import pool from '../config/db.js';
import { logAudit } from '../utils/audit.js';
import { notifyAdmins, sendNotification } from '../utils/notify.js';
import { notifyFollowersOfNewEvent, notifyReminderSubscribers, processEventReminders } from '../utils/eventReminders.js';
import cache from '../utils/cache.js';

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
      price,        // 'free' | 'paid' | '0-50' | '50-100' | '100-250' | '250+'
      minPrice,
      maxPrice,
      date,         // ISO date or 'today' | 'tomorrow' | 'weekend' | 'this_week' | 'this-week' | 'this-weekend' | 'this-month'
      dateFrom,
      dateTo,
      location,     // city
      city,
      search,
      q: searchQuery,
      sort = 'date-asc',
      page = 1,
      limit = 12,
    } = req.query;

    const searchTerm = (search || searchQuery || '').trim();
    const loc = (location || city || '').trim();

    const conditions = [`e.status = 'published'`, `e.visibility = 'public'`];
    const params = [];

    // Category filter (supports comma-separated list)
    if (category && category !== 'all') {
      const cats = category.split(',').map((c) => c.trim()).filter(Boolean);
      if (cats.length === 1) {
        conditions.push(`e.category = ?`);
        params.push(cats[0]);
      } else if (cats.length > 1) {
        conditions.push(`e.category IN (${cats.map(() => '?').join(', ')})`);
        params.push(...cats);
      }
    }

    // Price filters
    if (minPrice !== undefined && Number(minPrice) > 0) {
      conditions.push(`EXISTS (SELECT 1 FROM ticket_types tt WHERE tt.event_id = e.id AND tt.price >= ?)`);
      params.push(Number(minPrice));
    }
    if (maxPrice !== undefined && Number(maxPrice) > 0) {
      conditions.push(`EXISTS (SELECT 1 FROM ticket_types tt WHERE tt.event_id = e.id AND tt.price <= ?)`);
      params.push(Number(maxPrice));
    }

    if (price === 'free') {
      conditions.push(`EXISTS (SELECT 1 FROM ticket_types tt WHERE tt.event_id = e.id AND tt.price = 0)`);
    } else if (price === 'paid') {
      conditions.push(`EXISTS (SELECT 1 FROM ticket_types tt WHERE tt.event_id = e.id AND tt.price > 0)`);
    } else if (price === '0-50') {
      conditions.push(`EXISTS (SELECT 1 FROM ticket_types tt WHERE tt.event_id = e.id AND tt.price BETWEEN 0 AND 50)`);
    } else if (price === '50-100') {
      conditions.push(`EXISTS (SELECT 1 FROM ticket_types tt WHERE tt.event_id = e.id AND tt.price BETWEEN 50 AND 100)`);
    } else if (price === '100-250') {
      conditions.push(`EXISTS (SELECT 1 FROM ticket_types tt WHERE tt.event_id = e.id AND tt.price BETWEEN 100 AND 250)`);
    } else if (price === '250+') {
      conditions.push(`EXISTS (SELECT 1 FROM ticket_types tt WHERE tt.event_id = e.id AND tt.price >= 250)`);
    }

    // Date filters
    if (dateFrom) {
      conditions.push(`e.start_date >= ?`);
      params.push(dateFrom);
    }
    if (dateTo) {
      conditions.push(`e.start_date <= ?`);
      params.push(dateTo);
    }

    if (date) {
      if (date === 'today') {
        conditions.push(`e.start_date = CURRENT_DATE`);
      } else if (date === 'tomorrow') {
        conditions.push(`e.start_date = CURRENT_DATE + INTERVAL '1 day'`);
      } else if (date === 'this_week' || date === 'this-week') {
        conditions.push(`e.start_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'`);
      } else if (date === 'weekend' || date === 'this-weekend') {
        conditions.push(`EXTRACT(DOW FROM e.start_date) IN (5,6) AND e.start_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'`);
      } else if (date === 'this-month') {
        conditions.push(`e.start_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'`);
      } else if (!dateFrom && !dateTo) {
        conditions.push(`e.start_date >= ?`);
        params.push(date);
      }
    }

    if (loc && loc !== 'all') {
      conditions.push(`(e.city LIKE ? OR e.country LIKE ? OR e.venue LIKE ?)`);
      const locQ = `%${loc}%`;
      params.push(locQ, locQ, locQ);
    }

    // Search matches title, description, venue, city, category, AND organizer/artist name
    if (searchTerm) {
      conditions.push(`(e.title LIKE ? OR e.description LIKE ? OR e.venue LIKE ? OR e.category LIKE ? OR e.city LIKE ? OR u.name LIKE ?)`);
      const q = `%${searchTerm}%`;
      params.push(q, q, q, q, q, q);
    }

    const where = conditions.join(' AND ');
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 12, 1), 100);
    const offset = (pageNum - 1) * limitNum;

    const countSql = `
      SELECT COUNT(*) AS total
      FROM events e
      LEFT JOIN users u ON u.id = e.organizer_id
      WHERE ${where}`;
    const [countRows] = await pool.execute(countSql, params);
    const total = countRows[0].total;

    // Determine sort ordering
    let orderClause = 'e.start_date ASC, e.start_time ASC';
    if (sort === 'latest') {
      orderClause = 'e.created_at DESC';
    } else if (sort === 'price_low' || sort === 'price-asc') {
      orderClause = 'min_price ASC NULLS LAST, e.start_date ASC';
    } else if (sort === 'price_high' || sort === 'price-desc') {
      orderClause = 'min_price DESC NULLS LAST, e.start_date ASC';
    } else if (sort === 'popularity' || sort === 'popular') {
      orderClause = 'e.is_featured DESC, (SELECT COUNT(*) FROM tickets t WHERE t.event_id = e.id) DESC';
    } else if (sort === 'date-desc' || sort === 'date_desc') {
      orderClause = 'e.start_date DESC';
    }

    const dataSql = `
      SELECT e.*, u.name AS organizer_name,
             (SELECT MIN(price) FROM ticket_types WHERE event_id = e.id) AS min_price
      FROM events e
      LEFT JOIN users u ON u.id = e.organizer_id
      WHERE ${where}
      ORDER BY ${orderClause}
      LIMIT ${limitNum} OFFSET ${offset}`;

    const [rows] = await pool.execute(dataSql, params);

    res.json({
      events: rows,
      data: rows,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum) || 1,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum) || 1,
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
      `SELECT e.*, u.name AS organizer_name, u.avatar AS organizer_avatar,
              op.organization_name, op.is_verified AS organizer_is_verified
       FROM events e
       LEFT JOIN users u ON u.id = e.organizer_id
       LEFT JOIN organizer_profiles op ON op.user_id = e.organizer_id
       WHERE e.id = ?`,
      [id],
    );
    const event = rows[0];
    if (!event) return res.status(404).json({ message: 'Event not found' });

    // Only published events are publicly visible. Drafts / pending / rejected
    // events are visible to their owner and to admins.
    const isOwner = Boolean(req.user?.id && Number(event.organizer_id) === Number(req.user.id));
    const isAdmin = req.user?.role === 'admin';
    if (event.status !== 'published' && !isOwner && !isAdmin) {
      return res.status(404).json({ message: 'Event not found' });
    }

    // Asynchronously record event view for personalized recommendations & analytics
    try {
      pool.execute(
        `INSERT INTO event_views (user_id, event_id, ip_address, viewed_at)
         VALUES (?, ?, ?, NOW())`,
        [req.user?.id || null, event.id, req.ip || null],
      ).catch(() => {});
    } catch {
      // non-fatal
    }

    const [tickets] = await pool.execute(
      `SELECT * FROM ticket_types WHERE event_id = ? ORDER BY price ASC`,
      [id],
    );

    // Attach uploaded pre-generated ticket files to each ticket type
    for (const tt of tickets) {
      try {
        const [utRows] = await pool.execute(
          `SELECT id, file_url, file_name, barcode, seat_number, is_assigned
           FROM uploaded_tickets WHERE ticket_type_id = ? ORDER BY id ASC`,
          [tt.id],
        );
        tt.uploaded_tickets = utRows || [];
        tt.uploadedTickets = utRows || [];
      } catch {
        tt.uploaded_tickets = [];
        tt.uploadedTickets = [];
      }
    }
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
          name: event.organization_name || event.organizer_name,
          organization_name: event.organization_name || event.organizer_name,
          avatar: event.organizer_avatar,
          is_verified: Boolean(event.organizer_is_verified),
          isVerified: Boolean(event.organizer_is_verified),
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
      start_date, end_date, start_time, end_time,
      capacity, dress_code, contact_email, contact_phone,
      banner_image, ticket_template, ticketTemplate, images, tags, visibility,
    } = req.body;

    const location_type = req.body.location_type || req.body.locationType || (venue?.toLowerCase().includes('online') ? 'online' : 'physical');
    const gps_location = req.body.gps_location || req.body.gpsLocation || null;

    let latitude = req.body.latitude || null;
    let longitude = req.body.longitude || null;
    if (gps_location && (!latitude || !longitude)) {
      const parts = String(gps_location).split(',').map((p) => parseFloat(p.trim()));
      if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        latitude = parts[0];
        longitude = parts[1];
      }
    }

    if (!title || !venue || !start_date || !end_date || !start_time || !end_time) {
      conn.release();
      return res.status(400).json({ message: 'Missing required event fields' });
    }

    // Organizers can save a draft, submit for admin approval, or publish directly
    let status = 'draft';
    let approval_status = 'pending';
    if (req.body.status === 'published') {
      status = 'published';
      approval_status = 'approved';
    } else if (req.body.status === 'pending' || req.body.status === 'submitted' || req.body.status === 'submit_for_approval') {
      status = 'pending';
      approval_status = 'pending';
    } else {
      status = 'draft';
      approval_status = 'pending';
    }

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

    const templateImg = ticket_template || ticketTemplate || null;

    let result;
    try {
      [result] = await conn.execute(
        `INSERT INTO events
          (organizer_id, title, description, category_id, category, venue, address,
           city, country, location_type, gps_location, latitude, longitude, start_date, end_date, start_time,
           end_time, capacity, dress_code, contact_email, contact_phone,
           banner_image, ticket_template, images, tags, visibility, status, approval_status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          organizerId, title, description || null, categoryId, category || null, venue, address || null,
          city || null, country || null, location_type, gps_location, latitude || null, longitude || null,
          start_date, end_date, start_time, end_time, capacity || 0,
          dress_code || null, contact_email || null, contact_phone || null,
          banner_image || null, templateImg, images && Array.isArray(images) ? JSON.stringify(images) : null,
          tags ? JSON.stringify(Array.isArray(tags) ? tags : []) : null,
          visibility === 'private' ? 'private' : 'public',
          status,
          approval_status,
        ],
      );
    } catch (insertErr) {
      // Graceful fallback if location_type or gps_location column does not exist on legacy DB
      if (insertErr.message && (insertErr.message.includes('location_type') || insertErr.message.includes('gps_location'))) {
        [result] = await conn.execute(
          `INSERT INTO events
            (organizer_id, title, description, category_id, category, venue, address,
             city, country, latitude, longitude, start_date, end_date, start_time,
             end_time, capacity, dress_code, contact_email, contact_phone,
             banner_image, ticket_template, images, tags, visibility, status, approval_status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            organizerId, title, description || null, categoryId, category || null, venue, address || null,
            city || null, country || null, latitude || null, longitude || null,
            start_date, end_date, start_time, end_time, capacity || 0,
            dress_code || null, contact_email || null, contact_phone || null,
            banner_image || null, templateImg, images && Array.isArray(images) ? JSON.stringify(images) : null,
            tags ? JSON.stringify(Array.isArray(tags) ? tags : []) : null,
            visibility === 'private' ? 'private' : 'public',
            status,
            approval_status,
          ],
        );
      } else {
        throw insertErr;
      }
    }

    const eventId = result.insertId;

    // Persist ticket types submitted by the event wizard (if any).
    const ticketTypes = Array.isArray(req.body.ticket_types) || Array.isArray(req.body.ticketTypes)
      ? (req.body.ticket_types || req.body.ticketTypes)
      : [];
    if (ticketTypes.length) {
      for (const tt of ticketTypes) {
        const utList = Array.isArray(tt.uploadedTickets) || Array.isArray(tt.uploaded_tickets)
          ? (tt.uploadedTickets || tt.uploaded_tickets)
          : [];
        const finalQuantity = utList.length > 0 ? utList.length : Math.max(Number(tt.quantity) || 0, 0);
        const finalPrice = (tt.price === '' || tt.price === null || tt.price === undefined) ? 0 : Number(tt.price) || 0;
        if (!tt.name || (finalQuantity === 0 && utList.length === 0 && tt.quantity === undefined)) continue;

        const [ttRes] = await conn.execute(
          `INSERT INTO ticket_types (
             event_id, name, price, quantity, quantity_sold, sale_start, sale_end, description,
             early_bird_price, early_bird_deadline, early_bird_max_qty, section_type, perks
           )
           VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            eventId,
            tt.name,
            finalPrice,
            finalQuantity,
            tt.saleStartDate || tt.sale_start || null,
            tt.saleEndDate || tt.sale_end || null,
            tt.description || null,
            tt.earlyBirdPrice || tt.early_bird_price ? Number(tt.earlyBirdPrice || tt.early_bird_price) : null,
            tt.earlyBirdDeadline || tt.early_bird_deadline || null,
            tt.earlyBirdMaxQty || tt.early_bird_max_qty ? Number(tt.earlyBirdMaxQty || tt.early_bird_max_qty) : null,
            tt.sectionType || tt.section_type || 'general',
            tt.perks ? JSON.stringify(Array.isArray(tt.perks) ? tt.perks : [tt.perks]) : null,
          ],
        );

        if (utList.length > 0) {
          const ttId = ttRes.insertId;
          for (const ut of utList) {
            if (!ut.file_url && !ut.url) continue;
            await conn.execute(
              `INSERT INTO uploaded_tickets (event_id, ticket_type_id, file_url, file_name, barcode, seat_number)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [
                eventId,
                ttId,
                ut.file_url || ut.url,
                ut.file_name || ut.fileName || ut.originalName || null,
                ut.barcode || null,
                ut.seat_number || ut.seatNumber || null,
              ],
            );
          }
        }
      }
    }

    await logAudit({ userId: organizerId, action: 'create_event', entityType: 'event', entityId: Number(eventId) });
    cache.clearPrefix('events');

    notifyAdmins({
      title: 'New Event Created',
      message: `Organizer "${req.user.name || 'Organizer'}" created "${title}" (${category || 'General'}) in ${city || 'Accra'}.`,
      type: 'system',
      link: '/admin/events',
    }).catch(() => {});

    if (req.body.status === 'published') {
      notifyFollowersOfNewEvent(
        { id: eventId, title, city, category, tags: req.body.tags, organizer_id: organizerId },
        req.user.name,
      ).catch(() => {});
    }

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

    if (Number(event.organizer_id) !== Number(organizerId) && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'You can only update your own events' });
    }

    // Organizers may edit content fields only. Status and featured flags are
    // server/admin-controlled — organizers can neither publish nor feature
    // their own events (they submit via PATCH /:id/publish for review).
    const allowed = [
      'title','description','category','venue','address','city','country',
      'location_type','gps_location','latitude','longitude','start_date','end_date','start_time','end_time',
      'capacity','dress_code','contact_email','contact_phone','banner_image',
      'ticket_template','images','tags','visibility',
    ];
    if (req.user.role === 'admin') {
      allowed.push('status', 'is_featured');
    }

    if (req.body.locationType !== undefined && req.body.location_type === undefined) {
      req.body.location_type = req.body.locationType;
    }
    if (req.body.gpsLocation !== undefined && req.body.gps_location === undefined) {
      req.body.gps_location = req.body.gpsLocation;
    }
    if (req.body.gps_location && (!req.body.latitude || !req.body.longitude)) {
      const parts = String(req.body.gps_location).split(',').map((p) => parseFloat(p.trim()));
      if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        req.body.latitude = parts[0];
        req.body.longitude = parts[1];
      }
    }

    if (req.body.ticketTemplate !== undefined && req.body.ticket_template === undefined) {
      req.body.ticket_template = req.body.ticketTemplate;
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

    // Persist ticket types update if supplied
    const ticketTypes = Array.isArray(req.body.ticket_types) || Array.isArray(req.body.ticketTypes)
      ? (req.body.ticket_types || req.body.ticketTypes)
      : null;

    if (ticketTypes) {
      for (const tt of ticketTypes) {
        const hasUtList = Array.isArray(tt.uploadedTickets) || Array.isArray(tt.uploaded_tickets);
        const utList = hasUtList
          ? (tt.uploadedTickets || tt.uploaded_tickets)
          : [];
        const finalQuantity = utList.length > 0 ? utList.length : Math.max(Number(tt.quantity) || 0, 0);
        const finalPrice = (tt.price === '' || tt.price === null || tt.price === undefined) ? 0 : Number(tt.price) || 0;
        if (!tt.name || (finalQuantity === 0 && utList.length === 0 && tt.quantity === undefined)) continue;

        if (tt.id) {
          // Synchronize uploaded_tickets if provided
          if (hasUtList) {
            const [existingUploaded] = await pool.execute(
              'SELECT id, file_url, is_assigned FROM uploaded_tickets WHERE ticket_type_id = ?',
              [tt.id]
            );

            // Remove unassigned tickets that are no longer in utList
            for (const ex of existingUploaded) {
              const stillExists = utList.some(
                (u) => (u.id && Number(u.id) === Number(ex.id)) || (u.file_url === ex.file_url || u.url === ex.file_url)
              );
              if (!stillExists && !ex.is_assigned) {
                await pool.execute('DELETE FROM uploaded_tickets WHERE id = ?', [ex.id]);
              }
            }

            // Insert newly added tickets
            for (const ut of utList) {
              const url = ut.file_url || ut.url;
              if (!url) continue;
              const exists = existingUploaded.some(
                (ex) => (ut.id && Number(ut.id) === Number(ex.id)) || ex.file_url === url
              );
              if (!exists) {
                await pool.execute(
                  `INSERT INTO uploaded_tickets (event_id, ticket_type_id, file_url, file_name, barcode, seat_number)
                   VALUES (?, ?, ?, ?, ?, ?)`,
                  [
                    id,
                    tt.id,
                    url,
                    ut.file_name || ut.fileName || ut.originalName || null,
                    ut.barcode || null,
                    ut.seat_number || ut.seatNumber || null,
                  ],
                );
              }
            }
          }

          // Count remaining uploaded tickets to ensure accurate quantity
          let updateQty = Math.max(Number(tt.quantity) || 0, 0);
          if (hasUtList) {
            const [[{ countUploaded }]] = await pool.execute(
              'SELECT COUNT(*) AS countUploaded FROM uploaded_tickets WHERE ticket_type_id = ?',
              [tt.id]
            );
            if (countUploaded > 0 || utList.length > 0) {
              updateQty = countUploaded;
            }
          }

          await pool.execute(
            `UPDATE ticket_types SET
               name = ?, price = ?, quantity = ?, description = ?,
               sale_start = ?, sale_end = ?,
               early_bird_price = ?, early_bird_deadline = ?, early_bird_max_qty = ?,
               section_type = ?, perks = ?
             WHERE id = ? AND event_id = ?`,
            [
              tt.name,
              finalPrice,
              updateQty,
              tt.description || null,
              tt.saleStartDate || tt.sale_start || null,
              tt.saleEndDate || tt.sale_end || null,
              tt.earlyBirdPrice || tt.early_bird_price ? Number(tt.earlyBirdPrice || tt.early_bird_price) : null,
              tt.earlyBirdDeadline || tt.early_bird_deadline || null,
              tt.earlyBirdMaxQty || tt.early_bird_max_qty ? Number(tt.earlyBirdMaxQty || tt.early_bird_max_qty) : null,
              tt.sectionType || tt.section_type || 'general',
              tt.perks ? JSON.stringify(Array.isArray(tt.perks) ? tt.perks : [tt.perks]) : null,
              tt.id,
              id,
            ],
          );
        } else {
          // Insert new ticket type for this event
          const [insRes] = await pool.execute(
            `INSERT INTO ticket_types (
               event_id, name, price, quantity, quantity_sold, sale_start, sale_end, description,
               early_bird_price, early_bird_deadline, early_bird_max_qty, section_type, perks
             )
             VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              tt.name,
              finalPrice,
              finalQuantity,
              tt.saleStartDate || tt.sale_start || null,
              tt.saleEndDate || tt.sale_end || null,
              tt.description || null,
              tt.earlyBirdPrice || tt.early_bird_price ? Number(tt.earlyBirdPrice || tt.early_bird_price) : null,
              tt.earlyBirdDeadline || tt.early_bird_deadline || null,
              tt.earlyBirdMaxQty || tt.early_bird_max_qty ? Number(tt.earlyBirdMaxQty || tt.early_bird_max_qty) : null,
              tt.sectionType || tt.section_type || 'general',
              tt.perks ? JSON.stringify(Array.isArray(tt.perks) ? tt.perks : [tt.perks]) : null,
            ],
          );

          if (utList.length > 0) {
            const newTtId = insRes.insertId;
            for (const ut of utList) {
              const url = ut.file_url || ut.url;
              if (!url) continue;
              await pool.execute(
                `INSERT INTO uploaded_tickets (event_id, ticket_type_id, file_url, file_name, barcode, seat_number)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                  id,
                  newTtId,
                  url,
                  ut.file_name || ut.fileName || ut.originalName || null,
                  ut.barcode || null,
                  ut.seat_number || ut.seatNumber || null,
                ],
              );
            }
          }
        }
      }
    }

    await logAudit({ userId: organizerId, action: 'update_event', entityType: 'event', entityId: Number(id) });
    cache.clearPrefix('events');

    // Lifecycle notifications for event reminder subscribers:
    const newStartDate = req.body.start_date || req.body.startDate;
    const newStartTime = req.body.start_time || req.body.startTime;
    const oldStartDate = event.start_date ? new Date(event.start_date).toISOString().split('T')[0] : null;
    const oldStartTime = event.start_time ? String(event.start_time).slice(0, 5) : null;

    if ((newStartDate && newStartDate !== oldStartDate) || (newStartTime && newStartTime !== oldStartTime)) {
      notifyReminderSubscribers(id, 'time_changed', {
        title: `Event Schedule Changed: ${event.title}`,
        message: `The schedule for "${event.title}" has been updated to ${newStartDate || oldStartDate} at ${newStartTime || oldStartTime || 'TBA'}.`,
      }).catch(() => {});
    }

    const newVenue = req.body.venue;
    const newCity = req.body.city;
    if ((newVenue && newVenue !== event.venue) || (newCity && newCity !== event.city)) {
      notifyReminderSubscribers(id, 'venue_changed', {
        title: `Venue Changed: ${event.title}`,
        message: `The venue for "${event.title}" has been moved to ${newVenue || event.venue}${newCity ? `, ${newCity}` : ''}.`,
      }).catch(() => {});
    }

    if (req.body.status === 'cancelled' && event.status !== 'cancelled') {
      notifyReminderSubscribers(id, 'event_cancelled', {
        title: `Event Cancelled: ${event.title}`,
        message: `We regret to inform you that "${event.title}" has been cancelled.`,
      }).catch(() => {});
    }

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
    cache.clearPrefix('events');

    res.json({ message: 'Event deleted' });
  } catch (err) {
    console.error('[eventController.deleteEvent]', err);
    res.status(500).json({ message: 'Server error deleting event' });
  }
};

/* ------------------------------------------------------------------ */
/* Publish / unpublish event                                          */
/* ------------------------------------------------------------------ */
const setEventStatus = async (req, res, status) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute('SELECT * FROM events WHERE id = ?', [id]);
    const event = rows[0];
    if (!event) return res.status(404).json({ message: 'Event not found' });

    if (Number(event.organizer_id) !== Number(req.user.id) && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'You can only manage your own events' });
    }

    const approval_status = status === 'published' ? 'approved' : 'pending';
    await pool.execute(`UPDATE events SET status = ?, approval_status = ? WHERE id = ?`, [status, approval_status, id]);
    await logAudit({
      userId: req.user.id,
      action: status === 'published' ? 'publish_event' : (status === 'draft' ? 'unpublish_event' : 'submit_event_for_review'),
      entityType: 'event',
      entityId: Number(id),
    });
    cache.clearPrefix('events');

    if (status === 'published' && event.status !== 'published') {
      notifyFollowersOfNewEvent({ ...event, status: 'published' }, req.user.name).catch(() => {});
      notifyReminderSubscribers(id, 'sales_opening', {
        title: `Ticket Sales Live: ${event.title}`,
        message: `Tickets are now live for "${event.title}"! Grab your tickets before they sell out.`,
      }).catch(() => {});
    }

    res.json({
      message: status === 'published' ? 'Event published and live for ticket sales' : (status === 'draft' ? 'Event unpublished' : 'Event submitted for review'),
      status,
    });
  } catch (err) {
    console.error('[eventController.setEventStatus]', err);
    res.status(500).json({ message: 'Server error updating event status' });
  }
};

// Organizers can directly publish their event for instant ticket sales, or save as draft
export const publishEvent = (req, res) => setEventStatus(req, res, 'published');
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
    const limitNum = Math.min(parseInt(limit, 10) || 6, 20);
    const cacheKey = `events_featured_${limitNum}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const [rows] = await pool.execute(
      `SELECT e.*, u.name AS organizer_name,
              (SELECT MIN(price) FROM ticket_types WHERE event_id = e.id) AS min_price
       FROM events e
       LEFT JOIN users u ON u.id = e.organizer_id
       WHERE e.status = 'published' AND e.is_featured = TRUE
         AND e.visibility = 'public' AND e.start_date >= CURRENT_DATE
       ORDER BY e.start_date ASC
       LIMIT ${limitNum}`,
    );
    const result = { events: rows };
    cache.set(cacheKey, result, 120_000); // 2 minutes
    res.json(result);
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
    const limitNum = Math.min(parseInt(limit, 10) || 8, 20);
    const cacheKey = `events_trending_${limitNum}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const [rows] = await pool.execute(
      `SELECT e.id, e.organizer_id, e.category_id, e.title, e.slug, e.description,
              e.category, e.venue, e.address, e.city, e.country, e.start_date, e.end_date,
              e.start_time, e.end_time, e.capacity, e.banner_image, e.status, e.is_featured,
              e.visibility, e.created_at, e.updated_at,
              u.name AS organizer_name,
              COUNT(t.id) AS tickets_sold,
              (SELECT MIN(price) FROM ticket_types WHERE event_id = e.id) AS min_price
       FROM events e
       LEFT JOIN users u ON u.id = e.organizer_id
       LEFT JOIN ticket_types tt ON tt.event_id = e.id
       LEFT JOIN tickets t ON t.ticket_type_id = tt.id AND t.status = 'active'
       WHERE e.status = 'published' AND e.start_date >= CURRENT_DATE
         AND e.visibility = 'public'
       GROUP BY e.id, e.organizer_id, e.category_id, e.title, e.slug, e.description,
                e.category, e.venue, e.address, e.city, e.country, e.start_date, e.end_date,
                e.start_time, e.end_time, e.capacity, e.banner_image, e.status, e.is_featured,
                e.visibility, e.created_at, e.updated_at, u.name
       ORDER BY tickets_sold DESC, e.created_at DESC
       LIMIT ${limitNum}`,
    );
    const result = { events: rows };
    cache.set(cacheKey, result, 120_000); // 2 minutes
    res.json(result);
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
/* ------------------------------------------------------------------ */
/* Track event view (Personalized Recommendations signal)             */
/* ------------------------------------------------------------------ */
export const trackEventView = async (req, res) => {
  try {
    const eventId = Number(req.params.id);
    if (!eventId) return res.status(400).json({ message: 'Event ID required' });
    const userId = req.user?.id || null;
    const ip = req.ip || null;

    await pool.execute(
      `INSERT INTO event_views (user_id, event_id, ip_address, viewed_at)
       VALUES (?, ?, ?, NOW())`,
      [userId, eventId, ip],
    );
    res.status(204).end();
  } catch (err) {
    res.status(200).json({ ok: true });
  }
};

/* ------------------------------------------------------------------ */
/* Search query logging (Personalized Recommendations)                 */
/* ------------------------------------------------------------------ */
export const trackSearchQuery = async (req, res) => {
  try {
    const { query, category, city } = req.body;
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.json({ tracked: false });
    }
    const userId = req.user?.id || null;
    const cleanQuery = query.trim().slice(0, 255);
    const cleanCategory = category ? String(category).slice(0, 100) : null;
    const cleanCity = city ? String(city).slice(0, 100) : null;

    await pool.execute(
      `INSERT INTO search_history (user_id, query, category, city, searched_at)
       VALUES (?, ?, ?, ?, NOW())`,
      [userId, cleanQuery, cleanCategory, cleanCity],
    );
    res.json({ tracked: true });
  } catch (err) {
    // Non-fatal logging failure
    res.json({ tracked: false });
  }
};

/* ------------------------------------------------------------------ */
/* Personalized recommendations                                         */
/* ------------------------------------------------------------------ */
// Scored recommendations and contextual grouped rails based on:
// 1. Previous purchases / attendance ("Because you attended: [Event]")
// 2. Favorite categories
// 3. Location / city
// 4. Organizers & artists followed
// 5. Search history
// 6. Events viewed
export const getRecommendedEvents = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 12, 30);
    const userId = req.user?.id;
    const clientCity = req.query.city ? String(req.query.city).trim().toLowerCase() : null;

    const [candidates] = await pool.execute(
      `SELECT e.id, e.title, e.slug, e.description, e.banner_image, e.venue, e.category, e.city,
              e.start_date, e.end_date, e.start_time, e.is_featured, e.organizer_id, e.tags,
              u.name AS organizer_name,
              (SELECT MIN(price) FROM ticket_types WHERE event_id = e.id) AS min_price
       FROM events e
       LEFT JOIN users u ON u.id = e.organizer_id
       WHERE e.status = 'published' AND e.start_date >= CURRENT_DATE
         AND e.visibility = 'public'
       ORDER BY e.start_date ASC`,
    );

    // Anonymous fallback: featured first, then soonest
    if (!userId) {
      const cityFilter = clientCity || 'Accra';
      const cityEvents = candidates.filter((e) => e.city && e.city.toLowerCase().includes(cityFilter.toLowerCase())).slice(0, 6);
      const featuredEvents = candidates.filter((e) => e.is_featured).slice(0, 6);

      const popular = [...candidates]
        .sort((a, b) => (b.is_featured ? 1 : 0) - (a.is_featured ? 1 : 0) || new Date(a.start_date) - new Date(b.start_date))
        .slice(0, limit)
        .map((e) => ({
          ...e,
          recommendationReason: e.is_featured ? 'Featured on Tribes & Cliqs' : `Popular upcoming in ${e.city || 'Ghana'}`,
          recommendationBadge: e.is_featured ? 'Featured Pick' : 'Trending',
        }));

      const defaultSections = [];
      if (cityEvents.length > 0) {
        defaultSections.push({
          id: 'popular_city',
          type: 'location',
          title: `Trending Near You in ${clientCity ? clientCity.charAt(0).toUpperCase() + clientCity.slice(1) : 'Accra'}`,
          subtitle: 'Exciting live experiences in your area',
          events: cityEvents,
        });
      }
      if (featuredEvents.length > 0) {
        defaultSections.push({
          id: 'featured_picks',
          type: 'featured',
          title: 'Handpicked For You',
          subtitle: 'Curated experiences hand-selected by Tribes & Cliqs',
          events: featuredEvents,
        });
      }

      return res.json({ events: popular, sections: defaultSections });
    }

    // ──────────────── 1. SIGNAL: PREVIOUS PURCHASES & ATTENDANCE ────────────────
    const [purchaseRows] = await pool.execute(
      `SELECT DISTINCT e.id AS event_id, e.title, e.category, e.organizer_id, e.city, t.created_at AS attended_at
       FROM tickets t
       JOIN events e ON e.id = t.event_id
       WHERE t.user_id = ?
       ORDER BY t.created_at DESC`,
      [userId],
    );
    const ownedEventIds = new Set(purchaseRows.map((r) => r.event_id));
    const pastAttendedEvents = [];
    const purchasedCategories = new Map();
    const purchasedOrganizers = new Map();

    for (const r of purchaseRows) {
      if (!pastAttendedEvents.some((p) => p.id === r.event_id || p.event_id === r.event_id)) {
        pastAttendedEvents.push({
          id: r.event_id,
          event_id: r.event_id,
          title: r.title,
          category: r.category,
        });
      }
      if (r.category) {
        purchasedCategories.set(r.category, { title: r.title, count: (purchasedCategories.get(r.category)?.count || 0) + 1 });
      }
      if (r.organizer_id) {
        purchasedOrganizers.set(r.organizer_id, (purchasedOrganizers.get(r.organizer_id) || 0) + 1);
      }
    }

    // ──────────────── 2. SIGNAL: FAVORITE CATEGORIES & USER LOCATION ────────────────
    let favoriteCategories = [];
    let userCity = clientCity;
    try {
      const [userRows] = await pool.execute(
        'SELECT location, favorite_categories FROM users WHERE id = ?',
        [userId],
      );
      if (userRows[0]) {
        const u = userRows[0];
        if (u.location && !userCity) {
          userCity = String(u.location).split(',')[0].trim().toLowerCase();
        }
        if (u.favorite_categories) {
          favoriteCategories = typeof u.favorite_categories === 'string'
            ? JSON.parse(u.favorite_categories || '[]')
            : (Array.isArray(u.favorite_categories) ? u.favorite_categories : []);
        }
      }
    } catch {
      // ignore
    }
    const favCatSet = new Set(favoriteCategories.map((c) => String(c).toLowerCase()));

    // ──────────────── 3. SIGNAL: ORGANIZERS & ARTISTS FOLLOWED ────────────────
    let followedOrganizerIds = new Set();
    try {
      const [followRows] = await pool.execute(
        'SELECT organizer_id FROM organizer_follows WHERE follower_id = ?',
        [userId],
      );
      followedOrganizerIds = new Set(followRows.map((r) => Number(r.organizer_id)));
    } catch {
      followedOrganizerIds = new Set();
    }

    // ──────────────── 4. SIGNAL: SEARCH HISTORY ────────────────
    let recentSearches = [];
    try {
      const [shRows] = await pool.execute(
        `SELECT DISTINCT query, category, city, searched_at
         FROM search_history
         WHERE user_id = ?
         ORDER BY searched_at DESC
         LIMIT 5`,
        [userId],
      );
      recentSearches = shRows || [];
    } catch {
      recentSearches = [];
    }

    // ──────────────── 5. SIGNAL: EVENTS VIEWED ────────────────
    let viewedRows = [];
    try {
      const [vRows] = await pool.execute(
        `SELECT DISTINCT e.id AS event_id, e.title, e.category, e.organizer_id, e.city, ev.viewed_at
         FROM event_views ev
         JOIN events e ON e.id = ev.event_id
         WHERE ev.user_id = ?
         ORDER BY ev.viewed_at DESC
         LIMIT 30`,
        [userId],
      );
      viewedRows = vRows || [];
    } catch {
      viewedRows = [];
    }
    const viewedCategories = new Map();
    for (const r of viewedRows) {
      if (r.category && !viewedCategories.has(r.category)) {
        viewedCategories.set(r.category, { title: r.title });
      }
    }

    // ──────────────── 6. SIGNAL: BOOKMARKED FAVORITES ────────────────
    const favCategories = new Set();
    try {
      const [favRows] = await pool.execute(
        'SELECT event_id FROM favorites WHERE user_id = ?',
        [userId],
      );
      for (const f of favRows) {
        const [rows] = await pool.execute('SELECT category FROM events WHERE id = ?', [f.event_id]);
        if (rows[0]?.category) favCategories.add(rows[0].category.toLowerCase());
      }
    } catch {
      // ignore
    }

    // ──────────────── COMPOSITE SCORING ────────────────
    const scored = candidates
      .filter((e) => !ownedEventIds.has(e.id))
      .map((e) => {
        let score = 0;
        let recommendationReason = 'Recommended for you';
        let recommendationBadge = 'For You';
        const eCatLower = (e.category || '').toLowerCase();

        // 1. Previous Purchases / Attendance Match (Highest Weight: +18)
        if (purchasedCategories.has(e.category)) {
          const match = purchasedCategories.get(e.category);
          score += 18;
          recommendationReason = `Because you attended ${match.title || e.category}`;
          recommendationBadge = 'Past Attendance';
        } else if (purchasedOrganizers.has(e.organizer_id)) {
          score += 15;
          recommendationReason = `From an organizer you previously booked with (${e.organizer_name || 'Organizer'})`;
          recommendationBadge = 'Favorite Organizer';
        }

        // 2. Organizers / Artists Followed Match (+14)
        if (followedOrganizerIds.has(Number(e.organizer_id))) {
          score += 14;
          if (score <= 14) {
            recommendationReason = `From ${e.organizer_name || 'an organizer'} you follow`;
            recommendationBadge = 'Following';
          }
        }

        // 3. Favorite Categories Match (+12)
        if (favCatSet.has(eCatLower)) {
          score += 12;
          if (score <= 12) {
            recommendationReason = `Matches your favorite category: ${e.category}`;
            recommendationBadge = 'Favorite Category';
          }
        }

        // 4. Search History Match (+10)
        if (recentSearches.length > 0) {
          for (const s of recentSearches) {
            const q = (s.query || '').toLowerCase();
            const inTitle = (e.title || '').toLowerCase().includes(q);
            const inDesc = (e.description || '').toLowerCase().includes(q);
            const inCat = eCatLower.includes(q);
            if (q.length >= 3 && (inTitle || inDesc || inCat)) {
              score += 10;
              if (score <= 10) {
                recommendationReason = `Based on your search for "${s.query}"`;
                recommendationBadge = 'Search Match';
              }
              break;
            }
          }
        }

        // 5. Events Viewed Match (+8)
        if (viewedCategories.has(e.category)) {
          score += 8;
          if (score <= 8) {
            recommendationReason = `Based on your recent interest in ${e.category}`;
            recommendationBadge = 'Recently Viewed';
          }
        }

        // 6. Bookmarked Favorites Match (+6)
        if (favCategories.has(eCatLower)) {
          score += 6;
          if (score <= 6) {
            recommendationReason = `Matches your saved ${e.category} interests`;
            recommendationBadge = 'Saved Interest';
          }
        }

        // 7. City / Location Match (+5)
        if (userCity && e.city && e.city.toLowerCase().includes(userCity)) {
          score += 5;
          if (score <= 5) {
            recommendationReason = `Happening near you in ${e.city}`;
            recommendationBadge = 'Near You';
          }
        }

        if (e.is_featured) score += 3;

        return {
          ...e,
          score,
          recommendationReason,
          recommendationBadge,
        };
      })
      .sort((a, b) => b.score - a.score || new Date(a.start_date) - new Date(b.start_date));

    // ──────────────── BUILD CONTEXTUAL RECOMMENDATION SECTIONS ────────────────
    const sections = [];
    const usedEventIds = new Set();

    // Section 1: "Because you attended: [Event Name]"
    // E.g. Blueprint example: "Because you attended: Tech Summit Ghana" -> "Ghana Developer Conference, AI Ghana Summit, Startup Expo Accra"
    if (pastAttendedEvents.length > 0) {
      let attendedCount = 0;
      for (const attended of pastAttendedEvents) {
        if (attendedCount >= 2) break;
        const related = candidates.filter(
          (c) =>
            !ownedEventIds.has(c.id) &&
            !usedEventIds.has(c.id) &&
            (c.category === attended.category ||
              (attended.category && (c.description || '').toLowerCase().includes(attended.category.toLowerCase()))),
        ).slice(0, 4);

        if (related.length > 0) {
          attendedCount++;
          related.forEach((r) => usedEventIds.add(r.id));
          sections.push({
            id: `attended_${attended.id}`,
            type: 'because_you_attended',
            title: `Because you attended: ${attended.title}`,
            subtitle: `Handpicked upcoming ${attended.category || 'live'} events matching your experience`,
            basis: attended.title,
            category: attended.category,
            events: related.map((r) => ({
              ...r,
              recommendationReason: `Because you attended ${attended.title}`,
              recommendationBadge: 'Past Attendance',
            })),
          });
        }
      }
    }

    // Section 2: "From Organizers & Artists You Follow"
    if (followedOrganizerIds.size > 0) {
      const orgEvents = candidates
        .filter((c) => !ownedEventIds.has(c.id) && followedOrganizerIds.has(Number(c.organizer_id)))
        .slice(0, 4);

      if (orgEvents.length > 0) {
        orgEvents.forEach((r) => usedEventIds.add(r.id));
        sections.push({
          id: 'organizers_followed',
          type: 'organizers_followed',
          title: 'From Organizers & Artists You Follow',
          subtitle: 'Upcoming shows from your favorite event creators',
          events: orgEvents.map((r) => ({
            ...r,
            recommendationReason: `From ${r.organizer_name || 'an organizer'} you follow`,
            recommendationBadge: 'Following',
          })),
        });
      }
    }

    // Section 3: "Matches Your Favorite Categories"
    if (favoriteCategories.length > 0) {
      const favEvents = candidates
        .filter((c) => !ownedEventIds.has(c.id) && favCatSet.has((c.category || '').toLowerCase()))
        .slice(0, 6);

      if (favEvents.length > 0) {
        favEvents.forEach((r) => usedEventIds.add(r.id));
        sections.push({
          id: 'favorite_categories',
          type: 'favorite_categories',
          title: 'Matches Your Favorite Categories',
          subtitle: `Curated for your preferences: ${favoriteCategories.join(', ')}`,
          categories: favoriteCategories,
          events: favEvents.map((r) => ({
            ...r,
            recommendationReason: `Matches your favorite category: ${r.category}`,
            recommendationBadge: 'Favorite Category',
          })),
        });
      }
    }

    // Section 4: "Based on Your Recent Searches"
    if (recentSearches.length > 0) {
      const latest = recentSearches[0];
      const q = (latest.query || '').toLowerCase();
      if (q.length >= 3) {
        const searchMatches = candidates
          .filter(
            (c) =>
              !ownedEventIds.has(c.id) &&
              ((c.title || '').toLowerCase().includes(q) ||
                (c.category || '').toLowerCase().includes(q) ||
                (c.description || '').toLowerCase().includes(q)),
          )
          .slice(0, 4);

        if (searchMatches.length > 0) {
          searchMatches.forEach((r) => usedEventIds.add(r.id));
          sections.push({
            id: 'recent_searches',
            type: 'search_history',
            title: `Because you searched for "${latest.query}"`,
            subtitle: 'Recommended matches from your search activity',
            query: latest.query,
            events: searchMatches.map((r) => ({
              ...r,
              recommendationReason: `Based on your search for "${latest.query}"`,
              recommendationBadge: 'Search Match',
            })),
          });
        }
      }
    }

    // Section 5: "Trending Near You"
    if (userCity) {
      const cityMatches = candidates
        .filter((c) => !ownedEventIds.has(c.id) && c.city && c.city.toLowerCase().includes(userCity))
        .slice(0, 4);

      if (cityMatches.length > 0) {
        sections.push({
          id: 'near_you',
          type: 'location',
          title: `Trending Near You in ${userCity.charAt(0).toUpperCase() + userCity.slice(1)}`,
          subtitle: 'Live experiences happening right around you',
          city: userCity,
          events: cityMatches.map((r) => ({
            ...r,
            recommendationReason: `Happening in ${r.city}`,
            recommendationBadge: 'Near You',
          })),
        });
      }
    }

    const top = (scored.length && scored.some((e) => e.score > 0) ? scored : candidates)
      .slice(0, limit)
      .map((e) => ({
        ...e,
        recommendationReason: e.recommendationReason || (e.is_featured ? 'Featured on Tribes & Cliqs' : 'Popular upcoming event'),
        recommendationBadge: e.recommendationBadge || (e.is_featured ? 'Featured Pick' : 'Trending'),
      }));

    res.json({
      events: top,
      sections,
      meta: {
        favoriteCategories,
        location: userCity,
        followingCount: followedOrganizerIds.size,
        searchesCount: recentSearches.length,
        attendedCount: pastAttendedEvents.length,
      },
    });
  } catch (err) {
    console.error('[eventController.getRecommendedEvents]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Event Reminders                                                     */
/* ------------------------------------------------------------------ */
export const toggleEventReminder = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const [eventRows] = await pool.execute('SELECT id, title, start_date FROM events WHERE id = ?', [id]);
    const event = eventRows[0];
    if (!event) return res.status(404).json({ message: 'Event not found' });

    const [existing] = await pool.execute(
      'SELECT id, preferences FROM event_reminders WHERE user_id = ? AND event_id = ?',
      [userId, id],
    );

    if (existing.length > 0) {
      await pool.execute('DELETE FROM event_reminders WHERE user_id = ? AND event_id = ?', [userId, id]);
      return res.json({ isReminded: false, message: 'Event reminder removed' });
    }

    const rawPrefs = req.body?.preferences;
    const preferences = {
      sevenDays: rawPrefs?.sevenDays ?? true,
      twentyFourHours: rawPrefs?.twentyFourHours ?? true,
      oneHour: rawPrefs?.oneHour ?? true,
      salesOpening: rawPrefs?.salesOpening ?? true,
      almostSoldOut: rawPrefs?.almostSoldOut ?? true,
      timeChanged: rawPrefs?.timeChanged ?? true,
      venueChanged: rawPrefs?.venueChanged ?? true,
      cancelled: rawPrefs?.cancelled ?? true,
    };

    await pool.execute(
      `INSERT INTO event_reminders (user_id, event_id, remind_at, preferences, notified_stages)
       VALUES (?, ?, ?, ?, '[]')`,
      [userId, id, event.start_date, JSON.stringify(preferences)],
    );

    sendNotification({
      userId,
      title: 'Event Reminder Set',
      message: `You'll be notified before ${event.title} begins!`,
      type: 'event',
    }).catch(() => {});

    res.json({
      isReminded: true,
      preferences,
      message: 'Event reminder set! We will notify you at key milestones and schedule updates.',
    });
  } catch (err) {
    console.error('[eventController.toggleEventReminder]', err);
    res.status(500).json({ message: 'Failed to update reminder' });
  }
};

export const updateReminderPreferences = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const preferences = req.body.preferences;
    if (!preferences) return res.status(400).json({ message: 'Preferences required' });

    await pool.execute(
      `UPDATE event_reminders SET preferences = ? WHERE user_id = ? AND event_id = ?`,
      [JSON.stringify(preferences), userId, id],
    );
    res.json({ message: 'Reminder preferences updated', preferences });
  } catch (err) {
    console.error('[eventController.updateReminderPreferences]', err);
    res.status(500).json({ message: 'Failed to update reminder preferences' });
  }
};

export const getEventReminderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    if (!userId) return res.json({ isReminded: false, preferences: null });

    const [rows] = await pool.execute(
      'SELECT id, preferences FROM event_reminders WHERE user_id = ? AND event_id = ?',
      [userId, id],
    );

    if (rows.length === 0) {
      return res.json({ isReminded: false, preferences: null });
    }

    let prefs = rows[0].preferences;
    if (typeof prefs === 'string') {
      try { prefs = JSON.parse(prefs); } catch { prefs = null; }
    }

    res.json({ isReminded: true, preferences: prefs });
  } catch (err) {
    console.error('[eventController.getEventReminderStatus]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const processRemindersManualTrigger = async (_req, res) => {
  try {
    const result = await processEventReminders();
    res.json({ message: 'Reminders processed successfully', result });
  } catch (err) {
    console.error('[eventController.processRemindersManualTrigger]', err);
    res.status(500).json({ message: 'Server error processing reminders' });
  }
};

export const getUserReminders = async (req, res) => {
  try {
    const userId = req.user.id;
    const [rows] = await pool.execute(
      `SELECT er.id AS reminder_id, er.remind_at, er.preferences, er.created_at AS reminder_created_at,
              e.id, e.title, e.slug, e.description, e.banner_image, e.venue, e.city,
              e.category, e.start_date, e.end_date, e.start_time, e.is_featured,
              u.name AS organizer_name,
              (SELECT MIN(price) FROM ticket_types WHERE event_id = e.id) AS min_price
       FROM event_reminders er
       JOIN events e ON e.id = er.event_id
       LEFT JOIN users u ON u.id = e.organizer_id
       WHERE er.user_id = ? AND e.status = 'published' AND e.start_date >= CURRENT_DATE
       ORDER BY e.start_date ASC`,
      [userId],
    );

    const formatted = rows.map((r) => {
      let prefs = r.preferences;
      if (typeof prefs === 'string') {
        try { prefs = JSON.parse(prefs); } catch { prefs = null; }
      }
      return { ...r, preferences: prefs };
    });

    res.json({ reminders: formatted });
  } catch (err) {
    console.error('[eventController.getUserReminders]', err);
    res.status(500).json({ message: 'Server error fetching user reminders' });
  }
};

/* ------------------------------------------------------------------ */
/* Get categories (public)                                              */
/* ------------------------------------------------------------------ */
export const getCategories = async (_req, res) => {
  try {
    const cacheKey = 'events_categories_all';
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const [rows] = await pool.execute(
      `SELECT c.id, c.name, c.slug, c.icon, c.description,
              COUNT(e.id)::int AS event_count
       FROM categories c
       LEFT JOIN events e ON (e.category_id = c.id OR LOWER(e.category) = LOWER(c.name)) AND e.status = 'published'
       GROUP BY c.id, c.name, c.slug, c.icon, c.description
       ORDER BY c.name ASC`,
    );
    cache.set(cacheKey, rows, 300_000); // 5 minutes
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
    const limitNum = Math.min(parseInt(limit, 10) || 6, 20);
    const cacheKey = `events_organizers_${limitNum}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const [rows] = await pool.execute(
      `SELECT u.id, u.name, COALESCE(u.avatar_url, u.avatar) AS avatar,
              COUNT(e.id) AS events_count,
              op.organization_name,
              'Organizer' AS specialty
       FROM users u
       LEFT JOIN organizer_profiles op ON op.user_id = u.id
       LEFT JOIN events e ON e.organizer_id = u.id AND e.status = 'published'
       WHERE u.role = 'organizer' AND u.is_approved = TRUE AND u.status = 'active'
       GROUP BY u.id, u.name, u.avatar_url, u.avatar, op.organization_name
       ORDER BY events_count DESC, u.name ASC
       LIMIT ${limitNum}`,
    );
    cache.set(cacheKey, rows, 300_000); // 5 minutes
    res.json(rows);
  } catch (err) {
    console.error('[eventController.getFeaturedOrganizers]', err);
    res.status(500).json({ message: 'Server error fetching organizers' });
  }
};

/* ------------------------------------------------------------------ */
/* Get Public Organizer Profile with Events & Reviews                 */
/* ------------------------------------------------------------------ */
export const getPublicOrganizerProfile = async (req, res) => {
  try {
    const { id } = req.params;
    const organizerId = Number(id);
    if (!organizerId || isNaN(organizerId)) {
      return res.status(400).json({ message: 'Valid organizer ID required' });
    }

    const [userRows] = await pool.execute(
      `SELECT u.id, u.name, u.email, u.phone, COALESCE(u.avatar_url, u.avatar) AS avatar,
              u.created_at, op.organization_name, op.description, op.about, op.website,
              op.logo_url, op.banner_url, op.social_links, op.is_verified, op.category,
              op.city, op.country, op.primary_color, op.tagline
       FROM users u
       LEFT JOIN organizer_profiles op ON op.user_id = u.id
       WHERE u.id = ? AND u.role IN ('organizer', 'admin', 'system_admin')`,
      [organizerId],
    );

    const organizer = userRows[0];
    if (!organizer) {
      return res.status(404).json({ message: 'Organizer not found' });
    }

    // Followers count
    let followersCount = 0;
    try {
      const [followerRows] = await pool.execute(
        `SELECT COUNT(*) AS count FROM organizer_follows WHERE organizer_id = ?`,
        [organizerId],
      );
      followersCount = Number(followerRows[0]?.count || 0);
    } catch {
      // safe fallback if organizer_follows table is missing
    }

    // Is current user following?
    let isFollowing = false;
    if (req.user?.id) {
      try {
        const [followCheck] = await pool.execute(
          `SELECT id FROM organizer_follows WHERE follower_id = ? AND organizer_id = ?`,
          [req.user.id, organizerId],
        );
        isFollowing = followCheck.length > 0;
      } catch {
        isFollowing = false;
      }
    }

    // Events by this organizer
    const [eventsRows] = await pool.execute(
      `SELECT e.*,
              COALESCE(MIN(tt.price), 0) AS min_price,
              COALESCE(MAX(tt.price), 0) AS max_price,
              COALESCE(SUM(tt.quantity), 0) AS total_capacity,
              COALESCE(SUM(tt.quantity_sold), 0) AS total_sold
       FROM events e
       LEFT JOIN ticket_types tt ON tt.event_id = e.id AND tt.is_active = TRUE
       WHERE e.organizer_id = ? AND e.status = 'published'
       GROUP BY e.id
       ORDER BY e.start_date ASC, e.start_time ASC`,
      [organizerId],
    );

    const todayStr = new Date().toISOString().split('T')[0];
    const upcomingEvents = [];
    const pastEvents = [];

    for (const ev of eventsRows) {
      const evDate = ev.start_date ? new Date(ev.start_date).toISOString().split('T')[0] : '';
      if (evDate >= todayStr) {
        upcomingEvents.push(ev);
      } else {
        pastEvents.push(ev);
      }
    }

    // Reviews & average rating across organizer's events
    let reviewsRows = [];
    let averageRating = 5.0;
    try {
      const [revRows] = await pool.execute(
        `SELECT r.id, r.rating, r.comment, r.created_at,
                u.name AS reviewer_name, COALESCE(u.avatar_url, u.avatar) AS reviewer_avatar,
                e.title AS event_title, e.id AS event_id
         FROM reviews r
         JOIN users u ON u.id = r.user_id
         JOIN events e ON e.id = r.event_id
         WHERE e.organizer_id = ?
         ORDER BY r.created_at DESC
         LIMIT 30`,
        [organizerId],
      );
      reviewsRows = revRows;
      if (reviewsRows.length > 0) {
        const sum = reviewsRows.reduce((acc, r) => acc + Number(r.rating || 0), 0);
        averageRating = Number((sum / reviewsRows.length).toFixed(1));
      }
    } catch {
      reviewsRows = [];
    }

    res.json({
      organizer,
      stats: {
        totalEvents: eventsRows.length,
        upcomingCount: upcomingEvents.length,
        pastCount: pastEvents.length,
        followersCount,
        isFollowing,
        averageRating,
        reviewCount: reviewsRows.length,
      },
      upcomingEvents,
      pastEvents,
      reviews: reviewsRows,
    });
  } catch (err) {
    console.error('[eventController.getPublicOrganizerProfile]', err);
    res.status(500).json({ message: 'Server error fetching organizer profile' });
  }
};

export default {
  getEvents, getEvent, trackEventView, trackSearchQuery, createEvent, updateEvent, deleteEvent,
  publishEvent, unpublishEvent,
  getOrganizerEvents, getFeaturedEvents, getTrendingEvents, getRecommendedEvents,
  toggleEventReminder, getEventReminderStatus, updateReminderPreferences, getUserReminders, processRemindersManualTrigger,
  getCategories, getFeaturedOrganizers, getPublicOrganizerProfile,
};
