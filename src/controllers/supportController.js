import pool from '../config/db.js';
import { sendNotification, notifyAdmins } from '../utils/notify.js';
import {
  sendSupportTicketCreatedEmail,
  sendAdminNewSupportTicketEmail,
} from '../utils/email.js';

/* ------------------------------------------------------------------ */
/* Create a support ticket                                             */
/* ------------------------------------------------------------------ */
export const createTicket = async (req, res) => {
  try {
    const userId = req.user.id;
    const { subject, message, category, priority, orderId, eventId, order_id, event_id } = req.body;

    if (!subject?.trim() || !message?.trim()) {
      return res.status(400).json({ message: 'Subject and message are required' });
    }

    const allowedCategories = ['general', 'billing', 'technical', 'account', 'event', 'ticketing', 'refund', 'other'];
    const cat = allowedCategories.includes(category?.toLowerCase()) ? category.toLowerCase() : 'general';

    const allowedPriorities = ['low', 'medium', 'high', 'urgent'];
    const pri = allowedPriorities.includes(priority?.toLowerCase()) ? priority.toLowerCase() : 'medium';

    const linkedOrderId = orderId || order_id || null;
    const linkedEventId = eventId || event_id || null;

    // Generate readable ticket reference
    const reference = `TC-SUP-${Math.floor(100000 + Math.random() * 900000)}`;

    const [result] = await pool.execute(
      `INSERT INTO support_tickets (user_id, subject, message, category, priority, status, reference, order_id, event_id)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      [userId, subject.trim().slice(0, 200), message.trim(), cat, pri, reference, linkedOrderId, linkedEventId],
    );

    const ticketId = result.insertId;

    // 1. Notify platform staff via in-app notification
    notifyAdmins({
      title: pri === 'urgent' ? '🚨 URGENT Support Request' : 'New Support Request',
      message: `[${reference}] Ticket from ${req.user.name || 'User'} (${req.user.email || 'N/A'}): "${subject.trim().slice(0, 70)}" (Priority: ${pri}).`,
      type: 'support',
      link: '/admin/support',
    }).catch(() => {});

    // 2. Dispatch user email confirmation
    if (req.user?.email) {
      sendSupportTicketCreatedEmail({
        to: req.user.email,
        userName: req.user.name || 'Valued Member',
        ticketId,
        reference,
        subject: subject.trim(),
        category: cat,
        priority: pri,
      }).catch((err) => console.warn('[supportController.createTicket] User confirmation email notice:', err.message));
    }

    // 3. Dispatch admin email alert (for all admins, especially urgent/high)
    (async () => {
      try {
        const [adminRows] = await pool.execute(
          `SELECT email FROM users WHERE role IN ('admin', 'system_admin', 'superadmin') AND (status = 'active' OR status IS NULL)`
        );
        const adminEmails = [...new Set(adminRows.map((a) => a.email).filter(Boolean))];
        if (process.env.ADMIN_EMAIL && !adminEmails.includes(process.env.ADMIN_EMAIL.toLowerCase())) {
          adminEmails.push(process.env.ADMIN_EMAIL.toLowerCase());
        }
        for (const aEmail of adminEmails) {
          await sendAdminNewSupportTicketEmail({
            to: aEmail,
            userName: req.user.name || 'User',
            userEmail: req.user.email || '',
            ticketId,
            reference,
            subject: subject.trim(),
            message: message.trim(),
            category: cat,
            priority: pri,
          }).catch(() => {});
        }
      } catch (admErr) {
        console.warn('[supportController.createTicket] Admin ticket alert error:', admErr.message);
      }
    })().catch(() => {});

    res.status(201).json({
      message: 'Support ticket submitted successfully',
      ticket: {
        id: ticketId,
        reference,
        subject: subject.trim().slice(0, 200),
        message: message.trim(),
        category: cat,
        priority: pri,
        status: 'open',
        order_id: linkedOrderId,
        event_id: linkedEventId,
        created_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[supportController.createTicket]', err);
    res.status(500).json({ message: 'Server error while creating support ticket' });
  }
};

/* ------------------------------------------------------------------ */
/* List the current user's support tickets                             */
/* ------------------------------------------------------------------ */
export const getUserTickets = async (req, res) => {
  try {
    const userId = req.user.id;
    const { status, category, search, page = 1, limit = 20 } = req.query;

    const conditions = ['s.user_id = ?'];
    const params = [userId];

    if (status && status !== 'all') {
      conditions.push('s.status = ?');
      params.push(status);
    }

    if (category && category !== 'all') {
      conditions.push('s.category = ?');
      params.push(category);
    }

    if (search && search.trim()) {
      conditions.push('(s.subject ILIKE ? OR s.message ILIKE ? OR s.reference ILIKE ?)');
      const q = `%${search.trim()}%`;
      params.push(q, q, q);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    const offset = (pageNum - 1) * limitNum;

    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS total FROM support_tickets s ${where}`,
      params,
    );
    const total = Number(countRows[0]?.total || 0);

    const [rows] = await pool.execute(
      `SELECT s.*,
              e.title AS linked_event_title,
              o.payment_reference AS linked_order_reference,
              (SELECT COUNT(*) FROM support_replies sr WHERE sr.ticket_id = s.id) AS reply_count
       FROM support_tickets s
       LEFT JOIN events e ON e.id = s.event_id
       LEFT JOIN orders o ON o.id = s.order_id
       ${where}
       ORDER BY s.updated_at DESC, s.created_at DESC
       LIMIT ${limitNum} OFFSET ${offset}`,
      params,
    );

    // Compute user status counts
    const [counts] = await pool.execute(
      `SELECT
         COUNT(*) AS all_count,
         COUNT(CASE WHEN status = 'open' THEN 1 END) AS open_count,
         COUNT(CASE WHEN status = 'in_progress' THEN 1 END) AS in_progress_count,
         COUNT(CASE WHEN status = 'resolved' THEN 1 END) AS resolved_count,
         COUNT(CASE WHEN status = 'closed' THEN 1 END) AS closed_count
       FROM support_tickets WHERE user_id = ?`,
      [userId],
    );

    res.json({
      tickets: rows.map((r) => ({
        ...r,
        reference: r.reference || `TC-SUP-${String(r.id).padStart(6, '0')}`,
      })),
      counts: counts[0] || { all_count: total, open_count: 0, in_progress_count: 0, resolved_count: 0, closed_count: 0 },
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum) || 1,
      },
    });
  } catch (err) {
    console.error('[supportController.getUserTickets]', err);
    res.status(500).json({ message: 'Server error while fetching your tickets' });
  }
};

/* ------------------------------------------------------------------ */
/* Get a single ticket with its conversation thread                    */
/* ------------------------------------------------------------------ */
export const getUserTicket = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const [rows] = await pool.execute(
      `SELECT s.*,
              e.title AS linked_event_title,
              o.payment_reference AS linked_order_reference,
              o.total_amount AS linked_order_amount
       FROM support_tickets s
       LEFT JOIN events e ON e.id = s.event_id
       LEFT JOIN orders o ON o.id = s.order_id
       WHERE s.id = ? AND s.user_id = ?`,
      [id, userId],
    );
    if (!rows.length) return res.status(404).json({ message: 'Ticket not found' });

    const ticket = {
      ...rows[0],
      reference: rows[0].reference || `TC-SUP-${String(rows[0].id).padStart(6, '0')}`,
    };

    const [replies] = await pool.execute(
      `SELECT sr.id, sr.ticket_id, sr.user_id, sr.message, sr.is_staff, sr.created_at,
              u.name AS user_name, u.email AS user_email, u.role AS user_role
       FROM support_replies sr
       JOIN users u ON u.id = sr.user_id
       WHERE sr.ticket_id = ?
       ORDER BY sr.created_at ASC`,
      [id],
    );

    res.json({
      ticket,
      replies: replies.map((r) => ({
        ...r,
        is_staff: Boolean(r.is_staff || r.user_role === 'admin' || r.user_role === 'system_admin' || r.user_role === 'superadmin'),
      })),
    });
  } catch (err) {
    console.error('[supportController.getUserTicket]', err);
    res.status(500).json({ message: 'Server error while loading ticket' });
  }
};

/* ------------------------------------------------------------------ */
/* User replies to a ticket                                            */
/* ------------------------------------------------------------------ */
export const addReply = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ message: 'Message is required' });
    }

    const [ticketRows] = await pool.execute(
      'SELECT * FROM support_tickets WHERE id = ? AND user_id = ?',
      [id, userId],
    );
    if (!ticketRows.length) return res.status(404).json({ message: 'Ticket not found' });

    const ticket = ticketRows[0];
    if (ticket.status === 'closed') {
      return res.status(400).json({ message: 'This ticket is closed. Create a new ticket if you need further help.' });
    }

    // Fix Postgres boolean: pass false instead of integer 0
    await pool.execute(
      'INSERT INTO support_replies (ticket_id, user_id, message, is_staff) VALUES (?, ?, ?, false)',
      [id, userId, message.trim()],
    );

    // Reopen ticket if it was resolved
    const nextStatus = ticket.status === 'resolved' ? 'open' : ticket.status;
    await pool.execute(
      `UPDATE support_tickets SET status = ?, updated_at = NOW() WHERE id = ?`,
      [nextStatus, id],
    );

    // Notify admins of user response
    notifyAdmins({
      title: 'Customer Reply on Support Ticket',
      message: `${req.user.name || 'User'} replied on ticket #${id} ("${ticket.subject.slice(0, 50)}")`,
      type: 'support',
      link: '/admin/support',
    }).catch(() => {});

    res.status(201).json({
      message: 'Reply sent successfully',
      reply: {
        id: Date.now(),
        message: message.trim(),
        is_staff: false,
        user_name: req.user.name || 'You',
        created_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[supportController.addReply]', err);
    res.status(500).json({ message: 'Server error while sending reply' });
  }
};

/* ------------------------------------------------------------------ */
/* User closes their own ticket                                        */
/* ------------------------------------------------------------------ */
export const closeTicket = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const [ticketRows] = await pool.execute(
      'SELECT * FROM support_tickets WHERE id = ? AND user_id = ?',
      [id, userId],
    );
    if (!ticketRows.length) return res.status(404).json({ message: 'Ticket not found' });

    if (ticketRows[0].status === 'closed') {
      return res.status(400).json({ message: 'Ticket is already closed' });
    }

    await pool.execute("UPDATE support_tickets SET status = 'closed', updated_at = NOW() WHERE id = ?", [id]);
    res.json({ message: 'Ticket marked as resolved and closed' });
  } catch (err) {
    console.error('[supportController.closeTicket]', err);
    res.status(500).json({ message: 'Server error while closing ticket' });
  }
};
