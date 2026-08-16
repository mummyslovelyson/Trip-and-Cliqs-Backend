import { Router } from 'express';
import {
  getEvents, getEvent, createEvent, updateEvent, deleteEvent,
  publishEvent, unpublishEvent,
  getOrganizerEvents, getFeaturedEvents, getTrendingEvents, getRecommendedEvents,
  getCategories, getFeaturedOrganizers,
} from '../controllers/eventController.js';
import { authenticate, authorize, optionalAuth } from '../middleware/auth.js';
import { uploadSingle, uploadArray } from '../middleware/upload.js';

const router = Router();

// Public
router.get('/', getEvents);
router.get('/featured', getFeaturedEvents);
router.get('/trending', getTrendingEvents);
router.get('/recommended', optionalAuth, getRecommendedEvents);
router.get('/categories', getCategories);
router.get('/featured-organizers', getFeaturedOrganizers);

// Organizer-only (create / manage)
router.get('/organizer/mine', authenticate, authorize('organizer', 'admin'), getOrganizerEvents);
router.post('/', authenticate, authorize('organizer', 'admin'), uploadSingle('banner_image'), createEvent);
router.put('/:id', authenticate, authorize('organizer', 'admin'), updateEvent);
router.patch('/:id/publish', authenticate, authorize('organizer', 'admin'), publishEvent);
router.patch('/:id/unpublish', authenticate, authorize('organizer', 'admin'), unpublishEvent);
router.delete('/:id', authenticate, authorize('organizer', 'admin'), deleteEvent);
router.get('/:id', optionalAuth, getEvent);

export default router;
