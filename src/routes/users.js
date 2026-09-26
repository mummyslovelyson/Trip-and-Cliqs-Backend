import { Router } from 'express';
import {
  getProfile, updateProfile,
  getNotifications, markNotificationRead, markAllNotificationsRead, deleteNotification,
  getFavorites, toggleFavorite,
  followOrganizer, unfollowOrganizer, getFollowing, getFollowingEvents,
  followArtist, unfollowArtist, getFollowedArtists, checkArtistFollowStatus,
  followCategory, unfollowCategory, getFollowedCategories, checkCategoryFollowStatus,
  getFollowingSummary,
  getReviews, createReview, deleteReview,
} from '../controllers/userController.js';
import { authenticate } from '../middleware/auth.js';
import { uploadSingle } from '../middleware/upload.js';

const router = Router();

router.use(authenticate);

// Profile
router.get('/profile', getProfile);
router.put('/profile', updateProfile);

// Avatar upload
router.post('/avatar', uploadSingle('avatar'), updateProfile);

// Notifications
router.get('/notifications', getNotifications);
router.put('/notifications/:id/read', markNotificationRead);
router.put('/notifications/read-all', markAllNotificationsRead);
router.delete('/notifications/:id', deleteNotification);

// Favorites (Events)
router.get('/favorites', getFavorites);
router.post('/favorites/toggle', toggleFavorite);

// Following (Organizers, Artists, Categories, Summary)
router.get('/following', getFollowing);
router.get('/following/summary', getFollowingSummary);
router.get('/following/events', getFollowingEvents);
router.post('/organizers/:id/follow', followOrganizer);
router.delete('/organizers/:id/follow', unfollowOrganizer);

// Artists Follow
router.get('/artists/following', getFollowedArtists);
router.get('/artists/check', checkArtistFollowStatus);
router.get('/artists/:name/status', checkArtistFollowStatus);
router.post('/artists/follow', followArtist);
router.delete('/artists/follow', unfollowArtist);
router.post('/artists/:name/follow', followArtist);
router.delete('/artists/:name/follow', unfollowArtist);
router.get('/following/artists', getFollowedArtists);
router.get('/following/artists/:name/status', checkArtistFollowStatus);

// Categories Follow
router.get('/categories/following', getFollowedCategories);
router.get('/categories/check', checkCategoryFollowStatus);
router.get('/categories/:name/status', checkCategoryFollowStatus);
router.post('/categories/follow', followCategory);
router.delete('/categories/follow', unfollowCategory);
router.post('/categories/:name/follow', followCategory);
router.delete('/categories/:name/follow', unfollowCategory);
router.get('/following/categories', getFollowedCategories);
router.get('/following/categories/:name/status', checkCategoryFollowStatus);

// Reviews
router.get('/reviews', getReviews);
router.get('/reviews/:eventId', getReviews);
router.post('/reviews', createReview);
router.post('/reviews/:eventId', createReview);
router.delete('/reviews/:id', deleteReview);

export default router;
