import { Router } from 'express';
import {
  createOrder, getOrder, getOrders, getUserOrders, getOrganizerOrders,
  cancelOrder, requestRefund, verifyPayment,
  applyCouponHandler, initiateOrderPayment, getOrderInvoice,
} from '../controllers/orderController.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();

// Paystack webhook — no auth (verified via signature/reference on the server)
router.post('/verify-payment', verifyPayment);

// Authenticated
router.post('/', authenticate, createOrder);
router.post('/apply-coupon', authenticate, applyCouponHandler);
router.get('/', authenticate, getOrders);
router.get('/me', authenticate, getUserOrders);
router.get('/organizer', authenticate, authorize('organizer', 'admin'), getOrganizerOrders);
router.get('/:id', authenticate, getOrder);
router.get('/:id/invoice', authenticate, getOrderInvoice);
router.post('/:id/payment', authenticate, initiateOrderPayment);
router.post('/:id/cancel', authenticate, cancelOrder);
router.post('/:id/refund', authenticate, requestRefund);

export default router;
