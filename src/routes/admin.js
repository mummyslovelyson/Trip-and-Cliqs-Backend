import { Router } from 'express';
import {
  getDashboardStats, getUsers, getUser, updateUser, suspendUser, unsuspendUser, verifyUser, deleteUser, approveOrganizer, rejectOrganizer, resetUserPassword, createAdminUser,
  getUserManagementStats, getUserActivity, getUserSessions, forceLogoutUser, addAdminNote, getAdminNotes, deleteAdminNote,
  exportUsers, bulkRoleChange, bulkDeleteUsers, getUserStats,
  getEvents, approveEvent, rejectEvent, featureEvent, suspendEvent, unsuspendEvent, adminDeleteEvent,
  getCategories, createCategory, updateCategory, deleteCategory,
  getPayments, getPayment, refundPayment, getWithdrawals, approveWithdrawal,
  getReports, getRevenueReport, getGrowthReport,
  getSupportTickets, getSupportTicket, respondToSupportTicket, closeSupportTicket, resolveSupportTicket,
  sendAnnouncement, getAdminNotifications, markAdminNotificationsRead, getAuditLogs, getSystemSettings, updateSystemSettings,
  testEmailSetting, testSmsSetting, getSmsBalanceSetting, testPaystackSetting,
  getContentPages, createContentPage, updateContentPage, deleteContentPage,
  getAITrainingData, createAIKnowledgeItem, updateAIKnowledgeItem, deleteAIKnowledgeItem, updateAISettings, testAIPrompt,
} from '../controllers/adminController.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

// Every admin route requires an admin token.
router.use(authenticate, authorize('admin'));

const writeLimiter = rateLimit({ windowMs: 60_000, max: 60, message: 'Too many admin actions. Please slow down.' });
const destructiveLimiter = rateLimit({ windowMs: 60_000, max: 10, message: 'Too many destructive actions.' });

// Dashboard
router.get('/dashboard', getDashboardStats);

// Users
router.get('/users', getUsers);
router.get('/users/stats', getUserManagementStats);
router.get('/users/export/csv', exportUsers);
router.post('/users/create-admin', authorize('system_admin', 'superadmin'), writeLimiter, createAdminUser);
router.get('/users/:id', getUser);
router.put('/users/:id', writeLimiter, updateUser);
router.put('/users/:id/suspend', writeLimiter, suspendUser);
router.post('/users/:id/suspend', writeLimiter, suspendUser);
router.post('/users/:id/unsuspend', writeLimiter, unsuspendUser);
router.post('/users/:id/verify', writeLimiter, verifyUser);
router.post('/users/:id/reset-password', writeLimiter, resetUserPassword);
router.delete('/users/:id', destructiveLimiter, deleteUser);
router.put('/organizers/:id/approve', writeLimiter, approveOrganizer);
router.post('/organizers/:id/approve', writeLimiter, approveOrganizer);
router.put('/organizers/:id/reject', writeLimiter, rejectOrganizer);
router.post('/organizers/:id/reject', writeLimiter, rejectOrganizer);

// User power features
router.get('/users/:id/activity', getUserActivity);
router.get('/users/:id/sessions', getUserSessions);
router.get('/users/:id/stats', getUserStats);
router.post('/users/:id/force-logout', writeLimiter, forceLogoutUser);
router.post('/users/:id/notes', writeLimiter, addAdminNote);
router.get('/users/:id/notes', getAdminNotes);
router.delete('/users/notes/:noteId', writeLimiter, deleteAdminNote);
router.get('/users/export/csv', exportUsers);
router.post('/users/bulk/role', writeLimiter, bulkRoleChange);
router.post('/users/bulk/delete', destructiveLimiter, bulkDeleteUsers);

// Events
router.get('/events', getEvents);
router.put('/events/:id/approve', writeLimiter, approveEvent);
router.post('/events/:id/approve', writeLimiter, approveEvent);
router.put('/events/:id/reject', writeLimiter, rejectEvent);
router.post('/events/:id/reject', writeLimiter, rejectEvent);
router.post('/events/:id/feature', writeLimiter, featureEvent);
router.post('/events/:id/suspend', writeLimiter, suspendEvent);
router.post('/events/:id/unsuspend', writeLimiter, unsuspendEvent);
router.delete('/events/:id', destructiveLimiter, adminDeleteEvent);

// Categories
router.get('/categories', getCategories);
router.post('/categories', writeLimiter, createCategory);
router.put('/categories/:id', writeLimiter, updateCategory);
router.delete('/categories/:id', destructiveLimiter, deleteCategory);

// Payments & withdrawals
router.get('/payments', getPayments);
router.get('/payments/:id', getPayment);
router.post('/payments/:id/refund', destructiveLimiter, refundPayment);
router.get('/withdrawals', getWithdrawals);
router.put('/withdrawals/:id/approve', writeLimiter, approveWithdrawal);

// Reports
router.get('/reports', getReports);
router.get('/reports/revenue', getRevenueReport);
router.get('/reports/growth', getGrowthReport);

// Support tickets
router.get('/support', getSupportTickets);
router.get('/support/:id', getSupportTicket);
router.post('/support/:id/respond', writeLimiter, respondToSupportTicket);
router.post('/support/:id/close', writeLimiter, closeSupportTicket);
router.get('/support-tickets', getSupportTickets);
router.put('/support-tickets/:id/resolve', writeLimiter, resolveSupportTicket);

// Notifications & Announcements
router.get('/notifications', getAdminNotifications);
router.put('/notifications/:id/read', markAdminNotificationsRead);
router.post('/notifications/mark-read', markAdminNotificationsRead);
router.post('/notifications', writeLimiter, sendAnnouncement);
router.post('/announcements', writeLimiter, sendAnnouncement);

// Content Management
router.get('/content', getContentPages);
router.post('/content', writeLimiter, createContentPage);
router.put('/content/:id', writeLimiter, updateContentPage);
router.delete('/content/:id', destructiveLimiter, deleteContentPage);

// Audit logs (Admin & System Admin)
router.get('/audit-logs', authorize('admin', 'system_admin', 'superadmin'), getAuditLogs);

// System settings (Admin & System Admin)
router.get('/settings', authorize('admin', 'system_admin', 'superadmin'), getSystemSettings);
router.put('/settings', authorize('admin', 'system_admin', 'superadmin'), writeLimiter, updateSystemSettings);
router.post('/settings/test-email', authorize('admin', 'system_admin', 'superadmin'), writeLimiter, testEmailSetting);
router.post('/settings/test-sms', authorize('admin', 'system_admin', 'superadmin'), writeLimiter, testSmsSetting);
router.post('/settings/test-paystack', authorize('admin', 'system_admin', 'superadmin'), writeLimiter, testPaystackSetting);
router.get('/settings/sms-balance', authorize('admin', 'system_admin', 'superadmin'), getSmsBalanceSetting);
// AI Model Training & Knowledge Management
router.get('/ai/knowledge', getAITrainingData);
router.post('/ai/knowledge', writeLimiter, createAIKnowledgeItem);
router.put('/ai/knowledge/:id', writeLimiter, updateAIKnowledgeItem);
router.delete('/ai/knowledge/:id', destructiveLimiter, deleteAIKnowledgeItem);
router.put('/ai/settings', writeLimiter, updateAISettings);
router.post('/ai/test', writeLimiter, testAIPrompt);

export default router;
