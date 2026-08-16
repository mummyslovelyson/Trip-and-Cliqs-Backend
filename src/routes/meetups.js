import { Router } from 'express';
import {
  getEventMeetups, createMeetup, joinMeetup, leaveMeetup, deleteMeetup, getMyMeetups,
} from '../controllers/meetupController.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';

const router = Router();

// Public — meet-ups for an event (includes join state when authenticated).
router.get('/event/:eventId', optionalAuth, getEventMeetups);

// Authenticated
router.get('/mine', authenticate, getMyMeetups);
router.post('/event/:eventId', authenticate, createMeetup);
router.post('/:id/join', authenticate, joinMeetup);
router.post('/:id/leave', authenticate, leaveMeetup);
router.delete('/:id', authenticate, deleteMeetup);

export default router;
