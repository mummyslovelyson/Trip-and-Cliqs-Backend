import pool from '../config/db.js';
import {
  rankEventsWithML,
  classifySentimentAndUrgency,
  predictEventDemand,
} from '../utils/mlEngine.js';

const getGeminiApiKey = () => process.env.GEMINI_API_KEY || '';
const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-flash-latest'];

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

    // If no future events, fetch any published events
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
 * Fetch specific event details and its active ticket tiers (for event page context)
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
      SELECT id, name, price, quantity, quantity_sold, description
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
      SELECT t.id, t.ticket_number, t.status, t.created_at,
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
 * Fetch dynamic AI training knowledge & system instructions from database
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
async function searchEvents({ query = '', category = '', city = '', isFree = false, maxPrice = null }) {
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
            maxOutputTokens: 500,
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
      } else {
        const errJson = await res.json().catch(() => ({}));
        console.warn(`[Gemini ${model}] returned ${res.status}:`, errJson?.error?.message?.slice(0, 120));
      }
    } catch (modelErr) {
      console.warn(`[Gemini ${model}] failed:`, modelErr.message);
    }
  }

  return null;
}

/**
 * Intelligent Gemini AI Event Concierge & Platform Agent Controller
 */
export const handleChatMessage = async (req, res) => {
  try {
    const { message, conversationHistory = [], context = {} } = req.body;
    const rawMessage = (message || '').trim();

    if (!rawMessage) {
      return res.status(400).json({ message: 'Message is required' });
    }

    const user = req.user || null;
    const currentPath = context.currentPath || '';
    let eventId = context.eventId || null;

    // Detect if user is viewing an event details page: /events/:id
    if (!eventId && currentPath.startsWith('/events/')) {
      const parts = currentPath.split('/');
      const potentialId = parseInt(parts[2], 10);
      if (!isNaN(potentialId)) eventId = potentialId;
    }

    // Parallel fetch relevant contexts
    const [liveEvents, aiContext, activeEvent, userTickets, organizerStats] = await Promise.all([
      getLiveEventsContext(8),
      getAITrainingContext(),
      eventId ? getSingleEventContext(eventId) : Promise.resolve(null),
      user?.id ? getUserTicketsContext(user.id, 5) : Promise.resolve([]),
      user?.role === 'organizer' ? getOrganizerStatsContext(user.id) : Promise.resolve(null),
    ]);

    const lower = rawMessage.toLowerCase();

    // Machine Learning Sentiment & Urgency Analysis
    const mlAnalysis = classifySentimentAndUrgency(rawMessage);

    // Intent detection heuristics
    const wantsTickets =
      lower.includes('my ticket') ||
      lower.includes('my tickets') ||
      lower.includes('show ticket') ||
      lower.includes('my booking') ||
      lower.includes('my bookings') ||
      lower.includes('bought ticket') ||
      lower.includes('my qr') ||
      lower.includes('check my ticket');

    const wantsTransfer =
      lower.includes('transfer') ||
      lower.includes('send ticket') ||
      lower.includes('give ticket');

    const wantsResale =
      lower.includes('resale') ||
      lower.includes('sell ticket') ||
      lower.includes('re-sell') ||
      lower.includes('marketplace');

    const wantsScanner =
      lower.includes('scanner') ||
      lower.includes('check in') ||
      lower.includes('check-in') ||
      lower.includes('scan ticket');

    const wantsCreateEvent =
      lower.includes('create event') ||
      lower.includes('host event') ||
      lower.includes('post event') ||
      lower.includes('publish event') ||
      lower.includes('new event');

    const wantsOrganizerSales =
      user?.role === 'organizer' &&
      (lower.includes('my sales') ||
       lower.includes('ticket sales') ||
       lower.includes('how are my events') ||
       lower.includes('organizer stat') ||
       lower.includes('my revenue'));

    const isEventQuery =
      lower.includes('event') ||
      lower.includes('concert') ||
      lower.includes('party') ||
      lower.includes('festival') ||
      lower.includes('show') ||
      lower.includes('weekend') ||
      lower.includes('today') ||
      lower.includes('tonight') ||
      lower.includes('music') ||
      lower.includes('nightlife') ||
      lower.includes('afrobeats') ||
      lower.includes('amapiano') ||
      lower.includes('jazz') ||
      lower.includes('rooftop') ||
      lower.includes('accra') ||
      lower.includes('kumasi') ||
      lower.includes('free') ||
      lower.includes('find') ||
      lower.includes('recommend') ||
      lower.includes('suggest') ||
      lower.includes('surprise') ||
      lower.includes('chale') ||
      lower.includes('rave') ||
      lower.includes('vibes') ||
      lower.includes('gate fee') ||
      lower.includes('dey') ||
      lower.includes('upcoming');

    // Dynamic database event matching with Machine Learning ranking
    let candidateEvents = [];
    if (isEventQuery) {
      const isFree = lower.includes('free') || lower.includes('free bash');
      let cat = '';
      if (lower.includes('music') || lower.includes('concert') || lower.includes('afrobeats') || lower.includes('amapiano') || lower.includes('rave')) cat = 'Music';
      else if (lower.includes('tech') || lower.includes('technology')) cat = 'Technology';
      else if (lower.includes('business') || lower.includes('networking')) cat = 'Business';
      else if (lower.includes('food') || lower.includes('dining') || lower.includes('drinks')) cat = 'Food & Drinks';

      let city = '';
      if (lower.includes('accra') || lower.includes('osu') || lower.includes('labadi') || lower.includes('east legon')) city = 'Accra';
      else if (lower.includes('kumasi')) city = 'Kumasi';

      const searchResults = await searchEvents({
        query: !cat && !city ? rawMessage.replace(/[^\w\s]/g, '').slice(0, 30) : '',
        category: cat,
        city: city,
        isFree: isFree,
      });

      candidateEvents = searchResults.length > 0 ? searchResults : liveEvents;
    }

    // Build user taste profile for ML ranking
    const userTaste = {
      favoriteCategories: [],
      attendedCategories: (userTickets || []).map((t) => t.ticket_type_name || '').filter(Boolean),
      userCity: user?.location ? user.location.split(',')[0].trim() : '',
      query: rawMessage,
    };

    let mlRankedEvents = isEventQuery ? rankEventsWithML(candidateEvents, userTaste).slice(0, 3) : [];

    // If user asked for a surprise, give extra highlight
    if (lower.includes('surprise') && mlRankedEvents.length > 0) {
      mlRankedEvents[0] = {
        ...mlRankedEvents[0],
        matchScore: 99,
        matchReason: '🔮 AI Secret Pick: Highest trending gem in Accra',
      };
    }

    // Query active ticket tiers for recommended events
    const eventIds = mlRankedEvents.map((e) => e.id);
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

    const mappedEventCards = mlRankedEvents.map((ev) => ({
      id: ev.id,
      title: ev.title,
      image: ev.banner_image,
      date: ev.start_date,
      time: ev.start_time,
      venue: ev.venue,
      city: ev.city,
      category: ev.category,
      minPrice: Number(ev.min_price || 0),
      matchScore: ev.matchScore || 88,
      matchReason: ev.matchReason || 'Curated ML recommendation',
      demandBadge: ev.demandBadge || predictEventDemand(ev).badge,
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

    // Construct detailed prompt for Gemini AI Agent
    const liveEventsSummary = liveEvents.map((e) =>
      `• [ID: ${e.id}] "${e.title}" | Date: ${e.start_date} ${e.start_time || ''} | Venue: ${e.venue || e.city} | Category: ${e.category} | From: GHS ${e.min_price}`
    ).join('\n');

    const knowledgeSummary = aiContext.knowledge.map((k) =>
      `[${k.category.toUpperCase()}] ${k.title}: ${k.instruction_or_answer}`
    ).join('\n');

    let activeEventContext = 'User is currently browsing general platform pages.';
    if (activeEvent) {
      const tiersDesc = (activeEvent.ticket_tiers || []).map(
        (tt) => `${tt.name}: GHS ${tt.price} (${tt.quantity - tt.quantity_sold > 0 ? 'Available' : 'Sold out'})`
      ).join(', ');

      activeEventContext = `User is CURRENTLY VIEWING THIS EVENT:
- Title: "${activeEvent.title}"
- Venue: ${activeEvent.venue || ''}, ${activeEvent.city || ''}
- Address: ${activeEvent.address || 'N/A'}
- Start Date & Time: ${activeEvent.start_date} at ${activeEvent.start_time || 'TBA'}
- End Date & Time: ${activeEvent.end_date || activeEvent.start_date} at ${activeEvent.end_time || 'TBA'}
- Category: ${activeEvent.category}
- Organizer: ${activeEvent.organizer_name || 'Event Host'}
- Dress Code: ${activeEvent.dress_code || 'No specific dress code'}
- Contact: ${activeEvent.contact_email || ''} ${activeEvent.contact_phone || ''}
- Ticket Tiers & Pricing: ${tiersDesc || 'Standard admission'}
- Overview: ${activeEvent.description ? activeEvent.description.slice(0, 300) : 'Exciting live event'}`;
    }

    const userInfoSummary = user
      ? `Authenticated User: Name="${user.name}", Role="${user.role}", Email="${user.email}". Active Tickets Count: ${userTickets.length}.`
      : `User is a GUEST (not logged in). If they ask to view or manage tickets, instruct them to log in.`;

    const organizerContext = organizerStats
      ? `Organizer Stats: Total Events: ${organizerStats.total_events}, Tickets Sold: ${organizerStats.total_tickets_sold}, Revenue: GHS ${organizerStats.total_revenue}.`
      : '';

    const systemInstruction = `You are Cliq Concierge, the official autonomous AI Agent for Tribes & Cliqs (Ghana's premier event ticketing and nightlife platform).

Role & Persona:
- You act as a warm, ultra-helpful, highly competent local event concierge and app agent.
- You answer questions accurately, concisely (1-3 sentences), and offer actionable assistance.
- Avoid robotic corporate speak, avoid markdown heading spam, and keep it crisp and elegant.

Current Application State:
${userInfoSummary}
${organizerContext}
Current Page: ${currentPath || '/'}
${activeEventContext}
User ML Analysis: Sentiment=${mlAnalysis.sentiment}, Urgency=${mlAnalysis.urgency}.
${mlAnalysis.urgency === 'high' ? 'CRITICAL: The user has an urgent issue or dispute. Provide reassuring, empathetic guidance and guide them to priority support.' : ''}

Platform Knowledge Base & Rules:
${knowledgeSummary || 'Ticket transfer & resale are accessed via My Tickets. Refunds subject to organizer policy. Paystack handles Card/MoMo.'}

Upcoming Live Events:
${liveEventsSummary || 'No published events at this moment.'}

FEW-SHOT TRAINING EXAMPLES (Follow this style and format precisely):
Example 1 (Event Search):
User: "What concerts are on this weekend?"
Output: {"reply":"Accra has some electric vibes this weekend! Based on our ML recommendations, check out the live shows below.","intent":"SEARCH_EVENTS","actions":[{"type":"NAVIGATE","label":"🔍 Explore All Events","path":"/explore"}],"suggestions":["What time does it start?","Ticket pricing tiers","Show my tickets"]}

Example 2 (Ticket Management):
User: "How do I transfer my ticket?"
Output: {"reply":"Head to **My Tickets**, find your pass, and click **Transfer** to safely send it to your friend's email with a fresh QR code.","intent":"TRANSFER","actions":[{"type":"NAVIGATE","label":"🎟️ Open My Tickets","path":"/attendee/tickets"}],"suggestions":["Show my tickets","How does resale work?","Download receipt"]}

Example 3 (Organizer Check-In):
User: "I need to scan tickets at the gate"
Output: {"reply":"You can launch our high-speed camera scanner right now to scan QR passes and check in your attendees!","intent":"NAVIGATE","actions":[{"type":"NAVIGATE","label":"📲 Open Check-In Scanner","path":"/organizer/check-in"}],"suggestions":["View attendee list","Organizer dashboard"]}

INSTRUCTIONS FOR AGENT ACTIONS & RESPONSE FORMAT:
You MUST output valid JSON conforming to this schema:
{
  "reply": "Your concise, friendly response text formatted with basic markdown (**bold**)",
  "intent": "GENERAL" | "GET_TICKETS" | "SEARCH_EVENTS" | "NAVIGATE" | "EVENT_INFO" | "TRANSFER" | "RESALE" | "ORGANIZER" | "SUPPORT",
  "actions": [
    {
      "type": "NAVIGATE",
      "label": "Button Label with Emoji (e.g. 🎟️ View My Tickets, 🔍 Explore Music, 📲 Open Scanner, 🔑 Log In)",
      "path": "/attendee/tickets" | "/explore" | "/organizer/check-in" | "/organizer/events/create" | "/login" | "/events/${eventId || ''}" | "/attendee/support"
    }
  ],
  "suggestions": [ "3-4 concise follow-up prompts user can tap" ]
}
`;

    const contents = [];
    if (Array.isArray(conversationHistory)) {
      conversationHistory.slice(-4).forEach((h) => {
        if (h.content) {
          contents.push({
            role: h.role === 'user' ? 'user' : 'model',
            parts: [{ text: h.content }],
          });
        }
      });
    }
    contents.push({ role: 'user', parts: [{ text: rawMessage }] });

    // 1. Try Gemini AI with JSON agent output
    const geminiAgentResponse = await callGemini(contents, systemInstruction, aiContext.temperature);

    if (geminiAgentResponse && geminiAgentResponse.reply) {
      let finalActions = Array.isArray(geminiAgentResponse.actions) ? geminiAgentResponse.actions : [];
      let finalTickets = undefined;
      let finalEvents = undefined;

      // Attach dynamic cards based on intent or query
      if (wantsTickets || geminiAgentResponse.intent === 'GET_TICKETS') {
        if (user) {
          finalTickets = mappedTickets;
          if (!finalActions.some((a) => a.path === '/attendee/tickets')) {
            finalActions.unshift({ type: 'NAVIGATE', label: '🎟️ Open My Tickets', path: '/attendee/tickets' });
          }
        } else {
          finalActions.unshift({ type: 'NAVIGATE', label: '🔑 Log In to View Tickets', path: '/login' });
        }
      }

      if ((isEventQuery || geminiAgentResponse.intent === 'SEARCH_EVENTS') && mappedEventCards.length > 0) {
        finalEvents = mappedEventCards;
      }

      if (mlAnalysis.urgency === 'high' || mlAnalysis.isDispute) {
        if (!finalActions.some((a) => a.path?.includes('support'))) {
          finalActions.unshift({ type: 'NAVIGATE', label: '🚨 Contact Priority Support', path: '/attendee/support' });
        }
      }

      if (wantsOrganizerSales && organizerStats) {
        if (!finalActions.some((a) => a.path === '/organizer/dashboard')) {
          finalActions.push({ type: 'NAVIGATE', label: '📊 Organizer Dashboard', path: '/organizer/dashboard' });
        }
      }

      return res.json({
        reply: geminiAgentResponse.reply,
        intent: geminiAgentResponse.intent || 'GENERAL',
        actions: finalActions.length > 0 ? finalActions : undefined,
        tickets: finalTickets && finalTickets.length > 0 ? finalTickets : undefined,
        events: finalEvents && finalEvents.length > 0 ? finalEvents : undefined,
        activeEvent: activeEvent ? { id: activeEvent.id, title: activeEvent.title } : undefined,
        suggestions: geminiAgentResponse.suggestions || [
          'What’s happening this weekend?',
          'Concerts and live shows',
          'How do I transfer a ticket?',
          'How does resale work?',
        ],
      });
    }

    // 2. Local Fallback Agent (100% reliable rule-based agent when Gemini API is off/quarantined)
    // Urgent disputes or complaints flagged by ML
    if (mlAnalysis.urgency === 'high' || mlAnalysis.isDispute) {
      return res.json({
        reply: `I understand this is an urgent matter. Don't worry—our support specialists and organizers are dedicated to resolving any ticket or billing disputes promptly.`,
        intent: 'SUPPORT',
        actions: [
          { type: 'NAVIGATE', label: '🚨 Open Support Ticket', path: '/attendee/support' },
          { type: 'NAVIGATE', label: '🎟️ Check My Tickets', path: user ? '/attendee/tickets' : '/login' },
        ],
        suggestions: ['Check payment status', 'Contact Organizer', 'Refund Policy'],
      });
    }

    // A. Attendee asking about tickets
    if (wantsTickets) {
      if (!user) {
        return res.json({
          reply: `You need to log into your Tribes & Cliqs account first so I can retrieve your personal tickets and digital passes.`,
          intent: 'NAVIGATE',
          actions: [{ type: 'NAVIGATE', label: '🔑 Log In Now', path: '/login' }],
          suggestions: ['Explore upcoming events', 'How does ticket resale work?', 'Accepted payment methods'],
        });
      }

      if (mappedTickets.length === 0) {
        return res.json({
          reply: `You don't have any active tickets right now, **${user.name || 'there'}**. Check out upcoming concerts and club nights!`,
          intent: 'GET_TICKETS',
          actions: [{ type: 'NAVIGATE', label: '🔍 Explore Events', path: '/explore' }],
          suggestions: ['What’s happening this weekend?', 'Concerts in Accra', 'Free events'],
        });
      }

      return res.json({
        reply: `Here are your current tickets, **${user.name || ''}**! You can view full QR passes, download receipts, or transfer tickets in **My Tickets**.`,
        intent: 'GET_TICKETS',
        tickets: mappedTickets,
        actions: [{ type: 'NAVIGATE', label: '🎟️ View All in My Tickets', path: '/attendee/tickets' }],
        suggestions: ['How do I transfer a ticket?', 'Can I resell my ticket?', 'Explore more events'],
      });
    }

    // B. Transferring tickets
    if (wantsTransfer) {
      return res.json({
        reply: `You can easily transfer a ticket! Go to **My Tickets**, find your event pass, and click **Transfer**. Enter the recipient's phone or email to securely hand it over.`,
        intent: 'TRANSFER',
        actions: [{ type: 'NAVIGATE', label: '🎟️ Go to My Tickets', path: '/attendee/tickets' }],
        suggestions: ['Show my tickets', 'How does resale work?', 'Contact Support'],
      });
    }

    // C. Resale inquiries
    if (wantsResale) {
      return res.json({
        reply: `Our verified resale marketplace lets you list tickets safely. Go to **My Tickets**, select your ticket, click **List for Resale**, and choose your price. Funds are credited once sold!`,
        intent: 'RESALE',
        actions: [{ type: 'NAVIGATE', label: '🎟️ Open My Tickets', path: '/attendee/tickets' }],
        suggestions: ['Show my tickets', 'Explore events', 'Refund policy'],
      });
    }

    // D. Organizer check-in scanner or stats
    if (wantsScanner) {
      return res.json({
        reply: `Ready to check in guests? Open the fast in-app QR scanner to validate attendee tickets at the gate.`,
        intent: 'NAVIGATE',
        actions: [{ type: 'NAVIGATE', label: '📲 Open Check-In Scanner', path: '/organizer/check-in' }],
        suggestions: ['View Attendees List', 'Organizer Dashboard'],
      });
    }

    if (wantsCreateEvent) {
      return res.json({
        reply: `Ready to launch an event? Head to the event creator to set up ticket tiers, add flyers, and start selling in minutes!`,
        intent: 'NAVIGATE',
        actions: [{ type: 'NAVIGATE', label: '⚡ Create New Event', path: '/organizer/events/create' }],
        suggestions: ['How do payouts work?', 'View My Events'],
      });
    }

    if (wantsOrganizerSales && organizerStats) {
      return res.json({
        reply: `Here is your current organizer overview: You have published **${organizerStats.total_events} events** with **${organizerStats.total_tickets_sold} tickets sold** and **GHS ${Number(organizerStats.total_revenue).toLocaleString()}** in total revenue.`,
        intent: 'ORGANIZER',
        actions: [
          { type: 'NAVIGATE', label: '📊 View Organizer Dashboard', path: '/organizer/dashboard' },
          { type: 'NAVIGATE', label: '👥 Attendee List', path: '/organizer/attendees' },
        ],
        suggestions: ['Open Check-In Scanner', 'Create a Promo Code', 'View Wallet'],
      });
    }

    // E. Current Event detail questions
    if (activeEvent) {
      const priceText = (activeEvent.ticket_tiers || []).map((t) => `${t.name}: GHS ${t.price}`).join(', ');
      return res.json({
        reply: `You're currently viewing **${activeEvent.title}** at **${activeEvent.venue || activeEvent.city}** on **${activeEvent.start_date}**. ${priceText ? `Tickets: ${priceText}.` : ''}`,
        intent: 'EVENT_INFO',
        actions: [{ type: 'NAVIGATE', label: '🎟️ Get Tickets', path: `/events/${activeEvent.id}` }],
        suggestions: ['What time does it start?', 'Dress code & venue', 'Explore other events'],
      });
    }

    // F. In-App Knowledge Base Check
    for (const item of aiContext.knowledge) {
      const keys = (item.keywords || '').toLowerCase().split(',').map((k) => k.trim()).filter(Boolean);
      const titleMatch = lower.includes(item.title.toLowerCase());
      const keyMatch = keys.some((k) => lower.includes(k));

      if (titleMatch || keyMatch) {
        return res.json({
          reply: item.instruction_or_answer,
          intent: 'FAQ',
          actions: [{ type: 'NAVIGATE', label: '🔍 Explore Events', path: '/explore' }],
          suggestions: ['Explore all events', 'View My Tickets', 'Contact Support'],
        });
      }
    }

    // G. Event discovery fallback
    res.json({
      reply: `Hey! I'm your **Cliq Concierge Agent**. I can help you discover upcoming concerts, locate free events, manage your tickets and transfers, or guide you through the app. What would you like to do?`,
      intent: 'GENERAL',
      events: mappedEventCards.length > 0 ? mappedEventCards : undefined,
      actions: [
        { type: 'NAVIGATE', label: '🔍 Explore Events', path: '/explore' },
        { type: 'NAVIGATE', label: '🎟️ My Tickets', path: user ? '/attendee/tickets' : '/login' },
      ],
      suggestions: [
        'What’s happening this weekend?',
        'Concerts and live shows',
        'Show my tickets',
        'How do I transfer a ticket?',
      ],
    });
  } catch (err) {
    console.error('[chatController.handleChatMessage]', err);
    res.status(500).json({
      reply: `I ran into a quick hiccup looking that up. Feel free to ask again or browse the Explore page!`,
      actions: [{ type: 'NAVIGATE', label: '🔍 Explore Events', path: '/explore' }],
      suggestions: ['Explore Events', 'View My Tickets', 'Contact Support'],
    });
  }
};

export default { handleChatMessage };
