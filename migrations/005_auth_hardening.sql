-- ============================================================
--  Migration 005: Auth Hardening
--  - Refresh token server-side storage + rotation + revocation
--  - Per-account login attempt tracking + lockout
--  - Password history (prevent reuse)
-- ============================================================

SET NAMES utf8mb4;

-- ────────────────  REFRESH TOKENS  ────────────────
-- Server-side storage for refresh tokens. Enables:
--   - Rotation: each refresh issues a new token, old one is burned
--   - Revocation: logout deletes the row, stolen token becomes useless
--   - Family tracking: if a reused token is detected, all family tokens
--     are revoked (token reuse detection = compromised session)
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT NOT NULL,
  token_hash  VARCHAR(64) NOT NULL UNIQUE,
  family      VARCHAR(36) NOT NULL,
  ip_address  VARCHAR(45),
  user_agent  VARCHAR(300),
  expires_at  DATETIME NOT NULL,
  revoked     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_rt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_rt_user    (user_id),
  INDEX idx_rt_hash    (token_hash),
  INDEX idx_rt_family  (family),
  INDEX idx_rt_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  LOGIN ATTEMPTS  ────────────────
-- Per-account brute-force tracking. Separate from the IP-based abuse.js
-- so rotating VPNs can't bypass per-account lockout.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until DATETIME NULL DEFAULT NULL;

-- ────────────────  PASSWORD HISTORY  ────────────────
-- Prevents users from reusing recent passwords.
CREATE TABLE IF NOT EXISTS password_history (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ph_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_ph_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
