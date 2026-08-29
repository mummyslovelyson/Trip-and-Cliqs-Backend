import jwt from 'jsonwebtoken';

/**
 * Verify the Bearer token from the Authorization header.
 * Attaches the decoded payload to req.user.
 */
export const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  if (!token) {
    return res.status(401).json({ message: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ message: 'Invalid token' });
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
      req.user = jwt.verify(token, process.env.JWT_SECRET);
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
