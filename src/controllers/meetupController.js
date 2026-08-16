import pool from '../config/db.js';

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

const decorate = async (meetup, userId) => ({
  id: meetup.id,
  eventId: meetup.event_id,
  hostId: meetup.host_id,
  host: await getHost(meetup.host_id),
  title: meetup.title,
  description: meetup.description,
  meetingSpot: meetup.meeting_spot,
  meetAt: meetup.meet_at,
  maxMembers: Number(meetup.max_members) || 0,
  isPublic: !!meetup.is_public,
  createdAt: meetup.created_at,
  memberCount: await getMemberCount(meetup.id),
  joined: userId != null
    ? !!(await pool.execute(
      'SELECT id FROM event_meetup_members WHERE meetup_id = ? AND user_id = ?',
      [meetup.id, userId],
    ))[0].length
    : false,
});

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
    const { title, description, meetingSpot, meetAt, maxMembers, isPublic } = req.body || {};

    if (!title || !title.trim()) return res.status(400).json({ message: 'A title is required' });

    const [eventRows] = await pool.execute('SELECT id FROM events WHERE id = ?', [eventId]);
    if (!eventRows[0]) return res.status(404).json({ message: 'Event not found' });

    const [result] = await pool.execute(
      `INSERT INTO event_meetups (event_id, host_id, title, description, meeting_spot, meet_at, max_members, is_public)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId,
        req.user.id,
        title.trim().slice(0, 160),
        description || null,
        meetingSpot || null,
        meetAt || null,
        Math.max(Number(maxMembers) || 0, 0),
        isPublic === false ? false : true,
      ],
    );
    const meetupId = result.insertId;

    await pool.execute(
      `INSERT INTO event_meetup_members (meetup_id, user_id, role) VALUES (?, ?, 'host')`,
      [meetupId, req.user.id],
    );

    const [rows] = await pool.execute('SELECT * FROM event_meetups WHERE id = ?', [meetupId]);
    res.status(201).json({ message: 'Meet-up created', meetup: await decorate(rows[0], req.user.id) });
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
    res.json({ message: 'You joined the meet-up', joined: true });
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

export default {
  getEventMeetups, createMeetup, joinMeetup, leaveMeetup, deleteMeetup, getMyMeetups,
};
