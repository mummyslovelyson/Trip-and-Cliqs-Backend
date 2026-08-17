import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import pool from '../config/db.js';
import { sendNotification, sendNotificationToMany } from '../utils/notify.js';
import {
  sendOrganizerApprovalEmail, sendEventApprovalEmail, sendEventRejectionEmail,
} from '../utils/email.js';
import { logAudit } from '../utils/audit.js';
import { validatePassword } from '../utils/password.js';

/* ------------------------------------------------------------------ */
/* Dashboard stats                                                     */
/* ------------------------------------------------------------------ */
const fillDailySeries = (rows, days, { revenue = false, attendees = false, organizers = false, orders = false }) => {
  const byDate = new Map(rows.map((r) => [String(r.date), r]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const row = byDate.get(key) || {};
    out.push({
      date: key,
      ...(revenue && { revenue: Number(row.revenue) || 0 }),
      ...(orders && { orders: Number(row.orders) || 0 }),
      ...(attendees && { attendees: Number(row.attendees) || 0 }),
      ...(organizers && { organizers: Number(row.organizers) || 0 }),
    });
  }
  return out;
};

const sumRange = (series, startIdx, endIdx) =>
  series.slice(startIdx, endIdx).reduce((acc, s) => acc + (Number(s.revenue) || 0), 0);

export const getDashboardStats = async (_req, res) => {
  try {
    const [[usersRow]] = await pool.execute(`SELECT COUNT(*) AS total FROM users`);
    const [[organizersRow]] = await pool.execute(`SELECT COUNT(*) AS total FROM users WHERE role = 'organizer'`);
    const [[eventsRow]] = await pool.execute(`SELECT COUNT(*) AS total FROM events`);
    const [[ordersRow]] = await pool.execute(
      `SELECT COUNT(*) AS total, COALESCE(SUM(total_amount),0) AS revenue FROM orders WHERE payment_status = 'completed'`,
    );
    const [[ticketsRow]] = await pool.execute(`SELECT COUNT(*) AS total FROM tickets`);
    const [[ticketsTodayRow]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM tickets WHERE DATE(created_at) = CURDATE()`,
    );
    const [[pendingOrgsRow]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM users WHERE role = 'organizer' AND is_approved = 0 AND status = 'active'`,
    );
    const [[pendingWithdrawalsRow]] = await pool.execute(`SELECT COUNT(*) AS total FROM withdrawals WHERE status = 'pending'`);
    const [[pendingEventsRow]] = await pool.execute(`SELECT COUNT(*) AS total FROM events WHERE status = 'pending'`);

    // Last 30 days of completed orders (revenue + volume).
    const [dailyRevenue] = await pool.execute(
      `SELECT DATE(created_at) AS date, COALESCE(SUM(total_amount),0) AS revenue, COUNT(*) AS orders
       FROM orders WHERE payment_status = 'completed'
         AND created_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
       GROUP BY DATE(created_at) ORDER BY date ASC`,
    );
    const revenueSeries = fillDailySeries(dailyRevenue, 30, { revenue: true, orders: true });

    // Last 14 days of new signups, split by role.
    const [dailySignups] = await pool.execute(
      `SELECT DATE(created_at) AS date,
              SUM(CASE WHEN role = 'attendee' THEN 1 ELSE 0 END) AS attendees,
              SUM(CASE WHEN role = 'organizer' THEN 1 ELSE 0 END) AS organizers
       FROM users WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
       GROUP BY DATE(created_at) ORDER BY date ASC`,
    );
    const growthSeries = fillDailySeries(dailySignups, 14, { attendees: true, organizers: true });

    const last7 = sumRange(revenueSeries, revenueSeries.length - 7, revenueSeries.length);
    const prev7 = sumRange(revenueSeries, revenueSeries.length - 14, revenueSeries.length - 7);
    const revenueTrend = prev7 > 0 ? ((last7 - prev7) / prev7) * 100 : null;

    const [pendingEvents] = await pool.execute(
      `SELECT e.id, e.title, e.category, e.start_date, e.banner_image AS thumbnail, e.created_at,
              u.name AS organizer_name
       FROM events e JOIN users u ON u.id = e.organizer_id
       WHERE e.status = 'pending'
       ORDER BY e.created_at DESC LIMIT 8`,
    );

    const [recentEvents] = await pool.execute(
      `SELECT e.id, e.title, e.category, e.status, e.start_date, e.created_at,
              u.name AS organizer_name
       FROM events e JOIN users u ON u.id = e.organizer_id
       ORDER BY e.created_at DESC LIMIT 6`,
    );

    const [recentUsers] = await pool.execute(
      `SELECT id, name, email, role, status, created_at FROM users ORDER BY created_at DESC LIMIT 6`,
    );

    const activity = [
      ...recentUsers.map((u) => ({
        type: 'user',
        label: `${u.name} joined as ${u.role}`,
        role: u.role,
        time: u.created_at,
      })),
      ...recentEvents.map((e) => ({
        type: 'event',
        label: `${e.title}`,
        organizer: e.organizer_name,
        time: e.created_at,
      })),
    ].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 10);

    res.json({
      overview: {
        totalUsers: usersRow.total,
        totalOrganizers: organizersRow.total,
        totalEvents: eventsRow.total,
        totalOrders: ordersRow.total,
        totalRevenue: Number(ordersRow.revenue),
        ticketsSold: ticketsRow.total,
        ticketsSoldToday: ticketsTodayRow.total,
        pendingOrganizers: pendingOrgsRow.total,
        pendingWithdrawals: pendingWithdrawalsRow.total,
        pendingEvents: pendingEventsRow.total,
        revenueTrend,
        last7Revenue: last7,
      },
      revenueSeries,
      growthSeries,
      pendingEvents,
      recentEvents,
      recentUsers,
      activity,
    });
  } catch (err) {
    console.error('[adminController.getDashboardStats]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */
const userSortClause = (sort) => {
  if (sort === 'oldest') return 'ORDER BY u.created_at ASC';
  if (sort === 'name') return 'ORDER BY u.name ASC';
  return 'ORDER BY u.created_at DESC';
};

export const getUsers = async (req, res) => {
  try {
    const { role, status, search, sort, page = 1, limit = 20 } = req.query;
    const conditions = [];
    const params = [];

    if (role && role !== 'all') {
      conditions.push('u.role = ?');
      params.push(role);
    }

    if (status && status !== 'all') {
      if (status === 'pending') {
        // Only organizer applicants awaiting review. Attendees never go
        // through approval, so they must not appear as "pending".
        conditions.push('u.role = "organizer" AND u.is_approved = 0 AND u.status = "active"');
      } else if (status === 'active') {
        conditions.push('u.status = "active"');
      } else if (status === 'approved') {
        // Only organizers that passed review. Admins never appear here.
        conditions.push('u.role = "organizer" AND u.is_approved = 1 AND u.status = "active"');
      } else if (status === 'suspended' || status === 'rejected') {
        conditions.push(`u.status = "${status}"`);
      }
    }

    if (search) {
      conditions.push('(u.name LIKE ? OR u.email LIKE ? OR op.organization_name LIKE ?)');
      const q = `%${search}%`;
      params.push(q, q, q);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const offset = (pageNum - 1) * limitNum;

    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS total FROM users u LEFT JOIN organizer_profiles op ON op.user_id = u.id ${where}`,
      params,
    );
    const [rows] = await pool.execute(
      `SELECT u.id, u.name, u.email, u.role, u.phone, u.status, u.is_approved, u.email_verified,
              u.suspend_reason, u.suspended_at,
              COALESCE(u.avatar_url, u.avatar) AS avatar, u.created_at,
              (SELECT COUNT(*) FROM events e WHERE e.organizer_id = u.id) AS events_count,
              (SELECT COUNT(*) FROM tickets t WHERE t.user_id = u.id) AS tickets_count,
              op.organization_name, op.description AS org_description, op.website, op.logo_url, op.is_verified AS org_is_verified
       FROM users u
       LEFT JOIN organizer_profiles op ON op.user_id = u.id
       ${where}
       ${userSortClause(sort)}
       LIMIT ${limitNum} OFFSET ${offset}`,
      params,
    );

    const formattedUsers = rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      phone: u.phone,
      status: u.status,
      is_approved: u.is_approved,
      email_verified: u.email_verified,
      avatar: u.avatar,
      createdAt: u.created_at,
      eventsCount: Number(u.events_count) || 0,
      ticketsCount: Number(u.tickets_count) || 0,
      isSuspended: u.status === 'suspended',
      suspendReason: u.suspend_reason || null,
      suspendedAt: u.suspended_at || null,
      organizationName: u.organization_name || u.name,
      organization: {
        name: u.organization_name || u.name,
        description: u.org_description,
        website: u.website,
        logoUrl: u.logo_url,
        isVerified: !!u.org_is_verified,
      },
    }));

    res.json({
      users: formattedUsers,
      pagination: { page: pageNum, limit: limitNum, total: countRows[0].total, totalPages: Math.ceil(countRows[0].total / limitNum) },
    });
  } catch (err) {
    console.error('[adminController.getUsers]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getUser = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute(
      `SELECT u.*, op.organization_name, op.description AS org_description, op.website, op.logo_url, op.banner_url, op.is_verified AS org_is_verified,
              (SELECT COUNT(*) FROM events e WHERE e.organizer_id = u.id) AS events_count,
              (SELECT COUNT(*) FROM tickets t WHERE t.user_id = u.id) AS tickets_count
       FROM users u
       LEFT JOIN organizer_profiles op ON op.user_id = u.id
       WHERE u.id = ?`,
      [id],
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ message: 'User not found' });
    const { password, reset_token, reset_expires, ...safe } = user;
    res.json({
      user: {
        ...safe,
        // The stored credential is an irreversible bcrypt hash — the plaintext
        // password is never kept, so this is the only view an admin can get.
        passwordHash: password || null,
        createdAt: safe.created_at,
        updatedAt: safe.updated_at,
        lastLoginAt: safe.last_login_at,
        emailVerified: safe.email_verified === 1 || safe.email_verified === true,
        isApproved: safe.is_approved === 1 || safe.is_approved === true,
        eventsCount: Number(safe.events_count) || 0,
        ticketsCount: Number(safe.tickets_count) || 0,
        isSuspended: safe.status === 'suspended',
        suspendReason: safe.suspend_reason || null,
        suspendedAt: safe.suspended_at || null,
        organizationName: safe.organization_name || safe.name,
        organization: {
          name: safe.organization_name || safe.name,
          description: safe.org_description,
          website: safe.website,
          logoUrl: safe.logo_url,
          bannerUrl: safe.banner_url,
          isVerified: !!safe.org_is_verified,
        },
      },
    });
  } catch (err) {
    console.error('[adminController.getUser]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const rejectOrganizer = async (req, res) => {
  try {
    const { id } = req.params;
    const { rejectionReason, reason } = req.body || {};
    const rReason = rejectionReason || reason || 'Application did not meet requirements.';

    const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.role !== 'organizer') return res.status(400).json({ message: 'Only organizer accounts can be rejected' });

    await pool.execute(`UPDATE users SET is_approved = 0, status = 'rejected' WHERE id = ?`, [id]);
    await pool.execute(`UPDATE organizer_profiles SET is_verified = 0 WHERE user_id = ?`, [id]);

    await sendNotification({
      userId: Number(id),
      title: 'Organizer application update',
      message: `Your organizer application was not approved. Reason: ${rReason}`,
      type: 'account',
    });

    await logAudit({ userId: req.user.id, action: 'reject_organizer', entityType: 'user', entityId: Number(id), details: { reason: rReason } });
    res.json({ message: 'Organizer application rejected' });
  } catch (err) {
    console.error('[adminController.rejectOrganizer]', err);
    res.status(500).json({ message: 'Server error rejecting organizer' });
  }
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const updateUser = async (req, res) => {
  try {
    const { id } = req.params;

    // Approve / reject shortcuts used by moderation flows.
    if (req.body.isRejected || req.body.status === 'rejected') {
      return rejectOrganizer(req, res);
    }
    if (req.body.is_approved === 1 || req.body.isApproved === true) {
      return approveOrganizer(req, res);
    }

    const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [id]);
    const target = rows[0];
    if (!target) return res.status(404).json({ message: 'User not found' });

    const allowed = ['name', 'email', 'role', 'phone', 'status', 'is_approved'];
    const fields = [];
    const values = [];
    const changed = {};

    // Admin accounts are protected: they cannot be demoted, suspended, or
    // de-approved through this endpoint (use the audit-safe paths elsewhere).
    const touchesPrivilege = ['role', 'status', 'is_approved'].some((k) => req.body[k] !== undefined);
    if (target.role === 'admin' && touchesPrivilege) {
      return res.status(400).json({ message: 'Admin accounts cannot be modified' });
    }

    for (const key of allowed) {
      if (req.body[key] === undefined) continue;
      let value = req.body[key];
      if (key === 'role') {
        // Role promotion to admin is only possible through the seed/CLI —
        // never through the admin panel.
        if (!['attendee', 'organizer'].includes(value)) {
          return res.status(400).json({ message: 'Role must be attendee or organizer' });
        }
      }
      if (key === 'email' && typeof value === 'string' && !EMAIL_RE.test(value.trim())) {
        return res.status(400).json({ message: 'Invalid email address' });
      }
      if (key === 'email') value = value.trim();
      fields.push(`${key} = ?`);
      values.push(value);
      changed[key] = value;
    }

    if (!fields.length) return res.status(400).json({ message: 'No fields to update' });
    values.push(id);
    await pool.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);

    // Promoting someone to organizer: make sure they have a profile row so
    // the organizer dashboard and approval flow work immediately.
    if (changed.role === 'organizer') {
      const [existing] = await pool.execute('SELECT id FROM organizer_profiles WHERE user_id = ?', [id]);
      if (!existing.length) {
        await pool.execute(
          'INSERT INTO organizer_profiles (user_id, organization_name) VALUES (?, ?)',
          [Number(id), changed.name || target.name],
        );
      }
    }

    await logAudit({
      userId: req.user.id,
      action: 'admin_update_user',
      entityType: 'user',
      entityId: Number(id),
      details: { changed },
    });
    res.json({ message: 'User updated' });
  } catch (err) {
    console.error('[adminController.updateUser]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const suspendUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    const suspendReason = (reason || 'Violation of platform policy').toString().trim().slice(0, 500);

    const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.role === 'admin') return res.status(400).json({ message: 'Admin accounts cannot be suspended' });
    if (user.status === 'suspended') return res.status(400).json({ message: 'User is already suspended' });

    await pool.execute(
      `UPDATE users SET status = 'suspended', suspend_reason = ?, suspended_at = NOW() WHERE id = ?`,
      [suspendReason, id],
    );
    await sendNotification({
      userId: Number(id),
      title: 'Account suspended',
      message: `Your account has been suspended. Reason: ${suspendReason}`, // eslint-disable-line max-len
      type: 'account',
    });
    await logAudit({ userId: req.user.id, action: 'suspend_user', entityType: 'user', entityId: Number(id), details: { reason: suspendReason } });
    res.json({ message: 'User suspended' });
  } catch (err) {
    console.error('[adminController.suspendUser]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Approve organizer                                                   */
/* ------------------------------------------------------------------ */
export const approveOrganizer = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ message: 'Organizer not found' });
    if (user.role !== 'organizer') return res.status(400).json({ message: 'Only organizer accounts can be approved' });

    await pool.execute(`UPDATE users SET is_approved = 1, status = 'active' WHERE id = ?`, [id]);
    await pool.execute(`UPDATE organizer_profiles SET is_verified = 1, approved_at = NOW() WHERE user_id = ?`, [id]);

    try {
      sendOrganizerApprovalEmail(user.email, user.name);
    } catch (e) {
      /* ignore if email provider unconfigured */
    }

    sendNotification({ userId: Number(id), title: 'Organizer account approved', message: 'You can now create and publish events.', type: 'account' });

    await logAudit({ userId: req.user.id, action: 'approve_organizer', entityType: 'user', entityId: Number(id) });
    res.json({ message: 'Organizer approved' });
  } catch (err) {
    console.error('[adminController.approveOrganizer]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Events (admin)                                                      */
/* ------------------------------------------------------------------ */
export const getEvents = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const conditions = [];
    const params = [];
    if (status && status !== 'all') { conditions.push('e.status = ?'); params.push(status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const offset = (pageNum - 1) * limitNum;

    const [countRows] = await pool.execute(`SELECT COUNT(*) AS total FROM events e ${where}`, params);
    const [rows] = await pool.execute(
      `SELECT e.*, u.name AS organizer_name
       FROM events e JOIN users u ON u.id = e.organizer_id
       ${where}
       ORDER BY e.created_at DESC
       LIMIT ${limitNum} OFFSET ${offset}`,
      params,
    );

    res.json({
      events: rows,
      pagination: { page: pageNum, limit: limitNum, total: countRows[0].total, totalPages: Math.ceil(countRows[0].total / limitNum) },
    });
  } catch (err) {
    console.error('[adminController.getEvents]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const approveEvent = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute(
      `UPDATE events SET status = 'published', approval_status = 'approved' WHERE id = ?`,
      [id],
    );
    const [rows] = await pool.execute(
      `SELECT e.organizer_id, e.title, u.email
       FROM events e JOIN users u ON u.id = e.organizer_id
       WHERE e.id = ?`,
      [id],
    );
    if (rows[0]) {
      sendNotification({
        userId: rows[0].organizer_id,
        title: 'Event approved',
        message: `Your event "${rows[0].title}" has been approved and is now live.`,
        type: 'event',
      });
      if (rows[0].email) {
        sendEventApprovalEmail(rows[0].email, { id, title: rows[0].title }).catch(() => {});
      }
    }
    await logAudit({ userId: req.user.id, action: 'approve_event', entityType: 'event', entityId: Number(id) });
    res.json({ message: 'Event approved and published' });
  } catch (err) {
    console.error('[adminController.approveEvent]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Suspend / restore an event                                          */
/* Suspending takes a live (published) event offline: it disappears
 * from public listings and can no longer be booked, without deleting it.
 * Restoring puts it back to published.                              */
/* ------------------------------------------------------------------ */
export const suspendEvent = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute('SELECT organizer_id, title, status FROM events WHERE id = ?', [id]);
    const event = rows[0];
    if (!event) return res.status(404).json({ message: 'Event not found' });

    if (event.status !== 'published') {
      return res.status(400).json({ message: 'Only published events can be suspended' });
    }

    await pool.execute(`UPDATE events SET status = 'suspended' WHERE id = ?`, [id]);
    sendNotification({
      userId: event.organizer_id,
      title: 'Event suspended',
      message: `Your event "${event.title}" has been suspended and is no longer visible or bookable. Contact support for details.`,
      type: 'event',
    });
    await logAudit({
      userId: req.user.id,
      action: 'suspend_event',
      entityType: 'event',
      entityId: Number(id),
      details: { title: event.title },
    });

    res.json({ message: 'Event suspended' });
  } catch (err) {
    console.error('[adminController.suspendEvent]', err);
    res.status(500).json({ message: 'Server error suspending event' });
  }
};

export const unsuspendEvent = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute('SELECT organizer_id, title, status FROM events WHERE id = ?', [id]);
    const event = rows[0];
    if (!event) return res.status(404).json({ message: 'Event not found' });

    if (event.status !== 'suspended') {
      return res.status(400).json({ message: 'Only suspended events can be restored' });
    }

    await pool.execute(`UPDATE events SET status = 'published' WHERE id = ?`, [id]);
    sendNotification({
      userId: event.organizer_id,
      title: 'Event restored',
      message: `Your event "${event.title}" has been restored and is live again.`,
      type: 'event',
    });
    await logAudit({
      userId: req.user.id,
      action: 'unsuspend_event',
      entityType: 'event',
      entityId: Number(id),
      details: { title: event.title },
    });

    res.json({ message: 'Event restored' });
  } catch (err) {
    console.error('[adminController.unsuspendEvent]', err);
    res.status(500).json({ message: 'Server error restoring event' });
  }
};

/* ------------------------------------------------------------------ */
/* Feature / unfeature an event (homepage spotlight)                   */
/* ------------------------------------------------------------------ */
export const featureEvent = async (req, res) => {
  try {
    const { id } = req.params;
    const featured = req.body.featured === true || req.body.featured === 1 || req.body.featured === '1';
    const [rows] = await pool.execute('SELECT id, title, status FROM events WHERE id = ?', [id]);
    const event = rows[0];
    if (!event) return res.status(404).json({ message: 'Event not found' });

    await pool.execute('UPDATE events SET is_featured = ? WHERE id = ?', [featured ? 1 : 0, id]);
    await logAudit({
      userId: req.user.id,
      action: featured ? 'feature_event' : 'unfeature_event',
      entityType: 'event',
      entityId: Number(id),
      details: { title: event.title, status: event.status, is_featured: featured },
    });

    res.json({ message: featured ? 'Event featured' : 'Event unfeatured', is_featured: featured });
  } catch (err) {
    console.error('[adminController.featureEvent]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const rejectEvent = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    await pool.execute(
      `UPDATE events SET status = 'rejected', approval_status = 'rejected' WHERE id = ?`,
      [id],
    );
    const [rows] = await pool.execute(
      `SELECT e.organizer_id, e.title, u.email
       FROM events e JOIN users u ON u.id = e.organizer_id
       WHERE e.id = ?`,
      [id],
    );
    if (rows[0]) {
      sendNotification({
        userId: rows[0].organizer_id,
        title: 'Event rejected',
        message: `Your event "${rows[0].title}" was rejected. Reason: ${reason || 'not specified'}`,
        type: 'event',
      });
      if (rows[0].email) {
        sendEventRejectionEmail(rows[0].email, { id, title: rows[0].title }, reason).catch(() => {});
      }
    }
    await logAudit({ userId: req.user.id, action: 'reject_event', entityType: 'event', entityId: Number(id), details: { reason } });
    res.json({ message: 'Event rejected' });
  } catch (err) {
    console.error('[adminController.rejectEvent]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Categories                                                           */
/* ------------------------------------------------------------------ */
export const getCategories = async (_req, res) => {
  try {
    const [rows] = await pool.execute(`SELECT * FROM categories ORDER BY name ASC`);
    res.json({ categories: rows });
  } catch (err) {
    console.error('[adminController.getCategories]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const createCategory = async (req, res) => {
  try {
    const { name, slug, icon } = req.body;
    if (!name) return res.status(400).json({ message: 'name is required' });
    const finalSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const [result] = await pool.execute(
      `INSERT INTO categories (name, slug, icon, is_active) VALUES (?, ?, ?, 1)`,
      [name, finalSlug, icon || null],
    );
    res.status(201).json({ message: 'Category created', categoryId: result.insertId });
  } catch (err) {
    console.error('[adminController.createCategory]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = ['name', 'slug', 'icon', 'is_active'];
    const fields = [];
    const values = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) { fields.push(`${key} = ?`); values.push(req.body[key]); }
    }
    if (!fields.length) return res.status(400).json({ message: 'No fields to update' });
    values.push(id);
    await pool.execute(`UPDATE categories SET ${fields.join(', ')} WHERE id = ?`, values);
    res.json({ message: 'Category updated' });
  } catch (err) {
    console.error('[adminController.updateCategory]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute(`DELETE FROM categories WHERE id = ?`, [id]);
    res.json({ message: 'Category deleted' });
  } catch (err) {
    console.error('[adminController.deleteCategory]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Payments                                                            */
/* ------------------------------------------------------------------ */
export const getPayments = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const conditions = [];
    const params = [];
    if (status && status !== 'all') { conditions.push('o.payment_status = ?'); params.push(status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const offset = (pageNum - 1) * limitNum;

    const [countRows] = await pool.execute(`SELECT COUNT(*) AS total FROM orders o ${where}`, params);
    const [rows] = await pool.execute(
      `SELECT o.*, e.title AS event_title, u.name AS buyer_name, u.email AS buyer_email
       FROM orders o
       JOIN events e ON e.id = o.event_id
       JOIN users u ON u.id = o.user_id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT ${limitNum} OFFSET ${offset}`,
      params,
    );

    res.json({
      payments: rows,
      pagination: { page: pageNum, limit: limitNum, total: countRows[0].total, totalPages: Math.ceil(countRows[0].total / limitNum) },
    });
  } catch (err) {
    console.error('[adminController.getPayments]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Withdrawals (admin)                                                 */
/* ------------------------------------------------------------------ */
export const getWithdrawals = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const conditions = [];
    const params = [];
    if (status && status !== 'all') { conditions.push('w.status = ?'); params.push(status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const offset = (pageNum - 1) * limitNum;

    const [countRows] = await pool.execute(`SELECT COUNT(*) AS total FROM withdrawals w ${where}`, params);
    const [rows] = await pool.execute(
      `SELECT w.*, u.name AS organizer_name, u.email AS organizer_email
       FROM withdrawals w
       JOIN users u ON u.id = w.organizer_id
       ${where}
       ORDER BY w.created_at DESC
       LIMIT ${limitNum} OFFSET ${offset}`,
      params,
    );

    res.json({
      withdrawals: rows,
      pagination: { page: pageNum, limit: limitNum, total: countRows[0].total, totalPages: Math.ceil(countRows[0].total / limitNum) },
    });
  } catch (err) {
    console.error('[adminController.getWithdrawals]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const approveWithdrawal = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute(`UPDATE withdrawals SET status = 'approved', processed_at = NOW() WHERE id = ?`, [id]);
    const [rows] = await pool.execute('SELECT organizer_id, amount FROM withdrawals WHERE id = ?', [id]);
    if (rows[0]) {
      sendNotification({
        userId: rows[0].organizer_id,
        title: 'Withdrawal approved',
        message: `Your withdrawal request of ${rows[0].amount} has been approved and processed.`,
        type: 'withdrawal',
      });
    }
    await logAudit({ userId: req.user.id, action: 'approve_withdrawal', entityType: 'withdrawal', entityId: Number(id) });
    res.json({ message: 'Withdrawal approved' });
  } catch (err) {
    console.error('[adminController.approveWithdrawal]', err);
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
    const params = [];
    if (from && to) { dateFilter = `AND o.created_at BETWEEN ? AND ?`; params.push(from, to); }

    const [[totals]] = await pool.execute(
      `SELECT COUNT(*) AS orders,
              COALESCE(SUM(o.total_amount),0) AS gross,
              COALESCE(SUM(o.discount_amount),0) AS discounts
       FROM orders o WHERE o.payment_status = 'completed' ${dateFilter}`,
      params,
    );

    const [byCategory] = await pool.execute(
      `SELECT e.category, COUNT(o.id) AS orders, COALESCE(SUM(o.total_amount - o.discount_amount),0) AS revenue
       FROM orders o
       JOIN events e ON e.id = o.event_id
       WHERE o.payment_status = 'completed' ${dateFilter}
       GROUP BY e.category
       ORDER BY revenue DESC`,
      params,
    );

    const [topOrganizers] = await pool.execute(
      `SELECT u.id, u.name, COUNT(e.id) AS events, COALESCE(SUM(o.total_amount - o.discount_amount),0) AS revenue
       FROM users u
       JOIN events e ON e.organizer_id = u.id
       LEFT JOIN orders o ON o.event_id = e.id AND o.payment_status = 'completed' ${dateFilter}
       WHERE u.role = 'organizer'
       GROUP BY u.id
       ORDER BY revenue DESC
       LIMIT 10`,
      params,
    );

    res.json({ totals, byCategory, topOrganizers });
  } catch (err) {
    console.error('[adminController.getReports]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Support tickets                                                     */
/* ------------------------------------------------------------------ */
export const getSupportTickets = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const conditions = [];
    const params = [];
    if (status && status !== 'all') { conditions.push('s.status = ?'); params.push(status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const offset = (pageNum - 1) * limitNum;

    const [countRows] = await pool.execute(`SELECT COUNT(*) AS total FROM support_tickets s ${where}`, params);
    const [rows] = await pool.execute(
      `SELECT s.*, u.name AS user_name, u.email AS user_email
       FROM support_tickets s
       JOIN users u ON u.id = s.user_id
       ${where}
       ORDER BY s.created_at DESC
       LIMIT ${limitNum} OFFSET ${offset}`,
      params,
    );

    res.json({
      tickets: rows.map((r) => ({ ...r, user: { name: r.user_name, email: r.user_email } })),
      pagination: { page: pageNum, limit: limitNum, total: countRows[0].total, totalPages: Math.ceil(countRows[0].total / limitNum) },
    });
  } catch (err) {
    console.error('[adminController.getSupportTickets]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const resolveSupportTicket = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute(`UPDATE support_tickets SET status = 'resolved' WHERE id = ?`, [id]);
    const [rows] = await pool.execute('SELECT user_id FROM support_tickets WHERE id = ?', [id]);
    if (rows[0]) {
      sendNotification({ userId: rows[0].user_id, title: 'Support ticket resolved', message: 'Your support ticket has been marked as resolved.', type: 'support' });
    }
    await logAudit({ userId: req.user.id, action: 'resolve_support_ticket', entityType: 'support_ticket', entityId: Number(id) });
    res.json({ message: 'Support ticket resolved' });
  } catch (err) {
    console.error('[adminController.resolveSupportTicket]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Announcements                                                       */
/* ------------------------------------------------------------------ */
export const sendAnnouncement = async (req, res) => {
  try {
    const { title, message, target_role = 'all' } = req.body;
    if (!title || !message) return res.status(400).json({ message: 'title and message are required' });

    const [result] = await pool.execute(
      `INSERT INTO announcements (title, message, target_role, created_by) VALUES (?, ?, ?, ?)`,
      [title, message, target_role, req.user.id],
    );

    // Notify matching users.
    let userIds = [];
    if (target_role === 'all') {
      const [rows] = await pool.execute(`SELECT id FROM users WHERE status = 'active'`);
      userIds = rows.map((r) => r.id);
    } else {
      const [rows] = await pool.execute(`SELECT id FROM users WHERE status = 'active' AND role = ?`, [target_role]);
      userIds = rows.map((r) => r.id);
    }
    await sendNotificationToMany(userIds, { title, message, type: 'announcement' });

    await logAudit({ userId: req.user.id, action: 'send_announcement', entityType: 'announcement', entityId: result.insertId });
    res.status(201).json({ message: 'Announcement sent', announcementId: result.insertId, recipients: userIds.length });
  } catch (err) {
    console.error('[adminController.sendAnnouncement]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Audit logs                                                          */
/* ------------------------------------------------------------------ */
export const getAuditLogs = async (req, res) => {
  try {
    const { action, page = 1, limit = 50 } = req.query;
    const conditions = [];
    const params = [];
    if (action) { conditions.push('a.action = ?'); params.push(action); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const offset = (pageNum - 1) * limitNum;

    const [countRows] = await pool.execute(`SELECT COUNT(*) AS total FROM audit_logs a ${where}`, params);
    const [rows] = await pool.execute(
      `SELECT a.*, u.name AS user_name, u.email AS user_email
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       ${where}
       ORDER BY a.created_at DESC
       LIMIT ${limitNum} OFFSET ${offset}`,
      params,
    );

    res.json({
      logs: rows,
      pagination: { page: pageNum, limit: limitNum, total: countRows[0].total, totalPages: Math.ceil(countRows[0].total / limitNum) },
    });
  } catch (err) {
    console.error('[adminController.getAuditLogs]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* System settings                                                     */
/* ------------------------------------------------------------------ */
// System settings are stored in a simple key/value table created on demand.
// For this build we persist them in the audit-friendly `categories`-style
// approach: a dedicated settings table is created lazily here.

const ensureSettingsTable = async () => {
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS system_settings (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      setting_key VARCHAR(120) NOT NULL,
      setting_value TEXT,
      updated_by BIGINT UNSIGNED DEFAULT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_settings_key (setting_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
};

export const getSystemSettings = async (_req, res) => {
  try {
    await ensureSettingsTable();
    const [rows] = await pool.execute(`SELECT setting_key, setting_value, updated_at FROM system_settings`);
    const settings = {};
    for (const r of rows) settings[r.setting_key] = r.setting_value;
    res.json({ settings });
  } catch (err) {
    console.error('[adminController.getSystemSettings]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const updateSystemSettings = async (req, res) => {
  try {
    await ensureSettingsTable();
    const entries = Object.entries(req.body?.settings || req.body || {});
    if (!entries.length) return res.status(400).json({ message: 'No settings provided' });

    for (const [key, value] of entries) {
      // `updated_by` is deliberately omitted from the INSERT: the table created
      // by schema.sql predates that column, and referencing it makes saves 500
      // on existing installs. The column is still migrated in for new installs.
      await pool.execute(
        `INSERT INTO system_settings (setting_key, setting_value)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [key, String(value)],
      );
    }

    await logAudit({ userId: req.user.id, action: 'update_system_settings', entityType: 'system', details: { keys: entries.map((e) => e[0]) } });
    res.json({ message: 'Settings updated' });
  } catch (err) {
    console.error('[adminController.updateSystemSettings]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* CMS Content                                                         */
/* ------------------------------------------------------------------ */
export const getContentPages = async (_req, res) => {
  try {
    const [banners] = await pool.execute(`SELECT * FROM banners ORDER BY sort_order ASC`);
    const [faqs] = await pool.execute(`SELECT * FROM faqs ORDER BY sort_order ASC`);
    const [blogPosts] = await pool.execute(`SELECT * FROM blog_posts ORDER BY created_at DESC`);
    res.json({ banners, faqs, blogPosts, pages: [] });
  } catch (err) {
    console.error('[adminController.getContentPages]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const createContentPage = async (_req, res) => {
  res.json({ message: 'Content created' });
};

export const updateContentPage = async (_req, res) => {
  res.json({ message: 'Content updated' });
};

export const deleteContentPage = async (_req, res) => {
  res.json({ message: 'Content deleted' });
};

/* ------------------------------------------------------------------ */
/* Admin Notifications                                                 */
/* ------------------------------------------------------------------ */
export const getAdminNotifications = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
    const offset = (pageNum - 1) * limitNum;

    const [countRows] = await pool.execute(`SELECT COUNT(*) AS total FROM announcements`);
    const [rows] = await pool.execute(
      `SELECT * FROM announcements ORDER BY created_at DESC LIMIT ${limitNum} OFFSET ${offset}`
    );

    res.json({
      notifications: rows,
      pagination: { page: pageNum, limit: limitNum, total: countRows[0]?.total || 0, totalPages: Math.ceil((countRows[0]?.total || 0) / limitNum) },
    });
  } catch (err) {
    console.error('[adminController.getAdminNotifications]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Support Tickets                                                     */
/* ------------------------------------------------------------------ */
export const getSupportTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute(
      `SELECT s.*, u.name AS user_name, u.email AS user_email
       FROM support_tickets s
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`,
      [id],
    );
    if (!rows.length) return res.status(404).json({ message: 'Ticket not found' });

    const [replies] = await pool.execute(
      `SELECT sr.*, u.name AS author_name, u.email AS author_email, u.role AS author_role
       FROM support_replies sr
       LEFT JOIN users u ON u.id = sr.user_id
       WHERE sr.ticket_id = ?
       ORDER BY sr.created_at ASC`,
      [id],
    );

    res.json({ ticket: { ...rows[0], user: { name: rows[0].user_name, email: rows[0].user_email } }, replies });
  } catch (err) {
    console.error('[adminController.getSupportTicket]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const respondToSupportTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;
    await pool.execute(
      'INSERT INTO support_replies (ticket_id, user_id, message, is_staff) VALUES (?, ?, ?, 1)',
      [id, req.user.id, message || 'Response sent from support.'],
    );
    res.json({ message: 'Response sent' });
  } catch (err) {
    console.error('[adminController.respondToSupportTicket]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const closeSupportTicket = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute("UPDATE support_tickets SET status = 'closed' WHERE id = ?", [id]);
    res.json({ message: 'Ticket closed' });
  } catch (err) {
    console.error('[adminController.closeSupportTicket]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* User & Event Management Extra Actions                               */
/* ------------------------------------------------------------------ */
export const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.role === 'admin') return res.status(400).json({ message: 'Admin accounts cannot be deleted' });

    await logAudit({ userId: req.user.id, action: 'delete_user', entityType: 'user', entityId: Number(id), details: { name: user.name, email: user.email } });
    await pool.execute('DELETE FROM users WHERE id = ?', [id]);
    res.json({ message: 'User deleted' });
  } catch (err) {
    console.error('[adminController.deleteUser]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const unsuspendUser = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.status !== 'suspended') return res.status(400).json({ message: 'User is not suspended' });

    await pool.execute(
      `UPDATE users SET status = 'active', suspend_reason = NULL, suspended_at = NULL WHERE id = ?`,
      [id],
    );
    await sendNotification({
      userId: Number(id),
      title: 'Account reinstated',
      message: 'Your account has been reinstated. You can now use the platform again.',
      type: 'account',
    });
    await logAudit({ userId: req.user.id, action: 'unsuspend_user', entityType: 'user', entityId: Number(id) });
    res.json({ message: 'User unsuspended' });
  } catch (err) {
    console.error('[adminController.unsuspendUser]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const verifyUser = approveOrganizer;

/* ------------------------------------------------------------------ */
/* Reset a user's password (admin)                                     */
/* ------------------------------------------------------------------ */
// Admins may set a new password for any non-admin account, or let the
// system generate a strong temporary one. The plaintext is never stored —
// only the bcrypt hash. Outstanding reset tokens are burned so stale
// links cannot override the fresh credential.
const generateTemporaryPassword = (len = 12) => {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  if (!/[a-zA-Z]/.test(out)) out = `${out.slice(0, -1)}a`;
  if (!/\d/.test(out)) out = `${out.slice(0, -1)}7`;
  return out;
};

export const resetUserPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body || {};

    const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.role === 'admin') {
      return res.status(400).json({ message: 'Admin account passwords cannot be reset here' });
    }

    const generated = !password;
    const newPassword = generated ? generateTemporaryPassword() : String(password);

    const strength = validatePassword(newPassword);
    if (!strength.valid) {
      return res.status(400).json({ message: strength.message });
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.execute('UPDATE users SET password = ? WHERE id = ?', [hashed, id]);

    // Burn outstanding reset tokens so old emailed links stop working.
    await pool.execute('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ?', [id]);

    await sendNotification({
      userId: Number(id),
      title: 'Password updated by administrator',
      message: 'Your password was reset by an administrator. Please log in using the new password.',
      type: 'account',
    });
    await logAudit({
      userId: req.user.id,
      action: 'admin_reset_password',
      entityType: 'user',
      entityId: Number(id),
      details: { generated, by: req.user.email },
    });

    res.json({
      message: generated ? 'Temporary password generated' : 'Password reset successfully',
      ...(generated ? { temporaryPassword: newPassword } : {}),
    });
  } catch (err) {
    console.error('[adminController.resetUserPassword]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const adminDeleteEvent = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute('DELETE FROM events WHERE id = ?', [id]);
    res.json({ message: 'Event deleted' });
  } catch (err) {
    console.error('[adminController.adminDeleteEvent]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute('SELECT * FROM payments WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ message: 'Payment not found' });
    res.json({ payment: rows[0] });
  } catch (err) {
    console.error('[adminController.getPayment]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const refundPayment = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute("UPDATE payments SET status = 'refunded' WHERE id = ?", [id]);
    res.json({ message: 'Payment refunded' });
  } catch (err) {
    console.error('[adminController.refundPayment]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getRevenueReport = async (_req, res) => {
  res.json({ report: [] });
};

export const getGrowthReport = async (_req, res) => {
  res.json({ report: [] });
};

export default {
  getDashboardStats, getUsers, getUser, updateUser, suspendUser, unsuspendUser, verifyUser, deleteUser, approveOrganizer, resetUserPassword,
  getEvents, approveEvent, rejectEvent, featureEvent, suspendEvent, unsuspendEvent, adminDeleteEvent,
  getCategories, createCategory, updateCategory, deleteCategory,
  getPayments, getPayment, refundPayment, getWithdrawals, approveWithdrawal,
  getReports, getRevenueReport, getGrowthReport,
  getSupportTickets, getSupportTicket, respondToSupportTicket, closeSupportTicket, resolveSupportTicket,
  sendAnnouncement, getAdminNotifications, getAuditLogs, getSystemSettings, updateSystemSettings,
  getContentPages, createContentPage, updateContentPage, deleteContentPage,
};
