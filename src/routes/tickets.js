import { Router } from 'express';
import {
  getTicketTypes, createTicketType, updateTicketType, deleteTicketType,
  getUserTickets, getTicketById, checkInTicket, transferTicket, getTickets,
  verifyTicketByCode, bulkCheckIn, downloadTicket,
} from '../controllers/ticketController.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();

// Public — view ticket types for an event
router.get('/:eventId/types', getTicketTypes);

// Organizer / admin manage ticket types
router.post('/:eventId/types', authenticate, authorize('organizer', 'admin'), createTicketType);
router.put('/types/:id', authenticate, authorize('organizer', 'admin'), updateTicketType);
router.delete('/types/:id', authenticate, authorize('organizer', 'admin'), deleteTicketType);

// Attendee — tickets
router.get('/', authenticate, getTickets);
router.get('/me', authenticate, getUserTickets);
router.get('/:id', authenticate, getTicketById);
router.get('/:id/download', authenticate, downloadTicket);
router.post('/:id/transfer', authenticate, transferTicket);

// Organizer / staff — check-in
router.post('/check-in/bulk', authenticate, authorize('organizer', 'admin'), bulkCheckIn);
router.get('/verify/:code', authenticate, authorize('organizer', 'admin'), verifyTicketByCode);
router.post('/:id/check-in', authenticate, authorize('organizer', 'admin', 'staff'), checkInTicket);

export default router;
