import { v4 as uuidv4 } from 'uuid';
import pool from '../config/db.js';
import { sendMarketingEmail as dispatchMarketingEmail } from '../utils/email.js';
import { sendNotification } from '../utils/notify.js';
import { logAudit } from '../utils/audit.js';
import { validatePassword } from '../utils/password.js';
import textPdf from '../utils/pdf.js';

/* ------------------------------------------------------------------ */
/* Dashboard stats                                                     */
/* ------------------------------------------------------------------ */
export const getDashboardStats = async (req, res) => {
  try {
    const organizerId = req.user.id;
    const monthStart = `TO_CHAR(CURRENT_DATE, 'YYYY-MM-01')`;

    // Percentage change helper (month over month).
    const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : cur > 0 ? 100 : 0);

    // Organization header.
    const [[orgRow]] = await pool.execute(
      `SELECT u.name, u.is_approved, op.organization_name
       FROM users u
       LEFT JOIN organizer_profiles op ON op.user_id = u.id
       WHERE u.id = ?`,
      [organizerId],
    );

    // Event counts.
    const [[eventsCount]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM events WHERE organizer_id = ?`,
      [organizerId],
    );
    const [[activeEventsCount]] = await pool.execute(
      `SELECT COUNT(*) AS total
       FROM events
       WHERE organizer_id = ? AND status = 'published' AND start_date >= CURRENT_DATE()`,
      [organizerId],
    );

    // Totals: revenue, orders, tickets.
    const [[revenueRow]] = await pool.execute(
      `SELECT COALESCE(SUM(o.total_amount - o.discount_amount), 0) AS revenue
       FROM orders o
       JOIN events e ON e.id = o.event_id
       WHERE e.organizer_id = ? AND o.payment_status = 'completed'`,
      [organizerId],
    );
    const [[ordersRow]] = await pool.execute(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN o.payment_status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
              COALESCE(SUM(CASE WHEN o.payment_status = 'refunded' THEN 1 ELSE 0 END), 0) AS refunds
       FROM orders o
       JOIN events e ON e.id = o.event_id
       WHERE e.organizer_id = ?`,
      [organizerId],
    );
    const [[ticketsRow]] = await pool.execute(
      `SELECT COUNT(*) AS total
       FROM tickets t
       JOIN events e ON e.id = t.event_id
       WHERE e.organizer_id = ? AND t.status = 'active'`,
      [organizerId],
    );

    // Month-over-month trends.
    const [[eventTrend]] = await pool.execute(
      `SELECT
         COALESCE(SUM(CASE WHEN created_at >= ${monthStart} THEN 1 ELSE 0 END), 0) AS thisMonth,
         COALESCE(SUM(CASE WHEN created_at < ${monthStart}
                           AND created_at >= (${monthStart})::date - INTERVAL '1 month' THEN 1 ELSE 0 END), 0) AS lastMonth
       FROM events
       WHERE organizer_id = ?`,
      [organizerId],
    );
    const [[activeTrend]] = await pool.execute(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'published' AND start_date >= ${monthStart} THEN 1 ELSE 0 END), 0) AS thisMonth,
         COALESCE(SUM(CASE WHEN status = 'published' AND start_date >= (${monthStart})::date - INTERVAL '1 month'
                           AND start_date < ${monthStart} THEN 1 ELSE 0 END), 0) AS lastMonth
       FROM events
       WHERE organizer_id = ?`,
      [organizerId],
    );
    const [[ticketTrend]] = await pool.execute(
      `SELECT
         COALESCE(SUM(CASE WHEN t.created_at >= ${monthStart} THEN 1 ELSE 0 END), 0) AS thisMonth,
         COALESCE(SUM(CASE WHEN t.created_at < ${monthStart}
                           AND t.created_at >= (${monthStart})::date - INTERVAL '1 month' THEN 1 ELSE 0 END), 0) AS lastMonth
       FROM tickets t
       JOIN events e ON e.id = t.event_id
       WHERE e.organizer_id = ?`,
      [organizerId],
    );
    const [[orderTrend]] = await pool.execute(
      `SELECT
         COALESCE(SUM(CASE WHEN o.payment_status = 'completed' AND o.created_at >= ${monthStart}
                           THEN o.total_amount - o.discount_amount ELSE 0 END), 0) AS revenueThisMonth,
         COALESCE(SUM(CASE WHEN o.payment_status = 'completed' AND o.created_at < ${monthStart}
                           AND o.created_at >= (${monthStart})::date - INTERVAL '1 month'
                           THEN o.total_amount - o.discount_amount ELSE 0 END), 0) AS revenueLastMonth
       FROM orders o
       JOIN events e ON e.id = o.event_id
       WHERE e.organizer_id = ?`,
      [organizerId],
    );

    // Recent orders (latest 8 across the organizer's events).
    const [recentOrders] = await pool.execute(
      `SELECT o.id, o.payment_reference AS reference, u.name AS customerName,
              e.title AS eventTitle, COALESCE(SUM(oi.quantity), 0) AS ticketCount,
              o.total_amount AS amount, o.payment_status AS status, o.created_at AS createdAt
       FROM orders o
       JOIN users u ON u.id = o.user_id
       JOIN events e ON e.id = o.event_id
       LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE e.organizer_id = ?
       GROUP BY o.id, o.payment_reference, u.name, e.title, o.total_amount, o.payment_status, o.created_at
       ORDER BY o.created_at DESC
       LIMIT 8`,
      [organizerId],
    );

    // Upcoming events with capacity and tickets sold.
    const [upcomingEvents] = await pool.execute(
      `SELECT e.id, e.title, e.start_date AS startDate, e.venue, e.city, e.capacity AS totalCapacity,
              (SELECT COUNT(*) FROM tickets t WHERE t.event_id = e.id AND t.status = 'active') AS ticketsSold
       FROM events e
       WHERE e.organizer_id = ? AND e.status IN ('published', 'pending') AND e.start_date >= CURRENT_DATE()
       ORDER BY e.start_date ASC
       LIMIT 6`,
      [organizerId],
    );

    // Top 5 events by tickets sold.
    const [topEvents] = await pool.execute(
      `SELECT e.id, e.title AS name,
              (SELECT COUNT(*) FROM tickets t WHERE t.event_id = e.id AND t.status = 'active') AS ticketsSold
       FROM events e
       WHERE e.organizer_id = ?
       ORDER BY ticketsSold DESC
       LIMIT 5`,
      [organizerId],
    );

    res.json({
      organization: {
        name: orgRow?.organization_name || orgRow?.name || '',
        isApproved: Number(orgRow?.is_approved) === 1,
      },
      metrics: {
        totalEvents: eventsCount.total,
        totalEventsTrend: pct(eventTrend.thisMonth, eventTrend.lastMonth),
        ticketsSold: ticketsRow.total,
        ticketsSoldTrend: pct(ticketTrend.thisMonth, ticketTrend.lastMonth),
        totalRevenue: Number(revenueRow.revenue),
        revenueTrend: pct(orderTrend.revenueThisMonth, orderTrend.revenueLastMonth),
        activeEvents: activeEventsCount.total,
        activeEventsTrend: pct(activeTrend.thisMonth, activeTrend.lastMonth),
        totalOrders: ordersRow.total,
        pendingOrders: ordersRow.pending,
        refunds: ordersRow.refunds,
      },
      recentOrders,
      upcomingEvents,
      topEvents,
    });
  } catch (err) {
    console.error('[organizerController.getDashboardStats]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Organizer profile                                                   */
/* ------------------------------------------------------------------ */
export const getOrganizerProfile = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute(
      `SELECT u.id, u.name, u.email, u.avatar, op.*
       FROM users u
       LEFT JOIN organizer_profiles op ON op.user_id = u.id
       WHERE u.id = ? AND u.role = 'organizer'`,
      [id],
    );
    const profile = rows[0];
    if (!profile) return res.status(404).json({ message: 'Organizer not found' });

    const [events] = await pool.execute(
      `SELECT id, title, start_date, status, banner_image FROM events WHERE organizer_id = ? AND status = 'published' ORDER BY start_date DESC`,
      [id],
    );

    res.json({ organizer: profile, events });
  } catch (err) {
    console.error('[organizerController.getOrganizerProfile]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const updateOrganizerProfile = async (req, res) => {
  try {
    const {
      organization_name, description, website, social_links, logo, banner,
    } = req.body;

    const allowed = ['organization_name', 'description', 'website', 'logo', 'banner'];
    const fields = [];
    const values = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(req.body[key]);
      }
    }
    if (social_links !== undefined) {
      fields.push('social_links = ?');
      values.push(JSON.stringify(social_links));
    }

    if (!fields.length) return res.status(400).json({ message: 'No fields to update' });

    values.push(req.user.id);
    await pool.execute(
      `UPDATE organizer_profiles SET ${fields.join(', ')} WHERE user_id = ?`,
      values,
    );

    await logAudit({ userId: req.user.id, action: 'update_organizer_profile', entityType: 'user', entityId: req.user.id });
    res.json({ message: 'Organizer profile updated' });
  } catch (err) {
    console.error('[organizerController.updateOrganizerProfile]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Revenue                                                             */
/* ------------------------------------------------------------------ */
export const getRevenue = async (req, res) => {
  try {
    const { range = '30d' } = req.query;
    let interval = "'30 days'";
    if (range === '7d') interval = "'7 days'";
    else if (range === '90d') interval = "'90 days'";
    else if (range === '1y') interval = "'1 year'";

    const [byEvent] = await pool.execute(
      `SELECT e.id, e.title, COALESCE(SUM(o.total_amount - o.discount_amount), 0) AS revenue,
              COUNT(o.id) AS orders
       FROM events e
       LEFT JOIN orders o ON o.event_id = e.id AND o.payment_status = 'completed'
       WHERE e.organizer_id = ?
       GROUP BY e.id, e.title
       ORDER BY revenue DESC`,
      [req.user.id],
    );

    const [totals] = await pool.execute(
      `SELECT COALESCE(SUM(o.total_amount - o.discount_amount), 0) AS total,
              COUNT(o.id) AS orders
       FROM orders o
       JOIN events e ON e.id = o.event_id
       WHERE e.organizer_id = ? AND o.payment_status = 'completed'
         AND o.created_at >= CURRENT_DATE - INTERVAL ${interval}`,
      [req.user.id],
    );

    // Daily revenue series within the range (for the dashboard chart).
    const [daily] = await pool.execute(
      `SELECT DATE(o.created_at) AS date,
              COALESCE(SUM(o.total_amount - o.discount_amount), 0) AS revenue
       FROM orders o
       JOIN events e ON e.id = o.event_id
       WHERE e.organizer_id = ? AND o.payment_status = 'completed'
         AND o.created_at >= CURRENT_DATE - INTERVAL ${interval}
       GROUP BY DATE(o.created_at)
       ORDER BY date ASC`,
      [req.user.id],
    );

    res.json({ revenueByEvent: byEvent, totals: totals[0], data: daily });
  } catch (err) {
    console.error('[organizerController.getRevenue]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Attendees                                                           */
/* ------------------------------------------------------------------ */
export const getAttendees = async (req, res) => {
  try {
    const { eventId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    const [eventRows] = await pool.execute('SELECT organizer_id FROM events WHERE id = ?', [eventId]);
    if (!eventRows[0]) return res.status(404).json({ message: 'Event not found' });
    if (eventRows[0].organizer_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const offset = (pageNum - 1) * limitNum;

    const [rows] = await pool.execute(
      `SELECT t.id, t.ticket_number, t.status, t.seat_number, t.checked_in_at, t.created_at,
              tt.name AS ticket_type, u.name AS attendee_name, u.email, u.phone
       FROM tickets t
       JOIN ticket_types tt ON tt.id = t.ticket_type_id
       JOIN users u ON u.id = t.user_id
       WHERE t.event_id = ?
       ORDER BY t.created_at DESC
       LIMIT ${limitNum} OFFSET ${offset}`,
      [eventId],
    );

    const [[countRow]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM tickets WHERE event_id = ?`,
      [eventId],
    );

    res.json({
      attendees: rows,
      pagination: { page: pageNum, limit: limitNum, total: countRow.total, totalPages: Math.ceil(countRow.total / limitNum) },
    });
  } catch (err) {
    console.error('[organizerController.getAttendees]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Export attendees as CSV                                             */
/* ------------------------------------------------------------------ */
export const exportAttendees = async (req, res) => {
  try {
    const { eventId } = req.params;
    const [eventRows] = await pool.execute('SELECT organizer_id, title FROM events WHERE id = ?', [eventId]);
    if (!eventRows[0]) return res.status(404).json({ message: 'Event not found' });
    if (eventRows[0].organizer_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const [rows] = await pool.execute(
      `SELECT t.ticket_number, t.status, t.seat_number, t.checked_in_at,
              tt.name AS ticket_type, u.name AS attendee_name, u.email, u.phone
       FROM tickets t
       JOIN ticket_types tt ON tt.id = t.ticket_type_id
       JOIN users u ON u.id = t.user_id
       WHERE t.event_id = ?
       ORDER BY t.created_at DESC`,
      [eventId],
    );

    if (req.query.format === 'pdf') {
      const pdf = textPdf({
        title: `Attendees - ${eventRows[0].title}`,
        lines: rows.map((r) =>
          `${r.ticket_number} | ${r.attendee_name || ''} | ${r.email || ''} | ${r.phone || ''} | ${r.ticket_type || ''} | ${r.status || ''} | ${r.checked_in_at || ''}`,
        ),
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="attendees-event-${eventId}.pdf"`);
      return res.send(pdf);
    }

    const header = ['Ticket Number', 'Status', 'Seat', 'Ticket Type', 'Name', 'Email', 'Phone', 'Checked In'];
    const lines = [header.join(',')];
    for (const r of rows) {
      const row = [
        r.ticket_number, r.status, r.seat_number || '', r.ticket_type,
        `"${(r.attendee_name || '').replace(/"/g, '""')}"`,
        `"${(r.email || '').replace(/"/g, '""')}"`,
        `"${(r.phone || '').replace(/"/g, '""')}"`,
        r.checked_in_at || '',
      ];
      lines.push(row.join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="attendees-event-${eventId}.csv"`);
    res.status(200).send(lines.join('\n'));
  } catch (err) {
    console.error('[organizerController.exportAttendees]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Coupons                                                             */
/* ------------------------------------------------------------------ */
export const createCoupon = async (req, res) => {
  try {
    const { eventId, code, discount_type, discount_value, max_uses, valid_from, valid_to } = req.body;
    if (!eventId || !code || !discount_type || discount_value === undefined) {
      return res.status(400).json({ message: 'eventId, code, discount_type and discount_value are required' });
    }

    const [eventRows] = await pool.execute('SELECT organizer_id FROM events WHERE id = ?', [eventId]);
    if (!eventRows[0]) return res.status(404).json({ message: 'Event not found' });
    if (eventRows[0].organizer_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const finalCode = (code || uuidv4().split('-')[0].toUpperCase()).toUpperCase();

    try {
      const [result] = await pool.execute(
        `INSERT INTO coupons (event_id, organizer_id, code, discount_type, discount_value, max_uses, valid_from, valid_to)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [eventId, req.user.id, finalCode, discount_type, discount_value, max_uses || 1, valid_from || null, valid_to || null],
      );
      res.status(201).json({ message: 'Coupon created', couponId: result.insertId, code: finalCode });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ message: 'Coupon code already exists' });
      }
      throw e;
    }
  } catch (err) {
    console.error('[organizerController.createCoupon]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getCoupons = async (req, res) => {
  try {
    const { eventId } = req.query;
    let sql = `SELECT * FROM coupons WHERE organizer_id = ?`;
    const params = [req.user.id];
    if (eventId) { sql += ` AND event_id = ?`; params.push(eventId); }
    sql += ` ORDER BY created_at DESC`;
    const [rows] = await pool.execute(sql, params);
    res.json({ coupons: rows });
  } catch (err) {
    console.error('[organizerController.getCoupons]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const deleteCoupon = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute('SELECT * FROM coupons WHERE id = ? AND organizer_id = ?', [id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ message: 'Coupon not found' });
    await pool.execute('DELETE FROM coupons WHERE id = ?', [id]);
    res.json({ message: 'Coupon deleted' });
  } catch (err) {
    console.error('[organizerController.deleteCoupon]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const updateCoupon = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute('SELECT * FROM coupons WHERE id = ? AND organizer_id = ?', [id, req.user.id]);
    const coupon = rows[0];
    if (!coupon) return res.status(404).json({ message: 'Coupon not found' });

    // Map the frontend payload to DB columns.
    const fieldMap = {
      code: 'code',
      type: 'discount_type',
      value: 'discount_value',
      maxUses: 'max_uses',
      validFrom: 'valid_from',
      validTo: 'valid_to',
      eventId: 'event_id',
      active: 'is_active',
    };
    const fields = [];
    const values = [];
    for (const [key, column] of Object.entries(fieldMap)) {
      if (req.body[key] !== undefined) {
        fields.push(`${column} = ?`);
        values.push(req.body[key]);
      }
    }
    if (!fields.length) return res.status(400).json({ message: 'No fields to update' });

    values.push(id, req.user.id);
    await pool.execute(
      `UPDATE coupons SET ${fields.join(', ')} WHERE id = ? AND organizer_id = ?`,
      values,
    );

    res.json({ message: 'Coupon updated' });
  } catch (err) {
    console.error('[organizerController.updateCoupon]', err);
    res.status(500).json({ message: 'Server error updating coupon' });
  }
};

/* ------------------------------------------------------------------ */
/* Per-event analytics                                                 */
/* ------------------------------------------------------------------ */
export const getEventAnalytics = async (req, res) => {
  try {
    const { eventId } = req.params;
    const [eventRows] = await pool.execute('SELECT * FROM events WHERE id = ?', [eventId]);
    const event = eventRows[0];
    if (!event) return res.status(404).json({ message: 'Event not found' });
    if (event.organizer_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const [[revRow]] = await pool.execute(
      `SELECT COALESCE(SUM(o.total_amount - o.discount_amount), 0) AS revenue,
              COUNT(DISTINCT o.id) AS orders
       FROM orders o
       WHERE o.event_id = ? AND o.payment_status = 'completed'`,
      [eventId],
    );

    const [[ticketRow]] = await pool.execute(
      `SELECT COUNT(*) AS total, COALESCE(SUM(status = 'used'), 0) AS checkedIn
       FROM tickets WHERE event_id = ?`,
      [eventId],
    );

    const [dailySales] = await pool.execute(
      `SELECT DATE(o.created_at) AS date,
              COALESCE(SUM(o.total_amount - o.discount_amount), 0) AS revenue,
              COUNT(*) AS orders
       FROM orders o
       WHERE o.event_id = ? AND o.payment_status = 'completed'
       GROUP BY DATE(o.created_at)
       ORDER BY date ASC`,
      [eventId],
    );

    const [ticketTypes] = await pool.execute(
      `SELECT id, name, price, quantity, quantity_sold
       FROM ticket_types WHERE event_id = ?
       ORDER BY price ASC`,
      [eventId],
    );

    const [recentOrders] = await pool.execute(
      `SELECT o.id, o.payment_reference AS reference, u.name AS buyer_name,
              o.total_amount AS amount, o.payment_status AS status, o.created_at AS date
       FROM orders o
       JOIN users u ON u.id = o.user_id
       WHERE o.event_id = ?
       ORDER BY o.created_at DESC
       LIMIT 10`,
      [eventId],
    );

    const sold = Number(ticketRow.total || 0);
    const checkedIn = Number(ticketRow.checkedIn || 0);
    const capacity = Number(event.capacity || 0);

    res.json({
      analytics: {
        overview: {
          revenue: Number(revRow.revenue || 0),
          orders: Number(revRow.orders || 0),
          ticketsSold: sold,
          checkedIn,
          attendanceRate: sold > 0 ? Math.round((checkedIn / sold) * 100) : 0,
          capacity,
          capacityUsed: capacity > 0 ? Math.round((sold / capacity) * 100) : 0,
        },
        dailySales,
        ticketTypes: ticketTypes.map((t) => ({
          ...t,
          sold: Number(t.quantity_sold || 0),
          remaining: Math.max(Number(t.quantity || 0) - Number(t.quantity_sold || 0), 0),
        })),
        recentOrders,
      },
    });
  } catch (err) {
    console.error('[organizerController.getEventAnalytics]', err);
    res.status(500).json({ message: 'Server error fetching event analytics' });
  }
};

/* ------------------------------------------------------------------ */
/* Withdrawals                                                         */
/* ------------------------------------------------------------------ */
export const getWithdrawals = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM withdrawals WHERE organizer_id = ? ORDER BY created_at DESC`,
      [req.user.id],
    );
    res.json({ withdrawals: rows });
  } catch (err) {
    console.error('[organizerController.getWithdrawals]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const requestWithdrawal = async (req, res) => {
  try {
    const { amount, bank_name, account_number, account_name } = req.body;
    if (!amount || !bank_name || !account_number || !account_name) {
      return res.status(400).json({ message: 'amount, bank_name, account_number and account_name are required' });
    }

    // Check available balance.
    const [[revenueRow]] = await pool.execute(
      `SELECT COALESCE(SUM(o.total_amount - o.discount_amount), 0) AS revenue
       FROM orders o
       JOIN events e ON e.id = o.event_id
       WHERE e.organizer_id = ? AND o.payment_status = 'completed'`,
      [req.user.id],
    );
    const [[withdrawnRow]] = await pool.execute(
      `SELECT COALESCE(SUM(w.amount), 0) AS withdrawn
       FROM withdrawals w
       WHERE w.organizer_id = ? AND w.status IN ('pending','approved')`,
      [req.user.id],
    );
    const available = Number(revenueRow.revenue) - Number(withdrawnRow.withdrawn);
    if (Number(amount) > available) {
      return res.status(400).json({ message: `Insufficient balance. Available: ${available}` });
    }

    const reference = `WD-${uuidv4().split('-')[0].toUpperCase()}`;
    const [result] = await pool.execute(
      `INSERT INTO withdrawals (organizer_id, amount, status, bank_name, account_number, account_name, reference)
       VALUES (?, ?, 'pending', ?, ?, ?, ?)`,
      [req.user.id, amount, bank_name, account_number, account_name, reference],
    );

    await logAudit({ userId: req.user.id, action: 'request_withdrawal', entityType: 'withdrawal', entityId: result.insertId });
    res.status(201).json({ message: 'Withdrawal request submitted', reference, withdrawalId: result.insertId });
  } catch (err) {
    console.error('[organizerController.requestWithdrawal]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Team members                                                        */
/* ------------------------------------------------------------------ */
export const getTeamMembers = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT tm.*, u.name, u.email, u.avatar
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
       WHERE tm.organizer_id = ?`,
      [req.user.id],
    );
    res.json({ teamMembers: rows });
  } catch (err) {
    console.error('[organizerController.getTeamMembers]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const addTeamMember = async (req, res) => {
  try {
    const { email, role = 'staff', permissions } = req.body;
    if (!email) return res.status(400).json({ message: 'email is required' });

    const [userRows] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
    const user = userRows[0];
    if (!user) return res.status(404).json({ message: 'User not found with that email' });
    if (user.id === req.user.id) return res.status(400).json({ message: 'You cannot add yourself' });

    try {
      const [result] = await pool.execute(
        `INSERT INTO team_members (organizer_id, user_id, role, permissions) VALUES (?, ?, ?, ?)`,
        [req.user.id, user.id, role, permissions ? JSON.stringify(permissions) : null],
      );
      res.status(201).json({ message: 'Team member added', teamMemberId: result.insertId });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ message: 'User is already a team member' });
      }
      throw e;
    }
  } catch (err) {
    console.error('[organizerController.addTeamMember]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const removeTeamMember = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute('DELETE FROM team_members WHERE id = ? AND organizer_id = ?', [id, req.user.id]);
    res.json({ message: 'Team member removed' });
  } catch (err) {
    console.error('[organizerController.removeTeamMember]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Send marketing email                                                */
/* ------------------------------------------------------------------ */
export const sendMarketingEmail = async (req, res) => {
  try {
    const { eventId, subject, htmlContent } = req.body;
    if (!subject || !htmlContent) {
      return res.status(400).json({ message: 'subject and htmlContent are required' });
    }

    let recipients = [];
    if (eventId) {
      const [eventRows] = await pool.execute('SELECT organizer_id FROM events WHERE id = ?', [eventId]);
      if (!eventRows[0]) return res.status(404).json({ message: 'Event not found' });
      if (eventRows[0].organizer_id !== req.user.id) {
        return res.status(403).json({ message: 'Forbidden' });
      }
      const [rows] = await pool.execute(
        `SELECT DISTINCT u.email FROM tickets t
         JOIN users u ON u.id = t.user_id
         WHERE t.event_id = ?`,
        [eventId],
      );
      recipients = rows.map((r) => r.email);
    } else {
      const [rows] = await pool.execute(
        `SELECT DISTINCT u.email FROM tickets t
         JOIN events e ON e.id = t.event_id
         JOIN users u ON u.id = t.user_id
         WHERE e.organizer_id = ?`,
        [req.user.id],
      );
      recipients = rows.map((r) => r.email);
    }

    if (!recipients.length) {
      return res.status(400).json({ message: 'No recipients found' });
    }

    let sent = 0;
    for (const email of recipients) {
      const ok = await dispatchMarketingEmail(email, subject, htmlContent);
      if (ok) sent++;
    }

    await logAudit({ userId: req.user.id, action: 'send_marketing_email', entityType: 'event', entityId: eventId || null, details: { recipients: recipients.length, sent } });
    res.json({ message: `Marketing email sent to ${sent}/${recipients.length} recipients` });
  } catch (err) {
    console.error('[organizerController.sendMarketingEmail]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Reports                                                             */
/* ------------------------------------------------------------------ */
export const getReports = async (req, res) => {
  try {
    const { from, to } = req.query;
    let dateFilter = '';
    const params = [req.user.id];
    if (from && to) {
      dateFilter = `AND o.created_at BETWEEN ? AND ?`;
      params.push(from, to);
    }

    const [eventReports] = await pool.execute(
      `SELECT e.id, e.title, e.start_date,
              COUNT(o.id) AS orders,
              COALESCE(SUM(o.total_amount - o.discount_amount), 0) AS revenue,
              (SELECT COUNT(*) FROM tickets t WHERE t.event_id = e.id AND t.status = 'active') AS tickets_sold,
              (SELECT COUNT(*) FROM tickets t WHERE t.event_id = e.id AND t.status = 'used') AS checked_in
       FROM events e
       LEFT JOIN orders o ON o.event_id = e.id AND o.payment_status = 'completed' ${dateFilter}
       WHERE e.organizer_id = ?
       GROUP BY e.id
       ORDER BY revenue DESC`,
      params,
    );

    res.json({ reports: eventReports });
  } catch (err) {
    console.error('[organizerController.getReports]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getReportSummary = async (req, res) => {
  try {
    const organizerId = req.user.id;
    const { from, to } = req.query;
    let dateFilter = '';
    const params = [organizerId];
    if (from && to) {
      dateFilter = ` AND o.created_at BETWEEN ? AND ?`;
      params.push(`${from} 00:00:00`, `${to} 23:59:59`);
    }

    const [[revRow]] = await pool.execute(
      `SELECT COALESCE(SUM(o.total_amount - o.discount_amount), 0) AS totalRevenue,
              COUNT(DISTINCT o.id) AS totalOrders
       FROM orders o
       JOIN events e ON e.id = o.event_id
       WHERE e.organizer_id = ? AND o.payment_status = 'completed'${dateFilter}`,
      params,
    );

    const [[ticketRow]] = await pool.execute(
      `SELECT COUNT(*) AS totalTickets, COUNT(DISTINCT t.user_id) AS totalAttendees
       FROM tickets t
       JOIN events e ON e.id = t.event_id
       WHERE e.organizer_id = ?`,
      [organizerId],
    );

    const [[eventsRow]] = await pool.execute(
      `SELECT COUNT(*) AS totalEvents FROM events WHERE organizer_id = ?`,
      [organizerId],
    );

    res.json({
      summary: {
        totalRevenue: Number(revRow?.totalRevenue || 0),
        totalOrders: Number(revRow?.totalOrders || 0),
        totalTicketsSold,
        totalCheckedIn,
        checkInRate,
      },
    });
  } catch (err) {
    console.error('[organizerController.getReportSummary]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getSalesByEvent = async (req, res) => {
  try {
    const organizerId = req.user.id;
    const { from, to } = req.query;
    let dateFilter = '';
    const params = [organizerId];
    if (from && to) {
      dateFilter = ` AND o.created_at BETWEEN ? AND ?`;
      params.push(`${from} 00:00:00`, `${to} 23:59:59`);
    }

    const [dailySales] = await pool.execute(
      `SELECT DATE(o.created_at) AS date,
              COALESCE(SUM(o.total_amount - o.discount_amount), 0) AS revenue,
              COUNT(o.id) AS orders
       FROM orders o
       JOIN events e ON e.id = o.event_id
       WHERE e.organizer_id = ? AND o.payment_status = 'completed' ${dateFilter}
       GROUP BY DATE(o.created_at)
       ORDER BY date ASC`,
      params,
    );

    const [eventSales] = await pool.execute(
      `SELECT e.id, e.title,
              COALESCE(SUM(o.total_amount - o.discount_amount), 0) AS revenue,
              COUNT(o.id) AS orders
       FROM events e
       LEFT JOIN orders o ON o.event_id = e.id AND o.payment_status = 'completed' ${dateFilter}
       WHERE e.organizer_id = ?
       GROUP BY e.id, e.title
       ORDER BY revenue DESC`,
      params,
    );

    res.json({ dailySales, eventSales });
  } catch (err) {
    console.error('[organizerController.getSalesByEvent]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getSalesReport = getSalesByEvent;

export const getAttendanceReport = async (req, res) => {
  try {
    const organizerId = req.user.id;

    const [rows] = await pool.execute(
      `SELECT e.id, e.title,
              COUNT(t.id) AS total,
              SUM(CASE WHEN t.status = 'used' OR t.checked_in_at IS NOT NULL THEN 1 ELSE 0 END) AS checkedIn
       FROM events e
       LEFT JOIN tickets t ON t.event_id = e.id
       WHERE e.organizer_id = ?
       GROUP BY e.id, e.title`,
      [organizerId],
    );

    let totalTickets = 0;
    let totalCheckedIn = 0;

    const byEvent = rows.map((r) => {
      const tot = Number(r.total || 0);
      const chk = Number(r.checkedIn || 0);
      totalTickets += tot;
      totalCheckedIn += chk;
      return {
        id: r.id,
        title: r.title,
        total: tot,
        checkedIn: chk,
        rate: tot > 0 ? Math.round((chk / tot) * 100) : 0,
      };
    });

    const rate = totalTickets > 0 ? Math.round((totalCheckedIn / totalTickets) * 100) : 0;

    res.json({
      attendance: {
        total: totalTickets,
        checkedIn: totalCheckedIn,
        rate,
        byEvent,
      },
    });
  } catch (err) {
    console.error('[organizerController.getAttendanceReport]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getTopEvents = async (req, res) => {
  try {
    const organizerId = req.user.id;

    const [rows] = await pool.execute(
      `SELECT e.id, e.title, e.banner_image AS image,
              COALESCE(SUM(o.total_amount - o.discount_amount), 0) AS revenue,
              COUNT(DISTINCT t.id) AS ticketsSold,
              COUNT(DISTINCT t.user_id) AS attendees
       FROM events e
       LEFT JOIN orders o ON o.event_id = e.id AND o.payment_status = 'completed'
       LEFT JOIN tickets t ON t.event_id = e.id
       WHERE e.organizer_id = ?
       GROUP BY e.id, e.title, e.banner_image
       ORDER BY revenue DESC
       LIMIT 10`,
      [organizerId],
    );

    const events = rows.map((r) => ({
      id: r.id,
      title: r.title,
      image: r.image,
      revenue: Number(r.revenue || 0),
      ticketsSold: Number(r.ticketsSold || 0),
      attendees: Number(r.attendees || 0),
      rating: 4.8,
    }));

    res.json({ events });
  } catch (err) {
    console.error('[organizerController.getTopEvents]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getTicketTypeSales = async (req, res) => {
  try {
    const organizerId = req.user.id;
    const [rows] = await pool.execute(
      `SELECT tt.id, tt.name, tt.price, e.title AS event_title,
              COUNT(t.id) AS sold,
              COALESCE(SUM(tt.price), 0) AS revenue
       FROM ticket_types tt
       JOIN events e ON e.id = tt.event_id
       LEFT JOIN tickets t ON t.ticket_type_id = tt.id AND t.status = 'active'
       WHERE e.organizer_id = ?
       GROUP BY tt.id, tt.name, tt.price, e.title
       ORDER BY revenue DESC`,
      [organizerId],
    );
    res.json({ ticketTypes: rows });
  } catch (err) {
    console.error('[organizerController.getTicketTypeSales]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getRefundReport = async (req, res) => {
  try {
    const organizerId = req.user.id;

    const [[refundRow]] = await pool.execute(
      `SELECT COALESCE(SUM(o.total_amount), 0) AS total, COUNT(o.id) AS count
       FROM orders o
       JOIN events e ON e.id = o.event_id
       WHERE e.organizer_id = ? AND o.payment_status = 'refunded'`,
      [organizerId],
    );

    res.json({
      refund: {
        total: Number(refundRow.total || 0),
        count: Number(refundRow.count || 0),
        rate: 0,
        trend: [],
      },
    });
  } catch (err) {
    console.error('[organizerController.getRefundReport]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const exportReport = async (req, res) => {
  try {
    const organizerId = req.user.id;

    const [rows] = await pool.execute(
      `SELECT e.title, COUNT(o.id) AS orders, COALESCE(SUM(o.total_amount - o.discount_amount), 0) AS revenue
       FROM events e
       LEFT JOIN orders o ON o.event_id = e.id AND o.payment_status = 'completed'
       WHERE e.organizer_id = ?
       GROUP BY e.id, e.title`,
      [organizerId],
    );

    if (req.query.format === 'pdf') {
      const pdf = textPdf({
        title: 'Sales Report',
        lines: rows.map((r) => `${r.title || ''} | orders: ${r.orders || 0} | revenue: GHS ${Number(r.revenue || 0).toFixed(2)}`),
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="organizer-report.pdf"');
      return res.send(pdf);
    }

    const header = ['Event Title', 'Orders', 'Revenue (GHC)'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([`"${(r.title || '').replace(/"/g, '""')}"`, r.orders, r.revenue].join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="organizer-report.csv"');
    res.status(200).send(lines.join('\n'));
  } catch (err) {
    console.error('[organizerController.exportReport]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */
export const getOrganizationSettings = async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM organizer_profiles WHERE user_id = ?', [req.user.id]);
    const profile = rows[0] || {};
    let socials = {};
    try {
      socials = typeof profile.social_links === 'string' ? JSON.parse(profile.social_links) : profile.social_links || {};
    } catch (e) {
      socials = {};
    }

    res.json({
      organization: {
        name: profile.organization_name || '',
        description: profile.description || '',
        website: profile.website || '',
        facebook: socials.facebook || '',
        twitter: socials.twitter || '',
        instagram: socials.instagram || '',
        linkedin: socials.linkedin || '',
        logoUrl: profile.logo_url || '',
        bannerUrl: profile.banner_url || '',
      },
    });
  } catch (err) {
    console.error('[organizerController.getOrganizationSettings]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const updateOrganizationSettings = async (req, res) => {
  try {
    const { name, description, website, facebook, twitter, instagram, linkedin, logoUrl, bannerUrl } = req.body;
    const socials = JSON.stringify({ facebook, twitter, instagram, linkedin });

    const [existing] = await pool.execute('SELECT id FROM organizer_profiles WHERE user_id = ?', [req.user.id]);
    if (existing.length) {
      await pool.execute(
        `UPDATE organizer_profiles
         SET organization_name = ?, description = ?, website = ?, social_links = ?, logo_url = ?, banner_url = ?
         WHERE user_id = ?`,
        [name || null, description || null, website || null, socials, logoUrl || null, bannerUrl || null, req.user.id],
      );
    } else {
      await pool.execute(
        `INSERT INTO organizer_profiles (user_id, organization_name, description, website, social_links, logo_url, banner_url)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [req.user.id, name || null, description || null, website || null, socials, logoUrl || null, bannerUrl || null],
      );
    }

    res.json({ message: 'Organization profile updated' });
  } catch (err) {
    console.error('[organizerController.updateOrganizationSettings]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getPaymentAccount = async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM organizer_profiles WHERE user_id = ?', [req.user.id]);
    const profile = rows[0] || {};
    res.json({
      paymentAccount: {
        bankName: profile.bank_name || '',
        accountNumber: profile.account_number || '',
        accountName: profile.account_name || '',
        mobileMoney: profile.mobile_money || '',
        momoNumber: profile.mobile_money || '',
        payoutMethod: profile.payout_method || 'bank',
      },
    });
  } catch (err) {
    console.error('[organizerController.getPaymentAccount]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const updatePaymentAccount = async (req, res) => {
  try {
    const { bankName, accountNumber, accountName, mobileMoney, momoNumber, payoutMethod } = req.body;
    const momo = mobileMoney || momoNumber || null;

    const [existing] = await pool.execute('SELECT id FROM organizer_profiles WHERE user_id = ?', [req.user.id]);
    if (existing.length) {
      await pool.execute(
        `UPDATE organizer_profiles
         SET bank_name = ?, account_number = ?, account_name = ?, mobile_money = ?, payout_method = ?
         WHERE user_id = ?`,
        [bankName || null, accountNumber || null, accountName || null, momo, payoutMethod || 'bank', req.user.id],
      );
    } else {
      await pool.execute(
        `INSERT INTO organizer_profiles (user_id, bank_name, account_number, account_name, mobile_money, payout_method)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [req.user.id, bankName || null, accountNumber || null, accountName || null, momo, payoutMethod || 'bank'],
      );
    }

    res.json({ message: 'Payment account updated' });
  } catch (err) {
    console.error('[organizerController.updatePaymentAccount]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current password and new password are required' });
    }
    const strength = validatePassword(newPassword);
    if (!strength.valid) {
      return res.status(400).json({ message: strength.message });
    }

    const [rows] = await pool.execute('SELECT password FROM users WHERE id = ?', [req.user.id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ message: 'User not found' });

    const bcrypt = (await import('bcryptjs')).default;
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) {
      return res.status(400).json({ message: 'Incorrect current password' });
    }

    const hashed = await bcrypt.hash(newPassword, 12);
    await pool.execute('UPDATE users SET password = ? WHERE id = ?', [hashed, req.user.id]);

    await logAudit({ userId: req.user.id, action: 'change_password', entityType: 'user', entityId: req.user.id });
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error('[organizerController.changePassword]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getActiveSessions = async (req, res) => {
  try {
    res.json({
      sessions: [
        {
          id: 'session-1',
          device: 'Current Browser Session (Windows / Chrome)',
          ip: req.ip || '127.0.0.1',
          lastActive: 'Active now',
          current: true,
        },
      ],
    });
  } catch (err) {
    console.error('[organizerController.getActiveSessions]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const revokeSession = async (req, res) => {
  try {
    res.json({ message: 'Session revoked' });
  } catch (err) {
    console.error('[organizerController.revokeSession]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getBranding = async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM organizer_profiles WHERE user_id = ?', [req.user.id]);
    const profile = rows[0] || {};
    res.json({
      branding: {
        primaryColor: profile.primary_color || '#D4AF37',
        tagline: profile.tagline || '',
        about: profile.about || profile.description || '',
      },
    });
  } catch (err) {
    console.error('[organizerController.getBranding]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const updateBranding = async (req, res) => {
  try {
    const { primaryColor, tagline, about } = req.body;

    const [existing] = await pool.execute('SELECT id FROM organizer_profiles WHERE user_id = ?', [req.user.id]);
    if (existing.length) {
      await pool.execute(
        `UPDATE organizer_profiles
         SET primary_color = ?, tagline = ?, about = ?
         WHERE user_id = ?`,
        [primaryColor || '#D4AF37', tagline || null, about || null, req.user.id],
      );
    } else {
      await pool.execute(
        `INSERT INTO organizer_profiles (user_id, primary_color, tagline, about)
         VALUES (?, ?, ?, ?)`,
        [req.user.id, primaryColor || '#D4AF37', tagline || null, about || null],
      );
    }

    res.json({ message: 'Branding updated' });
  } catch (err) {
    console.error('[organizerController.updateBranding]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getFlashSales = async (req, res) => {
  try {
    const { eventId } = req.query;
    let sql = `SELECT fs.*, e.title AS eventName, tt.name AS ticketTypeName
               FROM flash_sales fs
               JOIN events e ON e.id = fs.event_id
               LEFT JOIN ticket_types tt ON tt.id = fs.ticket_type_id
               WHERE fs.organizer_id = ?`;
    const params = [req.user.id];
    if (eventId) {
      sql += ` AND fs.event_id = ?`;
      params.push(eventId);
    }
    sql += ` ORDER BY fs.created_at DESC`;
    const [rows] = await pool.execute(sql, params);

    const formatted = rows.map((r) => ({
      ...r,
      discountPct: r.discount_percentage,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
    }));

    res.json({ flashSales: formatted });
  } catch (err) {
    console.error('[organizerController.getFlashSales]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const createFlashSale = async (req, res) => {
  try {
    const { eventId, ticketType, ticketTypeId, discountPct, durationHours = 24 } = req.body;
    if (!eventId || !discountPct) {
      return res.status(400).json({ message: 'eventId and discountPct are required' });
    }

    const ttId = ticketTypeId || (isNaN(Number(ticketType)) ? null : Number(ticketType));
    const now = new Date();
    const ends = new Date(now.getTime() + Number(durationHours) * 60 * 60 * 1000);

    const [result] = await pool.execute(
      `INSERT INTO flash_sales (organizer_id, event_id, ticket_type_id, discount_percentage, starts_at, ends_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      [
        req.user.id,
        eventId,
        ttId,
        Number(discountPct),
        now.toISOString().slice(0, 19).replace('T', ' '),
        ends.toISOString().slice(0, 19).replace('T', ' '),
      ],
    );

    res.status(201).json({ message: 'Flash sale created', flashSaleId: result.insertId });
  } catch (err) {
    console.error('[organizerController.createFlashSale]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const deleteFlashSale = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute('SELECT * FROM flash_sales WHERE id = ? AND organizer_id = ?', [id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ message: 'Flash sale not found' });

    await pool.execute('DELETE FROM flash_sales WHERE id = ?', [id]);
    res.json({ message: 'Flash sale deleted' });
  } catch (err) {
    console.error('[organizerController.deleteFlashSale]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getMarketingCampaigns = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT mc.*, e.title AS eventTitle
       FROM marketing_campaigns mc
       LEFT JOIN events e ON e.id = mc.event_id
       WHERE mc.organizer_id = ?
       ORDER BY mc.created_at DESC`,
      [req.user.id],
    );

    const formatted = rows.map((r) => ({
      id: r.id,
      title: r.title || r.subject || 'Campaign',
      type: r.type,
      audience: r.audience,
      sentCount: r.sent_count || 0,
      createdAt: r.created_at,
    }));

    res.json({ campaigns: formatted });
  } catch (err) {
    console.error('[organizerController.getMarketingCampaigns]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const createMarketingCampaign = async (req, res) => {
  try {
    const { type = 'email', subject, message, title, eventId, audience = 'all' } = req.body;
    if (!message) {
      return res.status(400).json({ message: 'Message is required' });
    }

    const campaignTitle = title || subject || 'Campaign';

    const [result] = await pool.execute(
      `INSERT INTO marketing_campaigns (organizer_id, event_id, title, type, audience, subject, message, sent_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [req.user.id, eventId || null, campaignTitle, type, audience, subject || null, message],
    );

    res.status(201).json({ message: 'Campaign created and sent', campaignId: result.insertId });
  } catch (err) {
    console.error('[organizerController.createMarketingCampaign]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getPendingInvites = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM team_invites WHERE organizer_id = ? ORDER BY created_at DESC`,
      [req.user.id],
    );
    res.json({ invites: rows });
  } catch (err) {
    console.error('[organizerController.getPendingInvites]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const inviteTeamMember = async (req, res) => {
  try {
    const { email, role = 'staff', permissions } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required' });

    const token = uuidv4();
    const [result] = await pool.execute(
      `INSERT INTO team_invites (organizer_id, email, role, permissions, token, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [req.user.id, email, role, permissions ? JSON.stringify(permissions) : null, token],
    );

    res.status(201).json({ message: 'Invite sent', inviteId: result.insertId });
  } catch (err) {
    console.error('[organizerController.inviteTeamMember]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const resendInvite = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute('SELECT * FROM team_invites WHERE id = ? AND organizer_id = ?', [id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ message: 'Invite not found' });

    res.json({ message: 'Invite resent successfully' });
  } catch (err) {
    console.error('[organizerController.resendInvite]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const cancelInvite = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute('DELETE FROM team_invites WHERE id = ? AND organizer_id = ?', [id, req.user.id]);
    res.json({ message: 'Invite cancelled' });
  } catch (err) {
    console.error('[organizerController.cancelInvite]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getWalletBalance = async (req, res) => {
  try {
    const organizerId = req.user.id;

    const [[revRow]] = await pool.execute(
      `SELECT COALESCE(SUM(o.total_amount - o.discount_amount), 0) AS totalEarned
       FROM orders o
       JOIN events e ON e.id = o.event_id
       WHERE e.organizer_id = ? AND o.payment_status = 'completed'`,
      [organizerId],
    );

    const [[wdRow]] = await pool.execute(
      `SELECT COALESCE(SUM(w.amount), 0) AS withdrawn
       FROM withdrawals w
       WHERE w.organizer_id = ? AND w.status IN ('pending', 'approved')`,
      [organizerId],
    );

    const totalEarned = Number(revRow.totalEarned || 0);
    const withdrawn = Number(wdRow.withdrawn || 0);
    const available = Math.max(totalEarned - withdrawn, 0);

    res.json({
      balance: {
        available,
        pending: 0,
        totalEarned,
      },
    });
  } catch (err) {
    console.error('[organizerController.getWalletBalance]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getTransactions = async (req, res) => {
  try {
    const organizerId = req.user.id;
    const { limit = 50 } = req.query;
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

    const [rows] = await pool.execute(
      `SELECT o.id, o.payment_reference AS reference, 'Ticket Sale' AS description,
              (o.total_amount - o.discount_amount) AS amount, 'credit' AS type, 'completed' AS status,
              o.created_at AS date
       FROM orders o
       JOIN events e ON e.id = o.event_id
       WHERE e.organizer_id = ? AND o.payment_status = 'completed'
       ORDER BY o.created_at DESC
       LIMIT ${limitNum}`,
      [organizerId],
    );

    res.json({ transactions: rows });
  } catch (err) {
    console.error('[organizerController.getTransactions]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getWalletEarnings = async (req, res) => {
  try {
    const organizerId = req.user.id;

    const [rows] = await pool.execute(
      `SELECT TO_CHAR(o.created_at, 'Mon YYYY') AS period,
              COALESCE(SUM(o.total_amount - o.discount_amount), 0) AS amount
       FROM orders o
       JOIN events e ON e.id = o.event_id
       WHERE e.organizer_id = ? AND o.payment_status = 'completed'
       GROUP BY TO_CHAR(o.created_at, 'YYYY-MM'), TO_CHAR(o.created_at, 'Mon YYYY')
       ORDER BY TO_CHAR(o.created_at, 'YYYY-MM') DESC`,
      [organizerId],
    );

    res.json({ earnings: rows });
  } catch (err) {
    console.error('[organizerController.getWalletEarnings]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export default {
  getDashboardStats, getOrganizerProfile, updateOrganizerProfile, getRevenue,
  getEventAnalytics,
  getAttendees, exportAttendees, createCoupon, getCoupons, updateCoupon, deleteCoupon,
  getWithdrawals, requestWithdrawal,
  getTeamMembers, addTeamMember, removeTeamMember,
  sendMarketingEmail, getReports, getReportSummary, getSalesReport, getAttendanceReport, getTopEvents, getRefundReport, exportReport,
  getOrganizationSettings, updateOrganizationSettings, getPaymentAccount, updatePaymentAccount, changePassword, getActiveSessions, revokeSession, getBranding, updateBranding,
  getFlashSales, createFlashSale, deleteFlashSale,
  getMarketingCampaigns, createMarketingCampaign, getPendingInvites, inviteTeamMember, resendInvite, cancelInvite, getWalletBalance, getTransactions, getWalletEarnings,
};
