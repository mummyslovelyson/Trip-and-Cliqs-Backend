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
  let rewritten = sql.replace(/\?/g, () => `$${++idx}`);
  const flat = params.flat(Infinity);

  const isInsert = /^\s*INSERT\s+INTO\s+/i.test(rewritten);
  const hasReturning = /\bRETURNING\b/i.test(rewritten);
  if (isInsert && !hasReturning) {
    rewritten += ' RETURNING id';
  }

  return { sql: rewritten, params: flat };
}

function formatResult(result) {
  if (!result) return [[], []];

  if (result.command === 'INSERT') {
    const insertId = result.rows?.[0]?.id != null ? Number(result.rows[0].id) : 0;
    const header = {
      insertId,
      affectedRows: result.rowCount || 0,
      fieldCount: 0,
    };
    return [header, result.fields || []];
  }

  if (result.command === 'UPDATE' || result.command === 'DELETE') {
    const header = {
      affectedRows: result.rowCount || 0,
      changedRows: result.rowCount || 0,
      fieldCount: 0,
    };
    return [header, result.fields || []];
  }

  return [result.rows || [], result.fields || []];
}

/**
 * Create a pg Pool with MySQL2-compatible interface.
 *
 * Exposes: query(sql, params), execute(sql, params), getConnection()
 * Both query and execute accept MySQL-style ? placeholders and return
 * [rows, fields] to match the mysql2 API used throughout the codebase.
 */
const isRemoteHost = (host) => host && host !== 'localhost' && host !== '127.0.0.1';

const getPoolConfig = () => {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      max: parseInt(process.env.DB_POOL_MAX, 10) || 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: parseInt(process.env.DB_ACQUIRE_TIMEOUT, 10) || 10000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
      ssl: process.env.DB_SSL === 'false'
        ? false
        : { rejectUnauthorized: false },
    };
  }

  const host = process.env.DB_HOST || '127.0.0.1';
  const useSsl = process.env.DB_SSL === 'true' || isRemoteHost(host);

  return {
    host,
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'tribes_cliqs',
    max: parseInt(process.env.DB_POOL_MAX, 10) || 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: parseInt(process.env.DB_ACQUIRE_TIMEOUT, 10) || 10000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
  };
};

const pool = new pg.Pool(getPoolConfig());

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

pool.on('connect', () => {
  if (process.env.NODE_ENV !== 'production') {
    console.log('[db] New connection acquired');
  }
});

const originalQuery = pool.query.bind(pool);

const isTransientError = (err) => {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  const code = (err.code || '').toLowerCase();
  return (
    msg.includes('connection terminated') ||
    msg.includes('connection timeout') ||
    msg.includes('timeout') ||
    msg.includes('closed') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('broken pipe') ||
    code === '57p01' ||
    code === '57p02' ||
    code === '57p03' ||
    code === '08006' ||
    code === '08001' ||
    code === '08004'
  );
};

const executeWithRetry = async (fn, maxRetries = MAX_RETRIES) => {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries && isTransientError(err)) {
        const delay = Math.min(attempt * 250, 1000);
        console.warn(`[db] Transient connection issue: "${err.message}". Retrying (${attempt}/${maxRetries}) in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
};

/**
 * MySQL2-compatible wrapper: pool.execute(sql, params)
 * Returns [rows, fields] or [header, fields] like mysql2.
 */
pool.execute = async (sql, params) => {
  const { sql: pgSql, params: pgParams } = convertParams(sql, params);
  return executeWithRetry(async () => {
    const result = await originalQuery(pgSql, pgParams);
    return formatResult(result);
  });
};

/**
 * MySQL2-compatible wrapper: pool.query(sql, params)
 * Returns [rows, fields] or [header, fields] like mysql2.
 */
pool.query = async (sql, params) => {
  if (typeof sql === 'string') {
    const { sql: pgSql, params: pgParams } = convertParams(sql, params);
    return executeWithRetry(async () => {
      const result = await originalQuery(pgSql, pgParams);
      return formatResult(result);
    });
  }
  return executeWithRetry(() => originalQuery(sql, params));
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
      return formatResult(result);
    },
    query: async (sql, params) => {
      const { sql: pgSql, params: pgParams } = convertParams(sql, params);
      const result = await client.query(pgSql, pgParams);
      return formatResult(result);
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
