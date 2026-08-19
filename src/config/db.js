import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const MAX_RETRIES = parseInt(process.env.DB_RETRY_COUNT, 10) || 3;

/**
 * Convert MySQL-style ? placeholders to PostgreSQL $1, $2, ... and return
 * the rewritten SQL plus the flat params array (pg doesn't accept nested arrays).
 */
function convertParams(sql, params = []) {
  let idx = 0;
  const rewritten = sql.replace(/\?/g, () => `$${++idx}`);
  const flat = params.flat(Infinity);
  return { sql: rewritten, params: flat };
}

/**
 * Create a pg Pool with MySQL2-compatible interface.
 *
 * Exposes: query(sql, params), execute(sql, params), getConnection()
 * Both query and execute accept MySQL-style ? placeholders and return
 * [rows, fields] to match the mysql2 API used throughout the codebase.
 */
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'tribes_cliqs',
  max: parseInt(process.env.DB_POOL_MAX, 10) || 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: parseInt(process.env.DB_ACQUIRE_TIMEOUT, 10) || 10000,
  ssl: process.env.DB_SSL === 'true'
    ? { rejectUnauthorized: false }
    : false,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

pool.on('connect', () => {
  if (process.env.NODE_ENV !== 'production') {
    console.log('[db] New connection acquired');
  }
});

/**
 * MySQL2-compatible wrapper: pool.execute(sql, params)
 * Returns [rows, fields] like mysql2.
 */
pool.execute = async (sql, params) => {
  const { sql: pgSql, params: pgParams } = convertParams(sql, params);
  const result = await pool.query(pgSql, pgParams);
  return [result.rows, result.fields];
};

/**
 * MySQL2-compatible wrapper: pool.query(sql, params)
 * Returns [rows, fields] like mysql2.
 */
const originalQuery = pool.query.bind(pool);
pool.query = async (sql, params) => {
  if (typeof sql === 'string') {
    const { sql: pgSql, params: pgParams } = convertParams(sql, params);
    const result = await originalQuery(pgSql, pgParams);
    return [result.rows, result.fields];
  }
  return originalQuery(sql, params);
};

/**
 * MySQL2-compatible connection getter for transactions.
 * Returns an object with execute(), beginTransaction(), commit(), rollback(), release().
 */
pool.getConnection = async () => {
  const client = await pool.connect();
  return {
    execute: async (sql, params) => {
      const { sql: pgSql, params: pgParams } = convertParams(sql, params);
      const result = await client.query(pgSql, pgParams);
      return [result.rows, result.fields];
    },
    query: async (sql, params) => {
      const { sql: pgSql, params: pgParams } = convertParams(sql, params);
      const result = await client.query(pgSql, pgParams);
      return [result.rows, result.fields];
    },
    beginTransaction: async () => { await client.query('BEGIN'); },
    commit: async () => { await client.query('COMMIT'); },
    rollback: async () => { await client.query('ROLLBACK'); },
    release: () => { client.release(); },
  };
};

// Validate pool can connect
pool.connect()
  .then((client) => { client.release(); console.log('[db] Connection pool ready (PostgreSQL)'); })
  .catch((err) => { console.warn('[db] Initial connect failed (will retry on first query):', err.message); });

export default pool;
