import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../.env') });

async function initDb() {
  const host = process.env.DB_HOST || '127.0.0.1';
  const port = process.env.DB_PORT || 3306;
  const user = process.env.DB_USER || 'root';
  const password = process.env.DB_PASSWORD || '';
  const dbName = process.env.DB_NAME || 'tribes_cliqs';

  console.log(`Connecting to MySQL at ${host}:${port} as user '${user}'...`);

  let connection;
  try {
    connection = await mysql.createConnection({
      host,
      port,
      user,
      password,
      multipleStatements: true,
      connectTimeout: 30000,
      // Encrypt the connection when DB_SSL=true (required by most cloud
      // MySQL hosts, e.g. Aiven). Set DB_SSL_CA to pin a CA certificate.
      ...(process.env.DB_SSL === 'true' && {
        ssl: process.env.DB_SSL_CA
          ? { ca: process.env.DB_SSL_CA.replace(/\\n/g, '\n') }
          : { rejectUnauthorized: false },
      }),
    });

    console.log(`Creating database '${dbName}' if not exists...`);
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    await connection.query(`USE \`${dbName}\`;`);

    const schemaPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      console.log('Executing schema.sql...');
      const schemaSql = fs.readFileSync(schemaPath, 'utf8');
      await connection.query(schemaSql);

      // Migrations for existing tables
      try {
        await connection.query(`ALTER TABLE categories ADD COLUMN description TEXT AFTER icon;`);
      } catch (e) {
        // Column may already exist
      }

      try {
        await connection.query(`ALTER TABLE users ADD COLUMN avatar VARCHAR(500) AFTER phone;`);
      } catch (e) {
        // Column may already exist
      }

      // Profile fields edited from the attendee Personal Info tab (idempotent).
      const profileCols = [
        `ALTER TABLE users ADD COLUMN location VARCHAR(200) AFTER avatar_url;`,
        `ALTER TABLE users ADD COLUMN bio TEXT AFTER location;`,
        `ALTER TABLE users ADD COLUMN date_of_birth DATE AFTER bio;`,
      ];
      for (const colSql of profileCols) {
        try { await connection.query(colSql); } catch (e) { /* existing column */ }
      }

      try {
        await connection.query(`ALTER TABLE users MODIFY COLUMN status VARCHAR(50) NOT NULL DEFAULT 'active';`);
      } catch (e) {
        // Column update
      }

      // Suspension tracking so admins can record why an account was suspended
      // and when (idempotent — same column is a no-op).
      try {
        await connection.query(`ALTER TABLE users ADD COLUMN suspend_reason VARCHAR(500) AFTER status;`);
      } catch (e) {
        // Column may already exist
      }
      try {
        await connection.query(`ALTER TABLE users ADD COLUMN suspended_at DATETIME AFTER suspend_reason;`);
      } catch (e) {
        // Column may already exist
      }

      try {
        await connection.query(`ALTER TABLE password_reset_tokens CHANGE COLUMN token token_hash VARCHAR(64) NOT NULL;`);
      } catch (e) {
        // Column token_hash already exists or token column does not exist
      }

      // Widen the notifications `type` enum so payment/refund/account/system
      // notifications actually persist (idempotent — same enum is a no-op).
      try {
        await connection.query(
          `ALTER TABLE notifications MODIFY COLUMN type ENUM('ticket','reminder','update','price_change','announcement','system','marketing','payment','refund','info','account','withdrawal','support') NOT NULL DEFAULT 'system';`,
        );
      } catch (e) {
        // Column may already include the values
      }

      // Add the 'suspended' event status (idempotent MODIFY — same enum is a no-op).
      try {
        await connection.query(
          `ALTER TABLE events MODIFY COLUMN status ENUM('draft','pending','published','cancelled','completed','rejected','suspended') NOT NULL DEFAULT 'draft';`,
        );
      } catch (e) {
        // Column may already include the value
      }

      // Event wizard fields: visibility (public/private) and tags (JSON array).
      // Idempotent — same column is a no-op on newer installs.
      try {
        await connection.query(
          `ALTER TABLE events ADD COLUMN visibility ENUM('public','private') NOT NULL DEFAULT 'public' AFTER is_featured;`,
        );
      } catch (e) {
        // Column may already exist
      }
      try {
        await connection.query(
          `ALTER TABLE events ADD COLUMN tags JSON AFTER images;`,
        );
      } catch (e) {
        // Column may already exist
      }

      const orgCols = [
        `ALTER TABLE organizer_profiles ADD COLUMN bank_name VARCHAR(150);`,
        `ALTER TABLE organizer_profiles ADD COLUMN account_number VARCHAR(100);`,
        `ALTER TABLE organizer_profiles ADD COLUMN account_name VARCHAR(150);`,
        `ALTER TABLE organizer_profiles ADD COLUMN mobile_money VARCHAR(100);`,
        `ALTER TABLE organizer_profiles ADD COLUMN payout_method VARCHAR(50) DEFAULT 'bank';`,
        `ALTER TABLE organizer_profiles ADD COLUMN primary_color VARCHAR(50) DEFAULT '#D4AF37';`,
        `ALTER TABLE organizer_profiles ADD COLUMN tagline VARCHAR(255);`,
        `ALTER TABLE organizer_profiles ADD COLUMN about TEXT;`,
      ];
      for (const colSql of orgCols) {
        try { await connection.query(colSql); } catch (e) { /* existing column */ }
      }

      // Older installs' system_settings table predates updated_by; bring it in
      // line with schema.sql / ensureSettingsTable (idempotent).
      try {
        await connection.query(
          `ALTER TABLE system_settings ADD COLUMN updated_by BIGINT UNSIGNED DEFAULT NULL;`,
        );
      } catch (e) {
        // Column may already exist
      }

      await connection.query(`
        CREATE TABLE IF NOT EXISTS flash_sales (
          id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
          organizer_id        BIGINT NOT NULL,
          event_id            BIGINT NOT NULL,
          ticket_type_id      BIGINT,
          discount_percentage INT NOT NULL DEFAULT 0,
          starts_at           DATETIME NOT NULL,
          ends_at             DATETIME NOT NULL,
          status              VARCHAR(50) NOT NULL DEFAULT 'active',
          created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          CONSTRAINT fk_fs_organizer FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE,
          CONSTRAINT fk_fs_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      await connection.query(`
        CREATE TABLE IF NOT EXISTS marketing_campaigns (
          id           BIGINT AUTO_INCREMENT PRIMARY KEY,
          organizer_id BIGINT NOT NULL,
          event_id     BIGINT,
          title        VARCHAR(255),
          type         VARCHAR(50) NOT NULL DEFAULT 'email',
          audience     VARCHAR(50) NOT NULL DEFAULT 'all',
          subject      VARCHAR(255),
          message      TEXT,
          sent_count   INT DEFAULT 0,
          created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT fk_mc_organizer FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      // Email verification tokens (one-time, hashed). Schema.sql also
      // declares this table; the IF NOT EXISTS keeps older installs in sync.
      await connection.query(`
        CREATE TABLE IF NOT EXISTS email_verifications (
          id         BIGINT AUTO_INCREMENT PRIMARY KEY,
          user_id    BIGINT NOT NULL,
          token_hash VARCHAR(64) NOT NULL UNIQUE,
          expires_at DATETIME NOT NULL,
          used       BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT fk_ev_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          INDEX idx_ev_user (user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      // Password reset tokens (one-time, hashed) — same pattern as email
      // verifications. Schema.sql also declares this table; the IF NOT EXISTS
      // keeps older installs in sync so forgot/reset-password never 500 on a
      // missing table.
      await connection.query(`
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
          id         BIGINT AUTO_INCREMENT PRIMARY KEY,
          user_id    BIGINT NOT NULL,
          token_hash VARCHAR(64) NOT NULL UNIQUE,
          expires_at DATETIME NOT NULL,
          used       BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT fk_prt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          INDEX idx_prt_user (user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      // Community: organizer follows + event meet-ups (idempotent).
      await connection.query(`
        CREATE TABLE IF NOT EXISTS organizer_follows (
          id            BIGINT AUTO_INCREMENT PRIMARY KEY,
          follower_id   BIGINT NOT NULL,
          organizer_id  BIGINT NOT NULL,
          created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_follow (follower_id, organizer_id),
          CONSTRAINT fk_of_follower FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
          CONSTRAINT fk_of_organizer FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE,
          INDEX idx_of_organizer (organizer_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);
      await connection.query(`
        CREATE TABLE IF NOT EXISTS event_meetups (
          id            BIGINT AUTO_INCREMENT PRIMARY KEY,
          event_id      BIGINT NOT NULL,
          host_id       BIGINT NOT NULL,
          title         VARCHAR(160) NOT NULL,
          description   TEXT,
          meeting_spot  VARCHAR(200),
          meet_at       DATETIME,
          max_members   INT DEFAULT 0,
          is_public     BOOLEAN NOT NULL DEFAULT TRUE,
          created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT fk_em_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
          CONSTRAINT fk_em_host FOREIGN KEY (host_id) REFERENCES users(id) ON DELETE CASCADE,
          INDEX idx_em_event (event_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);
      await connection.query(`
        CREATE TABLE IF NOT EXISTS event_meetup_members (
          id            BIGINT AUTO_INCREMENT PRIMARY KEY,
          meetup_id     BIGINT NOT NULL,
          user_id       BIGINT NOT NULL,
          role          ENUM('host','member') NOT NULL DEFAULT 'member',
          created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_member (meetup_id, user_id),
          CONSTRAINT fk_emm_meetup FOREIGN KEY (meetup_id) REFERENCES event_meetups(id) ON DELETE CASCADE,
          CONSTRAINT fk_emm_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      // Resale marketplace: orders can reference a resale listing so the
      // ticket transfers to the buyer once payment completes.
      try {
        await connection.query(`ALTER TABLE orders ADD COLUMN resale_listing_id BIGINT AFTER paystack_ref;`);
      } catch (e) {
        // Column may already exist
      }

      // Resale marketplace: attendees can list purchased tickets for sale.
      await connection.query(`
        CREATE TABLE IF NOT EXISTS resale_listings (
          id             BIGINT AUTO_INCREMENT PRIMARY KEY,
          ticket_id      BIGINT NOT NULL,
          seller_id      BIGINT NOT NULL,
          event_id       BIGINT NOT NULL,
          ticket_type_id BIGINT NOT NULL,
          price          DECIMAL(12,2) NOT NULL,
          status         ENUM('active','sold','cancelled') NOT NULL DEFAULT 'active',
          sold_to        BIGINT,
          sold_at        DATETIME,
          created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_resale_ticket (ticket_id),
          CONSTRAINT fk_rl_ticket FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
          CONSTRAINT fk_rl_seller FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
          CONSTRAINT fk_rl_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
          CONSTRAINT fk_rl_tt FOREIGN KEY (ticket_type_id) REFERENCES ticket_types(id) ON DELETE CASCADE,
          INDEX idx_rl_event (event_id),
          INDEX idx_rl_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      await connection.query(`
        CREATE TABLE IF NOT EXISTS team_invites (
          id           BIGINT AUTO_INCREMENT PRIMARY KEY,
          organizer_id BIGINT NOT NULL,
          email        VARCHAR(255) NOT NULL,
          role         VARCHAR(50) NOT NULL DEFAULT 'staff',
          permissions  JSON,
          status       VARCHAR(50) NOT NULL DEFAULT 'pending',
          token        VARCHAR(255),
          created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT fk_ti_organizer FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      // ── Auth hardening: server-side refresh tokens, lockout, password history ──
      try {
        await connection.query(`
          CREATE TABLE IF NOT EXISTS refresh_tokens (
            id          BIGINT AUTO_INCREMENT PRIMARY KEY,
            user_id     BIGINT NOT NULL,
            token_hash  VARCHAR(64) NOT NULL UNIQUE,
            family      VARCHAR(36) NOT NULL,
            ip_address  VARCHAR(45),
            user_agent  VARCHAR(300),
            expires_at  DATETIME NOT NULL,
            revoked     BOOLEAN NOT NULL DEFAULT FALSE,
            used        BOOLEAN NOT NULL DEFAULT FALSE,
            last_active DATETIME DEFAULT NULL,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_rt_user    (user_id),
            INDEX idx_rt_hash    (token_hash),
            INDEX idx_rt_family  (family),
            INDEX idx_rt_expires (expires_at)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);
      } catch (e) { console.warn('[migrate] refresh_tokens:', e.message); }
      const authCols = [
        `ALTER TABLE users ADD COLUMN failed_login_attempts INT NOT NULL DEFAULT 0;`,
        `ALTER TABLE users ADD COLUMN locked_until DATETIME NULL DEFAULT NULL;`,
      ];
      for (const colSql of authCols) {
        try { await connection.query(colSql); } catch (e) { /* existing column */ }
      }
      try {
        await connection.query(`
          CREATE TABLE IF NOT EXISTS password_history (
            id             BIGINT AUTO_INCREMENT PRIMARY KEY,
            user_id        BIGINT NOT NULL,
            password_hash  VARCHAR(255) NOT NULL,
            created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_ph_user (user_id)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);
      } catch (e) { console.warn('[migrate] password_history:', e.message); }

      // ── Admin user management: internal notes, activity log ──
      try {
        await connection.query(`
          CREATE TABLE IF NOT EXISTS admin_user_notes (
            id         BIGINT AUTO_INCREMENT PRIMARY KEY,
            user_id    BIGINT NOT NULL,
            admin_id   BIGINT NOT NULL,
            note       TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_aun_user (user_id)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);
      } catch (e) { console.warn('[migrate] admin_user_notes:', e.message); }
      try {
        await connection.query(`
          CREATE TABLE IF NOT EXISTS user_activity_log (
            id          BIGINT AUTO_INCREMENT PRIMARY KEY,
            user_id     BIGINT NOT NULL,
            action      VARCHAR(100) NOT NULL,
            entity_type VARCHAR(50),
            entity_id   BIGINT,
            details     JSON,
            ip_address  VARCHAR(45),
            user_agent  VARCHAR(300),
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_ual_user   (user_id),
            INDEX idx_ual_action (action),
            INDEX idx_ual_created (created_at)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);
      } catch (e) { console.warn('[migrate] user_activity_log:', e.message); }

      // Create the seed admin account ONLY on first run. The password is
      // never reset here — existing credentials are preserved across restarts.
      // (Previously this upsert overwrote the admin password on every boot,
      // which made the default password a permanent backdoor.)
      const bcrypt = (await import('bcryptjs')).default;
      const adminEmail = process.env.ADMIN_EMAIL || 'admin@tribesandcliqs.com';
      const [adminRows] = await connection.query(
        `SELECT id FROM users WHERE role = 'admin' LIMIT 1`,
      );

      if (adminRows.length === 0) {
        const adminPass = process.env.ADMIN_PASSWORD || 'Admin@TC2024';
        if (!process.env.ADMIN_PASSWORD && process.env.NODE_ENV === 'production') {
          console.warn('⚠️ ADMIN_PASSWORD is not set — the seed admin account uses the default password. Set ADMIN_PASSWORD before deploying.');
        }
        const adminHash = await bcrypt.hash(adminPass, 12);
        await connection.query(
          `INSERT INTO users (name, email, password, role, status, is_approved, email_verified)
           VALUES ('System Administrator', ?, ?, 'admin', 'active', TRUE, TRUE);`,
          [adminEmail, adminHash]
        );
        console.log('✅ Seed admin account created.');
      } else {
        console.log('✅ Admin account already exists — skipping seed (password untouched).');
      }

      console.log('✅ Database schema created/updated successfully!');
    } else {
      console.warn('⚠️ schema.sql not found at', schemaPath);
    }
  } catch (err) {
    console.error('❌ Database initialization error:', err.message);
    throw err;
  } finally {
    if (connection) await connection.end();
  }
}

initDb().catch(() => process.exit(1));
