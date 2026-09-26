import { Router } from 'express';
import {
  handleChatMessage,
  createAgentBookingHoldHandler,
  verifyAgentPaymentHandler,
  resendAgentTicketHandler,
} from '../controllers/chatController.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

const chatLimiter = rateLimit({
  windowMs: 60_000,
  max: 40,
  message: 'You are sending messages too quickly. Please wait a moment.',
});

router.post('/message', optionalAuth, chatLimiter, handleChatMessage);
router.post('/book', authenticate, chatLimiter, createAgentBookingHoldHandler);
router.post('/verify-payment', optionalAuth, chatLimiter, verifyAgentPaymentHandler);
router.post('/resend', authenticate, chatLimiter, resendAgentTicketHandler);

export default router;
