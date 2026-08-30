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
        `ALTER TABLE event_meetups ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'general'`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(120)`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS firebase_uid VARCHAR(120)`,
        `ALTER TABLE ticket_types ADD COLUMN IF NOT EXISTS early_bird_deadline TIMESTAMPTZ`,
        `ALTER TABLE ticket_types ADD COLUMN IF NOT EXISTS early_bird_max_qty INT`,
        `ALTER TABLE ticket_types ADD COLUMN IF NOT EXISTS early_bird_price DECIMAL(10,2)`,
        `ALTER TABLE ticket_types ADD COLUMN IF NOT EXISTS section_type VARCHAR(50) DEFAULT 'general'`,
        `ALTER TABLE ticket_types ADD COLUMN IF NOT EXISTS perks JSONB`,
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(64)`,
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
          ['Ticket Resale & P2P Marketplace', 'ticketing', 'resale, sell ticket, cant attend, transfer ticket, resell, p2p, marketplace', 'You can resell verified tickets directly through your account! Go to My Tickets, select your ticket, tap "List for Resale", and set your price (up to the original face value). Once purchased by another fan, your funds are credited to your account.'],
          ['Ticket Transfer to Friend', 'ticketing', 'send ticket, transfer to friend, gift ticket, give ticket, share pass', 'To transfer a ticket to a friend, open My Tickets, tap "Transfer", and enter their email address. They will receive an instant confirmation with their new unique QR code.'],
          ['Payment Options (Mobile Money & Cards)', 'payments', 'payment, momo, mtn, vodafone, telecel, airteltigo, visa, mastercard, how to pay, checkout', 'We support all major Ghanaian Mobile Money providers (MTN MoMo, Telecel Cash, AirtelTigo Money) as well as Visa and Mastercard via Paystack secure checkout.'],
          ['Official Invoices & Tax Receipts', 'payments', 'receipt, invoice, proof of payment, tax receipt, vat receipt, download receipt, pdf receipt', 'Official tax receipts and order invoices are automatically generated after checkout. You can download or print your PDF receipt anytime under My Tickets by clicking the "Receipt" button on any completed order.'],
          ['Interactive Seating & Section Reservations', 'venue_policy', 'seat map, seating, table reservation, vip booth, front row, interactive map, tier layout', 'For seated events and table reservations, you can preview the interactive seating map on the event page, check row numbers, table layouts, and select your exact tier before checkout.'],
          ['Early-Bird Pricing & Tier Cutoffs', 'venue_policy', 'early bird, discounts, tier, regular, vip, ticket types, price jump, deadline', 'Early-Bird tiers offer discounted rates until their sales cutoff date or until allocated tickets sell out. Once sold out, pricing automatically transitions to standard Regular and VIP tiers.'],
          ['How to Host & Create an Event', 'organizer', 'create event, host event, organizer, publish event, sell tickets, become organizer', 'Anyone can apply to become an organizer! Click "Create Event" in the top navigation, set up your event details, ticket tiers, and interactive seating, then submit for instant admin verification.'],
          ['Payouts & Organizer Revenue', 'organizer', 'payout, withdraw money, revenue, earnings, bank transfer, momo payout', 'Organizer payouts are processed securely through direct bank transfers and verified Mobile Money merchant wallets within 24 to 48 hours after event completion.'],
          ['Lost Tickets & QR Code Help', 'faq', 'lost ticket, lost qr, cant find ticket, email not received, where is my ticket', 'All purchased tickets remain permanently saved in your My Tickets tab. You can view offline QR codes anytime from your mobile device without needing to check your email.'],
          ['Live Human Support Escalation', 'faq', 'contact human, talk to agent, support team, phone number, helpdesk, customer service', 'If you need direct assistance from our customer care team, you can visit the Support page or email us at support@tribesandcliqs.com.'],
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
    const adminEmail = (process.env.ADMIN_EMAIL || 'admin@tribesandcliqs.com').toLowerCase().trim();
    const { rows: adminRows } = await connection.query(
      `SELECT id, role FROM users WHERE email = $1 OR role IN ('system_admin', 'superadmin', 'admin') LIMIT 1`,
      [adminEmail],
    );

    if (adminRows.length === 0) {
      const adminPass = process.env.ADMIN_PASSWORD || 'tribesandcliqs';
      if (!process.env.ADMIN_PASSWORD && process.env.NODE_ENV === 'production') {
        console.warn('ADMIN_PASSWORD is not set — the seed admin account uses the default password. Set ADMIN_PASSWORD before deploying.');
      }
      const adminHash = await bcrypt.hash(adminPass, 12);
      await connection.query(
        `INSERT INTO users (name, email, password, role, status, is_approved, email_verified)
         VALUES ('System Administrator', $1, $2, 'system_admin', 'active', TRUE, TRUE)
         ON CONFLICT (email) DO UPDATE SET role = 'system_admin', status = 'active', email_verified = TRUE`,
        [adminEmail, adminHash],
      );
      console.log('Seed system admin account created.');
    } else {
      console.log('System Admin account already exists — skipping seed (password untouched).');
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
