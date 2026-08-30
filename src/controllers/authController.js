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
import { sendVerificationSMS, sendWelcomeSMS, sendSMS } from '../utils/sms.js';
import { sendNotification, notifyAdmins } from '../utils/notify.js';
import { logAudit } from '../utils/audit.js';
import { validatePassword } from '../utils/password.js';
import { recordAuthFailure, recordAuthSuccess } from '../middleware/abuse.js';
import { verifyFirebaseToken } from '../utils/firebase.js';

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

/** Check if password matches any of the last N passwords for this user. */
const isPasswordReused = async (userId, newHash) => {
  try {
    const [rows] = await pool.execute(
      'SELECT password_hash FROM password_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      [userId, MAX_PASSWORD_HISTORY],
    );
    for (const row of rows) {
      if (await bcrypt.compare(newHash.replace(/^\$2[aby]\$\d{2}\$/, ''), row.password_hash)) return true;
    }
  } catch (err) {
    console.warn('[authController] isPasswordReused check skipped:', err.message);
  }
  return false;
};

/** Store a password in history (call after successful password change). */
const storePasswordHistory = async (userId, passwordHash) => {
  try {
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
  } catch (err) {
    console.warn('[authController] storePasswordHistory skipped:', err.message);
  }
};

/** Build meta object for refresh token storage. */
const buildMeta = (req, family) => ({
  ip: req.ip || req.connection?.remoteAddress,
  userAgent: req.headers['user-agent']?.slice(0, 300) || null,
  family,
});

/** Helper to persist verification tokens & OTP for a user */
const createEmailVerification = async (userId, otp, verifyToken) => {
  // Invalidate previous unused verification entries for this user
  await pool.execute('UPDATE email_verifications SET used = TRUE WHERE user_id = ? AND used = FALSE', [userId]);

  // Insert link token hash (valid for 24 hours)
  await pool.execute(
    `INSERT INTO email_verifications (user_id, token_hash, expires_at, used)
     VALUES (?, ?, NOW() + INTERVAL '24 hours', FALSE)`,
    [userId, hashToken(verifyToken)],
  );

  // Insert 6-digit OTP hash (valid for 15 minutes)
  if (otp) {
    await pool.execute(
      `INSERT INTO email_verifications (user_id, token_hash, expires_at, used)
       VALUES (?, ?, NOW() + INTERVAL '15 minutes', FALSE)`,
      [userId, hashToken(`otp:${userId}:${otp}`)],
    );
  }
};


/* ------------------------------------------------------------------ */
/* Register (Step 1: Validate, Store Pending & Dispatch OTP)          */
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

    const cleanName = String(name).trim().slice(0, 120);
    const cleanEmail = String(email).trim().toLowerCase().slice(0, 190);
    const cleanPhone = phone ? String(phone).trim().slice(0, 30) : null;

    const [existing] = await pool.execute('SELECT id FROM users WHERE email = ?', [cleanEmail]);
    if (existing.length) {
      return res.status(409).json({ message: 'Email already registered' });
    }

    const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const registrationId = uuidv4();
    const otp = crypto.randomInt(100000, 1000000).toString();
    const otpHash = hashToken(`pending_otp:${otp}`);
    const orgName = (req.body.organizationName || req.body.organization_name || name).toString().trim().slice(0, 180);
    const metadataObj = {
      category: req.body.category || req.body.industry || null,
      city: req.body.city || req.body.location || null,
      description: req.body.description || req.body.bio || null,
      website: req.body.website || req.body.websiteUrl || null,
    };
    const metadataStr = JSON.stringify(metadataObj);

    // Clean up older pending registrations for this email/phone
    try {
      await pool.execute(
        'DELETE FROM pending_registrations WHERE email = ? OR (phone IS NOT NULL AND phone = ?)',
        [cleanEmail, cleanPhone || ''],
      );
    } catch {
      // ignore table or cleanup errors
    }

    // Insert pending registration (account is NOT created in users table yet)
    await pool.execute(
      `INSERT INTO pending_registrations (
        registration_id, name, email, phone, password_hash, role, organization_name, metadata, otp_hash, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW() + INTERVAL '15 minutes')`,
      [registrationId, cleanName, cleanEmail, cleanPhone, hashed, role, orgName, metadataStr, otpHash],
    );

    // Background dispatches (safe, non-blocking)
    sendVerificationEmail(cleanEmail, registrationId, otp).catch((err) =>
      console.error('[authController.register] Verification email failed:', err.message)
    );
    if (cleanPhone) {
      sendVerificationSMS(cleanPhone, otp).catch((err) =>
        console.error('[authController.register] SMS send error:', err.message)
      );
    }

    const verifyMessage = cleanPhone
      ? 'Verification code sent to your phone via SMS and to your email. Please enter the code to complete account creation.'
      : 'Verification code sent to your email. Please enter the code to complete account creation.';

    res.status(201).json({
      status: 'pending_verification',
      message: verifyMessage,
      registrationId,
      email: cleanEmail,
      phone: cleanPhone,
      name: cleanName,
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
      if (user.firebase_uid || user.google_id) {
        return res.status(401).json({
          message: 'This account was created with Google Sign-In. Please click "Continue with Google" below to sign in.',
        });
      }
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    if (['admin', 'system_admin', 'superadmin', 'staff'].includes(user.role)) {
      return res.status(403).json({
        message: 'Admin accounts must log in via the Admin Portal at /admin-login',
        isAdminPortalRedirect: true,
      });
    }

    if (user.status === 'suspended') {
      return res.status(403).json({ message: 'Your account has been suspended' });
    }

    if (user.role !== 'admin' && (user.email_verified === false || user.email_verified === 0)) {
      return res.status(403).json({
        message: 'Please verify your account before logging in. A 6-digit code was sent to your SMS and email.',
        requiresVerification: true,
        email: user.email,
        phone: user.phone,
      });
    }

    // Success — reset lockout, issue tokens
    await resetFailedAttempts(user.id);

    const family = uuidv4();
    const payload = { id: user.id, role: user.role, email: user.email };
    const accessToken = generateToken(payload);
    const { rawToken: refreshToken } = await generateRefreshToken(payload, buildMeta(req, family));

    await pool.execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
    await sendNotification({
      userId: user.id,
      title: 'Account Login',
      message: `Signed in successfully on ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} at ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}.`,
      type: 'account',
    });
    if (user.phone) {
      sendSMS(
        user.phone,
        `Tribes & Cliqs Security: Login detected on your account at ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}.`,
      ).catch((err) => console.error('[authController.login] SMS alert error:', err.message));
    }
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
      `SELECT * FROM users WHERE email = ? AND role IN ('admin', 'system_admin', 'superadmin', 'staff')`,
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
    await sendNotification({
      userId: user.id,
      title: 'Admin Portal Login',
      message: `Admin portal signed in on ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} at ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}.`,
      type: 'account',
    });
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
/* ------------------------------------------------------------------ */
/* Forgot password (dispatches 6-digit code via Email and SMS)         */
/* ------------------------------------------------------------------ */
export const forgotPassword = async (req, res) => {
  try {
    const { email, identifier } = req.body;
    const target = String(email || identifier || '').trim().toLowerCase();
    if (!target) return res.status(400).json({ message: 'Email or phone number is required' });

    const [rows] = await pool.execute(
      'SELECT id, name, email, phone FROM users WHERE email = ? OR phone = ?',
      [target, target],
    );
    const user = rows[0];
    if (user) {
      const code = crypto.randomInt(100000, 1000000).toString();
      const codeHash = hashToken(code);

      // Clean up older unused reset tokens
      await pool.execute(
        'DELETE FROM password_reset_tokens WHERE user_id = ? OR expires_at < NOW()',
        [user.id],
      );

      // Insert new 6-digit reset code with 15 minutes validity
      await pool.execute(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, used)
         VALUES (?, ?, NOW() + INTERVAL '15 minutes', FALSE)`,
        [user.id, codeHash],
      );

      // 1. Dispatch Email with 6-digit code
      try {
        sendPasswordResetEmail(user.email, code, user.name);
      } catch (emailErr) {
        console.error('[authController.forgotPassword] sendPasswordResetEmail error:', emailErr.message);
      }

      // 2. Dispatch SMS with 6-digit code
      if (user.phone) {
        try {
          sendSMS(
            user.phone,
            `Tribes & Cliqs: Your password reset code is ${code}. Valid for 15 minutes. Never share this code with anyone.`
          ).catch((smsErr) => console.warn('[authController.forgotPassword] SMS error:', smsErr.message));
        } catch {
          /* ignore */
        }
      }

      await logAudit({ userId: user.id, action: 'forgot_password_otp_sent', entityType: 'user', entityId: user.id });
    }

    res.json({
      message: 'A 6-digit password reset code has been sent to your email and registered phone number.',
      email: user?.email || target,
      phone: user?.phone ? `${user.phone.slice(0, 4)}***${user.phone.slice(-3)}` : null,
    });
  } catch (err) {
    console.error('[authController.forgotPassword]', err);
    res.status(500).json({ message: 'Server error sending password reset code' });
  }
};

/* ------------------------------------------------------------------ */
/* Reset password (verifies 6-digit code or link token)                */
/* ------------------------------------------------------------------ */
export const resetPassword = async (req, res) => {
  try {
    const { token, code, email, password } = req.body;
    const resetInput = String(code || token || '').trim();
    if (!resetInput || !password) {
      return res.status(400).json({ message: 'Reset code and new password are required' });
    }
    const strength = validatePassword(password);
    if (!strength.valid) {
      return res.status(400).json({ message: strength.message });
    }

    const inputHash = hashToken(resetInput);

    let query = `
      SELECT prt.*, u.id AS user_id, u.email, u.phone, u.name
      FROM password_reset_tokens prt
      JOIN users u ON u.id = prt.user_id
      WHERE prt.token_hash = ? AND prt.used = FALSE AND prt.expires_at > NOW()
    `;
    const params = [inputHash];

    if (email) {
      query += ` AND LOWER(u.email) = ?`;
      params.push(String(email).trim().toLowerCase());
    }

    const [rows] = await pool.execute(query, params);
    const resetRow = rows[0];
    if (!resetRow) {
      return res.status(400).json({ message: 'Invalid or expired 6-digit reset code. Please request a new one.' });
    }

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

    // Send confirmation SMS & in-app notification
    if (resetRow.phone) {
      sendSMS(
        resetRow.phone,
        'Tribes & Cliqs Security: Your account password was successfully reset. If you did not make this change, please contact support immediately.'
      ).catch(() => {});
    }

    sendNotification({
      userId: resetRow.user_id,
      title: 'Password Reset Successful',
      message: 'Your account password has been updated. Other active sessions have been signed out for security.',
      type: 'account',
    }).catch(() => {});

    await logAudit({ userId: resetRow.user_id, action: 'reset_password_completed', entityType: 'user', entityId: resetRow.user_id });

    res.json({ message: 'Password reset successful! You can now sign in with your new password.' });
  } catch (err) {
    console.error('[authController.resetPassword]', err);
    res.status(500).json({ message: 'Server error during password reset' });
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
/* Verify email & OTP (Creates and activates account upon OTP match)   */
/* ------------------------------------------------------------------ */
export const verifyEmail = async (req, res) => {
  try {
    const { token, otp, email, phone, registrationId } = req.body;
    const cleanOtp = otp ? String(otp).trim() : '';
    const cleanEmail = email ? String(email).trim().toLowerCase() : '';
    const cleanPhone = phone ? String(phone).trim() : '';
    const cleanRegId = registrationId ? String(registrationId).trim() : '';

    // --- STEP 1: Check pending_registrations (Pre-verification creation) ---
    if (cleanOtp && (cleanRegId || cleanEmail || cleanPhone)) {
      let pending = null;
      if (cleanRegId) {
        const [rows] = await pool.execute(
          `SELECT * FROM pending_registrations WHERE registration_id = ? AND expires_at > NOW()`,
          [cleanRegId],
        );
        pending = rows[0];
      }
      if (!pending && cleanEmail) {
        const [rows] = await pool.execute(
          `SELECT * FROM pending_registrations WHERE email = ? AND expires_at > NOW()`,
          [cleanEmail],
        );
        pending = rows[0];
      }
      if (!pending && cleanPhone) {
        const [rows] = await pool.execute(
          `SELECT * FROM pending_registrations WHERE phone = ? AND expires_at > NOW()`,
          [cleanPhone],
        );
        pending = rows[0];
      }

      if (pending) {
        const expectedHash = hashToken(`pending_otp:${cleanOtp}`);
        if (pending.otp_hash === expectedHash) {
          // Double check email uniqueness before final insert
          const [dupCheck] = await pool.execute('SELECT id FROM users WHERE email = ?', [pending.email]);
          if (dupCheck.length) {
            await pool.execute('DELETE FROM pending_registrations WHERE id = ?', [pending.id]);
            return res.status(409).json({ message: 'An account with this email is already registered.' });
          }

          const isApproved = pending.role === 'organizer' ? 0 : 1;
          const meta = pending.metadata
            ? (typeof pending.metadata === 'string' ? JSON.parse(pending.metadata) : pending.metadata)
            : {};

          const [result] = await pool.execute(
            `INSERT INTO users (name, email, password, role, phone, status, is_approved, email_verified, location, bio)
             VALUES (?, ?, ?, ?, ?, 'active', ?, TRUE, ?, ?)`,
            [
              pending.name,
              pending.email,
              pending.password_hash,
              pending.role,
              pending.phone || null,
              isApproved === 1,
              meta.city || meta.location || null,
              meta.description || null,
            ],
          );

          const userId = result.insertId;

          if (pending.role === 'organizer') {
            await pool.execute(
              `INSERT INTO organizer_profiles (user_id, organization_name, description, website, category, city, is_verified)
               VALUES (?, ?, ?, ?, ?, ?, FALSE)`,
              [
                userId,
                pending.organization_name || pending.name,
                meta.description || null,
                meta.website || null,
                meta.category || null,
                meta.city || meta.location || null,
              ],
            );
          }

          // Clean up pending registration
          await pool.execute('DELETE FROM pending_registrations WHERE id = ?', [pending.id]);
          await storePasswordHistory(userId, pending.password_hash);

          // Dispatch Welcome Email and SMS alerts
          sendWelcomeEmail(pending.email, pending.name).catch((err) =>
            console.error('[authController.verifyEmail] sendWelcomeEmail error:', err.message)
          );
          if (pending.phone) {
            sendWelcomeSMS(pending.phone, pending.name).catch((err) =>
              console.error('[authController.verifyEmail] sendWelcomeSMS error:', err.message)
            );
          }

          sendNotification({
            userId,
            title: 'Account Created & Verified',
            message: 'Your account has been successfully verified and activated. Welcome to Tribes & Cliqs!',
            type: 'account',
          }).catch(() => {});

          notifyAdmins({
            title: pending.role === 'organizer' ? 'New Organizer Application' : 'New Attendee Registered',
            message: `${pending.name} (${pending.email}) just verified their ${pending.role} account.${pending.role === 'organizer' ? ' Profile is awaiting approval.' : ''}`,
            type: 'account',
            link: pending.role === 'organizer' ? '/admin/organizers' : '/admin/users',
          }).catch(() => {});

          logAudit({ userId, action: 'create_and_verify_account', entityType: 'user', entityId: userId }).catch(() => {});

          const family = uuidv4();
          const payload = { id: userId, role: pending.role, email: pending.email };
          const accessToken = generateToken(payload);
          const { rawToken: refreshToken } = await generateRefreshToken(payload, buildMeta(req, family));

          return res.json({
            message: 'Account verified and created successfully!',
            user: sanitize({
              id: userId,
              name: pending.name,
              email: pending.email,
              role: pending.role,
              phone: pending.phone,
              status: 'active',
              is_approved: isApproved,
              email_verified: 1,
            }),
            accessToken,
            refreshToken,
          });
        }
      }
    }

    // --- STEP 2: Legacy / Existing user verification in DB ---
    let verification = null;
    if (token) {
      const tokenHash = hashToken(token);
      const [rows] = await pool.execute(
        `SELECT ev.*, u.email, u.name, u.role, u.status, u.is_approved
         FROM email_verifications ev
         JOIN users u ON u.id = ev.user_id
         WHERE ev.token_hash = ? AND ev.used = FALSE AND ev.expires_at > NOW()`,
        [tokenHash],
      );
      verification = rows[0];
    } else if (cleanOtp && (cleanEmail || cleanPhone)) {
      let user = null;
      if (cleanEmail) {
        const [userRows] = await pool.execute('SELECT id, email, name, role, status, is_approved FROM users WHERE email = ?', [cleanEmail]);
        user = userRows[0];
      } else if (cleanPhone) {
        const [userRows] = await pool.execute('SELECT id, email, name, role, status, is_approved FROM users WHERE phone = ?', [cleanPhone]);
        user = userRows[0];
      }

      if (user) {
        const otpHash = hashToken(`otp:${user.id}:${cleanOtp}`);
        const [rows] = await pool.execute(
          `SELECT ev.*, u.email, u.name, u.role, u.status, u.is_approved
           FROM email_verifications ev
           JOIN users u ON u.id = ev.user_id
           WHERE ev.token_hash = ? AND ev.used = FALSE AND ev.expires_at > NOW()`,
          [otpHash],
        );
        verification = rows[0];
      }
    }

    if (!verification) {
      return res.status(400).json({ message: 'Invalid or expired verification code' });
    }

    await pool.execute('UPDATE email_verifications SET used = TRUE WHERE user_id = ?', [verification.user_id]);
    await pool.execute('UPDATE users SET email_verified = TRUE WHERE id = ?', [verification.user_id]);

    await sendNotification({
      userId: verification.user_id,
      title: 'Account Verified',
      message: 'Your account has been successfully verified.',
      type: 'account',
    });

    sendWelcomeEmail(verification.email, verification.name).catch(() => {});
    if (verification.phone) {
      sendWelcomeSMS(verification.phone, verification.name).catch(() => {});
    }
    await logAudit({ userId: verification.user_id, action: 'verify_account', entityType: 'user', entityId: verification.user_id });

    // Issue tokens upon verification
    const family = uuidv4();
    const payload = { id: verification.user_id, role: verification.role, email: verification.email };
    const accessToken = generateToken(payload);
    const { rawToken: refreshToken } = await generateRefreshToken(payload, buildMeta(req, family));

    res.json({
      message: 'Account verified successfully',
      user: sanitize({ ...verification, email_verified: 1 }),
      accessToken,
      refreshToken,
    });
  } catch (err) {
    console.error('[authController.verifyEmail]', err);
    res.status(500).json({ message: 'Server error during verification' });
  }
};

/* ------------------------------------------------------------------ */
/* Resend verification email / SMS OTP                                 */
/* ------------------------------------------------------------------ */
export const resendVerification = async (req, res) => {
  try {
    const { email, phone, registrationId, channel = 'email' } = req.body;
    if (!email && !phone && !registrationId) {
      return res.status(400).json({ message: 'Email address, phone number, or registration ID is required' });
    }

    const cleanEmail = email ? String(email).trim().toLowerCase() : '';
    const cleanPhone = phone ? String(phone).trim() : '';
    const cleanRegId = registrationId ? String(registrationId).trim() : '';

    // Check pending_registrations first
    let pending = null;
    if (cleanRegId) {
      const [rows] = await pool.execute(
        `SELECT * FROM pending_registrations WHERE registration_id = ?`,
        [cleanRegId],
      );
      pending = rows[0];
    }
    if (!pending && cleanEmail) {
      const [rows] = await pool.execute(
        `SELECT * FROM pending_registrations WHERE email = ?`,
        [cleanEmail],
      );
      pending = rows[0];
    }
    if (!pending && cleanPhone) {
      const [rows] = await pool.execute(
        `SELECT * FROM pending_registrations WHERE phone = ?`,
        [cleanPhone],
      );
      pending = rows[0];
    }
    if (pending) {
      const otp = crypto.randomInt(100000, 1000000).toString();
      const otpHash = hashToken(`pending_otp:${otp}`);
      await pool.execute(
        `UPDATE pending_registrations SET otp_hash = ?, expires_at = NOW() + INTERVAL '15 minutes' WHERE id = ?`,
        [otpHash, pending.id],
      );

      const destEmail = cleanEmail || pending.email;
      const destPhone = cleanPhone || pending.phone;

      // Always send to email if available
      if (destEmail && channel !== 'sms_only') {
        sendVerificationEmail(destEmail, pending.registration_id, otp).catch((err) =>
          console.error('[authController.resendVerification] email send failed:', err.message)
        );
      }

      // Always send to SMS if phone is available
      if (destPhone && channel !== 'email_only') {
        sendVerificationSMS(destPhone, otp).catch((err) =>
          console.error('[authController.resendVerification] SMS send error:', err.message)
        );
      }

      const resendMsg = (destPhone && destEmail)
        ? 'A new verification code has been sent to your email and via SMS to your phone.'
        : (destPhone ? 'A new verification code has been sent via SMS.' : 'A new verification code has been sent to your email.');

      return res.json({ message: resendMsg });
    }

    // Check existing users table
    let user = null;
    if (cleanEmail) {
      const [rows] = await pool.execute('SELECT id, name, email, phone, email_verified FROM users WHERE email = ?', [cleanEmail]);
      user = rows[0];
    } else if (cleanPhone) {
      const [rows] = await pool.execute('SELECT id, name, email, phone, email_verified FROM users WHERE phone = ?', [cleanPhone]);
      user = rows[0];
    }

    if (user && !user.email_verified) {
      const verifyToken = uuidv4();
      const otp = crypto.randomInt(100000, 1000000).toString();
      await createEmailVerification(user.id, otp, verifyToken);

      const destEmail = cleanEmail || user.email;
      const destPhone = cleanPhone || user.phone;

      if (destEmail && channel !== 'sms_only') {
        sendVerificationEmail(destEmail, verifyToken, otp).catch((err) =>
          console.error('[authController.resendVerification] email send failed:', err.message)
        );
      }

      if (destPhone && channel !== 'email_only') {
        sendVerificationSMS(destPhone, otp).catch((err) =>
          console.error('[authController.resendVerification] SMS send error:', err.message)
        );
      }

      await logAudit({ userId: user.id, action: 'resend_verification', entityType: 'user', entityId: user.id, details: { channel } });
    }

    const finalMsg = (cleanPhone && cleanEmail)
      ? 'A verification code has been sent to your email and via SMS to your phone.'
      : (cleanPhone ? 'A verification code has been sent via SMS.' : 'A verification code has been sent to your email.');

    res.json({ message: finalMsg });
  } catch (err) {
    console.error('[authController.resendVerification]', err);
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

/* ------------------------------------------------------------------ */
/* Firebase / Google OAuth Social Authentication                      */
/* ------------------------------------------------------------------ */
export const firebaseAuth = async (req, res) => {
  try {
    const {
      credential,
      idToken,
      token: legacyToken,
      accessToken,
      role = 'attendee',
      organizationName,
      category,
      city,
      phone,
    } = req.body;

    const rawToken = idToken || credential || legacyToken;
    let authUser = null;

    if (rawToken) {
      try {
        const verified = await verifyFirebaseToken(rawToken);
        authUser = {
          id: verified.uid,
          email: verified.email,
          name: verified.name,
          picture: verified.picture,
          emailVerified: verified.emailVerified,
        };
      } catch (err) {
        console.warn('[firebaseAuth] Token verification failed:', err.message);
      }
    }

    // Direct access token lookup fallback
    if (!authUser && accessToken) {
      try {
        const gRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (gRes.ok) {
          const data = await gRes.json();
          authUser = {
            id: data.sub,
            email: data.email?.toLowerCase()?.trim(),
            name: data.name || data.given_name || (data.email?.split('@')[0]),
            picture: data.picture,
            emailVerified: data.email_verified === true,
          };
        }
      } catch (err) {
        console.warn('[firebaseAuth] Google userinfo fallback failed:', err.message);
      }
    }

    if (!authUser || !authUser.email) {
      return res.status(400).json({ message: 'Invalid or expired Firebase/Google authentication token' });
    }

    // Look up existing user by email, firebase_uid, or google_id
    const [existingRows] = await pool.execute(
      'SELECT * FROM users WHERE email = ? OR firebase_uid = ? OR google_id = ? LIMIT 1',
      [authUser.email, authUser.id, authUser.id],
    );
    let user = existingRows[0];

    if (user) {
      // Existing user
      if (user.status === 'suspended') {
        return res.status(403).json({ message: 'Account is suspended. Please contact support.' });
      }

      // Update firebase_uid, google_id, and avatar if missing
      await pool.execute(
        `UPDATE users SET
           firebase_uid = COALESCE(firebase_uid, ?),
           google_id = COALESCE(google_id, ?),
           avatar = COALESCE(avatar, ?),
           avatar_url = COALESCE(avatar_url, ?),
           email_verified = TRUE,
           last_login_at = NOW()
         WHERE id = ?`,
        [authUser.id, authUser.id, authUser.picture, authUser.picture, user.id],
      );

      user.firebase_uid = user.firebase_uid || authUser.id;
      user.google_id = user.google_id || authUser.id;
      user.avatar = user.avatar || authUser.picture;
      user.avatar_url = user.avatar_url || authUser.picture;
      user.email_verified = true;
    } else {
      // New user registration via Firebase
      const assignedRole = role === 'organizer' ? 'organizer' : 'attendee';
      const status = assignedRole === 'organizer' ? 'pending' : 'active';
      const isApproved = assignedRole === 'organizer' ? false : true;
      const randomPassword = `FB_${uuidv4()}_${Date.now()}`;
      const passwordHash = await bcrypt.hash(randomPassword, BCRYPT_ROUNDS);

      const [insertResult] = await pool.execute(
        `INSERT INTO users (name, email, password, role, status, is_approved, email_verified, firebase_uid, google_id, avatar, avatar_url, phone)
         VALUES (?, ?, ?, ?, ?, ?, TRUE, ?, ?, ?, ?, ?)`,
        [
          authUser.name,
          authUser.email,
          passwordHash,
          assignedRole,
          status,
          isApproved,
          authUser.id,
          authUser.id,
          authUser.picture,
          authUser.picture,
          phone || null,
        ],
      );

      const newUserId = insertResult.insertId;

      if (assignedRole === 'organizer') {
        await pool.execute(
          `INSERT INTO organizer_profiles (user_id, organization_name, description, is_verified)
           VALUES (?, ?, ?, FALSE)
           ON CONFLICT (user_id) DO NOTHING`,
          [newUserId, organizationName || authUser.name, `Category: ${category || 'Events'}`],
        );

        // Notify admins about new organizer registration
        try {
          const [adminRows] = await pool.execute(
            `SELECT id FROM users WHERE role IN ('admin', 'system_admin', 'superadmin')`,
          );
          for (const a of adminRows) {
            sendNotification({
              userId: a.id,
              title: 'New Organizer Signed Up (Firebase/Google)',
              message: `${authUser.name} (${authUser.email}) registered as an organizer via Firebase OAuth and is awaiting approval.`,
              type: 'organizer_approval',
            }).catch(() => {});
          }
        } catch { /* ignore */ }
      }

      const [newUserRows] = await pool.execute('SELECT * FROM users WHERE id = ?', [newUserId]);
      user = newUserRows[0];

      await logAudit({
        userId: user.id,
        action: 'firebase_register',
        entityType: 'user',
        entityId: user.id,
        details: { role: user.role, email: user.email },
      });
    }

    // Check organizer pending approval
    const isPendingOrganizer = user.role === 'organizer' && (!user.is_approved || user.status === 'pending');

    const family = uuidv4();
    const meta = buildMeta(req, family);
    const tokenPayload = { id: user.id, role: user.role, email: user.email };
    const jwtToken = generateToken(tokenPayload);
    const { rawToken: refreshToken } = await generateRefreshToken(tokenPayload, meta);

    await logAudit({
      userId: user.id,
      action: 'firebase_login',
      entityType: 'user',
      entityId: user.id,
    });

    res.json({
      message: isPendingOrganizer
        ? 'Account registered! Your organizer application is pending admin review.'
        : 'Google sign-in successful',
      token: jwtToken,
      accessToken: jwtToken,
      refreshToken,
      user: sanitize(user),
      pendingApproval: isPendingOrganizer,
    });
  } catch (err) {
    console.error('[authController.firebaseAuth]', err);
    res.status(500).json({ message: 'Firebase authentication failed' });
  }
};

export const googleAuth = firebaseAuth;

export default {
  register, login, adminLogin, refreshToken, forgotPassword,
  resetPassword, changePassword, verifyEmail, logout, logoutAll,
  getSessions, revokeOneSession, googleAuth, firebaseAuth,
};
