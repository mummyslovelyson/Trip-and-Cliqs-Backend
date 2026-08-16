import nodemailer from 'nodemailer';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'no-reply@tribesandcliqs.com';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// Lazily-initialised Resend client. The `resend` package is optional; when it
// is not installed we fall back to SMTP via nodemailer. Resolved on first use
// so the server never crashes at boot if the package is missing.
let resendClient = null;
let resendChecked = false;

const getResend = async () => {
  if (resendChecked) return resendClient;
  resendChecked = true;
  if (!RESEND_API_KEY) return null;
  try {
    const { Resend } = await import('resend');
    resendClient = new Resend(RESEND_API_KEY);
    return resendClient;
  } catch {
    console.warn('[email] "resend" package not installed — falling back to SMTP.');
    return null;
  }
};

const smtpTransport = () => {
  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: (process.env.SMTP_SECURE || 'false') === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
  }
  return null;
};

/**
 * Send an email. Tries Resend first, then SMTP, then silently no-ops.
 * @param {{ to: string, subject: string, html?: string, text?: string }} opts
 */
export const sendEmail = async ({ to, subject, html, text }) => {
  try {
    if (RESEND_API_KEY) {
      const resend = await getResend();
      if (resend) {
        const { error } = await resend.emails.send({
          from: FROM_EMAIL,
          to,
          subject,
          html,
          text,
        });
        if (error) throw error;
        return true;
      }
    }

    const transport = smtpTransport();
    if (transport) {
      await transport.sendMail({ from: FROM_EMAIL, to, subject, html, text });
      return true;
    }

    // No provider configured — log so devs can see the email locally.
    console.warn('[email] No provider configured — email not sent:', { to, subject });
    return false;
  } catch (err) {
    console.error('[email] sendEmail failed:', err.message);
    return false;
  }
};

/* ------------------------------------------------------------------ *
 * Templated helpers
 * ------------------------------------------------------------------ */

export const sendVerificationEmail = async (to, token) => {
  const link = `${FRONTEND_URL}/verify-email?token=${token}`;
  return sendEmail({
    to,
    subject: 'Verify your email — Tribes & Cliqs',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
        <h2>Welcome to Tribes &amp; Cliqs!</h2>
        <p>Please verify your email address to activate your account.</p>
        <p><a href="${link}" style="display:inline-block;padding:10px 20px;background:#6d28d9;color:#fff;border-radius:6px;text-decoration:none">Verify Email</a></p>
        <p style="color:#666;font-size:13px">If the button doesn't work, copy this link:<br>${link}</p>
      </div>`,
    text: `Welcome to Tribes & Cliqs! Verify your email: ${link}`,
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
