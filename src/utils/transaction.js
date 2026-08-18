/**
 * Safe transaction wrapper for MySQL connection pool.
 *
 * Acquires a connection, begins a transaction, runs the callback, and
 * commits or rolls back — always releasing the connection regardless of
 * success or failure.
 *
 * Usage:
 *   const result = await withTransaction(async (conn) => {
 *     await conn.execute('INSERT ...', [...]);
 *     await conn.execute('UPDATE ...', [...]);
 *     return someValue;
 *   });
 */

import pool from '../config/db.js';

export const withTransaction = async (fn) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch { /* rollback failed — best effort */ }
    throw err;
  } finally {
    conn.release();
  }
};

export default withTransaction;
