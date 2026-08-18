import { Router } from 'express';
import {
  register, login, adminLogin, refreshToken, forgotPassword,
  resetPassword, changePassword, verifyEmail, logout, logoutAll,
  getSessions, revokeOneSession,
} from '../controllers/authController.js';
import { authenticate } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { honeypot } from '../middleware/bot.js';

const router = Router();

/* ------------------------------------------------------------------ */
/* Public routes                                                        */
/* ------------------------------------------------------------------ */

// Registration — strict rate limit + honeypot + validation
router.post(
  '/register',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: 'Too many registration attempts' }),
  honeypot,
  register,
);

// Login — per-IP + per-account protection is handled in abuse.js + controller
router.post(
  '/login',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many login attempts' }),
  honeypot,
  login,
);

// Admin login — separate, stricter limit
router.post(
  '/admin/login',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: 'Too many admin login attempts' }),
  honeypot,
  adminLogin,
);

// Token refresh
router.post(
  '/refresh',
  rateLimit({ windowMs: 60 * 1000, max: 30, message: 'Too many token refresh requests' }),
  refreshToken,
);

// Forgot password — aggressive rate limit to prevent email spam
router.post(
  '/forgot-password',
  rateLimit({ windowMs: 60 * 60 * 1000, max: 3, message: 'Too many password reset requests. Try again later.' }),
  honeypot,
  forgotPassword,
);

// Reset password (from email link)
router.post(
  '/reset-password',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many reset attempts' }),
  resetPassword,
);

// Email verification
router.post(
  '/verify-email',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many verification attempts' }),
  verifyEmail,
);

/* ------------------------------------------------------------------ */
/* Authenticated routes                                                 */
/* ------------------------------------------------------------------ */

// Logout current session
router.post('/logout', authenticate, logout);

// Logout all devices
router.post('/logout-all', authenticate, logoutAll);

// Change password (must be logged in)
router.post(
  '/change-password',
  authenticate,
  rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: 'Too many password change attempts' }),
  changePassword,
);

// Active sessions
router.get('/sessions', authenticate, getSessions);

// Revoke a specific session
router.delete(
  '/sessions/:sessionId',
  authenticate,
  rateLimit({ windowMs: 60 * 1000, max: 20, message: 'Too many revoke requests' }),
  revokeOneSession,
);

export default router;
