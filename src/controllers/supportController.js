import pool from '../config/db.js';
import { sendNotification } from '../utils/notify.js';

/* ------------------------------------------------------------------ */
/* Create a support ticket                                             */
/* ------------------------------------------------------------------ */
export const createTicket = async (req, res) => {
  try {
    const userId = req.user.id;
    const { subject, message, category, priority } = req.body;

    if (!subject || !message) {
      return res.status(400).json({ message: 'Subject and message are required' });
    }

    const allowedCategories = ['general', 'billing', 'technical', 'account', 'event', 'other'];
    const cat = allowedCategories.includes(category) ? category : 'general';

    const allowedPriorities = ['low', 'medium', 'high', 'urgent'];
    const pri = allowedPriorities.includes(priority) ? priority : 'medium';

    const [result] = await pool.execute(
      'INSERT INTO support_tickets (user_id, subject, message, category, priority, status) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, subject.slice(0, 200), message, cat, pri, 'open'],
    );

    res.status(201).json({
      message: 'Ticket created successfully',
      ticket: { id: result.insertId, subject: subject.slice(0, 200), message, category: cat, priority: pri, status: 'open' },
    });
  } catch (err) {
    console.error('[supportController.createTicket]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* List the current user's support tickets                             */
/* ------------------------------------------------------------------ */
export const getUserTickets = async (req, res) => {
  try {
    const userId = req.user.id;
    const { status, page = 1, limit = 20 } = req.query;

    const conditions = ['s.user_id = ?'];
    const params = [userId];

    if (status && status !== 'all') {
      conditions.push('s.status = ?');
      params.push(status);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    const offset = (pageNum - 1) * limitNum;

    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS total FROM support_tickets s ${where}`,
      params,
    );
    const [rows] = await pool.execute(
      `SELECT s.*,
        (SELECT COUNT(*) FROM support_replies sr WHERE sr.ticket_id = s.id) AS reply_count
       FROM support_tickets s
       ${where}
       ORDER BY s.created_at DESC
       LIMIT ${limitNum} OFFSET ${offset}`,
      params,
    );

    res.json({
      tickets: rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: countRows[0].total,
        totalPages: Math.ceil(countRows[0].total / limitNum),
      },
    });
  } catch (err) {
    console.error('[supportController.getUserTickets]', err);
    res.status(500).json({ message: 'Server error' });
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
      'SELECT * FROM support_tickets WHERE id = ? AND user_id = ?',
      [id, userId],
    );
    if (!rows.length) return res.status(404).json({ message: 'Ticket not found' });

    const [replies] = await pool.execute(
      `SELECT sr.*, u.name AS user_name, u.email AS user_email, u.role AS user_role
       FROM support_replies sr
       JOIN users u ON u.id = sr.user_id
       WHERE sr.ticket_id = ?
       ORDER BY sr.created_at ASC`,
      [id],
    );

    res.json({ ticket: rows[0], replies });
  } catch (err) {
    console.error('[supportController.getUserTicket]', err);
    res.status(500).json({ message: 'Server error' });
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
      return res.status(400).json({ message: 'This ticket is closed. Create a new one if you need further help.' });
    }

    await pool.execute(
      'INSERT INTO support_replies (ticket_id, user_id, message, is_staff) VALUES (?, ?, ?, 0)',
      [id, userId, message.trim()],
    );

    // Reopen if it was resolved
    if (ticket.status === 'resolved') {
      await pool.execute("UPDATE support_tickets SET status = 'open', updated_at = NOW() WHERE id = ?", [id]);
    } else {
      await pool.execute('UPDATE support_tickets SET updated_at = NOW() WHERE id = ?', [id]);
    }

    res.status(201).json({ message: 'Reply sent' });
  } catch (err) {
    console.error('[supportController.addReply]', err);
    res.status(500).json({ message: 'Server error' });
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
    res.json({ message: 'Ticket closed' });
  } catch (err) {
    console.error('[supportController.closeTicket]', err);
    res.status(500).json({ message: 'Server error' });
  }
};
