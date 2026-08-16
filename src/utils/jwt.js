import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev_refresh_change_me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '30d';

/**
 * Build a JWT access token for a user payload.
 * @param {object} payload - typically { id, role, email }
 * @returns {string} signed access token
 */
export const generateToken = (payload) =>
  jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

/**
 * Build a JWT refresh token for a user payload.
 * @param {object} payload
 * @returns {string} signed refresh token
 */
export const generateRefreshToken = (payload) =>
  jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: JWT_REFRESH_EXPIRES_IN });

/**
 * Verify an access token.
 * @param {string} token
 * @returns {object|null} decoded payload or null when invalid/expired
 */
export const verifyToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
};

/**
 * Verify a refresh token.
 * @param {string} token
 * @returns {object|null}
 */
export const verifyRefreshToken = (token) => {
  try {
    return jwt.verify(token, JWT_REFRESH_SECRET);
  } catch {
    return null;
  }
};
