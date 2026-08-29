import { v4 as uuidv4 } from 'uuid';
import pool from '../config/db.js';
import { logAudit } from '../utils/audit.js';
import textPdf from '../utils/pdf.js';
import { sendNotification } from '../utils/notify.js';

/* ------------------------------------------------------------------ */
/* Get ticket types for an event (public)                              */
/* ------------------------------------------------------------------ */
export const getTicketTypes = async (req, res) => {
  try {
    const { eventId } = req.params;
    const [rows] = await pool.execute(
      `SELECT * FROM ticket_types WHERE event_id = ? ORDER BY price ASC`,
      [eventId],
    );
    res.json(rows);
  } catch (err) {
    console.error('[ticketController.getTicketTypes]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Create ticket type                                                  */
/* ------------------------------------------------------------------ */
export const createTicketType = async (req, res) => {
  try {
    const { eventId } = req.params;
    const {
      name, price, quantity, sale_start, sale_end, description,
      early_bird_price, early_bird_deadline, early_bird_max_qty, section_type, perks,
    } = req.body;

    if (!name || price === undefined || quantity === undefined) {
      return res.status(400).json({ message: 'Name, price and quantity are required' });
    }

    const [eventRows] = await pool.execute('SELECT * FROM events WHERE id = ?', [eventId]);
    const event = eventRows[0];
    if (!event) return res.status(404).json({ message: 'Event not found' });

    if (event.organizer_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only the event organizer can add ticket types' });
    }

    const [result] = await pool.execute(
      `INSERT INTO ticket_types (
        event_id, name, price, quantity, quantity_sold, sale_start, sale_end, description,
        early_bird_price, early_bird_deadline, early_bird_max_qty, section_type, perks
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId, name, price, quantity,
        sale_start || null, sale_end || null, description || null,
        early_bird_price !== undefined ? early_bird_price : null,
        early_bird_deadline || null,
        early_bird_max_qty || null,
        section_type || 'general',
        perks ? JSON.stringify(perks) : null,
      ],
    );

    await logAudit({ userId: req.user.id, action: 'create_ticket_type', entityType: 'ticket_type', entityId: result.insertId });

    res.status(201).json({ message: 'Ticket type created', ticketTypeId: result.insertId });
  } catch (err) {
    console.error('[ticketController.createTicketType]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Update ticket type                                                  */
/* ------------------------------------------------------------------ */
export const updateTicketType = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute('SELECT * FROM ticket_types WHERE id = ?', [id]);
    const tt = rows[0];
    if (!tt) return res.status(404).json({ message: 'Ticket type not found' });

    const [eventRows] = await pool.execute('SELECT organizer_id FROM events WHERE id = ?', [tt.event_id]);
    if (eventRows[0].organizer_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const allowed = [
      'name', 'price', 'quantity', 'sale_start', 'sale_end', 'description',
      'early_bird_price', 'early_bird_deadline', 'early_bird_max_qty', 'section_type', 'perks',
    ];
    const fields = [];
    const values = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(key === 'perks' && typeof req.body[key] === 'object' ? JSON.stringify(req.body[key]) : req.body[key]);
      }
    }
    if (!fields.length) return res.status(400).json({ message: 'No fields to update' });

    values.push(id);
    await pool.execute(`UPDATE ticket_types SET ${fields.join(', ')} WHERE id = ?`, values);

    res.json({ message: 'Ticket type updated' });
  } catch (err) {
    console.error('[ticketController.updateTicketType]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Delete ticket type                                                  */
/* ------------------------------------------------------------------ */
export const deleteTicketType = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute('SELECT * FROM ticket_types WHERE id = ?', [id]);
    const tt = rows[0];
    if (!tt) return res.status(404).json({ message: 'Ticket type not found' });

    const [eventRows] = await pool.execute('SELECT organizer_id FROM events WHERE id = ?', [tt.event_id]);
    if (eventRows[0].organizer_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (tt.quantity_sold > 0) {
      return res.status(400).json({ message: 'Cannot delete a ticket type that has sold tickets' });
    }

    await pool.execute('DELETE FROM ticket_types WHERE id = ?', [id]);
    res.json({ message: 'Ticket type deleted' });
  } catch (err) {
    console.error('[ticketController.deleteTicketType]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Get the current user's tickets                                      */
/* ------------------------------------------------------------------ */
export const getUserTickets = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT t.*, tt.name AS ticket_type_name, e.title AS event_title,
              e.venue AS event_venue, e.start_date, e.start_time, e.banner_image
       FROM tickets t
       JOIN ticket_types tt ON tt.id = t.ticket_type_id
       JOIN events e ON e.id = t.event_id
       WHERE t.user_id = ?
       ORDER BY t.created_at DESC`,
      [req.user.id],
    );
    res.json({ tickets: rows });
  } catch (err) {
    console.error('[ticketController.getUserTickets]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Get a single ticket by id                                           */
/* ------------------------------------------------------------------ */
export const getTicketById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute(
      `SELECT t.*, tt.name AS ticket_type_name, e.title AS event_title,
              e.venue, e.address, e.city, e.start_date, e.end_date, e.start_time, e.end_time,
              e.banner_image, e.organizer_id
       FROM tickets t
       JOIN ticket_types tt ON tt.id = t.ticket_type_id
       JOIN events e ON e.id = t.event_id
       WHERE t.id = ?`,
      [id],
    );
    const ticket = rows[0];
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });

    const isOwner = ticket.user_id === req.user.id;
    const isOrganizer = ticket.organizer_id === req.user.id;
    const isStaff = req.user.role === 'admin';
    if (!isOwner && !isOrganizer && !isStaff) {
      return res.status(403).json({ message: 'You do not have access to this ticket' });
    }

    res.json({ ticket });
  } catch (err) {
    console.error('[ticketController.getTicketById]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Check-in a ticket (organizer / staff / inspector)                   */
/* ------------------------------------------------------------------ */
export const checkInTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute(
      `SELECT t.*, e.organizer_id
       FROM tickets t
       JOIN events e ON e.id = t.event_id
       WHERE t.id = ?`,
      [id],
    );
    const ticket = rows[0];
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });

    const isOrganizer = ticket.organizer_id === req.user.id;
    const isStaff = req.user.role === 'admin';
    if (!isOrganizer && !isStaff) {
      return res.status(403).json({ message: 'Only the organizer or staff can check in tickets' });
    }

    if (ticket.status === 'used') {
      return res.status(400).json({ message: 'Ticket already checked in' });
    }
    if (ticket.status !== 'active') {
      return res.status(400).json({ message: `Ticket is ${ticket.status} and cannot be checked in` });
    }

    await pool.execute(
      `UPDATE tickets SET status = 'used', checked_in_at = NOW() WHERE id = ?`,
      [id],
    );

    await logAudit({ userId: req.user.id, action: 'check_in_ticket', entityType: 'ticket', entityId: id });

    res.json({ message: 'Ticket checked in successfully' });
  } catch (err) {
    console.error('[ticketController.checkInTicket]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Transfer a ticket to another user                                   */
/* ------------------------------------------------------------------ */
export const transferTicket = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;
    const { recipientEmail } = req.body;
    if (!recipientEmail) {
      conn.release();
      return res.status(400).json({ message: 'Recipient email is required' });
    }

    const [ticketRows] = await conn.execute('SELECT * FROM tickets WHERE id = ?', [id]);
    const ticket = ticketRows[0];
    if (!ticket) {
      conn.release();
      return res.status(404).json({ message: 'Ticket not found' });
    }
    if (ticket.user_id !== req.user.id) {
      conn.release();
      return res.status(403).json({ message: 'You can only transfer your own tickets' });
    }
    if (ticket.status !== 'active') {
      conn.release();
      return res.status(400).json({ message: `Ticket is ${ticket.status} and cannot be transferred` });
    }

    const [recipientRows] = await conn.execute('SELECT id, email FROM users WHERE email = ?', [recipientEmail]);
    const recipient = recipientRows[0];
    if (!recipient) {
      conn.release();
      return res.status(404).json({ message: 'Recipient not found. Ask them to create an account first.' });
    }
    if (recipient.id === req.user.id) {
      conn.release();
      return res.status(400).json({ message: 'Cannot transfer a ticket to yourself' });
    }

    // Mark original ticket as transferred and issue a new active ticket to recipient.
    await conn.beginTransaction();

    await conn.execute(`UPDATE tickets SET status = 'transferred' WHERE id = ?`, [id]);

    const newNumber = `TC-${uuidv4().split('-')[0].toUpperCase()}`;
    const [result] = await conn.execute(
      `INSERT INTO tickets
        (order_item_id, user_id, event_id, ticket_type_id, ticket_number, qr_code, seat_number, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
      [ticket.order_item_id, recipient.id, ticket.event_id, ticket.ticket_type_id, newNumber, ticket.qr_code, ticket.seat_number],
    );

    await conn.commit();
    conn.release();

    // Notify recipient and sender
    try {
      const [eventRows] = await pool.execute('SELECT title FROM events WHERE id = ?', [ticket.event_id]);
      const eventTitle = eventRows[0]?.title || 'your event';
      const senderName = req.user.name || req.user.email || 'A friend';

      sendNotification({
        userId: recipient.id,
        title: '🎟️ Ticket Received!',
        message: `${senderName} just transferred a ticket for "${eventTitle}" to you. Access it now under My Tickets!`,
        type: 'ticket',
      }).catch(() => {});

      sendNotification({
        userId: req.user.id,
        title: 'Ticket Transferred',
        message: `Your ticket for "${eventTitle}" was successfully transferred to ${recipient.email}.`,
        type: 'ticket',
      }).catch(() => {});
    } catch { /* ignore notification errors */ }

    await logAudit({
      userId: req.user.id,
      action: 'transfer_ticket',
      entityType: 'ticket',
      entityId: id,
      details: { from: req.user.id, to: recipient.id, newTicketId: result.insertId },
    });

    res.json({ message: 'Ticket transferred successfully', newTicketId: result.insertId });
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    conn.release();
    console.error('[ticketController.transferTicket]', err);
    res.status(500).json({ message: 'Server error during transfer' });
  }
};

/* ------------------------------------------------------------------ */
/* Verify a ticket by its ticket number / QR code (check-in scanner)   */
/* ------------------------------------------------------------------ */
export const verifyTicketByCode = async (req, res) => {
  try {
    const { code } = req.params;
    if (!code) return res.status(400).json({ message: 'Ticket code is required' });

    const [rows] = await pool.execute(
      `SELECT t.id, t.user_id, t.ticket_number, t.qr_code, t.seat_number, t.status, t.checked_in_at,
              tt.name AS ticket_type, u.name AS attendee_name, e.organizer_id, e.id AS event_id
       FROM tickets t
       JOIN ticket_types tt ON tt.id = t.ticket_type_id
       JOIN events e ON e.id = t.event_id
       JOIN users u ON u.id = t.user_id
       WHERE t.ticket_number = ? OR t.qr_code = ?`,
      [code, code],
    );
    const ticket = rows[0];
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });

    if (ticket.organizer_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only the event organizer can verify tickets' });
    }

    res.json({
      ticket: {
        id: ticket.id,
        ticketId: ticket.id,
        ticketNumber: ticket.ticket_number,
        eventId: ticket.event_id,
        attendeeName: ticket.attendee_name,
        ticketType: ticket.ticket_type,
        seatNumber: ticket.seat_number,
        status: ticket.status,
        checkedIn: ticket.status === 'used',
        checkInStatus: ticket.status,
      },
    });
  } catch (err) {
    console.error('[ticketController.verifyTicketByCode]', err);
    res.status(500).json({ message: 'Server error verifying ticket' });
  }
};

/* ------------------------------------------------------------------ */
/* Check in multiple tickets at once                                   */
/* ------------------------------------------------------------------ */
export const bulkCheckIn = async (req, res) => {
  try {
    const { ticketIds = [], codes = [] } = req.body;
    const ids = [...new Set([...ticketIds, ...codes])].filter(Boolean);
    if (!ids.length) {
      return res.status(400).json({ message: 'ticketIds[] or codes[] are required' });
    }

    const placeholders = ids.map(() => '?').join(', ');
    const [tickets] = await pool.execute(
      `SELECT t.id, t.status, t.event_id, e.organizer_id
       FROM tickets t
       JOIN events e ON e.id = t.event_id
       WHERE t.id IN (${placeholders}) OR t.ticket_number IN (${placeholders})`,
      [...ids, ...ids],
    );

    let checkedIn = 0;
    let skipped = 0;
    const results = [];
    for (const ticket of tickets) {
      if (ticket.organizer_id !== req.user.id && req.user.role !== 'admin') {
        results.push({ id: ticket.id, status: 'forbidden' });
        continue;
      }
      if (ticket.status === 'used') {
        results.push({ id: ticket.id, status: 'already_used' });
        skipped++;
        continue;
      }
      if (ticket.status !== 'active') {
        results.push({ id: ticket.id, status: 'invalid' });
        skipped++;
        continue;
      }
      await pool.execute(`UPDATE tickets SET status = 'used', checked_in_at = NOW() WHERE id = ?`, [ticket.id]);
      results.push({ id: ticket.id, status: 'checked_in' });
      checkedIn++;
    }

    await logAudit({
      userId: req.user.id,
      action: 'bulk_check_in',
      entityType: 'ticket',
      details: { requested: ids.length, checkedIn, skipped },
    });

    res.json({ message: `Checked in ${checkedIn} of ${tickets.length} tickets`, checkedIn, skipped, results });
  } catch (err) {
    console.error('[ticketController.bulkCheckIn]', err);
    res.status(500).json({ message: 'Server error during bulk check-in' });
  }
};

/* ------------------------------------------------------------------ */
/* Download a ticket as a PDF                                          */
/* ------------------------------------------------------------------ */
export const downloadTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute(
      `SELECT t.*, tt.name AS ticket_type_name, e.title AS event_title,
              e.venue, e.city, e.start_date, e.start_time, e.organizer_id,
              u.name AS attendee_name
       FROM tickets t
       JOIN ticket_types tt ON tt.id = t.ticket_type_id
       JOIN events e ON e.id = t.event_id
       JOIN users u ON u.id = t.user_id
       WHERE t.id = ?`,
      [id],
    );
    const ticket = rows[0];
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });

    const isOwner = ticket.user_id === req.user.id;
    const isOrganizer = ticket.organizer_id === req.user.id;
    const isAdmin = ['admin', 'system_admin', 'superadmin', 'staff'].includes(req.user.role);
    if (!isOwner && !isOrganizer && !isAdmin) {
      return res.status(403).json({ message: 'You do not have access to this ticket' });
    }

    const pdf = textPdf({
      title: 'TICKET',
      lines: [
        ticket.event_title || 'Event ticket',
        `${ticket.venue || ''}${ticket.city ? `, ${ticket.city}` : ''}`,
        `${ticket.start_date ? String(ticket.start_date).slice(0, 10) : ''}${ticket.start_time ? ` at ${ticket.start_time}` : ''}`,
        '',
        `Ticket number: ${ticket.ticket_number}`,
        `Ticket type: ${ticket.ticket_type_name || 'General admission'}`,
        `Seat: ${ticket.seat_number || 'General admission'}`,
        `Attendee: ${ticket.attendee_name || ''}`,
        `Status: ${ticket.status}`, 
      ],
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="ticket-${id}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('[ticketController.downloadTicket]', err);
    res.status(500).json({ message: 'Server error downloading ticket' });
  }
};

export const getTickets = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, eventId } = req.query;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const offset = (pageNum - 1) * limitNum;

    const conditions = [];
    const params = [];

    if (req.user.role !== 'admin') {
      conditions.push('t.user_id = ?');
      params.push(req.user.id);
    }
    if (status && status !== 'all') {
      conditions.push('t.status = ?');
      params.push(status);
    }
    if (eventId) {
      conditions.push('t.event_id = ?');
      params.push(eventId);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [countRows] = await pool.execute(`SELECT COUNT(*) AS total FROM tickets t ${where}`, params);

    const [rows] = await pool.execute(
      `SELECT t.*, tt.name AS ticket_type_name, e.title AS event_title,
              e.venue AS event_venue, e.start_date, e.start_time, e.banner_image,
              u.name AS owner_name, u.email AS owner_email
       FROM tickets t
       JOIN ticket_types tt ON tt.id = t.ticket_type_id
       JOIN events e ON e.id = t.event_id
       JOIN users u ON u.id = t.user_id
       ${where}
       ORDER BY t.created_at DESC
       LIMIT ${limitNum} OFFSET ${offset}`,
      params,
    );

    res.json({
      tickets: rows,
      pagination: { page: pageNum, limit: limitNum, total: countRows[0].total, totalPages: Math.ceil(countRows[0].total / limitNum) },
    });
  } catch (err) {
    console.error('[ticketController.getTickets]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export default {
  getTicketTypes, createTicketType, updateTicketType, deleteTicketType,
  getUserTickets, getTicketById, checkInTicket, transferTicket, getTickets,
  verifyTicketByCode, bulkCheckIn, downloadTicket,
};
