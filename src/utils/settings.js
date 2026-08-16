import pool from '../config/db.js';

// Lazily-loaded system settings with a short TTL so admin dashboard changes
// (e.g. Paystack keys) take effect without a server restart, while avoiding a
// DB hit on every payment call.
const cache = new Map();
let lastFetch = 0;
const TTL = 60_000; // 1 minute

export const getSetting = async (key) => {
  const now = Date.now();
  if (now - lastFetch > TTL) {
    try {
      const [rows] = await pool.execute(
        `SELECT setting_key, setting_value FROM system_settings`,
      );
      cache.clear();
      for (const r of rows) cache.set(r.setting_key, r.setting_value);
      lastFetch = now;
    } catch {
      // system_settings may not exist yet (fresh install / no admin visit).
      // Fall back to whatever the env provides.
    }
  }
  return cache.get(key) ?? null;
};

export const getPaystackSecretKey = async () => {
  const dbKey = await getSetting('paystack_secret_key');
  return dbKey || process.env.PAYSTACK_SECRET_KEY || '';
};

export const getPaystackPublicKey = async () => {
  const dbKey = await getSetting('paystack_public_key');
  return dbKey || process.env.PAYSTACK_PUBLIC_KEY || '';
};

export default { getSetting, getPaystackSecretKey, getPaystackPublicKey };
