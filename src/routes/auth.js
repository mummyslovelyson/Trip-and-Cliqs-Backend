import { Router } from 'express';
import {
  register, login, adminLogin, refreshToken, forgotPassword,
  resetPassword, changePassword, verifyEmail, resendVerification, logout, logoutAll,
  getSessions, revokeOneSession, googleAuth, firebaseAuth,
} from '../controllers/authController.js';
import { authenticate } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { honeypot } from '../middleware/bot.js';

const router = Router();

/* ------------------------------------------------------------------ */
/* Public routes                                                        */
/* ------------------------------------------------------------------ */

// Firebase / Google OAuth Social Sign-In
router.post(
  '/firebase',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many Firebase sign-in attempts' }),
  firebaseAuth,
);

router.post(
  '/google',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many Google sign-in attempts' }),
  googleAuth,
);

// Mobile OAuth Redirect Callback Bridge
router.get('/callback', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authenticating with Tribes &amp; Cliqs</title>
  <style>
    body {
      background-color: #1C232B;
      color: #EFEFF1;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 24px;
      box-sizing: border-box;
    }
    .card {
      background-color: #242B32;
      border: 1px solid #494F55;
      border-radius: 16px;
      padding: 32px 24px;
      text-align: center;
      max-width: 360px;
      width: 100%;
    }
    .title {
      font-size: 20px;
      font-weight: 700;
      color: #EFEFF1;
      margin: 0 0 8px 0;
    }
    .desc {
      color: #949599;
      font-size: 14px;
      margin: 0 0 20px 0;
    }
    .btn {
      display: inline-block;
      background-color: #b21414;
      color: #ffffff;
      padding: 12px 24px;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 600;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h2 class="title">Tribes &amp; Cliqs</h2>
    <p class="desc">Completing authentication and returning to the app...</p>
    <a id="returnBtn" class="btn" href="#">Return to App</a>
  </div>
  <script>
    (function() {
      var params = new URLSearchParams(window.location.search);
      var appRedirect = params.get('app_redirect') || 'tribescliqs://auth-callback';
      var hash = window.location.hash || '';
      var query = window.location.search || '';
      var target = appRedirect + (hash ? hash : (query ? '?' + query.substring(1) : ''));
      var btn = document.getElementById('returnBtn');
      if (btn) btn.href = target;
      window.location.replace(target);
      setTimeout(function() {
        window.location.href = target;
      }, 250);
    })();
  </script>
</body>
</html>`);
});

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

// Email / OTP verification
router.post(
  '/verify-email',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 15, message: 'Too many verification attempts' }),
  verifyEmail,
);

// Resend verification email / OTP
router.post(
  '/resend-verification',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: 'Too many verification resend attempts. Please wait a few minutes.' }),
  resendVerification,
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
