-- ============================================================
--  Migration 005: Auth Hardening
--  Server-side refresh tokens, token rotation, per-account
--  lockout, password history.
-- ============================================================
SET NAMES utf8mb4;

-- ──── REFRESH TOKENS ────
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
  CONSTRAINT fk_rt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_rt_user    (user_id),
  INDEX idx_rt_hash    (token_hash),
  INDEX idx_rt_family  (family),
  INDEX idx_rt_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ──── LOGIN ATTEMPTS ON USERS ────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until DATETIME NULL DEFAULT NULL;

-- ──── PASSWORD HISTORY ────
CREATE TABLE IF NOT EXISTS password_history (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id        BIGINT NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ph_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_ph_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
