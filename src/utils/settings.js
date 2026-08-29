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

export const getSmsApiKey = async () => {
  const dbKey = await getSetting('smsonlinegh_api_key') || await getSetting('sms_api_key');
  return dbKey || process.env.SMSONLINEGH_API_KEY || process.env.SMS_API_KEY || process.env.SMSONLINE_API_KEY || '';
};

export const getSmsSenderId = async () => {
  const dbSender = await getSetting('smsonlinegh_sender_id') || await getSetting('sms_sender_id');
  return dbSender || process.env.SMSONLINEGH_SENDER_ID || process.env.SMS_SENDER_ID || 'TribesCliqs';
};

export const getEmailConfig = async () => {
  const resendKey = (await getSetting('resend_api_key')) || process.env.RESEND_API_KEY || '';
  const smtpHost = (await getSetting('smtp_host')) || process.env.SMTP_HOST || '';
  const smtpPort = (await getSetting('smtp_port')) || process.env.SMTP_PORT || '587';
  const smtpUser = (await getSetting('smtp_username')) || process.env.SMTP_USER || '';
  const smtpPass = (await getSetting('smtp_password')) || process.env.SMTP_PASS || '';
  const fromEmail = (await getSetting('from_email')) || process.env.FROM_EMAIL || 'no-reply@tribesandcliqs.com';
  const fromName = (await getSetting('from_name')) || process.env.FROM_NAME || 'Tribes & Cliqs';
  return { resendKey, smtpHost, smtpPort, smtpUser, smtpPass, fromEmail, fromName };
};

export default { getSetting, getPaystackSecretKey, getPaystackPublicKey, getSmsApiKey, getSmsSenderId, getEmailConfig };
