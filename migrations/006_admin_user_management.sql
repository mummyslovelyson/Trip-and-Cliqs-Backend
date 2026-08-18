-- ============================================================
--  Migration 006: Admin User Management Power Features
-- ============================================================

SET NAMES utf8mb4;

-- ────────────────  ADMIN NOTES ON USERS  ────────────────
CREATE TABLE IF NOT EXISTS admin_user_notes (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  admin_id   BIGINT NOT NULL,
  note       TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_aun_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_aun_admin FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_aun_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────  USER ACTIVITY LOG  ────────────────
CREATE TABLE IF NOT EXISTS user_activity_log (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  action     VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50),
  entity_id  BIGINT,
  details    JSON,
  ip_address VARCHAR(45),
  user_agent VARCHAR(300),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ual_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_ual_user (user_id),
  INDEX idx_ual_action (action),
  INDEX idx_ual_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
