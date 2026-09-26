import { Router } from 'express';
import {
  getEventMeetups, createMeetup, joinMeetup, leaveMeetup, deleteMeetup, getMyMeetups,
  getEventAttendees, getEventDiscussions, postEventDiscussion,
  getFriendsAttending, inviteFriendsToEvent, getMyEventInvites, respondToEventInvite,
  getMeetupMessages, postMeetupMessage,
} from '../controllers/meetupController.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';

const router = Router();

// Public / Optional Auth — meet-ups and attendees for an event
router.get('/event/:eventId', optionalAuth, getEventMeetups);
router.get('/event/:eventId/attendees', optionalAuth, getEventAttendees);
router.get('/event/:eventId/discussions', optionalAuth, getEventDiscussions);
router.get('/event/:eventId/friends-attending', optionalAuth, getFriendsAttending);

// Squad / Group Outing Chat
router.get('/:id/messages', optionalAuth, getMeetupMessages);
router.post('/:id/messages', authenticate, postMeetupMessage);

// Authenticated — meetups & discussions
router.post('/event/:eventId/discussions', authenticate, postEventDiscussion);
router.get('/mine', authenticate, getMyMeetups);
router.post('/event/:eventId', authenticate, createMeetup);
router.post('/:id/join', authenticate, joinMeetup);
router.post('/:id/leave', authenticate, leaveMeetup);
router.delete('/:id', authenticate, deleteMeetup);

// Event Invites
router.post('/event/:eventId/invite', authenticate, inviteFriendsToEvent);
router.get('/invites/mine', authenticate, getMyEventInvites);
router.put('/invites/:id/respond', authenticate, respondToEventInvite);

export default router;

