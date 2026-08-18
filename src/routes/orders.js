import { Router } from 'express';
import {
  createOrder, getOrder, getOrders, getUserOrders, getOrganizerOrders,
  cancelOrder, requestRefund, verifyPayment,
  applyCouponHandler, initiateOrderPayment, getOrderInvoice,
} from '../controllers/orderController.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

// Tight limits on payment-related endpoints (fraud prevention).
const orderLimiter = rateLimit({ windowMs: 60_000, max: 10, message: 'Too many order attempts. Please try again later.' });
const refundLimiter = rateLimit({ windowMs: 60_000, max: 3, message: 'Too many refund requests.' });

// Paystack webhook — no auth (verified via signature/reference on the server)
router.post('/verify-payment', verifyPayment);

// Authenticated
router.post('/', authenticate, orderLimiter, createOrder);
router.post('/apply-coupon', authenticate, applyCouponHandler);
router.get('/', authenticate, getOrders);
router.get('/me', authenticate, getUserOrders);
router.get('/organizer', authenticate, authorize('organizer', 'admin'), getOrganizerOrders);
router.get('/:id', authenticate, getOrder);
router.get('/:id/invoice', authenticate, getOrderInvoice);
router.post('/:id/payment', authenticate, orderLimiter, initiateOrderPayment);
router.post('/:id/cancel', authenticate, orderLimiter, cancelOrder);
router.post('/:id/refund', authenticate, refundLimiter, requestRefund);

export default router;
