import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/tribes_cliqs?sslmode=disable',
  ssl: false,
});

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running social tribes migration...');

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_follows (
        id            BIGSERIAL PRIMARY KEY,
        follower_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        following_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uniq_user_follow UNIQUE (follower_id, following_id),
        CONSTRAINT chk_no_self_follow CHECK (follower_id <> following_id)
      );
      CREATE INDEX IF NOT EXISTS idx_uf_follower ON user_follows(follower_id);
      CREATE INDEX IF NOT EXISTS idx_uf_following ON user_follows(following_id);

      CREATE TABLE IF NOT EXISTS event_invites (
        id            BIGSERIAL PRIMARY KEY,
        event_id      BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        sender_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        recipient_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        meetup_id     BIGINT REFERENCES event_meetups(id) ON DELETE SET NULL,
        status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
        note          TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uniq_event_invite UNIQUE (event_id, sender_id, recipient_id)
      );
      CREATE INDEX IF NOT EXISTS idx_ei_recipient ON event_invites(recipient_id);
      CREATE INDEX IF NOT EXISTS idx_ei_event ON event_invites(event_id);

      CREATE TABLE IF NOT EXISTS meetup_messages (
        id            BIGSERIAL PRIMARY KEY,
        meetup_id     BIGINT NOT NULL REFERENCES event_meetups(id) ON DELETE CASCADE,
        user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message       TEXT NOT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_mm_meetup ON meetup_messages(meetup_id);

      CREATE TABLE IF NOT EXISTS event_discussions (
        id          BIGSERIAL PRIMARY KEY,
        event_id    BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message     TEXT NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ed_event ON event_discussions(event_id);
    `);

    console.log('Social tribes migration finished successfully!');
  } catch (err) {
    console.error('Migration error:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
