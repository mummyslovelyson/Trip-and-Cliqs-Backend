/**
 * Paystack payment helpers.
 * Docs: https://paystack.com/docs/api
 *
 * Uses native fetch and the PAYSTACK_SECRET_KEY. The key is resolved from the
 * system_settings table (configured in the admin dashboard) with the
 * environment variable as a fallback, so admins can switch test/live keys
 * without editing .env.
 */

import { getPaystackSecretKey } from './settings.js';

const BASE_URL = 'https://api.paystack.co';

const headers = (secretKey) => ({
  Authorization: `Bearer ${secretKey}`,
  'Content-Type': 'application/json',
});

/**
 * Initialise a transaction. Returns the authorization URL the client should
 * be redirected to in order to complete payment.
 *
 * @param {{ email: string, amount: number, reference: string, callback_url?: string, metadata?: object }} params
 * @returns {Promise<{ status: boolean, data?: any, error?: string }>}
 */
export const initializeTransaction = async ({
  email,
  amount,
  reference,
  callback_url,
  currency,
  channels,
  metadata,
}) => {
  const secretKey = await getPaystackSecretKey();
  if (!secretKey) {
    return { status: false, error: 'Paystack secret key not configured. Please set PAYSTACK_SECRET_KEY in system settings or .env' };
  }

  try {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const response = await fetch(`${BASE_URL}/transaction/initialize`, {
      method: 'POST',
      headers: headers(secretKey),
      body: JSON.stringify({
        email,
        amount: Math.round(amount * 100), // Paystack expects minor units (pesewas/kobo)
        reference,
        currency: currency || process.env.PAYSTACK_CURRENCY || 'GHS',
        channels: channels || ['card', 'mobile_money', 'bank', 'ussd', 'qr', 'eft'],
        callback_url: callback_url || `${frontendUrl}/payment/callback`,
        metadata: metadata || {},
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.status) {
      return { status: false, error: data.message || `HTTP ${response.status}` };
    }

    return { status: true, data: data.data };
  } catch (err) {
    console.error('[paystack] initializeTransaction failed:', err.message);
    return { status: false, error: err.message };
  }
};

/**
 * Verify a transaction using its reference.
 * @param {string} reference
 * @returns {Promise<{ status: boolean, data?: any, error?: string }>}
 */
export const verifyTransaction = async (reference) => {
  const secretKey = await getPaystackSecretKey();
  if (!secretKey) {
    return { status: false, error: 'Paystack secret key not configured' };
  }

  try {
    const response = await fetch(`${BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`, {
      method: 'GET',
      headers: headers(secretKey),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.status) {
      return { status: false, error: data.message || `HTTP ${response.status}` };
    }

    return { status: true, data: data.data };
  } catch (err) {
    console.error('[paystack] verifyTransaction failed:', err.message);
    return { status: false, error: err.message };
  }
};

/**
 * Initiate a refund for a transaction.
 * @param {string} reference - the original transaction reference
 * @param {number} [amount] - optional partial refund amount in major currency units
 * @returns {Promise<{ status: boolean, data?: any, error?: string }>}
 */
export const refundTransaction = async (reference, amount) => {
  const secretKey = await getPaystackSecretKey();
  if (!secretKey) {
    return { status: false, error: 'Paystack secret key not configured' };
  }

  try {
    const body = { transaction: reference };
    if (amount) body.amount = Math.round(amount * 100);

    const response = await fetch(`${BASE_URL}/refund`, {
      method: 'POST',
      headers: headers(secretKey),
      body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.status) {
      return { status: false, error: data.message || `HTTP ${response.status}` };
    }

    return { status: true, data: data.data };
  } catch (err) {
    console.error('[paystack] refundTransaction failed:', err.message);
    return { status: false, error: err.message };
  }
};

/**
 * Create a transfer recipient (bank account) — used for organizer payouts.
 * @param {{ name: string, account_number: string, bank_code: string }} params
 */
export const createTransferRecipient = async ({ name, account_number, bank_code }) => {
  const secretKey = await getPaystackSecretKey();
  if (!secretKey) return { status: false, error: 'Paystack secret key not configured' };

  try {
    const response = await fetch(`${BASE_URL}/transferrecipient`, {
      method: 'POST',
      headers: headers(secretKey),
      body: JSON.stringify({ type: 'nuban', name, account_number, bank_code, currency: 'GHS' }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.status) {
      return { status: false, error: data.message || `HTTP ${response.status}` };
    }
    return { status: true, data: data.data };
  } catch (err) {
    console.error('[paystack] createTransferRecipient failed:', err.message);
    return { status: false, error: err.message };
  }
};

/**
 * List supported banks and their codes.
 */
export const listBanks = async (country = 'ghana') => {
  const secretKey = await getPaystackSecretKey();
  if (!secretKey) return { status: false, error: 'Paystack secret key not configured' };
  try {
    const response = await fetch(
      `${BASE_URL}/bank?country=${encodeURIComponent(country)}`,
      { method: 'GET', headers: headers(secretKey) },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.status) {
      return { status: false, error: data.message || `HTTP ${response.status}` };
    }
    return { status: true, data: data.data };
  } catch (err) {
    console.error('[paystack] listBanks failed:', err.message);
    return { status: false, error: err.message };
  }
};

export default { initializeTransaction, verifyTransaction, refundTransaction };
