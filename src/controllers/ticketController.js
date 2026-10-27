import { v4 as uuidv4 } from 'uuid';
import pool from '../config/db.js';
import { logAudit } from '../utils/audit.js';
import textPdf from '../utils/pdf.js';
import { sendNotification, notifyAdmins } from '../utils/notify.js';
import { sendTicketTransferEmail, sendGateCheckInAlertEmail } from '../utils/email.js';
import { sendSMS } from '../utils/sms.js';
import { completeOrder, generateTicketsForOrder } from './orderController.js';

/* ------------------------------------------------------------------ */
/* Get ticket types for an event (public)                              */
/* ------------------------------------------------------------------ */
export const getTicketTypes = async (req, res) => {
  try {
    const { eventId } = req.params;
    if (!eventId || eventId === 'undefined' || eventId === 'null' || isNaN(Number(eventId))) {
      return res.json([]);
    }
    let [rows] = await pool.execute(
      `SELECT * FROM ticket_types WHERE event_id = ? ORDER BY price ASC`,
      [Number(eventId)],
    );

    // Return empty array if no ticket types configured yet
    if (!rows) rows = [];

    for (const tt of (rows || [])) {
      tt.saleStartDate = tt.sale_start;
      tt.saleEndDate = tt.sale_end;
      tt.image = tt.image || null;
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

      // Compute ticket monitoring breakdown (Kwame Blueprint Sec. 17)
      try {
        const [statusRows] = await pool.execute(
          `SELECT 
             COUNT(CASE WHEN t.status IN ('active', 'used') THEN 1 END) AS sold_count,
             COUNT(CASE WHEN t.status = 'cancelled' THEN 1 END) AS cancelled_count
           FROM tickets t WHERE t.ticket_type_id = ?`,
          [tt.id],
        );
        const [orderRows] = await pool.execute(
          `SELECT 
             COUNT(CASE WHEN o.payment_status = 'refunded' OR o.order_status = 'refunded' THEN 1 END) AS refunded_count,
             COUNT(CASE WHEN o.payment_status = 'pending' THEN 1 END) AS reserved_count,
             COALESCE(SUM(CASE WHEN o.payment_status = 'completed' THEN oi.subtotal ELSE 0 END), 0) AS actual_revenue
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           WHERE oi.ticket_type_id = ?`,
          [tt.id],
        );

        const sold = Math.max(Number(tt.quantity_sold) || 0, Number(statusRows?.[0]?.sold_count) || 0);
        const total = Number(tt.quantity) || 0;
        const remaining = Math.max(0, total - sold);
        const reserved = Number(orderRows?.[0]?.reserved_count) || 0;
        const cancelled = Number(statusRows?.[0]?.cancelled_count) || 0;
        const refunded = Number(orderRows?.[0]?.refunded_count) || 0;
        const rev = Number(orderRows?.[0]?.actual_revenue) > 0 ? Number(orderRows[0].actual_revenue) : (sold * (Number(tt.price) || 0));

        tt.total = total;
        tt.sold = sold;
        tt.remaining = remaining;
        tt.reserved = reserved;
        tt.cancelled = cancelled;
        tt.refunded = refunded;
        tt.revenue = rev;
      } catch {
        const sold = Number(tt.quantity_sold) || 0;
        const total = Number(tt.quantity) || 0;
        tt.total = total;
        tt.sold = sold;
        tt.remaining = Math.max(0, total - sold);
        tt.reserved = 0;
        tt.cancelled = 0;
        tt.refunded = 0;
        tt.revenue = sold * (Number(tt.price) || 0);
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
      name, price, quantity, description,
      early_bird_price, early_bird_deadline, early_bird_max_qty, section_type, perks,
    } = req.body;

    const sale_start = req.body.sale_start || req.body.saleStartDate || req.body.sale_start_date || null;
    const sale_end = req.body.sale_end || req.body.saleEndDate || req.body.sale_end_date || null;
    let image = req.body.image || req.body.imageUrl || req.body.image_url || req.body.ticket_image || null;

    const uploadedList = Array.isArray(req.body.uploadedTickets) || Array.isArray(req.body.uploaded_tickets)
      ? (req.body.uploadedTickets || req.body.uploaded_tickets)
      : [];

    if ((!image || image.startsWith('/assets/')) && uploadedList.length > 0) {
      const firstImg = uploadedList.find((u) => {
        const f = (u.file_name || u.file_url || u.url || '').toLowerCase();
        return f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.png') || f.endsWith('.webp');
      });
      if (firstImg) {
        image = firstImg.file_url || firstImg.url;
      }
    }

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

    // Kwame Blueprint / System Rule: An event must be approved by admin before a ticket can be created
    if (event.approval_status !== 'approved') {
      return res.status(400).json({
        message: 'Tickets cannot be created because this event has not yet been approved by an administrator.',
        approval_status: event.approval_status,
      });
    }

    const [result] = await pool.execute(
      `INSERT INTO ticket_types (
        event_id, name, price, quantity, quantity_sold, sale_start, sale_end, description,
        early_bird_price, early_bird_deadline, early_bird_max_qty, section_type, perks, image
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId, name, finalPrice, finalQuantity,
        sale_start || null, sale_end || null, description || null,
        early_bird_price !== undefined && early_bird_price !== '' ? early_bird_price : null,
        early_bird_deadline || null,
        early_bird_max_qty || null,
        section_type || 'general',
        perks ? JSON.stringify(perks) : null,
        image || null,
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

    // If the parent event has no custom banner or only has a placeholder, sync with this real uploaded image
    if (image && !image.startsWith('/assets/')) {
      if (!event.banner_image || event.banner_image.startsWith('/assets/')) {
        await pool.execute('UPDATE events SET banner_image = ? WHERE id = ?', [image, eventId]);
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

    if (req.body.saleStartDate !== undefined && req.body.sale_start === undefined) {
      req.body.sale_start = req.body.saleStartDate || null;
    }
    if (req.body.sale_start_date !== undefined && req.body.sale_start === undefined) {
      req.body.sale_start = req.body.sale_start_date || null;
    }
    if (req.body.saleEndDate !== undefined && req.body.sale_end === undefined) {
      req.body.sale_end = req.body.saleEndDate || null;
    }
    if (req.body.sale_end_date !== undefined && req.body.sale_end === undefined) {
      req.body.sale_end = req.body.sale_end_date || null;
    }
    if (req.body.imageUrl !== undefined && req.body.image === undefined) {
      req.body.image = req.body.imageUrl || null;
    }
    if (req.body.image_url !== undefined && req.body.image === undefined) {
      req.body.image = req.body.image_url || null;
    }
    if (req.body.ticket_image !== undefined && req.body.image === undefined) {
      req.body.image = req.body.ticket_image || null;
    }

    if ((!req.body.image || req.body.image.startsWith('/assets/')) && uploadedList.length > 0) {
      const firstImg = uploadedList.find((u) => {
        const f = (u.file_name || u.file_url || u.url || '').toLowerCase();
        return f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.png') || f.endsWith('.webp');
      });
      if (firstImg) {
        req.body.image = firstImg.file_url || firstImg.url;
      }
    }

    const allowed = [
      'name', 'price', 'quantity', 'sale_start', 'sale_end', 'description',
      'early_bird_price', 'early_bird_deadline', 'early_bird_max_qty', 'section_type', 'perks', 'image',
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
      const [cntRows] = await pool.execute(
        'SELECT COUNT(*) AS count_uploaded FROM uploaded_tickets WHERE ticket_type_id = ?',
        [id]
      );
      const countUploaded = Number(cntRows[0]?.count_uploaded ?? cntRows[0]?.countuploaded ?? cntRows[0]?.countUploaded ?? 0);
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

    // If a real image exists on the ticket, and the parent event has no custom banner or has a placeholder, sync it
    const finalImage = req.body.image || tt.image;
    if (finalImage && !finalImage.startsWith('/assets/')) {
      const [parentEventRows] = await pool.execute('SELECT banner_image FROM events WHERE id = ?', [tt.event_id]);
      const parentEvt = parentEventRows[0];
      if (parentEvt && (!parentEvt.banner_image || parentEvt.banner_image.startsWith('/assets/'))) {
        await pool.execute('UPDATE events SET banner_image = ? WHERE id = ?', [finalImage, tt.event_id]);
      }
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
    // 0. Auto-verify any recent pending orders for this user with Paystack.
    // If the user completed payment via mobile money / card / browser callback,
    // this ensures the order is completed and tickets are minted immediately.
    try {
      const [pendingOrders] = await pool.execute(
        `SELECT id, payment_reference
         FROM orders
         WHERE user_id = ? AND payment_status = 'pending' AND payment_reference IS NOT NULL
         ORDER BY id DESC LIMIT 5`,
        [req.user.id],
      );

      for (const po of pendingOrders) {
        if (!po.payment_reference) continue;
        try {
          const vRes = await verifyTransaction(po.payment_reference);
          if (vRes?.status && vRes.data?.status === 'success') {
            await completeOrder(po.id, po.payment_reference);
          }
        } catch {
          // If transaction is still in progress, continue without failing
        }
      }
    } catch (pendingErr) {
      console.warn('[ticketController.getUserTickets] Pending check notice:', pendingErr.message);
    }

    // 1. Self-healing: ensure tickets are minted strictly without duplication
    try {
      const [completedOrders] = await pool.execute(
        `SELECT o.id FROM orders o WHERE o.user_id = ? AND o.payment_status = 'completed'`,
        [req.user.id],
      );

      for (const ord of completedOrders) {
        await generateTicketsForOrder(ord.id);
      }

      // 2. Prune any historic duplicates created by concurrent webhooks/callbacks
      await pool.execute(`
        DELETE FROM tickets 
        WHERE id IN (
          SELECT id FROM (
            SELECT t.id,
                   ROW_NUMBER() OVER (PARTITION BY t.order_item_id ORDER BY t.id ASC) as rn,
                   oi.quantity
            FROM tickets t
            JOIN order_items oi ON oi.id = t.order_item_id
            WHERE t.user_id = ? AND t.status = 'active'
          ) sub
          WHERE sub.rn > sub.quantity
        )
      `, [req.user.id]);
    } catch (healErr) {
      console.warn('[ticketController.getUserTickets] Auto-heal/dedup notice:', healErr.message);
    }

    // Auto-claim any tickets transferred to the logged-in user's email or phone
    if (req.user?.email) {
      try {
        await pool.execute(
          `UPDATE tickets 
           SET user_id = ? 
           WHERE (
             LOWER(attendee_email) = LOWER(?)
             OR (attendee_phone IS NOT NULL AND attendee_phone != '' AND attendee_phone = ?)
           )
           AND status = 'active'
           AND user_id != ?`,
          [req.user.id, req.user.email.trim(), req.user.phone || '', req.user.id],
        );
      } catch (claimErr) {
        console.warn('[ticketController.getUserTickets] Auto-claim notice:', claimErr.message);
      }
    }

    const statusFilter = req.query.status ? String(req.query.status).toLowerCase().trim() : null;
    let statusCondition = "AND t.status != 'transferred'";
    const queryParams = [req.user.id];

    if (statusFilter && statusFilter !== 'all') {
      statusCondition += ' AND t.status = ?';
      queryParams.push(statusFilter);
    }

    const [rows] = await pool.execute(
      `SELECT t.*, tt.name AS ticket_type_name, tt.price AS ticket_price,
              COALESCE(oi.unit_price, tt.price, 0) AS unit_price,
              COALESCE(oi.unit_price, tt.price, 0) AS price,
              e.title AS event_title, e.venue AS event_venue, e.city AS event_city,
              e.start_date, e.end_date, e.start_time, e.end_time, e.status AS event_status,
              e.banner_image, e.ticket_template,
              COALESCE(t.attendee_name, u.name) AS attendee_name,
              COALESCE(t.attendee_email, u.email) AS attendee_email,
              COALESCE(t.attendee_phone, u.phone) AS attendee_phone,
              CASE WHEN t.order_item_id IS NULL OR (o.user_id IS NOT NULL AND o.user_id != t.user_id) THEN 1 ELSE 0 END AS is_transferred_to_me,
              o.id AS order_id, o.payment_reference, o.payment_method, o.payment_status,
              o.invoice_number, o.discount_amount AS order_discount, o.total_amount AS order_total,
              o.created_at AS order_created_at
       FROM tickets t
       LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
       LEFT JOIN order_items oi ON oi.id = t.order_item_id
       LEFT JOIN orders o ON o.id = oi.order_id
       LEFT JOIN events e ON e.id = t.event_id
       LEFT JOIN users u ON u.id = t.user_id
       WHERE t.user_id = ? AND (t.is_deleted_by_user IS NULL OR t.is_deleted_by_user = FALSE) ${statusCondition}
       ORDER BY t.created_at DESC`,
      queryParams,
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

    if (ticket.is_deleted_by_user && !isOrganizer && !isStaff) {
      return res.status(404).json({ message: 'Ticket not found or has been deleted from history' });
    }

    res.json({ ticket });
  } catch (err) {
    console.error('[ticketController.getTicketById]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Delete / Remove an old ticket from user history (attendee)          */
/* ------------------------------------------------------------------ */
export const deleteUserTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const [rows] = await pool.execute(
      `SELECT t.*, e.title AS event_title, e.start_date, e.end_date, e.start_time, e.end_time
       FROM tickets t
       JOIN events e ON e.id = t.event_id
       WHERE t.id = ? AND t.user_id = ?`,
      [id, userId]
    );

    const ticket = rows[0];
    if (!ticket) {
      return res.status(404).json({ message: 'Ticket not found or does not belong to your account' });
    }

    if (ticket.is_deleted_by_user) {
      return res.json({ success: true, message: 'Ticket is already deleted from your history' });
    }

    // Determine if this ticket is old (event ended or ticket status is non-active)
    const now = new Date();
    let isPastEvent = false;
    const dateStr = ticket.end_date || ticket.start_date;
    if (dateStr) {
      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) {
        const timeStr = ticket.end_time || ticket.start_time;
        if (timeStr && typeof timeStr === 'string') {
          const parts = timeStr.split(':');
          if (parts.length >= 2) {
            d.setHours(parseInt(parts[0], 10), parseInt(parts[1], 10), 0, 0);
          }
        } else {
          d.setHours(23, 59, 59, 999);
        }
        if (d < now) isPastEvent = true;
      }
    }

    const statusLower = String(ticket.status || '').toLowerCase();
    const isNonActiveStatus = ['used', 'cancelled', 'transferred', 'refunded', 'void'].includes(statusLower) || Boolean(ticket.is_used);

    // If active ticket for future event, block accidental deletion unless explicitly forced
    if (!isPastEvent && !isNonActiveStatus && req.query.force !== 'true') {
      return res.status(400).json({
        message: 'Only past or used tickets can be deleted from your history. Active tickets for upcoming events cannot be deleted.',
      });
    }

    // Soft delete: remove from user view while preserving financial / event records
    await pool.execute(
      `UPDATE tickets SET is_deleted_by_user = TRUE, deleted_at = NOW() WHERE id = ? AND user_id = ?`,
      [id, userId]
    );

    await logAudit({
      userId,
      action: 'delete_ticket_history',
      entityType: 'ticket',
      entityId: id,
      details: { ticketNumber: ticket.ticket_number, eventTitle: ticket.event_title },
    });

    res.json({
      success: true,
      message: 'Ticket successfully removed from your history',
      ticketId: Number(id),
    });
  } catch (err) {
    console.error('[ticketController.deleteUserTicket]', err);
    res.status(500).json({ message: 'Server error deleting ticket' });
  }
};

/* ------------------------------------------------------------------ */
/* Bulk Clear all old (past / used / cancelled) tickets for attendee   */
/* ------------------------------------------------------------------ */
export const clearOldTickets = async (req, res) => {
  try {
    const userId = req.user.id;

    const [rows] = await pool.execute(
      `SELECT t.id, t.status, e.start_date, e.end_date, e.start_time, e.end_time
       FROM tickets t
       JOIN events e ON e.id = t.event_id
       WHERE t.user_id = ? AND (t.is_deleted_by_user IS NULL OR t.is_deleted_by_user = FALSE)`,
      [userId]
    );

    const now = new Date();
    const oldIds = [];

    for (const ticket of rows) {
      let isPastEvent = false;
      const dateStr = ticket.end_date || ticket.start_date;
      if (dateStr) {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) {
          const timeStr = ticket.end_time || ticket.start_time;
          if (timeStr && typeof timeStr === 'string') {
            const parts = timeStr.split(':');
            if (parts.length >= 2) {
              d.setHours(parseInt(parts[0], 10), parseInt(parts[1], 10), 0, 0);
            }
          } else {
            d.setHours(23, 59, 59, 999);
          }
          if (d < now) isPastEvent = true;
        }
      }

      const statusLower = String(ticket.status || '').toLowerCase();
      const isNonActive = ['used', 'cancelled', 'transferred', 'refunded', 'void'].includes(statusLower);

      if (isPastEvent || isNonActive) {
        oldIds.push(ticket.id);
      }
    }

    if (oldIds.length === 0) {
      return res.json({
        success: true,
        message: 'No past or used tickets found to clear',
        clearedCount: 0,
        deletedIds: [],
      });
    }

    const placeholders = oldIds.map(() => '?').join(', ');
    await pool.execute(
      `UPDATE tickets SET is_deleted_by_user = TRUE, deleted_at = NOW() WHERE id IN (${placeholders}) AND user_id = ?`,
      [...oldIds, userId]
    );

    await logAudit({
      userId,
      action: 'clear_old_tickets_history',
      entityType: 'ticket',
      details: { count: oldIds.length, ids: oldIds },
    });

    res.json({
      success: true,
      message: `Successfully cleared ${oldIds.length} old ticket pass${oldIds.length > 1 ? 'es' : ''}`,
      clearedCount: oldIds.length,
      deletedIds: oldIds,
    });
  } catch (err) {
    console.error('[ticketController.clearOldTickets]', err);
    res.status(500).json({ message: 'Server error clearing old tickets' });
  }
};

/* ------------------------------------------------------------------ */
/* Check-in a ticket (organizer / staff / inspector)                   */
/* ------------------------------------------------------------------ */
export const checkInTicket = async (req, res) => {
  try {
    let id = req.params.id || req.params.code || req.body?.code || req.body?.ticketId || req.body?.id;
    if (!id) return res.status(400).json({ success: false, status: 'error', message: 'Ticket identifier is required' });

    try {
      id = decodeURIComponent(id).trim();
    } catch {
      id = String(id).trim();
    }

    // 1. Extract ticket code from JSON payload if present
    if (id.startsWith('{') && id.endsWith('}')) {
      try {
        const parsed = JSON.parse(id);
        id = parsed.ticket_number || parsed.ticketNumber || parsed.ticket_code || parsed.qr_code || parsed.qrCode || parsed.ticketId || parsed.id || id;
      } catch {}
    }

    // 2. Direct regex extraction for ticket numbers like TC-XXXXXX or TRB-XXXXXX
    const codeMatch = String(id).match(/\b(TC-[A-Z0-9]+|TRB-[A-Z0-9-]+)\b/i);
    let candidateCode = codeMatch ? codeMatch[1].toUpperCase() : id;

    // 3. If payload is a URL (e.g. from web or print preview)
    if (candidateCode.includes('/') || candidateCode.includes('?')) {
      try {
        const urlStr = candidateCode.startsWith('http') ? candidateCode : `https://dummy.com/${candidateCode.replace(/^\/+/, '')}`;
        const u = new URL(urlStr);
        const queryCode = u.searchParams.get('code') || u.searchParams.get('ticket') || u.searchParams.get('ticketNumber') || u.searchParams.get('reference') || u.searchParams.get('trxref');
        if (queryCode) {
          candidateCode = queryCode.trim();
        } else {
          const parts = u.pathname.split('/').filter(Boolean);
          const last = parts.pop();
          if (last) candidateCode = last.split('?')[0].trim();
        }
      } catch {
        const parts = candidateCode.split('/').filter(Boolean);
        const last = parts.pop() || candidateCode;
        candidateCode = last.split('?')[0].trim();
      }
    }

    const cleanCode = candidateCode.trim();
    const isNumeric = /^\d+$/.test(cleanCode);
    const searchId = isNumeric ? Number(cleanCode) : 0;

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
       WHERE UPPER(t.ticket_number) = UPPER(?) 
          OR UPPER(t.qr_code) = UPPER(?) 
          OR UPPER(t.ticket_number) = UPPER(?)
          OR (?::bigint > 0 AND t.id = ?)`,
      [cleanCode, cleanCode, id, searchId, searchId],
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

    // Checklist 2: Is payment confirmed? (Support 'completed', 'paid', 'successful', 'success')
    const paymentStatusClean = String(ticket.payment_status || '').toLowerCase().trim();
    const isPaid = !paymentStatusClean || ['paid', 'completed', 'successful', 'success'].includes(paymentStatusClean);
    if (!isPaid && Number(ticket.order_total) > 0) {
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

    // Send immediate gate admission confirmation email
    if (ticket.attendee_email) {
      sendGateCheckInAlertEmail({
        to: ticket.attendee_email,
        attendeeName: ticket.attendee_name || 'Attendee',
        eventTitle: ticket.event_title,
        ticketNumber: ticket.ticket_number,
        tier: ticket.ticket_type || 'General Admission',
        checkedInAt: new Date(),
      }).catch((err) =>
        console.warn('[ticketController.checkInTicket] Gate check-in email alert notice:', err.message)
      );
    }

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
/* Real-time check-in stats & scan history for Organizer & Admin      */
/* ------------------------------------------------------------------ */
export const getCheckInStats = async (req, res) => {
  try {
    const userId = Number(req.user.id);
    const isAdmin = req.user.role === 'admin' || req.user.role === 'system_admin' || req.user.role === 'staff';
    const { eventId } = req.query;

    const hasSpecificEvent = eventId && eventId !== 'all';
    const eventNum = hasSpecificEvent ? Number(eventId) : 0;

    let statsSql = `
      SELECT 
        COUNT(*) AS total_tickets,
        COALESCE(SUM(CASE WHEN t.status = 'used' OR t.checked_in_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS admitted_count,
        COALESCE(SUM(CASE WHEN t.status = 'active' AND t.checked_in_at IS NULL THEN 1 ELSE 0 END), 0) AS remaining_count
      FROM tickets t
      JOIN events e ON e.id = t.event_id
      WHERE 1=1
    `;
    const statsParams = [];

    if (!isAdmin) {
      statsSql += ` AND e.organizer_id = ?`;
      statsParams.push(userId);
    }
    if (hasSpecificEvent) {
      statsSql += ` AND t.event_id = ?`;
      statsParams.push(eventNum);
    }

    const [statsRows] = await pool.execute(statsSql, statsParams);
    const stats = statsRows[0] || { total_tickets: 0, admitted_count: 0, remaining_count: 0 };

    let historySql = `
      SELECT t.id, t.ticket_number, t.checked_in_at, tt.name AS tier,
             COALESCE(t.attendee_name, u.name, 'Attendee') AS attendee,
             e.title AS event_title
      FROM tickets t
      JOIN events e ON e.id = t.event_id
      LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
      WHERE (t.status = 'used' OR t.checked_in_at IS NOT NULL)
    `;
    const historyParams = [];

    if (!isAdmin) {
      historySql += ` AND e.organizer_id = ?`;
      historyParams.push(userId);
    }
    if (hasSpecificEvent) {
      historySql += ` AND t.event_id = ?`;
      historyParams.push(eventNum);
    }

    historySql += ` ORDER BY t.checked_in_at DESC LIMIT 15`;

    const [historyRows] = await pool.execute(historySql, historyParams);

    res.json({
      success: true,
      stats: {
        totalTickets: Number(stats.total_tickets || 0),
        admitted: Number(stats.admitted_count || 0),
        remaining: Number(stats.remaining_count || 0),
      },
      recentScans: historyRows.map((r) => ({
        id: r.id,
        code: r.ticket_number,
        attendee: r.attendee,
        tier: r.tier || 'General',
        status: 'approved',
        eventTitle: r.event_title,
        time: r.checked_in_at
          ? new Date(r.checked_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          : 'Admitted',
      })),
    });
  } catch (err) {
    console.error('[ticketController.getCheckInStats]', err);
    res.status(500).json({ message: 'Server error loading check-in stats' });
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
      const [eventRows] = await pool.execute(
        'SELECT title, venue, city, start_date, start_time FROM events WHERE id = ?',
        [ticket.event_id],
      );
      const [tierRows] = await pool.execute(
        'SELECT name FROM ticket_types WHERE id = ?',
        [ticket.ticket_type_id],
      );
      const ev = eventRows[0] || {};
      const eventTitle = ev.title || 'your event';
      const senderName = req.user.name || req.user.email || 'A friend';
      const eventDate = ev.start_date
        ? `${new Date(ev.start_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}${ev.start_time ? ` at ${ev.start_time}` : ''}`
        : 'Upcoming';
      const eventVenue = [ev.venue, ev.city].filter(Boolean).join(', ') || 'Venue TBA';
      const frontendUrl = (process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/+$/, '');

      // 1. In-app notification to recipient
      sendNotification({
        userId: recipient.id,
        title: 'Ticket Received! ',
        message: `${senderName} transferred a digital ticket for "${eventTitle}" to you. Access your new ticket and QR code under My Tickets!`,
        type: 'ticket',
      }).catch(() => {});

      // 2. Email notification to recipient
      const targetEmail = recipient.email || recipientEmail;
      if (targetEmail && targetEmail.includes('@') && !targetEmail.endsWith('@tribesandcliqs.app')) {
        sendTicketTransferEmail({
          to: targetEmail,
          recipientName: finalAttendeeName,
          senderName,
          eventTitle,
          ticketNumber: newNumber,
          ticketTier: tierRows[0]?.name || 'General Admission',
          venue: eventVenue,
          eventDate,
          ticketUrl: `${frontendUrl}/my-tickets`,
        }).catch((err) => console.warn('[transferTicket] Email failed:', err.message));
      }

      // 3. SMS notification to recipient if phone provided
      const targetPhone = recipient.phone || recipientPhone;
      if (targetPhone) {
        sendSMS(
          targetPhone,
          `Tribes & Cliqs: ${senderName} sent you a ticket for "${eventTitle}"! Ticket #${newNumber}. Access your QR pass at ${frontendUrl}/my-tickets`
        ).catch((err) => console.warn('[transferTicket] SMS failed:', err.message));
      }

      // 4. In-app notification to sender
      sendNotification({
        userId: req.user.id,
        title: 'Ticket Transferred',
        message: `Your ticket for "${eventTitle}" was transferred to ${finalAttendeeName}. Your original QR code has been safely invalidated.`,
        type: 'ticket',
      }).catch(() => {});

      // 5. Admin notification
      notifyAdmins({
        title: 'Ticket Transferred',
        message: `${senderName} transferred ticket #${ticket.id} (${eventTitle}) to ${finalAttendeeName}.`,
        type: 'ticket',
        link: '/admin/events',
      }).catch(() => {});
    } catch (notifErr) {
      console.warn('[transferTicket] Notification notice:', notifErr.message);
    }

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

    // Direct regex extraction for ticket numbers like TC-XXXXXX or TRB-XXXXXX
    const codeMatch = String(code).match(/\b(TC-[A-Z0-9]+|TRB-[A-Z0-9-]+)\b/i);
    if (codeMatch) {
      parsedTicketNumber = codeMatch[1].toUpperCase();
    }

    const cleanSearchCode = parsedTicketNumber.trim();

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
       WHERE UPPER(t.ticket_number) = UPPER(?) 
          OR UPPER(t.qr_code) = UPPER(?) 
          OR UPPER(t.ticket_number) = UPPER(?)
          OR UPPER(t.ticket_number) = UPPER(?)
          OR (?::bigint > 0 AND t.id = ?)`,
      [code, parsedQrCode, cleanSearchCode, parsedTicketNumber, searchId || 0, searchId || 0],
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

    const paymentStatusClean = String(ticket.payment_status || '').toLowerCase().trim();
    const isPaid = !paymentStatusClean || ['paid', 'completed', 'successful', 'success'].includes(paymentStatusClean);

    if (ticket.status === 'used') {
      validationState = 'used';
      validationMessage = 'Ticket Already Used';
    } else if (ticket.status === 'cancelled') {
      validationState = 'cancelled';
      validationMessage = ' Ticket Cancelled — Entry Denied';
    } else if (ticket.status === 'transferred') {
      validationState = 'transferred';
      validationMessage = ' Ticket Transferred — Old QR Code Invalidated';
    } else if (!isPaid && Number(ticket.order_total) > 0) {
      validationState = 'unpaid';
      validationMessage = ' Payment Unconfirmed — Admission Denied';
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
      `SELECT t.*, tt.name AS ticket_type_name, tt.price AS ticket_price,
              COALESCE(oi.unit_price, tt.price, 0) AS unit_price,
              e.title AS event_title, e.venue AS event_venue, e.city AS event_city,
              e.start_date, e.end_date, e.start_time, e.end_time, e.status AS event_status,
              e.banner_image, e.ticket_template,
              COALESCE(t.attendee_name, u.name) AS attendee_name,
              COALESCE(t.attendee_email, u.email) AS attendee_email,
              COALESCE(t.attendee_phone, u.phone) AS attendee_phone,
              u.name AS owner_name, u.email AS owner_email,
              o.id AS order_id, o.payment_reference, o.payment_method, o.payment_status,
              o.invoice_number, o.discount_amount AS order_discount, o.total_amount AS order_total,
              o.created_at AS order_created_at
       FROM tickets t
       LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
       LEFT JOIN order_items oi ON oi.id = t.order_item_id
       LEFT JOIN orders o ON o.id = oi.order_id
       LEFT JOIN events e ON e.id = t.event_id
       LEFT JOIN users u ON u.id = t.user_id
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
  verifyTicketByCode, bulkCheckIn, downloadTicket, deleteUserTicket, clearOldTickets,
  getCheckInStats,
};

