import { Router } from 'express';
import {
  getEventResale,
  getMarketplaceListings,
  getMyResale,
  getOrganizerResaleListings,
  approveResaleListing,
  rejectResaleListing,
  createResaleListing,
  cancelResaleListing,
  purchaseResaleListing,
} from '../controllers/resaleController.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();

// Public — explore all verified active resale listings across events
router.get('/marketplace', getMarketplaceListings);

// Public — active resale listings for a specific event
router.get('/event/:eventId', getEventResale);

// Organizer routes (approval & moderation)
router.get('/organizer', authenticate, authorize('organizer', 'admin'), getOrganizerResaleListings);
router.put('/:id/approve', authenticate, authorize('organizer', 'admin'), approveResaleListing);
router.put('/:id/reject', authenticate, authorize('organizer', 'admin'), rejectResaleListing);

// Authenticated Attendee routes
router.get('/mine', authenticate, getMyResale);
router.post('/', authenticate, createResaleListing);
router.delete('/:id', authenticate, cancelResaleListing);
router.post('/:id/purchase', authenticate, purchaseResaleListing);

export default router;
