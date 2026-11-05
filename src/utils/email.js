import 'dotenv/config';
import nodemailer from 'nodemailer';
import { getEmailConfig } from './settings.js';
import { resolveSingleFrontendUrl, getFrontendUrl, createFrontendLink } from './urlHelper.js';

const FRONTEND_URL = resolveSingleFrontendUrl(process.env.FRONTEND_URL, 'https://tribesandcliqsevent.vercel.app');

/**
 * Direct HTTP dispatch to Resend's REST API (api.resend.com/emails).
 * Zero dependency on the 'resend' npm package.
 */
const sendViaResendHttp = async ({ apiKey, from, to, subject, html, text, attachments }) => {
  const payload = {
    from,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    text,
  };

  if (Array.isArray(attachments) && attachments.length > 0) {
    payload.attachments = attachments.map((a) => {
      let b64 = '';
      if (Buffer.isBuffer(a.content)) {
        b64 = a.content.toString('base64');
      } else if (typeof a.content === 'string') {
        b64 = Buffer.from(a.content).toString('base64');
      } else {
        b64 = String(a.content);
      }
      return {
        filename: a.filename || 'attachment.pdf',
        content: b64,
      };
    });
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
};

const getSmtpTransport = (cfg) => {
  if (cfg.smtpHost) {
    return nodemailer.createTransport({
      host: cfg.smtpHost,
      port: Number(cfg.smtpPort) || 587,
      secure: Number(cfg.smtpPort) === 465,
      auth: cfg.smtpUser
        ? { user: cfg.smtpUser, pass: cfg.smtpPass }
        : undefined,
    });
  }
  return null;
};

/**
 * Send an email. Tries Resend first, then SMTP, then logs locally.
 * Supports both object signature ({ to, subject, html, text }) and positional (to, subject, html, text).
 * @param {{ to: string, subject: string, html?: string, text?: string, attachments?: Array<{ filename: string, content: any, contentType?: string }> } | string} optsOrTo
 * @param {string} [subjectArg]
 * @param {string} [htmlArg]
 * @param {string} [textArg]
 * @returns {Promise<{ success: boolean, provider?: string, id?: string, error?: string }>}
 */
export const sendEmail = async (optsOrTo, subjectArg, htmlArg, textArg) => {
  try {
    let to, subject, html, text, attachments;
    if (typeof optsOrTo === 'string') {
      to = optsOrTo;
      subject = subjectArg;
      html = htmlArg;
      text = textArg;
    } else if (optsOrTo && typeof optsOrTo === 'object') {
      ({ to, subject, html, text, attachments } = optsOrTo);
    } else {
      console.warn('[email] sendEmail called with invalid arguments:', optsOrTo);
      return { success: false, error: 'Invalid arguments' };
    }

    if (!to) {
      console.warn('[email] sendEmail called without recipient address');
      return { success: false, error: 'Recipient address required' };
    }

    const cfg = await getEmailConfig();
    const from = cfg.fromName ? `"${cfg.fromName}" <${cfg.fromEmail}>` : cfg.fromEmail;

    if (cfg.resendKey) {
      try {
        let sendRes = await sendViaResendHttp({
          apiKey: cfg.resendKey,
          from,
          to,
          subject,
          html,
          text,
          attachments,
        });

        // If domain is unverified (initial test mode on Resend), retry automatically with onboarding@resend.dev
        if (
          !sendRes.ok &&
          sendRes.status === 403 &&
          String(sendRes.data?.message || '').toLowerCase().includes('domain')
        ) {
          console.warn(
            `[email] Domain "${from}" is not yet verified on resend.com. Retrying with test sender "onboarding@resend.dev"...`,
          );
          const testFrom = cfg.fromName
            ? `"${cfg.fromName}" <onboarding@resend.dev>`
            : 'onboarding@resend.dev';

          sendRes = await sendViaResendHttp({
            apiKey: cfg.resendKey,
            from: testFrom,
            to,
            subject,
            html,
            text,
            attachments,
          });
        }

        if (sendRes.ok) {
          console.log(`[email] Email sent via Resend API to ${to} (${subject}) — ID: ${sendRes.data?.id}`);
          return { success: true, provider: 'resend', id: sendRes.data?.id };
        }

        const errMsg = sendRes.data?.message || sendRes.data?.error || `HTTP ${sendRes.status}`;
        console.error(`[email] Resend API error (${sendRes.status}):`, errMsg);
        return { success: false, provider: 'resend', error: errMsg };
      } catch (resendFetchErr) {
        console.error('[email] Resend network dispatch failed:', resendFetchErr.message);
      }
    }

    const transport = getSmtpTransport(cfg);
    if (transport) {
      const info = await transport.sendMail({ from, to, subject, html, text, attachments });
      console.log(`[email] Email sent via SMTP to ${to} (${subject})`);
      return { success: true, provider: 'smtp', messageId: info?.messageId };
    }

    // No provider configured — log so devs can see the email locally.
    console.warn('[email] No provider configured (RESEND_API_KEY or SMTP_HOST missing in .env / system_settings) — email logged:', { to, subject });
    return { success: true, provider: 'dev_log', note: 'Email logged locally (no provider configured)' };
  } catch (err) {
    console.error('[email] sendEmail failed:', err.message);
    return { success: false, error: err.message };
  }
};

/* ------------------------------------------------------------------ *
 * Templated helpers
 * ------------------------------------------------------------------ */

// Escape user-supplied text for safe embedding in HTML emails.
const escapeHtml = (value) =>
  String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const eventLink = (eventId) => `${FRONTEND_URL}/events/${eventId}`;

const buildGoogleCalendarUrl = ({ title, description, venue, startDate, startTime }) => {
  try {
    let startIso = '';
    let endIso = '';
    if (startDate) {
      const datePart = String(startDate).includes('T') ? String(startDate).split('T')[0] : String(startDate);
      const timePart = startTime ? String(startTime).replace(/[^0-9]/g, '').slice(0, 4) : '1800';
      const cleanDate = datePart.replace(/[^0-9]/g, '');
      if (cleanDate.length === 8) {
        startIso = `${cleanDate}T${timePart.padEnd(4, '0')}00Z`;
        const startHour = Number(timePart.slice(0, 2)) || 18;
        const endHour = String(Math.min(23, startHour + 3)).padStart(2, '0');
        endIso = `${cleanDate}T${endHour}${timePart.slice(2, 4).padEnd(2, '0')}00Z`;
      }
    }
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: title || 'Tribes & Cliqs Live Event',
      details: description || 'Official admission pass booked on Tribes & Cliqs.',
      location: venue || '',
    });
    if (startIso && endIso) {
      params.set('dates', `${startIso}/${endIso}`);
    }
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  } catch {
    return null;
  }
};

const buildGoogleMapsUrl = (venue, address, city) => {
  const parts = [venue, address, city].filter(Boolean).join(', ');
  if (!parts) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts)}`;
};

/* ------------------------------------------------------------------ *
 * Templated helpers
 * ------------------------------------------------------------------ */

export const sendVerificationEmail = async (to, token, otp = null) => {
  const link = `${FRONTEND_URL}/verify-email?token=${token}${to ? `&email=${encodeURIComponent(to)}` : ''}`;
  const otpSection = otp
    ? `
      <div style="margin:24px 0;padding:20px;background:#1C232B;border-radius:12px;border:1px solid #363F48;text-align:center;">
        <p style="color:#949599;font-size:12px;margin:0 0 8px 0;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Your 6-Digit Verification Code</p>
        <div style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#FFFFFF;font-family:monospace;">${otp}</div>
        <p style="color:#64748b;font-size:12px;margin:8px 0 0 0;">Valid for 15 minutes</p>
      </div>`
    : '';

  return sendEmail({
    to,
    subject: otp ? `Your Verification Code: ${otp} — Tribes & Cliqs` : 'Verify your email — Tribes & Cliqs',
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <div style="text-align:center;margin-bottom:20px;">
          <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(239,239,241,0.1);color:#EFEFF1;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">Account Security</span>
        </div>
        <h2 style="margin-top:0;color:#FFFFFF;text-align:center;font-size:22px;">Welcome to Tribes &amp; Cliqs!</h2>
        <p style="color:#A1A1AA;line-height:1.6;font-size:15px;text-align:center;">
          Thank you for joining. Please use the verification code below or click the button to verify your account and get started.
        </p>
        ${otpSection}
        <div style="text-align:center;margin:28px 0;">
          <a href="${link}" style="display:inline-block;padding:12px 28px;background:#EFEFF1;color:#14191E;font-weight:700;border-radius:8px;text-decoration:none;font-size:14px;">Verify Account</a>
        </div>
        <p style="color:#64748B;font-size:12px;line-height:1.5;margin-bottom:0;text-align:center;">
          If you did not request this email, you can safely ignore it.
        </p>
      </div>`,
    text: otp
      ? `Welcome to Tribes & Cliqs!\n\nYour 6-digit verification code is: ${otp}\n(Valid for 15 minutes)\n\nOr click here to verify: ${link}`
      : `Welcome to Tribes & Cliqs! Verify your email: ${link}`,
  });
};

/**
 * Branded Welcome Alert for both Email registrations and Google OAuth sign-ups.
 */
export const sendWelcomeEmail = async (to, name = 'Friend', options = {}) => {
  const isGoogle = typeof options === 'boolean' ? options : Boolean(options.isGoogle);
  const role = typeof options === 'object' && options.role ? options.role : 'attendee';
  const cleanName = escapeHtml(name || 'Friend');
  const exploreLink = `${FRONTEND_URL}/events`;
  const profileLink = role === 'organizer' ? `${FRONTEND_URL}/organizer` : `${FRONTEND_URL}/tickets`;

  const registrationDetail = isGoogle
    ? 'Your account was successfully created via Google Sign-In.'
    : 'Your account has been verified and is ready to use.';

  const roleText = role === 'organizer'
    ? 'You are now ready to set up your organizer profile, create memorable events, and manage ticket sales.'
    : 'You can now discover trending events, reserve tickets in seconds, transfer passes to friends, and chat with Clqs Bot.';

  return sendEmail({
    to,
    subject: `✨ Welcome to Tribes & Cliqs, ${cleanName}!`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <div style="text-align:center;margin-bottom:24px;">
          <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(239,239,241,0.12);color:#FFFFFF;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">
            ${isGoogle ? 'Google Account Connected' : 'Welcome to the Tribe'}
          </span>
        </div>
        <h2 style="margin-top:0;color:#FFFFFF;text-align:center;font-size:24px;">Hi ${cleanName}, Welcome!</h2>
        <p style="color:#A1A1AA;line-height:1.6;font-size:15px;text-align:center;">
          ${registrationDetail} We are thrilled to have you as part of Tribes &amp; Cliqs.
        </p>

        <div style="margin:24px 0;padding:24px;background:#1C232B;border-radius:14px;border:1px solid #363F48;">
          <h3 style="margin:0 0 10px 0;color:#FFFFFF;font-size:16px;">What you can do next:</h3>
          <p style="margin:0;color:#CBD5E1;font-size:14px;line-height:1.6;">
            ${roleText}
          </p>
        </div>

        <div style="text-align:center;margin:30px 0;">
          <a href="${exploreLink}" style="display:inline-block;padding:12px 28px;background:#EFEFF1;color:#14191E;font-weight:bold;border-radius:8px;text-decoration:none;font-size:14px;margin-right:10px;">
            Explore Events
          </a>
          <a href="${profileLink}" style="display:inline-block;padding:12px 28px;background:#242B32;color:#FFFFFF;font-weight:bold;border-radius:8px;text-decoration:none;font-size:14px;border:1px solid #494F55;">
            ${role === 'organizer' ? 'Organizer Dashboard' : 'My Account & Tickets'}
          </a>
        </div>

        <p style="color:#64748B;font-size:12px;line-height:1.5;margin-bottom:0;text-align:center;border-top:1px solid #2B333B;padding-top:20px;">
          Tribes &amp; Cliqs — Discover, Connect &amp; Experience Unforgettable Events.
        </p>
      </div>`,
    text: `Hi ${name},\n\nWelcome to Tribes & Cliqs! ${registrationDetail}\n\n${roleText}\n\nExplore events: ${exploreLink}\nManage account: ${profileLink}`,
  });
};

export const sendPasswordResetEmail = async (to, tokenOrCode, name = 'User') => {
  const code = tokenOrCode;
  const link = `${FRONTEND_URL}/reset-password?code=${encodeURIComponent(code)}&email=${encodeURIComponent(to)}`;
  const cleanName = escapeHtml(name || 'User');
  return sendEmail({
    to,
    subject: `Your Password Reset Code: ${code} — Tribes & Cliqs`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <div style="text-align:center;margin-bottom:20px;">
          <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(239,68,68,0.15);color:#EF4444;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">Security Alert</span>
        </div>
        <h2 style="margin-top:0;color:#FFFFFF;text-align:center;font-size:22px;">Password Reset Request</h2>
        <p style="color:#A1A1AA;line-height:1.6;font-size:15px;text-align:center;">
          Hello ${cleanName}, we received a request to reset your Tribes &amp; Cliqs password.
        </p>
        <div style="margin:24px 0;padding:20px;background:#1C232B;border-radius:12px;border:1px solid #363F48;text-align:center;">
          <p style="color:#949599;font-size:12px;margin:0 0 8px 0;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Your 6-Digit Reset Code</p>
          <div style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#FFFFFF;font-family:monospace;">${code}</div>
          <p style="color:#64748b;font-size:12px;margin:8px 0 0 0;">Valid for 15 minutes</p>
        </div>
        <div style="text-align:center;margin:28px 0;">
          <a href="${link}" style="display:inline-block;padding:12px 28px;background:#EFEFF1;color:#14191E;border-radius:8px;font-weight:bold;text-decoration:none;font-size:14px;">Reset Password Directly</a>
        </div>
        <p style="color:#64748b;font-size:12px;margin-top:24px;border-top:1px solid #2B333B;padding-top:16px;line-height:1.5;">
          If you did not request this password reset, please ignore this email or contact support if you suspect unauthorized activity on your account.
        </p>
      </div>`,
    text: `Your password reset code is: ${code} (valid for 15 minutes).\n\nOr click here to reset your password: ${link}`,
  });
};

/**
 * Security notification sent after a password has been successfully reset or updated.
 */
export const sendPasswordChangedAlertEmail = async (to, name = 'User', method = 'reset') => {
  const cleanName = escapeHtml(name || 'User');
  const now = new Date().toUTCString();
  const resetLink = `${FRONTEND_URL}/forgot-password`;
  const methodText = method === 'settings' ? 'Account Settings' : 'Password Reset Code';

  return sendEmail({
    to,
    subject: '🔒 Security Alert: Your password was changed — Tribes & Cliqs',
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <div style="text-align:center;margin-bottom:20px;">
          <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(16,185,129,0.15);color:#10B981;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">Security Notice</span>
        </div>
        <h2 style="margin-top:0;color:#FFFFFF;text-align:center;font-size:22px;">Password Successfully Changed</h2>
        <p style="color:#A1A1AA;line-height:1.6;font-size:15px;text-align:center;">
          Hello ${cleanName}, this is a confirmation that your Tribes &amp; Cliqs password was updated on <strong>${now}</strong> via ${methodText}.
        </p>
        <div style="margin:24px 0;padding:20px;background:#1C232B;border-radius:12px;border:1px solid #363F48;">
          <p style="margin:0 0 8px 0;color:#CBD5E1;font-size:14px;"><strong>Account:</strong> ${escapeHtml(to)}</p>
          <p style="margin:0 0 8px 0;color:#CBD5E1;font-size:14px;"><strong>Time:</strong> ${now}</p>
          <p style="margin:0;color:#CBD5E1;font-size:14px;"><strong>Action Taken:</strong> Other active device sessions were logged out for your protection.</p>
        </div>
        <div style="margin:24px 0;padding:16px;background:rgba(239,68,68,0.1);border-left:4px solid #EF4444;border-radius:8px;">
          <p style="margin:0;color:#FCA5A5;font-size:13px;line-height:1.5;">
            <strong>Did not make this change?</strong> If you did not change your password, someone else may have accessed your account. Reset your password immediately:
          </p>
          <div style="margin-top:12px;">
            <a href="${resetLink}" style="display:inline-block;padding:10px 20px;background:#EF4444;color:#FFFFFF;font-weight:bold;border-radius:6px;text-decoration:none;font-size:13px;">Secure My Account</a>
          </div>
        </div>
        <p style="color:#64748B;font-size:12px;line-height:1.5;margin-bottom:0;text-align:center;">
          If you made this change, you can safely ignore this notification.
        </p>
      </div>`,
    text: `Security Alert: Your Tribes & Cliqs password was successfully updated on ${now}.\n\nIf you did not make this change, please reset your password immediately: ${resetLink}`,
  });
};

/**
 * High-fidelity, branded ticket purchase confirmation with QR access and event info.
 */
export const sendTicketConfirmationEmail = async (to, order) => {
  const cleanTitle = escapeHtml(order.eventTitle || 'Live Event');
  const cleanRef = escapeHtml(order.reference || order.paymentReference || 'N/A');
  const cleanTotal = escapeHtml(order.total || (order.total_amount ? `GHS ${Number(order.total_amount).toFixed(2)}` : 'GHS 0.00'));
  const fullVenue = [order.venue, order.address, order.city].filter(Boolean).join(', ') || 'Venue TBA';
  const cleanVenue = escapeHtml(fullVenue);
  const cleanDate = escapeHtml(order.eventDate || order.date || 'Upcoming');
  const cleanTime = escapeHtml(order.startTime || order.start_time || '');
  const attendeeName = escapeHtml(order.attendeeName || 'Guest');
  const bannerImage = order.bannerImage || order.banner_image || null;
  const link = `${FRONTEND_URL}/my-tickets`;
  const receiptLink = `${FRONTEND_URL}/receipt/${encodeURIComponent(order.reference || order.id || '')}`;

  const calUrl = buildGoogleCalendarUrl({
    title: order.eventTitle,
    description: `Order ${cleanRef} — Access your tickets: ${link}`,
    venue: fullVenue,
    startDate: order.startDate || order.start_date,
    startTime: order.startTime || order.start_time,
  });

  const mapsUrl = buildGoogleMapsUrl(order.venue, order.address, order.city);

  const tickets = Array.isArray(order.tickets) && order.tickets.length > 0 ? order.tickets : [];

  const ticketCardsHtml = tickets.length > 0
    ? tickets.map((t, index) => {
        const ticketNum = t.ticket_number || t.code || `TC-${index + 1}`;
        const qrContent = encodeURIComponent(t.qr_code || ticketNum);
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${qrContent}&margin=4`;
        const tier = escapeHtml(t.tier || t.tier_name || 'Admission Pass');
        const holder = escapeHtml(t.attendee_name || attendeeName);
        const seat = t.seat_number ? escapeHtml(t.seat_number) : null;

        return `
          <div style="background:#1C232B;border-radius:14px;border:1px solid #363F48;margin-bottom:16px;overflow:hidden;box-shadow:0 6px 18px rgba(0,0,0,0.35);">
            <div style="padding:12px 18px;background:#242B32;border-bottom:1px dashed #363F48;display:flex;justify-content:space-between;align-items:center;">
              <span style="display:inline-block;padding:4px 10px;border-radius:6px;background:rgba(239,239,241,0.12);color:#EFEFF1;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">
                ${tier}
              </span>
              <span style="font-family:monospace;color:#949599;font-size:12px;">Pass #${index + 1}</span>
            </div>
            <div style="padding:22px;text-align:center;">
              <div style="background:#FFFFFF;padding:12px;border-radius:12px;display:inline-block;box-shadow:0 4px 14px rgba(0,0,0,0.25);">
                <img src="${qrUrl}" alt="Entry QR Code" width="160" height="160" style="display:block;border:0;margin:0 auto;" />
              </div>
              <p style="margin:12px 0 0 0;font-family:monospace;font-size:16px;color:#FFFFFF;font-weight:bold;letter-spacing:2px;">
                ${escapeHtml(ticketNum)}
              </p>
              <p style="margin:6px 0 0 0;color:#CBD5E1;font-size:13px;">
                Holder: <strong style="color:#FFFFFF;">${holder}</strong>
                ${seat ? ` &bull; Seat: <strong style="color:#10B981;">${seat}</strong>` : ''}
              </p>
              <div style="margin-top:10px;">
                <span style="display:inline-block;padding:4px 10px;border-radius:999px;background:rgba(16,185,129,0.12);color:#10B981;font-size:11px;font-weight:600;">
                  &#10003; Ready for Gate Admission
                </span>
              </div>
            </div>
          </div>
        `;
      }).join('')
    : (order.items || []).map((i) => `
        <div style="padding:10px 0;border-bottom:1px solid #2B333B;color:#CBD5E1;font-size:13px;display:flex;justify-content:space-between;">
          <span>${escapeHtml(i.quantity)} &times; ${escapeHtml(i.name || i.ticket_type_name || 'Pass')}</span>
          <strong style="color:#FFFFFF;">${escapeHtml(i.subtotal ? `GHS ${Number(i.subtotal).toFixed(2)}` : '')}</strong>
        </div>
      `).join('');

  const lineItemsList = Array.isArray(order.items) && order.items.length > 0
    ? `
      <div style="margin-top:16px;border-top:1px solid #363F48;padding-top:14px;">
        <p style="margin:0 0 8px 0;color:#949599;font-size:12px;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Order Summary</p>
        ${order.items.map((item) => `
          <div style="padding:6px 0;color:#CBD5E1;font-size:13px;display:flex;justify-content:space-between;">
            <span>${escapeHtml(item.quantity)} &times; ${escapeHtml(item.name || item.ticket_type_name || 'Ticket')}</span>
            <span style="color:#FFFFFF;font-weight:600;">GHS ${Number(item.subtotal || (item.quantity * item.unit_price) || 0).toFixed(2)}</span>
          </div>
        `).join('')}
      </div>`
    : '';

  const bannerHtml = bannerImage
    ? `<div style="margin:-32px -32px 24px -32px;overflow:hidden;border-radius:16px 16px 0 0;">
        <img src="${escapeHtml(bannerImage)}" alt="${cleanTitle}" style="width:100%;max-height:220px;object-fit:cover;display:block;" />
       </div>`
    : '';

  const calendarButtons = `
    <div style="text-align:center;margin:18px 0 0 0;">
      ${calUrl ? `<a href="${calUrl}" target="_blank" style="display:inline-block;padding:8px 16px;background:rgba(255,255,255,0.08);color:#CBD5E1;border-radius:8px;text-decoration:none;font-size:12px;font-weight:600;margin-right:8px;border:1px solid #363F48;">&#128197; Add to Google Calendar</a>` : ''}
      ${mapsUrl ? `<a href="${mapsUrl}" target="_blank" style="display:inline-block;padding:8px 16px;background:rgba(255,255,255,0.08);color:#CBD5E1;border-radius:8px;text-decoration:none;font-size:12px;font-weight:600;border:1px solid #363F48;">&#128205; Open in Maps</a>` : ''}
    </div>
  `;

  return sendEmail({
    to,
    subject: `🎟️ Your Tickets for "${cleanTitle}" — Tribes & Cliqs`,
    attachments: order.attachments || [],
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:590px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;line-height:1.5;">
        ${bannerHtml}
        <div style="text-align:center;margin-bottom:20px;">
          <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(16,185,129,0.15);color:#10B981;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">
            Order Confirmed &bull; Entry Passes Ready
          </span>
        </div>
        <h2 style="margin-top:0;color:#FFFFFF;text-align:center;font-size:24px;font-weight:800;">You're Going! 🎟️</h2>
        <p style="color:#A1A1AA;line-height:1.6;font-size:15px;text-align:center;margin-bottom:24px;">
          Hi ${attendeeName}, your payment was successful and your official ticket passes have been issued.
        </p>

        <!-- Event Logistics Card -->
        <div style="margin:20px 0;padding:22px;background:#1C232B;border-radius:14px;border:1px solid #363F48;">
          <h3 style="margin:0 0 12px 0;color:#FFFFFF;font-size:20px;font-weight:700;">${cleanTitle}</h3>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;">
            <strong style="color:#FFFFFF;">Date:</strong> ${cleanDate}${cleanTime ? ` at ${cleanTime}` : ''}
          </p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;">
            <strong style="color:#FFFFFF;">Venue:</strong> ${cleanVenue}
          </p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;">
            <strong style="color:#FFFFFF;">Order Reference:</strong> <code style="font-family:monospace;color:#CBD5E1;font-size:14px;background:#242B32;padding:2px 6px;border-radius:4px;border:1px solid #363F48;">${cleanRef}</code>
          </p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;">
            <strong style="color:#FFFFFF;">Total Paid:</strong> <strong style="color:#10B981;font-size:16px;">${cleanTotal}</strong>
            ${order.paymentMethod ? ` <span style="color:#949599;font-size:12px;">via ${escapeHtml(order.paymentMethod.toUpperCase())}</span>` : ''}
          </p>
          ${calendarButtons}
          ${lineItemsList}
        </div>

        <!-- Ticket Passes Section -->
        <div style="margin:26px 0;">
          <div style="text-align:center;margin-bottom:14px;">
            <p style="margin:0;color:#949599;font-size:12px;text-transform:uppercase;letter-spacing:1px;font-weight:700;">
              Your Entry Pass${tickets.length > 1 ? 'es' : ''} (${tickets.length || 1})
            </p>
            <p style="margin:4px 0 0 0;color:#64748B;font-size:12px;">
              Present these QR codes at the gate on your phone screen
            </p>
          </div>
          ${ticketCardsHtml}
        </div>

        <!-- Action CTAs -->
        <div style="text-align:center;margin:30px 0;display:flex;justify-content:center;gap:12px;flex-wrap:wrap;">
          <a href="${link}" style="display:inline-block;padding:14px 28px;background:#EFEFF1;color:#14191E;font-weight:bold;border-radius:10px;text-decoration:none;font-size:14px;box-shadow:0 6px 16px rgba(0,0,0,0.3);">
            Open Live Pass in App
          </a>
          <a href="${receiptLink}" style="display:inline-block;padding:14px 28px;background:#242B32;color:#FFFFFF;font-weight:bold;border-radius:10px;text-decoration:none;font-size:14px;border:1px solid #494F55;">
            Official Receipt
          </a>
        </div>

        <!-- Gate Tip Box -->
        <div style="background:#1C232B;padding:16px 20px;border-radius:12px;border:1px solid #363F48;margin-bottom:24px;">
          <p style="margin:0;color:#CBD5E1;font-size:13px;line-height:1.5;">
            <strong style="color:#FFFFFF;">Gate Entry Tip:</strong> Screenshot or save these QR passes before arriving at the venue in case mobile data is slow at the entrance. Each QR code is uniquely tied to your order and guarantees 1 entry.
          </p>
        </div>

        <p style="color:#64748B;font-size:12px;line-height:1.5;margin-bottom:0;text-align:center;border-top:1px solid #2B333B;padding-top:16px;">
          Tribes &amp; Cliqs Ticketing &bull; Need help? Reach out to support@tribesandcliqs.com or message the event organizer on the event page.
        </p>
      </div>`,
    text: `Order Confirmed! Your tickets for "${cleanTitle}" are ready.\n\nOrder Ref: ${cleanRef}\nTotal Paid: ${cleanTotal}\nDate: ${cleanDate}${cleanTime ? ` at ${cleanTime}` : ''}\nVenue: ${cleanVenue}\n\nView Your Passes: ${link}\nOfficial Receipt: ${receiptLink}\n\nShow your ticket code at the gate: ${tickets.map((t) => t.ticket_number).join(', ')}`,
  });
};

/**
 * Gate admission confirmation alert sent immediately when an attendee's pass is checked in.
 */
export const sendGateCheckInAlertEmail = async ({
  to,
  attendeeName = 'Attendee',
  eventTitle = 'Live Event',
  ticketNumber = '',
  tier = 'General Admission',
  checkedInAt = new Date(),
}) => {
  const cleanTitle = escapeHtml(eventTitle);
  const cleanAttendee = escapeHtml(attendeeName);
  const timeStr = new Date(checkedInAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  return sendEmail({
    to,
    subject: `✅ Gate Admission Confirmed — "${cleanTitle}"`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <div style="text-align:center;margin-bottom:20px;">
          <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(16,185,129,0.15);color:#10B981;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">Admitted at Gate</span>
        </div>
        <h2 style="margin-top:0;color:#FFFFFF;text-align:center;font-size:22px;">Welcome to ${cleanTitle}! 🎉</h2>
        <p style="color:#A1A1AA;line-height:1.6;font-size:15px;text-align:center;">
          Hi ${cleanAttendee}, your ticket has been successfully verified and scanned at the entrance gate.
        </p>
        <div style="margin:24px 0;padding:20px;background:#1C232B;border-radius:12px;border:1px solid #363F48;">
          <p style="margin:4px 0;color:#CBD5E1;font-size:14px;"><strong>Pass Tier:</strong> ${escapeHtml(tier)}</p>
          <p style="margin:4px 0;color:#CBD5E1;font-size:14px;"><strong>Ticket #:</strong> <code style="font-family:monospace;color:#CBD5E1;background:#242B32;padding:2px 6px;border-radius:4px;border:1px solid #363F48;">${escapeHtml(ticketNumber)}</code></p>
          <p style="margin:4px 0;color:#CBD5E1;font-size:14px;"><strong>Admission Time:</strong> ${timeStr}</p>
        </div>
        <p style="color:#CBD5E1;font-size:14px;text-align:center;line-height:1.6;">
          Have a fantastic time at the event! Share your moments with your Tribe.
        </p>
      </div>`,
    text: `Gate Admission Confirmed for "${eventTitle}"!\n\nTicket: ${ticketNumber}\nTier: ${tier}\nTime: ${timeStr}\n\nEnjoy the event!`,
  });
};

/**
 * Announcement broadcast email sent to attendees, organizers, admins or all users.
 */
export const sendAnnouncementEmail = async ({
  to,
  recipientName = 'Tribe Member',
  title = 'Important Announcement',
  message = '',
  senderName = 'Tribes & Cliqs Admin',
  link = null,
  actionLabel = 'View Details',
  eventTitle = null,
  badge = null,
}) => {
  const cleanTitle = escapeHtml(title);
  const cleanRecipient = escapeHtml(recipientName);
  const cleanSender = escapeHtml(senderName);
  const cleanEvent = eventTitle ? escapeHtml(eventTitle) : null;
  const actionLink = link || (eventTitle ? `${FRONTEND_URL}/events` : `${FRONTEND_URL}`);
  const cleanActionLabel = escapeHtml(actionLabel || 'View Details');
  const badgeLabel = escapeHtml(badge || (cleanEvent ? `Event Broadcast • ${cleanEvent}` : 'Platform Announcement'));

  // Format message paragraphs
  const formattedMsg = escapeHtml(message)
    .split('\n')
    .filter((p) => p.trim())
    .map((p) => `<p style="margin:0 0 12px 0;color:#CBD5E1;font-size:15px;line-height:1.6;">${p}</p>`)
    .join('');

  return sendEmail({
    to,
    subject: `📢 ${cleanEvent ? `[${cleanEvent}] ` : ''}${cleanTitle}`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <div style="text-align:center;margin-bottom:20px;">
          <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(239,239,241,0.12);color:#EFEFF1;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">
            ${badgeLabel}
          </span>
        </div>
        <h2 style="margin-top:0;color:#FFFFFF;text-align:center;font-size:22px;">${cleanTitle}</h2>
        <p style="color:#A1A1AA;line-height:1.6;font-size:14px;text-align:center;margin-bottom:24px;">
          From: <strong>${cleanSender}</strong>
        </p>

        <div style="margin:20px 0;padding:24px;background:#1C232B;border-radius:14px;border:1px solid #363F48;">
          <p style="margin:0 0 12px 0;color:#FFFFFF;font-size:15px;font-weight:600;">Hello ${cleanRecipient},</p>
          ${formattedMsg}
        </div>

        <div style="text-align:center;margin:28px 0;">
          <a href="${actionLink}" style="display:inline-block;padding:12px 28px;background:#EFEFF1;color:#14191E;font-weight:bold;border-radius:8px;text-decoration:none;font-size:14px;">
            ${cleanActionLabel}
          </a>
        </div>

        <p style="color:#64748B;font-size:12px;line-height:1.5;margin-bottom:0;text-align:center;border-top:1px solid #2B333B;padding-top:16px;">
          You received this update because you are registered for this event or have an account on Tribes &amp; Cliqs.
        </p>
      </div>`,
    text: `${title}\nFrom: ${senderName}${eventTitle ? ` (${eventTitle})` : ''}\n\n${message}\n\n${actionLabel}: ${actionLink}`,
  });
};

/**
 * Organizer Alert: Triggered immediately when tickets are sold for their event.
 */
export const sendOrganizerTicketSaleAlertEmail = async ({
  to,
  organizerName = 'Organizer',
  buyerName = 'Attendee',
  buyerEmail = '',
  eventTitle = 'Live Event',
  ticketCount = 1,
  tierName = 'General Admission',
  orderRef = '',
  totalAmount = '0.00',
  currency = 'GHS',
  eventId = null,
}) => {
  const cleanOrg = escapeHtml(organizerName);
  const cleanTitle = escapeHtml(eventTitle);
  const cleanBuyer = escapeHtml(buyerName);
  const cleanBuyerEmail = escapeHtml(buyerEmail || 'Not specified');
  const cleanTier = escapeHtml(tierName);
  const cleanRef = escapeHtml(orderRef || 'N/A');
  const cleanTotal = escapeHtml(`${currency} ${Number(totalAmount).toFixed(2)}`);
  const ordersLink = `${FRONTEND_URL}/organizer/orders`;

  return sendEmail({
    to,
    subject: `🎉 Ticket Sale! ${ticketCount}× ${cleanTier} for "${cleanTitle}" (${cleanTotal})`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <div style="text-align:center;margin-bottom:20px;">
          <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(16,185,129,0.15);color:#10B981;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">
            New Ticket Sale Alert
          </span>
        </div>
        <h2 style="margin-top:0;color:#FFFFFF;text-align:center;font-size:22px;">You Made a Sale! 🎉</h2>
        <p style="color:#A1A1AA;line-height:1.6;font-size:15px;text-align:center;">
          Hello ${cleanOrg}, good news! A new ticket order has just been completed for your event <strong>"${cleanTitle}"</strong>.
        </p>

        <div style="margin:24px 0;padding:24px;background:#1C232B;border-radius:14px;border:1px solid #363F48;">
          <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #363F48;padding-bottom:12px;margin-bottom:12px;">
            <span style="color:#949599;font-size:13px;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Total Paid</span>
            <strong style="color:#10B981;font-size:20px;">${cleanTotal}</strong>
          </div>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Event:</strong> ${cleanTitle}</p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Passes Sold:</strong> ${ticketCount} × ${cleanTier}</p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Buyer:</strong> ${cleanBuyer} (${cleanBuyerEmail})</p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Order Reference:</strong> <code style="font-family:monospace;color:#CBD5E1;background:#242B32;padding:2px 6px;border-radius:4px;border:1px solid #363F48;">${cleanRef}</code></p>
        </div>

        <div style="text-align:center;margin:28px 0;">
          <a href="${ordersLink}" style="display:inline-block;padding:12px 28px;background:#EFEFF1;color:#14191E;font-weight:bold;border-radius:8px;text-decoration:none;font-size:14px;">
            View Order &amp; Attendees
          </a>
        </div>

        <p style="color:#64748B;font-size:12px;line-height:1.5;margin-bottom:0;text-align:center;border-top:1px solid #2B333B;padding-top:16px;">
          Tribes &amp; Cliqs Organizer Network — Powering Live Experiences.
        </p>
      </div>`,
    text: `New Ticket Sale Alert!\n\n${ticketCount}x ${tierName} sold for "${eventTitle}"!\nTotal Paid: ${currency} ${Number(totalAmount).toFixed(2)}\nBuyer: ${buyerName} (${buyerEmail})\nOrder Ref: ${orderRef}\n\nView details: ${ordersLink}`,
  });
};

/**
 * Platform Admin Alert: Triggered immediately when any ticket order is paid across the platform.
 */
export const sendAdminTicketSaleAlertEmail = async ({
  to,
  orderId,
  reference = '',
  eventTitle = 'Live Event',
  organizerName = 'Organizer',
  buyerName = 'Attendee',
  buyerEmail = '',
  totalAmount = '0.00',
  ticketCount = 1,
  currency = 'GHS',
}) => {
  const cleanTitle = escapeHtml(eventTitle);
  const cleanOrg = escapeHtml(organizerName);
  const cleanBuyer = escapeHtml(buyerName);
  const cleanEmail = escapeHtml(buyerEmail || 'N/A');
  const cleanRef = escapeHtml(reference);
  const cleanTotal = escapeHtml(`${currency} ${Number(totalAmount).toFixed(2)}`);
  const adminLink = `${FRONTEND_URL}/admin/payments`;

  return sendEmail({
    to,
    subject: `💸 [Sale Alert] ${cleanTotal} — "${cleanTitle}" (Order #${orderId})`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <div style="text-align:center;margin-bottom:20px;">
          <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(59,130,246,0.15);color:#60A5FA;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">
            Platform Financial Activity
          </span>
        </div>
        <h2 style="margin-top:0;color:#FFFFFF;text-align:center;font-size:22px;">New Ticket Purchase Completed</h2>
        <p style="color:#A1A1AA;line-height:1.6;font-size:14px;text-align:center;">
          A customer has successfully completed payment for tickets on Tribes &amp; Cliqs.
        </p>

        <div style="margin:24px 0;padding:24px;background:#1C232B;border-radius:14px;border:1px solid #363F48;">
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Order ID:</strong> #${orderId}</p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Event:</strong> ${cleanTitle}</p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Organizer:</strong> ${cleanOrg}</p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Buyer:</strong> ${cleanBuyer} (${cleanEmail})</p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Pass Count:</strong> ${ticketCount}</p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Gross Revenue:</strong> <span style="color:#10B981;font-weight:bold;">${cleanTotal}</span></p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Payment Ref:</strong> <code style="font-family:monospace;color:#CBD5E1;background:#242B32;padding:2px 6px;border-radius:4px;border:1px solid #363F48;">${cleanRef}</code></p>
        </div>

        <div style="text-align:center;margin:28px 0;">
          <a href="${adminLink}" style="display:inline-block;padding:12px 28px;background:#EFEFF1;color:#14191E;font-weight:bold;border-radius:8px;text-decoration:none;font-size:14px;">
            Review in Admin Payments
          </a>
        </div>

        <p style="color:#64748B;font-size:12px;text-align:center;">
          Tribes &amp; Cliqs Platform Operations &amp; Auditing.
        </p>
      </div>`,
    text: `Platform Sale Alert: ${cleanTotal} for "${eventTitle}"\nOrder #${orderId}\nOrganizer: ${organizerName}\nBuyer: ${buyerName} (${buyerEmail})\nReference: ${reference}\n\nReview: ${adminLink}`,
  });
};

/**
 * Platform Admin Alert: Triggered when an organizer creates or submits an event for review.
 */
export const sendAdminNewEventAlertEmail = async ({
  to,
  eventId,
  eventTitle = 'Untitled Event',
  organizerName = 'Organizer',
  organizerEmail = '',
  city = 'Accra',
  category = 'General',
  startDate = 'Upcoming',
}) => {
  const cleanTitle = escapeHtml(eventTitle);
  const cleanOrg = escapeHtml(organizerName);
  const cleanEmail = escapeHtml(organizerEmail);
  const adminEventsLink = `${FRONTEND_URL}/admin/events`;

  return sendEmail({
    to,
    subject: `🔔 New Event Awaiting Review: "${cleanTitle}" by ${cleanOrg}`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <div style="text-align:center;margin-bottom:20px;">
          <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(239,239,241,0.12);color:#EFEFF1;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">
            Review Required
          </span>
        </div>
        <h2 style="margin-top:0;color:#FFFFFF;text-align:center;font-size:22px;">New Event Submitted</h2>
        <p style="color:#A1A1AA;line-height:1.6;font-size:14px;text-align:center;">
          An organizer has submitted a new event for moderation. Tickets remain locked until this event is approved.
        </p>

        <div style="margin:24px 0;padding:24px;background:#1C232B;border-radius:14px;border:1px solid #363F48;">
          <h3 style="margin:0 0 10px 0;color:#FFFFFF;font-size:18px;">${cleanTitle}</h3>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Organizer:</strong> ${cleanOrg} (${cleanEmail})</p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Category:</strong> ${escapeHtml(category)}</p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Location:</strong> ${escapeHtml(city)}</p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Date:</strong> ${escapeHtml(startDate)}</p>
        </div>

        <div style="text-align:center;margin:28px 0;">
          <a href="${adminEventsLink}" style="display:inline-block;padding:12px 28px;background:#EFEFF1;color:#14191E;font-weight:bold;border-radius:8px;text-decoration:none;font-size:14px;">
            Review &amp; Approve Event
          </a>
        </div>

        <p style="color:#64748B;font-size:12px;text-align:center;">
          Tribes &amp; Cliqs Platform Compliance &amp; Event Moderation.
        </p>
      </div>`,
    text: `New Event Awaiting Review: "${eventTitle}"\nOrganizer: ${organizerName} (${organizerEmail})\nCategory: ${category}\nLocation: ${city}\nDate: ${startDate}\n\nReview event: ${adminEventsLink}`,
  });
};

/**
 * Organizer Confirmation: Sent when their event is submitted for review.
 */
export const sendOrganizerEventSubmittedEmail = async ({
  to,
  organizerName = 'Organizer',
  eventTitle = 'Live Event',
  eventId = null,
}) => {
  const cleanOrg = escapeHtml(organizerName);
  const cleanTitle = escapeHtml(eventTitle);
  const hubLink = `${FRONTEND_URL}/organizer/events`;

  return sendEmail({
    to,
    subject: `📝 Event Received: "${cleanTitle}" is under review — Tribes & Cliqs`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <div style="text-align:center;margin-bottom:20px;">
          <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(59,130,246,0.15);color:#60A5FA;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">
            Under Review
          </span>
        </div>
        <h2 style="margin-top:0;color:#FFFFFF;text-align:center;font-size:22px;">Event Submitted Successfully!</h2>
        <p style="color:#A1A1AA;line-height:1.6;font-size:15px;text-align:center;">
          Hello ${cleanOrg}, we have received your event submission <strong>"${cleanTitle}"</strong>.
        </p>

        <div style="margin:24px 0;padding:24px;background:#1C232B;border-radius:14px;border:1px solid #363F48;">
          <p style="margin:0 0 10px 0;color:#FFFFFF;font-weight:600;">What happens next?</p>
          <ul style="margin:0;padding-left:20px;color:#CBD5E1;font-size:14px;line-height:1.8;">
            <li>Our moderation board will review your event details within 24 hours.</li>
            <li>As soon as your event is approved, you will receive an email confirmation.</li>
            <li>Once approved, ticket configuration will unlock and your event will go live to attendees.</li>
          </ul>
        </div>

        <div style="text-align:center;margin:28px 0;">
          <a href="${hubLink}" style="display:inline-block;padding:12px 28px;background:#EFEFF1;color:#14191E;font-weight:bold;border-radius:8px;text-decoration:none;font-size:14px;">
            Track in Organizer Portal
          </a>
        </div>

        <p style="color:#64748B;font-size:12px;text-align:center;">
          Thank you for hosting with Tribes &amp; Cliqs.
        </p>
      </div>`,
    text: `Event Submitted for Review: "${eventTitle}"\n\nHello ${organizerName}, your event has been submitted and is currently under review by our operations team.\nYou will receive an email as soon as it is approved.\n\nTrack status: ${hubLink}`,
  });
};

/**
 * Organizer Alert: Admin requests changes before approving event.
 */
export const sendEventChangesRequestedEmail = async ({
  to,
  organizerName = 'Organizer',
  eventTitle = 'Live Event',
  eventId,
  feedback = 'Please review and adjust your event details.',
}) => {
  const cleanOrg = escapeHtml(organizerName);
  const cleanTitle = escapeHtml(eventTitle);
  const cleanFeedback = escapeHtml(feedback);
  const editLink = `${FRONTEND_URL}/organizer/events/${eventId}/edit`;

  return sendEmail({
    to,
    subject: `⚠️ Action Required: Changes requested for "${cleanTitle}" — Tribes & Cliqs`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <div style="text-align:center;margin-bottom:20px;">
          <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(239,68,68,0.15);color:#EF4444;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">
            Changes Requested
          </span>
        </div>
        <h2 style="margin-top:0;color:#FFFFFF;text-align:center;font-size:22px;">Modifications Needed</h2>
        <p style="color:#A1A1AA;line-height:1.6;font-size:15px;text-align:center;">
          Hello ${cleanOrg}, an administrator reviewed <strong>"${cleanTitle}"</strong> and requested changes before it can be published.
        </p>

        <div style="margin:24px 0;padding:20px;background:#1C232B;border-radius:14px;border-left:4px solid #CBD5E1;border:1px solid #363F48;">
          <p style="margin:0 0 8px 0;color:#EFEFF1;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Admin Review Feedback</p>
          <p style="margin:0;color:#E2E8F0;font-size:14px;line-height:1.6;white-space:pre-wrap;">${cleanFeedback}</p>
        </div>

        <div style="text-align:center;margin:28px 0;">
          <a href="${editLink}" style="display:inline-block;padding:12px 28px;background:#EFEFF1;color:#14191E;font-weight:bold;border-radius:8px;text-decoration:none;font-size:14px;">
            Edit &amp; Resubmit Event
          </a>
        </div>

        <p style="color:#64748B;font-size:12px;text-align:center;">
          If you have questions about this review, reply to this email or contact support.
        </p>
      </div>`,
    text: `Changes Requested for "${eventTitle}"\n\nFeedback: ${feedback}\n\nEdit and resubmit: ${editLink}`,
  });
};

/**
 * Attendee Alert: Urgent update dispatched to all registered ticket holders when an event changes or is cancelled.
 */
export const sendEventUrgentUpdateAlertEmail = async ({
  to,
  attendeeName = 'Attendee',
  eventTitle = 'Live Event',
  updateType = 'general', // 'venue_changed' | 'time_changed' | 'event_cancelled' | 'general'
  headline = 'Important Event Update',
  details = '',
  newVenue = null,
  newDate = null,
  newTime = null,
  eventId = null,
}) => {
  const cleanTitle = escapeHtml(eventTitle);
  const cleanName = escapeHtml(attendeeName);
  const cleanHeadline = escapeHtml(headline);
  const isCancelled = updateType === 'event_cancelled';
  const badgeColor = isCancelled ? '#EF4444' : '#CBD5E1';
  const badgeBg = isCancelled ? 'rgba(239,68,68,0.15)' : 'rgba(239,239,241,0.12)';
  const badgeText = isCancelled ? 'Event Cancelled' : 'Urgent Schedule / Venue Notice';
  const actionLink = eventId ? `${FRONTEND_URL}/events/${eventId}` : `${FRONTEND_URL}/tickets`;

  const detailsFormatted = escapeHtml(details)
    .split('\n')
    .filter((p) => p.trim())
    .map((p) => `<p style="margin:0 0 10px 0;color:#CBD5E1;font-size:14px;line-height:1.6;">${p}</p>`)
    .join('');

  return sendEmail({
    to,
    subject: `🚨 ${isCancelled ? '[Cancelled]' : '[Important Update]'} ${cleanTitle} — ${cleanHeadline}`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <div style="text-align:center;margin-bottom:20px;">
          <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:${badgeBg};color:${badgeColor};font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">
            ${badgeText}
          </span>
        </div>
        <h2 style="margin-top:0;color:#FFFFFF;text-align:center;font-size:22px;">${cleanHeadline}</h2>
        <p style="color:#A1A1AA;line-height:1.6;font-size:15px;text-align:center;">
          Hi ${cleanName}, we are writing with an urgent operational update regarding your tickets for <strong>"${cleanTitle}"</strong>.
        </p>

        <div style="margin:24px 0;padding:24px;background:#1C232B;border-radius:14px;border:1px solid #363F48;">
          ${detailsFormatted}

          ${(newVenue || newDate || newTime) ? `
            <div style="margin-top:16px;padding-top:16px;border-top:1px solid #363F48;">
              <p style="margin:0 0 8px 0;color:#FFFFFF;font-weight:600;font-size:13px;text-transform:uppercase;letter-spacing:1px;">New Event Information</p>
              ${newDate ? `<p style="margin:4px 0;color:#CBD5E1;font-size:14px;"><strong>Date:</strong> ${escapeHtml(newDate)}</p>` : ''}
              ${newTime ? `<p style="margin:4px 0;color:#CBD5E1;font-size:14px;"><strong>Time:</strong> ${escapeHtml(newTime)}</p>` : ''}
              ${newVenue ? `<p style="margin:4px 0;color:#CBD5E1;font-size:14px;"><strong>Venue:</strong> ${escapeHtml(newVenue)}</p>` : ''}
            </div>` : ''}
        </div>

        <div style="text-align:center;margin:28px 0;">
          <a href="${actionLink}" style="display:inline-block;padding:12px 28px;background:#EFEFF1;color:#14191E;font-weight:bold;border-radius:8px;text-decoration:none;font-size:14px;">
            ${isCancelled ? 'Review Ticket & Refund Info' : 'View Updated Event Page'}
          </a>
        </div>

        <p style="color:#64748B;font-size:12px;text-align:center;border-top:1px solid #2B333B;padding-top:16px;">
          You received this urgent alert because you hold an active ticket or reservation for this event on Tribes &amp; Cliqs.
        </p>
      </div>`,
    text: `Important Update for "${eventTitle}": ${headline}\n\n${details}\n${newVenue ? `New Venue: ${newVenue}\n` : ''}${newDate ? `New Date: ${newDate}\n` : ''}\nView details: ${actionLink}`,
  });
};

/**
 * Platform Admin Alert: Triggered when a new user applies to become an event organizer.
 */
export const sendAdminNewOrganizerApplicationAlertEmail = async ({
  to,
  organizerName = 'Applicant',
  organizerEmail = '',
  organizationName = '',
  phone = '',
  category = 'General',
}) => {
  const cleanOrg = escapeHtml(organizationName || organizerName);
  const cleanApplicant = escapeHtml(organizerName);
  const cleanEmail = escapeHtml(organizerEmail);
  const cleanPhone = escapeHtml(phone || 'N/A');
  const cleanCategory = escapeHtml(category || 'General');
  const reviewLink = `${FRONTEND_URL}/admin/organizers`;

  return sendEmail({
    to,
    subject: `👤 New Organizer Verification Request: ${cleanOrg}`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <div style="text-align:center;margin-bottom:20px;">
          <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(168,85,247,0.15);color:#C084FC;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">
            KYC Verification
          </span>
        </div>
        <h2 style="margin-top:0;color:#FFFFFF;text-align:center;font-size:22px;">New Organizer Application</h2>
        <p style="color:#A1A1AA;line-height:1.6;font-size:14px;text-align:center;">
          A user has submitted their organizer profile and is awaiting verification to publish events and sell passes.
        </p>

        <div style="margin:24px 0;padding:24px;background:#1C232B;border-radius:14px;border:1px solid #363F48;">
          <h3 style="margin:0 0 10px 0;color:#FFFFFF;font-size:18px;">${cleanOrg}</h3>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Contact Person:</strong> ${cleanApplicant}</p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Email:</strong> ${cleanEmail}</p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Phone:</strong> ${cleanPhone}</p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Category:</strong> ${cleanCategory}</p>
        </div>

        <div style="text-align:center;margin:28px 0;">
          <a href="${reviewLink}" style="display:inline-block;padding:12px 28px;background:#EFEFF1;color:#14191E;font-weight:bold;border-radius:8px;text-decoration:none;font-size:14px;">
            Review in Organizer Approvals
          </a>
        </div>

        <p style="color:#64748B;font-size:12px;text-align:center;">
          Tribes &amp; Cliqs Platform Compliance &amp; KYC Verification.
        </p>
      </div>`,
    text: `New Organizer Application: ${organizationName || organizerName}\nApplicant: ${organizerName}\nEmail: ${organizerEmail}\nPhone: ${phone}\nCategory: ${category}\n\nReview: ${reviewLink}`,
  });
};

export const sendOrganizerApprovalEmail = async (to, orgName) =>
  sendEmail({
    to,
    subject: 'Your organizer account is approved — Tribes & Cliqs',
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <h2 style="margin-top:0;color:#FFFFFF;">Congratulations, ${escapeHtml(orgName)}!</h2>
        <p style="color:#A1A1AA;line-height:1.6;">Your organizer account has been approved by platform administration. You can now create, publish, and sell tickets to unforgettable experiences.</p>
        <div style="text-align:center;margin:24px 0;">
          <a href="${FRONTEND_URL}/organizer" style="display:inline-block;padding:12px 28px;background:#EFEFF1;color:#14191E;font-weight:bold;border-radius:8px;text-decoration:none;font-size:14px;">Open Organizer Hub</a>
        </div>
      </div>`,
    text: `Your organizer account has been approved. You can now create and publish events at: ${FRONTEND_URL}/organizer`,
  });

export const sendEventApprovalEmail = async (to, event) => {
  const title = escapeHtml(event.title);
  const ticketsLink = `${FRONTEND_URL}/organizer/tickets?event=${event.id}`;
  const publicLink = eventLink(event.id);
  return sendEmail({
    to,
    subject: `Your event "${event.title}" has been approved! Start adding tickets — Tribes & Cliqs`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <h2 style="margin-top:0;color:#FFFFFF;">Your event is approved!</h2>
        <p style="color:#A1A1AA;line-height:1.6;"><strong>${title}</strong> has been approved by an administrator. You can now start creating and configuring ticket tiers (VIP, Early Bird, General Admission) and upload barcode passes.</p>
        <div style="text-align:center;margin:28px 0;display:flex;gap:12px;justify-content:center;">
          <a href="${ticketsLink}" style="display:inline-block;padding:12px 28px;background:#EFEFF1;color:#14191E;font-weight:bold;border-radius:8px;text-decoration:none;font-size:14px;">Start Adding Tickets</a>
        </div>
        <p style="color:#71717A;font-size:12px;text-align:center;">You can also preview your public event page <a href="${publicLink}" style="color:#CBD5E1;">here</a>.</p>
      </div>`,
    text: `Your event "${event.title}" has been approved by an administrator! You can now start adding ticket tiers: ${ticketsLink}`,
  });
};

export const sendEventRejectionEmail = async (to, event, reason) => {
  const title = escapeHtml(event.title);
  const rejectionReason = escapeHtml(reason || 'Not specified');
  const link = `${FRONTEND_URL}/organizer/events/${event.id}/edit`;
  return sendEmail({
    to,
    subject: `Your event "${event.title}" needs changes — Tribes & Cliqs`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <h2 style="margin-top:0;color:#FFFFFF;">Your event was not approved</h2>
        <p style="color:#A1A1AA;line-height:1.6;"><strong>${title}</strong> was reviewed and needs changes before it can go live.</p>
        <p style="color:#CBD5E1;"><strong>Reason:</strong> ${rejectionReason}</p>
        <div style="text-align:center;margin:24px 0;">
          <a href="${link}" style="display:inline-block;padding:12px 28px;background:#EFEFF1;color:#14191E;font-weight:bold;border-radius:8px;text-decoration:none;font-size:14px;">Edit &amp; Resubmit</a>
        </div>
      </div>`,
    text: `Your event "${event.title}" was not approved. Reason: ${reason || 'Not specified'}. Edit and resubmit here: ${link}`,
  });
};

export const sendMarketingEmail = async (to, subject, htmlContent) =>
  sendEmail({
    to,
    subject,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        ${htmlContent}
        <hr style="border:none;border-top:1px solid #2B333B;margin-top:24px;"><p style="color:#64748B;font-size:12px;">You received this email because you have an account with Tribes &amp; Cliqs.</p>
      </div>`,
    text: subject,
  });

export const sendTicketTransferEmail = async ({
  to,
  recipientName = 'Friend',
  senderName = 'A friend',
  eventTitle = 'Live Event',
  ticketNumber = '',
  ticketTier = 'General Admission',
  venue = 'Venue TBA',
  address = '',
  city = '',
  eventDate = 'Upcoming',
  startTime = '',
  qrCode = null,
  seatNumber = null,
  ticketUrl = null,
}) => {
  const link = ticketUrl || `${FRONTEND_URL}/my-tickets`;
  const cleanEvent = escapeHtml(eventTitle);
  const cleanSender = escapeHtml(senderName);
  const cleanRecipient = escapeHtml(recipientName);
  const fullVenue = [venue, address, city].filter(Boolean).join(', ') || 'Venue TBA';
  const cleanVenue = escapeHtml(fullVenue);
  const cleanDate = escapeHtml(eventDate);
  const cleanTime = escapeHtml(startTime);

  const qrData = encodeURIComponent(qrCode || ticketNumber);
  const qrUrl = ticketNumber
    ? `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${qrData}&margin=4`
    : null;

  return sendEmail({
    to,
    subject: `🎟️ You received a ticket from ${cleanSender} for "${cleanEvent}"!`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <div style="text-align:center;margin-bottom:24px;">
          <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(239,239,241,0.12);color:#EFEFF1;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">
            Ticket Transferred
          </span>
        </div>
        <h2 style="margin-top:0;color:#FFFFFF;text-align:center;font-size:22px;">You Got a Ticket! 🎉</h2>
        <p style="color:#A1A1AA;line-height:1.6;font-size:15px;text-align:center;">
          Hi ${cleanRecipient}, <strong>${cleanSender}</strong> has transferred an official entry ticket to you for:
        </p>

        <div style="margin:24px 0;padding:24px;background:#1C232B;border-radius:14px;border:1px solid #363F48;">
          <h3 style="margin:0 0 12px 0;color:#FFFFFF;font-size:18px;">${cleanEvent}</h3>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Pass Tier:</strong> ${escapeHtml(ticketTier)}</p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Date:</strong> ${cleanDate}${cleanTime ? ` at ${cleanTime}` : ''}</p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Venue:</strong> ${cleanVenue}</p>
          ${seatNumber ? `<p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Seat:</strong> ${escapeHtml(seatNumber)}</p>` : ''}
          ${ticketNumber ? `<p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Ticket Code:</strong> <code style="background:#242B32;padding:3px 6px;border-radius:4px;font-family:monospace;color:#CBD5E1;border:1px solid #363F48;">${escapeHtml(ticketNumber)}</code></p>` : ''}

          ${qrUrl ? `
            <div style="margin-top:20px;text-align:center;border-top:1px dashed #363F48;padding-top:18px;">
              <div style="background:#FFFFFF;padding:12px;border-radius:10px;display:inline-block;box-shadow:0 4px 12px rgba(0,0,0,0.25);">
                <img src="${qrUrl}" alt="Entry QR Code" width="160" height="160" style="display:block;margin:0 auto;border:0;" />
              </div>
              <p style="margin:10px 0 0 0;font-size:12px;color:#949599;">Show this QR code at the entrance for direct admission</p>
            </div>
          ` : ''}
        </div>

        <div style="text-align:center;margin:32px 0;">
          <a href="${link}" style="display:inline-block;padding:14px 32px;background:#EFEFF1;color:#14191E;font-weight:bold;border-radius:8px;text-decoration:none;font-size:15px;box-shadow:0 6px 16px rgba(0,0,0,0.3);">
            View My Ticket &amp; QR Pass
          </a>
        </div>

        <p style="color:#64748B;font-size:12px;text-align:center;line-height:1.5;margin-bottom:0;">
          Log into Tribes &amp; Cliqs with <strong>${escapeHtml(to)}</strong> to view, download, or present your entry QR code at the gates.
        </p>
      </div>`,
    text: `You received a ticket from ${senderName} for "${eventTitle}"!\n\nTicket: ${ticketNumber}\nVenue: ${fullVenue}\nDate: ${eventDate}\n\nAccess your ticket here: ${link}`,
  });
};

/**
 * Event Reminder Email sent to ticket holders before showtime.
 */
export const sendEventReminderEmail = async ({
  to,
  attendeeName = 'Attendee',
  eventTitle = 'Live Event',
  eventDate = 'Upcoming',
  startTime = '',
  venue = 'Venue TBA',
  address = '',
  city = '',
  tickets = [],
  eventId = null,
}) => {
  const cleanTitle = escapeHtml(eventTitle);
  const cleanAttendee = escapeHtml(attendeeName);
  const fullVenue = [venue, address, city].filter(Boolean).join(', ') || 'Venue TBA';
  const cleanVenue = escapeHtml(fullVenue);
  const cleanDate = escapeHtml(eventDate);
  const cleanTime = escapeHtml(startTime);
  const link = `${FRONTEND_URL}/my-tickets`;
  const mapsUrl = buildGoogleMapsUrl(venue, address, city);

  const ticketRows = Array.isArray(tickets) && tickets.length > 0
    ? tickets.map((t, idx) => {
        const ticketNum = t.ticket_number || t.code || `TC-${idx + 1}`;
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(t.qr_code || ticketNum)}&margin=4`;
        return `
          <div style="background:#1C232B;border-radius:12px;border:1px solid #363F48;padding:16px;margin-bottom:12px;text-align:center;">
            <div style="background:#FFFFFF;padding:10px;border-radius:8px;display:inline-block;">
              <img src="${qrUrl}" alt="QR Pass" width="140" height="140" style="display:block;margin:0 auto;border:0;" />
            </div>
            <p style="margin:8px 0 0 0;font-family:monospace;font-size:14px;color:#FFFFFF;font-weight:bold;">${escapeHtml(ticketNum)}</p>
            <p style="margin:2px 0 0 0;color:#CBD5E1;font-size:12px;">${escapeHtml(t.tier || t.tier_name || 'Pass')}</p>
          </div>
        `;
      }).join('')
    : '';

  return sendEmail({
    to,
    subject: `⏰ Reminder: "${cleanTitle}" is coming up! (${cleanDate})`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <div style="text-align:center;margin-bottom:20px;">
          <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(239,239,241,0.12);color:#EFEFF1;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">
            Event Reminder
          </span>
        </div>
        <h2 style="margin-top:0;color:#FFFFFF;text-align:center;font-size:22px;">Get Ready for ${cleanTitle}! 🎉</h2>
        <p style="color:#A1A1AA;line-height:1.6;font-size:15px;text-align:center;">
          Hi ${cleanAttendee}, your event is just around the corner. Here are your event details and entry passes.
        </p>

        <div style="margin:24px 0;padding:22px;background:#1C232B;border-radius:14px;border:1px solid #363F48;">
          <h3 style="margin:0 0 10px 0;color:#FFFFFF;font-size:18px;">${cleanTitle}</h3>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Date:</strong> ${cleanDate}${cleanTime ? ` at ${cleanTime}` : ''}</p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Venue:</strong> ${cleanVenue}</p>
          ${mapsUrl ? `<div style="margin-top:12px;"><a href="${mapsUrl}" target="_blank" style="color:#10B981;font-size:13px;text-decoration:none;font-weight:bold;">&#128205; View Venue on Google Maps &rarr;</a></div>` : ''}
        </div>

        ${ticketRows ? `<div style="margin:20px 0;">${ticketRows}</div>` : ''}

        <div style="text-align:center;margin:28px 0;">
          <a href="${link}" style="display:inline-block;padding:12px 28px;background:#EFEFF1;color:#14191E;font-weight:bold;border-radius:8px;text-decoration:none;font-size:14px;">
            Open Live Pass in App
          </a>
        </div>

        <p style="color:#64748B;font-size:12px;line-height:1.5;margin-bottom:0;text-align:center;border-top:1px solid #2B333B;padding-top:16px;">
          Have your ticket QR code ready when arriving at the gate. Enjoy the experience!
        </p>
      </div>`,
    text: `Reminder: "${eventTitle}" is coming up on ${eventDate}${startTime ? ` at ${startTime}` : ''} at ${fullVenue}!\n\nAccess your passes: ${link}`,
  });
};

export const sendEventInviteEmail = async ({
  to,
  recipientName = 'Friend',
  senderName = 'A friend',
  eventTitle = 'Live Event',
  venue = 'Venue TBA',
  eventDate = 'Upcoming',
  note = null,
  eventUrl = null,
}) => {
  const link = eventUrl || `${FRONTEND_URL}/events`;
  const cleanEvent = escapeHtml(eventTitle);
  const cleanSender = escapeHtml(senderName);
  const cleanRecipient = escapeHtml(recipientName);

  return sendEmail({
    to,
    subject: `✨ ${cleanSender} invited you to "${cleanEvent}"!`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <div style="text-align:center;margin-bottom:24px;">
          <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(239,239,241,0.12);color:#EFEFF1;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">Event Invitation</span>
        </div>
        <h2 style="margin-top:0;color:#FFFFFF;text-align:center;font-size:22px;">You're Invited!</h2>
        <p style="color:#A1A1AA;line-height:1.6;font-size:15px;text-align:center;">
          Hi ${cleanRecipient}, <strong>${cleanSender}</strong> wants you to join their Tribe at:
        </p>

        <div style="margin:24px 0;padding:24px;background:#1C232B;border-radius:14px;border:1px solid #363F48;">
          <h3 style="margin:0 0 12px 0;color:#FFFFFF;font-size:18px;">${cleanEvent}</h3>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Date:</strong> ${escapeHtml(eventDate)}</p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Venue:</strong> ${escapeHtml(venue)}</p>
          ${note ? `<div style="margin-top:14px;padding:12px;border-radius:8px;background:#14191E;border-left:3px solid #EFEFF1;color:#E2E8F0;font-style:italic;font-size:13px;">"${escapeHtml(note)}"</div>` : ''}
        </div>

        <div style="text-align:center;margin:32px 0;">
          <a href="${link}" style="display:inline-block;padding:14px 32px;background:#EFEFF1;color:#14191E;font-weight:bold;border-radius:8px;text-decoration:none;font-size:15px;">
            View Event &amp; Join In
          </a>
        </div>

        <p style="color:#64748B;font-size:12px;text-align:center;line-height:1.5;margin-bottom:0;">
          Discover more upcoming experiences and connect with your Tribe on Tribes &amp; Cliqs.
        </p>
      </div>`,
    text: `${senderName} invited you to "${eventTitle}"!\n\nVenue: ${venue}\nDate: ${eventDate}\n${note ? `Note: "${note}"\n` : ''}\nView event details: ${link}`,
  });
};

/**
 * User Confirmation: Sent when a user submits a support ticket.
 */
export const sendSupportTicketCreatedEmail = async ({
  to,
  userName = 'Member',
  ticketId,
  reference = '',
  subject = '',
  category = 'General',
  priority = 'medium',
}) => {
  const cleanName = escapeHtml(userName);
  const cleanSubj = escapeHtml(subject);
  const cleanRef = escapeHtml(reference || `#${ticketId}`);
  const cleanCat = escapeHtml(category);
  const ticketLink = `${FRONTEND_URL}/attendee/support`;

  return sendEmail({
    to,
    subject: `🎫 Support Ticket Received: [${cleanRef}] ${cleanSubj}`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <div style="text-align:center;margin-bottom:20px;">
          <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(59,130,246,0.15);color:#60A5FA;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">
            Support Request Logged
          </span>
        </div>
        <h2 style="margin-top:0;color:#FFFFFF;text-align:center;font-size:22px;">We're on It!</h2>
        <p style="color:#A1A1AA;line-height:1.6;font-size:14px;text-align:center;">
          Hello ${cleanName}, thank you for contacting Tribes &amp; Cliqs customer care. We have registered your support request.
        </p>

        <div style="margin:24px 0;padding:24px;background:#1C232B;border-radius:14px;border:1px solid #363F48;">
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Ticket Ref:</strong> <code style="font-family:monospace;color:#CBD5E1;background:#242B32;padding:2px 6px;border-radius:4px;border:1px solid #363F48;">${cleanRef}</code></p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Subject:</strong> ${cleanSubj}</p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Category:</strong> ${cleanCat}</p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Priority:</strong> <span style="text-transform:capitalize;">${escapeHtml(priority)}</span></p>
        </div>

        <p style="color:#CBD5E1;font-size:13px;line-height:1.6;">
          Our dedicated operations team is investigating your inquiry. You will receive an email as soon as an agent replies.
        </p>

        <div style="text-align:center;margin:28px 0;">
          <a href="${ticketLink}" style="display:inline-block;padding:12px 28px;background:#EFEFF1;color:#14191E;font-weight:bold;border-radius:8px;text-decoration:none;font-size:14px;">
            View Support Thread
          </a>
        </div>

        <p style="color:#64748B;font-size:12px;text-align:center;">
          Tribes &amp; Cliqs Helpdesk Operations.
        </p>
      </div>`,
    text: `Support Request Logged: [${reference || ticketId}] ${subject}\n\nHello ${userName}, we received your ticket.\nCategory: ${category}\nPriority: ${priority}\n\nTrack your ticket: ${ticketLink}`,
  });
};

/**
 * Admin Alert: Sent to platform staff when a new support ticket is opened.
 */
export const sendAdminNewSupportTicketEmail = async ({
  to,
  userName = 'Member',
  userEmail = '',
  ticketId,
  reference = '',
  subject = '',
  message = '',
  category = 'General',
  priority = 'medium',
}) => {
  const cleanName = escapeHtml(userName);
  const cleanEmail = escapeHtml(userEmail);
  const cleanSubj = escapeHtml(subject);
  const cleanRef = escapeHtml(reference || `#${ticketId}`);
  const cleanMsg = escapeHtml(message.slice(0, 300));
  const isUrgent = priority === 'urgent' || priority === 'high';
  const badgeColor = isUrgent ? '#EF4444' : '#CBD5E1';
  const badgeBg = isUrgent ? 'rgba(239,68,68,0.15)' : 'rgba(239,239,241,0.12)';
  const adminLink = `${FRONTEND_URL}/admin/support`;

  return sendEmail({
    to,
    subject: `🚨 [Support ${priority.toUpperCase()}] ${cleanRef}: ${cleanSubj}`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <div style="text-align:center;margin-bottom:20px;">
          <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:${badgeBg};color:${badgeColor};font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">
            ${priority.toUpperCase()} Support Ticket
          </span>
        </div>
        <h2 style="margin-top:0;color:#FFFFFF;text-align:center;font-size:22px;">New Support Inquiry</h2>
        <p style="color:#A1A1AA;line-height:1.6;font-size:14px;text-align:center;">
          A customer has submitted a new support ticket requiring assistance.
        </p>

        <div style="margin:24px 0;padding:24px;background:#1C232B;border-radius:14px;border:1px solid #363F48;">
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Ticket:</strong> <code style="font-family:monospace;color:#CBD5E1;background:#242B32;padding:2px 6px;border-radius:4px;border:1px solid #363F48;">${cleanRef}</code></p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>User:</strong> ${cleanName} (${cleanEmail})</p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Category:</strong> ${escapeHtml(category)}</p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Subject:</strong> ${cleanSubj}</p>
          <div style="margin-top:12px;padding:12px;background:#14191E;border-radius:8px;border:1px solid #2B333B;color:#CBD5E1;font-size:13px;line-height:1.5;">
            ${cleanMsg}${message.length > 300 ? '...' : ''}
          </div>
        </div>

        <div style="text-align:center;margin:28px 0;">
          <a href="${adminLink}" style="display:inline-block;padding:12px 28px;background:#EFEFF1;color:#14191E;font-weight:bold;border-radius:8px;text-decoration:none;font-size:14px;">
            Open in Support Center
          </a>
        </div>
      </div>`,
    text: `New Support Ticket [${priority.toUpperCase()}]: ${cleanRef}\nUser: ${userName} (${userEmail})\nSubject: ${subject}\n\n${message}\n\nOpen Helpdesk: ${adminLink}`,
  });
};

/**
 * User Alert: Sent when support staff responds to a ticket.
 */
export const sendSupportTicketReplyEmail = async ({
  to,
  userName = 'Member',
  ticketId,
  reference = '',
  subject = '',
  replyMessage = '',
  staffName = 'Tribes & Cliqs Support',
}) => {
  const cleanName = escapeHtml(userName);
  const cleanSubj = escapeHtml(subject);
  const cleanRef = escapeHtml(reference || `#${ticketId}`);
  const cleanStaff = escapeHtml(staffName);
  const cleanReply = escapeHtml(replyMessage)
    .split('\n')
    .filter((p) => p.trim())
    .map((p) => `<p style="margin:0 0 10px 0;color:#CBD5E1;font-size:14px;line-height:1.6;">${p}</p>`)
    .join('');
  const ticketLink = `${FRONTEND_URL}/attendee/support`;

  return sendEmail({
    to,
    subject: `💬 New Reply on Ticket [${cleanRef}]: ${cleanSubj}`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <div style="text-align:center;margin-bottom:20px;">
          <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(16,185,129,0.15);color:#10B981;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">
            Support Staff Response
          </span>
        </div>
        <h2 style="margin-top:0;color:#FFFFFF;text-align:center;font-size:22px;">New Message from Support</h2>
        <p style="color:#A1A1AA;line-height:1.6;font-size:14px;text-align:center;">
          Hello ${cleanName}, an agent has replied to your inquiry <strong>"${cleanSubj}"</strong>.
        </p>

        <div style="margin:24px 0;padding:24px;background:#1C232B;border-radius:14px;border:1px solid #363F48;">
          <p style="margin:0 0 12px 0;color:#FFFFFF;font-size:13px;font-weight:600;">Reply from ${cleanStaff}:</p>
          ${cleanReply}
        </div>

        <div style="text-align:center;margin:28px 0;">
          <a href="${ticketLink}" style="display:inline-block;padding:12px 28px;background:#EFEFF1;color:#14191E;font-weight:bold;border-radius:8px;text-decoration:none;font-size:14px;">
            Reply to Ticket
          </a>
        </div>

        <p style="color:#64748B;font-size:12px;text-align:center;">
          You can continue this conversation anytime directly in your account support portal.
        </p>
      </div>`,
    text: `Support Response [${cleanRef}]: ${subject}\n\nFrom: ${staffName}\n\n${replyMessage}\n\nView and reply: ${ticketLink}`,
  });
};

/**
 * User Alert: Sent when a support ticket is resolved.
 */
export const sendSupportTicketResolvedEmail = async ({
  to,
  userName = 'Member',
  ticketId,
  reference = '',
  subject = '',
}) => {
  const cleanName = escapeHtml(userName);
  const cleanSubj = escapeHtml(subject);
  const cleanRef = escapeHtml(reference || `#${ticketId}`);
  const ticketLink = `${FRONTEND_URL}/attendee/support`;

  return sendEmail({
    to,
    subject: `✅ Ticket Resolved [${cleanRef}]: ${cleanSubj}`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <div style="text-align:center;margin-bottom:20px;">
          <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(16,185,129,0.15);color:#10B981;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">
            Ticket Resolved
          </span>
        </div>
        <h2 style="margin-top:0;color:#FFFFFF;text-align:center;font-size:22px;">Issue Resolved!</h2>
        <p style="color:#A1A1AA;line-height:1.6;font-size:14px;text-align:center;">
          Hello ${cleanName}, your support ticket <strong>[${cleanRef}] ${cleanSubj}</strong> has been marked as resolved by our team.
        </p>

        <p style="color:#CBD5E1;font-size:14px;text-align:center;line-height:1.6;margin:20px 0;">
          If you have further questions or if this issue requires additional attention, you can reopen this ticket by simply replying.
        </p>

        <div style="text-align:center;margin:28px 0;">
          <a href="${ticketLink}" style="display:inline-block;padding:12px 28px;background:#EFEFF1;color:#14191E;font-weight:bold;border-radius:8px;text-decoration:none;font-size:14px;">
            Open Support Portal
          </a>
        </div>
      </div>`,
    text: `Ticket Resolved [${cleanRef}]: ${subject}\n\nHello ${userName}, your ticket has been resolved.\nIf you still need assistance, you can reply directly: ${ticketLink}`,
  });
};

export default sendEmail;

