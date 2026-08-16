-- ============================================================
--  Tribes & Cliqs — Event Ticketing & Management System
--  Full MySQL Schema  (MySQL 8.0+)
-- ============================================================

SET FOREIGN_KEY_CHECKS = 0;
SET NAMES utf8mb4;
SET sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION';

-- ────────────────  USERS  ────────────────
CREATE TABLE IF NOT EXISTS users (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(120)  NOT NULL,
  email           VARCHAR(190)  NOT NULL UNIQUE,
  password        VARCHAR(255)  NOT NULL,
  role            ENUM('attendee','organizer','admin') NOT NULL DEFAULT 'attendee',
  phone           VARCHAR(25),
  avatar_url      VARCHAR(500),
  location        VARCHAR(200),
  bio             TEXT,
  date_of_birth   DATE,
  status          ENUM('active','suspended','pending','rejected') NOT NULL DEFAULT 'active',
  suspend_reason  VARCHAR(500),
  suspended_at    DATETIME,
  is_approved     BOOLEAN NOT NULL DEFAULT FALSE,
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at   DATETIME,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_users_role (role),
  INDEX idx_users_status (status),
  INDEX idx_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  ORGANIZER PROFILES  ────────────────
CREATE TABLE IF NOT EXISTS organizer_profiles (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id           BIGINT NOT NULL UNIQUE,
  organization_name VARCHAR(180),
  description       TEXT,
  website           VARCHAR(300),
  logo_url          VARCHAR(500),
  banner_url        VARCHAR(500),
  social_links      JSON,
  is_verified       BOOLEAN NOT NULL DEFAULT FALSE,
  approved_at       DATETIME,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_op_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  CATEGORIES  ────────────────
CREATE TABLE IF NOT EXISTS categories (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  slug        VARCHAR(120) NOT NULL UNIQUE,
  icon        VARCHAR(80),
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INT DEFAULT 0,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  EVENTS  ────────────────
CREATE TABLE IF NOT EXISTS events (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
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
  images         JSON,
  tags           JSON,
  status         ENUM('draft','pending','published','cancelled','completed','rejected','suspended') NOT NULL DEFAULT 'draft',
  is_featured    BOOLEAN NOT NULL DEFAULT FALSE,
  visibility     ENUM('public','private') NOT NULL DEFAULT 'public',
  approval_status ENUM('pending','approved','rejected') DEFAULT 'pending',
  rejection_reason TEXT,
  view_count     INT DEFAULT 0,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_events_org FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_events_cat FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
  INDEX idx_events_status (status),
  INDEX idx_events_category (category),
  INDEX idx_events_org (organizer_id),
  INDEX idx_events_dates (start_date, end_date),
  INDEX idx_events_featured (is_featured)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  TICKET TYPES  ────────────────
CREATE TABLE IF NOT EXISTS ticket_types (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id       BIGINT NOT NULL,
  name           VARCHAR(100) NOT NULL,
  description    TEXT,
  price          DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  quantity       INT NOT NULL DEFAULT 0,
  quantity_sold  INT NOT NULL DEFAULT 0,
  sale_start     DATETIME,
  sale_end       DATETIME,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order     INT DEFAULT 0,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_tt_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  INDEX idx_tt_event (event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  COUPONS / PROMO CODES  ────────────────
CREATE TABLE IF NOT EXISTS coupons (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id       BIGINT,
  organizer_id   BIGINT NOT NULL,
  code           VARCHAR(40) NOT NULL UNIQUE,
  discount_type  ENUM('percentage','fixed') NOT NULL DEFAULT 'percentage',
  discount_value DECIMAL(10,2) NOT NULL,
  max_uses       INT DEFAULT 0,
  used_count     INT NOT NULL DEFAULT 0,
  valid_from     DATETIME,
  valid_to       DATETIME,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_coup_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  CONSTRAINT fk_coup_org FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_coup_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  FLASH SALES  ────────────────
-- Column names match what organizerController reads/writes
-- (discount_percentage, starts_at, ends_at, status).
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
  CONSTRAINT fk_fs_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  CONSTRAINT fs_tt FOREIGN KEY (ticket_type_id) REFERENCES ticket_types(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  ORDERS  ────────────────
CREATE TABLE IF NOT EXISTS orders (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id          BIGINT NOT NULL,
  event_id         BIGINT NOT NULL,
  total_amount     DECIMAL(12,2) NOT NULL,
  discount_amount  DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  coupon_code      VARCHAR(40),
  payment_method   ENUM('mobile_money','visa','mastercard','paypal','apple_pay','google_pay','paystack') NOT NULL DEFAULT 'paystack',
  payment_status   ENUM('pending','completed','failed','refunded','partially_refunded') NOT NULL DEFAULT 'pending',
  payment_reference VARCHAR(100),
  paystack_ref     VARCHAR(100),
  resale_listing_id BIGINT,
  order_status     ENUM('active','cancelled','refunded','completed') NOT NULL DEFAULT 'active',
  cancel_reason    TEXT,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_orders_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  INDEX idx_orders_user (user_id),
  INDEX idx_orders_event (event_id),
  INDEX idx_orders_status (payment_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  ORDER ITEMS  ────────────────
CREATE TABLE IF NOT EXISTS order_items (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_id        BIGINT NOT NULL,
  ticket_type_id  BIGINT NOT NULL,
  quantity        INT NOT NULL,
  unit_price      DECIMAL(12,2) NOT NULL,
  subtotal        DECIMAL(12,2) NOT NULL,
  CONSTRAINT fk_oi_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_oi_tt FOREIGN KEY (ticket_type_id) REFERENCES ticket_types(id) ON DELETE CASCADE,
  INDEX idx_oi_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  TICKETS  (individual digital tickets)  ────────────────
CREATE TABLE IF NOT EXISTS tickets (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_item_id   BIGINT,
  user_id         BIGINT NOT NULL,
  event_id        BIGINT NOT NULL,
  ticket_type_id  BIGINT NOT NULL,
  ticket_number   VARCHAR(60) NOT NULL UNIQUE,
  qr_code         TEXT,
  seat_number     VARCHAR(50),
  status          ENUM('active','used','cancelled','transferred') NOT NULL DEFAULT 'active',
  transferred_to  BIGINT,
  checked_in_at   DATETIME,
  checked_in_by   BIGINT,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_t_oi FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE SET NULL,
  CONSTRAINT fk_t_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_t_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  CONSTRAINT fk_t_tt FOREIGN KEY (ticket_type_id) REFERENCES ticket_types(id) ON DELETE CASCADE,
  INDEX idx_t_user (user_id),
  INDEX idx_t_event (event_id),
  INDEX idx_t_number (ticket_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  FAVORITES  ────────────────
CREATE TABLE IF NOT EXISTS favorites (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  event_id   BIGINT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_fav (user_id, event_id),
  CONSTRAINT fk_fav_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_fav_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  ORGANIZER FOLLOWS  ────────────────
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

-- ────────────────  EVENT MEET-UPS (group outings)  ────────────────
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

-- ────────────────  EVENT MEET-UP MEMBERS  ────────────────
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

-- ────────────────  RESALE LISTINGS  (ticket resale marketplace)  ────────────────
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

-- ────────────────  REVIEWS  ────────────────
CREATE TABLE IF NOT EXISTS reviews (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  event_id   BIGINT NOT NULL,
  rating     TINYINT NOT NULL,
  comment    TEXT,
  is_published BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_rev_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_rev_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  INDEX idx_rev_event (event_id),
  CONSTRAINT chk_rating CHECK (rating BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  NOTIFICATIONS  ────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT,
  title      VARCHAR(200) NOT NULL,
  message    TEXT,
  type       ENUM('ticket','reminder','update','price_change','announcement','system','marketing','payment','refund','info','account','withdrawal','support') NOT NULL DEFAULT 'system',
  is_read    BOOLEAN NOT NULL DEFAULT FALSE,
  link       VARCHAR(300),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_notif_user (user_id),
  INDEX idx_notif_read (is_read)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  WITHDRAWALS  ────────────────
CREATE TABLE IF NOT EXISTS withdrawals (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  organizer_id   BIGINT NOT NULL,
  amount         DECIMAL(12,2) NOT NULL,
  status         ENUM('pending','approved','rejected','paid') NOT NULL DEFAULT 'pending',
  bank_name      VARCHAR(120),
  account_number VARCHAR(40),
  account_name   VARCHAR(150),
  reference      VARCHAR(80),
  processed_at   DATETIME,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_wd_org FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_wd_org (organizer_id),
  INDEX idx_wd_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  WALLET TRANSACTIONS  ────────────────
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  organizer_id  BIGINT NOT NULL,
  type          ENUM('credit','debit','withdrawal','commission') NOT NULL,
  description   VARCHAR(300),
  amount        DECIMAL(12,2) NOT NULL,
  balance_after DECIMAL(12,2),
  reference     VARCHAR(80),
  status        ENUM('pending','completed','failed') NOT NULL DEFAULT 'completed',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_wt_org FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_wt_org (organizer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  SUPPORT TICKETS  ────────────────
CREATE TABLE IF NOT EXISTS support_tickets (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id      BIGINT NOT NULL,
  subject      VARCHAR(200) NOT NULL,
  message      TEXT NOT NULL,
  category     VARCHAR(80),
  priority     ENUM('low','medium','high','urgent') NOT NULL DEFAULT 'medium',
  status       ENUM('open','in_progress','resolved','closed') NOT NULL DEFAULT 'open',
  assigned_to  BIGINT,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_st_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_st_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  SUPPORT REPLIES  ────────────────
CREATE TABLE IF NOT EXISTS support_replies (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  ticket_id       BIGINT NOT NULL,
  user_id         BIGINT NOT NULL,
  message         TEXT NOT NULL,
  is_staff        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sr_ticket FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE,
  CONSTRAINT fk_sr_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  ANNOUNCEMENTS  ────────────────
CREATE TABLE IF NOT EXISTS announcements (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  title        VARCHAR(220) NOT NULL,
  message      TEXT NOT NULL,
  target_role  ENUM('all','attendee','organizer','admin') NOT NULL DEFAULT 'all',
  channel      ENUM('in_app','email','sms','push') NOT NULL DEFAULT 'in_app',
  created_by   BIGINT,
  sent_count   INT DEFAULT 0,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ann_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  TEAM MEMBERS  ────────────────
CREATE TABLE IF NOT EXISTS team_members (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  organizer_id  BIGINT NOT NULL,
  user_id       BIGINT,
  email         VARCHAR(190) NOT NULL,
  role          ENUM('staff','inspector','manager') NOT NULL DEFAULT 'staff',
  permissions   JSON,
  status        ENUM('pending','active','revoked') NOT NULL DEFAULT 'pending',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_tm_org FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_tm_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  HOMEPAGE BANNERS  ────────────────
CREATE TABLE IF NOT EXISTS banners (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  title       VARCHAR(200),
  subtitle    VARCHAR(300),
  image_url   VARCHAR(500),
  link_url    VARCHAR(300),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INT DEFAULT 0,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  FAQS  ────────────────
CREATE TABLE IF NOT EXISTS faqs (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  question    VARCHAR(300) NOT NULL,
  answer      TEXT NOT NULL,
  category    VARCHAR(80) DEFAULT 'General',
  sort_order  INT DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  BLOG POSTS  ────────────────
CREATE TABLE IF NOT EXISTS blog_posts (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  title        VARCHAR(250) NOT NULL,
  slug         VARCHAR(280),
  excerpt      TEXT,
  content      LONGTEXT,
  cover_image  VARCHAR(500),
  author_id    BIGINT,
  status       ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  published_at DATETIME,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_bp_author FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  PAYMENTS  (platform-level transaction log)  ────────────────
CREATE TABLE IF NOT EXISTS payments (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_id        BIGINT,
  user_id         BIGINT NOT NULL,
  event_id        BIGINT,
  organizer_id    BIGINT,
  amount          DECIMAL(12,2) NOT NULL,
  commission      DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  net_to_organizer DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  method          VARCHAR(40),
  reference       VARCHAR(100),
  status          ENUM('pending','completed','failed','refunded') NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pay_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
  CONSTRAINT fk_pay_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_pay_status (status),
  INDEX idx_pay_event (event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  REFUNDS  ────────────────
CREATE TABLE IF NOT EXISTS refunds (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_id        BIGINT NOT NULL,
  user_id         BIGINT NOT NULL,
  amount          DECIMAL(12,2) NOT NULL,
  reason          TEXT,
  status          ENUM('pending','approved','rejected','processed') NOT NULL DEFAULT 'pending',
  processed_by    BIGINT,
  processed_at    DATETIME,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ref_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_ref_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  AUDIT LOGS  ────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id      BIGINT,
  action       VARCHAR(100) NOT NULL,
  entity_type  VARCHAR(60),
  entity_id    BIGINT,
  details      JSON,
  ip_address   VARCHAR(45),
  user_agent   VARCHAR(300),
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_audit_user (user_id),
  INDEX idx_audit_action (action),
  INDEX idx_audit_entity (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  SYSTEM SETTINGS  ────────────────
CREATE TABLE IF NOT EXISTS system_settings (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  setting_key   VARCHAR(100) NOT NULL UNIQUE,
  setting_value TEXT,
  category      VARCHAR(60) DEFAULT 'general',
  updated_by    BIGINT UNSIGNED DEFAULT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  NOTIFICATION TEMPLATES  ────────────────
CREATE TABLE IF NOT EXISTS notification_templates (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(120) NOT NULL,
  subject    VARCHAR(200),
  body       TEXT,
  type       ENUM('email','sms','push','in_app') NOT NULL DEFAULT 'email',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  MARKETING CAMPAIGNS  ────────────────
-- Column names match what organizerController reads/writes
-- (title, type, audience, sent_count).
CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  organizer_id  BIGINT NOT NULL,
  event_id      BIGINT,
  title         VARCHAR(255),
  type          VARCHAR(50) NOT NULL DEFAULT 'email',
  audience      VARCHAR(50) NOT NULL DEFAULT 'all',
  subject       VARCHAR(255),
  message       TEXT,
  sent_count    INT DEFAULT 0,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_mc_organizer FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_mc_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  USER SAVED PAYMENT METHODS  ────────────────
CREATE TABLE IF NOT EXISTS user_payment_methods (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT NOT NULL,
  type          ENUM('mobile_money','card') NOT NULL,
  provider      VARCHAR(60),
  last4         VARCHAR(4),
  is_default    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_upm_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  NOTIFICATION PREFERENCES  ────────────────
CREATE TABLE IF NOT EXISTS notification_preferences (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         BIGINT NOT NULL UNIQUE,
  email_tickets   BOOLEAN DEFAULT TRUE,
  email_reminders BOOLEAN DEFAULT TRUE,
  email_offers    BOOLEAN DEFAULT TRUE,
  sms_tickets     BOOLEAN DEFAULT TRUE,
  sms_reminders   BOOLEAN DEFAULT TRUE,
  push_enabled    BOOLEAN DEFAULT TRUE,
  CONSTRAINT fk_np_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  PASSWORD RESET TOKENS  ────────────────
-- Tokens are stored as SHA-256 hashes (token_hash); only the raw token is
-- ever emailed to the user. Single-use via the `used` flag.
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

-- ────────────────  EMAIL VERIFICATION TOKENS  ────────────────
-- One-time tokens emailed at registration; hashed at rest like password
-- reset tokens. `used` flips to TRUE after the account is verified.
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

-- ────────────────  TEAM INVITES  ────────────────
-- Pending invitations from organizers to join their team. A user who accepts
-- is added to team_members (or matched by email at accept time).
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

-- ────────────────  ACTIVE SESSIONS  ────────────────
CREATE TABLE IF NOT EXISTS user_sessions (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id      BIGINT NOT NULL,
  token_hash   VARCHAR(255) NOT NULL,
  ip_address   VARCHAR(45),
  device       VARCHAR(200),
  last_active  DATETIME,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_us_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  PLATFORM COMMISSION SETTINGS  ────────────────
CREATE TABLE IF NOT EXISTS platform_commissions (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  commission_pct    DECIMAL(5,2) NOT NULL DEFAULT 5.00,
  currency          VARCHAR(10) DEFAULT 'GHS',
  updated_by        BIGINT,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;

