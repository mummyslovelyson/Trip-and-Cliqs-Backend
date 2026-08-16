import { Router } from 'express';
import {
  getEventResale, getMyResale, createResaleListing, cancelResaleListing, purchaseResaleListing,
} from '../controllers/resaleController.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Public — active resale listings for an event
router.get('/event/:eventId', getEventResale);

// Authenticated
router.get('/mine', authenticate, getMyResale);
router.post('/', authenticate, createResaleListing);
router.delete('/:id', authenticate, cancelResaleListing);
router.post('/:id/purchase', authenticate, purchaseResaleListing);

export default router;
