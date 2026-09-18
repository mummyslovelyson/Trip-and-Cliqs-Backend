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

const COMPREHENSIVE_RULES = [
  // ── 1. TICKETING & PASSES ──
  {
    title: 'Accessing Purchased Tickets & QR Passes',
    category: 'ticketing',
    keywords: 'my tickets, view ticket, show ticket, where is ticket, qr pass, barcode, entry code, offline ticket',
    instruction_or_answer: 'All purchased tickets are stored permanently under **My Tickets** (/attendee/tickets). Each ticket features an encrypted QR code and unique reference (#TC-xxxx) that can be scanned directly from your phone screen even without active internet.',
  },
  {
    title: 'Ticket Transfer to Friend or Family',
    category: 'ticketing',
    keywords: 'transfer ticket, send ticket to friend, gift pass, share ticket, change name on ticket, handover',
    instruction_or_answer: 'To transfer a ticket, navigate to **My Tickets**, find your pass, and click **Transfer**. Enter the recipient’s email address or phone. Our system instantly invalidates your old QR code and issues a brand-new encrypted pass to the recipient for total security.',
  },
  {
    title: 'Ticket Resale Marketplace Rules & Payouts',
    category: 'ticketing',
    keywords: 'resale, sell ticket, resale marketplace, p2p, cant attend, list ticket, scalp, ticket price cap',
    instruction_or_answer: 'Can’t attend an event? Head to **My Tickets**, select your pass, and click **List for Resale**. You can set any price up to the original face value (scalping above face value is strictly blocked). Once purchased by another attendee, funds are credited directly to your account wallet.',
  },
  {
    title: 'Seating Maps & Section Reservations',
    category: 'ticketing',
    keywords: 'seating, seat map, table booking, vip booth, front row, reserved seating, table reservation',
    instruction_or_answer: 'For seated concerts, comedy specials, and VIP table reservations, you can preview the interactive seat map on the event page, review row/table availability, and choose your exact section before checkout.',
  },
  {
    title: 'Early-Bird Tiers & Flash Sales',
    category: 'ticketing',
    keywords: 'early bird, discount tier, ticket price jump, deadline, vip vs regular, flash sale',
    instruction_or_answer: 'Early-Bird tickets offer limited discount pricing until the cutoff date or allocated quantity sells out. Once sold out, pricing shifts automatically to Regular and VIP tiers.',
  },

  // ── 2. PAYMENTS & TRANSACTIONS ──
  {
    title: 'Supported Ghanaian & International Payment Methods',
    category: 'payments',
    keywords: 'payment methods, momo, mtn mobile money, telecel cash, airteltigo money, visa, mastercard, how to pay',
    instruction_or_answer: 'We support all Ghanaian Mobile Money networks (MTN MoMo, Telecel Cash, AirtelTigo Money) as well as local and international Visa and Mastercard cards, powered securely by Paystack.',
  },
  {
    title: 'Downloading Tax Invoices & PDF Receipts',
    category: 'payments',
    keywords: 'receipt, invoice, proof of purchase, vat receipt, download receipt, tax receipt',
    instruction_or_answer: 'Official order invoices and receipts are generated automatically upon purchase. In **My Tickets**, click the **Receipt** button on any completed booking to download or print your PDF receipt with VAT breakdown.',
  },
  {
    title: 'Handling Deductions Without Ticket Generated',
    category: 'payments',
    keywords: 'charged twice, money deducted no ticket, payment pending, debited but no ticket, momo prompt failed',
    instruction_or_answer: 'If your Mobile Money or card was debited but the ticket hasn’t appeared, check **My Bookings** for your Paystack reference. If still pending after 5 minutes, head to **Support** (/attendee/support) to open a high-priority ticket with your transaction ID for instant manual verification.',
  },
  {
    title: 'Refund Policy & Event Cancellations',
    category: 'payments',
    keywords: 'refund, money back, event cancelled, postponed, rain out, refund policy',
    instruction_or_answer: 'If an event is cancelled or indefinitely postponed by the organizer, 100% full refunds are issued automatically back to your original payment method. For change-of-mind, tickets can be resold on the verified Resale Marketplace.',
  },

  // ── 3. ORGANIZER CAPABILITIES & TOOLS ──
  {
    title: 'Creating & Publishing Live Events',
    category: 'organizer',
    keywords: 'create event, host event, publish event, sell tickets, organizer dashboard, become organizer',
    instruction_or_answer: 'To host an event, tap **Create Event** (/organizer/events/create) to upload high-res banners, define ticket tiers, set capacity, configure promo coupons, and submit for quick administrative approval.',
  },
  {
    title: 'Gate Check-In Scanner for Door Staff',
    category: 'organizer',
    keywords: 'scanner, check in guests, door scan, validate ticket, gate check, camera scanner, staff check in',
    instruction_or_answer: 'Organizers and staff can validate passes at the gate using the in-app QR scanner at **/organizer/check-in**. It supports high-speed camera scanning, manual 6-digit code entry, and bulk check-ins.',
  },
  {
    title: 'Organizer Revenue Payouts & Settlement Time',
    category: 'organizer',
    keywords: 'payout, withdraw money, revenue withdrawal, bank payout, momo payout, settlement time',
    instruction_or_answer: 'Organizer revenue can be withdrawn directly to your verified Ghanaian Bank Account or Mobile Money merchant wallet from the **Organizer Wallet** tab (/organizer/wallet). Payouts are reviewed and settled within 24 to 48 hours.',
  },
  {
    title: 'Coupons, Promo Codes & Flash Discounts',
    category: 'organizer',
    keywords: 'promo code, coupon, discount, flash sale, promotional code, special offer',
    instruction_or_answer: 'Organizers can generate custom promo codes and time-limited flash sales from the **Promotions** tab (/organizer/promotions) to offer percentage or fixed discounts to select attendee tribes.',
  },

  // ── 4. MACHINE LEARNING & PERSONALIZATION ──
  {
    title: 'AI & Machine Learning Event Recommendations',
    category: 'ai_ml',
    keywords: 'ml match, recommend events, personalized picks, match score, taste profile, how does it recommend',
    instruction_or_answer: 'Our Machine Learning engine uses TF-IDF and Cosine Similarity vector matching to calculate taste compatibility between your past ticket choices, favorite categories, and live upcoming events, displaying an intuitive Match Score (e.g. 96% ML Match).',
  },
  {
    title: 'Voice Agent Capabilities & Hands-Free Interaction',
    category: 'ai_ml',
    keywords: 'voice agent, hands free, voice mode, audio assistant, speak to bot, voice search',
    instruction_or_answer: 'The Hands-Free Voice Agent lets you discover events and check passes by speaking naturally. The neural visualizer orb reacts in real-time as it listens and responds via natural speech synthesis. Tap the orb at any time to pause or interrupt.',
  },

  // ── 5. SAFETY, VERIFICATION & COMMUNITY ──
  {
    title: 'Verifying Official Ticket Authenticity',
    category: 'safety',
    keywords: 'verify ticket, is ticket real, authentic ticket, check fake ticket, anti counterfeit',
    instruction_or_answer: 'Anyone can verify ticket validity before purchasing off-platform by visiting **/verify** and entering the unique 6-digit verification code or scanning the QR code.',
  },
  {
    title: 'Ghanaian Nightlife Hubs & Safety Tips',
    category: 'safety',
    keywords: 'nightlife accra, osu, labadi, cantonments, east legon, kumasi, dress code, parking, safety',
    instruction_or_answer: 'Major Accra events take place across Osu, Cantonments, Labadi Beach, and East Legon. Check individual event cards for venue parking instructions, age restrictions (e.g., 18+ for club nights), and recommended dress codes.',
  },
  {
    title: 'Contacting Human Customer Support',
    category: 'support',
    keywords: 'talk to human, customer care, support team, phone number, email support, complaints',
    instruction_or_answer: 'Need personal help from a human representative? Visit our **Support Desk** (/attendee/support) to submit a ticket or reach us directly at support@tribesandcliqs.com.',
  },
];

const COMPREHENSIVE_SYSTEM_PROMPT = `You are Cliq Concierge, the official autonomous AI & Voice Agent for Tribes & Cliqs (Ghana's premier live ticketing, festival, and nightlife platform).

Tone & Communication Principles:
1. Warm, Insider Host: Speak with hospitality, high intelligence, and local cultural fluency (familiar with Accra, Kumasi, Detty December, Afrobeats, Amapiano, MoMo).
2. Concise & Punchy: Deliver direct answers in 1 to 3 sentences. Avoid robotic preamble, corporate clichés, and markdown header spam.
3. Action-Driven: Always pair recommendations or guidance with direct navigation action chips (e.g., [🎟️ View My Tickets], [🔍 Explore Events], [📲 Open Check-In Scanner], [🚨 Contact Priority Support]).
4. Machine Learning Explanations: When presenting recommended events, reference ML taste compatibility (e.g., "Matched 96% with your taste in live music").
5. Safety & Accuracy: If an event detail is not in the live database or context, politely guide the user to check the event page or ask support. Never invent fake venues or ticket prices.`;

async function seed() {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL database');

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

    // 2. Insert or update the comprehensive training rules
    for (const r of COMPREHENSIVE_RULES) {
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
        console.log(`+ Added training rule: "${r.title}"`);
      } else {
        await client.query(
          `UPDATE ai_training_knowledge
           SET category = $1, keywords = $2, instruction_or_answer = $3, is_active = TRUE, updated_at = NOW()
           WHERE id = $4`,
          [r.category, r.keywords, r.instruction_or_answer, rows[0].id]
        );
        console.log(`~ Updated training rule: "${r.title}"`);
      }
    }

    // 3. Save comprehensive system instructions
    await client.query(`
      INSERT INTO system_settings (setting_key, setting_value)
      VALUES ('ai_custom_instructions', $1)
      ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()
    `, [COMPREHENSIVE_SYSTEM_PROMPT]);

    console.log('Successfully updated AI system training instructions in system_settings.');
    console.log(`Successfully seeded all ${COMPREHENSIVE_RULES.length} domain training rules!`);
  } catch (err) {
    console.error('Seeding error:', err.message);
  } finally {
    await client.end();
  }
}

seed();
