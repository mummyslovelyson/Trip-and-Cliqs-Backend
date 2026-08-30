import { v4 as uuidv4 } from 'uuid';
import pool from '../config/db.js';
import { logAudit } from '../utils/audit.js';
import { sendNotification, notifyAdmins } from '../utils/notify.js';
import { initializeTransaction } from '../utils/paystack.js';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const decorate = (l) => ({
  id: l.id,
  ticketId: l.ticket_id,
  sellerId: l.seller_id,
  seller: l.seller_name ? { id: l.seller_id, name: l.seller_name, avatar: l.seller_avatar } : null,
  eventId: l.event_id,
  eventTitle: l.event_title,
  ticketTypeId: l.ticket_type_id,
  ticketTypeName: l.ticket_type_name,
  price: Number(l.price),
  status: l.status,
  soldTo: l.sold_to,
  soldAt: l.sold_at,
  createdAt: l.created_at,
});

const getTicketWithEvent = async (ticketId) => {
  const [rows] = await pool.execute(
    `SELECT t.*, e.title AS event_title, e.start_date, e.start_time, e.status AS event_status
     FROM tickets t JOIN events e ON e.id = t.event_id
     WHERE t.id = ?`,
    [ticketId],
  );
  return rows[0];
};

/* ------------------------------------------------------------------ */
/* List active resale listings for an event (public)                   */
/* ------------------------------------------------------------------ */
export const getEventResale = async (req, res) => {
  try {
    const eventId = Number(req.params.eventId);
    const [rows] = await pool.execute(
      `SELECT rl.*, u.name AS seller_name, u.avatar AS seller_avatar,
              tt.name AS ticket_type_name, e.title AS event_title
       FROM resale_listings rl
       JOIN users u ON u.id = rl.seller_id
       JOIN ticket_types tt ON tt.id = rl.ticket_type_id
       JOIN events e ON e.id = rl.event_id
       WHERE rl.event_id = ? AND rl.status = 'active'
       ORDER BY rl.created_at ASC`,
      [eventId],
    );
    res.json({ listings: rows.map(decorate) });
  } catch (err) {
    console.error('[resaleController.getEventResale]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* My resale listings                                                  */
/* ------------------------------------------------------------------ */
export const getMyResale = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT rl.*, tt.name AS ticket_type_name, e.title AS event_title
       FROM resale_listings rl
       JOIN ticket_types tt ON tt.id = rl.ticket_type_id
       JOIN events e ON e.id = rl.event_id
       WHERE rl.seller_id = ?
       ORDER BY rl.created_at DESC`,
      [req.user.id],
    );
    res.json({ listings: rows.map(decorate) });
  } catch (err) {
    console.error('[resaleController.getMyResale]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Create a resale listing                                             */
/* ------------------------------------------------------------------ */
export const createResaleListing = async (req, res) => {
  try {
    const { ticketId, price } = req.body;
    if (!ticketId) return res.status(400).json({ message: 'ticketId is required' });
    const listPrice = Number(price);
    if (!Number.isFinite(listPrice) || listPrice <= 0) {
      return res.status(400).json({ message: 'Enter a valid price greater than zero' });
    }

    const ticket = await getTicketWithEvent(ticketId);
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    if (ticket.user_id !== req.user.id) {
      return res.status(403).json({ message: 'You can only list your own tickets' });
    }
    if (ticket.status !== 'active') {
      return res.status(400).json({ message: `Ticket is ${ticket.status} and cannot be listed for resale` });
    }

    // Can't resell a ticket for an event that already happened.
    if (ticket.start_date) {
      const start = new Date(ticket.start_date);
      if (start.getTime() < Date.now()) {
        return res.status(400).json({ message: 'This event has already started and cannot be resold' });
      }
    }

    const [dup] = await pool.execute(
      `SELECT id FROM resale_listings WHERE ticket_id = ? AND status = 'active'`,
      [ticketId],
    );
    if (dup.length) return res.status(400).json({ message: 'This ticket is already listed for resale' });

    const [result] = await pool.execute(
      `INSERT INTO resale_listings (ticket_id, seller_id, event_id, ticket_type_id, price)
       VALUES (?, ?, ?, ?, ?)`,
      [ticketId, req.user.id, ticket.event_id, ticket.ticket_type_id, listPrice],
    );

    await logAudit({
      userId: req.user.id,
      action: 'create_resale_listing',
      entityType: 'resale_listing',
      entityId: result.insertId,
      details: { ticketId, eventId: ticket.event_id, price: listPrice },
    });

    notifyAdmins({
      title: '🏷️ New Ticket Resale Listed',
      message: `User "${req.user.name || 'User'}" listed a ticket for "${ticket.event_title || 'Event'}" at GHS ${listPrice}.`,
      type: 'ticket',
      link: '/admin/events',
    }).catch(() => {});

    res.status(201).json({ message: 'Ticket listed for resale', listingId: result.insertId });
  } catch (err) {
    console.error('[resaleController.createResaleListing]', err);
    res.status(500).json({ message: 'Server error creating listing' });
  }
};

/* ------------------------------------------------------------------ */
/* Cancel a resale listing (seller or admin)                           */
/* ------------------------------------------------------------------ */
export const cancelResaleListing = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute('SELECT * FROM resale_listings WHERE id = ?', [id]);
    const listing = rows[0];
    if (!listing) return res.status(404).json({ message: 'Listing not found' });
    if (listing.seller_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'You can only cancel your own listings' });
    }
    if (listing.status !== 'active') {
      return res.status(400).json({ message: `Listing is already ${listing.status}` });
    }

    await pool.execute(`UPDATE resale_listings SET status = 'cancelled' WHERE id = ?`, [id]);

    await logAudit({
      userId: req.user.id,
      action: 'cancel_resale_listing',
      entityType: 'resale_listing',
      entityId: id,
    });

    res.json({ message: 'Listing cancelled', listingId: id });
  } catch (err) {
    console.error('[resaleController.cancelResaleListing]', err);
    res.status(500).json({ message: 'Server error cancelling listing' });
  }
};

/* ------------------------------------------------------------------ */
/* Purchase a resale listing                                           */
/* Creates a pending order and returns the Paystack authorization URL. */
/* When payment completes (webhook / verify), the ticket is transferred */
/* and the listing marked sold via finalizeResalePurchase().            */
/* ------------------------------------------------------------------ */
export const purchaseResaleListing = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute(
      `SELECT rl.*, e.title AS event_title
       FROM resale_listings rl JOIN events e ON e.id = rl.event_id
       WHERE rl.id = ?`,
      [id],
    );
    const listing = rows[0];
    if (!listing) return res.status(404).json({ message: 'Listing not found' });
    if (listing.status !== 'active') {
      return res.status(400).json({ message: `Listing is no longer available (${listing.status})` });
    }
    if (listing.seller_id === req.user.id) {
      return res.status(400).json({ message: 'You cannot buy your own listing' });
    }

    // The seller's ticket must still be active and owned by the seller.
    const ticket = await getTicketWithEvent(listing.ticket_id);
    if (!ticket || ticket.status !== 'active' || ticket.user_id !== listing.seller_id) {
      return res.status(400).json({ message: 'This ticket is no longer available' });
    }
    if (ticket.start_date) {
      const start = new Date(ticket.start_date);
      if (start.getTime() < Date.now()) {
        return res.status(400).json({ message: 'This event has already started' });
      }
    }

    const reference = `TC-${uuidv4().split('-')[0].toUpperCase()}`;
    const [orderResult] = await pool.execute(
      `INSERT INTO orders (user_id, event_id, total_amount, payment_method, payment_status, payment_reference, resale_listing_id)
       VALUES (?, ?, ?, 'paystack', 'pending', ?, ?)`,
      [req.user.id, listing.event_id, listing.price, reference, listing.id],
    );
    const orderId = orderResult.insertId;
    await pool.execute(
      `INSERT INTO order_items (order_id, ticket_type_id, quantity, unit_price, subtotal)
       VALUES (?, ?, 1, ?, ?)`,
      [orderId, listing.ticket_type_id, listing.price, listing.price],
    );

    await logAudit({
      userId: req.user.id,
      action: 'purchase_resale_listing',
      entityType: 'resale_listing',
      entityId: id,
      details: { orderId, eventId: listing.event_id, price: Number(listing.price) },
    });

    // Initialize Paystack. In development (no secret key configured) the
    // payment is finalized immediately so the marketplace stays usable.
    const [userRows] = await pool.execute('SELECT email FROM users WHERE id = ?', [req.user.id]);
    const payResult = await initializeTransaction({
      email: userRows[0]?.email,
      amount: Number(listing.price),
      reference,
      metadata: { orderId, eventId: listing.event_id, userId: req.user.id, resaleListingId: id },
    });

    if (!payResult.status && payResult.error === 'Paystack secret key not configured') {
      await completeResaleOrder(orderId, reference);
      return res.status(201).json({
        message: 'Resale ticket purchased',
        orderId,
        id: orderId,
        reference,
        authorizationUrl: null,
      });
    }
    if (!payResult.status) {
      return res.status(400).json({ message: 'Could not initialise payment', error: payResult.error, orderId, reference });
    }

    res.status(201).json({
      message: 'Order created — complete payment to receive the resale ticket',
      orderId,
      id: orderId,
      reference,
      authorizationUrl: payResult.data.authorization_url,
    });
  } catch (err) {
    console.error('[resaleController.purchaseResaleListing]', err);
    res.status(500).json({ message: 'Server error purchasing listing' });
  }
};

/* ------------------------------------------------------------------ */
/* Finalize a resale purchase (used by completeOrder and dev mode)     */
/* Transfers the seller's ticket to the buyer and marks the listing    */
/* sold. Returns the new ticket id, or null if the listing is gone.    */
/* ------------------------------------------------------------------ */
export const completeResaleOrder = async (orderId, reference) => {
  const conn = await pool.getConnection();
  try {
    const [orderRows] = await conn.execute('SELECT * FROM orders WHERE id = ?', [orderId]);
    const order = orderRows[0];
    if (!order) return null;

    const [listRows] = await conn.execute('SELECT * FROM resale_listings WHERE id = ?', [order.resale_listing_id]);
    const listing = listRows[0];
    if (!listing) return null;

    const [ticketRows] = await conn.execute('SELECT * FROM tickets WHERE id = ?', [listing.ticket_id]);
    const ticket = ticketRows[0];
    if (!ticket || ticket.status !== 'active' || ticket.user_id !== listing.seller_id) {
      return null;
    }

    await conn.beginTransaction();

    // Mark the order completed (idempotent — the webhook path already did).
    await conn.execute(`UPDATE orders SET payment_status = 'completed' WHERE id = ?`, [orderId]);

    // Atomically claim the seller's ticket. The status check makes this
    // idempotent: a second concurrent completion finds no active ticket and
    // bails out instead of issuing a duplicate ticket to the buyer.
    const [transferred] = await conn.execute(
      `UPDATE tickets SET status = 'transferred' WHERE id = ? AND status = 'active'`,
      [listing.ticket_id],
    );
    if (transferred.affectedRows === 0) {
      await conn.rollback();
      conn.release();
      return null;
    }

    const newNumber = `TC-${uuidv4().split('-')[0].toUpperCase()}`;
    const [ticketResult] = await conn.execute(
      `INSERT INTO tickets (order_item_id, user_id, event_id, ticket_type_id, ticket_number, qr_code, seat_number, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
      [ticket.order_item_id, order.user_id, ticket.event_id, ticket.ticket_type_id, newNumber, ticket.qr_code, ticket.seat_number],
    );

    await conn.execute(
      `UPDATE resale_listings SET status = 'sold', sold_to = ?, sold_at = NOW() WHERE id = ?`,
      [order.user_id, listing.id],
    );

    await conn.commit();
    conn.release();

    // Notify both parties.
    sendNotification({
      userId: order.user_id,
      title: 'Resale ticket purchased',
      message: `Your payment for the resale ticket (${reference}) was confirmed. It's in your tickets now.`,
      type: 'payment',
    });
    sendNotification({
      userId: listing.seller_id,
      title: 'Your ticket sold',
      message: 'Your resale ticket was purchased. It has been transferred to the buyer.',
      type: 'payment',
    });

    notifyAdmins({
      title: '💰 Resale Ticket Sold',
      message: `Resale ticket for "${listing.event_title || 'Event'}" was purchased for GHS ${Number(listing.price || 0).toFixed(2)}.`,
      type: 'ticket',
      link: '/admin/events',
    }).catch(() => {});

    await logAudit({
      userId: order.user_id,
      action: 'complete_resale_purchase',
      entityType: 'resale_listing',
      entityId: listing.id,
      details: { orderId, buyerId: order.user_id, sellerId: listing.seller_id, newTicketId: ticketResult.insertId },
    });

    return ticketResult.insertId;
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    conn.release();
    console.error('[resaleController.completeResaleOrder]', err);
    return null;
  }
};

export default {
  getEventResale, getMyResale, createResaleListing, cancelResaleListing, purchaseResaleListing,
  completeResaleOrder,
};
