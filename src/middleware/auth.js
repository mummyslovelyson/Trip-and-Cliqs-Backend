import jwt from 'jsonwebtoken';
import pool from '../config/db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

/**
 * Verify the Bearer token from the Authorization header.
 * Attaches the verified DB user payload to req.user.
 * Automatically invalidates requests if the account was deleted by admin.
 */
export const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  if (!token) {
    return res.status(401).json({ message: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = decoded.id || decoded.userId || decoded.sub;
    if (!userId) {
      return res.status(401).json({ message: 'Invalid session payload' });
    }

    const [rows] = await pool.execute(
      'SELECT id, name, email, role, status, is_approved, email_verified FROM users WHERE id = ?',
      [userId],
    );
    const dbUser = rows[0];
    if (!dbUser) {
      return res.status(401).json({
        message: 'Your account has been removed. You have been automatically signed out.',
        accountDeleted: true,
      });
    }
    if (dbUser.status === 'suspended') {
      return res.status(403).json({
        message: 'Your account has been suspended.',
        accountSuspended: true,
      });
    }

    if (dbUser.role === 'organizer' && (dbUser.is_approved === false || dbUser.is_approved === 0 || dbUser.status === 'pending')) {
      return res.status(403).json({
        message: 'Your organizer account is pending admin approval.',
        requiresApproval: true,
      });
    }

    req.user = {
      ...dbUser,
      ...decoded,
      id: Number(dbUser.id),
      is_approved: dbUser.is_approved === 1 || dbUser.is_approved === true,
    };
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired session token' });
  }
};

/**
 * Optional authentication: attaches req.user if a valid token is present,
 * but does not fail the request when the token is missing or invalid.
 */
export const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch {
      /* ignore — treated as anonymous */
    }
  }
  next();
};

/**
 * Role-based authorization. Usage: authorize('admin') or authorize('system_admin')
 * system_admin/superadmin automatically satisfies 'admin' role checks.
 */
export const authorize = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(403).json({ message: 'Forbidden' });
  }

  const userRole = req.user.role;
  const isSystemAdmin = userRole === 'system_admin' || userRole === 'superadmin';
  const hasDirectRole = roles.includes(userRole);
  const hasAdminPerm = roles.includes('admin') && isSystemAdmin;

  if (!hasDirectRole && !hasAdminPerm) {
    return res.status(403).json({ message: 'Forbidden: Insufficient administrative privileges' });
  }
  next();
};
