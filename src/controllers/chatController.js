import axios from 'axios';
import pool from '../config/db.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

/**
 * Fetch top published events for live context
 */
async function getLiveEventsContext() {
  try {
    const [events] = await pool.execute(`
      SELECT e.id, e.title, e.description, e.banner_image, e.start_date, e.start_time, e.venue, e.city, e.category,
             COALESCE(MIN(tt.price), 0) AS min_price
      FROM events e
      LEFT JOIN ticket_types tt ON tt.event_id = e.id
      WHERE e.status = 'published'
      GROUP BY e.id
      ORDER BY e.start_date ASC
      LIMIT 12
    `);
    return events || [];
  } catch (err) {
    console.error('[chatController.getLiveEventsContext]', err.message);
    return [];
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
      temperature: config.ai_temperature ? Number(config.ai_temperature) : 0.7,
    };
  } catch (err) {
    console.error('[chatController.getAITrainingContext]', err.message);
    return { knowledge: [], customInstructions: '', temperature: 0.7 };
  }
}

/**
 * Intelligent Gemini AI Event Concierge Controller
 */
export const handleChatMessage = async (req, res) => {
  try {
    const { message, conversationHistory = [], context = {} } = req.body;
    const rawMessage = (message || '').trim();

    if (!rawMessage) {
      return res.status(400).json({ message: 'Message is required' });
    }

    const [liveEvents, aiContext] = await Promise.all([
      getLiveEventsContext(),
      getAITrainingContext(),
    ]);

    const lower = rawMessage.toLowerCase();

    // Check if query is looking for events to attach interactive cards
    const isEventQuery =
      lower.includes('event') ||
      lower.includes('concert') ||
      lower.includes('party') ||
      lower.includes('festival') ||
      lower.includes('show') ||
      lower.includes('weekend') ||
      lower.includes('today') ||
      lower.includes('music') ||
      lower.includes('nightlife') ||
      lower.includes('afrobeats') ||
      lower.includes('amapiano') ||
      lower.includes('accra') ||
      lower.includes('kumasi') ||
      lower.includes('find') ||
      lower.includes('recommend') ||
      lower.includes('upcoming');

    let matchedEventCards = [];
    if (isEventQuery && liveEvents.length > 0) {
      const keywords = lower
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter((w) => !['show', 'me', 'the', 'find', 'any', 'all', 'a', 'in', 'at', 'for', 'events', 'event', 'what', 'whats', 'are', 'there', 'some', 'good', 'looking'].includes(w));

      if (keywords.length > 0) {
        matchedEventCards = liveEvents.filter((ev) => {
          const text = `${ev.title} ${ev.category} ${ev.city} ${ev.venue} ${ev.description}`.toLowerCase();
          return keywords.some((k) => text.includes(k));
        }).slice(0, 3);
      }

      if (matchedEventCards.length === 0) {
        matchedEventCards = liveEvents.slice(0, 3);
      }
    }

    const mappedCards = matchedEventCards.map((ev) => ({
      id: ev.id,
      title: ev.title,
      image: ev.banner_image,
      date: ev.start_date,
      time: ev.start_time,
      venue: ev.venue,
      city: ev.city,
      category: ev.category,
      minPrice: Number(ev.min_price),
    }));

    // If Gemini API Key is available, invoke Google Gemini with dynamic in-app training
    if (GEMINI_API_KEY) {
      try {
        const eventsSummary = liveEvents.map((e) =>
          `- Event ID ${e.id}: "${e.title}" | Date: ${e.start_date} ${e.start_time || ''} | Venue: ${e.venue || e.city} | Category: ${e.category} | Starting Price: GHS ${e.min_price}`
        ).join('\n');

        const knowledgeSummary = aiContext.knowledge.map((k) =>
          `[${k.category.toUpperCase()}] ${k.title}: ${k.instruction_or_answer}`
        ).join('\n');

        const systemInstruction = `You are Cliq Concierge, the official live event guide for Tribes & Cliqs in Ghana.
${aiContext.customInstructions || 'Tone: Friendly, concise, insider host. Speak naturally like a knowledgeable local concierge. Avoid robotic phrases, AI clichés, and emoji spam. Keep responses short and punchy (1 to 3 sentences).'}

Trained Knowledge Base & Platform Rules (Follow these instructions closely):
${knowledgeSummary || 'Standard platform rules: ticket transfers in My Tickets, resale in My Tickets, receipts via Receipt button, Paystack MoMo/card checkout.'}

Live Upcoming Events in Database:
${eventsSummary || 'No published events right now.'}
`;

        const contents = [];

        // Add previous conversation turns if provided
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

        // Add latest user query
        contents.push({
          role: 'user',
          parts: [{ text: rawMessage }],
        });

        const geminiRes = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
          {
            contents,
            systemInstruction: {
              parts: [{ text: systemInstruction }],
            },
            generationConfig: {
              temperature: aiContext.temperature || 0.7,
              maxOutputTokens: 250,
            },
          },
          { timeout: 8000 }
        );

        const reply = geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (reply) {
          return res.json({
            reply: reply.trim(),
            events: mappedCards.length > 0 ? mappedCards : undefined,
            suggestions: [
              'What’s happening this weekend?',
              'Concerts and live shows',
              'How do I transfer a ticket?',
              'How does resale work?',
            ],
          });
        }
      } catch (geminiError) {
        console.error('[Gemini API Error, using local trained engine]:', geminiError.response?.data || geminiError.message);
      }
    }

    // Local Fallback: Check if user query matches any in-app trained knowledge items
    for (const item of aiContext.knowledge) {
      const keys = (item.keywords || '').toLowerCase().split(',').map((k) => k.trim()).filter(Boolean);
      const titleMatch = lower.includes(item.title.toLowerCase());
      const keyMatch = keys.some((k) => lower.includes(k));

      if (titleMatch || keyMatch) {
        return res.json({
          reply: item.instruction_or_answer,
          suggestions: ['Explore all events', 'View My Tickets', 'Contact Support'],
        });
      }
    }

    res.json({
      reply: `Hey! I can help you find upcoming concerts, parties, and festivals, or assist with your tickets, transfers, and receipts. What are you looking to do?`,
      events: mappedCards.length > 0 ? mappedCards : undefined,
      suggestions: [
        'What’s happening this weekend?',
        'Concerts and live shows',
        'How do I transfer a ticket?',
        'How does resale work?',
      ],
    });
  } catch (err) {
    console.error('[chatController.handleChatMessage]', err);
    res.status(500).json({
      reply: `I ran into a quick hiccup looking that up. Try asking again or browse the Explore page!`,
      suggestions: ['Explore Events', 'Contact Support'],
    });
  }
};

export default { handleChatMessage };
