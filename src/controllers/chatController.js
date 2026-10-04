import pool from '../config/db.js';
import agentTools, {
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
} from '../services/agentTools.js';
import {
  rankEventsWithML,
  classifySentimentAndUrgency,
  predictEventDemand,
} from '../utils/mlEngine.js';
import {
  voiceModel,
  correctVoicePhonetics,
  formatVoiceUtterance,
  analyzeVoiceEmotion,
} from '../utils/voiceMLEngine.js';
import { initializeTransaction, verifyTransaction } from '../utils/paystack.js';
import { sendTicketConfirmationEmail } from '../utils/email.js';
import { sendTicketConfirmationSMS } from '../utils/sms.js';
import { completeOrder } from './orderController.js';

export { agentTools };

const getGeminiApiKey = () => process.env.GEMINI_API_KEY || '';
const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-flash-latest'];

/**
 * Date and parsing utilities
 */
function getWeekendRange() {
  const now = new Date();
  const day = now.getDay(); // 0 is Sunday, 5 is Friday, 6 is Saturday
  const diffToFriday = (5 - day + 7) % 7;
  const friday = new Date(now);
  friday.setDate(now.getDate() + diffToFriday);
  const sunday = new Date(friday);
  sunday.setDate(friday.getDate() + 2);
  return {
    start: friday.toISOString().slice(0, 10),
    end: sunday.toISOString().slice(0, 10),
  };
}

function getNextDayOfWeekDate(dayOfWeekIndex) {
  const now = new Date();
  const currentDay = now.getDay();
  let diff = (dayOfWeekIndex - currentDay + 7) % 7;
  if (diff === 0) diff = 7; // Next week's occurrence
  const target = new Date(now);
  target.setDate(now.getDate() + diff);
  return target.toISOString().slice(0, 10);
}

function extractQuantity(text) {
  if (!text) return null;
  const numberWords = {
    'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
    'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
    'single': 1, 'couple': 2, 'pair': 2,
  };
  const lower = text.toLowerCase();
  for (const [w, n] of Object.entries(numberWords)) {
    const r = new RegExp(`\\b${w}\\b(?:\\s+(?:vip|vvip|regular|ticket|tickets|pass|passes))?`, 'i');
    if (r.test(lower)) return n;
  }
  const digitMatch = lower.match(/\b([1-9]|10)\b(?:\s*(?:x|tickets?|passes?))?/);
  if (digitMatch) return parseInt(digitMatch[1], 10);
  return null;
}

function extractTierName(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  if (lower.includes('vvip')) return 'VVIP';
  if (lower.includes('vip')) return 'VIP';
  if (lower.includes('regular') || lower.includes('standard') || lower.includes('general admission') || lower.includes('gen admission')) return 'Regular';
  if (lower.includes('early bird') || lower.includes('earlybird')) return 'Early Bird';
  if (lower.includes('table')) return 'Table';
  if (lower.includes('student')) return 'Student';
  return null;
}

function extractCity(text) {
  if (!text) return '';
  const lower = text.toLowerCase();
  if (lower.includes('kumasi')) return 'Kumasi';
  if (lower.includes('takoradi')) return 'Takoradi';
  if (lower.includes('cape coast')) return 'Cape Coast';
  if (lower.includes('tamale')) return 'Tamale';
  if (lower.includes('tema')) return 'Tema';
  if (lower.includes('accra') || lower.includes('osu') || lower.includes('labadi') || lower.includes('east legon')) return 'Accra';
  return '';
}

function extractBudget(text) {
  if (!text) return null;
  const match = text.match(/(?:under|below|max|budget|within|less than|up to)\s*(?:ghs|cedis|₵)?\s*([0-9]+)/i);
  if (match) return Number(match[1]);
  if (/affordable|cheap/i.test(text)) return 200;
  if (/free/i.test(text)) return 0;
  return null;
}

/**
 * Fetch top published upcoming events for general recommendations
 */
async function getLiveEventsContext(limit = 10) {
  try {
    const [events] = await pool.execute(`
      SELECT e.id, e.title, e.description, e.banner_image, e.start_date, e.start_time, e.venue, e.city, e.category,
             COALESCE(MIN(tt.price), 0) AS min_price
      FROM events e
      LEFT JOIN ticket_types tt ON tt.event_id = e.id
      WHERE e.status = 'published' AND e.start_date >= CURRENT_DATE
      GROUP BY e.id
      ORDER BY e.start_date ASC
      LIMIT ?
    `, [limit]);

    if (!events || events.length === 0) {
      const [fallbackEvents] = await pool.execute(`
        SELECT e.id, e.title, e.description, e.banner_image, e.start_date, e.start_time, e.venue, e.city, e.category,
               COALESCE(MIN(tt.price), 0) AS min_price
        FROM events e
        LEFT JOIN ticket_types tt ON tt.event_id = e.id
        WHERE e.status = 'published'
        GROUP BY e.id
        ORDER BY e.created_at DESC
        LIMIT ?
      `, [limit]);
      return fallbackEvents || [];
    }

    return events || [];
  } catch (err) {
    console.error('[chatController.getLiveEventsContext]', err.message);
    return [];
  }
}

/**
 * Fetch specific event details and active ticket tiers
 */
async function getSingleEventContext(eventId) {
  if (!eventId) return null;
  try {
    const [events] = await pool.execute(`
      SELECT e.id, e.title, e.description, e.banner_image, e.start_date, e.end_date, e.start_time, e.end_time,
             e.venue, e.address, e.city, e.category, e.dress_code, e.contact_email, e.contact_phone,
             u.name AS organizer_name
      FROM events e
      LEFT JOIN users u ON u.id = e.organizer_id
      WHERE e.id = ?
    `, [eventId]);

    const event = events?.[0];
    if (!event) return null;

    const [tiers] = await pool.execute(`
      SELECT id, name, price, quantity, quantity_sold, early_bird_price, early_bird_deadline, description
      FROM ticket_types
      WHERE event_id = ? AND is_active = TRUE
      ORDER BY price ASC
    `, [eventId]);

    return {
      ...event,
      ticket_tiers: tiers || [],
    };
  } catch (err) {
    console.error('[chatController.getSingleEventContext]', err.message);
    return null;
  }
}

/**
 * Fetch user tickets from database
 */
async function getUserTicketsContext(userId, limit = 5) {
  if (!userId) return [];
  try {
    const [rows] = await pool.execute(`
      SELECT t.id, t.ticket_number, t.qr_code, t.status, t.created_at,
             tt.name AS ticket_type_name, tt.price AS ticket_price,
             e.id AS event_id, e.title AS event_title, e.start_date, e.start_time,
             e.venue AS event_venue, e.city AS event_city, e.banner_image
      FROM tickets t
      JOIN ticket_types tt ON tt.id = t.ticket_type_id
      JOIN events e ON e.id = t.event_id
      WHERE t.user_id = ?
      ORDER BY e.start_date DESC, t.id DESC
      LIMIT ?
    `, [userId, limit]);

    return rows || [];
  } catch (err) {
    console.error('[chatController.getUserTicketsContext]', err.message);
    return [];
  }
}

/**
 * Monthly spending aggregation
 */
export async function getUserMonthlySpending(userId) {
  if (!userId) return null;
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const monthName = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });

    const [sumRows] = await pool.execute(
      `SELECT COALESCE(SUM(total_amount), 0) AS total_spent, COUNT(*) AS count
       FROM orders
       WHERE user_id = ? AND payment_status = 'completed' AND created_at >= ?`,
      [userId, startOfMonth]
    );

    const [recentRows] = await pool.execute(
      `SELECT DISTINCT e.title, o.total_amount, o.created_at
       FROM orders o
       JOIN events e ON e.id = o.event_id
       WHERE o.user_id = ? AND o.payment_status = 'completed' AND o.created_at >= ?
       ORDER BY o.created_at DESC LIMIT 5`,
      [userId, startOfMonth]
    );

    return {
      total: Number(sumRows[0]?.total_spent || 0),
      count: Number(sumRows[0]?.count || 0),
      month: monthName,
      recentEvents: recentRows || [],
    };
  } catch (err) {
    console.error('[chatController.getUserMonthlySpending]', err.message);
    return null;
  }
}

/**
 * Next upcoming event for attendee
 */
export async function getUserNextUpcomingEvent(userId) {
  if (!userId) return null;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const [rows] = await pool.execute(
      `SELECT t.id, t.ticket_number, tt.name AS tier_name,
              e.id AS event_id, e.title, e.start_date, e.start_time, e.venue, e.city, e.banner_image, e.dress_code
       FROM tickets t
       JOIN ticket_types tt ON tt.id = t.ticket_type_id
       JOIN events e ON e.id = t.event_id
       WHERE t.user_id = ? AND t.status IN ('valid', 'active') AND e.start_date >= ?
       ORDER BY e.start_date ASC, e.start_time ASC
       LIMIT 1`,
      [userId, today]
    );
    if (!rows || rows.length === 0) return null;
    const ev = rows[0];

    const eventDateObj = new Date(`${ev.start_date}T${ev.start_time || '00:00'}`);
    const now = new Date();
    const diffHours = Math.round((eventDateObj - now) / 36e5);
    const diffDays = Math.floor(diffHours / 24);

    let countdown = '';
    if (diffHours <= 0) countdown = 'Happening today!';
    else if (diffHours < 24) countdown = `In ${diffHours} hours`;
    else if (diffDays === 1) countdown = 'Tomorrow';
    else countdown = `In ${diffDays} days`;

    return {
      id: ev.id,
      ticketNumber: ev.ticket_number,
      tierName: ev.tier_name,
      eventId: ev.event_id,
      title: ev.title,
      date: ev.start_date,
      time: ev.start_time,
      venue: [ev.venue, ev.city].filter(Boolean).join(', '),
      bannerImage: ev.banner_image,
      dressCode: ev.dress_code,
      countdown,
    };
  } catch (err) {
    console.error('[chatController.getUserNextUpcomingEvent]', err.message);
    return null;
  }
}

/**
 * Fetch organizer performance summary
 */
async function getOrganizerStatsContext(userId) {
  if (!userId) return null;
  try {
    const [events] = await pool.execute(`
      SELECT COUNT(DISTINCT e.id) AS total_events,
             COUNT(DISTINCT t.id) AS total_tickets_sold,
             COALESCE(SUM(o.total_amount), 0) AS total_revenue
      FROM events e
      LEFT JOIN tickets t ON t.event_id = e.id
      LEFT JOIN orders o ON o.event_id = e.id AND o.payment_status = 'completed'
      WHERE e.organizer_id = ?
    `, [userId]);

    return events?.[0] || { total_events: 0, total_tickets_sold: 0, total_revenue: 0 };
  } catch (err) {
    console.error('[chatController.getOrganizerStatsContext]', err.message);
    return null;
  }
}

/**
 * Fetch dynamic AI training knowledge & system instructions
 */
async function getAITrainingContext() {
  try {
    const [items] = await pool.execute(
      `SELECT title, category, keywords, instruction_or_answer
       FROM ai_training_knowledge
       WHERE is_active = TRUE
       ORDER BY id ASC`
    );

    const [settings] = await pool.execute(
      `SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('ai_custom_instructions', 'ai_temperature')`
    );

    const config = {};
    for (const row of settings || []) {
      config[row.setting_key] = row.setting_value;
    }

    return {
      knowledge: items || [],
      customInstructions: config.ai_custom_instructions || '',
      temperature: config.ai_temperature ? Number(config.ai_temperature) : 0.4,
    };
  } catch (err) {
    console.error('[chatController.getAITrainingContext]', err.message);
    return { knowledge: [], customInstructions: '', temperature: 0.4 };
  }
}

/**
 * Parameterized Event Search in database
 */
export async function searchEvents({
  query = '',
  category = '',
  city = '',
  startDate = '',
  endDate = '',
  isFree = false,
  maxPrice = null,
  ticketType = '',
}) {
  try {
    const conditions = ["e.status = 'published'"];
    const params = [];

    if (query) {
      conditions.push('(LOWER(e.title) LIKE ? OR LOWER(e.description) LIKE ? OR LOWER(e.venue) LIKE ?)');
      const q = `%${query.toLowerCase()}%`;
      params.push(q, q, q);
    }
    if (category) {
      conditions.push('LOWER(e.category) = ?');
      params.push(category.toLowerCase());
    }
    if (city) {
      conditions.push('LOWER(e.city) LIKE ?');
      params.push(`%${city.toLowerCase()}%`);
    }
    if (startDate) {
      conditions.push('e.start_date >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('e.start_date <= ?');
      params.push(endDate);
    }
    if (ticketType) {
      conditions.push('EXISTS (SELECT 1 FROM ticket_types tt2 WHERE tt2.event_id = e.id AND LOWER(tt2.name) LIKE ? AND tt2.is_active = TRUE)');
      params.push(`%${ticketType.toLowerCase()}%`);
    }

    const sql = `
      SELECT e.id, e.title, e.description, e.banner_image, e.start_date, e.start_time, e.venue, e.city, e.category,
             COALESCE(MIN(tt.price), 0) AS min_price
      FROM events e
      LEFT JOIN ticket_types tt ON tt.event_id = e.id
      WHERE ${conditions.join(' AND ')}
      GROUP BY e.id
      ${isFree ? 'HAVING COALESCE(MIN(tt.price), 0) = 0' : (maxPrice ? 'HAVING COALESCE(MIN(tt.price), 0) <= ' + Number(maxPrice) : '')}
      ORDER BY e.start_date ASC
      LIMIT 4
    `;

    const [rows] = await pool.execute(sql, params);
    return rows || [];
  } catch (err) {
    console.error('[chatController.searchEvents]', err.message);
    return [];
  }
}

/**
 * Fetch tickets and QR codes for completed order
 */
async function fetchOrderTickets(orderId) {
  try {
    const [ticketRows] = await pool.execute(
      `SELECT t.id, t.ticket_number, t.qr_code, t.status,
              tt.name AS ticket_type_name, COALESCE(oi.unit_price, tt.price, 0) AS price,
              e.id AS event_id, e.title AS event_title, e.venue AS event_venue,
              e.start_date, e.start_time, e.banner_image
       FROM tickets t
       LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
       LEFT JOIN events e ON e.id = t.event_id
       LEFT JOIN order_items oi ON oi.id = t.order_item_id
       WHERE oi.order_id = ? OR t.order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)
       ORDER BY t.id ASC`,
      [orderId, orderId]
    );
    return ticketRows || [];
  } catch {
    return [];
  }
}

/**
 * Core Agent Booking Hold (10-minute ticket reservation)
 */
export async function createAgentBookingHold({ userId, eventId, ticketTypeId, quantity = 1, callbackUrl }) {
  const [eventRows] = await pool.execute('SELECT * FROM events WHERE id = ?', [eventId]);
  const event = eventRows[0];
  if (!event || event.status !== 'published') {
    throw new Error('Event is not available for booking');
  }

  const [ttRows] = await pool.execute('SELECT * FROM ticket_types WHERE id = ? AND event_id = ?', [ticketTypeId, eventId]);
  const tt = ttRows[0];
  if (!tt) {
    throw new Error('Selected ticket tier not found');
  }

  const available = Number(tt.quantity) - Number(tt.quantity_sold);
  if (quantity > available) {
    throw new Error(`Only ${available} tickets left for ${tt.name}`);
  }

  let unitPrice = Number(tt.price);
  if (tt.early_bird_price && tt.early_bird_deadline && new Date(tt.early_bird_deadline) >= new Date()) {
    unitPrice = Number(tt.early_bird_price);
  }

  const subtotal = unitPrice * quantity;
  const serviceFee = subtotal > 0 ? Math.max(5, Math.round(subtotal * 0.03 * 100) / 100) : 0;
  const total = subtotal + serviceFee;

  const reference = `TC_agent_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const [orderResult] = await pool.execute(
    `INSERT INTO orders (user_id, event_id, total_amount, payment_status, payment_reference, created_at)
     VALUES (?, ?, ?, 'pending', ?, NOW())`,
    [userId, eventId, total, reference]
  );
  const orderId = orderResult.insertId;

  await pool.execute(
    `INSERT INTO order_items (order_id, ticket_type_id, quantity, unit_price, subtotal)
     VALUES (?, ?, ?, ?, ?)`,
    [orderId, ticketTypeId, quantity, unitPrice, subtotal]
  );

  let authorizationUrl = null;
  const [userRows] = await pool.execute('SELECT email FROM users WHERE id = ?', [userId]);
  const userEmail = userRows[0]?.email || 'attendee@tribesandcliqs.com';

  if (total > 0) {
    const payResult = await initializeTransaction({
      email: userEmail,
      amount: total,
      reference,
      callback_url: callbackUrl,
      metadata: { orderId, eventId, userId, source: 'ai_booking_agent' },
    });
    if (payResult.status && payResult.data?.authorization_url) {
      authorizationUrl = payResult.data.authorization_url;
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
    unitPrice,
    subtotal,
    serviceFee,
    total,
    authorizationUrl,
    expiresAt,
    remainingSeconds: 600,
  };
}

/**
 * Core Agent Payment Verification (Security Enforced)
 */
export async function verifyAgentPayment({ orderId, reference, userId }) {
  if (!reference && !orderId) {
    throw new Error('Reference or orderId is required');
  }

  let order;
  if (orderId) {
    const [rows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [orderId]);
    order = rows[0];
  } else {
    const [rows] = await pool.execute('SELECT * FROM orders WHERE payment_reference = ?', [reference]);
    order = rows[0];
  }

  if (!order) {
    throw new Error('Order not found for that reference');
  }

  const ref = order.payment_reference || reference;

  if (order.payment_status === 'completed') {
    const tickets = await fetchOrderTickets(order.id);
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

  if (Number(order.total_amount) <= 0) {
    await completeOrder(order.id, ref);
    const tickets = await fetchOrderTickets(order.id);
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

  // Direct backend verification with Paystack
  const verifyResult = await verifyTransaction(ref);
  if (verifyResult.status && verifyResult.data?.status === 'success') {
    await completeOrder(order.id, ref);
    const tickets = await fetchOrderTickets(order.id);
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
    message: 'Payment verification pending. Please complete transaction on your device.',
  };
}

/**
 * Resend ticket confirmation email/SMS
 */
export async function resendAgentTicket({ userId, channel = 'email' }) {
  if (!userId) throw new Error('User authentication required');
  const [userRows] = await pool.execute('SELECT id, name, email, phone FROM users WHERE id = ?', [userId]);
  const user = userRows[0];
  if (!user) throw new Error('User not found');

  const [ticketRows] = await pool.execute(
    `SELECT t.ticket_number, e.title, e.start_date, o.payment_reference, o.total_amount
     FROM tickets t
     JOIN events e ON e.id = t.event_id
     JOIN order_items oi ON oi.id = t.order_item_id
     JOIN orders o ON o.id = oi.order_id
     WHERE t.user_id = ? AND t.status IN ('valid', 'active')
     ORDER BY t.id DESC LIMIT 1`,
    [userId]
  );
  if (!ticketRows || ticketRows.length === 0) {
    throw new Error('No active tickets found to resend');
  }

  const latest = ticketRows[0];
  if ((channel === 'email' || channel === 'both') && user.email) {
    await sendTicketConfirmationEmail(user.email, {
      reference: latest.payment_reference,
      eventTitle: latest.title,
      total: latest.total_amount,
      items: [],
    });
  }
  if ((channel === 'sms' || channel === 'both' || channel === 'whatsapp') && user.phone) {
    await sendTicketConfirmationSMS(user.phone, latest.payment_reference);
  }
  return { success: true, email: user.email, phone: user.phone };
}

/**
 * Helper to call Gemini API with model fallback
 */
async function callGemini(contents, systemInstruction, temperature = 0.4) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) return null;

  for (const model of GEMINI_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction: {
            parts: [{ text: systemInstruction }],
          },
          generationConfig: {
            responseMimeType: 'application/json',
            temperature,
            maxOutputTokens: 600,
          },
        }),
        signal: AbortSignal.timeout(6500),
      });

      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          try {
            return JSON.parse(text);
          } catch {
            return { reply: text };
          }
        }
      }
    } catch {
      // try next model
    }
  }

  return null;
}

/**
 * Log user question and agent answer to database
 */
async function logBotConversation({
  userId,
  userName,
  userEmail,
  sessionId,
  mode,
  question,
  answer,
  intent,
  pagePath,
  metadata = {},
}) {
  try {
    await pool.execute(
      `INSERT INTO bot_conversations (user_id, user_name, user_email, session_id, mode, question, answer, intent, page_path, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId || null,
        userName || 'Guest User',
        userEmail || null,
        sessionId || null,
        mode || 'chat',
        question,
        answer,
        intent || 'GENERAL',
        pagePath || '/',
        JSON.stringify(metadata || {}),
      ]
    );
  } catch (err) {
    console.error('[logBotConversation] error:', err.message);
  }
}

/**
 * Intelligent Tribes & Cliqs AI Booking Agent Controller
 */
export const handleChatMessage = async (req, res) => {
  try {
    const { message, conversationHistory = [], context = {}, mode = 'chat' } = req.body;
    const rawMessage = (message || '').trim();

    if (!rawMessage) {
      return res.status(400).json({ message: 'Message is required' });
    }

    const user = req.user || null;
    const currentPath = context.currentPath || context.pathname || '';
    let eventId = context.eventId || null;

    const isVoice = mode === 'voice' || context.mode === 'voice' || Boolean(context.isVoice);
    let processedMessage = rawMessage;
    let voicePhonetics = null;
    let voicePrediction = null;
    let voiceEmotion = null;

    if (isVoice) {
      let lexiconRows = [];
      try {
        const [lex] = await pool.execute(`SELECT heard, replacement, category FROM voice_pronunciation_lexicon WHERE is_active = TRUE`);
        lexiconRows = lex || [];
      } catch {}
      voicePhonetics = correctVoicePhonetics(rawMessage, lexiconRows);
      processedMessage = voicePhonetics.corrected || rawMessage;
      voicePrediction = voiceModel.predict(processedMessage, false);
      voiceEmotion = analyzeVoiceEmotion(rawMessage);
    }

    const originalJson = res.json.bind(res);
    res.json = (data) => {
      if (data && data.reply) {
        if (isVoice) {
          data.voiceReply = formatVoiceUtterance(data.reply);
          if (mode === 'voice') {
            data.reply = data.voiceReply;
          }
          data.voiceDiagnostics = {
            confidence: voicePrediction?.confidence,
            predictedIntent: voicePrediction?.intent,
            correctedTranscript: voicePhonetics?.corrected,
            phoneticChanges: voicePhonetics?.changes || [],
            emotion: voiceEmotion?.emotion,
          };
        }

        logBotConversation({
          userId: user?.id,
          userName: user?.name,
          userEmail: user?.email,
          sessionId: req.headers?.['x-session-id'] || context?.sessionId,
          mode: isVoice ? 'voice' : 'chat',
          question: isVoice && voicePhonetics?.corrected && voicePhonetics.corrected !== rawMessage
            ? `${rawMessage} [Normalized: ${voicePhonetics.corrected}]`
            : rawMessage,
          answer: data.voiceReply || data.reply,
          intent: data.intent || voicePrediction?.intent || 'GENERAL',
          pagePath: currentPath || '/',
          metadata: {
            eventsCount: data.events?.length || 0,
            ticketsCount: data.tickets?.length || 0,
            hasBooking: Boolean(data.booking),
            bookingStatus: data.booking?.status || null,
            isVoice,
            voiceIntent: voicePrediction?.intent || null,
            voiceConfidence: voicePrediction?.confidence || null,
            voiceEmotion: voiceEmotion?.emotion || null,
            phoneticChangesCount: voicePhonetics?.changes?.length || 0,
          },
        }).catch(() => {});
      }
      return originalJson(data);
    };

    if (!eventId && currentPath.startsWith('/events/')) {
      const parts = currentPath.split('/');
      const potentialId = parseInt(parts[2], 10);
      if (!isNaN(potentialId)) eventId = potentialId;
    }

    const [liveEvents, aiContext, activeEvent, userTickets, organizerStats] = await Promise.all([
      getLiveEventsContext(10),
      getAITrainingContext(),
      eventId ? getSingleEventContext(eventId) : Promise.resolve(null),
      user?.id ? getUserTicketsContext(user.id, 5) : Promise.resolve([]),
      user?.role === 'organizer' ? getOrganizerStatsContext(user.id) : Promise.resolve(null),
    ]);

    const lower = processedMessage.toLowerCase();
    const mlAnalysis = classifySentimentAndUrgency(processedMessage);

    // =========================================================================
    // 1. PAYMENT VERIFICATION (Crucial Security Rule: AI does NOT blindly trust "I have paid")
    // =========================================================================
    const wantsVerification =
      lower.includes('i have paid') ||
      lower.includes('i paid') ||
      lower.includes('verify payment') ||
      lower.includes('confirm payment') ||
      lower.includes('check my payment') ||
      lower.includes('i just paid');

    const activeReference = context.booking?.reference || context.reference;
    const activeOrderId = context.booking?.orderId || context.orderId;

    if (wantsVerification && (activeReference || activeOrderId)) {
      try {
        const verifyData = await verifyAgentPayment({
          orderId: activeOrderId,
          reference: activeReference,
          userId: user?.id,
        });

        if (verifyData.status === 'confirmed') {
          return res.json({
            reply: `🎉 **Booking confirmed!**\n\nYour payment for **${verifyData.eventTitle}** has been verified and confirmed.\n\n📅 **Date:** ${verifyData.eventDate}\n📍 **Venue:** ${verifyData.eventVenue}\n💰 **Paid:** GHS ${verifyData.total.toFixed(2)}\n\nYour digital tickets and unique QR passes are now ready in **My Tickets**.`,
            intent: 'PAYMENT_CONFIRMED',
            booking: verifyData,
            actions: [
              { type: 'NAVIGATE', label: 'View in My Tickets', path: '/attendee/tickets' },
              { type: 'PREVIEW_QR', label: 'Show QR Pass', tickets: verifyData.tickets },
            ],
            suggestions: ['When does the event start?', 'How do I transfer a ticket?', 'Show my active tickets'],
          });
        }

        return res.json({
          reply: `Payment has not been confirmed by the provider yet. If you initiated Mobile Money, please approve the USSD prompt on your phone and click **Verify Payment** again in a moment.`,
          intent: 'PAYMENT_PENDING',
          booking: {
            status: 'reserved',
            orderId: activeOrderId,
            reference: activeReference,
            total: context.booking?.total || 0,
            authorizationUrl: context.booking?.authorizationUrl,
          },
          actions: [
            { type: 'VERIFY_PAYMENT', label: 'Verify Payment', reference: activeReference },
            context.booking?.authorizationUrl ? { type: 'PAY_NOW', label: 'Open Payment Page', url: context.booking.authorizationUrl } : null,
          ].filter(Boolean),
          suggestions: ['Verify Payment', 'Change payment method', 'Contact Support'],
        });
      } catch (err) {
        return res.json({
          reply: `Could not verify payment: ${err.message}. Please click below to re-verify.`,
          intent: 'PAYMENT_PENDING',
          actions: [{ type: 'VERIFY_PAYMENT', label: 'Verify Payment', reference: activeReference }],
        });
      }
    }

    // =========================================================================
    // 2. CONTINUE TO PAYMENT / RESERVATION HOLD (10-minute countdown)
    // =========================================================================
    const wantsContinuePayment =
      lower === 'yes' ||
      lower.startsWith('yes,') ||
      lower.includes('confirm') ||
      lower.includes('confirm & pay') ||
      lower.includes('confirm and pay') ||
      lower.includes('continue to payment') ||
      lower.includes('proceed to pay') ||
      lower.includes('proceed to payment') ||
      lower.includes('pay now') ||
      context.action === 'CONTINUE_PAYMENT';

    const pendingBooking = context.booking || {};
    if (wantsContinuePayment && (pendingBooking.eventId || eventId)) {
      if (!user) {
        return res.json({
          reply: `Please log in to your Tribes & Cliqs account first so I can reserve your tickets and secure your order.`,
          intent: 'NAVIGATE',
          actions: [{ type: 'NAVIGATE', label: 'Log In to Continue', path: '/login' }],
          suggestions: ['Explore upcoming events', 'How does resale work?'],
        });
      }

      if (pendingBooking.status === 'reserved' && pendingBooking.authorizationUrl) {
        return res.json({
          reply: `Your tickets for **${pendingBooking.eventTitle || 'the event'}** are reserved! Please tap **Confirm & Pay** below to finalize your Mobile Money or Card payment:`,
          intent: 'PAYMENT_PENDING',
          booking: pendingBooking,
          actions: [
            { type: 'PAY_NOW', label: `Confirm & Pay GHS ${Number(pendingBooking.total || 0).toFixed(2)}`, url: pendingBooking.authorizationUrl },
            { type: 'VERIFY_PAYMENT', label: 'I Have Paid / Verify Payment', reference: pendingBooking.reference },
          ],
          suggestions: ['I have paid', 'Contact Support'],
        });
      }

      const targetEventId = pendingBooking.eventId || eventId;
      const targetTierId = pendingBooking.tierId;
      const targetQty = pendingBooking.quantity || 1;

      try {
        const holdData = await createAgentBookingHold({
          userId: user.id,
          eventId: targetEventId,
          ticketTypeId: targetTierId,
          quantity: targetQty,
          callbackUrl: context.callbackUrl,
        });

        return res.json({
          reply: `I've selected **${holdData.quantity} × ${holdData.tierName}** tickets and prepared your order for **${holdData.eventTitle}**. The total is **GHS ${holdData.total.toFixed(2)}**.\n\nYour tickets are reserved for **10 minutes**. I've prepared the payment. Please review and complete your payment below:`,
          intent: 'PAYMENT_PENDING',
          booking: {
            ...holdData,
            status: 'reserved',
          },
          actions: [
            holdData.authorizationUrl ? { type: 'PAY_NOW', label: `Confirm & Pay GHS ${holdData.total.toFixed(2)}`, url: holdData.authorizationUrl } : null,
            { type: 'VERIFY_PAYMENT', label: 'I Have Paid / Verify Payment', reference: holdData.reference },
          ].filter(Boolean),
          suggestions: ['I have paid', 'What happens if timer expires?', 'Contact Support'],
        });
      } catch (err) {
        return res.json({
          reply: `Unable to complete ticket reservation: ${err.message}`,
          intent: 'GENERAL',
          suggestions: ['Try another ticket tier', 'Explore other events'],
        });
      }
    }

    // =========================================================================
    // 3. AFTER-SALES: SPENDING THIS MONTH
    // =========================================================================
    const wantsSpending =
      lower.includes('how much have i spent') ||
      lower.includes('spent on events') ||
      lower.includes('my spending') ||
      lower.includes('total spend') ||
      lower.includes('spending this month');

    if (wantsSpending) {
      if (!user) {
        return res.json({
          reply: `Please log in to view your personalized ticket spending and transaction history.`,
          intent: 'NAVIGATE',
          actions: [{ type: 'NAVIGATE', label: 'Log In', path: '/login' }],
          suggestions: ['Explore events', 'How does ticket resale work?'],
        });
      }

      const spending = await getUserMonthlySpending(user.id);
      return res.json({
        reply: `You have spent **GHS ${spending.total.toFixed(2)}** across **${spending.count} event${spending.count === 1 ? '' : 's'}** in **${spending.month}**.`,
        intent: 'MONTHLY_SPEND',
        spending,
        actions: [{ type: 'NAVIGATE', label: 'View All Orders & Invoices', path: '/attendee/tickets' }],
        suggestions: ['Show my active tickets', 'When is my next event?', 'Explore upcoming concerts'],
      });
    }

    // =========================================================================
    // 4. AFTER-SALES: WHEN IS MY EVENT / NEXT EVENT COUNTDOWN
    // =========================================================================
    const wantsNextEvent =
      lower.includes('when is my event') ||
      lower.includes('my next event') ||
      lower.includes('when is the concert') ||
      lower.includes('what time is my event');

    if (wantsNextEvent) {
      if (!user) {
        return res.json({
          reply: `Please log in to check your upcoming event schedule and countdowns.`,
          intent: 'NAVIGATE',
          actions: [{ type: 'NAVIGATE', label: 'Log In', path: '/login' }],
          suggestions: ['Explore events', 'Show my tickets'],
        });
      }

      const nextEv = await getUserNextUpcomingEvent(user.id);
      if (!nextEv) {
        return res.json({
          reply: `You don't have any upcoming events scheduled right now, **${user.name || ''}**. Want me to find concerts happening this weekend?`,
          intent: 'GENERAL',
          actions: [{ type: 'NAVIGATE', label: 'Explore Events', path: '/explore' }],
          suggestions: ['Concerts in Accra this weekend', 'Kumasi events', 'Free events'],
        });
      }

      return res.json({
        reply: `Your next event is **${nextEv.title}**!\n\n📅 **Date:** ${nextEv.date} ${nextEv.time ? 'at ' + nextEv.time : ''}\n📍 **Venue:** ${nextEv.venue}\n⏳ **Status:** ${nextEv.countdown}\n🎫 **Ticket Tier:** ${nextEv.tierName}`,
        intent: 'EVENT_SCHEDULE',
        nextEvent: nextEv,
        actions: [
          { type: 'NAVIGATE', label: 'View Ticket in My Tickets', path: '/attendee/tickets' },
          { type: 'NAVIGATE', label: 'Open Event Page', path: `/events/${nextEv.eventId}` },
        ],
        suggestions: ['Show my active tickets', 'How do I transfer this ticket?', 'Dress code & directions'],
      });
    }

    // =========================================================================
    // 5. AFTER-SALES: RESEND TICKETS (EMAIL / SMS / WHATSAPP)
    // =========================================================================
    const wantsResend =
      lower.includes('send my ticket') ||
      lower.includes('resend my ticket') ||
      lower.includes('email my ticket') ||
      lower.includes('ticket to my whatsapp') ||
      lower.includes('ticket to my email');

    if (wantsResend) {
      if (!user) {
        return res.json({
          reply: `Please log in to resend your tickets to your verified email or phone number.`,
          intent: 'NAVIGATE',
          actions: [{ type: 'NAVIGATE', label: 'Log In', path: '/login' }],
        });
      }

      try {
        const channel = lower.includes('whatsapp') ? 'whatsapp' : (lower.includes('sms') ? 'sms' : 'email');
        const resendRes = await resendAgentTicket({ userId: user.id, channel });
        return res.json({
          reply: `I have resent your digital pass and confirmation to **${resendRes.email || user.email}** and SMS to **${resendRes.phone || user.phone}**!`,
          intent: 'SUPPORT',
          actions: [{ type: 'NAVIGATE', label: 'Open My Tickets', path: '/attendee/tickets' }],
          suggestions: ['Show my active tickets', 'When is my next event?'],
        });
      } catch (err) {
        return res.json({
          reply: `Could not resend tickets: ${err.message}. You can always view or download them directly in **My Tickets**.`,
          intent: 'SUPPORT',
          actions: [{ type: 'NAVIGATE', label: 'Open My Tickets', path: '/attendee/tickets' }],
        });
      }
    }

    // =========================================================================
    // 6. AFTER-SALES: REFUND INQUIRY / CANNOT ATTEND
    // =========================================================================
    const wantsRefund =
      lower.includes('refund') ||
      lower.includes("can't attend") ||
      lower.includes("cannot attend") ||
      lower.includes('cancel my ticket');

    if (wantsRefund) {
      return res.json({
        reply: `If you cannot attend, Tribes & Cliqs offers two verified options:\n\n1. **Official Refund:** Organizers process refunds for eligible requests submitted prior to the event cut-off.\n2. **Verified Resale:** You can list your ticket on our marketplace to recover your money instantly!\n\nClick below to open your tickets and choose an option.`,
        intent: 'REFUND_INFO',
        actions: [
          { type: 'NAVIGATE', label: 'Manage Tickets & Request Refund', path: '/attendee/tickets' },
          { type: 'NAVIGATE', label: 'Open Resale Marketplace', path: '/explore?filter=resale' },
        ],
        suggestions: ['How does resale work?', 'Transfer ticket to a friend', 'Contact Support'],
      });
    }

    // =========================================================================
    // 7. AFTER-SALES: TICKET TRANSFER
    // =========================================================================
    const wantsTransfer =
      lower.includes('transfer') ||
      lower.includes('send ticket to my friend') ||
      lower.includes('give ticket to');

    if (wantsTransfer) {
      return res.json({
        reply: `You can easily transfer a ticket to your friend! Go to **My Tickets**, click **Transfer**, and enter your friend's email or phone number. A fresh, secure QR pass will be issued to them immediately.`,
        intent: 'TRANSFER',
        actions: [{ type: 'NAVIGATE', label: 'Go to My Tickets', path: '/attendee/tickets' }],
        suggestions: ['Show my tickets', 'Can I resell my ticket?', 'Contact Support'],
      });
    }

    // =========================================================================
    // 7.1. AFTER-SALES: EVENT REMINDER SCHEDULING ("remind me one day before")
    // =========================================================================
    const wantsReminder =
      lower.includes('remind me') ||
      lower.includes('set a reminder') ||
      lower.includes('schedule a reminder') ||
      lower.includes('set reminder');

    if (wantsReminder) {
      if (!user) {
        return res.json({
          reply: `Please log in to schedule automated reminders for your upcoming events.`,
          intent: 'NAVIGATE',
          actions: [{ type: 'NAVIGATE', label: 'Log In', path: '/login' }],
        });
      }

      let reminderDays = 1;
      const dayMatch = lower.match(/([0-9]+)\s*day/);
      if (dayMatch) reminderDays = parseInt(dayMatch[1], 10);
      else if (lower.includes('two day') || lower.includes('2 day')) reminderDays = 2;
      else if (lower.includes('one day') || lower.includes('1 day')) reminderDays = 1;

      let targetEventId = eventId || context.booking?.eventId;
      if (!targetEventId) {
        const nextEv = await get_user_upcoming_events({ userId: user.id });
        if (nextEv) targetEventId = nextEv.eventId;
      }

      if (targetEventId) {
        const rem = await schedule_event_reminder({
          eventId: targetEventId,
          userId: user.id,
          daysBefore: reminderDays,
        });
        return res.json({
          reply: `Reminder set! I will notify you **${reminderDays === 1 ? '1 day' : `${reminderDays} days`}** before **${rem.eventTitle}**. You will receive an in-app alert!`,
          intent: 'REMINDER_SET',
          suggestions: ['Show my active tickets', 'When is my next event?'],
        });
      }
    }

    // =========================================================================
    // 7.2. AFTER-SALES: WHAT EVENTS AM I ATTENDING THIS MONTH?
    // =========================================================================
    const wantsEventsThisMonth =
      lower.includes('what events am i attending') ||
      lower.includes('events am i attending') ||
      lower.includes('events this month') ||
      lower.includes('what events am i going to');

    if (wantsEventsThisMonth) {
      if (!user) {
        return res.json({
          reply: `Please log in to check the events you are attending this month.`,
          intent: 'NAVIGATE',
          actions: [{ type: 'NAVIGATE', label: 'Log In', path: '/login' }],
        });
      }

      const tickets = await get_user_tickets({ userId: user.id, limit: 10 });
      if (tickets.length === 0) {
        return res.json({
          reply: `You don't have any tickets booked for this month yet, **${user.name || ''}**. Want me to find concerts happening in Kumasi or Accra this weekend?`,
          intent: 'GET_TICKETS',
          suggestions: ['Concerts in Kumasi this weekend', 'Concerts in Accra', 'Free events'],
        });
      }

      const eventsList = tickets.map((t) => `• **${t.event_title}** — ${t.start_date} at ${t.event_venue || t.event_city} (${t.ticket_type_name})`).join('\n');
      return res.json({
        reply: `Here are the events you're attending this month, **${user.name || ''}**:\n\n${eventsList}\n\nYour QR passes are available in **My Tickets**.`,
        intent: 'GET_TICKETS',
        tickets,
        actions: [{ type: 'NAVIGATE', label: 'View All in My Tickets', path: '/attendee/tickets' }],
        suggestions: ['When is my next event?', 'Transfer a ticket', 'How much have I spent on events this month?'],
      });
    }

    // =========================================================================
    // 8. AUTONOMOUS BOOKING: SEARCH THROUGH, SELECT TICKET & PREPARE PAYMENT
    // =========================================================================
    const wantsExplicitBooking =
      lower.includes('book') ||
      lower.includes('buy ticket') ||
      lower.includes('buy tickets') ||
      lower.includes('reserve ticket') ||
      lower.includes('reserve tickets') ||
      lower.includes('purchase ticket') ||
      lower.includes('purchase tickets') ||
      lower.includes('purchase') ||
      lower.includes('get ticket') ||
      lower.includes('get tickets') ||
      lower.includes('ticket for') ||
      lower.includes('tickets for');

    const wantsAttendance =
      lower.includes('attend') ||
      lower.includes('attends') ||
      lower.includes('attending') ||
      lower.includes('go to') ||
      lower.includes('going to') ||
      lower.includes('want to go') ||
      lower.includes('take me to') ||
      ((lower.includes('kumasi') || lower.includes('accra')) &&
        (lower.includes('want') || lower.includes('need') || lower.includes('find me') || lower.includes('get me') || lower.includes('show')));

    const isBookingIntent = wantsExplicitBooking || wantsAttendance;

    if (isBookingIntent) {
      // Find candidate event: either activeEvent, or matching title in message, or candidate search
      let targetEv = activeEvent;
      if (!targetEv) {
        for (const ev of liveEvents) {
          if (lower.includes(ev.title.toLowerCase())) {
            targetEv = await getSingleEventContext(ev.id);
            break;
          }
        }
      }

      const reqCity = extractCity(rawMessage);
      const reqBudget = extractBudget(rawMessage);
      const reqTierName = extractTierName(rawMessage);
      const reqQty = extractQuantity(rawMessage) || 1;

      // Extract date if mentioned
      let reqStartDate = '';
      let reqEndDate = '';
      if (lower.includes('this weekend') || lower.includes('the weekend')) {
        const wk = getWeekendRange();
        reqStartDate = wk.start;
        reqEndDate = wk.end;
      } else if (lower.includes('next friday')) {
        reqStartDate = getNextDayOfWeekDate(5);
        reqEndDate = reqStartDate;
      } else if (lower.includes('today') || lower.includes('tonight')) {
        reqStartDate = new Date().toISOString().slice(0, 10);
        reqEndDate = reqStartDate;
      } else if (lower.includes('tomorrow')) {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        reqStartDate = d.toISOString().slice(0, 10);
        reqEndDate = reqStartDate;
      }

      // Extract category
      let reqCat = '';
      if (lower.includes('concert') || lower.includes('music') || lower.includes('afrobeat') || lower.includes('amapiano') || lower.includes('rave')) reqCat = 'Music';
      else if (lower.includes('comedy') || lower.includes('standup')) reqCat = 'Comedy';
      else if (lower.includes('tech') || lower.includes('technology')) reqCat = 'Technology';
      else if (lower.includes('business') || lower.includes('networking')) reqCat = 'Business';
      else if (lower.includes('party') || lower.includes('nightlife')) reqCat = 'Party';

      // Targeted search across cities (e.g. Kumasi or Accra)
      const citiesToSearch = [];
      if (lower.includes('kumasi')) citiesToSearch.push('Kumasi');
      if (lower.includes('accra') || lower.includes('osu') || lower.includes('east legon')) citiesToSearch.push('Accra');
      if (lower.includes('takoradi')) citiesToSearch.push('Takoradi');
      if (lower.includes('tamale')) citiesToSearch.push('Tamale');
      if (citiesToSearch.length === 0 && reqCity) citiesToSearch.push(reqCity);
      if (citiesToSearch.length === 0) citiesToSearch.push('Kumasi', 'Accra');

      let matchingEvs = [];
      if (!targetEv) {
        for (const city of citiesToSearch) {
          const res = await searchEvents({
            city,
            category: reqCat,
            startDate: reqStartDate,
            endDate: reqEndDate,
            maxPrice: reqBudget,
            ticketType: reqTierName || '',
          });
          if (res.length > 0) {
            matchingEvs.push(...res);
          }
        }

        // Fallback: search any upcoming events in target cities
        if (matchingEvs.length === 0 && citiesToSearch.length > 0) {
          for (const city of citiesToSearch) {
            const res = await searchEvents({ city });
            if (res.length > 0) {
              matchingEvs.push(...res);
            }
          }
        }

        // Fallback to live published events
        if (matchingEvs.length === 0 && liveEvents.length > 0) {
          matchingEvs = liveEvents;
        }

        if (matchingEvs.length > 0) {
          targetEv = await getSingleEventContext(matchingEvs[0].id);
        }
      }

      if (targetEv) {
        const tiers = targetEv.ticket_tiers || [];
        const availableTiers = tiers.filter((t) => (Number(t.quantity) - Number(t.quantity_sold)) > 0);
        let selectedTier = null;

        if (reqTierName) {
          selectedTier = availableTiers.find((t) => t.name.toLowerCase().includes(reqTierName.toLowerCase()));
        }
        if (!selectedTier) {
          selectedTier = availableTiers.find((t) => lower.includes(t.name.toLowerCase()));
        }
        // Prefer lowest price / Regular tier
        if (!selectedTier && availableTiers.length > 0) {
          const sorted = [...availableTiers].sort((a, b) => Number(a.price) - Number(b.price));
          selectedTier = sorted[0];
        }
        if (!selectedTier && tiers.length > 0) {
          selectedTier = tiers[0];
        }

        if (selectedTier) {
          let unitPrice = Number(selectedTier.price);
          if (selectedTier.early_bird_price && selectedTier.early_bird_deadline && new Date(selectedTier.early_bird_deadline) >= new Date()) {
            unitPrice = Number(selectedTier.early_bird_price);
          }

          const subtotal = unitPrice * reqQty;
          const serviceFee = subtotal > 0 ? Math.max(5, Math.round(subtotal * 0.03 * 100) / 100) : 0;
          const total = subtotal + serviceFee;

          const bookingSummary = {
            status: 'summary',
            eventId: targetEv.id,
            eventTitle: targetEv.title,
            eventDate: targetEv.start_date,
            eventVenue: targetEv.venue || targetEv.city,
            tierId: selectedTier.id,
            tierName: selectedTier.name,
            quantity: reqQty,
            unitPrice,
            subtotal,
            serviceFee,
            total,
            paymentMethod: 'MTN MoMo',
          };

          const wantsReminderWithBooking = lower.includes('remind me');
          if (wantsReminderWithBooking && user?.id) {
            schedule_event_reminder({
              eventId: targetEv.id,
              userId: user.id,
              daysBefore: 1,
            }).catch(() => {});
          }

          const reminderNote = wantsReminderWithBooking
            ? ` I have also scheduled an event reminder for you 1 day before the show.`
            : '';

          const eventCards = (matchingEvs.length > 0 ? matchingEvs : [targetEv]).slice(0, 3).map((e) => ({
            id: e.id,
            title: e.title,
            image: e.banner_image,
            date: e.start_date,
            time: e.start_time,
            venue: e.venue,
            city: e.city,
            category: e.category,
            minPrice: Number(e.min_price || selectedTier.price || 0),
          }));

          const isVoiceMode = mode === 'voice' || context.mode === 'voice' || context.isVoice;
          const intentToUse = (lower.includes('this weekend') && !wantsExplicitBooking && !reqTierName)
            ? 'SEARCH_EVENTS'
            : 'BOOKING_SUMMARY';

          const voiceReply = `I found ${targetEv.title} in ${targetEv.city || 'Ghana'}. I've prepared your order for ${reqQty} ${selectedTier.name} ticket for GHS ${total.toFixed(2)}. Say confirm or tap Confirm & Pay below to complete your payment!`;
          const chatReply = `I've searched through events in **${targetEv.city || 'Ghana'}** and selected **${targetEv.title}** for you! I have prepared your ticket order for **${reqQty} × ${selectedTier.name}** tickets.${reminderNote}\n\n• **Event:** ${targetEv.title}\n• **Date:** ${targetEv.start_date} ${targetEv.start_time ? 'at ' + targetEv.start_time : ''}\n• **Venue:** ${targetEv.venue || targetEv.city}\n• **${reqQty} × ${selectedTier.name}** — GHS ${subtotal.toFixed(2)}\n• **Subtotal:** GHS ${subtotal.toFixed(2)}\n• **Service Fee:** GHS ${serviceFee.toFixed(2)}\n──────────────────\n• **Total:** **GHS ${total.toFixed(2)}**\n\nYour tickets can be reserved for 10 minutes once confirmed. Please review and tap **Confirm & Pay** below to proceed:`;

          return res.json({
            reply: isVoiceMode ? voiceReply : chatReply,
            intent: intentToUse,
            booking: bookingSummary,
            events: eventCards,
            actions: [
              { type: 'CONTINUE_PAYMENT', label: `Confirm & Pay GHS ${total.toFixed(2)}`, data: bookingSummary },
              user ? null : { type: 'NAVIGATE', label: 'Log In to Confirm Order', path: '/login' },
              { type: 'NAVIGATE', label: 'View Full Event Page', path: `/events/${targetEv.id}` },
            ].filter(Boolean),
            suggestions: [
              `Confirm & Pay GHS ${total.toFixed(2)}`,
              'Change ticket quantity',
              'Check refund policy',
            ],
          });
        }
      }
    }

    // =========================================================================
    // 9. EVENT DISCOVERY & NATURAL LANGUAGE SEARCH
    // =========================================================================
    const reqCity = extractCity(rawMessage);
    const reqBudget = extractBudget(rawMessage);
    const reqTierName = extractTierName(rawMessage);

    let startDate = '';
    let endDate = '';
    if (lower.includes('this weekend') || lower.includes('the weekend')) {
      const wk = getWeekendRange();
      startDate = wk.start;
      endDate = wk.end;
    } else if (lower.includes('next friday')) {
      startDate = getNextDayOfWeekDate(5);
      endDate = startDate;
    } else if (lower.includes('today') || lower.includes('tonight')) {
      startDate = new Date().toISOString().slice(0, 10);
      endDate = startDate;
    } else if (lower.includes('tomorrow')) {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      startDate = d.toISOString().slice(0, 10);
      endDate = startDate;
    }

    let searchCat = '';
    if (lower.includes('concert') || lower.includes('music') || lower.includes('afrobeat') || lower.includes('amapiano') || lower.includes('rave')) searchCat = 'Music';
    else if (lower.includes('comedy') || lower.includes('standup')) searchCat = 'Comedy';
    else if (lower.includes('tech') || lower.includes('technology')) searchCat = 'Technology';
    else if (lower.includes('business') || lower.includes('networking')) searchCat = 'Business';
    else if (lower.includes('party') || lower.includes('nightlife')) searchCat = 'Party';

    const searchResults = await searchEvents({
      query: !reqCity && !searchCat ? rawMessage.replace(/[^\w\s]/g, '').slice(0, 30) : '',
      category: searchCat,
      city: reqCity,
      startDate,
      endDate,
      maxPrice: reqBudget,
      ticketType: reqTierName || '',
    });

    const candidateEvents = searchResults.length > 0 ? searchResults : liveEvents;

    const userTaste = {
      favoriteCategories: searchCat ? [searchCat] : [],
      attendedCategories: (userTickets || []).map((t) => t.ticket_type_name || '').filter(Boolean),
      userCity: reqCity || (user?.location ? user.location.split(',')[0].trim() : 'Accra'),
      query: rawMessage,
    };

    const rankedEvents = rankEventsWithML(candidateEvents, userTaste).slice(0, 4);

    const eventIds = rankedEvents.map((e) => e.id);
    let tiersMap = {};
    if (eventIds.length > 0) {
      try {
        const placeholders = eventIds.map(() => '?').join(',');
        const [tiersRows] = await pool.execute(
          `SELECT id, event_id, name, price, quantity, quantity_sold
           FROM ticket_types
           WHERE event_id IN (${placeholders}) AND is_active = TRUE
           ORDER BY price ASC`,
          eventIds
        );
        for (const tier of tiersRows || []) {
          if (!tiersMap[tier.event_id]) tiersMap[tier.event_id] = [];
          tiersMap[tier.event_id].push({
            id: tier.id,
            name: tier.name,
            price: Number(tier.price),
            available: (Number(tier.quantity) - Number(tier.quantity_sold)) > 0,
          });
        }
      } catch (tierErr) {
        console.warn('[chatController.tiersMap]', tierErr.message);
      }
    }

    const mappedEventCards = rankedEvents.map((ev) => ({
      id: ev.id,
      title: ev.title,
      image: ev.banner_image,
      date: ev.start_date,
      time: ev.start_time,
      venue: ev.venue,
      city: ev.city,
      category: ev.category,
      minPrice: Number(ev.min_price || 0),
      demandBadge: ev.demandBadge || null,
      ticketTiers: tiersMap[ev.id] || [],
    }));

    const mappedTickets = (userTickets || []).map((t) => ({
      id: t.id,
      ticketNumber: t.ticket_number,
      status: t.status,
      ticketTypeName: t.ticket_type_name,
      ticketPrice: t.ticket_price,
      eventId: t.event_id,
      eventTitle: t.event_title,
      date: t.start_date,
      time: t.start_time,
      venue: t.event_venue || t.event_city,
      bannerImage: t.banner_image,
    }));

    // Check if user specifically asked for their tickets
    const wantsTickets =
      lower.includes('my ticket') ||
      lower.includes('my tickets') ||
      lower.includes('show ticket') ||
      lower.includes('my booking');

    if (wantsTickets) {
      if (!user) {
        return res.json({
          reply: `You need to log into your Tribes & Cliqs account first so I can retrieve your personal tickets and digital passes.`,
          intent: 'NAVIGATE',
          actions: [{ type: 'NAVIGATE', label: 'Log In Now', path: '/login' }],
          suggestions: ['Explore upcoming events', 'How does ticket resale work?', 'Accepted payment methods'],
        });
      }

      if (mappedTickets.length === 0) {
        return res.json({
          reply: `You don't have any active tickets right now, **${user.name || 'there'}**. Check out the hottest concerts and events below!`,
          intent: 'GET_TICKETS',
          events: mappedEventCards,
          actions: [{ type: 'NAVIGATE', label: 'Explore Events', path: '/explore' }],
          suggestions: ['What’s happening this weekend?', 'Concerts in Accra', 'Free events'],
        });
      }

      return res.json({
        reply: `Here are your active tickets, **${user.name || ''}**! Tap **Show QR** to view your entry pass, or **Transfer** to send to a friend.`,
        intent: 'GET_TICKETS',
        tickets: mappedTickets,
        actions: [{ type: 'NAVIGATE', label: 'View All in My Tickets', path: '/attendee/tickets' }],
        suggestions: ['When is my next event?', 'How do I transfer a ticket?', 'How does resale work?'],
      });
    }

    // Try Gemini AI response if API key is present
    const liveEventsSummary = candidateEvents.map((e) =>
      `• [ID: ${e.id}] "${e.title}" | Date: ${e.start_date} ${e.start_time || ''} | Venue: ${e.venue || e.city} | Category: ${e.category} | From: GHS ${e.min_price}`
    ).join('\n');

    const voiceToneRule = isVoice
      ? `IMPORTANT VOICE AGENT DIRECTIVE: The user is speaking directly via microphone. Respond strictly in natural, human conversational spoken English (1 to 2 sentences max). Absolutely NO markdown bolding (**), asterisks (*), bullet points (•), brackets, or raw code. Say 'Ghana Cedis' instead of 'GHS', and 'V.I.P.' instead of VIP.`
      : `Tone: Warm, efficient, polite, concise (2-3 sentences max).\nDo NOT use emojis in raw text output.`;

    const systemInstruction = `You are Cliq AI, your personal event booking assistant for Tribes & Cliqs.
Motto: Tell Cliq what you want, and Cliq handles the rest.
${voiceToneRule}
You help users through the complete conversational event lifecycle:
1. Identify event desires: category, city (e.g. Accra, Kumasi), dates (weekends, next Friday), budget, ticket tier (VIP, VVIP, Regular), and quantity.
2. Search live events and check ticket inventory & availability.
3. Make personalized recommendations.
4. Prepare orders with line-item breakdowns and 10-minute ticket reservations.
5. Guide the user to confirm their order and complete Paystack / Mobile Money payment.
6. Verify transactions via the backend gateway.
7. Issue tickets with unique QR entry passes.
8. Handle after-sales: show tickets, calculate spending, transfer passes, request refunds, and schedule event reminders.
Current User: ${user ? `${user.name} (${user.email})` : 'Guest User'}.
Available Events:
${liveEventsSummary || 'None'}`;

    const contents = [{ role: 'user', parts: [{ text: processedMessage }] }];
    const geminiRes = await callGemini(contents, systemInstruction, aiContext.temperature);

    let replyText = '';
    if (geminiRes && geminiRes.reply) {
      replyText = geminiRes.reply;
    } else {
      const cityLabel = reqCity ? ` in ${reqCity}` : '';
      const timeLabel = startDate && endDate ? (startDate === endDate ? ` on ${startDate}` : ' this weekend') : '';
      replyText = mappedEventCards.length > 0
        ? `I found ${mappedEventCards.length} events${cityLabel}${timeLabel}. Here are the closest matches:`
        : `I could not find exact events matching that right now, but check out these popular upcoming events:`;
    }

    return res.json({
      reply: replyText,
      intent: 'SEARCH_EVENTS',
      events: mappedEventCards,
      actions: [
        { type: 'NAVIGATE', label: 'Explore All Events', path: '/explore' },
      ],
      suggestions: [
        'Book 2 VIP tickets',
        'What events are happening in Accra next Friday?',
        'How much have I spent on events this month?',
        'Show my active tickets',
      ],
    });
  } catch (err) {
    console.error('[chatController.handleChatMessage]', err);
    res.status(500).json({ message: 'Internal chat service error' });
  }
};

/**
 * Dedicated API Handlers for Agent Interactive Booking Actions
 */
export const createAgentBookingHoldHandler = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ message: 'Authentication required' });
    const { eventId, ticketTypeId, quantity, callbackUrl } = req.body;
    if (!eventId || !ticketTypeId) {
      return res.status(400).json({ message: 'eventId and ticketTypeId are required' });
    }

    const holdData = await createAgentBookingHold({
      userId: req.user.id,
      eventId: Number(eventId),
      ticketTypeId: Number(ticketTypeId),
      quantity: Number(quantity) || 1,
      callbackUrl,
    });

    res.json({ success: true, booking: holdData, ...holdData });
  } catch (err) {
    console.error('[createAgentBookingHoldHandler]', err);
    res.status(400).json({ message: err.message });
  }
};

export const verifyAgentPaymentHandler = async (req, res) => {
  try {
    const { orderId, reference } = req.body;
    if (!orderId && !reference) {
      return res.status(400).json({ message: 'orderId or reference is required' });
    }

    const verifyData = await verifyAgentPayment({
      orderId: orderId ? Number(orderId) : null,
      reference,
      userId: req.user?.id,
    });

    res.json(verifyData);
  } catch (err) {
    console.error('[verifyAgentPaymentHandler]', err);
    res.status(400).json({ message: err.message });
  }
};

export const resendAgentTicketHandler = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ message: 'Authentication required' });
    const { channel } = req.body;
    const result = await resendAgentTicket({ userId: req.user.id, channel });
    res.json(result);
  } catch (err) {
    console.error('[resendAgentTicketHandler]', err);
    res.status(400).json({ message: err.message });
  }
};
