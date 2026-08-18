import { Router } from 'express';
import {
  createTicket, getUserTickets, getUserTicket, addReply, closeTicket,
} from '../controllers/supportController.js';
import { authenticate } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

const createLimiter = rateLimit({ windowMs: 60_000, max: 5, message: 'Too many support tickets. Please wait before creating another.' });
const replyLimiter = rateLimit({ windowMs: 60_000, max: 20, message: 'Too many replies. Please slow down.' });

router.use(authenticate);

router.post('/', createLimiter, createTicket);
router.get('/', getUserTickets);
router.get('/:id', getUserTicket);
router.post('/:id/reply', replyLimiter, addReply);
router.post('/:id/close', closeTicket);

export default router;
