-- ============================================================
--  Tribes & Cliqs — Event Ticketing & Management System
--  Full PostgreSQL Schema
-- ============================================================

-- ────────────────  USERS  ────────────────
CREATE TABLE IF NOT EXISTS users (
  id              BIGSERIAL PRIMARY KEY,
  name            VARCHAR(120)  NOT NULL,
  email           VARCHAR(190)  NOT NULL UNIQUE,
  password        VARCHAR(255)  NOT NULL,
  role            TEXT NOT NULL DEFAULT 'attendee' CHECK (role IN ('attendee','organizer','admin','system_admin','superadmin','staff')),
  phone           VARCHAR(25),
  avatar_url      VARCHAR(500),
  avatar          VARCHAR(500),
  location        VARCHAR(200),
  bio             TEXT,
  date_of_birth   DATE,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','pending','rejected')),
  suspend_reason  VARCHAR(500),
  suspended_at    TIMESTAMPTZ,
  is_approved     BOOLEAN NOT NULL DEFAULT FALSE,
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  failed_login_attempts INT NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ────────────────  ORGANIZER PROFILES  ────────────────
CREATE TABLE IF NOT EXISTS organizer_profiles (
  id                BIGSERIAL PRIMARY KEY,
  user_id           BIGINT NOT NULL UNIQUE,
  organization_name VARCHAR(180),
  description       TEXT,
  website           VARCHAR(300),
  logo_url          VARCHAR(500),
  banner_url        VARCHAR(500),
  social_links      jsonb,
  is_verified       BOOLEAN NOT NULL DEFAULT FALSE,
  approved_at       TIMESTAMPTZ,
  bank_name         VARCHAR(150),
  account_number    VARCHAR(100),
  account_name      VARCHAR(150),
  mobile_money      VARCHAR(100),
  payout_method     VARCHAR(50) DEFAULT 'bank',
  primary_color     VARCHAR(50) DEFAULT '#D4AF37',
  tagline           VARCHAR(255),
  about             TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_op_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ────────────────  CATEGORIES  ────────────────
CREATE TABLE IF NOT EXISTS categories (
  id          BIGSERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  slug        VARCHAR(120) NOT NULL UNIQUE,
  icon        VARCHAR(80),
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────  EVENTS  ────────────────
CREATE TABLE IF NOT EXISTS events (
  id             BIGSERIAL PRIMARY KEY,
  organizer_id   BIGINT NOT NULL,
  category_id    BIGINT,
  title          VARCHAR(220) NOT NULL,
  slug           VARCHAR(260),
  description    TEXT,
  category       VARCHAR(80),
  venue          VARCHAR(200),
  address        VARCHAR(300),
  city           VARCHAR(120),
  country        VARCHAR(100) DEFAULT 'Ghana',
  latitude       DECIMAL(10,7),
  longitude      DECIMAL(10,7),
  start_date     DATE NOT NULL,
  end_date       DATE,
  start_time     TIME,
  end_time       TIME,
  capacity       INT NOT NULL DEFAULT 0,
  dress_code     VARCHAR(200),
  contact_email  VARCHAR(190),
  contact_phone  VARCHAR(30),
  banner_image   VARCHAR(500),
  ticket_template VARCHAR(500),
  images         jsonb,
  tags           jsonb,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','published','cancelled','completed','rejected','suspended')),
  is_featured    BOOLEAN NOT NULL DEFAULT FALSE,
  visibility     TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  approval_status TEXT DEFAULT 'pending' CHECK (approval_status IN ('pending','approved','rejected')),
  rejection_reason TEXT,
  view_count     INT DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_events_org FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_events_cat FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
CREATE INDEX IF NOT EXISTS idx_events_org ON events(organizer_id);
CREATE INDEX IF NOT EXISTS idx_events_dates ON events(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_events_featured ON events(is_featured);

-- ────────────────  TICKET TYPES  ────────────────
CREATE TABLE IF NOT EXISTS ticket_types (
  id             BIGSERIAL PRIMARY KEY,
  event_id       BIGINT NOT NULL,
  name           VARCHAR(100) NOT NULL,
  description    TEXT,
  price          DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  quantity       INT NOT NULL DEFAULT 0,
  quantity_sold  INT NOT NULL DEFAULT 0,
  sale_start     TIMESTAMPTZ,
  sale_end       TIMESTAMPTZ,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order     INT DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_tt_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tt_event ON ticket_types(event_id);

-- ────────────────  COUPONS / PROMO CODES  ────────────────
CREATE TABLE IF NOT EXISTS coupons (
  id             BIGSERIAL PRIMARY KEY,
  event_id       BIGINT,
  organizer_id   BIGINT NOT NULL,
  code           VARCHAR(40) NOT NULL UNIQUE,
  discount_type  TEXT NOT NULL DEFAULT 'percentage' CHECK (discount_type IN ('percentage','fixed')),
  discount_value DECIMAL(10,2) NOT NULL,
  max_uses       INT DEFAULT 0,
  used_count     INT NOT NULL DEFAULT 0,
  valid_from     TIMESTAMPTZ,
  valid_to       TIMESTAMPTZ,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_coup_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  CONSTRAINT fk_coup_org FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_coup_code ON coupons(code);

-- ────────────────  FLASH SALES  ────────────────
CREATE TABLE IF NOT EXISTS flash_sales (
  id                  BIGSERIAL PRIMARY KEY,
  organizer_id        BIGINT NOT NULL,
  event_id            BIGINT NOT NULL,
  ticket_type_id      BIGINT,
  discount_percentage INT NOT NULL DEFAULT 0,
  starts_at           TIMESTAMPTZ NOT NULL,
  ends_at             TIMESTAMPTZ NOT NULL,
  status              VARCHAR(50) NOT NULL DEFAULT 'active',
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_fs_organizer FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_fs_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  CONSTRAINT fs_tt FOREIGN KEY (ticket_type_id) REFERENCES ticket_types(id) ON DELETE CASCADE
);

-- ────────────────  ORDERS  ────────────────
CREATE TABLE IF NOT EXISTS orders (
  id               BIGSERIAL PRIMARY KEY,
  user_id          BIGINT NOT NULL,
  event_id         BIGINT NOT NULL,
  total_amount     DECIMAL(12,2) NOT NULL,
  discount_amount  DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  coupon_code      VARCHAR(40),
  payment_method   TEXT NOT NULL DEFAULT 'paystack' CHECK (payment_method IN ('mobile_money','visa','mastercard','paypal','apple_pay','google_pay','paystack')),
  payment_status   TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','completed','failed','refunded','partially_refunded')),
  payment_reference VARCHAR(100),
  paystack_ref     VARCHAR(100),
  resale_listing_id BIGINT,
  order_status     TEXT NOT NULL DEFAULT 'active' CHECK (order_status IN ('active','cancelled','refunded','completed')),
  cancel_reason    TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_orders_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_event ON orders(event_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(payment_status);

-- ────────────────  ORDER ITEMS  ────────────────
CREATE TABLE IF NOT EXISTS order_items (
  id              BIGSERIAL PRIMARY KEY,
  order_id        BIGINT NOT NULL,
  ticket_type_id  BIGINT NOT NULL,
  quantity        INT NOT NULL,
  unit_price      DECIMAL(12,2) NOT NULL,
  subtotal        DECIMAL(12,2) NOT NULL,
  CONSTRAINT fk_oi_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_oi_tt FOREIGN KEY (ticket_type_id) REFERENCES ticket_types(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_oi_order ON order_items(order_id);

-- ────────────────  TICKETS  (individual digital tickets)  ────────────────
CREATE TABLE IF NOT EXISTS tickets (
  id              BIGSERIAL PRIMARY KEY,
  order_item_id   BIGINT,
  user_id         BIGINT NOT NULL,
  event_id        BIGINT NOT NULL,
  ticket_type_id  BIGINT NOT NULL,
  ticket_number   VARCHAR(60) NOT NULL UNIQUE,
  qr_code         TEXT,
  seat_number     VARCHAR(50),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','cancelled','transferred')),
  transferred_to  BIGINT,
  checked_in_at   TIMESTAMPTZ,
  checked_in_by   BIGINT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_t_oi FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE SET NULL,
  CONSTRAINT fk_t_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_t_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  CONSTRAINT fk_t_tt FOREIGN KEY (ticket_type_id) REFERENCES ticket_types(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_t_user ON tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_t_event ON tickets(event_id);
CREATE INDEX IF NOT EXISTS idx_t_number ON tickets(ticket_number);

-- ────────────────  FAVORITES  ────────────────
CREATE TABLE IF NOT EXISTS favorites (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  event_id   BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uniq_fav UNIQUE (user_id, event_id),
  CONSTRAINT fk_fav_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_fav_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

-- ────────────────  ORGANIZER FOLLOWS  ────────────────
CREATE TABLE IF NOT EXISTS organizer_follows (
  id            BIGSERIAL PRIMARY KEY,
  follower_id   BIGINT NOT NULL,
  organizer_id  BIGINT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uniq_follow UNIQUE (follower_id, organizer_id),
  CONSTRAINT fk_of_follower FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_of_organizer FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_of_organizer ON organizer_follows(organizer_id);

-- ────────────────  EVENT MEET-UPS (group outings)  ────────────────
CREATE TABLE IF NOT EXISTS event_meetups (
  id            BIGSERIAL PRIMARY KEY,
  event_id      BIGINT NOT NULL,
  host_id       BIGINT NOT NULL,
  title         VARCHAR(160) NOT NULL,
  description   TEXT,
  meeting_spot  VARCHAR(200),
  meet_at       TIMESTAMPTZ,
  max_members   INT DEFAULT 0,
  is_public     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_em_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  CONSTRAINT fk_em_host FOREIGN KEY (host_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_em_event ON event_meetups(event_id);

-- ────────────────  EVENT MEET-UP MEMBERS  ────────────────
CREATE TABLE IF NOT EXISTS event_meetup_members (
  id            BIGSERIAL PRIMARY KEY,
  meetup_id     BIGINT NOT NULL,
  user_id       BIGINT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('host','member')),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uniq_member UNIQUE (meetup_id, user_id),
  CONSTRAINT fk_emm_meetup FOREIGN KEY (meetup_id) REFERENCES event_meetups(id) ON DELETE CASCADE,
  CONSTRAINT fk_emm_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ────────────────  RESALE LISTINGS  (ticket resale marketplace)  ────────────────
CREATE TABLE IF NOT EXISTS resale_listings (
  id             BIGSERIAL PRIMARY KEY,
  ticket_id      BIGINT NOT NULL,
  seller_id      BIGINT NOT NULL,
  event_id       BIGINT NOT NULL,
  ticket_type_id BIGINT NOT NULL,
  price          DECIMAL(12,2) NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','sold','cancelled')),
  sold_to        BIGINT,
  sold_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uniq_resale_ticket UNIQUE (ticket_id),
  CONSTRAINT fk_rl_ticket FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  CONSTRAINT fk_rl_seller FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_rl_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  CONSTRAINT fk_rl_tt FOREIGN KEY (ticket_type_id) REFERENCES ticket_types(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rl_event ON resale_listings(event_id);
CREATE INDEX IF NOT EXISTS idx_rl_status ON resale_listings(status);

-- ────────────────  REVIEWS  ────────────────
CREATE TABLE IF NOT EXISTS reviews (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  event_id   BIGINT NOT NULL,
  rating     SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment    TEXT,
  is_published BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_rev_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_rev_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rev_event ON reviews(event_id);

-- ────────────────  NOTIFICATIONS  ────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT,
  title      VARCHAR(200) NOT NULL,
  message    TEXT,
  type       TEXT NOT NULL DEFAULT 'system' CHECK (type IN ('ticket','reminder','update','price_change','announcement','system','marketing','payment','refund','info','account','withdrawal','support')),
  is_read    BOOLEAN NOT NULL DEFAULT FALSE,
  link       VARCHAR(300),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notif_read ON notifications(is_read);

-- ────────────────  WITHDRAWALS  ────────────────
CREATE TABLE IF NOT EXISTS withdrawals (
  id             BIGSERIAL PRIMARY KEY,
  organizer_id   BIGINT NOT NULL,
  amount         DECIMAL(12,2) NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','paid')),
  bank_name      VARCHAR(120),
  account_number VARCHAR(40),
  account_name   VARCHAR(150),
  reference      VARCHAR(80),
  rejection_reason VARCHAR(255),
  notes          TEXT,
  processed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_wd_org FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wd_org ON withdrawals(organizer_id);
CREATE INDEX IF NOT EXISTS idx_wd_status ON withdrawals(status);

-- ────────────────  WALLET TRANSACTIONS  ────────────────
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id            BIGSERIAL PRIMARY KEY,
  organizer_id  BIGINT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('credit','debit','withdrawal','commission')),
  description   VARCHAR(300),
  amount        DECIMAL(12,2) NOT NULL,
  balance_after DECIMAL(12,2),
  reference     VARCHAR(80),
  status        TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending','completed','failed')),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_wt_org FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wt_org ON wallet_transactions(organizer_id);

-- ────────────────  SUPPORT TICKETS  ────────────────
CREATE TABLE IF NOT EXISTS support_tickets (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL,
  subject      VARCHAR(200) NOT NULL,
  message      TEXT NOT NULL,
  category     VARCHAR(80),
  priority     TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  assigned_to  BIGINT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_st_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_st_status ON support_tickets(status);

-- ────────────────  SUPPORT REPLIES  ────────────────
CREATE TABLE IF NOT EXISTS support_replies (
  id              BIGSERIAL PRIMARY KEY,
  ticket_id       BIGINT NOT NULL,
  user_id         BIGINT NOT NULL,
  message         TEXT NOT NULL,
  is_staff        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_sr_ticket FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE,
  CONSTRAINT fk_sr_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ────────────────  ANNOUNCEMENTS  ────────────────
CREATE TABLE IF NOT EXISTS announcements (
  id           BIGSERIAL PRIMARY KEY,
  title        VARCHAR(220) NOT NULL,
  message      TEXT NOT NULL,
  target_role  TEXT NOT NULL DEFAULT 'all' CHECK (target_role IN ('all','attendee','organizer','admin')),
  channel      TEXT NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app','email','sms','push')),
  created_by   BIGINT,
  sent_count   INT DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_ann_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- ────────────────  TEAM MEMBERS  ────────────────
CREATE TABLE IF NOT EXISTS team_members (
  id            BIGSERIAL PRIMARY KEY,
  organizer_id  BIGINT NOT NULL,
  user_id       BIGINT,
  email         VARCHAR(190) NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('staff','inspector','manager')),
  permissions   jsonb,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','revoked')),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_tm_org FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_tm_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- ────────────────  HOMEPAGE BANNERS  ────────────────
CREATE TABLE IF NOT EXISTS banners (
  id          BIGSERIAL PRIMARY KEY,
  title       VARCHAR(200),
  subtitle    VARCHAR(300),
  image_url   VARCHAR(500),
  link_url    VARCHAR(300),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────  FAQS  ────────────────
CREATE TABLE IF NOT EXISTS faqs (
  id          BIGSERIAL PRIMARY KEY,
  question    VARCHAR(300) NOT NULL,
  answer      TEXT NOT NULL,
  category    VARCHAR(80) DEFAULT 'General',
  sort_order  INT DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────  BLOG POSTS  ────────────────
CREATE TABLE IF NOT EXISTS blog_posts (
  id           BIGSERIAL PRIMARY KEY,
  title        VARCHAR(250) NOT NULL,
  slug         VARCHAR(280),
  excerpt      TEXT,
  content      TEXT,
  cover_image  VARCHAR(500),
  author_id    BIGINT,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  published_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_bp_author FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
);

-- ────────────────  PAYMENTS  (platform-level transaction log)  ────────────────
CREATE TABLE IF NOT EXISTS payments (
  id              BIGSERIAL PRIMARY KEY,
  order_id        BIGINT,
  user_id         BIGINT NOT NULL,
  event_id        BIGINT,
  organizer_id    BIGINT,
  amount          DECIMAL(12,2) NOT NULL,
  commission      DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  net_to_organizer DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  method          VARCHAR(40),
  reference       VARCHAR(100),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','refunded')),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_pay_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
  CONSTRAINT fk_pay_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pay_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_pay_event ON payments(event_id);

-- ────────────────  REFUNDS  ────────────────
CREATE TABLE IF NOT EXISTS refunds (
  id              BIGSERIAL PRIMARY KEY,
  order_id        BIGINT NOT NULL,
  user_id         BIGINT NOT NULL,
  amount          DECIMAL(12,2) NOT NULL,
  reason          TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','processed')),
  processed_by    BIGINT,
  processed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_ref_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_ref_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ────────────────  AUDIT LOGS  ────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT,
  action       VARCHAR(100) NOT NULL,
  entity_type  VARCHAR(60),
  entity_id    BIGINT,
  details      jsonb,
  ip_address   VARCHAR(45),
  user_agent   VARCHAR(300),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);

-- ────────────────  SYSTEM SETTINGS  ────────────────
CREATE TABLE IF NOT EXISTS system_settings (
  id            BIGSERIAL PRIMARY KEY,
  setting_key   VARCHAR(100) NOT NULL UNIQUE,
  setting_value TEXT,
  category      VARCHAR(60) DEFAULT 'general',
  updated_by    BIGINT DEFAULT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────  AI TRAINING KNOWLEDGE  ────────────────
CREATE TABLE IF NOT EXISTS ai_training_knowledge (
  id                      BIGSERIAL PRIMARY KEY,
  title                   VARCHAR(255) NOT NULL,
  category                VARCHAR(100) NOT NULL DEFAULT 'faq',
  keywords                TEXT,
  instruction_or_answer   TEXT NOT NULL,
  is_active               BOOLEAN DEFAULT TRUE,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_atk_category ON ai_training_knowledge(category);
CREATE INDEX IF NOT EXISTS idx_atk_active ON ai_training_knowledge(is_active);

-- ────────────────  NOTIFICATION TEMPLATES  ────────────────
CREATE TABLE IF NOT EXISTS notification_templates (
  id         BIGSERIAL PRIMARY KEY,
  name       VARCHAR(120) NOT NULL,
  subject    VARCHAR(200),
  body       TEXT,
  type       TEXT NOT NULL DEFAULT 'email' CHECK (type IN ('email','sms','push','in_app')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────  MARKETING CAMPAIGNS  ────────────────
CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id            BIGSERIAL PRIMARY KEY,
  organizer_id  BIGINT NOT NULL,
  event_id      BIGINT,
  title         VARCHAR(255),
  type          VARCHAR(50) NOT NULL DEFAULT 'email',
  audience      VARCHAR(50) NOT NULL DEFAULT 'all',
  subject       VARCHAR(255),
  message       TEXT,
  sent_count    INT DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_mc_organizer FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_mc_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL
);

-- ────────────────  USER SAVED PAYMENT METHODS  ────────────────
CREATE TABLE IF NOT EXISTS user_payment_methods (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('mobile_money','card')),
  provider      VARCHAR(60),
  last4         VARCHAR(4),
  is_default    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_upm_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ────────────────  NOTIFICATION PREFERENCES  ────────────────
CREATE TABLE IF NOT EXISTS notification_preferences (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL UNIQUE,
  email_tickets   BOOLEAN DEFAULT TRUE,
  email_reminders BOOLEAN DEFAULT TRUE,
  email_offers    BOOLEAN DEFAULT TRUE,
  sms_tickets     BOOLEAN DEFAULT TRUE,
  sms_reminders   BOOLEAN DEFAULT TRUE,
  push_enabled    BOOLEAN DEFAULT TRUE,
  CONSTRAINT fk_np_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ────────────────  PASSWORD RESET TOKENS  ────────────────
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_prt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_prt_user ON password_reset_tokens(user_id);

-- ────────────────  EMAIL VERIFICATION TOKENS  ────────────────
CREATE TABLE IF NOT EXISTS email_verifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  token_hash VARCHAR(128) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_ev_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ev_user ON email_verifications(user_id);

-- ────────────────  PENDING REGISTRATIONS (PRE-VERIFICATION)  ────────────────
CREATE TABLE IF NOT EXISTS pending_registrations (
  id                BIGSERIAL PRIMARY KEY,
  registration_id   VARCHAR(64) NOT NULL UNIQUE,
  name              VARCHAR(120) NOT NULL,
  email             VARCHAR(190) NOT NULL,
  phone             VARCHAR(50),
  password_hash     VARCHAR(255) NOT NULL,
  role              VARCHAR(50) NOT NULL DEFAULT 'attendee',
  organization_name VARCHAR(180),
  otp_hash          VARCHAR(128) NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pr_email ON pending_registrations(email);
CREATE INDEX IF NOT EXISTS idx_pr_phone ON pending_registrations(phone);
CREATE INDEX IF NOT EXISTS idx_pr_reg_id ON pending_registrations(registration_id);

-- ────────────────  TEAM INVITES  ────────────────
CREATE TABLE IF NOT EXISTS team_invites (
  id           BIGSERIAL PRIMARY KEY,
  organizer_id BIGINT NOT NULL,
  email        VARCHAR(255) NOT NULL,
  role         VARCHAR(50) NOT NULL DEFAULT 'staff',
  permissions  jsonb,
  status       VARCHAR(50) NOT NULL DEFAULT 'pending',
  token        VARCHAR(255),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_ti_organizer FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ────────────────  ACTIVE SESSIONS  ────────────────
CREATE TABLE IF NOT EXISTS user_sessions (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL,
  token_hash   VARCHAR(255) NOT NULL,
  ip_address   VARCHAR(45),
  device       VARCHAR(200),
  last_active  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_us_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ────────────────  PLATFORM COMMISSION SETTINGS  ────────────────
CREATE TABLE IF NOT EXISTS platform_commissions (
  id                BIGSERIAL PRIMARY KEY,
  commission_pct    DECIMAL(5,2) NOT NULL DEFAULT 5.00,
  currency          VARCHAR(10) DEFAULT 'GHS',
  updated_by        BIGINT,
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────  REFRESH TOKENS (auth hardening)  ────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL,
  token_hash  VARCHAR(64) NOT NULL UNIQUE,
  family      VARCHAR(36) NOT NULL,
  ip_address  VARCHAR(45),
  user_agent  VARCHAR(300),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked     BOOLEAN NOT NULL DEFAULT FALSE,
  used        BOOLEAN NOT NULL DEFAULT FALSE,
  last_active TIMESTAMPTZ DEFAULT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rt_user    ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_rt_hash    ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_rt_family  ON refresh_tokens(family);
CREATE INDEX IF NOT EXISTS idx_rt_expires ON refresh_tokens(expires_at);

-- ────────────────  PASSWORD HISTORY  ────────────────
CREATE TABLE IF NOT EXISTS password_history (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ph_user ON password_history(user_id);

-- ────────────────  ADMIN USER NOTES  ────────────────
CREATE TABLE IF NOT EXISTS admin_user_notes (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  admin_id   BIGINT NOT NULL,
  note       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aun_user ON admin_user_notes(user_id);

-- ────────────────  USER ACTIVITY LOG  ────────────────
CREATE TABLE IF NOT EXISTS user_activity_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL,
  action      VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50),
  entity_id   BIGINT,
  details     jsonb,
  ip_address  VARCHAR(45),
  user_agent  VARCHAR(300),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ual_user    ON user_activity_log(user_id);
CREATE INDEX IF NOT EXISTS idx_ual_action  ON user_activity_log(action);
CREATE INDEX IF NOT EXISTS idx_ual_created ON user_activity_log(created_at);

-- ────────────────  updated_at TRIGGER  ────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'users', 'organizer_profiles', 'categories', 'events', 'ticket_types',
      'orders', 'tickets', 'reviews', 'support_tickets', 'faqs', 'blog_posts',
      'system_settings', 'flash_sales', 'marketing_campaigns', 'admin_user_notes'
    ])
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = tbl AND column_name = 'updated_at') THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated_at ON %I;', tbl, tbl);
      EXECUTE format(
        'CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();',
        tbl, tbl
      );
    END IF;
  END LOOP;
END $$;
