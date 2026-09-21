import pool from './db.js';

async function setup() {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS bot_conversations (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT,
        user_name VARCHAR(150),
        user_email VARCHAR(150),
        session_id VARCHAR(100),
        mode VARCHAR(20) NOT NULL DEFAULT 'chat',
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        intent VARCHAR(50),
        page_path VARCHAR(255),
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT fk_bot_conv_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    await pool.execute(`
      CREATE INDEX IF NOT EXISTS idx_bot_conv_created ON bot_conversations(created_at DESC)
    `);

    await pool.execute(`
      CREATE INDEX IF NOT EXISTS idx_bot_conv_mode ON bot_conversations(mode)
    `);

    console.log('[setupChatLogs] bot_conversations table and indexes ready');
    process.exit(0);
  } catch (err) {
    console.error('[setupChatLogs] error:', err);
    process.exit(1);
  }
}

setup();
