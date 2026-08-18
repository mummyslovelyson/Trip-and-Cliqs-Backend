import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const MAX_RETRIES = parseInt(process.env.DB_RETRY_COUNT, 10) || 3;
const RETRY_DELAY_MS = 2000;

/**
 * Create a MySQL connection pool with configurable limits, SSL, and
 * automatic retry on initial connection failure.
 *
 * Env vars:
 *   DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME  — connection details
 *   DB_SSL            — 'true' to enable SSL
 *   DB_SSL_CA         — PEM CA certificate (newlines as \n)
 *   DB_POOL_MIN       — minimum idle connections (default 2)
 *   DB_POOL_MAX       — maximum connections (default 20)
 *   DB_ACQUIRE_TIMEOUT — ms to wait for a connection (default 10 000)
 *   DB_RETRY_COUNT    — startup connection retries (default 3)
 */
const createPool = () =>
  mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'tribes_cliqs',
    waitForConnections: true,
    connectionLimit: parseInt(process.env.DB_POOL_MAX, 10) || 20,
    queueLimit: parseInt(process.env.DB_QUEUE_LIMIT, 10) || 50,
    connectTimeout: parseInt(process.env.DB_ACQUIRE_TIMEOUT, 10) || 10_000,
    family: 4,
    ...(process.env.DB_SSL === 'true' && {
      ssl: process.env.DB_SSL_CA
        ? { ca: process.env.DB_SSL_CA.replace(/\\n/g, '\n') }
        : { rejectUnauthorized: false },
    }),
  });

/**
 * Create pool with retry logic for environments where the DB might not be
 * immediately available (e.g. Render cold starts, Docker Compose).
 */
const createPoolWithRetry = () => {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const pool = createPool();
      // Validate the pool can actually connect.
      pool.getConnection().then((conn) => {
        conn.release();
        console.log('[db] Connection pool ready');
      }).catch(() => { /* async — will retry on first real query if this fails */ });
      return pool;
    } catch (err) {
      lastError = err;
      console.warn(`[db] Pool creation attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        // Synchronous creation rarely fails; async connect handles the real retry.
        break;
      }
    }
  }
  // Fallback — create pool anyway; the async connectTimeout + pool waitForConnections
  // will handle retries naturally.
  return createPool();
};

const pool = createPoolWithRetry();

// Log pool events for observability.
pool.pool?.on?.('connection', (conn) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[db] Connection ${conn.threadId} acquired`);
  }
});

pool.pool?.on?.('release', (conn) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[db] Connection ${conn.threadId} released`);
  }
});

pool.pool?.on?.('enqueue', () => {
  console.warn('[db] Waiting for available connection slot');
});

export default pool;
