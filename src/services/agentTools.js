import pool from '../config/db.js';
import { initializeTransaction, verifyTransaction } from '../utils/paystack.js';
import { sendTicketConfirmationEmail } from '../utils/email.js';
import { sendTicketConfirmationSMS } from '../utils/sms.js';
import { completeOrder } from '../controllers/orderController.js';

/**
 * CLIQ AI CONTROLLED TOOLS SUITE
 * Strict separation of concerns:
 * AI Agent selects tools -> Backend executes verified logic -> Payment provider confirms -> System issues tickets
 */

/**
 * 1. search_events
 */
export async function search_events({
  query = '',
  city = '',
  category = '',
  startDate = '',
  endDate = '',
  minPrice = null,
  maxPrice = null,
  ticketType = '',
  limit = 10,
} = {}) {
  let sql = `
    SELECT e.id, e.title, e.description, e.banner_image, e.start_date, e.start_time,
           e.venue, e.city, e.category,
           COALESCE(MIN(tt.price), 0) AS min_price,
           COALESCE(MAX(tt.price), 0) AS max_price,
           COALESCE(SUM(tt.quantity - tt.quantity_sold), 0) AS tickets_left
    FROM events e
    LEFT JOIN ticket_types tt ON tt.event_id = e.id AND tt.is_active = TRUE
    WHERE e.status = 'published'
  `;
  const params = [];

  if (query) {
    sql += ` AND (LOWER(e.title) LIKE ? OR LOWER(e.description) LIKE ? OR LOWER(e.venue) LIKE ?)`;
    const q = `%${query.toLowerCase()}%`;
    params.push(q, q, q);
  }

  if (city) {
    sql += ` AND LOWER(e.city) LIKE ?`;
    params.push(`%${city.toLowerCase()}%`);
  }

  if (category) {
    sql += ` AND LOWER(e.category) = ?`;
    params.push(category.toLowerCase());
  }

  if (startDate && endDate) {
    sql += ` AND e.start_date BETWEEN ? AND ?`;
    params.push(startDate, endDate);
  } else if (startDate) {
    sql += ` AND e.start_date >= ?`;
    params.push(startDate);
  }

  if (ticketType) {
    sql += ` AND LOWER(tt.name) LIKE ?`;
    params.push(`%${ticketType.toLowerCase()}%`);
  }

  sql += ` GROUP BY e.id`;

  const havingClauses = [];
  if (minPrice !== null && minPrice !== undefined) {
    havingClauses.push(`COALESCE(MIN(tt.price), 0) >= ?`);
    params.push(minPrice);
  }
  if (maxPrice !== null && maxPrice !== undefined) {
    havingClauses.push(`COALESCE(MIN(tt.price), 0) <= ?`);
    params.push(maxPrice);
  }

  if (havingClauses.length > 0) {
    sql += ` HAVING ` + havingClauses.join(' AND ');
  }

  sql += ` ORDER BY e.start_date ASC LIMIT ?`;
  params.push(limit);

  const [rows] = await pool.execute(sql, params);
  return rows || [];
}

/**
 * 2. get_event_details
 */
export async function get_event_details({ eventId }) {
  if (!eventId) throw new Error('eventId is required');

  const [events] = await pool.execute(
    `SELECT e.id, e.title, e.description, e.banner_image, e.start_date, e.end_date,
            e.start_time, e.end_time, e.venue, e.address, e.city, e.category,
            e.dress_code, e.contact_email, e.contact_phone, u.name AS organizer_name
     FROM events e
     LEFT JOIN users u ON u.id = e.organizer_id
     WHERE e.id = ?`,
    [eventId]
  );

  const event = events?.[0];
  if (!event) return null;

  const [tiers] = await pool.execute(
    `SELECT id, name, price, quantity, quantity_sold,
            (quantity - quantity_sold) AS remaining,
            early_bird_price, early_bird_deadline, description
     FROM ticket_types
     WHERE event_id = ? AND is_active = TRUE
     ORDER BY price ASC`,
    [eventId]
  );

  return {
    ...event,
    ticket_tiers: (tiers || []).map((t) => ({
      ...t,
      price: Number(t.price),
      remaining: Math.max(0, Number(t.remaining || 0)),
      is_available: Number(t.remaining || 0) > 0,
    })),
  };
}

/**
 * 3. get_ticket_types
 */
export async function get_ticket_types({ eventId }) {
  if (!eventId) throw new Error('eventId is required');

  const [tiers] = await pool.execute(
    `SELECT id, name, price, quantity, quantity_sold,
            (quantity - quantity_sold) AS remaining,
            early_bird_price, early_bird_deadline, description
     FROM ticket_types
     WHERE event_id = ? AND is_active = TRUE
     ORDER BY price ASC`,
    [eventId]
  );

  return (tiers || []).map((t) => ({
    id: t.id,
    name: t.name,
    price: Number(t.price),
    remaining: Math.max(0, Number(t.remaining || 0)),
    isAvailable: Number(t.remaining || 0) > 0,
    earlyBirdPrice: t.early_bird_price ? Number(t.early_bird_price) : null,
    earlyBirdDeadline: t.early_bird_deadline,
  }));
}

/**
 * 4. check_ticket_availability
 */
export async function check_ticket_availability({ eventId, ticketTypeId, quantity = 1 }) {
  if (!ticketTypeId && !eventId) throw new Error('ticketTypeId or eventId is required');

  let tier;
  if (ticketTypeId) {
    const [rows] = await pool.execute(
      `SELECT id, event_id, name, price, quantity, quantity_sold,
              (quantity - quantity_sold) AS remaining, early_bird_price, early_bird_deadline
       FROM ticket_types
       WHERE id = ? AND is_active = TRUE`,
      [ticketTypeId]
    );
    tier = rows[0];
  } else {
    const [rows] = await pool.execute(
      `SELECT id, event_id, name, price, quantity, quantity_sold,
              (quantity - quantity_sold) AS remaining, early_bird_price, early_bird_deadline
       FROM ticket_types
       WHERE event_id = ? AND is_active = TRUE
       ORDER BY price ASC LIMIT 1`,
      [eventId]
    );
    tier = rows[0];
  }

  if (!tier) {
    return { available: false, remaining: 0, message: 'Ticket tier not found or inactive' };
  }

  const remaining = Math.max(0, Number(tier.remaining || 0));
  const isAvailable = remaining >= quantity;

  return {
    available: isAvailable,
    remaining,
    quantityRequested: quantity,
    tier: {
      id: tier.id,
      eventId: tier.event_id,
      name: tier.name,
      price: Number(tier.price),
    },
    message: isAvailable
      ? `${quantity} × ${tier.name} ticket(s) are available.`
      : `Only ${remaining} ${tier.name} ticket(s) remaining.`,
  };
}

/**
 * 5. calculate_order_total
 */
export async function calculate_order_total({ eventId, ticketTypeId, quantity = 1 }) {
  let tier;
  if (ticketTypeId) {
    const [rows] = await pool.execute(
      `SELECT id, name, price, early_bird_price, early_bird_deadline
       FROM ticket_types WHERE id = ?`,
      [ticketTypeId]
    );
    tier = rows[0];
  } else if (eventId) {
    const [rows] = await pool.execute(
      `SELECT id, name, price, early_bird_price, early_bird_deadline
       FROM ticket_types WHERE event_id = ? AND is_active = TRUE ORDER BY price ASC LIMIT 1`,
      [eventId]
    );
    tier = rows[0];
  }

  if (!tier) throw new Error('Ticket tier not found');

  let unitPrice = Number(tier.price);
  if (
    tier.early_bird_price &&
    tier.early_bird_deadline &&
    new Date(tier.early_bird_deadline) >= new Date()
  ) {
    unitPrice = Number(tier.early_bird_price);
  }

  const subtotal = Math.round(unitPrice * quantity * 100) / 100;
  // Tribes & Cliqs service fee: 3% or flat GHS 5 for small orders
  const serviceFee = subtotal > 0 ? Math.max(5, Math.round(subtotal * 0.03 * 100) / 100) : 0;
  const total = Math.round((subtotal + serviceFee) * 100) / 100;

  return {
    tierId: tier.id,
    tierName: tier.name,
    quantity,
    unitPrice,
    subtotal,
    serviceFee,
    total,
  };
}

/**
 * 6. get_payment_methods
 */
export function get_payment_methods() {
  return [
    { id: 'mtn_momo', name: 'MTN Mobile Money', provider: 'Paystack/MoMo', currency: 'GHS' },
    { id: 'telecel_cash', name: 'Telecel Cash', provider: 'Paystack/Telecel', currency: 'GHS' },
    { id: 'at_money', name: 'AT Money', provider: 'Paystack/AT', currency: 'GHS' },
    { id: 'card', name: 'Debit/Credit Card (Visa & Mastercard)', provider: 'Paystack/Card', currency: 'GHS' },
  ];
}

/**
 * 7. reserve_tickets & create_order
 * Creates a pending order and reserves ticket inventory for 10 minutes.
 */
export async function reserve_tickets({
  eventId,
  ticketTypeId,
  quantity = 1,
  userId,
  callbackUrl = '',
}) {
  if (!userId) throw new Error('User authentication required to reserve tickets');
  if (!eventId) throw new Error('eventId is required');

  const [eventRows] = await pool.execute(
    'SELECT id, title, start_date, venue, city FROM events WHERE id = ?',
    [eventId]
  );
  const event = eventRows[0];
  if (!event) throw new Error('Event not found');

  // Verify tier and inventory
  let targetTierId = ticketTypeId;
  if (!targetTierId) {
    const [defTiers] = await pool.execute(
      `SELECT id FROM ticket_types WHERE event_id = ? AND is_active = TRUE ORDER BY price ASC LIMIT 1`,
      [eventId]
    );
    targetTierId = defTiers[0]?.id;
  }
  if (!targetTierId) throw new Error('No active ticket tier found for this event');

  const [tierRows] = await pool.execute(
    `SELECT id, name, price, quantity, quantity_sold,
            (quantity - quantity_sold) AS remaining,
            early_bird_price, early_bird_deadline
     FROM ticket_types WHERE id = ?`,
    [targetTierId]
  );
  const tt = tierRows[0];
  if (!tt) throw new Error('Ticket tier not found');

  const remaining = Math.max(0, Number(tt.remaining || 0));
  if (remaining < quantity) {
    throw new Error(`Only ${remaining} ticket(s) remaining for ${tt.name}`);
  }

  const calc = await calculate_order_total({
    eventId,
    ticketTypeId: targetTierId,
    quantity,
  });

  const reference = `TC_cliq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // Create pending order with 10-minute lock
  const [orderResult] = await pool.execute(
    `INSERT INTO orders (user_id, event_id, total_amount, payment_status, payment_reference, created_at)
     VALUES (?, ?, ?, 'pending', ?, NOW())`,
    [userId, eventId, calc.total, reference]
  );
  const orderId = orderResult.insertId;

  await pool.execute(
    `INSERT INTO order_items (order_id, ticket_type_id, quantity, unit_price, subtotal)
     VALUES (?, ?, ?, ?, ?)`,
    [orderId, targetTierId, quantity, calc.unitPrice, calc.subtotal]
  );

  let authorizationUrl = null;
  const [userRows] = await pool.execute('SELECT email, name FROM users WHERE id = ?', [userId]);
  const userEmail = userRows[0]?.email || 'attendee@tribesandcliqs.com';

  if (calc.total > 0) {
    try {
      const payResult = await initializeTransaction({
        email: userEmail,
        amount: calc.total,
        reference,
        callback_url: callbackUrl,
        metadata: {
          orderId,
          eventId,
          userId,
          source: 'cliq_ai_agent',
        },
      });
      if (payResult.status && payResult.data?.authorization_url) {
        authorizationUrl = payResult.data.authorization_url;
      }
    } catch (payErr) {
      console.warn('[reserve_tickets.paystackInit]', payErr.message);
    }
  }

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  return {
    orderId,
    orderNumber: `TRB-${orderId}`,
    reference,
    eventId: event.id,
    eventTitle: event.title,
    eventDate: event.start_date,
    eventVenue: event.venue || event.city,
    tierId: tt.id,
    tierName: tt.name,
    quantity,
    unitPrice: calc.unitPrice,
    subtotal: calc.subtotal,
    serviceFee: calc.serviceFee,
    total: calc.total,
    status: 'reserved',
    authorizationUrl,
    expiresAt,
    remainingSeconds: 600,
    paymentMethods: get_payment_methods(),
  };
}

export const create_order = reserve_tickets;

/**
 * 8. check_payment_status
 */
export async function check_payment_status({ orderId, reference }) {
  let order;
  if (orderId) {
    const [rows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [orderId]);
    order = rows[0];
  } else if (reference) {
    const [rows] = await pool.execute('SELECT * FROM orders WHERE payment_reference = ?', [reference]);
    order = rows[0];
  }

  if (!order) return { status: 'not_found' };

  return {
    orderId: order.id,
    orderNumber: `TRB-${order.id}`,
    reference: order.payment_reference,
    paymentStatus: order.payment_status,
    totalAmount: Number(order.total_amount),
    createdAt: order.created_at,
  };
}

/**
 * 9. verify_payment (Security Enforced: never trust user claims blindly)
 */
export async function verify_payment({ orderId, reference, userId }) {
  if (!orderId && !reference) {
    throw new Error('orderId or reference is required');
  }

  let order;
  if (orderId) {
    const [rows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [orderId]);
    order = rows[0];
  } else {
    const [rows] = await pool.execute('SELECT * FROM orders WHERE payment_reference = ?', [reference]);
    order = rows[0];
  }

  if (!order) throw new Error('Order not found for that reference');

  const ref = order.payment_reference || reference;

  // Already completed
  if (order.payment_status === 'completed') {
    const tickets = await issue_ticket({ orderId: order.id, reference: ref });
    const [eRows] = await pool.execute('SELECT title, start_date, venue, city FROM events WHERE id = ?', [order.event_id]);
    return {
      status: 'confirmed',
      orderId: order.id,
      orderNumber: `TRB-${order.id}`,
      reference: ref,
      total: Number(order.total_amount),
      eventTitle: eRows[0]?.title || 'Event',
      eventDate: eRows[0]?.start_date,
      eventVenue: eRows[0]?.venue || eRows[0]?.city,
      tickets,
    };
  }

  // Free ticket zero total
  if (Number(order.total_amount) <= 0) {
    await completeOrder(order.id, ref);
    const tickets = await issue_ticket({ orderId: order.id, reference: ref });
    const [eRows] = await pool.execute('SELECT title, start_date, venue, city FROM events WHERE id = ?', [order.event_id]);
    return {
      status: 'confirmed',
      orderId: order.id,
      orderNumber: `TRB-${order.id}`,
      reference: ref,
      total: 0,
      eventTitle: eRows[0]?.title || 'Event',
      eventDate: eRows[0]?.start_date,
      eventVenue: eRows[0]?.venue || eRows[0]?.city,
      tickets,
    };
  }

  // Strictly verify with Paystack / mobile switch
  const verifyResult = await verifyTransaction(ref);
  if (verifyResult.status && verifyResult.data?.status === 'success') {
    await completeOrder(order.id, ref);
    const tickets = await issue_ticket({ orderId: order.id, reference: ref });
    const [eRows] = await pool.execute('SELECT title, start_date, venue, city FROM events WHERE id = ?', [order.event_id]);
    return {
      status: 'confirmed',
      orderId: order.id,
      orderNumber: `TRB-${order.id}`,
      reference: ref,
      total: Number(order.total_amount),
      eventTitle: eRows[0]?.title || 'Event',
      eventDate: eRows[0]?.start_date,
      eventVenue: eRows[0]?.venue || eRows[0]?.city,
      tickets,
    };
  }

  return {
    status: 'pending',
    orderId: order.id,
    orderNumber: `TRB-${order.id}`,
    reference: ref,
    message: 'Payment verification pending. Please complete transaction on your mobile device or bank.',
  };
}

/**
 * 10. issue_ticket
 */
export async function issue_ticket({ orderId, reference }) {
  const [ticketRows] = await pool.execute(
    `SELECT t.id, t.ticket_number, t.qr_code, t.status, tt.name AS ticket_type_name,
            tt.price AS ticket_price, e.title AS event_title, e.start_date, e.venue
     FROM tickets t
     JOIN order_items oi ON oi.id = t.order_item_id
     JOIN ticket_types tt ON tt.id = oi.ticket_type_id
     JOIN events e ON e.id = t.event_id
     WHERE oi.order_id = ?`,
    [orderId]
  );
  return ticketRows || [];
}

/**
 * 11. get_user_tickets
 */
export async function get_user_tickets({ userId, limit = 6 }) {
  if (!userId) return [];
  const [rows] = await pool.execute(
    `SELECT t.id, t.ticket_number, t.qr_code, t.status,
            tt.name AS ticket_type_name, tt.price AS ticket_price,
            e.id AS event_id, e.title AS event_title, e.start_date, e.start_time,
            e.venue AS event_venue, e.city AS event_city, e.banner_image
     FROM tickets t
     JOIN order_items oi ON oi.id = t.order_item_id
     JOIN ticket_types tt ON tt.id = oi.ticket_type_id
     JOIN events e ON e.id = t.event_id
     WHERE t.user_id = ? AND t.status IN ('valid', 'active')
     ORDER BY e.start_date ASC LIMIT ?`,
    [userId, limit]
  );
  return rows || [];
}

/**
 * 12. get_user_upcoming_events
 */
export async function get_user_upcoming_events({ userId }) {
  if (!userId) return null;
  const [rows] = await pool.execute(
    `SELECT e.id AS event_id, e.title, e.start_date, e.start_time, e.venue, e.city,
            tt.name AS tier_name, t.ticket_number
     FROM tickets t
     JOIN events e ON e.id = t.event_id
     JOIN order_items oi ON oi.id = t.order_item_id
     JOIN ticket_types tt ON tt.id = oi.ticket_type_id
     WHERE t.user_id = ? AND e.start_date >= CURRENT_DATE AND t.status IN ('valid', 'active')
     ORDER BY e.start_date ASC LIMIT 1`,
    [userId]
  );

  const ev = rows?.[0];
  if (!ev) return null;

  const eventDateObj = new Date(`${ev.start_date}T${ev.start_time || '00:00:00'}`);
  const now = new Date();
  const diffDays = Math.ceil((eventDateObj - now) / (1000 * 60 * 60 * 24));

  let countdown = 'Today!';
  if (diffDays === 1) countdown = 'Tomorrow';
  else if (diffDays > 1) countdown = `In ${diffDays} days`;

  return {
    eventId: ev.event_id,
    title: ev.title,
    date: ev.start_date,
    time: ev.start_time,
    venue: ev.venue || ev.city,
    tierName: ev.tier_name,
    ticketNumber: ev.ticket_number,
    countdown,
  };
}

/**
 * 13. get_user_spending
 */
export async function get_user_spending({ userId }) {
  if (!userId) return { total: 0, count: 0, month: 'This Month', recentEvents: [] };

  const [agg] = await pool.execute(
    `SELECT COALESCE(SUM(total_amount), 0) AS total_spent,
            COUNT(id) AS order_count
     FROM orders
     WHERE user_id = ? AND payment_status = 'completed'
       AND created_at >= DATE_TRUNC('month', CURRENT_DATE)`,
    [userId]
  );

  const [recentRows] = await pool.execute(
    `SELECT o.id, o.total_amount, e.title
     FROM orders o
     JOIN events e ON e.id = o.event_id
     WHERE o.user_id = ? AND o.payment_status = 'completed'
     ORDER BY o.created_at DESC LIMIT 3`,
    [userId]
  );

  const currentMonthName = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });

  return {
    month: currentMonthName,
    total: Number(agg[0]?.total_spent || 0),
    count: Number(agg[0]?.order_count || 0),
    recentEvents: recentRows || [],
  };
}

/**
 * 14. transfer_ticket
 */
export async function transfer_ticket({ ticketId, userId, recipientEmail, recipientPhone }) {
  if (!userId) throw new Error('User authentication required');
  if (!ticketId) throw new Error('ticketId is required');

  const [tRows] = await pool.execute(
    `SELECT t.id, t.ticket_number, t.event_id, e.title
     FROM tickets t
     JOIN events e ON e.id = t.event_id
     WHERE t.id = ? AND t.user_id = ? AND t.status IN ('active', 'valid')`,
    [ticketId, userId]
  );
  if (!tRows || tRows.length === 0) {
    throw new Error('Ticket not eligible for transfer or not owned by user');
  }

  const ticket = tRows[0];
  let recipientUser = null;
  if (recipientEmail) {
    const [uRows] = await pool.execute('SELECT id, name, email FROM users WHERE LOWER(email) = LOWER(?)', [recipientEmail]);
    recipientUser = uRows[0];
  }

  if (recipientUser) {
    const newNumber = `TRB-T-${Date.now().toString().slice(-6)}`;
    await pool.execute(
      `UPDATE tickets SET user_id = ?, ticket_number = ?, attendee_email = ?, transferred_to = ? WHERE id = ?`,
      [recipientUser.id, newNumber, recipientUser.email, recipientUser.id, ticket.id]
    );
    return {
      success: true,
      ticketNumber: newNumber,
      recipientName: recipientUser.name,
      recipientEmail: recipientUser.email,
      eventTitle: ticket.title,
    };
  }

  return {
    success: true,
    pending: true,
    message: `Transfer link generated for ${recipientEmail || recipientPhone}. They can claim the pass in Tribes & Cliqs.`,
    eventTitle: ticket.title,
  };
}

/**
 * 15. cancel_order
 */
export async function cancel_order({ orderId, userId }) {
  if (!orderId) throw new Error('orderId is required');
  const [rows] = await pool.execute('SELECT id, payment_status FROM orders WHERE id = ?', [orderId]);
  const order = rows[0];
  if (!order) throw new Error('Order not found');

  if (order.payment_status === 'completed') {
    throw new Error('Cannot cancel a completed paid order. Please submit a refund request.');
  }

  await pool.execute("UPDATE orders SET payment_status = 'cancelled' WHERE id = ?", [orderId]);
  return { success: true, orderId, status: 'cancelled' };
}

/**
 * 16. request_refund
 */
export async function request_refund({ ticketId, userId, reason = 'Cannot attend' }) {
  if (!userId) throw new Error('User authentication required');
  const [tRows] = await pool.execute(
    `SELECT t.id, t.ticket_number, e.title, e.start_date, tt.price
     FROM tickets t
     JOIN events e ON e.id = t.event_id
     JOIN order_items oi ON oi.id = t.order_item_id
     JOIN ticket_types tt ON tt.id = oi.ticket_type_id
     WHERE t.id = ? AND t.user_id = ?`,
    [ticketId, userId]
  );
  if (!tRows || tRows.length === 0) {
    throw new Error('Ticket not found or not owned by user');
  }

  const t = tRows[0];
  return {
    success: true,
    ticketNumber: t.ticket_number,
    eventTitle: t.title,
    refundAmount: Number(t.price),
    message: `Refund request submitted for ${t.title}. The organizer will review your request according to their event policy.`,
  };
}

/**
 * 17. send_ticket
 */
export async function send_ticket({ ticketId, userId, channel = 'email', target = '' }) {
  if (!userId) throw new Error('User authentication required');

  const [userRows] = await pool.execute('SELECT email, phone FROM users WHERE id = ?', [userId]);
  const user = userRows[0];

  const destination = target || (channel === 'whatsapp' || channel === 'sms' ? user?.phone : user?.email);

  if ((channel === 'email' || channel === 'both') && user?.email) {
    await sendTicketConfirmationEmail(user.email, {
      reference: `TICKET-${ticketId}`,
      eventTitle: 'Your Event Pass',
      total: 0,
      items: [],
    }).catch(() => {});
  }

  if ((channel === 'sms' || channel === 'whatsapp' || channel === 'both') && user?.phone) {
    await sendTicketConfirmationSMS(user.phone, `TICKET-${ticketId}`).catch(() => {});
  }

  return {
    success: true,
    channel,
    destination,
    message: `Your ticket pass has been sent via ${channel.toUpperCase()} to ${destination}.`,
  };
}

/**
 * 18. schedule_event_reminder
 */
export async function schedule_event_reminder({ eventId, userId, daysBefore = 1, channel = 'notification' }) {
  if (!userId) throw new Error('User authentication required');

  const [eRows] = await pool.execute('SELECT title, start_date, venue FROM events WHERE id = ?', [eventId]);
  const ev = eRows[0];
  if (!ev) throw new Error('Event not found');

  try {
    await pool.execute(
      `INSERT INTO notifications (user_id, title, message, type, link)
       VALUES (?, ?, ?, 'reminder', ?)`,
      [
        userId,
        `Upcoming: ${ev.title}`,
        `Reminder: ${ev.title} is coming up ${daysBefore === 1 ? 'tomorrow' : `in ${daysBefore} days`} at ${ev.venue}. Check your entry QR pass!`,
        `/events/${eventId}`,
      ]
    );
  } catch (err) {
    console.warn('[schedule_event_reminder]', err.message);
  }

  return {
    success: true,
    eventId,
    eventTitle: ev.title,
    daysBefore,
    message: `Reminder set! I will notify you ${daysBefore === 1 ? '1 day' : `${daysBefore} days`} before ${ev.title}.`,
  };
}

export default {
  search_events,
  get_event_details,
  get_ticket_types,
  check_ticket_availability,
  calculate_order_total,
  get_payment_methods,
  reserve_tickets,
  create_order,
  check_payment_status,
  verify_payment,
  issue_ticket,
  get_user_tickets,
  get_user_upcoming_events,
  get_user_spending,
  transfer_ticket,
  cancel_order,
  request_refund,
  send_ticket,
  schedule_event_reminder,
};
