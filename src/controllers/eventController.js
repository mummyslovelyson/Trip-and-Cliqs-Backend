import pool from '../config/db.js';
import { logAudit } from '../utils/audit.js';

// JSON columns (images, tags) arrive as strings from MySQL — normalise to
// arrays so the API always hands the frontend something it can iterate.
const parseJsonArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

/* ------------------------------------------------------------------ */
/* Get events — public, with filters                                   */
/* ------------------------------------------------------------------ */
export const getEvents = async (req, res) => {
  try {
    const {
      category,
      price,        // 'free' | 'paid'
      date,         // ISO date or 'today' | 'tomorrow' | 'weekend' | 'this_week'
      location,     // city
      search,
      page = 1,
      limit = 10,
    } = req.query;

    const conditions = [`e.status = 'published'`, `e.visibility = 'public'`];
    const params = [];

    if (category && category !== 'all') {
      conditions.push(`e.category = ?`);
      params.push(category);
    }

    if (price === 'free') {
      conditions.push(`EXISTS (SELECT 1 FROM ticket_types tt WHERE tt.event_id = e.id AND tt.price = 0)`);
    } else if (price === 'paid') {
      conditions.push(`EXISTS (SELECT 1 FROM ticket_types tt WHERE tt.event_id = e.id AND tt.price > 0)`);
    }

    if (date) {
      if (date === 'today') {
        conditions.push(`e.start_date = CURDATE()`);
      } else if (date === 'tomorrow') {
        conditions.push(`e.start_date = DATE_ADD(CURDATE(), INTERVAL 1 DAY)`);
      } else if (date === 'this_week') {
        conditions.push(`e.start_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)`);
      } else if (date === 'weekend') {
        conditions.push(`WEEKDAY(e.start_date) IN (5,6) AND e.start_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)`);
      } else {
        conditions.push(`e.start_date >= ?`);
        params.push(date);
      }
    }

    if (location && location !== 'all') {
      conditions.push(`(e.city = ? OR e.country = ?)`);
      params.push(location, location);
    }

    if (search) {
      conditions.push(`(e.title LIKE ? OR e.description LIKE ? OR e.venue LIKE ? OR e.category LIKE ?)`);
      const q = `%${search}%`;
      params.push(q, q, q, q);
    }

    const where = conditions.join(' AND ');
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);
    const offset = (pageNum - 1) * limitNum;

    const countSql = `SELECT COUNT(*) AS total FROM events e WHERE ${where}`;
    const [countRows] = await pool.execute(countSql, params);
    const total = countRows[0].total;

    const dataSql = `
      SELECT e.*, u.name AS organizer_name,
             (SELECT MIN(price) FROM ticket_types WHERE event_id = e.id) AS min_price
      FROM events e
      LEFT JOIN users u ON u.id = e.organizer_id
      WHERE ${where}
      ORDER BY e.start_date ASC, e.start_time ASC
      LIMIT ${limitNum} OFFSET ${offset}`;

    const [rows] = await pool.execute(dataSql, params);

    res.json({
      events: rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    console.error('[eventController.getEvents]', err);
    res.status(500).json({ message: 'Server error fetching events' });
  }
};

/* ------------------------------------------------------------------ */
/* Get single event (public)                                           */
/* ------------------------------------------------------------------ */
export const getEvent = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute(
      `SELECT e.*, u.name AS organizer_name, u.avatar AS organizer_avatar
       FROM events e
       LEFT JOIN users u ON u.id = e.organizer_id
       WHERE e.id = ?`,
      [id],
    );
    const event = rows[0];
    if (!event) return res.status(404).json({ message: 'Event not found' });

    // Only published events are publicly visible. Drafts / pending / rejected
    // events are visible to their owner and to admins.
    const isOwner = event.organizer_id === req.user?.id;
    const isAdmin = req.user?.role === 'admin';
    if (event.status !== 'published' && !isOwner && !isAdmin) {
      return res.status(404).json({ message: 'Event not found' });
    }    const [tickets] = await pool.execute(
      `SELECT * FROM ticket_types WHERE event_id = ? ORDER BY price ASC`,
      [id],
    );
    const [reviews] = await pool.execute(
      `SELECT r.*, u.name AS user_name, u.avatar AS user_avatar
       FROM reviews r
       LEFT JOIN users u ON u.id = r.user_id
       WHERE r.event_id = ?
       ORDER BY r.created_at DESC`,
      [id],
    );

    // Organizer card + follow state (join state only when signed in).
    let followersCount = 0;
    let isFollowing = false;
    if (event.organizer_id) {
      const [[{ total }]] = await pool.execute(
        'SELECT COUNT(*) AS total FROM organizer_follows WHERE organizer_id = ?',
        [event.organizer_id],
      );
      followersCount = Number(total) || 0;
      if (req.user?.id && Number(req.user.id) !== Number(event.organizer_id)) {
        const [followRows] = await pool.execute(
          'SELECT id FROM organizer_follows WHERE follower_id = ? AND organizer_id = ?',
          [req.user.id, event.organizer_id],
        );
        isFollowing = followRows.length > 0;
      }
    }

    res.json({
      ...event,
      images: parseJsonArray(event.images),
      tags: parseJsonArray(event.tags),
      organizer: event.organizer_id
        ? {
          id: event.organizer_id,
          name: event.organizer_name,
          avatar: event.organizer_avatar,
          followersCount,
          isFollowing,
        }
        : null,
      ticket_types: tickets,
      reviews,
    });
  } catch (err) {
    console.error('[eventController.getEvent]', err);
    res.status(500).json({ message: 'Server error fetching event' });
  }
};

/* ------------------------------------------------------------------ */
/* Create event                                                        */
/* ------------------------------------------------------------------ */
export const createEvent = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const organizerId = req.user.id;
    const {
      title, description, category, venue, address, city, country,
      latitude, longitude, start_date, end_date, start_time, end_time,
      capacity, dress_code, contact_email, contact_phone,
      banner_image, images, tags, visibility,
    } = req.body;

    if (!title || !venue || !start_date || !end_date || !start_time || !end_time) {
      conn.release();
      return res.status(400).json({ message: 'Missing required event fields' });
    }

    // The server decides the status: organizers may save a draft, but any
    // "publish" request becomes 'pending' and needs admin approval. A client
    // can never set 'published' directly.
    const status = req.body.status === 'draft' ? 'draft' : 'pending';

    // The wizard submits the category name; resolve it to its id so both the
    // display column and the FK are populated.
    let categoryId = null;
    if (category) {
      try {
        const [catRows] = await conn.execute(
          'SELECT id FROM categories WHERE name = ? OR slug = ? LIMIT 1',
          [category, category],
        );
        categoryId = catRows?.[0]?.id ?? null;
      } catch {
        categoryId = null;
      }
    }

    const [result] = await conn.execute(
      `INSERT INTO events
        (organizer_id, title, description, category_id, category, venue, address,
         city, country, latitude, longitude, start_date, end_date, start_time,
         end_time, capacity, dress_code, contact_email, contact_phone,
         banner_image, images, tags, visibility, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        organizerId, title, description || null, categoryId, category || null, venue, address || null,
        city || null, country || null, latitude || null, longitude || null,
        start_date, end_date, start_time, end_time, capacity || 0,
        dress_code || null, contact_email || null, contact_phone || null,
        banner_image || null, images && Array.isArray(images) ? JSON.stringify(images) : null,
        tags ? JSON.stringify(Array.isArray(tags) ? tags : []) : null,
        visibility === 'private' ? 'private' : 'public',
        status,
      ],
    );

    const eventId = result.insertId;

    // Persist ticket types submitted by the event wizard (if any).
    const ticketTypes = Array.isArray(req.body.ticket_types) || Array.isArray(req.body.ticketTypes)
      ? (req.body.ticket_types || req.body.ticketTypes)
      : [];
    if (ticketTypes.length) {
      for (const tt of ticketTypes) {
        if (!tt.name || tt.price === undefined || tt.quantity === undefined) continue;
        await conn.execute(
          `INSERT INTO ticket_types (event_id, name, price, quantity, quantity_sold, sale_start, sale_end, description)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
          [
            eventId,
            tt.name,
            Number(tt.price) || 0,
            Math.max(Number(tt.quantity) || 0, 0),
            tt.saleStartDate || tt.sale_start || null,
            tt.saleEndDate || tt.sale_end || null,
            tt.description || null,
          ],
        );
      }
    }

    await logAudit({ userId: organizerId, action: 'create_event', entityType: 'event', entityId: Number(eventId) });

    conn.release();
    res.status(201).json({ message: 'Event created', eventId });
  } catch (err) {
    conn.release();
    console.error('[eventController.createEvent]', err);
    res.status(500).json({ message: 'Server error creating event' });
  }
};

/* ------------------------------------------------------------------ */
/* Update event                                                        */
/* ------------------------------------------------------------------ */
export const updateEvent = async (req, res) => {
  try {
    const { id } = req.params;
    const organizerId = req.user.id;

    const [rows] = await pool.execute('SELECT * FROM events WHERE id = ?', [id]);
    const event = rows[0];
    if (!event) return res.status(404).json({ message: 'Event not found' });

    if (event.organizer_id !== organizerId && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'You can only update your own events' });
    }

    // Organizers may edit content fields only. Status and featured flags are
    // server/admin-controlled — organizers can neither publish nor feature
    // their own events (they submit via PATCH /:id/publish for review).
    const allowed = [
      'title','description','category','venue','address','city','country',
      'latitude','longitude','start_date','end_date','start_time','end_time',
      'capacity','dress_code','contact_email','contact_phone','banner_image',
      'images','tags','visibility',
    ];
    if (req.user.role === 'admin') {
      allowed.push('status', 'is_featured');
    }

    const fields = [];
    const values = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = ?`);
        if ((key === 'images' || key === 'tags') && Array.isArray(req.body[key])) {
          values.push(JSON.stringify(req.body[key]));
        } else if (key === 'visibility') {
          values.push(req.body[key] === 'private' ? 'private' : 'public');
        } else {
          values.push(req.body[key]);
        }
      }
    }

    // Keep the category FK in sync when the category name changes.
    if (req.body.category !== undefined) {
      let categoryId = null;
      try {
        const [catRows] = await pool.execute(
          'SELECT id FROM categories WHERE name = ? OR slug = ? LIMIT 1',
          [req.body.category, req.body.category],
        );
        categoryId = catRows?.[0]?.id ?? null;
      } catch {
        categoryId = null;
      }
      fields.push('category_id = ?');
      values.push(categoryId);
    }

    if (fields.length === 0) {
      return res.status(400).json({ message: 'No fields to update' });
    }

    values.push(id);
    await pool.execute(`UPDATE events SET ${fields.join(', ')} WHERE id = ?`, values);

    await logAudit({ userId: organizerId, action: 'update_event', entityType: 'event', entityId: Number(id) });

    res.json({ message: 'Event updated' });
  } catch (err) {
    console.error('[eventController.updateEvent]', err);
    res.status(500).json({ message: 'Server error updating event' });
  }
};

/* ------------------------------------------------------------------ */
/* Delete event                                                        */
/* ------------------------------------------------------------------ */
export const deleteEvent = async (req, res) => {
  try {
    const { id } = req.params;
    const organizerId = req.user.id;

    const [rows] = await pool.execute('SELECT * FROM events WHERE id = ?', [id]);
    const event = rows[0];
    if (!event) return res.status(404).json({ message: 'Event not found' });

    if (event.organizer_id !== organizerId && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'You can only delete your own events' });
    }

    // Prevent deletion when tickets have been sold.
    const [soldRows] = await pool.execute(
      `SELECT COUNT(*) AS sold FROM tickets t
       JOIN ticket_types tt ON tt.id = t.ticket_type_id
       WHERE tt.event_id = ?`,
      [id],
    );
    if (soldRows[0].sold > 0 && req.user.role !== 'admin') {
      return res.status(400).json({ message: 'Cannot delete an event with sold tickets' });
    }

    await pool.execute('DELETE FROM events WHERE id = ?', [id]);
    await logAudit({ userId: organizerId, action: 'delete_event', entityType: 'event', entityId: Number(id) });

    res.json({ message: 'Event deleted' });
  } catch (err) {
    console.error('[eventController.deleteEvent]', err);
    res.status(500).json({ message: 'Server error deleting event' });
  }
};

/* ------------------------------------------------------------------ */
/* Submit for review / unpublish                                       */
/* ------------------------------------------------------------------ */
const setEventStatus = async (req, res, status) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute('SELECT * FROM events WHERE id = ?', [id]);
    const event = rows[0];
    if (!event) return res.status(404).json({ message: 'Event not found' });

    if (event.organizer_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'You can only manage your own events' });
    }

    await pool.execute(`UPDATE events SET status = ?, approval_status = 'pending' WHERE id = ?`, [status, id]);
    await logAudit({
      userId: req.user.id,
      action: status === 'pending' ? 'submit_event_for_review' : 'unpublish_event',
      entityType: 'event',
      entityId: Number(id),
    });

    res.json({ message: status === 'pending' ? 'Event submitted for review' : 'Event unpublished', status });
  } catch (err) {
    console.error('[eventController.setEventStatus]', err);
    res.status(500).json({ message: 'Server error updating event status' });
  }
};

// Organizers cannot publish directly — PATCH /:id/publish submits the event
// for admin review (status becomes 'pending'). Admins approve via the admin
// routes (approveEvent), which sets 'published'.
export const publishEvent = (req, res) => setEventStatus(req, res, 'pending');
export const unpublishEvent = (req, res) => setEventStatus(req, res, 'draft');

/* ------------------------------------------------------------------ */
/* Get organizer's own events                                          */
/* ------------------------------------------------------------------ */
export const getOrganizerEvents = async (req, res) => {
  try {
    const organizerId = req.user.id;
    const { status } = req.query;
    const conditions = ['e.organizer_id = ?'];
    const params = [organizerId];
    if (status && status !== 'all') {
      conditions.push('e.status = ?');
      params.push(status);
    }

    const [rows] = await pool.execute(
      `SELECT e.*,
              (SELECT MIN(price) FROM ticket_types WHERE event_id = e.id) AS min_price,
              (SELECT COUNT(*) FROM tickets t JOIN ticket_types tt ON tt.id = t.ticket_type_id WHERE tt.event_id = e.id) AS tickets_sold
       FROM events e
       WHERE ${conditions.join(' AND ')}
       ORDER BY e.created_at DESC`,
      params,
    );
    res.json({ events: rows });
  } catch (err) {
    console.error('[eventController.getOrganizerEvents]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Featured events                                                     */
/* ------------------------------------------------------------------ */
export const getFeaturedEvents = async (req, res) => {
  try {
    const { limit = 6 } = req.query;
    const [rows] = await pool.execute(
      `SELECT e.*, u.name AS organizer_name,
              (SELECT MIN(price) FROM ticket_types WHERE event_id = e.id) AS min_price
       FROM events e
       LEFT JOIN users u ON u.id = e.organizer_id
       WHERE e.status = 'published' AND e.is_featured = 1
         AND e.visibility = 'public' AND e.start_date >= CURDATE()
       ORDER BY e.start_date ASC
       LIMIT ${Math.min(parseInt(limit, 10) || 6, 20)}`,
    );
    res.json({ events: rows });
  } catch (err) {
    console.error('[eventController.getFeaturedEvents]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Trending events (most tickets sold)                                 */
/* ------------------------------------------------------------------ */
export const getTrendingEvents = async (req, res) => {
  try {
    const { limit = 8 } = req.query;
    const [rows] = await pool.execute(
      `SELECT e.*, u.name AS organizer_name,
              COUNT(t.id) AS tickets_sold,
              (SELECT MIN(price) FROM ticket_types WHERE event_id = e.id) AS min_price
       FROM events e
       LEFT JOIN users u ON u.id = e.organizer_id
       LEFT JOIN ticket_types tt ON tt.event_id = e.id
       LEFT JOIN tickets t ON t.ticket_type_id = tt.id AND t.status = 'active'
       WHERE e.status = 'published' AND e.start_date >= CURDATE()
         AND e.visibility = 'public'
       GROUP BY e.id
       ORDER BY tickets_sold DESC, e.created_at DESC
       LIMIT ${Math.min(parseInt(limit, 10) || 8, 20)}`,
    );
    res.json({ events: rows });
  } catch (err) {
    console.error('[eventController.getTrendingEvents]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Personalized recommendations                                         */
/* ------------------------------------------------------------------ */
// Builds a scored list of upcoming published events for a user based on
// their favorites (strongest signal), past ticket purchases, and location.
// Anonymous users (or users with no history) get the platform's popular
// picks instead, so the section is never empty.
export const getRecommendedEvents = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 8, 20);
    const userId = req.user?.id;

    const [candidates] = await pool.execute(
      `SELECT e.id, e.category, e.city, e.start_date, e.is_featured,
              u.name AS organizer_name,
              (SELECT MIN(price) FROM ticket_types WHERE event_id = e.id) AS min_price
       FROM events e
       LEFT JOIN users u ON u.id = e.organizer_id
       WHERE e.status = 'published' AND e.start_date >= CURDATE()
         AND e.visibility = 'public'
       ORDER BY e.start_date ASC`,
    );

    // Anonymous / no-history fallback: featured first, then soonest.
    if (!userId) {
      const popular = [...candidates]
        .sort((a, b) => (b.is_featured ? 1 : 0) - (a.is_featured ? 1 : 0) || new Date(a.start_date) - new Date(b.start_date))
        .slice(0, limit);
      return res.json({ events: popular });
    }

    // Favorite categories — the strongest preference signal.
    const [favRows] = await pool.execute(
      `SELECT event_id FROM favorites WHERE user_id = ?`,
      [userId],
    );
    const favEventIds = favRows.map((r) => r.event_id);
    const favCategories = new Set();
    for (const id of favEventIds) {
      const [rows] = await pool.execute('SELECT category FROM events WHERE id = ?', [id]);
      if (rows[0]?.category) favCategories.add(rows[0].category);
    }

    // Categories the user has actually attended/bought into.
    const [attRows] = await pool.execute(
      `SELECT DISTINCT event_id FROM tickets WHERE user_id = ? AND status = 'active'`,
      [userId],
    );
    const ownedEventIds = new Set(attRows.map((r) => r.event_id));
    const attendedCategories = new Set();
    for (const id of ownedEventIds) {
      const [rows] = await pool.execute('SELECT category FROM events WHERE id = ?', [id]);
      if (rows[0]?.category) attendedCategories.add(rows[0].category);
    }

    // The user's home city — derived from their profile location
    // (e.g. "Accra, Ghana" → "Accra").
    let userCity = null;
    try {
      const [userRows] = await pool.execute('SELECT location FROM users WHERE id = ?', [userId]);
      const loc = userRows[0]?.location;
      if (loc && typeof loc === 'string') userCity = loc.split(',')[0].trim();
    } catch {
      // location column may not exist on older installs — skip the signal.
    }

    const scored = candidates
      .filter((e) => !ownedEventIds.has(e.id))
      .map((e) => {
        let score = 0;
        if (favCategories.has(e.category)) score += 3;
        if (attendedCategories.has(e.category)) score += 2;
        if (userCity && e.city && e.city.toLowerCase() === userCity.toLowerCase()) score += 1;
        return { ...e, score };
      })
      .sort((a, b) => b.score - a.score || new Date(a.start_date) - new Date(b.start_date));

    // No personalised signals → platform picks.
    const top = scored.length && scored.some((e) => e.score > 0)
      ? scored
      : [...candidates].sort(
        (a, b) => (b.is_featured ? 1 : 0) - (a.is_featured ? 1 : 0) || new Date(a.start_date) - new Date(b.start_date),
      );

    res.json({ events: top.slice(0, limit) });
  } catch (err) {
    console.error('[eventController.getRecommendedEvents]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Get categories (public)                                              */
/* ------------------------------------------------------------------ */
export const getCategories = async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, name, slug, icon, description FROM categories ORDER BY name ASC`,
    );
    res.json(rows);
  } catch (err) {
    console.error('[eventController.getCategories]', err);
    res.status(500).json({ message: 'Server error fetching categories' });
  }
};

/* ------------------------------------------------------------------ */
/* Get featured organizers (public — homepage)                          */
/* ------------------------------------------------------------------ */
export const getFeaturedOrganizers = async (req, res) => {
  try {
    const { limit = 6 } = req.query;
    const [rows] = await pool.execute(
      `SELECT u.id, u.name, COALESCE(u.avatar_url, u.avatar) AS avatar,
              COUNT(e.id) AS events_count,
              op.organization_name,
              'Organizer' AS specialty
       FROM users u
       LEFT JOIN organizer_profiles op ON op.user_id = u.id
       LEFT JOIN events e ON e.organizer_id = u.id AND e.status = 'published'
       WHERE u.role = 'organizer' AND u.is_approved = 1 AND u.status = 'active'
       GROUP BY u.id
       ORDER BY events_count DESC, u.name ASC
       LIMIT ${Math.min(parseInt(limit, 10) || 6, 20)}`,
    );
    res.json(rows);
  } catch (err) {
    console.error('[eventController.getFeaturedOrganizers]', err);
    res.status(500).json({ message: 'Server error fetching organizers' });
  }
};

export default {
  getEvents, getEvent, createEvent, updateEvent, deleteEvent,
  publishEvent, unpublishEvent,
  getOrganizerEvents, getFeaturedEvents, getTrendingEvents,
  getCategories, getFeaturedOrganizers,
};
