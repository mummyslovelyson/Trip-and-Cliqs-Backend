import { Router } from 'express';
import {
  getEvents, getEvent, trackEventView, createEvent, updateEvent, deleteEvent,
  publishEvent, unpublishEvent,
  getOrganizerEvents, getFeaturedEvents, getTrendingEvents, getRecommendedEvents,
  getCategories, getFeaturedOrganizers, getPublicOrganizerProfile,
  toggleEventReminder, getEventReminderStatus, getUserReminders,
} from '../controllers/eventController.js';
import { authenticate, authorize, optionalAuth } from '../middleware/auth.js';
import { uploadSingle, uploadArray } from '../middleware/upload.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

// Stricter rate limit on write operations (20 writes/min per IP).
const writeLimiter = rateLimit({ windowMs: 60_000, max: 20, message: 'Too many event changes. Please slow down.' });

// Public
router.get('/', getEvents);
router.get('/featured', getFeaturedEvents);
router.get('/trending', getTrendingEvents);
router.get('/recommended', optionalAuth, getRecommendedEvents);
router.get('/categories', getCategories);
router.get('/featured-organizers', getFeaturedOrganizers);
router.get('/organizers/:id', optionalAuth, getPublicOrganizerProfile);

// Reminders
router.get('/reminders/mine', authenticate, getUserReminders);
router.post('/:id/reminders', authenticate, writeLimiter, toggleEventReminder);
router.get('/:id/reminders', optionalAuth, getEventReminderStatus);

// View tracking (Personalized Recommendations)
router.post('/:id/view', optionalAuth, trackEventView);

// Organizer-only (create / manage)
router.get('/organizer/mine', authenticate, authorize('organizer', 'admin'), getOrganizerEvents);
router.post('/', authenticate, authorize('organizer', 'admin'), writeLimiter, uploadSingle('banner_image'), createEvent);
router.put('/:id', authenticate, authorize('organizer', 'admin'), writeLimiter, updateEvent);
router.patch('/:id/publish', authenticate, authorize('organizer', 'admin'), writeLimiter, publishEvent);
router.patch('/:id/unpublish', authenticate, authorize('organizer', 'admin'), writeLimiter, unpublishEvent);
router.delete('/:id', authenticate, authorize('organizer', 'admin'), writeLimiter, deleteEvent);
router.get('/:id', optionalAuth, getEvent);

export default router;
