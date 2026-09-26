import { v4 as uuidv4 } from 'uuid';
import pool from '../config/db.js';
import { logAudit } from '../utils/audit.js';
import textPdf from '../utils/pdf.js';
import { sendNotification, notifyAdmins } from '../utils/notify.js';

/* ------------------------------------------------------------------ */
/* Get ticket types for an event (public)                              */
/* ------------------------------------------------------------------ */
export const getTicketTypes = async (req, res) => {
  try {
    const { eventId } = req.params;
    let [rows] = await pool.execute(
      `SELECT * FROM ticket_types WHERE event_id = ? ORDER BY price ASC`,
      [eventId],
    );

    // Auto-seed Ghanaian standard ticket tiers if none exist yet
    if (!rows || rows.length === 0) {
      const [evtRows] = await pool.execute('SELECT id FROM events WHERE id = ?', [eventId]);
      if (evtRows.length > 0) {
        const standardTiers = [
          { name: 'Regular Ticket', price: 100.00, quantity: 250, description: 'Standard admission pass with full event and venue access.' },
          { name: 'VIP Ticket', price: 250.00, quantity: 80, description: 'Express queue entry, designated VIP lounge access, and complimentary welcome drink.' },
          { name: 'VVIP Ticket', price: 500.00, quantity: 25, description: 'Front-row seating, dedicated concierge, priority backstage pass, and luxury hospitality.' },
        ];
        for (const tier of standardTiers) {
          await pool.execute(
            `INSERT INTO ticket_types (event_id, name, price, quantity, quantity_sold, description)
             VALUES (?, ?, ?, ?, 0, ?)`,
            [eventId, tier.name, tier.price, tier.quantity, tier.description],
          );
        }
        const [seededRows] = await pool.execute(
          `SELECT * FROM ticket_types WHERE event_id = ? ORDER BY price ASC`,
          [eventId],
        );
        rows = seededRows;
      }
    }

    for (const tt of (rows || [])) {
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

    res.json(rows || []);
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

    const uploadedList = Array.isArray(req.body.uploadedTickets) || Array.isArray(req.body.uploaded_tickets)
      ? (req.body.uploadedTickets || req.body.uploaded_tickets)
      : [];

    let finalQuantity = Number(quantity);
    if (uploadedList.length > 0) {
      finalQuantity = uploadedList.length;
    }

    const finalPrice = (price === '' || price === null || price === undefined) ? 0 : Number(price);

    if (!name || (!finalQuantity && finalQuantity !== 0 && uploadedList.length === 0)) {
      return res.status(400).json({ message: 'Name and quantity (or uploaded tickets) are required' });
    }

    const [eventRows] = await pool.execute('SELECT * FROM events WHERE id = ?', [eventId]);
    const event = eventRows[0];
    if (!event) return res.status(404).json({ message: 'Event not found' });

    if (Number(event.organizer_id) !== Number(req.user.id) && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only the event organizer can add ticket types' });
    }

    const [result] = await pool.execute(
      `INSERT INTO ticket_types (
        event_id, name, price, quantity, quantity_sold, sale_start, sale_end, description,
        early_bird_price, early_bird_deadline, early_bird_max_qty, section_type, perks
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId, name, finalPrice, finalQuantity,
        sale_start || null, sale_end || null, description || null,
        early_bird_price !== undefined && early_bird_price !== '' ? early_bird_price : null,
        early_bird_deadline || null,
        early_bird_max_qty || null,
        section_type || 'general',
        perks ? JSON.stringify(perks) : null,
      ],
    );

    const ticketTypeId = result.insertId;

    if (uploadedList.length > 0) {
      for (const ut of uploadedList) {
        if (!ut.file_url && !ut.url) continue;
        await pool.execute(
          `INSERT INTO uploaded_tickets (event_id, ticket_type_id, file_url, file_name, barcode, seat_number)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            eventId,
            ticketTypeId,
            ut.file_url || ut.url,
            ut.file_name || ut.fileName || ut.originalName || null,
            ut.barcode || null,
            ut.seat_number || ut.seatNumber || null,
          ],
        );
      }
    }

    await logAudit({ userId: req.user.id, action: 'create_ticket_type', entityType: 'ticket_type', entityId: ticketTypeId });

    res.status(201).json({ message: 'Ticket type created', ticketTypeId });
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
    if (Number(eventRows[0]?.organizer_id) !== Number(req.user.id) && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const hasUploadedList = Array.isArray(req.body.uploadedTickets) || Array.isArray(req.body.uploaded_tickets);
    const uploadedList = hasUploadedList
      ? (req.body.uploadedTickets || req.body.uploaded_tickets)
      : [];

    if (hasUploadedList) {
      // Fetch existing uploaded tickets for this ticket type
      const [existingUploaded] = await pool.execute(
        'SELECT id, file_url, is_assigned FROM uploaded_tickets WHERE ticket_type_id = ?',
        [id]
      );

      // Remove unassigned tickets that are not in the new uploadedList
      for (const ex of existingUploaded) {
        const stillExists = uploadedList.some(
          (u) => (u.id && Number(u.id) === Number(ex.id)) || (u.file_url === ex.file_url || u.url === ex.file_url)
        );
        if (!stillExists && !ex.is_assigned) {
          await pool.execute('DELETE FROM uploaded_tickets WHERE id = ?', [ex.id]);
        }
      }

      // Insert new tickets that don't already exist
      for (const ut of uploadedList) {
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
              tt.event_id,
              id,
              url,
              ut.file_name || ut.fileName || ut.originalName || null,
              ut.barcode || null,
              ut.seat_number || ut.seatNumber || null,
            ],
          );
        }
      }
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
        if (key === 'price') {
          values.push((req.body[key] === '' || req.body[key] === null) ? 0 : Number(req.body[key]));
        } else if (key === 'perks' && typeof req.body[key] === 'object') {
          values.push(JSON.stringify(req.body[key]));
        } else {
          values.push(req.body[key]);
        }
      }
    }

    // If uploaded passes were provided, ensure quantity reflects total uploaded tickets
    if (hasUploadedList) {
      const [[{ countUploaded }]] = await pool.execute(
        'SELECT COUNT(*) AS countUploaded FROM uploaded_tickets WHERE ticket_type_id = ?',
        [id]
      );
      if (countUploaded > 0 || uploadedList.length > 0) {
        // Only override if quantity wasn't explicitly provided or if syncing to uploaded count
        if (req.body.quantity === undefined) {
          fields.push('quantity = ?');
          values.push(countUploaded);
        }
      }
    }

    if (!fields.length && !hasUploadedList) return res.status(400).json({ message: 'No fields to update' });

    if (fields.length > 0) {
      values.push(id);
      await pool.execute(`UPDATE ticket_types SET ${fields.join(', ')} WHERE id = ?`, values);
    }

    res.json({ message: 'Ticket type updated' });
  } catch (err) {
    console.error('[ticketController.updateTicketType]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Get uploaded tickets for a ticket type (organizer only)             */
/* ------------------------------------------------------------------ */
export const getUploadedTickets = async (req, res) => {
  try {
    const { id } = req.params;
    const [ttRows] = await pool.execute('SELECT * FROM ticket_types WHERE id = ?', [id]);
    const tt = ttRows[0];
    if (!tt) return res.status(404).json({ message: 'Ticket type not found' });

    const [eventRows] = await pool.execute('SELECT organizer_id FROM events WHERE id = ?', [tt.event_id]);
    if (Number(eventRows[0]?.organizer_id) !== Number(req.user.id) && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const [rows] = await pool.execute(
      `SELECT * FROM uploaded_tickets WHERE ticket_type_id = ? ORDER BY id ASC`,
      [id],
    );
    res.json({ tickets: rows, uploadedTickets: rows, count: rows.length });
  } catch (err) {
    console.error('[ticketController.getUploadedTickets]', err);
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
    if (Number(eventRows[0]?.organizer_id) !== Number(req.user.id) && req.user.role !== 'admin') {
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
    // Self-healing: if the user has completed orders whose tickets were not yet minted, mint them now
    try {
      const [completedOrders] = await pool.execute(
        `SELECT o.id, o.event_id
         FROM orders o
         WHERE o.user_id = ? AND o.payment_status = 'completed'`,
        [req.user.id],
      );

      for (const ord of completedOrders) {
        const [existing] = await pool.execute(
          `SELECT id FROM tickets WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)`,
          [ord.id],
        );
        if (!existing || existing.length === 0) {
          const [items] = await pool.execute('SELECT * FROM order_items WHERE order_id = ?', [ord.id]);
          for (const oi of items) {
            for (let i = 0; i < oi.quantity; i++) {
              let ticketNumber = `TC-${uuidv4().split('-')[0].toUpperCase()}`;
              let seatNumber = null;
              let ticketFileUrl = null;
              let ticketFileName = null;

              try {
                const [utRows] = await pool.execute(
                  `SELECT id, file_url, file_name, barcode, seat_number
                   FROM uploaded_tickets
                   WHERE ticket_type_id = ? AND is_assigned = FALSE
                   ORDER BY id ASC LIMIT 1`,
                  [oi.ticket_type_id],
                );
                const ut = utRows?.[0];
                if (ut) {
                  if (ut.barcode) ticketNumber = ut.barcode;
                  if (ut.seat_number) seatNumber = ut.seat_number;
                  ticketFileUrl = ut.file_url || null;
                  ticketFileName = ut.file_name || null;
                }

                const [tResult] = await pool.execute(
                  `INSERT INTO tickets (order_item_id, user_id, event_id, ticket_type_id, ticket_number, qr_code, seat_number, ticket_file_url, ticket_file_name, status)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
                  [oi.id, req.user.id, ord.event_id, oi.ticket_type_id, ticketNumber, ticketNumber, seatNumber, ticketFileUrl, ticketFileName],
                );

                if (ut) {
                  await pool.execute(
                    `UPDATE uploaded_tickets SET is_assigned = TRUE, assigned_ticket_id = ?, assigned_at = NOW() WHERE id = ?`,
                    [tResult.insertId, ut.id],
                  );
                }
              } catch {
                await pool.execute(
                  `INSERT INTO tickets (order_item_id, user_id, event_id, ticket_type_id, ticket_number, qr_code, status)
                   VALUES (?, ?, ?, ?, ?, ?, 'active')`,
                  [oi.id, req.user.id, ord.event_id, oi.ticket_type_id, ticketNumber, ticketNumber],
                );
              }
            }
          }
        }
      }
    } catch (healErr) {
      console.warn('[ticketController.getUserTickets] Auto-heal notice:', healErr.message);
    }

    const [rows] = await pool.execute(
      `SELECT t.*, tt.name AS ticket_type_name, tt.price AS ticket_price,
              COALESCE(oi.unit_price, tt.price, 0) AS unit_price,
              e.title AS event_title, e.venue AS event_venue, e.city AS event_city, e.start_date, e.start_time,
              e.banner_image, e.ticket_template,
              COALESCE(t.attendee_name, u.name) AS attendee_name,
              COALESCE(t.attendee_email, u.email) AS attendee_email,
              COALESCE(t.attendee_phone, u.phone) AS attendee_phone,
              o.id AS order_id, o.payment_reference, o.payment_method, o.payment_status,
              o.invoice_number, o.discount_amount AS order_discount, o.total_amount AS order_total,
              o.created_at AS order_created_at
       FROM tickets t
       LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
       LEFT JOIN order_items oi ON oi.id = t.order_item_id
       LEFT JOIN orders o ON o.id = oi.order_id
       LEFT JOIN events e ON e.id = t.event_id
       LEFT JOIN users u ON u.id = t.user_id
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
      `SELECT t.*, tt.name AS ticket_type_name, tt.price AS ticket_price,
              COALESCE(oi.unit_price, tt.price, 0) AS unit_price,
              e.title AS event_title, e.venue, e.address, e.city, e.start_date, e.end_date, e.start_time, e.end_time,
              e.banner_image, e.ticket_template, e.organizer_id, u.name AS attendee_name,
              u.email AS attendee_email, u.phone AS attendee_phone,
              o.id AS order_id, o.payment_reference, o.payment_method, o.payment_status,
              o.invoice_number, o.discount_amount AS order_discount, o.total_amount AS order_total,
              o.created_at AS order_created_at
       FROM tickets t
       JOIN ticket_types tt ON tt.id = t.ticket_type_id
       LEFT JOIN order_items oi ON oi.id = t.order_item_id
       LEFT JOIN orders o ON o.id = oi.order_id
       JOIN events e ON e.id = t.event_id
       LEFT JOIN users u ON u.id = t.user_id
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
    let { id } = req.params;
    if (!id) return res.status(400).json({ success: false, status: 'error', message: 'Ticket identifier is required' });

    try {
      id = decodeURIComponent(id).trim();
    } catch {
      id = String(id).trim();
    }

    // Extract ticket number or ID if JSON string was provided
    if (id.startsWith('{') && id.endsWith('}')) {
      try {
        const parsed = JSON.parse(id);
        id = parsed.ticketNumber || parsed.qrCode || parsed.ticketId || parsed.id || id;
      } catch {}
    }

    const isNumeric = /^\d+$/.test(String(id));
    const [rows] = await pool.execute(
      `SELECT t.*, e.organizer_id, e.title AS event_title, e.venue AS event_venue,
              COALESCE(t.attendee_name, u.name) AS attendee_name,
              COALESCE(t.attendee_phone, u.phone) AS attendee_phone,
              COALESCE(t.attendee_email, u.email) AS attendee_email,
              tt.name AS ticket_type, o.payment_status, o.total_amount AS order_total
       FROM tickets t
       JOIN events e ON e.id = t.event_id
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
       LEFT JOIN order_items oi ON oi.id = t.order_item_id
       LEFT JOIN orders o ON o.id = oi.order_id
       WHERE t.ticket_number = ? OR t.qr_code = ? OR (?::bigint IS NOT NULL AND t.id = ?)`,
      [id, id, isNumeric ? Number(id) : null, isNumeric ? Number(id) : 0],
    );

    const ticket = rows[0];

    // Checklist 1: Does ticket exist?
    if (!ticket) {
      return res.status(404).json({
        success: false,
        status: 'not_found',
        message: '❌ Ticket Not Found or Invalid QR Code',
      });
    }

    const isOrganizer = Number(ticket.organizer_id) === Number(req.user.id);
    const isStaff = req.user.role === 'admin' || req.user.role === 'staff';
    if (!isOrganizer && !isStaff) {
      return res.status(403).json({
        success: false,
        status: 'unauthorized',
        message: 'Only the event organizer or authorized staff can check in tickets',
      });
    }

    // Checklist 2: Is payment confirmed?
    if (ticket.payment_status && ticket.payment_status !== 'paid' && Number(ticket.order_total) > 0) {
      return res.status(400).json({
        success: false,
        status: 'unpaid',
        message: '❌ Payment Unconfirmed — Entry Denied',
        ticketNumber: ticket.ticket_number,
        attendeeName: ticket.attendee_name,
      });
    }

    // Checklist 3: Is ticket cancelled?
    if (ticket.status === 'cancelled') {
      return res.status(400).json({
        success: false,
        status: 'cancelled',
        message: '❌ Ticket Cancelled — Entry Denied',
        ticketNumber: ticket.ticket_number,
        attendeeName: ticket.attendee_name,
      });
    }

    // Checklist 4: Is ticket transferred? (Old QR code invalidated)
    if (ticket.status === 'transferred') {
      return res.status(400).json({
        success: false,
        status: 'transferred',
        message: '❌ Ticket Transferred — Old QR Code Invalidated',
        ticketNumber: ticket.ticket_number,
        attendeeName: ticket.attendee_name,
      });
    }

    // Checklist 5: Has ticket already been scanned?
    if (ticket.status === 'used') {
      return res.status(400).json({
        success: false,
        status: 'used',
        message: '❌ Ticket Already Used',
        ticketId: ticket.id,
        ticketNumber: ticket.ticket_number,
        checkedInAt: ticket.checked_in_at,
        attendeeName: ticket.attendee_name,
      });
    }

    // Checklist 6: Allow entry!
    await pool.execute(
      `UPDATE tickets SET status = 'used', checked_in_at = NOW(), checked_in_by = ? WHERE id = ?`,
      [req.user.id, ticket.id],
    );

    await logAudit({ userId: req.user.id, action: 'check_in_ticket', entityType: 'ticket', entityId: ticket.id });

    res.json({
      success: true,
      status: 'success',
      message: '✅ Valid Ticket — Entry Approved',
      ticket: {
        id: ticket.id,
        ticketNumber: ticket.ticket_number,
        attendeeName: ticket.attendee_name || 'Attendee',
        ticketType: ticket.ticket_type,
        eventTitle: ticket.event_title,
        venue: ticket.event_venue,
        status: 'used',
        checkedInAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[ticketController.checkInTicket]', err);
    res.status(500).json({ message: 'Server error during check-in' });
  }
};

/* ------------------------------------------------------------------ */
/* Transfer a ticket to another user (Full anti-fraud transfer)        */
/* ------------------------------------------------------------------ */
export const transferTicket = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;
    const { recipientEmail, recipientName, recipientPhone } = req.body;
    if (!recipientEmail && !recipientPhone) {
      conn.release();
      return res.status(400).json({ message: 'Recipient name and email or phone number are required' });
    }

    const [ticketRows] = await conn.execute('SELECT * FROM tickets WHERE id = ?', [id]);
    const ticket = ticketRows[0];
    if (!ticket) {
      conn.release();
      return res.status(404).json({ message: 'Ticket not found' });
    }
    if (Number(ticket.user_id) !== Number(req.user.id)) {
      conn.release();
      return res.status(403).json({ message: 'You can only transfer your own tickets' });
    }
    if (ticket.status !== 'active') {
      conn.release();
      return res.status(400).json({ message: `Ticket is ${ticket.status} and cannot be transferred` });
    }

    // Lookup recipient by email or phone
    let recipient = null;
    if (recipientEmail && recipientEmail.trim()) {
      const [emailRows] = await conn.execute('SELECT id, name, email, phone FROM users WHERE email = ?', [recipientEmail.trim()]);
      if (emailRows.length > 0) recipient = emailRows[0];
    }
    if (!recipient && recipientPhone && recipientPhone.trim()) {
      const cleanPhone = recipientPhone.replace(/\s+/g, '');
      const [phoneRows] = await conn.execute('SELECT id, name, email, phone FROM users WHERE phone = ?', [cleanPhone]);
      if (phoneRows.length > 0) recipient = phoneRows[0];
    }

    await conn.beginTransaction();

    // Auto-create attendee account if recipient is not registered yet
    if (!recipient) {
      const targetEmail = (recipientEmail && recipientEmail.trim()) || `${(recipientPhone || 'guest').replace(/\D/g, '')}@tribesandcliqs.app`;
      const targetName = (recipientName && recipientName.trim()) || 'Event Attendee';
      const [newU] = await conn.execute(
        `INSERT INTO users (name, email, phone, role)
         VALUES (?, ?, ?, 'attendee')`,
        [targetName, targetEmail, recipientPhone ? recipientPhone.trim() : null],
      );
      recipient = { id: newU.insertId, name: targetName, email: targetEmail, phone: recipientPhone };
    }

    if (Number(recipient.id) === Number(req.user.id)) {
      await conn.rollback();
      conn.release();
      return res.status(400).json({ message: 'Cannot transfer a ticket to yourself' });
    }

    // 1. Invalidate original ticket and mark as transferred (Old QR code is now invalid)
    await conn.execute(
      `UPDATE tickets SET status = 'transferred', transferred_to = ? WHERE id = ?`,
      [recipient.id, id],
    );

    // 2. Generate BRAND NEW ticket with BRAND NEW QR code and Ticket ID (Kwame blueprint)
    const newNumber = `TRB-${new Date().getFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`;
    const newQrCode = `TRB-QR-${uuidv4()}`;
    const finalAttendeeName = (recipientName && recipientName.trim()) || recipient.name || 'Gift Attendee';

    const [result] = await conn.execute(
      `INSERT INTO tickets
        (order_item_id, user_id, event_id, ticket_type_id, ticket_number, qr_code, seat_number, status, attendee_name, attendee_email, attendee_phone)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      [
        ticket.order_item_id,
        recipient.id,
        ticket.event_id,
        ticket.ticket_type_id,
        newNumber,
        newQrCode,
        ticket.seat_number,
        finalAttendeeName,
        recipient.email,
        recipient.phone || recipientPhone || null,
      ],
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
        title: 'Ticket Received!',
        message: `${senderName} transferred a digital ticket for "${eventTitle}" to you. Access your new ticket and QR code under My Tickets!`,
        type: 'ticket',
      }).catch(() => {});

      sendNotification({
        userId: req.user.id,
        title: 'Ticket Transferred',
        message: `Your ticket for "${eventTitle}" was transferred to ${finalAttendeeName}. Your original QR code has been safely invalidated.`,
        type: 'ticket',
      }).catch(() => {});

      notifyAdmins({
        title: 'Ticket Transferred',
        message: `${senderName} transferred ticket #${ticket.id} (${eventTitle}) to ${finalAttendeeName}.`,
        type: 'ticket',
        link: '/admin/events',
      }).catch(() => {});
    } catch { /* ignore notification errors */ }

    await logAudit({
      userId: req.user.id,
      action: 'transfer_ticket',
      entityType: 'ticket',
      entityId: id,
      details: { from: req.user.id, to: recipient.id, newTicketId: result.insertId, newNumber },
    });

    res.json({
      message: 'Ticket transferred successfully! The old QR code has been invalidated and a new pass issued.',
      newTicketId: result.insertId,
      newTicketNumber: newNumber,
      recipientName: finalAttendeeName,
    });
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
    let { code } = req.params;
    if (!code) return res.status(400).json({ message: 'Ticket code is required' });

    try {
      code = decodeURIComponent(code).trim();
    } catch {
      code = String(code).trim();
    }

    let parsedTicketNumber = code;
    let parsedTicketId = null;
    let parsedQrCode = code;

    // 1. If QR data is a JSON string
    if (code.startsWith('{') && code.endsWith('}')) {
      try {
        const obj = JSON.parse(code);
        parsedTicketNumber = obj.ticketNumber || parsedTicketNumber;
        parsedTicketId = obj.ticketId || obj.id || null;
        parsedQrCode = obj.qrCode || obj.code || parsedQrCode;
      } catch {}
    }

    // 2. If QR data is a URL
    if (code.includes('/')) {
      const parts = code.split('/');
      parsedTicketNumber = parts[parts.length - 1] || parsedTicketNumber;
    }

    const isNumeric = /^\d+$/.test(parsedTicketNumber) || (parsedTicketId && /^\d+$/.test(String(parsedTicketId)));
    const searchId = parsedTicketId ? Number(parsedTicketId) : (isNumeric ? Number(parsedTicketNumber) : null);

    const [rows] = await pool.execute(
      `SELECT t.id, t.user_id, t.ticket_number, t.qr_code, t.seat_number, t.status, t.checked_in_at,
              t.created_at, tt.name AS ticket_type, tt.price AS ticket_price,
              COALESCE(t.attendee_name, u.name) AS attendee_name,
              COALESCE(t.attendee_email, u.email) AS attendee_email,
              COALESCE(t.attendee_phone, u.phone) AS attendee_phone,
              e.id AS event_id, e.title AS event_title, e.venue AS event_venue, e.city AS event_city,
              e.start_date, e.start_time, e.organizer_id, e.banner_image, e.ticket_template,
              o.payment_status, o.total_amount AS order_total
       FROM tickets t
       JOIN ticket_types tt ON tt.id = t.ticket_type_id
       JOIN events e ON e.id = t.event_id
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN order_items oi ON oi.id = t.order_item_id
       LEFT JOIN orders o ON o.id = oi.order_id
       WHERE t.ticket_number = ? OR t.qr_code = ? OR t.ticket_number = ? OR (?::bigint IS NOT NULL AND t.id = ?)`,
      [code, parsedQrCode, parsedTicketNumber, searchId, searchId || 0],
    );
    const ticket = rows[0];
    if (!ticket) {
      return res.status(404).json({
        valid: false,
        status: 'not_found',
        message: '❌ Invalid / Unrecognized Ticket',
      });
    }

    const currentUserId = req.user?.id ? Number(req.user.id) : null;
    const isOrganizer = currentUserId && (Number(ticket.organizer_id) === currentUserId);
    const isStaff = req.user?.role === 'admin' || req.user?.role === 'staff';

    let validationState = 'valid';
    let validationMessage = '✅ Valid Ticket — Entry Approved';

    if (ticket.status === 'used') {
      validationState = 'used';
      validationMessage = '❌ Ticket Already Used';
    } else if (ticket.status === 'cancelled') {
      validationState = 'cancelled';
      validationMessage = '❌ Ticket Cancelled — Entry Denied';
    } else if (ticket.status === 'transferred') {
      validationState = 'transferred';
      validationMessage = '❌ Ticket Transferred — Old QR Code Invalidated';
    } else if (ticket.payment_status && ticket.payment_status !== 'paid' && Number(ticket.order_total) > 0) {
      validationState = 'unpaid';
      validationMessage = '❌ Payment Unconfirmed — Admission Denied';
    }

    res.json({
      valid: validationState === 'valid',
      status: validationState,
      statusMessage: validationMessage,
      canCheckIn: (isOrganizer || isStaff) && validationState === 'valid',
      isOrganizerOrStaff: !!(isOrganizer || isStaff),
      ticket: {
        id: ticket.id,
        ticketId: ticket.id,
        ticketNumber: ticket.ticket_number,
        qrCode: ticket.qr_code,
        status: ticket.status,
        checkedIn: ticket.status === 'used',
        checkedInAt: ticket.checked_in_at,
        attendeeName: ticket.attendee_name || 'Attendee',
        attendeeEmail: ticket.attendee_email,
        attendeePhone: ticket.attendee_phone,
        ticketType: ticket.ticket_type,
        price: ticket.ticket_price,
        seatNumber: ticket.seat_number || 'General Admission',
        createdAt: ticket.created_at,
        event: {
          id: ticket.event_id,
          title: ticket.event_title,
          venue: ticket.event_venue,
          city: ticket.event_city,
          startDate: ticket.start_date,
          startTime: ticket.start_time,
          bannerImage: ticket.banner_image,
          ticketTemplate: ticket.ticket_template,
        },
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
      if (Number(ticket.organizer_id) !== Number(req.user.id) && req.user.role !== 'admin') {
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
