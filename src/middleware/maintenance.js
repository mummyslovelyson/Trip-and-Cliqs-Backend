import { getSetting } from '../utils/settings.js';

/**
 * Maintenance mode middleware.
 * When enabled, blocks all traffic except:
 *   - Admin routes (/api/admin/*)
 *   - Auth routes (/api/auth/*) so admins can log in
 *   - The maintenance status endpoint itself
 *   - Static assets and uploads
 */
export const maintenanceMiddleware = async (req, res, next) => {
  try {
    const maintenanceMode = await getSetting('maintenance_mode');

    if (maintenanceMode !== 'true' && maintenanceMode !== true) {
      return next();
    }

    // Allow admin, auth, and public maintenance endpoints through
    const allowedPaths = [
      '/api/admin',
      '/api/auth',
      '/api/public/maintenance',
      '/api/public/settings',
      '/health',
      '/uploads',
    ];

    const isAllowed = allowedPaths.some((p) => req.path.startsWith(p));
    if (isAllowed) return next();

    return res.status(503).json({
      maintenance: true,
      message: 'We are currently performing scheduled maintenance. Please try again later.',
    });
  } catch {
    // If we can't read the setting, let traffic through
    next();
  }
};
