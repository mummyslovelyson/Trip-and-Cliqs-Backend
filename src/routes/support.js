import { Router } from 'express';
import {
  createTicket, getUserTickets, getUserTicket, addReply, closeTicket,
} from '../controllers/supportController.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

router.post('/', createTicket);
router.get('/', getUserTickets);
router.get('/:id', getUserTicket);
router.post('/:id/reply', addReply);
router.post('/:id/close', closeTicket);

export default router;
