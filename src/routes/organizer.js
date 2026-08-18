import { Router } from 'express';
import {
  getDashboardStats, getOrganizerProfile, updateOrganizerProfile, getRevenue,
  getEventAnalytics,
  getAttendees, exportAttendees,
  createCoupon, getCoupons, updateCoupon, deleteCoupon,
  getWithdrawals, requestWithdrawal,
  getTeamMembers, addTeamMember, removeTeamMember,
  sendMarketingEmail, getReports, getReportSummary, getSalesReport, getAttendanceReport, getTopEvents, getRefundReport, exportReport,
  getOrganizationSettings, updateOrganizationSettings, getPaymentAccount, updatePaymentAccount, changePassword, getActiveSessions, revokeSession, getBranding, updateBranding,
  getFlashSales, createFlashSale, deleteFlashSale,
  getMarketingCampaigns, createMarketingCampaign, getPendingInvites, inviteTeamMember, resendInvite, cancelInvite, getWalletBalance, getTransactions, getWalletEarnings,
} from '../controllers/organizerController.js';
import {
  getCategories, createCategory, updateCategory, deleteCategory,
} from '../controllers/adminController.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { uploadSingle } from '../middleware/upload.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

// All organizer routes require an organizer (or admin) token.
router.use(authenticate, authorize('organizer', 'admin'));

const writeLimiter = rateLimit({ windowMs: 60_000, max: 30, message: 'Too many requests. Please slow down.' });
const withdrawLimiter = rateLimit({ windowMs: 60_000, max: 5, message: 'Too many withdrawal requests.' });
const inviteLimiter = rateLimit({ windowMs: 60_000, max: 10, message: 'Too many invite requests.' });

// Dashboard & revenue & reports
router.get('/dashboard', getDashboardStats);
router.get('/revenue', getRevenue);
router.get('/reports', getReports);
router.get('/reports/summary', getReportSummary);
router.get('/reports/sales', getSalesReport);
router.get('/reports/attendance', getAttendanceReport);
router.get('/reports/top-events', getTopEvents);
router.get('/reports/refunds', getRefundReport);
router.get('/reports/export', exportReport);

// Profile & Settings
router.get('/profile/:id', getOrganizerProfile);
router.put('/profile', writeLimiter, updateOrganizerProfile);
router.post('/profile/logo', writeLimiter, uploadSingle('logo'), updateOrganizerProfile);

router.get('/settings/organization', getOrganizationSettings);
router.put('/settings/organization', writeLimiter, updateOrganizationSettings);
router.get('/settings/payment', getPaymentAccount);
router.put('/settings/payment', writeLimiter, updatePaymentAccount);
router.post('/settings/password', writeLimiter, changePassword);
router.post('/password', writeLimiter, changePassword);
router.get('/settings/sessions', getActiveSessions);
router.delete('/settings/sessions/:id', revokeSession);
router.get('/settings/branding', getBranding);
router.put('/settings/branding', writeLimiter, updateBranding);

// Analytics
router.get('/events/:eventId/analytics', getEventAnalytics);

// Attendees
router.get('/attendees/:eventId', getAttendees);
router.get('/attendees/:eventId/export', exportAttendees);

// Coupons & Flash Sales
router.post('/coupons', writeLimiter, createCoupon);
router.get('/coupons', getCoupons);
router.put('/coupons/:id', writeLimiter, updateCoupon);
router.delete('/coupons/:id', writeLimiter, deleteCoupon);

router.get('/flash-sales', getFlashSales);
router.post('/flash-sales', writeLimiter, createFlashSale);
router.delete('/flash-sales/:id', writeLimiter, deleteFlashSale);

// Withdrawals & Wallet
router.get('/withdrawals', getWithdrawals);
router.post('/withdrawals', withdrawLimiter, requestWithdrawal);
router.get('/wallet/balance', getWalletBalance);
router.get('/wallet/transactions', getTransactions);
router.get('/wallet/withdrawals', getWithdrawals);
router.post('/wallet/withdrawals', withdrawLimiter, requestWithdrawal);
router.get('/wallet/earnings', getWalletEarnings);

// Team & Invites
router.get('/team', getTeamMembers);
router.post('/team', inviteLimiter, addTeamMember);
router.delete('/team/:id', removeTeamMember);
router.get('/team/invites', getPendingInvites);
router.post('/team/invite', inviteLimiter, inviteTeamMember);
router.post('/team/invites/:id/resend', inviteLimiter, resendInvite);
router.delete('/team/invites/:id', cancelInvite);

// Marketing
router.get('/marketing', getMarketingCampaigns);
router.post('/marketing', writeLimiter, createMarketingCampaign);
router.post('/marketing/send', writeLimiter, sendMarketingEmail);

// Categories
router.get('/categories', getCategories);
router.post('/categories', writeLimiter, createCategory);
router.put('/categories/:id', writeLimiter, updateCategory);
router.delete('/categories/:id', writeLimiter, deleteCategory);

export default router;
