import pg from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../.env') });

async function initDb() {
  const host = process.env.DB_HOST || '127.0.0.1';
  const port = parseInt(process.env.DB_PORT, 10) || 5432;
  const user = process.env.DB_USER || 'postgres';
  const password = process.env.DB_PASSWORD || '';
  const dbName = process.env.DB_NAME || 'tribes_cliqs';

  console.log(`[initDb] target=${host}:${port} user=${user} db=${dbName} ssl=${process.env.DB_SSL}`);

  let connection;
  const isRemote = (h) => h && h !== 'localhost' && h !== '127.0.0.1';
  const MAX_RETRIES = 5;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (process.env.DATABASE_URL) {
        connection = new pg.Client({
          connectionString: process.env.DATABASE_URL,
          connectionTimeoutMillis: 30000,
          ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
        });
      } else {
        const useSsl = process.env.DB_SSL === 'true' || isRemote(host);
        connection = new pg.Client({
          host,
          port,
          user,
          password,
          database: dbName,
          connectionTimeoutMillis: 30000,
          ssl: useSsl ? { rejectUnauthorized: false } : false,
        });
      }
      await connection.connect();
      console.log('Connected to PostgreSQL database.');
      break;
    } catch (err) {
      console.error(`[initDb] connection attempt ${attempt}/${MAX_RETRIES} failed: ${err.code || err.message}`);
      if (attempt < MAX_RETRIES) {
        const delay = attempt * 5000;
        console.log(`[initDb] retrying in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }

  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      // Ensure existing tables have newly added columns before index creation in schema.sql
      const preMigrations = [
        `ALTER TABLE refunds ADD COLUMN IF NOT EXISTS policy_circumstance VARCHAR(80)`,
        `ALTER TABLE refunds ADD COLUMN IF NOT EXISTS clause_number INT`,
        `ALTER TABLE refunds ADD COLUMN IF NOT EXISTS organizer_id BIGINT`,
        `ALTER TABLE refunds ADD COLUMN IF NOT EXISTS event_id BIGINT`,
        `ALTER TABLE refunds ADD COLUMN IF NOT EXISTS organizer_deadline TIMESTAMPTZ`,
        `ALTER TABLE refunds ADD COLUMN IF NOT EXISTS organizer_response TEXT`,
        `ALTER TABLE refunds ADD COLUMN IF NOT EXISTS organizer_responded_at TIMESTAMPTZ`,
        `ALTER TABLE refunds ADD COLUMN IF NOT EXISTS admin_notes TEXT`,
        `ALTER TABLE refunds ADD COLUMN IF NOT EXISTS initiated_by VARCHAR(50) DEFAULT 'buyer'`,
        `ALTER TABLE refunds ADD COLUMN IF NOT EXISTS paystack_reference VARCHAR(100)`,
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_requested_at TIMESTAMPTZ`,
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_request_status VARCHAR(50)`,
      ];
      for (const preSql of preMigrations) {
        try {
          await connection.query(preSql);
        } catch {
          // ignore if table doesn't exist yet (schema.sql will create it)
        }
      }

      console.log('Executing schema.sql...');
      const schemaSql = fs.readFileSync(schemaPath, 'utf8');
      await connection.query(schemaSql);
      console.log('Database schema created/updated successfully!');

      // Safe column widening migrations for existing tables
      const safeMigrations = [
        `ALTER TABLE users ALTER COLUMN phone TYPE VARCHAR(60)`,
        `ALTER TABLE users ALTER COLUMN name TYPE VARCHAR(255)`,
        `ALTER TABLE users ALTER COLUMN email TYPE VARCHAR(255)`,
        `ALTER TABLE users ALTER COLUMN password TYPE VARCHAR(255)`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT FALSE`,
        `ALTER TABLE organizer_profiles ALTER COLUMN organization_name TYPE VARCHAR(255)`,
        `ALTER TABLE email_verifications ALTER COLUMN token_hash TYPE VARCHAR(128)`,
        `ALTER TABLE organizer_profiles ADD COLUMN IF NOT EXISTS category VARCHAR(120)`,
        `ALTER TABLE organizer_profiles ADD COLUMN IF NOT EXISTS city VARCHAR(120)`,
        `ALTER TABLE organizer_profiles ADD COLUMN IF NOT EXISTS country VARCHAR(120)`,
        `ALTER TABLE events ADD COLUMN IF NOT EXISTS ticket_template VARCHAR(500)`,
        `ALTER TABLE events ADD COLUMN IF NOT EXISTS location_type VARCHAR(20) DEFAULT 'physical'`,
        `ALTER TABLE events ADD COLUMN IF NOT EXISTS gps_location VARCHAR(255)`,
        `ALTER TABLE events DROP CONSTRAINT IF EXISTS events_approval_status_check`,
        `ALTER TABLE events ADD CONSTRAINT events_approval_status_check CHECK (approval_status IN ('pending','approved','rejected','changes_requested'))`,
        `ALTER TABLE reviews ALTER COLUMN event_id DROP NOT NULL`,
        `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS title VARCHAR(255)`,
        `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending'`,
        `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT FALSE`,
        `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT FALSE`,
        `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`,
        `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS approved_by BIGINT`,
        `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS admin_notes TEXT`,
        `CREATE INDEX IF NOT EXISTS idx_rev_status ON reviews(status)`,
        `CREATE INDEX IF NOT EXISTS idx_rev_featured ON reviews(is_featured)`,
        `ALTER TABLE announcements DROP CONSTRAINT IF EXISTS announcements_channel_check`,
        `ALTER TABLE announcements DROP CONSTRAINT IF EXISTS announcements_target_role_check`,
        `ALTER TABLE announcements ADD COLUMN IF NOT EXISTS sent_count INT DEFAULT 0`,
        `ALTER TABLE announcements ADD COLUMN IF NOT EXISTS failed_count INT DEFAULT 0`,
        `ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS reference VARCHAR(50)`,
        `ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS order_id BIGINT`,
        `ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS event_id BIGINT`,
        `ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS internal_notes TEXT`,
        `ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS metadata JSONB`,
        `CREATE TABLE IF NOT EXISTS pending_registrations (
          id                BIGSERIAL PRIMARY KEY,
          registration_id   VARCHAR(64) NOT NULL UNIQUE,
          name              VARCHAR(120) NOT NULL,
          email             VARCHAR(190) NOT NULL,
          phone             VARCHAR(50),
          password_hash     VARCHAR(255) NOT NULL,
          role              VARCHAR(50) NOT NULL DEFAULT 'attendee',
          organization_name VARCHAR(180),
          metadata          JSONB,
          otp_hash          VARCHAR(128) NOT NULL,
          expires_at        TIMESTAMPTZ NOT NULL,
          created_at        TIMESTAMPTZ DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS event_reminders (
          id                BIGSERIAL PRIMARY KEY,
          user_id           BIGINT NOT NULL,
          event_id          BIGINT NOT NULL,
          remind_at         TIMESTAMPTZ,
          email_sent        BOOLEAN DEFAULT FALSE,
          sms_sent          BOOLEAN DEFAULT FALSE,
          created_at        TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(user_id, event_id)
        )`,
        `CREATE TABLE IF NOT EXISTS artist_follows (
          id                BIGSERIAL PRIMARY KEY,
          user_id           BIGINT NOT NULL,
          artist_name       VARCHAR(150) NOT NULL,
          created_at        TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(user_id, artist_name)
        )`,
        `CREATE TABLE IF NOT EXISTS category_follows (
          id                BIGSERIAL PRIMARY KEY,
          user_id           BIGINT NOT NULL,
          category_name     VARCHAR(100) NOT NULL,
          created_at        TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(user_id, category_name)
        )`,
        `ALTER TABLE event_reminders ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{"sevenDays": true, "twentyFourHours": true, "oneHour": true, "salesOpening": true, "almostSoldOut": true, "timeChanged": true, "venueChanged": true, "cancelled": true}'`,
        `ALTER TABLE event_reminders ADD COLUMN IF NOT EXISTS notified_stages JSONB DEFAULT '[]'`,
        `ALTER TABLE event_meetups ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'general'`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(120)`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS firebase_uid VARCHAR(120)`,
        `ALTER TABLE ticket_types ADD COLUMN IF NOT EXISTS early_bird_deadline TIMESTAMPTZ`,
        `ALTER TABLE ticket_types ADD COLUMN IF NOT EXISTS early_bird_max_qty INT`,
        `ALTER TABLE ticket_types ADD COLUMN IF NOT EXISTS early_bird_price DECIMAL(10,2)`,
        `ALTER TABLE ticket_types ADD COLUMN IF NOT EXISTS section_type VARCHAR(50) DEFAULT 'general'`,
        `ALTER TABLE ticket_types ADD COLUMN IF NOT EXISTS perks JSONB`,
        `ALTER TABLE ticket_types ADD COLUMN IF NOT EXISTS image TEXT`,
        `ALTER TABLE coupons ADD COLUMN IF NOT EXISTS min_quantity INT DEFAULT 1`,
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(64)`,
        `ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS rejection_reason VARCHAR(255)`,
        `ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS notes TEXT`,
        `CREATE TABLE IF NOT EXISTS event_discussions (
          id                BIGSERIAL PRIMARY KEY,
          event_id          BIGINT NOT NULL,
          user_id           BIGINT NOT NULL,
          message           TEXT NOT NULL,
          created_at        TIMESTAMPTZ DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS ai_training_knowledge (
          id                      BIGSERIAL PRIMARY KEY,
          title                   VARCHAR(255) NOT NULL,
          category                VARCHAR(100) NOT NULL DEFAULT 'faq',
          keywords                TEXT,
          instruction_or_answer   TEXT NOT NULL,
          is_active               BOOLEAN DEFAULT TRUE,
          created_at              TIMESTAMPTZ DEFAULT NOW(),
          updated_at              TIMESTAMPTZ DEFAULT NOW()
        )`,
        `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ticket_file_url TEXT`,
        `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ticket_file_name VARCHAR(255)`,
        `CREATE TABLE IF NOT EXISTS uploaded_tickets (
          id                  BIGSERIAL PRIMARY KEY,
          event_id            BIGINT NOT NULL,
          ticket_type_id      BIGINT NOT NULL,
          file_url            TEXT NOT NULL,
          file_name           VARCHAR(255),
          barcode             VARCHAR(100),
          seat_number         VARCHAR(50),
          is_assigned         BOOLEAN NOT NULL DEFAULT FALSE,
          assigned_ticket_id  BIGINT,
          assigned_at         TIMESTAMPTZ,
          created_at          TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT fk_ut_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
          CONSTRAINT fk_ut_tt FOREIGN KEY (ticket_type_id) REFERENCES ticket_types(id) ON DELETE CASCADE
        )`,
        `CREATE INDEX IF NOT EXISTS idx_ut_tt_unassigned ON uploaded_tickets(ticket_type_id, is_assigned)`,
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_requested_at TIMESTAMPTZ`,
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_request_status VARCHAR(50)`,
        `ALTER TABLE refunds ADD COLUMN IF NOT EXISTS policy_circumstance VARCHAR(80)`,
        `ALTER TABLE refunds ADD COLUMN IF NOT EXISTS clause_number INT`,
        `ALTER TABLE refunds ADD COLUMN IF NOT EXISTS organizer_id BIGINT`,
        `ALTER TABLE refunds ADD COLUMN IF NOT EXISTS event_id BIGINT`,
        `ALTER TABLE refunds ADD COLUMN IF NOT EXISTS organizer_deadline TIMESTAMPTZ`,
        `ALTER TABLE refunds ADD COLUMN IF NOT EXISTS organizer_response TEXT`,
        `ALTER TABLE refunds ADD COLUMN IF NOT EXISTS organizer_responded_at TIMESTAMPTZ`,
        `ALTER TABLE refunds ADD COLUMN IF NOT EXISTS admin_notes TEXT`,
        `ALTER TABLE refunds ADD COLUMN IF NOT EXISTS initiated_by VARCHAR(50) DEFAULT 'buyer'`,
        `ALTER TABLE refunds ADD COLUMN IF NOT EXISTS paystack_reference VARCHAR(100)`,
        `CREATE INDEX IF NOT EXISTS idx_ref_status ON refunds(status)`,
        `CREATE INDEX IF NOT EXISTS idx_ref_org_deadline ON refunds(organizer_deadline)`,
        `CREATE INDEX IF NOT EXISTS idx_ref_policy_circ ON refunds(policy_circumstance)`,
        `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS is_deleted_by_user BOOLEAN DEFAULT FALSE`,
        `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
        `CREATE INDEX IF NOT EXISTS idx_t_deleted_user ON tickets(user_id, is_deleted_by_user)`,
      ];
      for (const migSql of safeMigrations) {
        try {
          await connection.query(migSql);
        } catch {
          // ignore if already migrated or column doesn't need change
        }
      }

      // Seed default AI training knowledge items if empty
      const { rows: aiRows } = await connection.query('SELECT COUNT(*) AS count FROM ai_training_knowledge');
      if (parseInt(aiRows[0].count, 10) === 0) {
        const defaultAITraining = [
          ['Organizer 2-Step Publishing Workflow', 'organizer', 'create event, publish event, add tickets, organizer workflow, how to host, step by step', 'To host an event on Tribes & Cliqs, you must follow the 2-step publishing flow: Step 1: Create your event details (title, dates, venue, category, and banner image) and publish it. Step 2: Once published, go to Tickets (/organizer/tickets) to add ticket tiers (VIP, Regular, Table) with custom prices and capacities. You cannot add tickets until the event is published.'],
          ['Organizer Ticket Tiers & Pricing Configuration', 'organizer', 'ticket tiers, ticket pricing, vip, regular, table, early bird, capacity, pause sales', 'Organizers can configure multiple ticket tiers for any published event: Regular, VIP, VVIP, Early Bird (with discount cutoffs), and Table reservations (Cabanas, Table of 4, Table of 6). You can set custom capacities, descriptions, and pause sales at any time from the Tickets management page.'],
          ['Gate Check-In & High-Speed QR Scanner', 'organizer', 'scan tickets, gate scanner, bouncer, door staff, check in, qr scanner, admissions, anti duplicate', 'Organizers and door security staff use our built-in camera scanner at /organizer/check-in to validate attendee digital passes in under 1 second. Each ticket features a cryptographically signed QR code that prevents duplicate entry. If an attendee phone is discharged or broken, staff can search by ticket number or name.'],
          ['Organizer Payouts & Revenue Withdrawals', 'organizer', 'payout, withdraw sales, organizer earnings, momo withdrawal, bank payout, revenue', 'Ticket sales revenue is calculated in real time. Organizers can request payouts directly to MTN Mobile Money, Telecel Cash, or direct Ghanaian bank accounts via the Payouts dashboard (/organizer/payouts). Withdrawals are verified and processed within 24 to 48 hours.'],
          ['Export Attendee Guest Lists', 'organizer', 'export attendees, download guest list, csv export, attendee list, check-in report', 'Organizers can view confirmed guest registrations and export complete attendee reports to CSV or Excel from the Event Management dashboard to coordinate with gate staff, security, or event sponsors.'],
          ['How to Purchase a Ticket (Step-by-Step Process & Rules)', 'ticketing', 'how can i purchase, how to purchase, how do i buy ticket, how can they purchase, purchase process, buying rules, steps to buy, how to buy ticket, ticket purchase rules', 'To purchase a ticket on Tribes & Cliqs: 1. Find an event in Explore or ask Cliq to recommend events in Accra, Kumasi, or Takoradi. 2. Select your ticket tier (Regular, VIP, VVIP, Table) and quantity. 3. Proceed to checkout where tickets are locked for 10 minutes. 4. Pay in Ghana Cedis via MTN MoMo, Telecel Cash, AT Money (approve USSD prompt with PIN), or Visa/Mastercard. 5. Your digital QR admission pass is immediately saved to My Tickets and sent via email/SMS. Passes work offline at the gate. If you purchase 1 ticket, only a single pass is displayed.'],
          ['Digital QR Entry Passes & Offline Wallet', 'ticketing', 'my tickets, qr pass, entry pass, barcode, digital pass, wallet, offline ticket', 'Every ticket purchased is automatically minted and stored in your digital wallet under My Tickets (/attendee/tickets). The high-resolution QR pass works completely offline, so you can enter the venue even if your phone has no active mobile data.'],
          ['Single Ticket Post-Payment Focused Layout', 'ticketing', 'single ticket, one ticket, post payment, callback, admission pass', 'When you purchase a single ticket, your confirmation screen displays a single, focused admission pass titled "Your Digital Admission Ticket" with zero clutter or duplicate cards. Multi-ticket orders display your complete ticket bundle.'],
          ['10-Minute Cart Reservation Hold', 'ticketing', 'reservation hold, 10 minutes, cart timer, countdown, hold ticket, booking hold', 'During checkout, your chosen tickets are temporarily held for 10 minutes with an active countdown timer. This guarantees your tickets will not be sold to anyone else while you complete your Mobile Money or Card payment.'],
          ['Free Peer-to-Peer Ticket Transfers', 'ticketing', 'transfer ticket, send to friend, gift ticket, give ticket, share pass, transfer to email', 'You can transfer any active ticket pass to a friend for free! Open My Tickets, select the pass, tap "Transfer", and enter their email or phone number. The original QR code is instantly revoked and a fresh, secure pass is delivered to your recipient.'],
          ['Verified Resale Marketplace & Fair Price Caps', 'ticketing', 'resell ticket, resale marketplace, can’t attend, buy resale, sell pass, anti-scalping', 'If you cannot attend, list your ticket on our official verified resale marketplace at /explore?filter=resale. To protect fans from scalping, prices are capped at original face value. When purchased, you receive instant payout and the buyer gets a freshly minted QR pass.'],
          ['Mobile Money Payments (MTN MoMo, Telecel Cash, AT Money)', 'payments', 'payment, momo, mtn momo, telecel cash, at money, ussd prompt, pin, how to pay', 'All payments are processed securely in Ghana Cedis (GHS) via Paystack. For Mobile Money, enter your phone number at checkout and an instant USSD push prompt will appear on your phone. Enter your Mobile Money PIN to authorize the payment.'],
          ['Card Payments (Visa, Mastercard, Verve)', 'payments', 'visa, mastercard, debit card, credit card, paystack, bank card payment', 'We accept all Visa, Mastercard, and Verve debit and credit cards worldwide through Paystack with 3D-Secure 256-bit encryption for maximum transaction safety.'],
          ['Official Invoices & Tax Receipts', 'payments', 'receipt, tax receipt, vat invoice, download receipt, proof of payment, order invoice', 'Official receipts and tax invoices are automatically generated for every completed transaction. You can view, print, or download your PDF receipt anytime under Orders or My Tickets by tapping "Receipt".'],
          ['Payment Verification & Pending Checkouts', 'payments', 'verify payment, payment pending, money deducted, momo approved, confirm payment', 'If your Mobile Money prompt was approved but your pass hasn\'t appeared, click "Verify Payment" on your booking card or visit your orders page. Our system performs an instant server check with Paystack to synchronize your order.'],
          ['Automatic Full Refunds on Event Cancellation', 'faq', 'refund, cancelled event, postponed event, money back, refund policy', 'If an event is cancelled or called off by the organizer, you will receive an automatic 100% full refund credited back to your original Mobile Money wallet or bank card. For other cases, refunds are subject to organizer policy or you can resell your ticket on the marketplace.'],
          ['Squad Chats & Social Event Coordination', 'faq', 'squad chat, friends, group booking, social sharing, chat with attendees', 'Tribes & Cliqs features Squad Chats for group coordination with friends attending the same concert or festival. You can also share events directly to WhatsApp, Instagram Stories, X (Twitter), or copy shareable event links.'],
          ['Venue Guidelines, Directions & Parking', 'venue_policy', 'venue directions, parking, untamed empire, polo beach, black star square, national theatre, accra sports stadium', 'Each event page lists exact venue details, addresses, and map pins across Accra, Kumasi, and Takoradi. Check event descriptions for on-site parking availability and VIP valet services.'],
          ['Dress Codes & Venue Entry Rules', 'venue_policy', 'dress code, all white, rave, smart casual, traditional, streetwear, gate rules', 'Event organizers configure specific dress codes (e.g. All White, Smart Casual, High Fashion, Beachwear, Rave). Adhering to the specified dress code is required for venue entry as enforced by venue security.'],
          ['Age Limits & Gate Identification', 'venue_policy', 'age limit, 18+, all ages, family friendly, id required, ghana card, passport', 'Nightclub and rave events are strictly 18+ and require government ID (Ghana Card, Passport, or Driver’s License) at the door. Family and cultural festivals are open to all ages as specified on the event card.'],
          ['Interactive Seating Maps & Table Reservations', 'venue_policy', 'seating map, seat layout, table reservation, cabana, vip table, booth', 'For table reservations and seated auditoriums, browse the interactive seat map on the event page to select your preferred table layout (Cabana, Front Row VIP, Tables for 4 or 6) before checking out.'],
          ['Emergency Gate Assistance & Discharged Phones', 'faq', 'gate emergency, dead phone, broken screen, bouncer issue, invalid ticket, door help', 'If your phone battery dies or your screen is damaged at the gate, don\'t panic. Present your valid national ID and phone number to the gate staff, who can locate your booking and admit you via the manual check-in override.'],
          ['Customer Care & Human Support Escalation', 'faq', 'customer care, support team, email support, talk to human, contact support, help desk', 'Our customer support team is on standby to assist with urgent gate issues, transaction questions, or organizer onboarding. Email us directly at support@tribesandcliqs.com.'],
          ['Account Security & Email Verification', 'custom', 'verify email, change password, reset password, account security, profile update', 'To keep your tickets and wallet safe, always verify your email address. You can update your profile name, phone number, and password anytime under Profile Settings (/profile).'],
          ['Early-Bird Discounts & Capacity Alerts', 'promotion', 'early bird discount, promo, discount price, ticket discount, limited offer', 'Early-Bird tickets offer limited-time discounts that expire when the deadline date passes or when the allocated batch sells out. Secure them early to lock in the lowest price.'],
          ['Becoming an Organizer & Account Switching', 'organizer', 'become an organizer, organizer account, switch role, host parties, event planner', 'Any registered user can apply to become an organizer directly from their profile. Once approved, you gain access to the Organizer Dashboard to create events, configure ticket tiers, scan passes, and track revenue.'],
        ];

        for (const [title, category, keywords, instruction_or_answer] of defaultAITraining) {
          await connection.query(
            `INSERT INTO ai_training_knowledge (title, category, keywords, instruction_or_answer, is_active)
             VALUES ($1, $2, $3, $4, TRUE)`,
            [title, category, keywords, instruction_or_answer],
          );
        }
        console.log('Default AI training knowledge items seeded.');
      }
    } else {
      console.warn('schema.sql not found at', schemaPath);
    }

    const bcrypt = (await import('bcryptjs')).default;
    const adminEmail = process.env.ADMIN_EMAIL ? process.env.ADMIN_EMAIL.toLowerCase().trim() : null;
    const adminPass = process.env.ADMIN_PASSWORD ? String(process.env.ADMIN_PASSWORD) : null;

    if (!adminEmail || !adminPass) {
      console.log('[initDb] ADMIN_EMAIL or ADMIN_PASSWORD not set in environment — skipping admin seed.');
    } else {
      const { rows: adminRows } = await connection.query(
        `SELECT id, role FROM users WHERE email = $1 OR role IN ('system_admin', 'superadmin', 'admin') LIMIT 1`,
        [adminEmail],
      );

      if (adminRows.length === 0) {
        const adminHash = await bcrypt.hash(adminPass, 12);
        await connection.query(
          `INSERT INTO users (name, email, password, role, status, is_approved, email_verified)
           VALUES ('System Administrator', $1, $2, 'system_admin', 'active', TRUE, TRUE)
           ON CONFLICT (email) DO UPDATE SET role = 'system_admin', status = 'active', email_verified = TRUE`,
          [adminEmail, adminHash],
        );
        console.log('Seed system admin account created from environment credentials.');
      } else {
        console.log('System Admin account already exists — skipping seed (password untouched).');
      }
    }

    // Seed default categories if none exist
    const { rows: catRows } = await connection.query('SELECT COUNT(*) AS count FROM categories');
    if (parseInt(catRows[0].count, 10) === 0) {
      const defaultCategories = [
        ['Music & Concerts', 'music-concerts', 'Music', 'Live concerts, festivals, DJ sets, and musical performances.'],
        ['Nightlife & Parties', 'nightlife-parties', 'PartyPopper', 'Club nights, beach parties, pool parties, and late-night events.'],
        ['Business & Networking', 'business-networking', 'Briefcase', 'Conferences, networking mixers, career fairs, and seminars.'],
        ['Arts & Culture', 'arts-culture', 'Palette', 'Art exhibitions, theatrical plays, cultural festivals, and heritage celebrations.'],
        ['Food & Drinks', 'food-drinks', 'Utensils', 'Food festivals, wine tastings, cooking workshops, and dining experiences.'],
        ['Sports & Fitness', 'sports-fitness', 'Dumbbell', 'Marathons, fitness bootcamps, tournaments, and wellness retreats.'],
        ['Tech & Innovation', 'tech-innovation', 'Cpu', 'Hackathons, developer meetups, startup pitches, and tech summits.'],
        ['Workshops & Education', 'workshops-education', 'GraduationCap', 'Hands-on masterclasses, skill-building workshops, and training sessions.'],
        ['Community & Causes', 'community-causes', 'Heart', 'Charity fundraisers, community outreach, and social impact gatherings.'],
      ];

      for (let i = 0; i < defaultCategories.length; i++) {
        const [name, slug, icon, description] = defaultCategories[i];
        await connection.query(
          `INSERT INTO categories (name, slug, icon, description, sort_order, is_active)
           VALUES ($1, $2, $3, $4, $5, TRUE)
           ON CONFLICT (slug) DO NOTHING`,
          [name, slug, icon, description, i + 1],
        );
      }
      console.log('Default categories seeded.');
    }
  } catch (err) {
    console.error('Database initialization error:', err.message);
  } finally {
    if (connection) await connection.end();
  }
}

initDb().catch((err) => {
  console.error('Database initialization failed — server will start but DB-dependent routes may error until the database is reachable.');
  console.error('   Error:', err.message);
});
