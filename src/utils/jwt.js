import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import pool from '../config/db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev_refresh_change_me';
const ACCESS_TOKEN_TTL = process.env.JWT_ACCESS_TTL || '15m';
const REFRESH_TOKEN_TTL_DAYS = parseInt(process.env.JWT_REFRESH_TTL_DAYS || '30', 10);
const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * Build a short-lived JWT access token (default 15 minutes).
 */
export const generateToken = (payload) =>
  jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });

/**
 * Build a refresh token, store it server-side, and return the raw token.
 * @param {object} payload - { id, role, email }
 * @param {object} meta    - { ip, userAgent, family? }
 * @returns {{ rawToken: string, family: string }}
 */
export const generateRefreshToken = async (payload, meta = {}) => {
  const family = meta.family || crypto.randomUUID();
  const rawToken = crypto.randomUUID();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  await pool.execute(
    `INSERT INTO refresh_tokens (user_id, token_hash, family, ip_address, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [payload.id, tokenHash, family, meta.ip || null, meta.userAgent || null, expiresAt],
  );

  return { rawToken, family };
};

/**
 * Rotate a refresh token: verify old one, revoke it, issue a new one.
 * If the old token was already revoked (reuse detected), revoke the
 * entire family — that session is compromised.
 * @returns {{ valid: boolean, rawToken?: string, family?: string, userId?: number, error?: string }}
 */
export const rotateRefreshToken = async (rawToken, meta = {}) => {
  const tokenHash = hashToken(rawToken);
  const [rows] = await pool.execute(
    `SELECT rt.*, u.email, u.role, u.status
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = ?`,
    [tokenHash],
  );
  const row = rows[0];

  if (!row) return { valid: false, error: 'Invalid refresh token' };
  if (row.used) {
    // TOKEN REUSE DETECTED — revoke entire family
    await pool.execute('UPDATE refresh_tokens SET revoked = 1 WHERE family = ?', [row.family]);
    return { valid: false, error: 'Token reuse detected — all sessions revoked', compromised: true, userId: row.user_id };
  }
  if (row.revoked) return { valid: false, error: 'Refresh token has been revoked' };
  if (new Date(row.expires_at) < new Date()) return { valid: false, error: 'Refresh token expired' };
  if (row.status === 'suspended') return { valid: false, error: 'Account suspended' };

  // Mark old token as used (not revoked — "used" = legitimate rotation)
  await pool.execute('UPDATE refresh_tokens SET used = 1 WHERE id = ?', [row.id]);

  // Issue new token in same family
  const newRawToken = crypto.randomUUID();
  const newHash = hashToken(newRawToken);
  const newExpires = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  await pool.execute(
    `INSERT INTO refresh_tokens (user_id, token_hash, family, ip_address, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [row.user_id, newHash, row.family, meta.ip || null, meta.userAgent || null, newExpires],
  );

  return {
    valid: true,
    rawToken: newRawToken,
    family: row.family,
    userId: row.user_id,
    email: row.email,
    role: row.role,
  };
};

/**
 * Revoke a single refresh token (used by logout).
 */
export const revokeRefreshToken = async (rawToken) => {
  const tokenHash = hashToken(rawToken);
  await pool.execute('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?', [tokenHash]);
};

/**
 * Revoke all refresh tokens for a user (used by password change/reset,
 * security事件, admin suspension).
 */
export const revokeAllUserTokens = async (userId) => {
  await pool.execute('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?', [userId]);
};

/**
 * Get all active sessions (refresh tokens) for a user.
 */
export const getUserSessions = async (userId) => {
  const [rows] = await pool.execute(
    `SELECT id, ip_address, user_agent, created_at, last_active
     FROM refresh_tokens
     WHERE user_id = ? AND revoked = 0 AND used = 0 AND expires_at > NOW()
     ORDER BY last_active DESC`,
    [userId],
  );
  return rows;
};

/**
 * Revoke a specific session by ID.
 */
export const revokeSession = async (sessionId, userId) => {
  await pool.execute(
    'UPDATE refresh_tokens SET revoked = 1 WHERE id = ? AND user_id = ?',
    [sessionId, userId],
  );
};

/**
 * Verify an access token.
 */
export const verifyToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
};

/**
 * Verify a refresh token (raw, for backward compat — prefer rotateRefreshToken).
 */
export const verifyRefreshToken = (token) => {
  try {
    return jwt.verify(token, JWT_REFRESH_SECRET);
  } catch {
    return null;
  }
};

export const REFRESH_TOKEN_TTL = REFRESH_TOKEN_TTL_MS;
export { REFRESH_TOKEN_TTL_DAYS };
