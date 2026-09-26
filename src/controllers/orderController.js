import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import pool from '../config/db.js';
import { initializeTransaction, verifyTransaction, refundTransaction } from '../utils/paystack.js';
import { getPaystackSecretKey } from '../utils/settings.js';
import { sendTicketConfirmationEmail } from '../utils/email.js';
import { sendTicketConfirmationSMS } from '../utils/sms.js';
import { sendNotification, notifyAdmins } from '../utils/notify.js';
import { logAudit } from '../utils/audit.js';
import textPdf from '../utils/pdf.js';

/**
 * Validate and price a coupon for an event.
 * Returns { valid, discount } where discount is the monetary amount to subtract.
 */
const applyCoupon = async (eventId, code, subtotal, totalQuantity = 1) => {
  if (!code) return { valid: false, discount: 0 };
  const [rows] = await pool.execute(
    `SELECT * FROM coupons WHERE (event_id = ? OR event_id IS NULL) AND UPPER(code) = UPPER(?) AND is_active = TRUE`,
    [eventId, code],
  );
  const coupon = rows[0];
  if (!coupon) return { valid: false, discount: 0, error: 'Invalid coupon code' };
  if (coupon.max_uses > 0 && coupon.used_count >= coupon.max_uses) return { valid: false, discount: 0, error: 'Coupon usage limit reached' };
  if (coupon.valid_to && new Date(coupon.valid_to) < new Date()) return { valid: false, discount: 0, error: 'Coupon expired' };
  if (coupon.valid_from && new Date(coupon.valid_from) > new Date()) return { valid: false, discount: 0, error: 'Coupon not yet active' };
  if (coupon.min_quantity && Number(totalQuantity) < Number(coupon.min_quantity)) {
    return { valid: false, discount: 0, error: `Minimum of ${coupon.min_quantity} tickets required to use this group discount` };
  }

  let discount = 0;
  if (coupon.discount_type === 'percentage') {
    discount = (subtotal * Number(coupon.discount_value)) / 100;
  } else {
    discount = Number(coupon.discount_value);
  }
  discount = Math.min(discount, subtotal);
  return { valid: true, discount, coupon };
};

/* ------------------------------------------------------------------ */
/* Create order                                                        */
/* ------------------------------------------------------------------ */
// Payment methods supported via Paystack gateway (Card, MoMo, Bank)
const SUPPORTED_PAYMENT_METHODS = ['paystack', 'mobile_money', 'card', 'momo', 'telecel', 'mtn', 'hubtel'];

// Hard cap per ticket type per order. The UI limits to 10; keep a sane
// server-side ceiling too.
const MAX_QUANTITY_PER_LINE = 20;

export const createOrder = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { eventId, items, couponCode, callbackUrl, customerName, customerEmail, customerPhone } = req.body;
    const paymentMethod = (req.body.paymentMethod ?? 'paystack').toLowerCase();
    if (!eventId || !Array.isArray(items) || items.length === 0) {
      conn.release();
      return res.status(400).json({ message: 'eventId and items[] are required' });
    }
    if (!SUPPORTED_PAYMENT_METHODS.includes(paymentMethod)) {
      conn.release();
      return res.status(400).json({ message: `Unsupported payment method: ${paymentMethod}` });
    }

    const [eventRows] = await conn.execute('SELECT * FROM events WHERE id = ?', [eventId]);
    const event = eventRows[0];
    if (!event) { conn.release(); return res.status(404).json({ message: 'Event not found' }); }
    if (event.status !== 'published') { conn.release(); return res.status(400).json({ message: 'Event is not available for booking' }); }

    let subtotal = 0;
    const lineItems = [];

    await conn.beginTransaction();

    for (const item of items) {
      if (!item || item.ticketTypeId === undefined || item.ticketTypeId === null || item.ticketTypeId === '') {
        await conn.rollback();
        conn.release();
        return res.status(400).json({ message: 'Each order item must include a ticketTypeId' });
      }

      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_PER_LINE) {
        await conn.rollback();
        conn.release();
        return res.status(400).json({ message: `Quantity must be a whole number between 1 and ${MAX_QUANTITY_PER_LINE}` });
      }

      const [ttRows] = await conn.execute('SELECT * FROM ticket_types WHERE id = ? AND event_id = ?', [item.ticketTypeId, eventId]);
      const tt = ttRows[0];
      if (!tt) { await conn.rollback(); conn.release(); return res.status(400).json({ message: `Ticket type ${item.ticketTypeId} not found` }); }

      const available = tt.quantity - tt.quantity_sold;
      if (quantity > available) {
        await conn.rollback();
        conn.release();
        return res.status(400).json({ message: `Only ${available} tickets left for ${tt.name}` });
      }

      // Early-bird dynamic price calculation
      let unitPrice = Number(tt.price);
      if (
        tt.early_bird_price &&
        Number(tt.early_bird_price) < unitPrice &&
        (!tt.early_bird_deadline || new Date(tt.early_bird_deadline) > new Date()) &&
        (!tt.early_bird_max_qty || Number(tt.quantity_sold) < Number(tt.early_bird_max_qty))
      ) {
        unitPrice = Number(tt.early_bird_price);
      }

      const lineSubtotal = unitPrice * quantity;
      subtotal += lineSubtotal;
      lineItems.push({ tt, quantity, unitPrice, lineSubtotal });
    }

    // Coupon
    let discount = 0;
    let coupon = null;
    const totalOrderTickets = items.reduce((sum, item) => sum + (Number(item.quantity) || 1), 0);
    if (couponCode) {
      const result = await applyCoupon(eventId, couponCode, subtotal, totalOrderTickets);
      if (!result.valid) {
        await conn.rollback();
        conn.release();
        return res.status(400).json({ message: result.error });
      }
      discount = result.discount;
      coupon = result.coupon;
    }

    const total = Math.max(subtotal - discount, 0);
    const reference = `TC-${uuidv4().split('-')[0].toUpperCase()}`;
    const invoiceNumber = `INV-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;

    const [orderResult] = await conn.execute(
      `INSERT INTO orders (user_id, event_id, total_amount, payment_method, payment_status, payment_reference, coupon_code, discount_amount, invoice_number)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      [req.user.id, eventId, total, paymentMethod, reference, couponCode || null, discount, invoiceNumber],
    );
    const orderId = orderResult.insertId;

    const orderItemIds = [];
    for (const li of lineItems) {
      const [oiResult] = await conn.execute(
        `INSERT INTO order_items (order_id, ticket_type_id, quantity, unit_price, subtotal) VALUES (?, ?, ?, ?, ?)`,
        [orderId, li.tt.id, li.quantity, li.unitPrice, li.lineSubtotal],
      );
      orderItemIds.push({ orderItemId: oiResult.insertId, tt: li.tt, quantity: li.quantity });

      // Reserve tickets by incrementing quantity_sold.
      await conn.execute(
        `UPDATE ticket_types SET quantity_sold = quantity_sold + ? WHERE id = ?`,
        [li.quantity, li.tt.id],
      );
    }

    if (coupon) {
      await conn.execute(`UPDATE coupons SET used_count = used_count + 1 WHERE id = ?`, [coupon.id]);
    }

    await conn.commit();
    conn.release();

    // Initialise Paystack transaction when the order has a real cost.
    let authorizationUrl = null;
    if (total > 0 && SUPPORTED_PAYMENT_METHODS.includes(paymentMethod)) {
      const [userRows] = await pool.execute('SELECT email, phone FROM users WHERE id = ?', [req.user.id]);
      const payerEmail = customerEmail || userRows[0]?.email;

      if (customerPhone && !userRows[0]?.phone) {
        try {
          await pool.execute('UPDATE users SET phone = ? WHERE id = ?', [customerPhone, req.user.id]);
        } catch {}
      }

      const payResult = await initializeTransaction({
        email: payerEmail,
        amount: total,
        reference,
        callback_url: callbackUrl,
        metadata: {
          orderId,
          eventId,
          userId: req.user.id,
          paymentMethod,
          customerName: customerName || null,
          customerPhone: customerPhone || null,
          customerEmail: customerEmail || null,
        },
      });
      if (!payResult.status) {
        return res.status(400).json({ message: 'Could not initialise payment', error: payResult.error, orderId, reference });
      }
      authorizationUrl = payResult.data.authorization_url;
    } else if (total === 0) {
      // Auto-complete order immediately when total is 0 (e.g. amount is on pre-generated pass)
      await completeOrder(orderId, reference);
    }

    await logAudit({ userId: req.user.id, action: 'create_order', entityType: 'order', entityId: orderId });

    res.status(201).json({
      message: 'Order created',
      orderId,
      id: orderId,
      reference,
      subtotal,
      discount,
      total,
      authorizationUrl,
      paymentStatus: total === 0 ? 'completed' : 'pending',
    });
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    conn.release();
    console.error('[orderController.createOrder]', err);
    res.status(500).json({ message: 'Server error creating order' });
  }
};

/* ------------------------------------------------------------------ */
/* Internal / Exported: generate tickets for a completed order        */
/* ------------------------------------------------------------------ */
export const generateTicketsForOrder = async (orderId) => {
  const [items] = await pool.execute('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
  const [orderRows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = orderRows[0];
  if (!order) return;

  // Guard against duplicate ticket minting
  const [existing] = await pool.execute(
    `SELECT id FROM tickets WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)`,
    [orderId],
  );
  if (existing && existing.length > 0) return;

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
          [oi.id, order.user_id, order.event_id, oi.ticket_type_id, ticketNumber, ticketNumber, seatNumber, ticketFileUrl, ticketFileName],
        );

        if (ut) {
          await pool.execute(
            `UPDATE uploaded_tickets SET is_assigned = TRUE, assigned_ticket_id = ?, assigned_at = NOW() WHERE id = ?`,
            [tResult.insertId, ut.id],
          );
        }
      } catch {
        // Safe fallback if uploaded_tickets columns are not present
        await pool.execute(
          `INSERT INTO tickets (order_item_id, user_id, event_id, ticket_type_id, ticket_number, qr_code, status)
           VALUES (?, ?, ?, ?, ?, ?, 'active')`,
          [oi.id, order.user_id, order.event_id, oi.ticket_type_id, ticketNumber, ticketNumber],
        );
      }
    }
  }
};

/* ------------------------------------------------------------------ */
/* Internal: mark an order completed, generate tickets and notify      */
/* ------------------------------------------------------------------ */
async function completeOrder(orderId, reference) {
  // Atomically claim the completion. The Paystack webhook and the browser
  // callback can fire within the same second; without this guard both would
  // see 'pending' and mint duplicate tickets.
  const [updateResult] = await pool.execute(
    `UPDATE orders SET payment_status = 'completed' WHERE id = ? AND payment_status <> 'completed'`,
    [orderId],
  );
  if (updateResult.affectedRows === 0) return;

  // Resale purchases transfer the seller's existing ticket to the buyer
  // instead of minting fresh ones from order items.
  const [resaleRows] = await pool.execute('SELECT resale_listing_id FROM orders WHERE id = ?', [orderId]);
  if (resaleRows[0]?.resale_listing_id) {
    const { completeResaleOrder } = await import('./resaleController.js');
    await completeResaleOrder(orderId, reference);
    return;
  }

  await generateTicketsForOrder(orderId);

  const [orderRows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = orderRows[0];
  if (!order) return;

  const [userRows] = await pool.execute('SELECT id, name, email, phone FROM users WHERE id = ?', [order.user_id]);
  const user = userRows[0];
  const [eventRows] = await pool.execute('SELECT title, organizer_id FROM events WHERE id = ?', [order.event_id]);
  const eventTitle = eventRows[0]?.title;
  const organizerId = eventRows[0]?.organizer_id;

  if (user?.email) {
    sendTicketConfirmationEmail(user.email, {
      reference,
      eventTitle,
      total: order.total_amount,
      items: [],
    });
  }
  if (user?.phone) sendTicketConfirmationSMS(user.phone, reference);

  // 1. User Notification: Purchase successful
  sendNotification({
    userId: order.user_id,
    title: 'Purchase successful',
    message: `Your ticket purchase for "${eventTitle || 'your event'}" was successful! Your tickets are ready in My Tickets.`,
    type: 'ticket',
    link: '/tickets',
  });

  // 2. Organizer Notifications: New ticket sale & Payment received
  if (organizerId) {
    sendNotification({
      userId: organizerId,
      title: 'New ticket sale',
      message: `You have a new ticket sale for "${eventTitle || 'your event'}"! Total: GHS ${Number(order.total_amount).toFixed(2)}.`,
      type: 'ticket',
      link: '/organizer/orders',
    });

    sendNotification({
      userId: organizerId,
      title: 'Payment received',
      message: `Payment received of GHS ${Number(order.total_amount).toFixed(2)} for "${eventTitle || 'your event'}".`,
      type: 'payment',
      link: '/organizer/reports',
    });
  }

  notifyAdmins({
    title: 'Ticket Purchase Completed',
    message: `${user?.name || 'Customer'} (${user?.email || 'N/A'}) purchased tickets for "${eventTitle || 'Event'}" (Order #${order.id} • GHS ${Number(order.total_amount).toFixed(2)}).`,
    type: 'payment',
    link: '/admin/payments',
  }).catch(() => {});

  // 3. Check if tickets are almost sold out for reminder subscribers
  if (order.event_id) {
    try {
      const [capacityStats] = await pool.execute(
        `SELECT COALESCE(SUM(quantity), 0) AS total_capacity,
                COALESCE(SUM(quantity_sold), 0) AS total_sold
         FROM ticket_types WHERE event_id = ? AND is_active = TRUE`,
        [order.event_id],
      );
      const totalCap = Number(capacityStats[0]?.total_capacity || 0);
      const totalSold = Number(capacityStats[0]?.total_sold || 0);
      const remaining = totalCap - totalSold;
      if (totalCap > 0 && remaining > 0 && (remaining <= 20 || (remaining / totalCap) <= 0.15)) {
        const { notifyReminderSubscribers } = await import('../utils/eventReminders.js');
        notifyReminderSubscribers(order.event_id, 'almost_sold_out', {
          title: `Ticket almost sold out: ${eventTitle || 'Event'}`,
          message: `Only ${remaining} ticket${remaining === 1 ? '' : 's'} remaining for "${eventTitle || 'Event'}". Grab yours before it's gone!`,
        }).catch((err) => console.error('[orderController.almostSoldOutReminder]', err));
      }
    } catch (err) {
      console.error('[orderController.checkAlmostSoldOut]', err);
    }
  }
};

/* ------------------------------------------------------------------ */
/* Validate a coupon code (used by the checkout UI)                    */
/* ------------------------------------------------------------------ */
export const applyCouponHandler = async (req, res) => {
  try {
    const { code, eventId, amount, quantity, totalQuantity } = req.body;
    if (!code || !eventId) {
      return res.status(400).json({ message: 'code and eventId are required' });
    }

    const subtotal = Number(amount) || 0;
    const ticketCount = Number(quantity) || Number(totalQuantity) || 1;
    const result = await applyCoupon(eventId, code, subtotal, ticketCount);
    if (!result.valid) {
      return res.status(400).json({ message: result.error || 'Invalid coupon code' });
    }

    const discountPercent = subtotal > 0 ? (result.discount / subtotal) * 100 : 0;
    res.json({
      valid: true,
      code,
      discount: discountPercent,
      discountPercent,
      discountAmount: result.discount,
    });
  } catch (err) {
    console.error('[orderController.applyCouponHandler]', err);
    res.status(500).json({ message: 'Server error validating coupon' });
  }
};

/* ------------------------------------------------------------------ */
/* Initialise payment for an existing order (or complete $0 orders)    */
/* ------------------------------------------------------------------ */
export const initiateOrderPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [id]);
    const order = rows[0];
    if (!order) return res.status(404).json({ message: 'Order not found' });

    if (Number(order.user_id) !== Number(req.user.id) && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (order.payment_status === 'completed') {
      return res.json({ message: 'Order already completed', orderId: order.id, authorizationUrl: null });
    }

    // Free orders (fully covered by coupons/discounts) complete immediately.
    if (Number(order.total_amount) <= 0) {
      await completeOrder(order.id, order.payment_reference);
      return res.json({ message: 'Order completed', orderId: order.id, authorizationUrl: null });
    }

    const { callbackUrl } = req.body || {};
    const [userRows] = await pool.execute('SELECT email FROM users WHERE id = ?', [order.user_id]);
    const payResult = await initializeTransaction({
      email: userRows[0]?.email,
      amount: Number(order.total_amount),
      reference: order.payment_reference,
      callback_url: callbackUrl,
      metadata: { orderId: order.id, eventId: order.event_id, userId: order.user_id },
    });
    if (!payResult.status) {
      return res.status(400).json({ message: 'Could not initialise payment', error: payResult.error, orderId: order.id });
    }

    res.json({ message: 'Payment initialised', orderId: order.id, authorizationUrl: payResult.data.authorization_url });
  } catch (err) {
    console.error('[orderController.initiateOrderPayment]', err);
    res.status(500).json({ message: 'Server error initialising payment' });
  }
};

/* ------------------------------------------------------------------ */
/* Download an invoice as a PDF                                        */
/* ------------------------------------------------------------------ */
export const getOrderInvoice = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute(
      `SELECT o.*, e.title AS event_title, u.name AS buyer_name, u.email AS buyer_email
       FROM orders o
       JOIN events e ON e.id = o.event_id
       JOIN users u ON u.id = o.user_id
       WHERE o.id = ?`,
      [id],
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ message: 'Order not found' });

    const isAllowedAdmin = ['admin', 'system_admin', 'superadmin', 'staff'].includes(req.user.role);
    if (Number(order.user_id) !== Number(req.user.id) && !isAllowedAdmin && req.user.role !== 'organizer') {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const [items] = await pool.execute(
      `SELECT oi.*, tt.name AS ticket_type_name
       FROM order_items oi
       JOIN ticket_types tt ON tt.id = oi.ticket_type_id
       WHERE oi.order_id = ?`,
      [id],
    );

    const itemLines = items.map((i) =>
      `${i.quantity} x ${i.ticket_type_name} @ GHS ${Number(i.unit_price).toFixed(2)} = GHS ${Number(i.subtotal).toFixed(2)}`,
    );
    const subtotal = items.reduce((sum, i) => sum + Number(i.subtotal), 0);

    const formattedDate = order.created_at ? new Date(order.created_at).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }) : '—';

    const pdf = textPdf({
      title: 'TAX INVOICE & OFFICIAL RECEIPT',
      lines: [
        `Invoice #: ${order.invoice_number || `INV-${order.id}`}`,
        `Order ID: #${order.id}`,
        `Transaction Ref: ${order.payment_reference}`,
        `Date Issued: ${formattedDate}`,
        `Billed To: ${order.buyer_name || 'Event Attendee'} (${order.buyer_email || '—'})`,
        `Event: ${order.event_title || ''}`,
        `Payment Method: ${order.payment_method || 'Paystack (Card / MoMo)'}`,
        `Payment Status: ${(order.payment_status || 'paid').toUpperCase()} (VERIFIED)`,
        '',
        'Itemized Breakdown:',
        ...itemLines,
        '',
        `Subtotal: GHS ${subtotal.toFixed(2)}`,
        ...(Number(order.discount_amount) > 0 ? [`Discount Applied: -GHS ${Number(order.discount_amount).toFixed(2)}`] : []),
        `Total Amount Paid: GHS ${Number(order.total_amount).toFixed(2)}`,
        '',
        'Thank you for booking with Tribes & Cliqs.',
        'This receipt is an official proof of payment and ticket fulfillment.',
        `Verification Link: https://tribesandcliqs.com/verify/${order.payment_reference}`,
      ],
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${id}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('[orderController.getOrderInvoice]', err);
    res.status(500).json({ message: 'Server error generating invoice' });
  }
};

/* ------------------------------------------------------------------ */
/* Get a single order                                                  */
/* ------------------------------------------------------------------ */
export const getOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute(
      `SELECT o.*, e.title AS event_title, e.venue AS event_venue, e.start_date AS event_date, e.start_time AS event_time,
              e.banner_image, e.organizer_id,
              u.name AS buyer_name, u.email AS buyer_email, u.phone AS buyer_phone
       FROM orders o
       JOIN events e ON e.id = o.event_id
       JOIN users u ON u.id = o.user_id
       WHERE o.id = ?`,
      [id],
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ message: 'Order not found' });

    if (Number(order.user_id) !== Number(req.user.id) && req.user.role !== 'admin') {
      if (req.user.role === 'organizer' && Number(order.organizer_id) === Number(req.user.id)) {
        // Authorized
      } else {
        return res.status(403).json({ message: 'Forbidden' });
      }
    }

    const [items] = await pool.execute(
      `SELECT oi.*, COALESCE(tt.name, 'General Admission') AS ticket_type_name
       FROM order_items oi
       LEFT JOIN ticket_types tt ON tt.id = oi.ticket_type_id
       WHERE oi.order_id = ?`,
      [id],
    );

    res.json({ order: { ...order, items } });
  } catch (err) {
    console.error('[orderController.getOrder]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Get the current user's orders                                       */
/* ------------------------------------------------------------------ */
export const getUserOrders = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT o.*, e.title AS event_title, e.banner_image
       FROM orders o
       JOIN events e ON e.id = o.event_id
       WHERE o.user_id = ?
       ORDER BY o.created_at DESC`,
      [req.user.id],
    );
    res.json({ orders: rows });
  } catch (err) {
    console.error('[orderController.getUserOrders]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getOrders = async (req, res) => {
  try {
    if (req.user.role === 'admin') {
      const { page = 1, limit = 20, status, search } = req.query;
      const pageNum = Math.max(parseInt(page, 10) || 1, 1);
      const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
      const offset = (pageNum - 1) * limitNum;

      const conditions = [];
      const params = [];
      if (status && status !== 'all') {
        conditions.push('o.payment_status = ?');
        params.push(status);
      }
      if (search) {
        conditions.push('(e.title LIKE ? OR u.name LIKE ? OR u.email LIKE ? OR o.payment_reference LIKE ?)');
        const q = `%${search}%`;
        params.push(q, q, q, q);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const [countRows] = await pool.execute(
        `SELECT COUNT(*) AS total FROM orders o JOIN events e ON e.id = o.event_id JOIN users u ON u.id = o.user_id ${where}`,
        params,
      );
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

      return res.json({
        orders: rows,
        pagination: { page: pageNum, limit: limitNum, total: countRows[0].total, totalPages: Math.ceil(countRows[0].total / limitNum) },
      });
    } else if (req.user.role === 'organizer') {
      return getOrganizerOrders(req, res);
    } else {
      return getUserOrders(req, res);
    }
  } catch (err) {
    console.error('[orderController.getOrders]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Get orders for an organizer (across their events)                   */
/* ------------------------------------------------------------------ */
export const getOrganizerOrders = async (req, res) => {
  try {
    const { status, method, search, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const offset = (pageNum - 1) * limitNum;

    const conditions = ['e.organizer_id = ?'];
    const params = [req.user.id];

    if (status && status !== 'all') {
      conditions.push('o.payment_status = ?');
      params.push(status);
    }
    if (method && method !== 'all') {
      conditions.push('o.payment_method = ?');
      params.push(method);
    }
    if (search && search.trim()) {
      const q = `%${search.trim()}%`;
      conditions.push('(e.title ILIKE ? OR u.name ILIKE ? OR u.email ILIKE ? OR o.payment_reference ILIKE ? OR CAST(o.id AS TEXT) ILIKE ?)');
      params.push(q, q, q, q, q);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;

    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS total FROM orders o JOIN events e ON e.id = o.event_id JOIN users u ON u.id = o.user_id ${where}`,
      params,
    );

    const [rows] = await pool.execute(
      `SELECT o.*, e.title AS event_title, u.name AS buyer_name, u.email AS buyer_email, u.phone AS buyer_phone,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
              (SELECT STRING_AGG(CONCAT(tt.name, ' (x', oi.quantity, ')'), ', ')
               FROM order_items oi
               LEFT JOIN ticket_types tt ON tt.id = oi.ticket_type_id
               WHERE oi.order_id = o.id) AS ticket_summary
       FROM orders o
       JOIN events e ON e.id = o.event_id
       JOIN users u ON u.id = o.user_id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT ${limitNum} OFFSET ${offset}`,
      params,
    );

    res.json({
      orders: rows.map((r) => ({
        id: r.id,
        reference: r.payment_reference || `#${r.id}`,
        amount: Number(r.total_amount),
        discountAmount: Number(r.discount_amount || 0),
        netAmount: Number(r.total_amount) - Number(r.discount_amount || 0),
        status: r.payment_status,
        paymentMethod: r.payment_method || 'card',
        currency: r.currency || 'GHS',
        createdAt: r.created_at,
        customerName: r.buyer_name,
        customerEmail: r.buyer_email,
        customerPhone: r.buyer_phone,
        eventTitle: r.event_title,
        ticketType: r.ticket_summary || 'General Admission',
        ticketCount: Number(r.item_count || 1),
        quantity: Number(r.item_count || 1),
        user: { name: r.buyer_name, email: r.buyer_email },
        event: { title: r.event_title },
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: Number(countRows[0].total),
        totalPages: Math.ceil(Number(countRows[0].total) / limitNum),
      },
    });
  } catch (err) {
    console.error('[orderController.getOrganizerOrders]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Cancel order                                                        */
/* ------------------------------------------------------------------ */
export const cancelOrder = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;
    const [rows] = await conn.execute('SELECT * FROM orders WHERE id = ?', [id]);
    const order = rows[0];
    if (!order) { conn.release(); return res.status(404).json({ message: 'Order not found' }); }

    if (Number(order.user_id) !== Number(req.user.id) && req.user.role !== 'admin') {
      conn.release();
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (order.payment_status === 'completed') {
      conn.release();
      return res.status(400).json({ message: 'Cannot cancel a completed order — request a refund instead' });
    }

    await conn.beginTransaction();
    // Release reserved quantities.
    const [items] = await conn.execute('SELECT * FROM order_items WHERE order_id = ?', [id]);
    for (const oi of items) {
      await conn.execute(
        `UPDATE ticket_types SET quantity_sold = GREATEST(quantity_sold - ?, 0) WHERE id = ?`,
        [oi.quantity, oi.ticket_type_id],
      );
    }
    await conn.execute(`UPDATE orders SET payment_status = 'failed' WHERE id = ?`, [id]);
    await conn.commit();
    conn.release();

    await logAudit({ userId: req.user.id, action: 'cancel_order', entityType: 'order', entityId: id });

    res.json({ message: 'Order cancelled' });
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    conn.release();
    console.error('[orderController.cancelOrder]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Request a refund                                                    */
/* ------------------------------------------------------------------ */
export const requestRefund = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    const [rows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [id]);
    const order = rows[0];
    if (!order) return res.status(404).json({ message: 'Order not found' });

    // Authorization: Buyer, Admin, or Organizer who owns the event
    let isAuthorized = order.user_id === req.user.id || req.user.role === 'admin';
    if (!isAuthorized && req.user.role === 'organizer') {
      const [eventRows] = await pool.execute('SELECT organizer_id FROM events WHERE id = ?', [order.event_id]);
      if (eventRows[0] && Number(eventRows[0].organizer_id) === Number(req.user.id)) {
        isAuthorized = true;
      }
    }
    if (!isAuthorized) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (order.payment_status === 'refunded') {
      return res.status(400).json({ message: 'Order has already been refunded' });
    }
    if (order.payment_status !== 'completed') {
      return res.status(400).json({ message: 'Only completed orders can be refunded' });
    }

    if (order.payment_reference) {
      const refundResult = await refundTransaction(order.payment_reference, Number(order.total_amount));
      if (!refundResult.status) {
        console.warn('[orderController.requestRefund] Paystack refund note:', refundResult.error);
      }
    }

    await pool.execute(`UPDATE orders SET payment_status = 'refunded', updated_at = NOW() WHERE id = ?`, [id]);
    await pool.execute(`UPDATE tickets SET status = 'cancelled' WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)`, [id]);

    await sendNotification({
      userId: order.user_id,
      title: 'Refund processed',
      message: `Your refund for order #${id} has been processed. Reason: ${reason || 'not specified'}`,
      type: 'refund',
    });

    await logAudit({ userId: req.user.id, action: 'refund_order', entityType: 'order', entityId: id, details: { reason } });

    res.json({ message: 'Refund processed successfully' });
  } catch (err) {
    console.error('[orderController.requestRefund]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Verify payment (Paystack webhook + manual verification)             */
/* ------------------------------------------------------------------ */
// This route is mounted with express.raw() (see server.js) so req.body is a
// raw Buffer — that raw payload is what Paystack signs with HMAC-SHA512.
const verifyWebhookSignature = async (req, rawBody) => {
  const signature = req.headers['x-paystack-signature'];
  const secretKey = await getPaystackSecretKey();
  if (!signature || !secretKey || !Buffer.isBuffer(rawBody)) return false;
  const expected = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
  const a = Buffer.from(String(signature), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

export const verifyPayment = async (req, res) => {
  try {
    // req.body is a Buffer on this route (raw middleware). Normalise to an
    // object while keeping the raw bytes for signature verification.
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}), 'utf8');
    let body = {};
    try {
      body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
    } catch {
      body = {};
    }

    // ---- Webhook path ----
    if (body.event && body.data) {
      // Never trust an unverified webhook: without a valid HMAC signature
      // this payload could claim any reference and mint free tickets.
      if (!(await verifyWebhookSignature(req, rawBody))) {
        return res.status(401).json({ message: 'Invalid webhook signature' });
      }

      const { event: evt, data } = body;
      if (evt === 'charge.success') {
        const reference = data.reference;
        const [rows] = await pool.execute('SELECT * FROM orders WHERE payment_reference = ?', [reference]);
        const order = rows[0];
        if (order && order.payment_status !== 'completed') {
          // Defense in depth: the amount Paystack reports (in kobo/pesewas)
          // must match the order total before we issue tickets.
          const charged = Number(data.amount);
          const expected = Math.round(Number(order.total_amount) * 100);
          if (!Number.isFinite(charged) || charged !== expected) {
            return res.status(400).json({ message: 'Payment amount does not match order total' });
          }
          await completeOrder(order.id, reference);
        }
      }
      return res.status(200).json({ status: 'success' });
    }

    // ---- Manual verification path ----
    const { reference } = body;
    if (!reference) return res.status(400).json({ message: 'reference is required' });

    const verifyResult = await verifyTransaction(reference);
    if (!verifyResult.status) {
      return res.status(400).json({ message: 'Payment verification failed', error: verifyResult.error });
    }

    const [rows] = await pool.execute('SELECT * FROM orders WHERE payment_reference = ?', [reference]);
    const order = rows[0];
    if (!order) return res.status(404).json({ message: 'Order not found for that reference' });

    if (verifyResult.data.status === 'success' && order.payment_status !== 'completed') {
      await completeOrder(order.id, reference);
    }

    // Fetch tickets and event data for the completed order so the attendee can view them immediately
    let tickets = [];
    let eventInfo = null;

    try {
      const [ticketRows] = await pool.execute(
        `SELECT t.id, t.ticket_number, t.qr_code, t.status, t.seat_number, t.created_at,
                t.ticket_file_url, t.ticket_file_name,
                tt.name AS ticket_type_name, COALESCE(oi.unit_price, tt.price, 0) AS price,
                COALESCE(oi.unit_price, tt.price, 0) AS unit_price,
                e.id AS event_id, e.title AS event_title, e.venue AS event_venue, e.location AS event_location,
                e.start_date, e.end_date, e.start_time, e.banner_image, e.ticket_template,
                u.name AS attendee_name, u.email AS attendee_email
         FROM tickets t
         LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
         LEFT JOIN events e ON e.id = t.event_id
         LEFT JOIN users u ON u.id = t.user_id
         LEFT JOIN order_items oi ON oi.id = t.order_item_id
         WHERE oi.order_id = ? OR t.order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)
         ORDER BY t.id ASC`,
        [order.id, order.id],
      );

      tickets = (ticketRows || []).map((t) => ({
        id: t.id,
        ticketNumber: t.ticket_number,
        qrCode: t.qr_code,
        status: t.status || 'active',
        ticketType: t.ticket_type_name || 'Standard Admission',
        price: Number(t.price || t.unit_price || 0),
        unitPrice: Number(t.unit_price || t.price || 0),
        attendeeName: t.attendee_name || 'Attendee',
        seat: t.seat_number,
        ticketFileUrl: t.ticket_file_url || null,
        ticketFileName: t.ticket_file_name || null,
        event: {
          id: t.event_id,
          title: t.event_title || 'Event',
          venue: t.event_venue || 'Venue TBA',
          location: t.event_location || '',
          startDate: t.start_date,
          startTime: t.start_time,
          image: t.banner_image,
          ticketTemplate: t.ticket_template,
        },
      }));

      if (tickets.length > 0) {
        eventInfo = tickets[0].event;
      } else if (order.event_id) {
        const [eventRows] = await pool.execute('SELECT * FROM events WHERE id = ?', [order.event_id]);
        if (eventRows[0]) {
          eventInfo = {
            id: eventRows[0].id,
            title: eventRows[0].title,
            venue: eventRows[0].venue,
            location: eventRows[0].location,
            startDate: eventRows[0].start_date,
            startTime: eventRows[0].start_time,
            image: eventRows[0].banner_image,
            ticketTemplate: eventRows[0].ticket_template,
          };
        }
      }
    } catch (ticketErr) {
      console.warn('[orderController.verifyPayment] Tickets fetch note:', ticketErr.message);
    }

    res.json({
      message: 'Payment verified',
      status: verifyResult.data.status,
      orderId: order.id,
      order: {
        id: order.id,
        reference: order.payment_reference,
        total: Number(order.total_amount || 0),
        currency: order.currency || 'GHS',
        paymentMethod: order.payment_method,
      },
      event: eventInfo,
      tickets,
    });
  } catch (err) {
    console.error('[orderController.verifyPayment]', err);
    res.status(500).json({ message: 'Server error verifying payment' });
  }
};

/* ------------------------------------------------------------------ */
/* Webhook Simulation Test Endpoint (Development & Admin Staging)       */
/* ------------------------------------------------------------------ */
export const testWebhook = async (req, res) => {
  try {
    const { reference, orderId } = req.body;
    if (!reference && !orderId) {
      return res.status(400).json({ message: 'reference or orderId is required' });
    }

    const [rows] = await pool.execute(
      'SELECT * FROM orders WHERE payment_reference = ? OR id = ? LIMIT 1',
      [reference || null, orderId || null],
    );
    const order = rows[0];
    if (!order) {
      return res.status(404).json({ message: 'Order not found for simulation' });
    }

    await completeOrder(order.id, order.payment_reference);

    res.json({
      message: 'Test webhook executed successfully: Order fulfilled & tickets issued.',
      orderId: order.id,
      reference: order.payment_reference,
      status: 'completed',
    });
  } catch (err) {
    console.error('[orderController.testWebhook]', err);
    res.status(500).json({ message: 'Test webhook error' });
  }
};
/* ------------------------------------------------------------------ */
/* Payment Callback Bridge for Mobile & Web Gateways                  */
/* ------------------------------------------------------------------ */
export const paymentCallbackBridge = async (req, res) => {
  const reference = req.query.reference || req.query.trxref || '';
  const appRedirect = req.query.app_redirect || 'tribescliqs://payment-callback';

  if (reference) {
    try {
      const verifyResult = await verifyTransaction(reference);
      if (verifyResult.status && verifyResult.data?.status === 'success') {
        const [rows] = await pool.execute('SELECT id, payment_status FROM orders WHERE payment_reference = ?', [reference]);
        const order = rows[0];
        if (order && order.payment_status !== 'completed') {
          await completeOrder(order.id, reference);
        }
      }
    } catch (e) {
      console.warn('[orderController.paymentCallbackBridge] Verification notice:', e.message);
    }
  }

  const encodedRef = encodeURIComponent(reference);
  const encodedRedirect = encodeURIComponent(appRedirect);

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Payment Successful - Tribes &amp; Cliqs</title>
  <style>
    body {
      background-color: #1C232B;
      color: #EFEFF1;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 24px;
      box-sizing: border-box;
    }
    .card {
      background-color: #242B32;
      border: 1px solid #494F55;
      border-radius: 20px;
      padding: 36px 24px;
      text-align: center;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.4);
    }
    .icon-circle {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background-color: rgba(34, 197, 94, 0.15);
      border: 2px solid rgba(34, 197, 94, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 16px auto;
      color: #22C55E;
      font-size: 32px;
      font-weight: 800;
    }
    .title {
      font-size: 20px;
      font-weight: 700;
      color: #FFFFFF;
      margin: 0 0 8px 0;
    }
    .desc {
      color: #949599;
      font-size: 14px;
      line-height: 1.5;
      margin: 0 0 20px 0;
    }
    .ref-box {
      background-color: #1C232B;
      border: 1px dashed #494F55;
      border-radius: 10px;
      padding: 10px 14px;
      margin-bottom: 24px;
      font-size: 13px;
      color: #949599;
    }
    .ref-code {
      font-family: monospace;
      color: #EFEFF1;
      font-weight: 700;
    }
    .btn {
      display: block;
      background-color: #b21414;
      color: #ffffff;
      padding: 14px 24px;
      border-radius: 12px;
      text-decoration: none;
      font-weight: 700;
      font-size: 15px;
      margin-bottom: 12px;
    }
    .btn-secondary {
      background-color: transparent;
      border: 1px solid #494F55;
      color: #EFEFF1;
      font-weight: 600;
      font-size: 13px;
      padding: 10px 20px;
      border-radius: 10px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon-circle">✓</div>
    <h2 class="title">Payment Successful!</h2>
    <p class="desc">Your tickets have been issued and added to your digital pass wallet.</p>
    ${reference ? `<div class="ref-box">Reference: <span class="ref-code">${reference}</span></div>` : ''}
    <a id="returnBtn" class="btn" href="#">Return to Tribes &amp; Cliqs App</a>
    <a id="webBtn" class="btn btn-secondary" href="https://tribesandcliqs-app.vercel.app/profile">View on Web</a>
  </div>
  <script>
    (function() {
      var params = new URLSearchParams(window.location.search);
      var reference = params.get('reference') || params.get('trxref') || '${encodedRef}';
      var appRedirect = params.get('app_redirect') || '${appRedirect}';
      var sep = appRedirect.indexOf('?') !== -1 ? '&' : '?';
      var target = reference ? (appRedirect + sep + 'reference=' + encodeURIComponent(reference) + '&status=success') : appRedirect;

      var returnBtn = document.getElementById('returnBtn');
      if (returnBtn) returnBtn.href = target;

      // Automatically redirect back to native app
      window.location.replace(target);
      setTimeout(function() {
        window.location.href = target;
      }, 250);

      // Attempt popup close
      setTimeout(function() {
        try { window.close(); } catch(e) {}
      }, 1500);
    })();
  </script>
</body>
</html>`);
};

export default {
  createOrder, getOrder, getUserOrders, getOrganizerOrders, cancelOrder, requestRefund, verifyPayment,
  applyCouponHandler, initiateOrderPayment, getOrderInvoice, testWebhook, paymentCallbackBridge,
};
