import pool from '../config/db.js';
import { sendNotification } from '../utils/notify.js';


/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const getMemberCount = async (meetupId) => {
  const [[{ total }]] = await pool.execute(
    'SELECT COUNT(*) AS total FROM event_meetup_members WHERE meetup_id = ?',
    [meetupId],
  );
  return Number(total) || 0;
};

const getHost = async (userId) => {
  if (userId == null) return null;
  const [rows] = await pool.execute('SELECT id, name, avatar FROM users WHERE id = ?', [userId]);
  const u = rows[0];
  if (!u) return null;
  return { id: u.id, name: u.name, avatar: u.avatar };
};

const getMembers = async (meetupId) => {
  try {
    const [rows] = await pool.execute(
      `SELECT u.id, u.name, COALESCE(u.avatar_url, u.avatar) AS avatar, emm.role, emm.created_at
       FROM event_meetup_members emm
       JOIN users u ON u.id = emm.user_id
       WHERE emm.meetup_id = ?
       ORDER BY emm.created_at ASC
       LIMIT 12`,
      [meetupId],
    );
    return rows;
  } catch {
    return [];
  }
};

const decorate = async (meetup, userId) => {
  const members = await getMembers(meetup.id);
  return {
    id: meetup.id,
    eventId: meetup.event_id,
    hostId: meetup.host_id,
    host: await getHost(meetup.host_id),
    title: meetup.title,
    type: meetup.type || 'general',
    description: meetup.description,
    meetingSpot: meetup.meeting_spot,
    meetAt: meetup.meet_at,
    maxMembers: Number(meetup.max_members) || 0,
    isPublic: !!meetup.is_public,
    createdAt: meetup.created_at,
    memberCount: members.length || (await getMemberCount(meetup.id)),
    members,
    joined: userId != null
      ? members.some((m) => m.id === userId) || !!(await pool.execute(
        'SELECT id FROM event_meetup_members WHERE meetup_id = ? AND user_id = ?',
        [meetup.id, userId],
      ))[0].length
      : false,
  };
};

/* ------------------------------------------------------------------ */
/* List meet-ups for an event (public)                                 */
/* ------------------------------------------------------------------ */
export const getEventMeetups = async (req, res) => {
  try {
    const eventId = Number(req.params.eventId);
    const [rows] = await pool.execute(
      `SELECT * FROM event_meetups WHERE event_id = ? ORDER BY created_at DESC`,
      [eventId],
    );
    const meetups = [];
    for (const m of rows) meetups.push(await decorate(m, req.user?.id));
    res.json({ meetups });
  } catch (err) {
    console.error('[meetupController.getEventMeetups]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Create a meet-up (host auto-joins)                                  */
/* ------------------------------------------------------------------ */
export const createMeetup = async (req, res) => {
  try {
    const eventId = Number(req.params.eventId);
    const { title, description, meetingSpot, meetAt, maxMembers, isPublic, type = 'general' } = req.body || {};

    if (!title || !title.trim()) return res.status(400).json({ message: 'A title is required' });

    const [eventRows] = await pool.execute('SELECT id FROM events WHERE id = ?', [eventId]);
    if (!eventRows[0]) return res.status(404).json({ message: 'Event not found' });

    const [result] = await pool.execute(
      `INSERT INTO event_meetups (event_id, host_id, title, description, meeting_spot, meet_at, max_members, is_public, type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId,
        req.user.id,
        title.trim().slice(0, 160),
        description || null,
        meetingSpot || null,
        meetAt || null,
        Math.max(Number(maxMembers) || 0, 0),
        isPublic === false ? false : true,
        type || 'general',
      ],
    );
    const meetupId = result.insertId;

    await pool.execute(
      `INSERT INTO event_meetup_members (meetup_id, user_id, role) VALUES (?, ?, 'host')`,
      [meetupId, req.user.id],
    );

    const [rows] = await pool.execute('SELECT * FROM event_meetups WHERE id = ?', [meetupId]);
    res.status(201).json({ message: 'Group Outing created!', meetup: await decorate(rows[0], req.user.id) });
  } catch (err) {
    console.error('[meetupController.createMeetup]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Join a meet-up                                                      */
/* ------------------------------------------------------------------ */
export const joinMeetup = async (req, res) => {
  try {
    const meetupId = Number(req.params.id);
    const [rows] = await pool.execute('SELECT * FROM event_meetups WHERE id = ?', [meetupId]);
    const meetup = rows[0];
    if (!meetup) return res.status(404).json({ message: 'Meet-up not found' });
    if (!meetup.is_public && meetup.host_id !== req.user.id) {
      return res.status(403).json({ message: 'This meet-up is private' });
    }

    const [existing] = await pool.execute(
      'SELECT id FROM event_meetup_members WHERE meetup_id = ? AND user_id = ?',
      [meetupId, req.user.id],
    );
    if (existing.length) return res.status(400).json({ message: 'You already joined this meet-up' });

    const count = await getMemberCount(meetupId);
    if (meetup.max_members > 0 && count >= meetup.max_members) {
      return res.status(400).json({ message: 'This meet-up is full' });
    }

    await pool.execute(
      `INSERT INTO event_meetup_members (meetup_id, user_id, role) VALUES (?, ?, 'member')`,
      [meetupId, req.user.id],
    );
    res.json({ message: 'You joined the squad!', joined: true });
  } catch (err) {
    console.error('[meetupController.joinMeetup]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Leave a meet-up                                                     */
/* ------------------------------------------------------------------ */
export const leaveMeetup = async (req, res) => {
  try {
    const meetupId = Number(req.params.id);
    await pool.execute(
      'DELETE FROM event_meetup_members WHERE meetup_id = ? AND user_id = ?',
      [meetupId, req.user.id],
    );
    res.json({ message: 'You left the meet-up', joined: false });
  } catch (err) {
    console.error('[meetupController.leaveMeetup]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Delete a meet-up (host or admin)                                    */
/* ------------------------------------------------------------------ */
export const deleteMeetup = async (req, res) => {
  try {
    const meetupId = Number(req.params.id);
    const [rows] = await pool.execute('SELECT * FROM event_meetups WHERE id = ?', [meetupId]);
    const meetup = rows[0];
    if (!meetup) return res.status(404).json({ message: 'Meet-up not found' });
    if (meetup.host_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only the host can delete this meet-up' });
    }
    await pool.execute('DELETE FROM event_meetups WHERE id = ?', [meetupId]);
    res.json({ message: 'Meet-up deleted' });
  } catch (err) {
    console.error('[meetupController.deleteMeetup]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Meet-ups I created or joined                                        */
/* ------------------------------------------------------------------ */
export const getMyMeetups = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT meetup_id FROM event_meetup_members WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id],
    );
    const meetups = [];
    const seen = new Set();
    for (const r of rows) {
      if (seen.has(r.meetup_id)) continue;
      seen.add(r.meetup_id);
      const [mRows] = await pool.execute('SELECT * FROM event_meetups WHERE id = ?', [r.meetup_id]);
      if (mRows[0]) meetups.push(await decorate(mRows[0], req.user.id));
    }
    res.json({ meetups });
  } catch (err) {
    console.error('[meetupController.getMyMeetups]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Event Attendees Wall ("Who's Going")                                */
/* ------------------------------------------------------------------ */
export const getEventAttendees = async (req, res) => {
  try {
    const eventId = Number(req.params.eventId);
    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(DISTINCT user_id) AS total FROM tickets WHERE event_id = ? AND status = 'active'`,
      [eventId],
    );

    const [rows] = await pool.execute(
      `SELECT DISTINCT u.id, u.name, COALESCE(u.avatar_url, u.avatar) AS avatar, u.role
       FROM tickets t
       JOIN users u ON u.id = t.user_id
       WHERE t.event_id = ? AND t.status = 'active'
       LIMIT 30`,
      [eventId],
    );

    res.json({ totalAttendees: Number(total) || 0, attendees: rows });
  } catch (err) {
    console.error('[meetupController.getEventAttendees]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Event Community Discussions                                         */
/* ------------------------------------------------------------------ */
export const getEventDiscussions = async (req, res) => {
  try {
    const eventId = Number(req.params.eventId);
    const [rows] = await pool.execute(
      `SELECT ed.id, ed.event_id, ed.user_id, ed.message, ed.created_at,
              u.name AS user_name, COALESCE(u.avatar_url, u.avatar) AS user_avatar
       FROM event_discussions ed
       JOIN users u ON u.id = ed.user_id
       WHERE ed.event_id = ?
       ORDER BY ed.created_at ASC
       LIMIT 100`,
      [eventId],
    );
    res.json({ discussions: rows });
  } catch (err) {
    console.error('[meetupController.getEventDiscussions]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const postEventDiscussion = async (req, res) => {
  try {
    const eventId = Number(req.params.eventId);
    const { message } = req.body || {};
    if (!message || !message.trim()) {
      return res.status(400).json({ message: 'Message is required' });
    }

    const [result] = await pool.execute(
      `INSERT INTO event_discussions (event_id, user_id, message)
       VALUES (?, ?, ?)`,
      [eventId, req.user.id, message.trim().slice(0, 1000)],
    );

    const [rows] = await pool.execute(
      `SELECT ed.id, ed.event_id, ed.user_id, ed.message, ed.created_at,
              u.name AS user_name, COALESCE(u.avatar_url, u.avatar) AS user_avatar
       FROM event_discussions ed
       JOIN users u ON u.id = ed.user_id
       WHERE ed.id = ?`,
      [result.insertId],
    );

    res.status(201).json({ message: 'Message posted', discussion: rows[0] });
  } catch (err) {
    console.error('[meetupController.postEventDiscussion]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Friends Attending Detection ("5 of your friends are attending")      */
/* ------------------------------------------------------------------ */
export const getFriendsAttending = async (req, res) => {
  try {
    const eventId = Number(req.params.eventId);
    const userId = req.user?.id;
    if (!userId) {
      return res.json({ count: 0, friends: [], headline: '' });
    }

    const [followedRows] = await pool.execute(
      'SELECT following_id FROM user_follows WHERE follower_id = ?',
      [userId],
    );
    if (!followedRows.length) {
      return res.json({ count: 0, friends: [], headline: '' });
    }

    const friendIdSet = new Set(followedRows.map((r) => Number(r.following_id)));

    const [ticketHolders] = await pool.execute(
      `SELECT DISTINCT u.id, u.name, COALESCE(u.avatar_url, u.avatar) AS avatar, u.role
       FROM tickets t
       JOIN users u ON u.id = t.user_id
       WHERE t.event_id = ? AND t.status = 'active'`,
      [eventId],
    );

    const friends = ticketHolders.filter((th) => friendIdSet.has(Number(th.id)));
    const count = friends.length;

    let headline = '';
    if (count === 1) {
      headline = `${friends[0].name} is attending this event`;
    } else if (count > 1) {
      headline = `${count} of your friends are attending this event`;
    }

    res.json({ count, friends, headline });
  } catch (err) {
    console.error('[meetupController.getFriendsAttending]', err);
    res.status(500).json({ message: 'Server error fetching friends attending' });
  }
};

/* ------------------------------------------------------------------ */
/* Event Invites ("Invite Friends to Event")                          */
/* ------------------------------------------------------------------ */
export const inviteFriendsToEvent = async (req, res) => {
  try {
    const eventId = Number(req.params.eventId);
    const { recipientIds, meetupId, note } = req.body || {};

    if (!Array.isArray(recipientIds) || recipientIds.length === 0) {
      return res.status(400).json({ message: 'Please select at least one friend to invite' });
    }

    const [events] = await pool.execute('SELECT id, title FROM events WHERE id = ?', [eventId]);
    const event = events[0];
    if (!event) return res.status(404).json({ message: 'Event not found' });

    const senderName = req.user.name || 'A friend';
    const cleanNote = note ? String(note).trim().slice(0, 250) : null;
    const cleanMeetupId = meetupId ? Number(meetupId) : null;

    const invited = [];
    for (const rawId of recipientIds) {
      const recipientId = Number(rawId);
      if (!recipientId || recipientId === req.user.id) continue;

      await pool.execute(
        `INSERT INTO event_invites (event_id, sender_id, recipient_id, meetup_id, status, note)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
        [eventId, req.user.id, recipientId, cleanMeetupId, cleanNote],
      );

      await sendNotification({
        userId: recipientId,
        type: 'invite',
        title: 'Event Invitation',
        message: `${senderName} invited you to "${event.title}"${cleanNote ? `: "${cleanNote}"` : ''}`,
      });

      invited.push(recipientId);
    }

    res.status(201).json({
      message: `Invited ${invited.length} friend${invited.length === 1 ? '' : 's'}!`,
      invitedCount: invited.length,
      invited,
    });
  } catch (err) {
    console.error('[meetupController.inviteFriendsToEvent]', err);
    res.status(500).json({ message: 'Server error sending invitations' });
  }
};

export const getMyEventInvites = async (req, res) => {
  try {
    const userId = req.user.id;
    const [invites] = await pool.execute(
      `SELECT * FROM event_invites WHERE recipient_id = ? ORDER BY created_at DESC`,
      [userId],
    );

    const result = [];
    for (const inv of invites) {
      const [eRows] = await pool.execute(
        'SELECT id, title, start_date, venue, image_url FROM events WHERE id = ?',
        [inv.event_id],
      );
      const [uRows] = await pool.execute(
        'SELECT id, name, email, COALESCE(avatar_url, avatar) AS avatar FROM users WHERE id = ?',
        [inv.sender_id],
      );
      let meetupTitle = null;
      if (inv.meetup_id) {
        const [mRows] = await pool.execute('SELECT id, title FROM event_meetups WHERE id = ?', [inv.meetup_id]);
        meetupTitle = mRows[0]?.title || null;
      }

      result.push({
        id: inv.id,
        eventId: inv.event_id,
        senderId: inv.sender_id,
        recipientId: inv.recipient_id,
        meetupId: inv.meetup_id,
        status: inv.status,
        note: inv.note,
        createdAt: inv.created_at,
        event: eRows[0] || null,
        sender: uRows[0] || null,
        meetupTitle,
      });
    }

    res.json({ invites: result });
  } catch (err) {
    console.error('[meetupController.getMyEventInvites]', err);
    res.status(500).json({ message: 'Server error fetching event invites' });
  }
};

export const respondToEventInvite = async (req, res) => {
  try {
    const inviteId = Number(req.params.id);
    const { status } = req.body || {};
    if (!['accepted', 'declined'].includes(status)) {
      return res.status(400).json({ message: 'Status must be either accepted or declined' });
    }

    const [rows] = await pool.execute('SELECT * FROM event_invites WHERE id = ?', [inviteId]);
    const invite = rows[0];
    if (!invite) return res.status(404).json({ message: 'Invite not found' });
    if (invite.recipient_id !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to respond to this invite' });
    }

    await pool.execute('UPDATE event_invites SET status = ? WHERE id = ?', [status, inviteId]);

    // If accepted and there was a meetup attached, auto-join meetup
    if (status === 'accepted' && invite.meetup_id) {
      const [memberRows] = await pool.execute(
        'SELECT id FROM event_meetup_members WHERE meetup_id = ? AND user_id = ?',
        [invite.meetup_id, req.user.id],
      );
      if (!memberRows.length) {
        await pool.execute(
          `INSERT INTO event_meetup_members (meetup_id, user_id, role) VALUES (?, ?, 'member')`,
          [invite.meetup_id, req.user.id],
        );
      }
    }

    // Send notification to sender
    const [eRows] = await pool.execute('SELECT title FROM events WHERE id = ?', [invite.event_id]);
    const eventTitle = eRows[0]?.title || 'the event';
    const actionText = status === 'accepted' ? 'accepted' : 'declined';

    await sendNotification({
      userId: invite.sender_id,
      type: status === 'accepted' ? 'social' : 'info',
      title: status === 'accepted' ? 'Invite Accepted! 🎉' : 'Invite Update',
      message: `${req.user.name || 'Your friend'} has ${actionText} your invite to "${eventTitle}".`,
    });

    res.json({ message: `Invite ${status}`, status });
  } catch (err) {
    console.error('[meetupController.respondToEventInvite]', err);
    res.status(500).json({ message: 'Server error updating invite' });
  }
};

/* ------------------------------------------------------------------ */
/* Squad / Meetup Chat                                                 */
/* ------------------------------------------------------------------ */
export const getMeetupMessages = async (req, res) => {
  try {
    const meetupId = Number(req.params.id);
    const [meetups] = await pool.execute('SELECT id FROM event_meetups WHERE id = ?', [meetupId]);
    if (!meetups[0]) return res.status(404).json({ message: 'Meetup not found' });

    const [msgRows] = await pool.execute(
      `SELECT * FROM meetup_messages WHERE meetup_id = ? ORDER BY created_at ASC`,
      [meetupId],
    );

    const messages = [];
    for (const m of msgRows) {
      const [uRows] = await pool.execute(
        'SELECT id, name, COALESCE(avatar_url, avatar) AS avatar FROM users WHERE id = ?',
        [m.user_id],
      );
      const user = uRows[0] || { id: m.user_id, name: 'Anonymous', avatar: null };
      messages.push({
        id: m.id,
        meetupId: m.meetup_id,
        userId: m.user_id,
        message: m.message,
        createdAt: m.created_at,
        userName: user.name,
        userAvatar: user.avatar,
      });
    }

    res.json({ messages });
  } catch (err) {
    console.error('[meetupController.getMeetupMessages]', err);
    res.status(500).json({ message: 'Server error fetching messages' });
  }
};

export const postMeetupMessage = async (req, res) => {
  try {
    const meetupId = Number(req.params.id);
    const { message } = req.body || {};
    if (!message || !message.trim()) {
      return res.status(400).json({ message: 'Message content is required' });
    }

    const [meetups] = await pool.execute('SELECT id, title FROM event_meetups WHERE id = ?', [meetupId]);
    if (!meetups[0]) return res.status(404).json({ message: 'Meetup not found' });

    // Auto-join member if not already in squad
    const [memberRows] = await pool.execute(
      'SELECT id FROM event_meetup_members WHERE meetup_id = ? AND user_id = ?',
      [meetupId, req.user.id],
    );
    if (!memberRows.length) {
      await pool.execute(
        `INSERT INTO event_meetup_members (meetup_id, user_id, role) VALUES (?, ?, 'member')`,
        [meetupId, req.user.id],
      );
    }

    const cleanMsg = message.trim().slice(0, 1000);
    const [result] = await pool.execute(
      `INSERT INTO meetup_messages (meetup_id, user_id, message) VALUES (?, ?, ?)`,
      [meetupId, req.user.id, cleanMsg],
    );

    const [uRows] = await pool.execute(
      'SELECT id, name, COALESCE(avatar_url, avatar) AS avatar FROM users WHERE id = ?',
      [req.user.id],
    );
    const user = uRows[0] || { id: req.user.id, name: req.user.name, avatar: null };

    const messageItem = {
      id: result.insertId,
      meetupId,
      userId: req.user.id,
      message: cleanMsg,
      createdAt: new Date().toISOString(),
      userName: user.name,
      userAvatar: user.avatar,
    };

    res.status(201).json({ message: 'Message sent', messageItem });
  } catch (err) {
    console.error('[meetupController.postMeetupMessage]', err);
    res.status(500).json({ message: 'Server error posting message' });
  }
};

export default {
  getEventMeetups, createMeetup, joinMeetup, leaveMeetup, deleteMeetup, getMyMeetups,
  getEventAttendees, getEventDiscussions, postEventDiscussion,
  getFriendsAttending, inviteFriendsToEvent, getMyEventInvites, respondToEventInvite,
  getMeetupMessages, postMeetupMessage,
};

