/**
 * SMSOnlineGH (smsonlinegh.com) v5 API integration.
 * Sends SMS via official HTTP REST API.
 *
 * Endpoint: POST https://api.smsonlinegh.com/v5/message/sms/send
 * Headers:
 *   Authorization: key <api_key>
 *   Content-Type: application/json
 *   Accept: application/json
 * Body:
 *   { text, type: 0, sender, to }
 */

import { getSmsApiKey, getSmsSenderId } from './settings.js';

const API_URL = 'https://api.smsonlinegh.com/v5/message/sms/send';

/**
 * Normalise a Ghanaian / international phone number to the format the API
 * expects (no leading +, no spaces).
 */
export const normalisePhone = (phone) => {
  if (!phone) return null;
  let p = String(phone).replace(/[^0-9+]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  // Convert local Ghana format 0XXXXXXXXX -> 233XXXXXXXXX
  if (p.startsWith('0') && p.length === 10) {
    p = '233' + p.slice(1);
  }
  return p;
};

/**
 * Send an SMS to one or more recipients via SMSOnlineGH.
 * @param {string|string[]} recipients
 * @param {string} message
 * @returns {Promise<{ success: boolean, data?: any, error?: string }>}
 */
export const sendSMS = async (recipients, message) => {
  const apiKey = await getSmsApiKey();
  const senderId = await getSmsSenderId();

  if (!apiKey) {
    console.warn('[sms] SMSOnlineGH API key is not configured (SMS_API_KEY in .env or system_settings). SMS not sent.');
    return { success: false, error: 'SMS provider not configured' };
  }

  const to = Array.isArray(recipients) ? recipients : [recipients];
  const numbers = to.map(normalisePhone).filter(Boolean);
  if (numbers.length === 0) {
    console.warn('[sms] No valid phone numbers found in recipient list:', recipients);
    return { success: false, error: 'No valid recipient numbers' };
  }

  // Sanitize sender ID: GSM standard is max 11 alphanumeric characters, no symbols like &
  const rawSender = senderId || 'TribesCliqs';
  const cleanSender = String(rawSender).replace(/[^a-zA-Z0-9]/g, '').slice(0, 11) || 'TribesCliqs';
  const destination = numbers.join(',');

  try {
    console.log(`[sms] Sending SMS via SMSOnlineGH to ${destination} (Sender: ${cleanSender})...`);

    const queryUrl = new URL(API_URL);
    queryUrl.searchParams.set('key', apiKey);
    queryUrl.searchParams.set('text', message);
    queryUrl.searchParams.set('type', '0');
    queryUrl.searchParams.set('sender', cleanSender);
    queryUrl.searchParams.set('to', destination);

    const response = await fetch(queryUrl.toString(), {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || (data.handshake && data.handshake.id !== 0 && data.handshake.label !== 'HSHK_OK')) {
      console.error(`[sms] SMSOnlineGH error (${response.status}):`, JSON.stringify(data));
      return { success: false, error: data?.message || data?.handshake?.label || `HTTP ${response.status}` };
    }

    // Inspect destinations for telecom delivery status
    const destinations = data?.data?.destinations || [];
    const rejectedDest = destinations.find((d) => d.status?.label === 'DS_REJECTED_SENDER_UNREGISTERED' || d.status?.id === 2128);
    if (rejectedDest) {
      console.warn(`[sms] SMSOnlineGH: Sender ID "${cleanSender}" is not registered/approved on your SMSOnlineGH account. (Ghana telcos require approved Sender IDs).`);
    }

    console.log(`[sms] SMS request accepted by SMSOnlineGH for ${destination}! (Batch: ${data?.data?.batch || 'OK'})`);
    return { success: true, data };
  } catch (err) {
    console.error('[sms] sendSMS failed:', err.message);
    return { success: false, error: err.message };
  }
};

/**
 * Send a verification code SMS.
 */
export const sendVerificationSMS = async (phone, otp) =>
  sendSMS(
    phone,
    `Tribes & Cliqs: Your verification code is ${otp}. Valid for 15 minutes. Never share this code with anyone.`,
  );

/**
 * Send a welcome alert SMS after account verification.
 */
export const sendWelcomeSMS = async (phone, name = '') => {
  const firstName = name ? String(name).trim().split(' ')[0] : '';
  const greeting = firstName ? `Hi ${firstName}, ` : '';
  return sendSMS(
    phone,
    `Welcome to Tribes & Cliqs! ${greeting}Your account has been verified and activated. Start exploring top events and booking tickets now!`,
  );
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
