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
const applyCoupon = async (eventId, code, subtotal) => {
  if (!code) return { valid: false, discount: 0 };
  const [rows] = await pool.execute(
    `SELECT * FROM coupons WHERE event_id = ? AND code = ? AND is_active = TRUE`,
    [eventId, code],
  );
  const coupon = rows[0];
  if (!coupon) return { valid: false, discount: 0, error: 'Invalid coupon code' };
  if (coupon.used_count >= coupon.max_uses) return { valid: false, discount: 0, error: 'Coupon usage limit reached' };
  if (coupon.valid_to && new Date(coupon.valid_to) < new Date()) return { valid: false, discount: 0, error: 'Coupon expired' };
  if (coupon.valid_from && new Date(coupon.valid_from) > new Date()) return { valid: false, discount: 0, error: 'Coupon not yet active' };

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
// Only Paystack is wired up end-to-end; reject anything else rather than
// creating orders that can never be paid for or completed.
const SUPPORTED_PAYMENT_METHODS = ['paystack'];

// Hard cap per ticket type per order. The UI limits to 10; keep a sane
// server-side ceiling too.
const MAX_QUANTITY_PER_LINE = 20;

export const createOrder = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { eventId, items, couponCode } = req.body;
    const paymentMethod = req.body.paymentMethod ?? 'paystack';
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
    if (couponCode) {
      const result = await applyCoupon(eventId, couponCode, subtotal);
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
    if (total > 0 && paymentMethod === 'paystack') {
      const [userRows] = await pool.execute('SELECT email FROM users WHERE id = ?', [req.user.id]);
      const payResult = await initializeTransaction({
        email: userRows[0].email,
        amount: total,
        reference,
        metadata: { orderId, eventId, userId: req.user.id },
      });
      if (!payResult.status) {
        return res.status(400).json({ message: 'Could not initialise payment', error: payResult.error, orderId, reference });
      }
      authorizationUrl = payResult.data.authorization_url;
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
    });
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    conn.release();
    console.error('[orderController.createOrder]', err);
    res.status(500).json({ message: 'Server error creating order' });
  }
};

/* ------------------------------------------------------------------ */
/* Internal: generate tickets for a completed order                    */
/* ------------------------------------------------------------------ */
const generateTicketsForOrder = async (orderId) => {
  const [items] = await pool.execute('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
  const [orderRows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = orderRows[0];
  if (!order) return;

  for (const oi of items) {
    for (let i = 0; i < oi.quantity; i++) {
      const ticketNumber = `TC-${uuidv4().split('-')[0].toUpperCase()}`;
      await pool.execute(
        `INSERT INTO tickets (order_item_id, user_id, event_id, ticket_type_id, ticket_number, qr_code, status)
         SELECT ?, ?, ?, ?, ?, ?, 'active'
         FROM dual`,
        [oi.id, order.user_id, order.event_id, oi.ticket_type_id, ticketNumber, ticketNumber],
      );
    }
  }
};

/* ------------------------------------------------------------------ */
/* Internal: mark an order completed, generate tickets and notify      */
/* ------------------------------------------------------------------ */
const completeOrder = async (orderId, reference) => {
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

  const [userRows] = await pool.execute('SELECT email, phone FROM users WHERE id = ?', [order.user_id]);
  const user = userRows[0];
  const [eventRows] = await pool.execute('SELECT title FROM events WHERE id = ?', [order.event_id]);
  const eventTitle = eventRows[0]?.title;

  if (user?.email) {
    sendTicketConfirmationEmail(user.email, {
      reference,
      eventTitle,
      total: order.total_amount,
      items: [],
    });
  }
  if (user?.phone) sendTicketConfirmationSMS(user.phone, reference);
  sendNotification({
    userId: order.user_id,
    title: 'Payment confirmed',
    message: `Your payment for "${eventTitle || 'your event'}" was confirmed. Your tickets are ready.`,
    type: 'payment',
  });

  notifyAdmins({
    title: 'Ticket Order Completed',
    message: `Order #${order.id} paid (GHS ${Number(order.total_amount).toFixed(2)}) for "${eventTitle || 'Event'}".`,
    type: 'payment',
    link: '/admin/payments',
  }).catch(() => {});
};

/* ------------------------------------------------------------------ */
/* Validate a coupon code (used by the checkout UI)                    */
/* ------------------------------------------------------------------ */
export const applyCouponHandler = async (req, res) => {
  try {
    const { code, eventId, amount } = req.body;
    if (!code || !eventId) {
      return res.status(400).json({ message: 'code and eventId are required' });
    }

    const subtotal = Number(amount) || 0;
    const result = await applyCoupon(eventId, code, subtotal);
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

    if (order.user_id !== req.user.id && req.user.role !== 'admin') {
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

    const [userRows] = await pool.execute('SELECT email FROM users WHERE id = ?', [order.user_id]);
    const payResult = await initializeTransaction({
      email: userRows[0]?.email,
      amount: Number(order.total_amount),
      reference: order.payment_reference,
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
    if (order.user_id !== req.user.id && !isAllowedAdmin && req.user.role !== 'organizer') {
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

    const pdf = textPdf({
      title: 'INVOICE',
      lines: [
        `Order #${order.id}`,
        `Reference: ${order.payment_reference}`,
        `Buyer: ${order.buyer_name || ''} (${order.buyer_email || ''})`,
        `Event: ${order.event_title || ''}`,
        `Status: ${order.payment_status}`,
        '',
        'Items:',
        ...itemLines,
        '',
        `Subtotal: GHS ${subtotal.toFixed(2)}`,
        `Discount: GHS ${Number(order.discount_amount || 0).toFixed(2)}`,
        `Total: GHS ${Number(order.total_amount).toFixed(2)}`,
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
      `SELECT o.*, e.title AS event_title, e.banner_image
       FROM orders o
       JOIN events e ON e.id = o.event_id
       WHERE o.id = ?`,
      [id],
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ message: 'Order not found' });

    if (order.user_id !== req.user.id && req.user.role !== 'admin' && req.user.role !== 'organizer') {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const [items] = await pool.execute(
      `SELECT oi.*, tt.name AS ticket_type_name
       FROM order_items oi
       JOIN ticket_types tt ON tt.id = oi.ticket_type_id
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
    const { page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const offset = (pageNum - 1) * limitNum;

    const [rows] = await pool.execute(
      `SELECT o.*, e.title AS event_title, u.name AS buyer_name, u.email AS buyer_email
       FROM orders o
       JOIN events e ON e.id = o.event_id
       JOIN users u ON u.id = o.user_id
       WHERE e.organizer_id = ?
       ORDER BY o.created_at DESC
       LIMIT ${limitNum} OFFSET ${offset}`,
      [req.user.id],
    );

    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS total FROM orders o JOIN events e ON e.id = o.event_id WHERE e.organizer_id = ?`,
      [req.user.id],
    );

    res.json({
      orders: rows,
      pagination: { page: pageNum, limit: limitNum, total: countRows[0].total, totalPages: Math.ceil(countRows[0].total / limitNum) },
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

    if (order.user_id !== req.user.id && req.user.role !== 'admin') {
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
    const { reason } = req.body;
    const [rows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [id]);
    const order = rows[0];
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (order.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (order.payment_status !== 'completed') {
      return res.status(400).json({ message: 'Only completed orders can be refunded' });
    }

    const refundResult = await refundTransaction(order.payment_reference, Number(order.total_amount));
    if (!refundResult.status) {
      return res.status(400).json({ message: 'Refund could not be processed', error: refundResult.error });
    }

    await pool.execute(`UPDATE orders SET payment_status = 'refunded' WHERE id = ?`, [id]);
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

    res.json({ message: 'Payment verified', status: verifyResult.data.status, orderId: order.id });
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

export default {
  createOrder, getOrder, getUserOrders, getOrganizerOrders, cancelOrder, requestRefund, verifyPayment,
  applyCouponHandler, initiateOrderPayment, getOrderInvoice, testWebhook,
};
