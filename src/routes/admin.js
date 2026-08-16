import { Router } from 'express';
import {
  getDashboardStats, getUsers, getUser, updateUser, suspendUser, unsuspendUser, verifyUser, deleteUser, approveOrganizer, rejectOrganizer, resetUserPassword,
  getEvents, approveEvent, rejectEvent, featureEvent, suspendEvent, unsuspendEvent, adminDeleteEvent,
  getCategories, createCategory, updateCategory, deleteCategory,
  getPayments, getPayment, refundPayment, getWithdrawals, approveWithdrawal,
  getReports, getRevenueReport, getGrowthReport,
  getSupportTickets, getSupportTicket, respondToSupportTicket, closeSupportTicket, resolveSupportTicket,
  sendAnnouncement, getAdminNotifications, getAuditLogs, getSystemSettings, updateSystemSettings,
  getContentPages, createContentPage, updateContentPage, deleteContentPage,
} from '../controllers/adminController.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();

// Every admin route requires an admin token.
router.use(authenticate, authorize('admin'));

// Dashboard
router.get('/dashboard', getDashboardStats);

// Users
router.get('/users', getUsers);
router.get('/users/:id', getUser);
router.put('/users/:id', updateUser);
router.put('/users/:id/suspend', suspendUser);
router.post('/users/:id/suspend', suspendUser);
router.post('/users/:id/unsuspend', unsuspendUser);
router.post('/users/:id/verify', verifyUser);
router.post('/users/:id/reset-password', resetUserPassword);
router.delete('/users/:id', deleteUser);
router.put('/organizers/:id/approve', approveOrganizer);
router.post('/organizers/:id/approve', approveOrganizer);
router.put('/organizers/:id/reject', rejectOrganizer);
router.post('/organizers/:id/reject', rejectOrganizer);

// Events
router.get('/events', getEvents);
router.put('/events/:id/approve', approveEvent);
router.post('/events/:id/approve', approveEvent);
router.put('/events/:id/reject', rejectEvent);
router.post('/events/:id/reject', rejectEvent);
router.post('/events/:id/feature', featureEvent);
router.post('/events/:id/suspend', suspendEvent);
router.post('/events/:id/unsuspend', unsuspendEvent);
router.delete('/events/:id', adminDeleteEvent);

// Categories
router.get('/categories', getCategories);
router.post('/categories', createCategory);
router.put('/categories/:id', updateCategory);
router.delete('/categories/:id', deleteCategory);

// Payments & withdrawals
router.get('/payments', getPayments);
router.get('/payments/:id', getPayment);
router.post('/payments/:id/refund', refundPayment);
router.get('/withdrawals', getWithdrawals);
router.put('/withdrawals/:id/approve', approveWithdrawal);

// Reports
router.get('/reports', getReports);
router.get('/reports/revenue', getRevenueReport);
router.get('/reports/growth', getGrowthReport);

// Support tickets
router.get('/support', getSupportTickets);
router.get('/support/:id', getSupportTicket);
router.post('/support/:id/respond', respondToSupportTicket);
router.post('/support/:id/close', closeSupportTicket);
router.get('/support-tickets', getSupportTickets);
router.put('/support-tickets/:id/resolve', resolveSupportTicket);

// Notifications & Announcements
router.get('/notifications', getAdminNotifications);
router.post('/notifications', sendAnnouncement);
router.post('/announcements', sendAnnouncement);

// Content Management
router.get('/content', getContentPages);
router.post('/content', createContentPage);
router.put('/content/:id', updateContentPage);
router.delete('/content/:id', deleteContentPage);

// Audit logs
router.get('/audit-logs', getAuditLogs);

// System settings
router.get('/settings', getSystemSettings);
router.put('/settings', updateSystemSettings);

export default router;
