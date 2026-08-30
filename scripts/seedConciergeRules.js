import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const host = process.env.DB_HOST || '127.0.0.1';
const isRemote = (h) => h && h !== 'localhost' && h !== '127.0.0.1';

const clientConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
    }
  : {
      host,
      port: parseInt(process.env.DB_PORT, 10) || 5432,
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'tribes_cliqs',
      ssl: process.env.DB_SSL === 'true' || isRemote(host) ? { rejectUnauthorized: false } : false,
    };

const client = new pg.Client(clientConfig);

const RULES = [
  {
    title: 'Ticket Resale & P2P Marketplace',
    category: 'ticketing',
    keywords: 'resale, sell ticket, cant attend, transfer ticket, resell, p2p, marketplace',
    instruction_or_answer: 'You can resell verified tickets directly through your account! Go to My Tickets, select your ticket, tap "List for Resale", and set your price (up to the original face value). Once purchased by another fan, your funds are credited to your account.',
  },
  {
    title: 'Ticket Transfer to Friend',
    category: 'ticketing',
    keywords: 'send ticket, transfer to friend, gift ticket, give ticket, share pass',
    instruction_or_answer: 'To transfer a ticket to a friend, open My Tickets, tap "Transfer", and enter their email address. They will receive an instant confirmation with their new unique QR code.',
  },
  {
    title: 'Payment Options (Mobile Money & Cards)',
    category: 'payments',
    keywords: 'payment, momo, mtn, vodafone, telecel, airteltigo, visa, mastercard, how to pay, checkout',
    instruction_or_answer: 'We support all major Ghanaian Mobile Money providers (MTN MoMo, Telecel Cash, AirtelTigo Money) as well as Visa and Mastercard via Paystack secure checkout.',
  },
  {
    title: 'Official Invoices & Tax Receipts',
    category: 'payments',
    keywords: 'receipt, invoice, proof of payment, tax receipt, vat receipt, download receipt, pdf receipt',
    instruction_or_answer: 'Official tax receipts and order invoices are automatically generated after checkout. You can download or print your PDF receipt anytime under My Tickets by clicking the "Receipt" button on any completed order.',
  },
  {
    title: 'Interactive Seating & Section Reservations',
    category: 'venue_policy',
    keywords: 'seat map, seating, table reservation, vip booth, front row, interactive map, tier layout',
    instruction_or_answer: 'For seated events and table reservations, you can preview the interactive seating map on the event page, check row numbers, table layouts, and select your exact tier before checkout.',
  },
  {
    title: 'Early-Bird Pricing & Tier Cutoffs',
    category: 'venue_policy',
    keywords: 'early bird, discounts, tier, regular, vip, ticket types, price jump, deadline',
    instruction_or_answer: 'Early-Bird tiers offer discounted rates until their sales cutoff date or until allocated tickets sell out. Once sold out, pricing automatically transitions to standard Regular and VIP tiers.',
  },
  {
    title: 'How to Host & Create an Event',
    category: 'organizer',
    keywords: 'create event, host event, organizer, publish event, sell tickets, become organizer',
    instruction_or_answer: 'Anyone can apply to become an organizer! Click "Create Event" in the top navigation, set up your event details, ticket tiers, and interactive seating, then submit for instant admin verification.',
  },
  {
    title: 'Payouts & Organizer Revenue',
    category: 'organizer',
    keywords: 'payout, withdraw money, revenue, earnings, bank transfer, momo payout',
    instruction_or_answer: 'Organizer payouts are processed securely through direct bank transfers and verified Mobile Money merchant wallets within 24 to 48 hours after event completion.',
  },
  {
    title: 'Lost Tickets & QR Code Help',
    category: 'faq',
    keywords: 'lost ticket, lost qr, cant find ticket, email not received, where is my ticket',
    instruction_or_answer: 'All purchased tickets remain permanently saved in your My Tickets tab. You can view offline QR codes anytime from your mobile device without needing to check your email.',
  },
  {
    title: 'Live Human Support Escalation',
    category: 'faq',
    keywords: 'contact human, talk to agent, support team, phone number, helpdesk, customer service',
    instruction_or_answer: 'If you need direct assistance from our customer care team, you can visit the Support page or email us at support@tribesandcliqs.com.',
  },
];

const VOICE_GUIDELINES = `You are Cliq Concierge, the official digital host and event guide for Tribes & Cliqs in Ghana.

Core Persona & Communication Rules:
1. Voice: Warm, energetic, knowledgeable, and hospitable. Speak naturally like an insider host in Accra.
2. Brevity: Keep responses punchy and concise (1 to 3 sentences maximum). Avoid long walls of text.
3. Clarity: Provide direct answers first, followed by clear next steps (e.g. "Head to My Tickets to initiate a resale").
4. No Jargon & No Emoji Spam: Never mention models, prompts, databases, or AI. Avoid emoji clutter.
5. Local Currency & Context: Use Ghana Cedis (GHS ₵) as default.
6. Safety & Directness: Never guess ticket prices or venue details if not listed. Refer users to the official event page or support team.`;

async function seed() {
  try {
    await client.connect();
    console.log('✅ Connected to database');

    // 1. Ensure table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_training_knowledge (
        id                      BIGSERIAL PRIMARY KEY,
        title                   VARCHAR(255) NOT NULL,
        category                VARCHAR(100) NOT NULL DEFAULT 'faq',
        keywords                TEXT,
        instruction_or_answer   TEXT NOT NULL,
        is_active               BOOLEAN DEFAULT TRUE,
        created_at              TIMESTAMPTZ DEFAULT NOW(),
        updated_at              TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // 2. Insert or update the training rules
    for (const r of RULES) {
      const { rows } = await client.query(
        'SELECT id FROM ai_training_knowledge WHERE title = $1',
        [r.title]
      );
      if (rows.length === 0) {
        await client.query(
          `INSERT INTO ai_training_knowledge (title, category, keywords, instruction_or_answer, is_active)
           VALUES ($1, $2, $3, $4, TRUE)`,
          [r.title, r.category, r.keywords, r.instruction_or_answer]
        );
        console.log(`+ Added rule: "${r.title}"`);
      } else {
        await client.query(
          `UPDATE ai_training_knowledge
           SET category = $1, keywords = $2, instruction_or_answer = $3, is_active = TRUE, updated_at = NOW()
           WHERE id = $4`,
          [r.category, r.keywords, r.instruction_or_answer, rows[0].id]
        );
        console.log(`~ Updated rule: "${r.title}"`);
      }
    }

    // 3. Insert system voice guidelines and settings
    await client.query(`
      INSERT INTO system_settings (setting_key, setting_value)
      VALUES ('ai_custom_instructions', $1)
      ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()
    `, [VOICE_GUIDELINES]);

    await client.query(`
      INSERT INTO system_settings (setting_key, setting_value)
      VALUES ('ai_temperature', '0.7')
      ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()
    `);

    console.log('✅ Concierge voice guidelines & temperature settings saved.');
    console.log('🎉 All concierge training rules successfully active in the database!');
  } catch (err) {
    console.error('❌ Seeding error:', err.message);
  } finally {
    await client.end();
  }
}

seed();
