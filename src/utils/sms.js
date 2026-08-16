/**
 * SMSOnlineGH (smsonlinegh.com) integration.
 * Sends SMS via the provider's HTTP API using native fetch.
 *
 * API docs (summary):
 *   POST https://api.smsonlinegh.com/v1/sms/send
 *   Headers: ApiKey: <your api key>
 *   Body (JSON): { sender, message, recipients: ["233xxxxxxxx"] }
 */

const API_BASE = 'https://api.smsonlinegh.com/v1';
const API_KEY = process.env.SMSONLINEGH_API_KEY;
const SENDER_ID = process.env.SMSONLINEGH_SENDER_ID || 'TribesCliqs';

/**
 * Normalise a Ghanaian / international phone number to the format the API
 * expects (no leading +, no spaces).
 */
export const normalisePhone = (phone) => {
  if (!phone) return null;
  let p = phone.replace(/[^0-9+]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  // Convert local Ghana format 0XXXXXXXXX -> 233XXXXXXXXX
  if (p.startsWith('0') && p.length === 10) {
    p = '233' + p.slice(1);
  }
  return p;
};

/**
 * Send an SMS to one or more recipients.
 * @param {string|string[]} recipients
 * @param {string} message
 * @returns {Promise<{ success: boolean, data?: any, error?: string }>}
 */
export const sendSMS = async (recipients, message) => {
  if (!API_KEY) {
    console.warn('[sms] No SMSONLINEGH_API_KEY configured — SMS not sent.');
    return { success: false, error: 'SMS provider not configured' };
  }

  const to = Array.isArray(recipients) ? recipients : [recipients];
  const numbers = to.map(normalisePhone).filter(Boolean);
  if (numbers.length === 0) {
    return { success: false, error: 'No valid recipient numbers' };
  }

  try {
    const response = await fetch(`${API_BASE}/sms/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ApiKey: API_KEY,
      },
      body: JSON.stringify({
        sender: SENDER_ID,
        message,
        recipients: numbers,
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return { success: false, error: data?.message || `HTTP ${response.status}` };
    }

    return { success: true, data };
  } catch (err) {
    console.error('[sms] sendSMS failed:', err.message);
    return { success: false, error: err.message };
  }
};

/**
 * Send a ticket confirmation SMS with a short ticket reference.
 */
export const sendTicketConfirmationSMS = async (phone, reference) =>
  sendSMS(
    phone,
    `Tribes & Cliqs: Your ticket order ${reference} is confirmed. Show this at the entrance. Thank you!`,
  );

export default sendSMS;
