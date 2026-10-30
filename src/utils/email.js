import { getEmailConfig } from './settings.js';

const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim().replace(/\/+$/, '');

let resendClient = null;
let lastResendKey = '';

const getResend = async (key) => {
  if (!key) return null;
  if (resendClient && lastResendKey === key) return resendClient;
  try {
    const { Resend } = await import('resend');
    resendClient = new Resend(key);
    lastResendKey = key;
    return resendClient;
  } catch {
    console.warn('[email] "resend" package not installed — falling back to SMTP.');
    return null;
  }
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
 * @param {{ to: string, subject: string, html?: string, text?: string }} opts
 */
export const sendEmail = async ({ to, subject, html, text }) => {
  try {
    const cfg = await getEmailConfig();
    const from = cfg.fromName ? `"${cfg.fromName}" <${cfg.fromEmail}>` : cfg.fromEmail;

    if (cfg.resendKey) {
      const resend = await getResend(cfg.resendKey);
      if (resend) {
        const { error } = await resend.emails.send({
          from,
          to,
          subject,
          html,
          text,
        });
        if (error) throw error;
        console.log(`[email] Email sent via Resend to ${to} (${subject})`);
        return true;
      }
    }

    const transport = getSmtpTransport(cfg);
    if (transport) {
      await transport.sendMail({ from, to, subject, html, text });
      console.log(`[email] Email sent via SMTP to ${to} (${subject})`);
      return true;
    }

    // No provider configured — log so devs can see the email locally.
    console.warn('[email] No provider configured (RESEND_API_KEY or SMTP_HOST missing in .env / system_settings) — email not sent:', { to, subject });
    return false;
  } catch (err) {
    console.error('[email] sendEmail failed:', err.message);
    return false;
  }
};

/* ------------------------------------------------------------------ *
 * Templated helpers
 * ------------------------------------------------------------------ */

// Escape user-supplied text for safe embedding in HTML emails.
const escapeHtml = (value) =>
  String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const eventLink = (eventId) => `${FRONTEND_URL}/events/${eventId}`;

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
  const cleanVenue = escapeHtml(order.venue || 'Venue TBA');
  const cleanDate = escapeHtml(order.eventDate || order.date || 'Upcoming');
  const attendeeName = escapeHtml(order.attendeeName || 'Guest');
  const link = `${FRONTEND_URL}/my-tickets`;

  const ticketRows = Array.isArray(order.tickets) && order.tickets.length > 0
    ? order.tickets.map((t) => `
        <div style="padding:12px;background:#14191E;border-radius:8px;border:1px solid #2B333B;margin-top:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong style="color:#FFFFFF;font-size:14px;">${escapeHtml(t.tier || t.tier_name || 'Pass')}</strong>
            <span style="font-family:monospace;background:#242B32;padding:2px 6px;border-radius:4px;color:#FBBF24;font-size:12px;">${escapeHtml(t.ticket_number || t.code || '')}</span>
          </div>
          ${t.attendee_name ? `<p style="margin:4px 0 0 0;color:#949599;font-size:12px;">Holder: ${escapeHtml(t.attendee_name)}</p>` : ''}
        </div>
      `).join('')
    : (order.items || []).map((i) => `
        <div style="padding:8px 0;border-bottom:1px solid #2B333B;color:#CBD5E1;font-size:13px;">
          ${escapeHtml(i.quantity)} × ${escapeHtml(i.name)} — ${escapeHtml(i.subtotal)}
        </div>
      `).join('');

  return sendEmail({
    to,
    subject: `🎟️ Your Tickets for "${cleanTitle}" — Tribes & Cliqs`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <div style="text-align:center;margin-bottom:20px;">
          <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(16,185,129,0.15);color:#10B981;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">Order Confirmed</span>
        </div>
        <h2 style="margin-top:0;color:#FFFFFF;text-align:center;font-size:24px;">You're Going! 🎟️</h2>
        <p style="color:#A1A1AA;line-height:1.6;font-size:15px;text-align:center;">
          Hi ${attendeeName}, thank you for your purchase. Your digital tickets and entry pass are ready.
        </p>

        <div style="margin:24px 0;padding:24px;background:#1C232B;border-radius:14px;border:1px solid #363F48;">
          <h3 style="margin:0 0 10px 0;color:#FFFFFF;font-size:18px;">${cleanTitle}</h3>
          <p style="margin:4px 0;color:#CBD5E1;font-size:14px;"><strong>Date:</strong> ${cleanDate}</p>
          <p style="margin:4px 0;color:#CBD5E1;font-size:14px;"><strong>Venue:</strong> ${cleanVenue}</p>
          <p style="margin:4px 0;color:#CBD5E1;font-size:14px;"><strong>Order Ref:</strong> <code style="font-family:monospace;color:#FBBF24;">${cleanRef}</code></p>
          <p style="margin:4px 0;color:#CBD5E1;font-size:14px;"><strong>Total Paid:</strong> ${cleanTotal}</p>

          <div style="margin-top:16px;border-top:1px solid #363F48;padding-top:14px;">
            <p style="margin:0 0 6px 0;color:#949599;font-size:12px;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Your Entry Passes</p>
            ${ticketRows}
          </div>
        </div>

        <div style="text-align:center;margin:30px 0;display:flex;justify-content:center;gap:12px;flex-wrap:wrap;">
          <a href="${link}" style="display:inline-block;padding:14px 28px;background:#EFEFF1;color:#14191E;font-weight:bold;border-radius:8px;text-decoration:none;font-size:14px;box-shadow:0 6px 16px rgba(0,0,0,0.3);">
            View My Tickets &amp; QR Pass
          </a>
          <a href="${FRONTEND_URL}/receipt/${encodeURIComponent(order.reference || order.id)}" style="display:inline-block;padding:14px 28px;background:#242B32;color:#FFFFFF;font-weight:bold;border-radius:8px;text-decoration:none;font-size:14px;border:1px solid #494F55;">
            Official Receipt
          </a>
        </div>

        <div style="background:#1C232B;padding:16px;border-radius:10px;border:1px solid #363F48;margin-bottom:24px;">
          <p style="margin:0;color:#CBD5E1;font-size:13px;line-height:1.5;">
            <strong>Gate Admission Tip:</strong> Have your QR pass ready on your phone or printed before reaching the gate. The gate scanner will scan your code for instant entry.
          </p>
        </div>

        <p style="color:#64748B;font-size:12px;line-height:1.5;margin-bottom:0;text-align:center;">
          Questions about this event? Contact the event organizer via the event page or reach out to Tribes &amp; Cliqs support.
        </p>
      </div>`,
    text: `Order Confirmed! Your tickets for "${cleanTitle}" are ready.\n\nOrder Ref: ${cleanRef}\nTotal: ${cleanTotal}\nVenue: ${cleanVenue}\nDate: ${cleanDate}\n\nAccess your QR tickets here: ${link}\nOfficial Receipt: ${FRONTEND_URL}/receipt/${encodeURIComponent(order.reference || order.id)}`,
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
          <p style="margin:4px 0;color:#CBD5E1;font-size:14px;"><strong>Ticket #:</strong> <code style="font-family:monospace;color:#FBBF24;">${escapeHtml(ticketNumber)}</code></p>
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
 * Announcement broadcast email sent to attendees or users.
 */
export const sendAnnouncementEmail = async ({
  to,
  recipientName = 'Tribe Member',
  title = 'Important Announcement',
  message = '',
  senderName = 'Tribes & Cliqs',
  link = null,
  eventTitle = null,
}) => {
  const cleanTitle = escapeHtml(title);
  const cleanRecipient = escapeHtml(recipientName);
  const cleanSender = escapeHtml(senderName);
  const cleanEvent = eventTitle ? escapeHtml(eventTitle) : null;
  const actionLink = link || (eventTitle ? `${FRONTEND_URL}/events` : `${FRONTEND_URL}`);

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
          <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(234,179,8,0.15);color:#FBBF24;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">
            ${cleanEvent ? `Event Broadcast • ${cleanEvent}` : 'Platform Announcement'}
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
            View Details
          </a>
        </div>

        <p style="color:#64748B;font-size:12px;line-height:1.5;margin-bottom:0;text-align:center;border-top:1px solid #2B333B;padding-top:16px;">
          You received this update because you are registered for this event or have an account on Tribes &amp; Cliqs.
        </p>
      </div>`,
    text: `${title}\nFrom: ${senderName}${eventTitle ? ` (${eventTitle})` : ''}\n\n${message}\n\nView details: ${actionLink}`,
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
  eventDate = 'Upcoming',
  ticketUrl = null,
}) => {
  const link = ticketUrl || `${FRONTEND_URL}/my-tickets`;
  const cleanEvent = escapeHtml(eventTitle);
  const cleanSender = escapeHtml(senderName);
  const cleanRecipient = escapeHtml(recipientName);
  const cleanVenue = escapeHtml(venue);

  return sendEmail({
    to,
    subject: `🎟️ You received a ticket from ${cleanSender} for "${cleanEvent}"!`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:580px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <div style="text-align:center;margin-bottom:24px;">
          <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(239,239,241,0.12);color:#EFEFF1;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">Ticket Transferred</span>
        </div>
        <h2 style="margin-top:0;color:#FFFFFF;text-align:center;font-size:22px;">You Got a Ticket!</h2>
        <p style="color:#A1A1AA;line-height:1.6;font-size:15px;text-align:center;">
          Hi ${cleanRecipient}, <strong>${cleanSender}</strong> has transferred an official entry ticket to you for:
        </p>

        <div style="margin:24px 0;padding:24px;background:#1C232B;border-radius:14px;border:1px solid #363F48;">
          <h3 style="margin:0 0 12px 0;color:#FFFFFF;font-size:18px;">${cleanEvent}</h3>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Ticket Tier:</strong> ${escapeHtml(ticketTier)}</p>
          ${ticketNumber ? `<p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Ticket #:</strong> <code style="background:#111417;padding:3px 6px;border-radius:4px;font-family:monospace;color:#FBBF24;">${escapeHtml(ticketNumber)}</code></p>` : ''}
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Date:</strong> ${escapeHtml(eventDate)}</p>
          <p style="margin:6px 0;color:#CBD5E1;font-size:14px;"><strong>Venue:</strong> ${cleanVenue}</p>
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
    text: `You received a ticket from ${senderName} for "${eventTitle}"!\n\nTicket: ${ticketNumber}\nVenue: ${venue}\nDate: ${eventDate}\n\nAccess your ticket here: ${link}`,
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
          <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(234,179,8,0.15);color:#FBBF24;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">Event Invitation</span>
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

export default sendEmail;

