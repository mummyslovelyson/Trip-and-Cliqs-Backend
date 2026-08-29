import { getEmailConfig } from './settings.js';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

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
        console.log(`✅ [email] Email sent via Resend to ${to} (${subject})`);
        return true;
      }
    }

    const transport = getSmtpTransport(cfg);
    if (transport) {
      await transport.sendMail({ from, to, subject, html, text });
      console.log(`✅ [email] Email sent via SMTP to ${to} (${subject})`);
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

export const sendVerificationEmail = async (to, token, otp = null) => {
  const link = `${FRONTEND_URL}/verify-email?token=${token}${to ? `&email=${encodeURIComponent(to)}` : ''}`;
  const otpSection = otp
    ? `
      <div style="margin:24px 0;padding:20px;background:#1E252B;border-radius:12px;border:1px solid #323A42;text-align:center;">
        <p style="color:#949599;font-size:13px;margin:0 0 8px 0;text-transform:uppercase;letter-spacing:1px;">Your 6-Digit Verification Code</p>
        <div style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#FFFFFF;font-family:monospace;">${otp}</div>
        <p style="color:#64748b;font-size:12px;margin:8px 0 0 0;">Valid for 15 minutes</p>
      </div>`
    : '';

  return sendEmail({
    to,
    subject: otp ? `Your Verification Code: ${otp} — Tribes & Cliqs` : 'Verify your email — Tribes & Cliqs',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;background:#14191E;color:#EFEFF1;padding:32px;border-radius:16px;border:1px solid #2B333B;">
        <h2 style="margin-top:0;color:#FFFFFF;">Welcome to Tribes &amp; Cliqs!</h2>
        <p style="color:#A1A1AA;line-height:1.6;">Please use the verification code below or click the button to verify your account.</p>
        ${otpSection}
        <div style="text-align:center;margin:28px 0;">
          <a href="${link}" style="display:inline-block;padding:12px 28px;background:#FFFFFF;color:#14191E;font-weight:600;border-radius:8px;text-decoration:none;font-size:14px;">Verify Account</a>
        </div>
        <p style="color:#64748B;font-size:12px;line-height:1.5;margin-bottom:0;">If you did not request this email, you can safely ignore it.</p>
      </div>`,
    text: otp
      ? `Welcome to Tribes & Cliqs!\n\nYour 6-digit verification code is: ${otp}\n(Valid for 15 minutes)\n\nOr click here to verify: ${link}`
      : `Welcome to Tribes & Cliqs! Verify your email: ${link}`,
  });
};

export const sendPasswordResetEmail = async (to, token) => {
  const link = `${FRONTEND_URL}/reset-password?token=${token}`;
  return sendEmail({
    to,
    subject: 'Reset your password — Tribes & Cliqs',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
        <h2>Password Reset</h2>
        <p>You requested a password reset. Click below to choose a new password.</p>
        <p><a href="${link}" style="display:inline-block;padding:10px 20px;background:#6d28d9;color:#fff;border-radius:6px;text-decoration:none">Reset Password</a></p>
        <p style="color:#666;font-size:13px">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
      </div>`,
    text: `Reset your password: ${link}`,
  });
};

export const sendTicketConfirmationEmail = async (to, order) => {
  const lines = (order.items || [])
    .map((i) => `<li>${i.quantity} × ${i.name} — ${i.subtotal}</li>`)
    .join('');
  return sendEmail({
    to,
    subject: `Your tickets for ${order.eventTitle || 'your event'} — Tribes & Cliqs`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
        <h2>Order Confirmed 🎉</h2>
        <p>Thank you for your purchase. Your order reference is <strong>${order.reference}</strong>.</p>
        <h3>Items</h3>
        <ul>${lines}</ul>
        <p><strong>Total:</strong> ${order.total}</p>
        <p>You can view and download your tickets from your account.</p>
      </div>`,
    text: `Order confirmed. Reference: ${order.reference}`,
  });
};

export const sendOrganizerApprovalEmail = async (to, orgName) =>
  sendEmail({
    to,
    subject: 'Your organizer account is approved — Tribes & Cliqs',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
        <h2>Congratulations, ${orgName}!</h2>
        <p>Your organizer account has been approved. You can now create and publish events.</p>
      </div>`,
    text: `Your organizer account has been approved. You can now create and publish events.`,
  });

// Escape user-supplied text for safe embedding in HTML emails.
const escapeHtml = (value) =>
  String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const eventLink = (eventId) => `${FRONTEND_URL}/events/${eventId}`;

export const sendEventApprovalEmail = async (to, event) => {
  const title = escapeHtml(event.title);
  const link = eventLink(event.id);
  return sendEmail({
    to,
    subject: `Your event "${event.title}" is live — Tribes & Cliqs`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
        <h2>Your event is live! 🎉</h2>
        <p><strong>${title}</strong> has been approved and is now visible to everyone on Tribes & Cliqs.</p>
        <p><a href="${link}" style="display:inline-block;padding:10px 20px;background:#6d28d9;color:#fff;border-radius:6px;text-decoration:none">View Event</a></p>
        <p style="color:#666;font-size:13px">You can manage tickets and attendees from your organizer dashboard.</p>
      </div>`,
    text: `Your event "${event.title}" has been approved and is now live. View it here: ${link}`,
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
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
        <h2>Your event was not approved</h2>
        <p><strong>${title}</strong> was reviewed and needs changes before it can go live.</p>
        <p><strong>Reason:</strong> ${rejectionReason}</p>
        <p><a href="${link}" style="display:inline-block;padding:10px 20px;background:#6d28d9;color:#fff;border-radius:6px;text-decoration:none">Edit & Resubmit</a></p>
        <p style="color:#666;font-size:13px">Make the requested changes, then submit the event for review again.</p>
      </div>`,
    text: `Your event "${event.title}" was not approved. Reason: ${reason || 'Not specified'}. Edit and resubmit here: ${link}`,
  });
};

export const sendWelcomeEmail = async (to, name) =>
  sendEmail({
    to,
    subject: 'Welcome to Tribes & Cliqs!',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
        <h2>Hi ${name},</h2>
        <p>Welcome to Tribes &amp; Cliqs — your home for discovering and hosting unforgettable events.</p>
      </div>`,
    text: `Hi ${name}, welcome to Tribes & Cliqs!`,
  });

export const sendMarketingEmail = async (to, subject, htmlContent) =>
  sendEmail({
    to,
    subject,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
        ${htmlContent}
        <hr><p style="color:#999;font-size:12px">You received this email because you have an account with Tribes &amp; Cliqs.</p>
      </div>`,
    text: subject,
  });

export default sendEmail;
