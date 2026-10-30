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
import { REFUND_POLICY_CIRCUMSTANCES, getPolicyClause, formatPolicyCitation } from '../constants/refundPolicy.js';

/**
 * Validate and price a coupon for an event.
 * Returns { valid, discount } where discount is the monetary amount to subtract.
 */
const applyCoupon = async (rawEventId, code, subtotal, totalQuantity = 1) => {
  if (!code) return { valid: false, discount: 0 };
  let numericEventId = !isNaN(Number(rawEventId)) ? Number(rawEventId) : null;
  if (!numericEventId && rawEventId) {
    const [eRows] = await pool.execute('SELECT id FROM events WHERE slug = ?', [String(rawEventId)]);
    if (eRows[0]) numericEventId = Number(eRows[0].id);
  }
  const [rows] = await pool.execute(
    `SELECT * FROM coupons WHERE (event_id = ? OR event_id IS NULL) AND UPPER(code) = UPPER(?) AND is_active = TRUE`,
    [numericEventId || 0, code],
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
  let connReleased = false;
  const safeRelease = () => {
    if (!connReleased) {
      connReleased = true;
      try { conn.release(); } catch {}
    }
  };

  try {
    const rawEventId = req.body.eventId ?? req.body.event_id;
    let orderItems = req.body.items;
    if (typeof orderItems === 'string') {
      try { orderItems = JSON.parse(orderItems); } catch {}
    }
    if (!Array.isArray(orderItems) && (req.body.ticketTypeId || req.body.ticket_type_id || req.body.id)) {
      orderItems = [{
        ticketTypeId: req.body.ticketTypeId || req.body.ticket_type_id || req.body.id,
        quantity: req.body.quantity || 1,
      }];
    }

    const { couponCode, callbackUrl, customerName, customerEmail, customerPhone } = req.body;
    const paymentMethod = (req.body.paymentMethod ?? 'paystack').toLowerCase();

    if (!rawEventId || !Array.isArray(orderItems) || orderItems.length === 0) {
      console.warn('[orderController.createOrder] 400: Missing eventId or items[]', { body: req.body });
      safeRelease();
      return res.status(400).json({ message: 'eventId and items[] are required' });
    }
    if (!SUPPORTED_PAYMENT_METHODS.includes(paymentMethod)) {
      console.warn('[orderController.createOrder] 400: Unsupported payment method', { paymentMethod });
      safeRelease();
      return res.status(400).json({ message: `Unsupported payment method: ${paymentMethod}` });
    }

    let event = null;
    if (!isNaN(Number(rawEventId))) {
      const [rows] = await conn.execute('SELECT * FROM events WHERE id = ?', [Number(rawEventId)]);
      event = rows[0];
    }
    if (!event && rawEventId) {
      const [rows] = await conn.execute('SELECT * FROM events WHERE slug = ?', [String(rawEventId)]);
      event = rows[0];
    }

    if (!event) {
      console.warn('[orderController.createOrder] 404: Event not found for id/slug:', rawEventId);
      safeRelease();
      return res.status(404).json({ message: 'Event not found' });
    }
    if (event.status !== 'published') {
      console.warn('[orderController.createOrder] 400: Event not available for booking, status:', event.status);
      safeRelease();
      return res.status(400).json({ message: 'Event is not available for booking' });
    }

    const eventId = Number(event.id);
    let subtotal = 0;
    const lineItems = [];

    await conn.beginTransaction();

    for (const item of orderItems) {
      const ticketTypeId = item?.ticketTypeId ?? item?.ticket_type_id ?? item?.id ?? item?.ticketId;
      if (ticketTypeId === undefined || ticketTypeId === null || ticketTypeId === '') {
        console.warn('[orderController.createOrder] 400: Missing ticketTypeId in item:', item);
        await conn.rollback();
        safeRelease();
        return res.status(400).json({ message: 'Each order item must include a ticketTypeId' });
      }

      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_PER_LINE) {
        console.warn('[orderController.createOrder] 400: Invalid quantity:', item.quantity);
        await conn.rollback();
        safeRelease();
        return res.status(400).json({ message: `Quantity must be a whole number between 1 and ${MAX_QUANTITY_PER_LINE}` });
      }

      const [ttRows] = await conn.execute('SELECT * FROM ticket_types WHERE id = ? AND event_id = ?', [ticketTypeId, eventId]);
      const tt = ttRows[0];
      if (!tt) {
        console.warn('[orderController.createOrder] 400: Ticket type not found for id:', ticketTypeId, 'eventId:', eventId);
        await conn.rollback();
        safeRelease();
        return res.status(400).json({ message: `Ticket type ${ticketTypeId} not found` });
      }

      const available = tt.quantity - tt.quantity_sold;
      if (quantity > available) {
        console.warn('[orderController.createOrder] 400: Insufficient tickets available:', { available, requested: quantity });
        await conn.rollback();
        safeRelease();
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
    const totalOrderTickets = orderItems.reduce((sum, item) => sum + (Number(item.quantity) || 1), 0);
    if (couponCode) {
      const result = await applyCoupon(eventId, couponCode, subtotal, totalOrderTickets);
      if (!result.valid) {
        await conn.rollback();
        safeRelease();
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
    safeRelease();

    // Initialise Paystack transaction when the order has a real cost.
    let authorizationUrl = null;
    if (total > 0 && SUPPORTED_PAYMENT_METHODS.includes(paymentMethod)) {
      const [userRows] = await pool.execute('SELECT email, phone FROM users WHERE id = ?', [req.user.id]);
      const payerEmail = customerEmail || userRows[0]?.email || req.user?.email || 'customer@tribesandcliqs.com';

      if (customerPhone && !userRows[0]?.phone) {
        try {
          await pool.execute('UPDATE users SET phone = ? WHERE id = ?', [customerPhone, req.user.id]);
        } catch {}
      }

      const clientOrigin = (req.headers.origin || req.headers.referer) ? (() => {
        try {
          const u = new URL(req.headers.origin || req.headers.referer);
          return u.origin;
        } catch { return null; }
      })() : null;
      const effectiveCallback = callbackUrl || (clientOrigin ? `${clientOrigin}/payment/callback` : null);

      const payResult = await initializeTransaction({
        email: payerEmail,
        amount: total,
        reference,
        callback_url: effectiveCallback,
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
        console.error('[orderController.createOrder] 400: Paystack error:', payResult.error);
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
    safeRelease();
    console.error('[orderController.createOrder]', err);
    res.status(500).json({ message: err.message || 'Server error creating order' });
  }
};

/* ------------------------------------------------------------------ */
/* Internal / Exported: generate tickets for a completed order        */
/* ------------------------------------------------------------------ */
const activeMintingOrders = new Set();

export const generateTicketsForOrder = async (orderId) => {
  if (!orderId) return;
  const numOrderId = Number(orderId);
  if (activeMintingOrders.has(numOrderId)) return;
  activeMintingOrders.add(numOrderId);

  try {
    const [items] = await pool.execute('SELECT * FROM order_items WHERE order_id = ?', [numOrderId]);
    const [orderRows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [numOrderId]);
    const order = orderRows[0];
    if (!order) return;

    for (const oi of items) {
      // 1. Strictly count how many tickets already exist for this order item
      const [countRows] = await pool.execute(
        'SELECT COUNT(*) AS count FROM tickets WHERE order_item_id = ?',
        [oi.id],
      );
      const existingCount = Number(countRows[0]?.count || 0);
      const targetQty = Number(oi.quantity || 1);

      // If duplicate tickets already exist from prior race conditions, clean up the redundant ones
      if (existingCount > targetQty) {
        try {
          const [excessRows] = await pool.execute(
            `SELECT id FROM tickets WHERE order_item_id = ? AND status = 'active' ORDER BY id ASC LIMIT ? OFFSET ?`,
            [oi.id, existingCount - targetQty, targetQty],
          );
          if (excessRows && excessRows.length > 0) {
            const excessIds = excessRows.map((r) => r.id);
            const placeholders = excessIds.map(() => '?').join(', ');
            await pool.execute(`DELETE FROM tickets WHERE id IN (${placeholders})`, excessIds);
          }
        } catch (cleanErr) {
          console.warn('[orderController.generateTicketsForOrder] Excess cleanup notice:', cleanErr.message);
        }
        continue;
      }

      const needed = Math.max(0, targetQty - existingCount);
      if (needed <= 0) continue;

      for (let i = 0; i < needed; i++) {
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
  } finally {
    activeMintingOrders.delete(numOrderId);
  }
};

/* ------------------------------------------------------------------ */
/* Internal: mark an order completed, generate tickets and notify      */
/* ------------------------------------------------------------------ */
export async function completeOrder(orderId, reference) {
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
  const [eventRows] = await pool.execute(
    'SELECT title, organizer_id, venue, location, start_date FROM events WHERE id = ?',
    [order.event_id],
  );
  const event = eventRows[0] || {};
  const eventTitle = event.title;
  const organizerId = event.organizer_id;

  // Retrieve generated tickets for this order with tier names
  let tickets = [];
  try {
    const [tRows] = await pool.execute(
      `SELECT t.id, t.ticket_number, t.qr_code, tt.name AS tier_name, COALESCE(t.attendee_name, ?) AS attendee_name
       FROM tickets t
       JOIN order_items oi ON oi.id = t.order_item_id
       LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
       WHERE oi.order_id = ?`,
      [user?.name || 'Attendee', orderId],
    );
    tickets = tRows;
  } catch (tErr) {
    console.warn('[orderController.completeOrder] Could not load ticket details for email:', tErr.message);
  }

  if (user?.email) {
    sendTicketConfirmationEmail(user.email, {
      reference,
      eventTitle,
      total: `GHS ${Number(order.total_amount).toFixed(2)}`,
      total_amount: order.total_amount,
      venue: event.venue || event.location || 'Venue TBA',
      eventDate: event.start_date ? new Date(event.start_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : 'Upcoming',
      attendeeName: user.name || 'Friend',
      tickets,
      items: [],
    }).catch((err) => console.error('[orderController] sendTicketConfirmationEmail error:', err.message));
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
    const { code, amount, quantity, totalQuantity } = req.body;
    const eventId = req.body.eventId ?? req.body.event_id;
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
    const clientOrigin = (req.headers.origin || req.headers.referer) ? (() => {
      try {
        const u = new URL(req.headers.origin || req.headers.referer);
        return u.origin;
      } catch { return null; }
    })() : null;
    const effectiveCallback = callbackUrl || (clientOrigin ? `${clientOrigin}/payment/callback` : null);

    const [userRows] = await pool.execute('SELECT email FROM users WHERE id = ?', [order.user_id]);
    const payResult = await initializeTransaction({
      email: userRows[0]?.email,
      amount: Number(order.total_amount),
      reference: order.payment_reference,
      callback_url: effectiveCallback,
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
        `Verification Link: ${(process.env.FRONTEND_URL || 'https://tribesandcliqs.com').split(',')[0].trim().replace(/\/+$/, '')}/verify/${order.payment_reference}`,
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
    const isNum = !isNaN(Number(id));
    const [rows] = await pool.execute(
      `SELECT o.*, e.title AS event_title, e.venue AS event_venue, e.location AS event_location,
              e.start_date AS event_date, e.start_time AS event_time,
              e.banner_image, e.organizer_id,
              u.name AS buyer_name, u.email AS buyer_email, u.phone AS buyer_phone
       FROM orders o
       JOIN events e ON e.id = o.event_id
       JOIN users u ON u.id = o.user_id
       WHERE (o.id = ?) OR (o.payment_reference = ?) OR (o.invoice_number = ?)`,
      [isNum ? Number(id) : -1, String(id), String(id)],
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
      [order.id],
    );

    let tickets = [];
    try {
      const [tRows] = await pool.execute(
        `SELECT t.id, t.ticket_number, t.qr_code, t.status, t.seat_number, t.created_at,
                t.ticket_file_url, t.ticket_file_name,
                COALESCE(tt.name, 'Admission Pass') AS ticket_type_name
         FROM tickets t
         JOIN order_items oi ON oi.id = t.order_item_id
         LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
         WHERE oi.order_id = ?
         ORDER BY t.id ASC`,
        [order.id],
      );
      tickets = tRows || [];
    } catch {}

    res.json({ order: { ...order, items, tickets } });
  } catch (err) {
    console.error('[orderController.getOrder]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

/* ------------------------------------------------------------------ */
/* Get receipt data for dedicated receipt page (public or authenticated) */
/* ------------------------------------------------------------------ */
export const getReceiptOrder = async (req, res) => {
  try {
    const rawIdentifier = req.params.identifier || req.params.id;
    if (!rawIdentifier) return res.status(400).json({ message: 'Receipt identifier is required' });

    const identifier = String(rawIdentifier).trim();
    const isNum = !isNaN(Number(identifier));

    const [rows] = await pool.execute(
      `SELECT o.*, 
              e.title AS event_title, e.venue AS event_venue, e.location AS event_location, e.city AS event_city,
              e.start_date AS event_date, e.start_time AS event_time, e.end_date, e.end_time,
              e.banner_image, e.organizer_id,
              org.name AS organizer_name,
              u.name AS buyer_name, u.email AS buyer_email, u.phone AS buyer_phone
       FROM orders o
       LEFT JOIN events e ON e.id = o.event_id
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN users org ON org.id = e.organizer_id
       WHERE (o.id = ?) OR (o.payment_reference = ?) OR (o.invoice_number = ?)`,
      [isNum ? Number(identifier) : -1, identifier, identifier],
    );

    const order = rows[0];
    if (!order) return res.status(404).json({ message: 'Receipt not found' });

    // Authorization check: if authenticated user is logged in, ensure they are owner, admin, or organizer
    if (req.user) {
      const isOwner = Number(order.user_id) === Number(req.user.id);
      const isAdmin = ['admin', 'system_admin', 'superadmin', 'staff'].includes(req.user.role);
      const isOrganizer = req.user.role === 'organizer' && Number(order.organizer_id) === Number(req.user.id);
      if (!isOwner && !isAdmin && !isOrganizer) {
        return res.status(403).json({ message: 'Access denied' });
      }
    }

    const [items] = await pool.execute(
      `SELECT oi.*, COALESCE(tt.name, 'General Admission') AS ticket_type_name
       FROM order_items oi
       LEFT JOIN ticket_types tt ON tt.id = oi.ticket_type_id
       WHERE oi.order_id = ?`,
      [order.id],
    );

    let tickets = [];
    try {
      const [tRows] = await pool.execute(
        `SELECT t.id, t.ticket_number, t.qr_code, t.status, t.seat_number, t.created_at,
                t.ticket_file_url, t.ticket_file_name,
                COALESCE(tt.name, 'Admission Pass') AS ticket_type_name
         FROM tickets t
         JOIN order_items oi ON oi.id = t.order_item_id
         LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
         WHERE oi.order_id = ?
         ORDER BY t.id ASC`,
        [order.id],
      );
      tickets = tRows || [];
    } catch {}

    res.json({
      order: {
        ...order,
        items,
        tickets,
      },
    });
  } catch (err) {
    console.error('[orderController.getReceiptOrder]', err);
    res.status(500).json({ message: 'Server error retrieving receipt' });
  }
};

/* ------------------------------------------------------------------ */
/* Get the current user's orders                                       */
/* ------------------------------------------------------------------ */
export const getUserOrders = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT o.*, e.title AS event_title, e.banner_image, e.start_date, e.start_time, e.venue AS venue_name, e.venue,
              r.id AS refund_request_id, r.status AS refund_status_detail,
              r.reason AS refund_reason, r.organizer_deadline, r.policy_circumstance, r.clause_number
       FROM orders o
       LEFT JOIN events e ON e.id = o.event_id
       LEFT JOIN LATERAL (
         SELECT id, status, reason, organizer_deadline, policy_circumstance, clause_number
         FROM refunds
         WHERE order_id = o.id
         ORDER BY id DESC
         LIMIT 1
       ) r ON TRUE
       WHERE o.user_id = ?
       ORDER BY o.created_at DESC`,
      [req.user.id],
    );

    const orderIds = rows.map((r) => r.id);
    const itemsByOrderId = {};

    if (orderIds.length > 0) {
      try {
        const placeholders = orderIds.map(() => '?').join(',');
        const [allOrderItems] = await pool.execute(
          `SELECT oi.*, COALESCE(tt.name, 'General Admission') AS ticket_type_name
           FROM order_items oi
           LEFT JOIN ticket_types tt ON tt.id = oi.ticket_type_id
           WHERE oi.order_id IN (${placeholders})`,
          orderIds,
        );
        for (const item of allOrderItems) {
          if (!itemsByOrderId[item.order_id]) itemsByOrderId[item.order_id] = [];
          itemsByOrderId[item.order_id].push({
            ...item,
            ticketType: item.ticket_type_name,
            name: item.ticket_type_name,
            price: Number(item.unit_price || item.price || 0),
            quantity: Number(item.quantity || 1),
          });
        }
      } catch (itemErr) {
        console.warn('[orderController.getUserOrders] Order items query note:', itemErr.message);
      }
    }

    const formattedOrders = rows.map((o) => {
      const items = itemsByOrderId[o.id] || [];
      const calculatedQty = items.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
      const totalNum = Number(o.total_amount != null ? o.total_amount : o.total || 0);

      return {
        ...o,
        totalAmount: totalNum,
        total: totalNum,
        total_amount: totalNum,
        createdAt: o.created_at,
        created_at: o.created_at,
        ticketCount: calculatedQty > 0 ? calculatedQty : 1,
        quantity: calculatedQty > 0 ? calculatedQty : 1,
        items,
        event: {
          title: o.event_title || 'Event',
          startDate: o.start_date,
          startTime: o.start_time,
          venue: o.venue_name || o.venue,
          image: o.banner_image,
        },
      };
    });

    res.json({ orders: formattedOrders });
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
        `SELECT COUNT(*) AS total FROM orders o LEFT JOIN events e ON e.id = o.event_id LEFT JOIN users u ON u.id = o.user_id ${where}`,
        params,
      );
      const total = Number(countRows[0]?.total || 0);
      const [rows] = await pool.execute(
        `SELECT o.*, e.title AS event_title, u.name AS buyer_name, u.email AS buyer_email
         FROM orders o
         LEFT JOIN events e ON e.id = o.event_id
         LEFT JOIN users u ON u.id = o.user_id
         ${where}
         ORDER BY o.created_at DESC
         LIMIT ${limitNum} OFFSET ${offset}`,
        params,
      );

      return res.json({
        orders: rows,
        pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) || 1 },
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
      `SELECT COUNT(*) AS total FROM orders o JOIN events e ON e.id = o.event_id LEFT JOIN users u ON u.id = o.user_id ${where}`,
      params,
    );
    const total = Number(countRows[0]?.total || 0);

    const [rows] = await pool.execute(
      `SELECT o.*, e.title AS event_title, u.name AS buyer_name, u.email AS buyer_email, u.phone AS buyer_phone,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
              (SELECT STRING_AGG(CONCAT(tt.name, ' (x', oi.quantity, ')'), ', ')
               FROM order_items oi
               LEFT JOIN ticket_types tt ON tt.id = oi.ticket_type_id
               WHERE oi.order_id = o.id) AS ticket_summary
       FROM orders o
       JOIN events e ON e.id = o.event_id
       LEFT JOIN users u ON u.id = o.user_id
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
        total,
        totalPages: Math.ceil(total / limitNum) || 1,
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
    const { reason, circumstance, policyCircumstance, adminNotes } = req.body || {};
    const [rows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [id]);
    const order = rows[0];
    if (!order) return res.status(404).json({ message: 'Order not found' });

    // Authorization: Buyer, Admin, or Organizer who owns the event
    const isBuyer = Number(order.user_id) === Number(req.user.id);
    const isAdmin = ['admin', 'system_admin', 'superadmin'].includes(req.user.role);
    let isOrganizer = false;

    const [eventRows] = await pool.execute('SELECT organizer_id, title FROM events WHERE id = ?', [order.event_id]);
    const event = eventRows[0] || {};
    if (Number(event.organizer_id) === Number(req.user.id)) {
      isOrganizer = true;
    }

    if (!isBuyer && !isAdmin && !isOrganizer) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (order.payment_status === 'refunded') {
      return res.status(400).json({ message: 'Order has already been refunded' });
    }
    if (order.payment_status !== 'completed') {
      return res.status(400).json({ message: 'Only completed orders can be refunded' });
    }

    // PATH 1: BUYER REQUEST (creates pending refund request with 1-day organizer SLA per Clause 5)
    if (isBuyer && !isAdmin && !isOrganizer) {
      const [existingPending] = await pool.execute(
        `SELECT id, status, organizer_deadline FROM refunds WHERE order_id = ? AND status = 'pending'`,
        [id],
      );
      if (existingPending.length > 0) {
        return res.status(400).json({
          message: 'A refund request for this order is already pending organizer review.',
          deadline: existingPending[0].organizer_deadline,
        });
      }

      // 1 day (24 hours) SLA for organizer response
      const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const chosenCircumstance = circumstance || policyCircumstance || '5_BUYER_CIRCUMSTANCES_UNRESPONSIVE_ORGANIZER';
      const clause = getPolicyClause(chosenCircumstance);

      await pool.execute(
        `INSERT INTO refunds (
           order_id, user_id, event_id, organizer_id, amount, reason,
           policy_circumstance, clause_number, initiated_by, status, organizer_deadline, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'buyer', 'pending', ?, NOW())`,
        [
          id,
          order.user_id,
          order.event_id,
          event.organizer_id || null,
          order.total_amount,
          reason || 'Requested by buyer',
          chosenCircumstance,
          clause?.clauseNumber || 5,
          deadline,
        ],
      );

      await pool.execute(
        `UPDATE orders SET refund_requested_at = NOW(), refund_request_status = 'pending', updated_at = NOW() WHERE id = ?`,
        [id],
      );

      // Notify organizer of the 24h deadline under TRIBESANDCLIQS Refund Policy
      if (event.organizer_id) {
        await sendNotification({
          userId: event.organizer_id,
          title: 'Refund Request Received (1-Day SLA)',
          message: `A buyer requested a refund for Order #${id} on "${event.title || 'your event'}". Per TRIBESANDCLIQS Refund Policy, you have 1 day (24 hours) to review. If unaddressed, TRIBESANDCLIQS reserves the right to issue a refund under Clause 5.`,
          type: 'refund',
        });
      }

      // Notify buyer
      await sendNotification({
        userId: order.user_id,
        title: 'Refund Request Submitted',
        message: `Your refund request for Order #${id} has been submitted. The event organizer has 1 day (24 hours) to review your request under the TRIBESANDCLIQS Refund Policy.`,
        type: 'refund',
      });

      await logAudit({
        userId: req.user.id,
        action: 'buyer_refund_request',
        entityType: 'order',
        entityId: id,
        details: { reason, deadline },
      });

      return res.json({
        message: 'Refund request submitted. The organizer has 1 day (24 hours) to respond per TRIBESANDCLIQS Refund Policy.',
        status: 'pending',
        deadline,
      });
    }

    // PATH 2: ORGANIZER OR ADMIN AUTHORIZATION (Executes refund under official policy clause)
    let selectedCircumstance = '1_ORGANIZER_AUTHORIZED';
    if (isAdmin) {
      selectedCircumstance = circumstance || policyCircumstance || '1_ORGANIZER_AUTHORIZED';
    } else if (isOrganizer) {
      selectedCircumstance = '1_ORGANIZER_AUTHORIZED';
    }
    const policyClause = getPolicyClause(selectedCircumstance);
    const clauseNum = policyClause?.clauseNumber || (isOrganizer ? 1 : 1);
    const citation = formatPolicyCitation(selectedCircumstance);

    // Call payment provider (Paystack)
    if (order.payment_reference) {
      const refundResult = await refundTransaction(order.payment_reference, Number(order.total_amount));
      if (!refundResult.status) {
        console.warn('[orderController.requestRefund] Paystack refund notice:', refundResult.error);
      }
    }

    await pool.execute(
      `UPDATE orders SET payment_status = 'refunded', order_status = 'refunded', refund_request_status = 'approved', updated_at = NOW() WHERE id = ?`,
      [id],
    );
    await pool.execute(
      `UPDATE tickets SET status = 'cancelled' WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)`,
      [id],
    );

    // Update or insert into refunds ledger
    const [existingRefunds] = await pool.execute(`SELECT id FROM refunds WHERE order_id = ?`, [id]);
    if (existingRefunds.length > 0) {
      await pool.execute(
        `UPDATE refunds SET
           status = 'processed', policy_circumstance = ?, clause_number = ?,
           processed_by = ?, processed_at = NOW(), admin_notes = COALESCE(?, admin_notes)
         WHERE order_id = ?`,
        [selectedCircumstance, clauseNum, req.user.id, adminNotes || null, id],
      );
    } else {
      await pool.execute(
        `INSERT INTO refunds (
           order_id, user_id, event_id, organizer_id, amount, reason,
           policy_circumstance, clause_number, initiated_by, status,
           processed_by, processed_at, admin_notes, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'processed', ?, NOW(), ?, NOW())`,
        [
          id,
          order.user_id,
          order.event_id,
          event.organizer_id || null,
          order.total_amount,
          reason || policyClause?.description || 'Refund processed',
          selectedCircumstance,
          clauseNum,
          isAdmin ? 'admin' : 'organizer',
          req.user.id,
          adminNotes || null,
        ],
      );
    }

    // Notify buyer with formal policy citation
    await sendNotification({
      userId: order.user_id,
      title: 'Refund Approved & Processed',
      message: `Your refund for Order #${id} has been processed per ${citation}. Reason: ${reason || policyClause?.title}.`,
      type: 'refund',
    });

    // If admin issued it, also notify organizer
    if (isAdmin && event.organizer_id) {
      await sendNotification({
        userId: event.organizer_id,
        title: 'Refund Executed on Event Order',
        message: `Order #${id} on "${event.title}" was refunded by TRIBESANDCLIQS per ${citation}.`,
        type: 'refund',
      });
    }

    await logAudit({
      userId: req.user.id,
      action: 'refund_order_approved',
      entityType: 'order',
      entityId: id,
      details: {
        reason,
        circumstance: selectedCircumstance,
        clauseNumber: clauseNum,
        citation,
        amount: order.total_amount,
      },
    });

    return res.json({
      message: `Refund processed successfully under ${citation}.`,
      status: 'refunded',
      circumstance: selectedCircumstance,
      clause: policyClause,
    });
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

    if (verifyResult.data.status === 'success') {
      if (order.payment_status !== 'completed') {
        await completeOrder(order.id, reference);
      }
    } else {
      return res.status(400).json({
        message: verifyResult.data.gateway_response || 'Payment not completed',
        status: verifyResult.data.status,
        orderId: order.id,
      });
    }

    // Fetch tickets and event data for the completed order so the attendee can view them immediately
    let tickets = [];
    let eventInfo = null;

    try {
      let [ticketRows] = await pool.execute(
        `SELECT DISTINCT ON (t.id) t.id, t.ticket_number, t.qr_code, t.status, t.seat_number, t.created_at,
                t.ticket_file_url, t.ticket_file_name,
                tt.name AS ticket_type_name, COALESCE(oi.unit_price, tt.price, 0) AS price,
                COALESCE(oi.unit_price, tt.price, 0) AS unit_price,
                e.id AS event_id, e.title AS event_title, e.venue AS event_venue, e.location AS event_location,
                e.start_date, e.end_date, e.start_time, e.end_time, e.banner_image, e.ticket_template,
                u.name AS attendee_name, u.email AS attendee_email
         FROM tickets t
         LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
         LEFT JOIN events e ON e.id = t.event_id
         LEFT JOIN users u ON u.id = t.user_id
         LEFT JOIN order_items oi ON oi.id = t.order_item_id
         WHERE oi.order_id = ?
         ORDER BY t.id ASC`,
        [order.id],
      );

      if (!ticketRows || ticketRows.length === 0) {
        await generateTicketsForOrder(order.id);
        const [refetched] = await pool.execute(
          `SELECT DISTINCT ON (t.id) t.id, t.ticket_number, t.qr_code, t.status, t.seat_number, t.created_at,
                  t.ticket_file_url, t.ticket_file_name,
                  tt.name AS ticket_type_name, COALESCE(oi.unit_price, tt.price, 0) AS price,
                  COALESCE(oi.unit_price, tt.price, 0) AS unit_price,
                  e.id AS event_id, e.title AS event_title, e.venue AS event_venue, e.location AS event_location,
                  e.start_date, e.end_date, e.start_time, e.end_time, e.banner_image, e.ticket_template,
                  u.name AS attendee_name, u.email AS attendee_email
           FROM tickets t
           LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
           LEFT JOIN events e ON e.id = t.event_id
           LEFT JOIN users u ON u.id = t.user_id
           LEFT JOIN order_items oi ON oi.id = t.order_item_id
           WHERE oi.order_id = ?
           ORDER BY t.id ASC`,
          [order.id],
        );
        ticketRows = refetched;
      }

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

  const sep = appRedirect.includes('?') ? '&' : '?';
  const target = reference
    ? `${appRedirect}${sep}reference=${encodeURIComponent(reference)}&status=success`
    : appRedirect;

  // Immediately redirect HTTP 302 so mobile browser or web app intercepts and returns to tickets
  if (req.query.no_redirect !== 'true' && !req.query.preview_bridge) {
    return res.redirect(302, target);
  }

  const encodedRef = encodeURIComponent(reference);

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="0;url=${target}">
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
      border: 1px solid #2E363E;
      border-radius: 24px;
      padding: 36px 24px;
      text-align: center;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
    }
    .icon-circle {
      width: 68px;
      height: 68px;
      border-radius: 50%;
      background-color: rgba(16, 185, 129, 0.15);
      border: 2px solid #10B981;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 16px auto;
      color: #10B981;
      font-size: 34px;
      font-weight: 800;
    }
    .title {
      font-size: 22px;
      font-weight: 800;
      color: #EFEFF1;
      margin: 0 0 8px 0;
      letter-spacing: -0.3px;
    }
    .desc {
      color: #949599;
      font-size: 14px;
      line-height: 1.5;
      margin: 0 0 20px 0;
    }
    .ref-box {
      background-color: #161D22;
      border: 1px dashed #3A444E;
      border-radius: 12px;
      padding: 12px 14px;
      margin-bottom: 24px;
      font-size: 13px;
      color: #949599;
    }
    .ref-code {
      font-family: monospace;
      color: #CBD5E1;
      font-weight: 700;
    }
    .btn {
      display: block;
      background: #EFEFF1;
      color: #1C232B;
      padding: 15px 24px;
      border-radius: 14px;
      text-decoration: none;
      font-weight: 800;
      font-size: 15px;
      margin-bottom: 12px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
    }
    .btn-secondary {
      background-color: rgba(255, 255, 255, 0.05);
      border: 1px solid #2E363E;
      color: #CBD5E1;
      font-weight: 600;
      font-size: 13px;
      padding: 12px 20px;
      border-radius: 12px;
      text-decoration: none;
      display: block;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon-circle">✓</div>
    <h2 class="title">Payment Successful!</h2>
    <p class="desc">Your tickets have been issued and added to your mobile wallet.</p>
    ${reference ? `<div class="ref-box">Order Reference: <span class="ref-code">${reference}</span></div>` : ''}
    <a id="returnBtn" class="btn" href="${target}">View Tickets in App</a>
    <a id="dismissBtn" class="btn btn-secondary" href="javascript:window.close();">Done</a>
  </div>
  <script>
    (function() {
      var target = '${target}';
      try {
        window.location.replace(target);
      } catch(e) {
        window.location.href = target;
      }

      setTimeout(function() {
        if (/android/i.test(navigator.userAgent) && !target.startsWith('exp:')) {
          var intentTarget = 'intent://payment-callback?reference=' + encodeURIComponent('${encodedRef}') + '#Intent;scheme=tribescliqs;package=com.tribesandcliqs.app;end';
          window.location.href = intentTarget;
        }
      }, 400);

      setTimeout(function() {
        try { window.close(); } catch(e) {}
      }, 1000);
    })();
  </script>
</body>
</html>`);
};

export default {
  createOrder, getOrder, getReceiptOrder, getUserOrders, getOrganizerOrders, cancelOrder, requestRefund, verifyPayment,
  applyCouponHandler, initiateOrderPayment, getOrderInvoice, testWebhook, paymentCallbackBridge,
};
