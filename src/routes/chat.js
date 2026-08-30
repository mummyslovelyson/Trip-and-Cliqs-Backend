import { Router } from 'express';
import { handleChatMessage } from '../controllers/chatController.js';
import { optionalAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

const chatLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  message: 'You are sending messages too quickly. Please wait a moment.',
});

router.post('/message', optionalAuth, chatLimiter, handleChatMessage);

export default router;
