import { Router } from 'express';
import {
  getProfile, updateProfile, changePassword,
  getNotifications, markNotificationRead, markAllNotificationsRead, deleteNotification,
  getFavorites, toggleFavorite,
  followOrganizer, unfollowOrganizer, getFollowing, getFollowingEvents,
  getReviews, createReview, deleteReview,
} from '../controllers/userController.js';
import { authenticate } from '../middleware/auth.js';
import { uploadSingle } from '../middleware/upload.js';

const router = Router();

router.use(authenticate);

// Profile
router.get('/profile', getProfile);
router.put('/profile', updateProfile);
router.post('/change-password', changePassword);

// Avatar upload
router.post('/avatar', uploadSingle('avatar'), updateProfile);

// Notifications
router.get('/notifications', getNotifications);
router.put('/notifications/:id/read', markNotificationRead);
router.put('/notifications/read-all', markAllNotificationsRead);
router.delete('/notifications/:id', deleteNotification);

// Favorites
router.get('/favorites', getFavorites);
router.post('/favorites/toggle', toggleFavorite);

// Follow organizers
router.get('/following', getFollowing);
router.get('/following/events', getFollowingEvents);
router.post('/organizers/:id/follow', followOrganizer);
router.delete('/organizers/:id/follow', unfollowOrganizer);

// Reviews
router.get('/reviews', getReviews);
router.get('/reviews/:eventId', getReviews);
router.post('/reviews', createReview);
router.post('/reviews/:eventId', createReview);
router.delete('/reviews/:id', deleteReview);

export default router;
