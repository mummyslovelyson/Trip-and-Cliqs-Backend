import { Router } from 'express';
import {
  getTicketTypes, createTicketType, updateTicketType, deleteTicketType,
  getUserTickets, getTicketById, checkInTicket, transferTicket, getTickets,
  verifyTicketByCode, bulkCheckIn, downloadTicket,
} from '../controllers/ticketController.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

const writeLimiter = rateLimit({ windowMs: 60_000, max: 30, message: 'Too many ticket requests. Please slow down.' });
const transferLimiter = rateLimit({ windowMs: 60_000, max: 5, message: 'Too many transfer attempts.' });

// Public — view ticket types for an event
router.get('/:eventId/types', getTicketTypes);

// Organizer / admin manage ticket types
router.post('/:eventId/types', authenticate, authorize('organizer', 'admin'), writeLimiter, createTicketType);
router.put('/types/:id', authenticate, authorize('organizer', 'admin'), writeLimiter, updateTicketType);
router.delete('/types/:id', authenticate, authorize('organizer', 'admin'), writeLimiter, deleteTicketType);

// Attendee — tickets
router.get('/', authenticate, getTickets);
router.get('/me', authenticate, getUserTickets);
router.get('/:id', authenticate, getTicketById);
router.get('/:id/download', authenticate, downloadTicket);
router.post('/:id/transfer', authenticate, transferLimiter, transferTicket);

// Organizer / staff — check-in
router.post('/check-in/bulk', authenticate, authorize('organizer', 'admin'), writeLimiter, bulkCheckIn);
router.get('/verify/:code', authenticate, authorize('organizer', 'admin'), verifyTicketByCode);
router.post('/:id/check-in', authenticate, authorize('organizer', 'admin', 'staff'), writeLimiter, checkInTicket);

export default router;
