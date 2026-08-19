import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import pool from '../config/db.js';
import {
  generateToken,
  generateRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
  getUserSessions,
  revokeSession,
} from '../utils/jwt.js';
import { sendVerificationEmail, sendPasswordResetEmail, sendWelcomeEmail } from '../utils/email.js';
import { logAudit } from '../utils/audit.js';
import { validatePassword } from '../utils/password.js';
import { recordAuthFailure, recordAuthSuccess } from '../middleware/abuse.js';

const BCRYPT_ROUNDS = 12;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const MAX_PASSWORD_HISTORY = 5;

const sanitize = (u) => {
  if (!u) return null;
  const { password, ...rest } = u;
  return rest;
};

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

/** Check if account is locked from too many failed login attempts. */
const isLocked = (user) => {
  if (!user.locked_until) return false;
  return new Date(user.locked_until) > new Date();
};

/** Record a failed login attempt; lock account if threshold exceeded. */
const recordFailedAttempt = async (userId, email) => {
  const [rows] = await pool.execute(
    'SELECT failed_login_attempts FROM users WHERE id = ?',
    [userId],
  );
  const attempts = (rows[0]?.failed_login_attempts || 0) + 1;

  if (attempts >= MAX_FAILED_ATTEMPTS) {
    const lockUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
    await pool.execute(
      'UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?',
      [attempts, lockUntil, userId],
    );
  } else {
    await pool.execute(
      'UPDATE users SET failed_login_attempts = ? WHERE id = ?',
      [attempts, userId],
    );
  }
};

/** Reset failed attempts on successful login. */
const resetFailedAttempts = async (userId) => {
  await pool.execute(
    'UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?',
    [userId],
  );
};

/** Check if a password was used recently (password history). */
const isPasswordReused = async (userId, newHash) => {
  const [rows] = await pool.execute(
    'SELECT password_hash FROM password_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    [userId, MAX_PASSWORD_HISTORY],
  );
  for (const row of rows) {
    if (await bcrypt.compare(newHash.replace(/^\$2[aby]\$\d{2}\$/, ''), row.password_hash)) return true;
  }
  return false;
};

/** Store a password in history (call after successful password change). */
const storePasswordHistory = async (userId, passwordHash) => {
  await pool.execute(
    'INSERT INTO password_history (user_id, password_hash) VALUES (?, ?)',
    [userId, passwordHash],
  );
  // Trim history beyond limit
  await pool.execute(
    `DELETE FROM password_history WHERE user_id = ? AND id NOT IN (
      SELECT id FROM (
        SELECT id FROM password_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
      ) AS recent
    )`,
    [userId, userId, MAX_PASSWORD_HISTORY],
  );
};

/** Build meta object for refresh token storage. */
const buildMeta = (req, family) => ({
  ip: req.ip || req.connection?.remoteAddress,
  userAgent: req.headers['user-agent']?.slice(0, 300) || null,
  family,
});

/* ------------------------------------------------------------------ */
/* Register                                                            */
/* ------------------------------------------------------------------ */
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

    const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const isApproved = role === 'organizer' ? 0 : 1;
    const verifyToken = uuidv4();

    const [result] = await pool.execute(
      `INSERT INTO users (name, email, password, role, phone, status, is_approved, email_verified)
       VALUES (?, ?, ?, ?, ?, 'active', ?, FALSE)`,
      [name, email, hashed, role, phone || null, isApproved === 1],
    );

    const userId = result.insertId;

    if (role === 'organizer') {
      const orgName = req.body.organizationName || req.body.organization_name || name;
      await pool.execute(
        `INSERT INTO organizer_profiles (user_id, organization_name) VALUES (?, ?)`,
        [userId, orgName],
      );
    }

    // Store password in history
    await storePasswordHistory(userId, hashed);

    // Persist hashed verification token
    await pool.execute(
      `INSERT INTO email_verifications (user_id, token_hash, expires_at, used)
       VALUES (?, ?, NOW() + INTERVAL '24 hours', FALSE)`,
      [userId, hashToken(verifyToken)],
    );

    // Issue tokens — unverified users still get a short-lived access token
    // for the verify-email flow, but the frontend should gate most features
    // on email_verified.
    const family = uuidv4();
    const accessToken = generateToken({ id: userId, role, email });
    const { rawToken: refreshToken } = await generateRefreshToken(
      { id: userId, role, email },
      buildMeta(req, family),
    );

    sendVerificationEmail(email, verifyToken);
    await logAudit({ userId, action: 'register', entityType: 'user', entityId: userId });

    res.status(201).json({
      message: role === 'organizer'
        ? 'Account created. Your organizer account is pending approval.'
        : 'Account created. Please verify your email to activate your account.',
      user: sanitize({
        id: userId, name, email, role, phone, status: 'active',
        is_approved: isApproved, email_verified: 0,
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
    if (!user) { recordAuthFailure(req); return res.status(401).json({ message: 'Invalid credentials' }); }

    // Per-account lockout check
    if (isLocked(user)) {
      const remaining = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(423).json({
        message: `Account locked due to too many failed attempts. Try again in ${remaining} min.`,
        lockedUntil: user.locked_until,
      });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      recordAuthFailure(req);
      await recordFailedAttempt(user.id, email);
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    if (user.status === 'suspended') {
      return res.status(403).json({ message: 'Your account has been suspended' });
    }

    if (user.role === 'organizer' && !user.is_approved) {
      return res.status(403).json({ message: 'Your organizer account is pending approval' });
    }

    // Success — reset lockout, issue tokens
    await resetFailedAttempts(user.id);

    const family = uuidv4();
    const payload = { id: user.id, role: user.role, email: user.email };
    const accessToken = generateToken(payload);
    const { rawToken: refreshToken } = await generateRefreshToken(payload, buildMeta(req, family));

    await pool.execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
    await logAudit({ userId: user.id, action: 'login', entityType: 'user', entityId: user.id });
    recordAuthSuccess(req);

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
    if (!user) { recordAuthFailure(req); return res.status(401).json({ message: 'Invalid admin credentials' }); }

    // Per-account lockout
    if (isLocked(user)) {
      const remaining = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(423).json({
        message: `Account locked due to too many failed attempts. Try again in ${remaining} min.`,
        lockedUntil: user.locked_until,
      });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      recordAuthFailure(req);
      await recordFailedAttempt(user.id, email);
      return res.status(401).json({ message: 'Invalid admin credentials' });
    }

    if (user.status === 'suspended') {
      return res.status(403).json({ message: 'Your admin account has been suspended' });
    }

    await resetFailedAttempts(user.id);

    const family = uuidv4();
    const payload = { id: user.id, role: user.role, email: user.email };
    const accessToken = generateToken(payload);
    const { rawToken: refreshToken } = await generateRefreshToken(payload, buildMeta(req, family));

    await pool.execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
    await logAudit({ userId: user.id, action: 'admin_login', entityType: 'user', entityId: user.id });
    recordAuthSuccess(req);

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
/* Refresh token (with rotation + reuse detection)                     */
/* ------------------------------------------------------------------ */
export const refreshToken = async (req, res) => {
  try {
    const rawToken = req.body.refreshToken || req.headers['x-refresh-token'];
    if (!rawToken) return res.status(400).json({ message: 'Refresh token required' });

    const result = await rotateRefreshToken(rawToken, buildMeta(req));

    if (!result.valid) {
      // If token was reused (compromised), also revoke all sessions for that user
      if (result.compromised && result.userId) {
        await revokeAllUserTokens(result.userId);
        await logAudit({
          userId: result.userId, action: 'token_reuse_detected',
          entityType: 'user', entityId: result.userId,
        });
      }
      return res.status(401).json({ message: result.error });
    }

    const accessToken = generateToken({ id: result.userId, role: result.role, email: result.email });

    res.json({ accessToken, refreshToken: result.rawToken });
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
    if (user) {
      const rawToken = uuidv4();
      await pool.execute(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, used)
         VALUES (?, ?, NOW() + INTERVAL '1 hour', FALSE)`,
        [user.id, hashToken(rawToken)],
      );
      await pool.execute(
        `UPDATE password_reset_tokens SET used = TRUE
         WHERE user_id = ? AND used = FALSE AND token_hash <> ?`,
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
       WHERE prt.token_hash = ? AND prt.used = FALSE AND prt.expires_at > NOW()`,
      [tokenHash],
    );
    const resetRow = rows[0];
    if (!resetRow) return res.status(400).json({ message: 'Invalid or expired reset token' });

    const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Check password history
    const reused = await isPasswordReused(resetRow.user_id, hashed);
    if (reused) {
      return res.status(400).json({ message: 'Cannot reuse a recent password. Choose a different one.' });
    }

    await pool.execute('UPDATE users SET password = ? WHERE id = ?', [hashed, resetRow.user_id]);
    await storePasswordHistory(resetRow.user_id, hashed);

    // Burn all reset tokens + revoke all refresh tokens (force re-login everywhere)
    await pool.execute('UPDATE password_reset_tokens SET used = TRUE WHERE user_id = ?', [resetRow.user_id]);
    await revokeAllUserTokens(resetRow.user_id);

    await logAudit({ userId: resetRow.user_id, action: 'reset_password', entityType: 'user', entityId: resetRow.user_id });

    res.json({ message: 'Password reset successful. Please log in again on all devices.' });
  } catch (err) {
    console.error('[authController.resetPassword]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Change password (authenticated)                                     */
/* ------------------------------------------------------------------ */
export const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'currentPassword and newPassword are required' });
    }
    const strength = validatePassword(newPassword);
    if (!strength.valid) {
      return res.status(400).json({ message: strength.message });
    }

    const [rows] = await pool.execute('SELECT password FROM users WHERE id = ?', [req.user.id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ message: 'User not found' });

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return res.status(400).json({ message: 'Current password is incorrect' });

    const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    // Check password history
    const reused = await isPasswordReused(req.user.id, hashed);
    if (reused) {
      return res.status(400).json({ message: 'Cannot reuse a recent password. Choose a different one.' });
    }

    await pool.execute('UPDATE users SET password = ? WHERE id = ?', [hashed, req.user.id]);
    await storePasswordHistory(req.user.id, hashed);

    // Revoke all other sessions (force re-login on other devices)
    await revokeAllUserTokens(req.user.id);
    // Re-issue current session so user stays logged in here
    const family = uuidv4();
    const { rawToken: newRefresh } = await generateRefreshToken(
      { id: req.user.id, role: req.user.role, email: req.user.email },
      buildMeta(req, family),
    );

    await logAudit({ userId: req.user.id, action: 'change_password', entityType: 'user', entityId: req.user.id });

    res.json({
      message: 'Password changed. Other devices have been signed out.',
      refreshToken: newRefresh,
    });
  } catch (err) {
    console.error('[authController.changePassword]', err);
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
       WHERE ev.token_hash = ? AND ev.used = FALSE AND ev.expires_at > NOW()`,
      [tokenHash],
    );
    const verification = rows[0];
    if (!verification) return res.status(400).json({ message: 'Invalid or expired verification token' });

    await pool.execute('UPDATE email_verifications SET used = TRUE WHERE id = ?', [verification.id]);
    await pool.execute('UPDATE users SET email_verified = TRUE WHERE id = ?', [verification.user_id]);

    sendWelcomeEmail(verification.email, verification.name);
    await logAudit({ userId: verification.user_id, action: 'verify_email', entityType: 'user', entityId: verification.user_id });

    res.json({ message: 'Email verified successfully' });
  } catch (err) {
    console.error('[authController.verifyEmail]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Logout (revoke current session)                                     */
/* ------------------------------------------------------------------ */
export const logout = async (req, res) => {
  try {
    const rawToken = req.body.refreshToken || req.headers['x-refresh-token'];
    if (rawToken) await revokeRefreshToken(rawToken);
    await logAudit({ userId: req.user?.id, action: 'logout', entityType: 'user', entityId: req.user?.id });
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    console.error('[authController.logout]', err);
    res.status(500).json({ message: 'Server error during logout' });
  }
};

/* ------------------------------------------------------------------ */
/* Logout all devices                                                  */
/* ------------------------------------------------------------------ */
export const logoutAll = async (req, res) => {
  try {
    await revokeAllUserTokens(req.user.id);
    await logAudit({ userId: req.user.id, action: 'logout_all', entityType: 'user', entityId: req.user.id });
    res.json({ message: 'Logged out from all devices' });
  } catch (err) {
    console.error('[authController.logoutAll]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Get active sessions                                                 */
/* ------------------------------------------------------------------ */
export const getSessions = async (req, res) => {
  try {
    const sessions = await getUserSessions(req.user.id);
    res.json({ sessions });
  } catch (err) {
    console.error('[authController.getSessions]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Revoke a specific session                                           */
/* ------------------------------------------------------------------ */
export const revokeOneSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    await revokeSession(sessionId, req.user.id);
    res.json({ message: 'Session revoked' });
  } catch (err) {
    console.error('[authController.revokeOneSession]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export default {
  register, login, adminLogin, refreshToken, forgotPassword,
  resetPassword, changePassword, verifyEmail, logout, logoutAll,
  getSessions, revokeOneSession,
};
