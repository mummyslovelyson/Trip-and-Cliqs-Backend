import { Router } from 'express';
import { body } from 'express-validator';
import {
  register, login, adminLogin, refreshToken,
  forgotPassword, resetPassword, verifyEmail, logout,
} from '../controllers/authController.js';
import { authenticate } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { honeypot } from '../middleware/bot.js';

const router = Router();

// Brute-force protection on credential + token endpoints. Generous limits
// so legitimate users are unaffected while automated attacks get throttled.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const emailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: 'Too many reset requests. Please try again later.' });

// Input validation mirrors the shared policy in utils/password.js so the
// API never depends on the frontend to enforce it.
router.post('/register', rateLimit({ windowMs: 15 * 60 * 1000, max: 5 }), honeypot, validate([
  body('name').trim().isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters'),
  body('email').trim().isEmail().withMessage('Invalid email address'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
]), register);
router.post('/login', loginLimiter, honeypot, validate([
  body('email').trim().notEmpty().withMessage('Email and password are required'),
  body('password').notEmpty().withMessage('Email and password are required'),
]), login);
router.post('/admin/login', loginLimiter, honeypot, validate([
  body('email').trim().notEmpty().withMessage('Email and password are required'),
  body('password').notEmpty().withMessage('Email and password are required'),
]), adminLogin);
router.post('/refresh-token', rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }), honeypot, refreshToken);
router.post('/forgot-password', emailLimiter, honeypot, validate([
  body('email').trim().isEmail().withMessage('Invalid email address'),
]), forgotPassword);
router.post('/reset-password', rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }), honeypot, validate([
  body('token').notEmpty().withMessage('Reset token is required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
]), resetPassword);
router.post('/verify-email', rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }), honeypot, validate([
  body('token').notEmpty().withMessage('Verification token required'),
]), verifyEmail);
router.post('/logout', authenticate, logout);

export default router;
