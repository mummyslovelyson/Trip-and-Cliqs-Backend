import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import pool from '../config/db.js';
import { generateToken, generateRefreshToken, verifyRefreshToken } from '../utils/jwt.js';
import { sendVerificationEmail, sendPasswordResetEmail, sendWelcomeEmail } from '../utils/email.js';
import { logAudit } from '../utils/audit.js';
import { validatePassword } from '../utils/password.js';

const sanitize = (u) => {
  if (!u) return null;
  const { password, ...rest } = u;
  return rest;
};

/**
 * Hash a raw one-time token so tokens are never stored in plaintext.
 * SHA-256 is appropriate here because tokens are 128-bit random UUIDs —
 * not user-chosen secrets — so dictionary attacks don't apply.
 */
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;      // 1 hour
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/* ------------------------------------------------------------------ */
/* Register                                                            */
/* ------------------------------------------------------------------ */
// Public registration may only create attendee or organizer accounts.
// Anything else (e.g. "admin") is rejected — admin accounts are seeded or
// created by existing admins only.
const ALLOWED_PUBLIC_ROLES = ['attendee', 'organizer'];

export const register = async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    const role = req.body.role ?? 'attendee';

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email and password are required' });
    }
    if (!ALLOWED_PUBLIC_ROLES.includes(role)) {
      return res.status(400).json({ message: 'Invalid role for registration' });
    }
    const strength = validatePassword(password);
    if (!strength.valid) {
      return res.status(400).json({ message: strength.message });
    }

    const [existing] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length) {
      return res.status(409).json({ message: 'Email already registered' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const isApproved = role === 'organizer' ? 0 : 1; // organizers need admin approval
    const verifyToken = uuidv4();

    const [result] = await pool.execute(
      `INSERT INTO users (name, email, password, role, phone, status, is_approved, email_verified)
       VALUES (?, ?, ?, ?, ?, 'active', ?, 0)`,
      [name, email, hashed, role, phone || null, isApproved],
    );

    const userId = result.insertId;

    if (role === 'organizer') {
      const orgName = req.body.organizationName || req.body.organization_name || name;
      await pool.execute(
        `INSERT INTO organizer_profiles (user_id, organization_name) VALUES (?, ?)`,
        [userId, orgName],
      );
    }

    // Persist a hashed, single-use verification token so the emailed link can
    // actually be validated server-side.
    await pool.execute(
      `INSERT INTO email_verifications (user_id, token_hash, expires_at, used)
       VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR), 0)`,
      [userId, hashToken(verifyToken)],
    );

    const payload = { id: userId, role, email };
    const accessToken = generateToken(payload);
    const refreshToken = generateRefreshToken(payload);

    // Fire-and-forget verification email.
    sendVerificationEmail(email, verifyToken);

    await logAudit({ userId, action: 'register', entityType: 'user', entityId: userId });

    res.status(201).json({
      message: role === 'organizer'
        ? 'Account created. Your organizer account is pending approval.'
        : 'Account created. Please verify your email to activate your account.',
      user: sanitize({
        id: userId, name, email, role, phone, status: 'active', is_approved: isApproved, email_verified: 0,
      }),
      accessToken,
      refreshToken,
    });
  } catch (err) {
    console.error('[authController.register]', err);
    res.status(500).json({ message: 'Server error during registration' });
  }
};

/* ------------------------------------------------------------------ */
/* Login                                                               */
/* ------------------------------------------------------------------ */
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
    const user = rows[0];
    if (!user) return res.status(401).json({ message: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ message: 'Invalid credentials' });

    if (user.status === 'suspended') {
      return res.status(403).json({ message: 'Your account has been suspended' });
    }

    if (user.role === 'organizer' && !user.is_approved) {
      return res.status(403).json({ message: 'Your organizer account is pending approval' });
    }

    const payload = { id: user.id, role: user.role, email: user.email };
    const accessToken = generateToken(payload);
    const refreshToken = generateRefreshToken(payload);

    await pool.execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
    await logAudit({ userId: user.id, action: 'login', entityType: 'user', entityId: user.id });

    res.json({
      message: 'Login successful',
      user: sanitize(user),
      accessToken,
      refreshToken,
    });
  } catch (err) {
    console.error('[authController.login]', err);
    res.status(500).json({ message: 'Server error during login' });
  }
};

/* ------------------------------------------------------------------ */
/* Admin login                                                         */
/* ------------------------------------------------------------------ */
export const adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const [rows] = await pool.execute(
      `SELECT * FROM users WHERE email = ? AND role = 'admin'`,
      [email],
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ message: 'Invalid admin credentials' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ message: 'Invalid admin credentials' });

    const payload = { id: user.id, role: user.role, email: user.email };
    const accessToken = generateToken(payload);
    const refreshToken = generateRefreshToken(payload);

    await pool.execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
    await logAudit({ userId: user.id, action: 'admin_login', entityType: 'user', entityId: user.id });

    res.json({
      message: 'Admin login successful',
      user: sanitize(user),
      accessToken,
      refreshToken,
    });
  } catch (err) {
    console.error('[authController.adminLogin]', err);
    res.status(500).json({ message: 'Server error during admin login' });
  }
};

/* ------------------------------------------------------------------ */
/* Refresh token                                                       */
/* ------------------------------------------------------------------ */
export const refreshToken = async (req, res) => {
  try {
    const token = req.body.refreshToken || req.headers['x-refresh-token'];
    if (!token) return res.status(400).json({ message: 'Refresh token required' });

    const decoded = verifyRefreshToken(token);
    if (!decoded) return res.status(401).json({ message: 'Invalid or expired refresh token' });

    const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [decoded.id]);
    const user = rows[0];
    if (!user || user.status === 'suspended') {
      return res.status(401).json({ message: 'User not found or suspended' });
    }

    const payload = { id: user.id, role: user.role, email: user.email };
    const accessToken = generateToken(payload);

    res.json({ accessToken, refreshToken: token });
  } catch (err) {
    console.error('[authController.refreshToken]', err);
    res.status(500).json({ message: 'Server error during token refresh' });
  }
};

/* ------------------------------------------------------------------ */
/* Forgot password                                                     */
/* ------------------------------------------------------------------ */
export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required' });

    const [rows] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
    const user = rows[0];
    // Always respond ok to avoid email enumeration.
    if (user) {
      const rawToken = uuidv4();
      await pool.execute(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, used)
         VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR), 0)`,
        [user.id, hashToken(rawToken)],
      );
      // A fresh request invalidates any older, unused reset tokens.
      await pool.execute(
        `UPDATE password_reset_tokens SET used = 1
         WHERE user_id = ? AND used = 0 AND token_hash <> ?`,
        [user.id, hashToken(rawToken)],
      );
      try {
        await sendPasswordResetEmail(email, rawToken);
      } catch (emailErr) {
        console.error('[authController.forgotPassword] sendPasswordResetEmail error:', emailErr.message);
      }
      await logAudit({ userId: user.id, action: 'forgot_password', entityType: 'user', entityId: user.id });
    }

    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (err) {
    console.error('[authController.forgotPassword]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Reset password                                                      */
/* ------------------------------------------------------------------ */
export const resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ message: 'Token and new password are required' });
    }
    const strength = validatePassword(password);
    if (!strength.valid) {
      return res.status(400).json({ message: strength.message });
    }

    const tokenHash = hashToken(token);
    const [rows] = await pool.execute(
      `SELECT prt.*, u.email
       FROM password_reset_tokens prt
       JOIN users u ON u.id = prt.user_id
       WHERE prt.token_hash = ? AND prt.used = 0 AND prt.expires_at > NOW()`,
      [tokenHash],
    );
    const resetRow = rows[0];
    if (!resetRow) return res.status(400).json({ message: 'Invalid or expired reset token' });

    const hashed = await bcrypt.hash(password, 10);
    await pool.execute('UPDATE users SET password = ? WHERE id = ?', [hashed, resetRow.user_id]);

    // Single-use: burn the token and any other outstanding reset tokens.
    await pool.execute(
      `UPDATE password_reset_tokens SET used = 1 WHERE user_id = ?`,
      [resetRow.user_id],
    );

    await logAudit({ userId: resetRow.user_id, action: 'reset_password', entityType: 'user', entityId: resetRow.user_id });

    res.json({ message: 'Password reset successful. You can now log in.' });
  } catch (err) {
    console.error('[authController.resetPassword]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Verify email                                                        */
/* ------------------------------------------------------------------ */
export const verifyEmail = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ message: 'Verification token required' });

    const tokenHash = hashToken(token);
    const [rows] = await pool.execute(
      `SELECT ev.*, u.email, u.name
       FROM email_verifications ev
       JOIN users u ON u.id = ev.user_id
       WHERE ev.token_hash = ? AND ev.used = 0 AND ev.expires_at > NOW()`,
      [tokenHash],
    );
    const verification = rows[0];
    if (!verification) return res.status(400).json({ message: 'Invalid or expired verification token' });

    await pool.execute(
      `UPDATE email_verifications SET used = 1 WHERE id = ?`,
      [verification.id],
    );
    await pool.execute(
      `UPDATE users SET email_verified = 1 WHERE id = ?`,
      [verification.user_id],
    );

    sendWelcomeEmail(verification.email, verification.name);
    await logAudit({ userId: verification.user_id, action: 'verify_email', entityType: 'user', entityId: verification.user_id });

    res.json({ message: 'Email verified successfully' });
  } catch (err) {
    console.error('[authController.verifyEmail]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Logout                                                              */
/* ------------------------------------------------------------------ */
export const logout = async (req, res) => {
  try {
    await logAudit({ userId: req.user?.id, action: 'logout', entityType: 'user', entityId: req.user?.id });
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    console.error('[authController.logout]', err);
    res.status(500).json({ message: 'Server error during logout' });
  }
};

export default { register, login, adminLogin, refreshToken, forgotPassword, resetPassword, verifyEmail, logout };
