import bcrypt from 'bcryptjs';
import pool from '../config/db.js';
import { logAudit } from '../utils/audit.js';
import { validatePassword } from '../utils/password.js';
import { sendNotification } from '../utils/notify.js';


/* ------------------------------------------------------------------ */
/* Notification preference helpers                                     */
/* ------------------------------------------------------------------ */
// UI names (ProfilePage notification settings) ↔ DB columns.
const PREF_UI_TO_DB = {
  emailTicketConfirmations: 'email_tickets',
  emailEventReminders: 'email_reminders',
  emailPromotions: 'email_offers',
  smsTicketConfirmations: 'sms_tickets',
  smsEventReminders: 'sms_reminders',
};

const readNotificationSettings = (row) => ({
  emailTicketConfirmations: row?.email_tickets !== 0 && row?.email_tickets !== false,
  emailEventReminders: row?.email_reminders !== 0 && row?.email_reminders !== false,
  emailPromotions: row?.email_offers === 1 || row?.email_offers === true,
  smsTicketConfirmations: row?.sms_tickets === 1 || row?.sms_tickets === true,
  smsEventReminders: row?.sms_reminders === 1 || row?.sms_reminders === true,
  pushTicketConfirmations: row?.push_enabled !== 0 && row?.push_enabled !== false,
  pushEventReminders: row?.push_enabled !== 0 && row?.push_enabled !== false,
  pushPromotions: false,
});

const saveNotificationSettings = async (userId, settings) => {
  const emailTickets = settings.emailTicketConfirmations !== false;
  const emailReminders = settings.emailEventReminders !== false;
  const emailOffers = settings.emailPromotions === true;
  const smsTickets = settings.smsTicketConfirmations === true;
  const smsReminders = settings.smsEventReminders === true;
  // push_enabled is the master in-app channel (used for ticket confirmations
  // and event reminders); both UI toggles mirror it.
  const pushEnabled = settings.pushEventReminders !== false && settings.pushTicketConfirmations !== false;

  const [existing] = await pool.execute(
    'SELECT id FROM notification_preferences WHERE user_id = ?',
    [userId],
  );
  if (existing.length) {
    await pool.execute(
      `UPDATE notification_preferences
       SET email_tickets = ?, email_reminders = ?, email_offers = ?,
           sms_tickets = ?, sms_reminders = ?, push_enabled = ?
       WHERE user_id = ?`,
      [emailTickets, emailReminders, emailOffers, smsTickets, smsReminders, pushEnabled, userId],
    );
  } else {
    await pool.execute(
      `INSERT INTO notification_preferences
         (user_id, email_tickets, email_reminders, email_offers, sms_tickets, sms_reminders, push_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, emailTickets, emailReminders, emailOffers, smsTickets, smsReminders, pushEnabled],
    );
  }
};

/* ------------------------------------------------------------------ */
/* Get profile                                                         */
/* ------------------------------------------------------------------ */
export const getProfile = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT u.*, op.organization_name, op.description, op.website, op.social_links,
              op.logo_url AS logo, op.banner_url AS banner, op.is_verified
       FROM users u
       LEFT JOIN organizer_profiles op ON op.user_id = u.id
       WHERE u.id = ?`,
      [req.user.id],
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ message: 'User not found' });

    const [prefRows] = await pool.execute(
      'SELECT * FROM notification_preferences WHERE user_id = ?',
      [req.user.id],
    );

    const { password, reset_token, reset_expires, ...profile } = user;
    let favoriteCategories = [];
    if (profile.favorite_categories) {
      favoriteCategories = typeof profile.favorite_categories === 'string'
        ? JSON.parse(profile.favorite_categories || '[]')
        : (Array.isArray(profile.favorite_categories) ? profile.favorite_categories : []);
    }

    res.json({
      user: {
        ...profile,
        dateOfBirth: profile.date_of_birth || null,
        favoriteCategories,
        favorite_categories: favoriteCategories,
        notificationSettings: readNotificationSettings(prefRows[0]),
      },
    });
  } catch (err) {
    console.error('[userController.getProfile]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Update profile                                                      */
/* ------------------------------------------------------------------ */
export const updateProfile = async (req, res) => {
  try {
    // name/phone/avatar are users columns; bio/location/dateOfBirth come from
    // the attendee Personal Info tab. notificationSettings maps to the
    // notification_preferences table.
    const fieldMap = {
      name: 'name',
      phone: 'phone',
      avatar: 'avatar',
      bio: 'bio',
      location: 'location',
      city: 'location',
      dateOfBirth: 'date_of_birth',
    };
    const fields = [];
    const values = [];
    for (const [key, column] of Object.entries(fieldMap)) {
      if (req.body[key] !== undefined) {
        fields.push(`${column} = ?`);
        values.push(req.body[key] === '' ? null : req.body[key]);
      }
    }

    if (req.body.favoriteCategories !== undefined || req.body.favorite_categories !== undefined) {
      const cats = req.body.favoriteCategories ?? req.body.favorite_categories;
      const formatted = Array.isArray(cats) ? JSON.stringify(cats) : (cats || '[]');
      fields.push('favorite_categories = ?');
      values.push(formatted);
    }

    if (req.user.role === 'organizer' && req.body.organization_name !== undefined) {
      // Update organizer-specific profile fields.
      await pool.execute(
        `UPDATE organizer_profiles SET organization_name = ? WHERE user_id = ?`,
        [req.body.organization_name, req.user.id],
      );
    }

    if (fields.length) {
      values.push(req.user.id);
      await pool.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
    }

    if (req.body.notificationSettings && typeof req.body.notificationSettings === 'object') {
      await saveNotificationSettings(req.user.id, req.body.notificationSettings);
    }

    await logAudit({ userId: req.user.id, action: 'update_profile', entityType: 'user', entityId: req.user.id });
    res.json({ message: 'Profile updated' });
  } catch (err) {
    console.error('[userController.updateProfile]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Change password                                                     */
/* ------------------------------------------------------------------ */
export const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'currentPassword and newPassword are required' });
    }
    const strength = validatePassword(newPassword);
    if (!strength.valid) {
      return res.status(400).json({ message: strength.message });
    }

    const [rows] = await pool.execute('SELECT password FROM users WHERE id = ?', [req.user.id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ message: 'User not found' });

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return res.status(400).json({ message: 'Current password is incorrect' });

    const hashed = await bcrypt.hash(newPassword, 12);
    await pool.execute('UPDATE users SET password = ? WHERE id = ?', [hashed, req.user.id]);

    await logAudit({ userId: req.user.id, action: 'change_password', entityType: 'user', entityId: req.user.id });
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    console.error('[userController.changePassword]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */
export const getNotifications = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC`,
      [req.user.id],
    );
    const unread = rows.filter((r) => !r.is_read).length;
    res.json({ notifications: rows, unread });
  } catch (err) {
    console.error('[userController.getNotifications]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const markNotificationRead = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute(
      `UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?`,
      [id, req.user.id],
    );
    res.json({ message: 'Notification marked as read' });
  } catch (err) {
    console.error('[userController.markNotificationRead]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const markAllNotificationsRead = async (req, res) => {
  try {
    await pool.execute(
      `UPDATE notifications SET is_read = TRUE WHERE user_id = ?`,
      [req.user.id],
    );
    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    console.error('[userController.markAllNotificationsRead]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const deleteNotification = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute(
      `DELETE FROM notifications WHERE id = ? AND user_id = ?`,
      [id, req.user.id],
    );
    res.json({ message: 'Notification deleted' });
  } catch (err) {
    console.error('[userController.deleteNotification]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Favorites                                                           */
/* ------------------------------------------------------------------ */
export const getFavorites = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT f.id AS favorite_id, f.created_at AS favorited_at, e.*
       FROM favorites f
       JOIN events e ON e.id = f.event_id
       WHERE f.user_id = ?
       ORDER BY f.created_at DESC`,
      [req.user.id],
    );
    res.json({ favorites: rows });
  } catch (err) {
    console.error('[userController.getFavorites]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const toggleFavorite = async (req, res) => {
  try {
    const { eventId } = req.body;
    if (!eventId) return res.status(400).json({ message: 'eventId is required' });

    const [existing] = await pool.execute(
      'SELECT id FROM favorites WHERE user_id = ? AND event_id = ?',
      [req.user.id, eventId],
    );

    if (existing.length) {
      await pool.execute('DELETE FROM favorites WHERE user_id = ? AND event_id = ?', [req.user.id, eventId]);
      return res.json({ message: 'Removed from favorites', favorited: false });
    }

    await pool.execute(
      'INSERT INTO favorites (user_id, event_id) VALUES (?, ?)',
      [req.user.id, eventId],
    );
    res.json({ message: 'Added to favorites', favorited: true });
  } catch (err) {
    console.error('[userController.toggleFavorite]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Follow organizers                                                  */
/* ------------------------------------------------------------------ */
export const followOrganizer = async (req, res) => {
  try {
    const organizerId = Number(req.params.id);
    if (organizerId === req.user.id) {
      return res.status(400).json({ message: 'You cannot follow yourself' });
    }

    const [orgRows] = await pool.execute(
      'SELECT id FROM users WHERE id = ? AND role = ?',
      [organizerId, 'organizer'],
    );
    if (!orgRows[0]) return res.status(404).json({ message: 'Organizer not found' });

    await pool.execute(
      'INSERT INTO organizer_follows (follower_id, organizer_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
      [req.user.id, organizerId],
    );
    res.json({ message: 'Now following this organizer', following: true });
  } catch (err) {
    console.error('[userController.followOrganizer]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const unfollowOrganizer = async (req, res) => {
  try {
    const organizerId = Number(req.params.id);
    await pool.execute(
      'DELETE FROM organizer_follows WHERE follower_id = ? AND organizer_id = ?',
      [req.user.id, organizerId],
    );
    res.json({ message: 'Unfollowed organizer', following: false });
  } catch (err) {
    console.error('[userController.unfollowOrganizer]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getFollowing = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT organizer_id, created_at FROM organizer_follows
       WHERE follower_id = ? ORDER BY created_at DESC`,
      [req.user.id],
    );

    const following = [];
    for (const f of rows) {
      const [userRows] = await pool.execute(
        'SELECT id, name, email, avatar FROM users WHERE id = ?',
        [f.organizer_id],
      );
      const u = userRows[0];
      if (!u) continue;
      const [orgRows] = await pool.execute(
        'SELECT organization_name FROM organizer_profiles WHERE user_id = ?',
        [f.organizer_id],
      );
      const [[{ total }]] = await pool.execute(
        'SELECT COUNT(*) AS total FROM organizer_follows WHERE organizer_id = ?',
        [f.organizer_id],
      );
      following.push({
        id: u.id,
        name: u.name,
        email: u.email,
        avatar: u.avatar,
        organizationName: orgRows[0]?.organization_name || u.name,
        followersCount: Number(total) || 0,
        followedAt: f.created_at,
      });
    }
    res.json({ following });
  } catch (err) {
    console.error('[userController.getFollowing]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getFollowingEvents = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT organizer_id FROM organizer_follows WHERE follower_id = ?`,
      [req.user.id],
    );
    const organizerIds = rows.map((r) => r.organizer_id);

    const events = [];
    for (const orgId of organizerIds) {
      const [eventRows] = await pool.execute(
        `SELECT e.*, u.name AS organizer_name,
                (SELECT MIN(price) FROM ticket_types WHERE event_id = e.id) AS min_price
         FROM events e
         LEFT JOIN users u ON u.id = e.organizer_id
         WHERE e.organizer_id = ? AND e.status = 'published' AND e.start_date >= CURRENT_DATE
         ORDER BY e.start_date ASC
         LIMIT 8`,
        [orgId],
      );
      events.push(...eventRows);
    }

    events.sort((a, b) => new Date(a.start_date) - new Date(b.start_date));
    res.json({ events: events.slice(0, 8) });
  } catch (err) {
    console.error('[userController.getFollowingEvents]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Follow / Unfollow Artists                                          */
/* ------------------------------------------------------------------ */
export const followArtist = async (req, res) => {
  try {
    const artistName = decodeURIComponent(req.params.name || req.body.artistName || '').trim();
    if (!artistName) return res.status(400).json({ message: 'Artist name is required' });

    await pool.execute(
      'INSERT INTO artist_follows (user_id, artist_name) VALUES (?, ?) ON CONFLICT DO NOTHING',
      [req.user.id, artistName],
    );
    res.json({ message: `Now following ${artistName}`, following: true, isFollowing: true, artist: artistName });
  } catch (err) {
    console.error('[userController.followArtist]', err);
    res.status(500).json({ message: 'Server error following artist' });
  }
};

export const unfollowArtist = async (req, res) => {
  try {
    const artistName = decodeURIComponent(req.params.name || req.body?.artistName || req.body?.name || req.query?.name || '').trim();
    if (!artistName) return res.status(400).json({ message: 'Artist name is required' });

    await pool.execute(
      'DELETE FROM artist_follows WHERE user_id = ? AND LOWER(artist_name) = LOWER(?)',
      [req.user.id, artistName],
    );
    res.json({ message: `Unfollowed ${artistName}`, following: false, isFollowing: false, artist: artistName });
  } catch (err) {
    console.error('[userController.unfollowArtist]', err);
    res.status(500).json({ message: 'Server error unfollowing artist' });
  }
};

export const getFollowedArtists = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, artist_name, created_at FROM artist_follows WHERE user_id = ? ORDER BY created_at DESC`,
      [req.user.id],
    );
    res.json({ artists: rows });
  } catch (err) {
    console.error('[userController.getFollowedArtists]', err);
    res.status(500).json({ message: 'Server error fetching followed artists' });
  }
};

export const checkArtistFollowStatus = async (req, res) => {
  try {
    const artistName = decodeURIComponent(req.params.name || req.query?.name || req.query?.artistName || '').trim();
    const [rows] = await pool.execute(
      'SELECT id FROM artist_follows WHERE user_id = ? AND LOWER(artist_name) = LOWER(?)',
      [req.user.id, artistName],
    );
    const isFoll = rows.length > 0;
    res.json({ following: isFoll, isFollowing: isFoll });
  } catch (err) {
    console.error('[userController.checkArtistFollowStatus]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Follow / Unfollow Categories                                       */
/* ------------------------------------------------------------------ */
export const followCategory = async (req, res) => {
  try {
    const categoryName = decodeURIComponent(req.params.name || req.body.categoryName || '').trim();
    if (!categoryName) return res.status(400).json({ message: 'Category name is required' });

    await pool.execute(
      'INSERT INTO category_follows (user_id, category_name) VALUES (?, ?) ON CONFLICT DO NOTHING',
      [req.user.id, categoryName],
    );

    // Sync with user's favorite_categories JSONB
    try {
      const [uRows] = await pool.execute('SELECT favorite_categories FROM users WHERE id = ?', [req.user.id]);
      if (uRows[0]) {
        let favs = uRows[0].favorite_categories;
        if (typeof favs === 'string') {
          try { favs = JSON.parse(favs); } catch { favs = []; }
        }
        favs = Array.isArray(favs) ? favs : [];
        if (!favs.some((c) => c.toLowerCase() === categoryName.toLowerCase())) {
          favs.push(categoryName);
          await pool.execute('UPDATE users SET favorite_categories = ? WHERE id = ?', [JSON.stringify(favs), req.user.id]);
        }
      }
    } catch {
      // non-fatal
    }

    res.json({ message: `Now following ${categoryName}`, following: true, isFollowing: true, category: categoryName });
  } catch (err) {
    console.error('[userController.followCategory]', err);
    res.status(500).json({ message: 'Server error following category' });
  }
};

export const unfollowCategory = async (req, res) => {
  try {
    const categoryName = decodeURIComponent(req.params.name || req.body?.categoryName || req.body?.name || req.query?.name || '').trim();
    if (!categoryName) return res.status(400).json({ message: 'Category name is required' });

    await pool.execute(
      'DELETE FROM category_follows WHERE user_id = ? AND LOWER(category_name) = LOWER(?)',
      [req.user.id, categoryName],
    );

    // Remove from favorite_categories JSONB as well
    try {
      const [uRows] = await pool.execute('SELECT favorite_categories FROM users WHERE id = ?', [req.user.id]);
      if (uRows[0]) {
        let favs = uRows[0].favorite_categories;
        if (typeof favs === 'string') {
          try { favs = JSON.parse(favs); } catch { favs = []; }
        }
        favs = Array.isArray(favs) ? favs : [];
        favs = favs.filter((c) => c.toLowerCase() !== categoryName.toLowerCase());
        await pool.execute('UPDATE users SET favorite_categories = ? WHERE id = ?', [JSON.stringify(favs), req.user.id]);
      }
    } catch {
      // non-fatal
    }

    res.json({ message: `Unfollowed ${categoryName}`, following: false, isFollowing: false, category: categoryName });
  } catch (err) {
    console.error('[userController.unfollowCategory]', err);
    res.status(500).json({ message: 'Server error unfollowing category' });
  }
};

export const getFollowedCategories = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, category_name, created_at FROM category_follows WHERE user_id = ? ORDER BY created_at DESC`,
      [req.user.id],
    );
    res.json({ categories: rows });
  } catch (err) {
    console.error('[userController.getFollowedCategories]', err);
    res.status(500).json({ message: 'Server error fetching followed categories' });
  }
};

export const checkCategoryFollowStatus = async (req, res) => {
  try {
    const categoryName = decodeURIComponent(req.params.name || req.query?.name || req.query?.categoryName || '').trim();
    const [rows] = await pool.execute(
      'SELECT id FROM category_follows WHERE user_id = ? AND LOWER(category_name) = LOWER(?)',
      [req.user.id, categoryName],
    );
    const isFoll = rows.length > 0;
    res.json({ following: isFoll, isFollowing: isFoll });
  } catch (err) {
    console.error('[userController.checkCategoryFollowStatus]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Unified Following Summary (Organizers, Artists, Categories, Events)*/
/* ------------------------------------------------------------------ */
export const getFollowingSummary = async (req, res) => {
  try {
    const userId = req.user.id;

    // Organizers
    const [orgRows] = await pool.execute(
      `SELECT of.organizer_id, of.created_at, u.name, u.avatar, op.organization_name
       FROM organizer_follows of
       JOIN users u ON u.id = of.organizer_id
       LEFT JOIN organizer_profiles op ON op.user_id = of.organizer_id
       WHERE of.follower_id = ?
       ORDER BY of.created_at DESC`,
      [userId],
    );

    // Artists
    const [artRows] = await pool.execute(
      `SELECT id, artist_name, created_at FROM artist_follows WHERE user_id = ? ORDER BY created_at DESC`,
      [userId],
    );

    // Categories
    const [catRows] = await pool.execute(
      `SELECT id, category_name, created_at FROM category_follows WHERE user_id = ? ORDER BY created_at DESC`,
      [userId],
    );

    // Favorites
    const [favRows] = await pool.execute(
      `SELECT f.event_id, f.created_at, e.title, e.banner_image, e.start_date, e.venue, e.city
       FROM favorites f
       JOIN events e ON e.id = f.event_id
       WHERE f.user_id = ?
       ORDER BY f.created_at DESC
       LIMIT 10`,
      [userId],
    );

    res.json({
      organizers: orgRows.map((r) => ({
        id: r.organizer_id,
        organizer_id: r.organizer_id,
        name: r.organization_name || r.name,
        organization_name: r.organization_name || r.name,
        avatar: r.avatar,
        followedAt: r.created_at,
      })),
      artists: artRows.map((r) => ({
        id: r.id,
        name: r.artist_name,
        artist_name: r.artist_name,
        followedAt: r.created_at,
      })),
      categories: catRows.map((r) => ({
        id: r.id,
        name: r.category_name,
        category_name: r.category_name,
        followedAt: r.created_at,
      })),
      favorites: favRows,
      counts: {
        organizers: orgRows.length,
        artists: artRows.length,
        categories: catRows.length,
        favorites: favRows.length,
      },
    });
  } catch (err) {
    console.error('[userController.getFollowingSummary]', err);
    res.status(500).json({ message: 'Server error fetching following summary' });
  }
};

/* ------------------------------------------------------------------ */
/* Reviews                                                             */
/* ------------------------------------------------------------------ */
export const getReviews = async (req, res) => {
  try {
    const eventId = req.params.eventId || req.query.eventId;
    let sql = `SELECT r.*, u.name AS user_name, u.avatar AS user_avatar, e.title AS event_title
               FROM reviews r
               LEFT JOIN users u ON u.id = r.user_id
               LEFT JOIN events e ON e.id = r.event_id`;
    const params = [];
    if (eventId) {
      sql += ` WHERE r.event_id = ?`;
      params.push(eventId);
    } else {
      sql += ` WHERE r.user_id = ?`;
      params.push(req.user.id);
    }
    sql += ` ORDER BY r.created_at DESC`;
    const [rows] = await pool.execute(sql, params);
    res.json({ reviews: rows });
  } catch (err) {
    console.error('[userController.getReviews]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const createReview = async (req, res) => {
  try {
    const eventId = req.params.eventId || req.body.eventId;
    const rating = req.body.rating;
    const comment = req.body.comment ?? req.body.review ?? null;

    if (!eventId) return res.status(400).json({ message: 'eventId is required' });
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'Rating must be between 1 and 5' });
    }

    const [eventRows] = await pool.execute('SELECT * FROM events WHERE id = ?', [eventId]);
    if (!eventRows[0]) return res.status(404).json({ message: 'Event not found' });

    const [existing] = await pool.execute(
      'SELECT id FROM reviews WHERE user_id = ? AND event_id = ?',
      [req.user.id, eventId],
    );
    if (existing.length) {
      return res.status(400).json({ message: 'You have already reviewed this event' });
    }

    const [result] = await pool.execute(
      `INSERT INTO reviews (user_id, event_id, rating, comment) VALUES (?, ?, ?, ?)`,
      [req.user.id, eventId, rating, comment],
    );

    const [newRows] = await pool.execute(
      `SELECT r.*, u.name AS user_name, e.title AS event_title
       FROM reviews r
       LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN events e ON e.id = r.event_id
       WHERE r.id = ?`,
      [result.insertId],
    );

    res.status(201).json({ message: 'Review added', review: newRows[0] });
  } catch (err) {
    console.error('[userController.createReview]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const deleteReview = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute(
      'SELECT id FROM reviews WHERE id = ? AND user_id = ?',
      [id, req.user.id],
    );
    if (!rows.length) return res.status(404).json({ message: 'Review not found' });

    await pool.execute(
      'DELETE FROM reviews WHERE id = ? AND user_id = ?',
      [id, req.user.id],
    );
    res.json({ message: 'Review deleted' });
  } catch (err) {
    console.error('[userController.deleteReview]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Social: Follow Friends & Cliq Connections                           */
/* ------------------------------------------------------------------ */
export const followUser = async (req, res) => {
  try {
    const followerId = req.user.id;
    const followingId = Number(req.params.id || req.body.userId);
    if (!followingId || isNaN(followingId)) return res.status(400).json({ message: 'Valid user ID required' });
    if (followerId === followingId) return res.status(400).json({ message: 'You cannot follow yourself' });

    const [targetUser] = await pool.execute('SELECT id, name FROM users WHERE id = ?', [followingId]);
    if (!targetUser.length) return res.status(404).json({ message: 'User not found' });

    await pool.execute(
      'INSERT INTO user_follows (follower_id, following_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
      [followerId, followingId],
    );

    sendNotification({
      userId: followingId,
      title: 'New Tribe Member',
      message: `${req.user.name || 'A user'} started following you on Tribes & Cliqs!`,
      type: 'social',
    }).catch(() => {});

    res.status(201).json({
      message: `Now following ${targetUser[0].name}`,
      following: true,
      isFollowing: true,
      targetUserId: followingId,
    });

  } catch (err) {
    console.error('[userController.followUser]', err);
    res.status(500).json({ message: 'Server error following user' });
  }
};

export const unfollowUser = async (req, res) => {
  try {
    const followerId = req.user.id;
    const followingId = Number(req.params.id || req.body.userId);
    if (!followingId || isNaN(followingId)) return res.status(400).json({ message: 'Valid user ID required' });

    await pool.execute(
      'DELETE FROM user_follows WHERE follower_id = ? AND following_id = ?',
      [followerId, followingId],
    );
    res.json({
      message: 'Unfollowed successfully',
      following: false,
      isFollowing: false,
      targetUserId: followingId,
    });
  } catch (err) {
    console.error('[userController.unfollowUser]', err);
    res.status(500).json({ message: 'Server error unfollowing user' });
  }
};

export const checkUserFollow = async (req, res) => {
  try {
    const followerId = req.user?.id;
    const followingId = Number(req.params.id);
    if (!followerId || !followingId) return res.json({ following: false, isFollowing: false });

    const [rows] = await pool.execute(
      'SELECT id FROM user_follows WHERE follower_id = ? AND following_id = ?',
      [followerId, followingId],
    );
    const isFoll = rows.length > 0;
    res.json({ following: isFoll, isFollowing: isFoll });
  } catch (err) {
    console.error('[userController.checkUserFollow]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getFriendsList = async (req, res) => {
  try {
    const userId = req.user.id;
    // Users that current user follows (friends)
    const [followingRows] = await pool.execute(
      `SELECT u.id, u.name, u.email, COALESCE(u.avatar_url, u.avatar) AS avatar, u.role, uf.created_at AS followed_at
       FROM user_follows uf
       JOIN users u ON u.id = uf.following_id
       WHERE uf.follower_id = ?
       ORDER BY uf.created_at DESC`,
      [userId],
    );

    // Users following current user
    const [followerRows] = await pool.execute(
      `SELECT u.id, u.name, u.email, COALESCE(u.avatar_url, u.avatar) AS avatar, u.role, uf.created_at AS followed_at
       FROM user_follows uf
       JOIN users u ON u.id = uf.follower_id
       WHERE uf.following_id = ?
       ORDER BY uf.created_at DESC`,
      [userId],
    );

    res.json({
      following: followingRows,
      followers: followerRows,
      counts: {
        following: followingRows.length,
        followers: followerRows.length,
      },
    });
  } catch (err) {
    console.error('[userController.getFriendsList]', err);
    res.status(500).json({ message: 'Server error fetching friends' });
  }
};

export const searchFriends = async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const currentUserId = req.user.id;
    if (!q) {
      const [rows] = await pool.execute(
        `SELECT u.id, u.name, u.email, COALESCE(u.avatar_url, u.avatar) AS avatar, u.role,
                EXISTS(SELECT 1 FROM user_follows WHERE follower_id = ? AND following_id = u.id) AS is_following
         FROM users u
         WHERE u.id <> ? AND u.status = 'active'
         LIMIT 20`,
        [currentUserId, currentUserId],
      );
      return res.json({ users: rows });
    }

    const [rows] = await pool.execute(
      `SELECT u.id, u.name, u.email, COALESCE(u.avatar_url, u.avatar) AS avatar, u.role,
              EXISTS(SELECT 1 FROM user_follows WHERE follower_id = ? AND following_id = u.id) AS is_following
       FROM users u
       WHERE u.id <> ? AND u.status = 'active' AND (LOWER(u.name) LIKE ? OR LOWER(u.email) LIKE ?)
       LIMIT 20`,
      [currentUserId, currentUserId, `%${q}%`, `%${q}%`],
    );
    res.json({ users: rows });
  } catch (err) {
    console.error('[userController.searchFriends]', err);
    res.status(500).json({ message: 'Server error searching friends' });
  }
};

export default {
  getProfile, updateProfile, changePassword,
  getNotifications, markNotificationRead, markAllNotificationsRead, deleteNotification,
  getFavorites, toggleFavorite,
  followOrganizer, unfollowOrganizer, getFollowing, getFollowingEvents,
  followArtist, unfollowArtist, getFollowedArtists, checkArtistFollowStatus,
  followCategory, unfollowCategory, getFollowedCategories, checkCategoryFollowStatus,
  getFollowingSummary,
  followUser, unfollowUser, checkUserFollow, getFriendsList, searchFriends,
  getReviews, createReview, deleteReview,
};

