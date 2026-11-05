import pool from '../config/db.js';
import { sendEventReminderEmail } from './email.js';

// Reminders go out when the event starts within this window (24 hours).
const REMINDER_WINDOW_HOURS = 24;

const pad = (n) => String(n).padStart(2, '0');
const toDateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Send in-app and email event reminders to every active ticket holder whose event
 * starts within the reminder window (24 hours).
 *
 * Each (user, event) pair is notified once — deduplicated by an existing
 * reminder record carrying the event link.
 *
 * Returns { created, emailed, skipped } so callers and logs can monitor health.
 */
export async function runReminderJob() {
  try {
    const today = toDateStr(new Date());
    const tomorrow = toDateStr(new Date(Date.now() + REMINDER_WINDOW_HOURS * 60 * 60 * 1000));

    // Retrieve distinct ticket holders for active or valid tickets
    const [holders] = await pool.execute(
      `SELECT DISTINCT t.user_id, t.event_id,
              COALESCE(t.attendee_name, u.name, 'Attendee') AS attendee_name,
              COALESCE(t.attendee_email, u.email) AS attendee_email
       FROM tickets t
       LEFT JOIN users u ON u.id = t.user_id
       WHERE t.status IN ('valid', 'active')`
    );
    const holdersList = Array.isArray(holders) ? holders : [];
    if (!holdersList.length) return { created: 0, emailed: 0, skipped: 0 };

    // Group holders by event to avoid re-fetching event rows
    const holdersByEvent = new Map();
    for (const h of holdersList) {
      if (h.user_id == null) continue;
      if (!holdersByEvent.has(h.event_id)) holdersByEvent.set(h.event_id, []);
      holdersByEvent.get(h.event_id).push(h);
    }

    let created = 0;
    let emailed = 0;
    let skipped = 0;

    for (const [eventId, eventHolders] of holdersByEvent) {
      const [eventRows] = await pool.execute(
        `SELECT id, title, venue, address, city, start_date, start_time FROM events
         WHERE id = ? AND status = 'published' AND start_date >= ? AND start_date <= ?`,
        [eventId, today, tomorrow],
      );
      const event = eventRows[0];
      if (!event) continue;

      const startsAt = new Date(`${event.start_date}T${event.start_time || '00:00'}`);
      const when = startsAt.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      const where = event.venue ? ` at ${event.venue}` : (event.city ? ` in ${event.city}` : '');
      const link = `/events/${eventId}`;

      for (const holder of eventHolders) {
        const userId = holder.user_id;

        // Check user preferences
        const [prefRows] = await pool.execute(
          `SELECT email_reminders, push_enabled FROM notification_preferences WHERE user_id = ?`,
          [userId],
        );
        const pushEnabled = prefRows.length ? prefRows[0].push_enabled !== 0 && prefRows[0].push_enabled !== false : true;
        const emailEnabled = prefRows.length ? prefRows[0].email_reminders !== 0 && prefRows[0].email_reminders !== false : true;

        // 1. In-App Notification check & send
        const [existingNotif] = await pool.execute(
          `SELECT id FROM notifications WHERE user_id = ? AND type = 'reminder' AND link = ?`,
          [userId, link],
        );

        if (!existingNotif.length && pushEnabled) {
          await pool.execute(
            `INSERT INTO notifications (user_id, title, message, type, link, is_read)
             VALUES (?, ?, ?, 'reminder', ?, 0)`,
            [
              userId,
              `Upcoming: ${event.title}`,
              `"${event.title}" starts ${when}${where}. Review your passes in My Tickets.`,
              link,
            ],
          );
          created += 1;
        } else {
          skipped += 1;
        }

        // 2. Email Reminder check & send
        const recipientEmail = (holder.attendee_email || '').trim().toLowerCase();
        if (emailEnabled && recipientEmail && recipientEmail.includes('@')) {
          // Check if email reminder was already dispatched for this event
          const [existingEmailAlert] = await pool.execute(
            `SELECT id FROM notifications WHERE user_id = ? AND type = 'email_reminder_sent' AND link = ?`,
            [userId, link],
          );

          if (!existingEmailAlert.length) {
            // Fetch tickets for this user and event to embed QR codes
            const [userTickets] = await pool.execute(
              `SELECT t.ticket_number, t.qr_code, tt.name AS tier_name
               FROM tickets t
               LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
               WHERE t.user_id = ? AND t.event_id = ? AND t.status IN ('valid', 'active')`,
              [userId, eventId],
            );

            sendEventReminderEmail({
              to: recipientEmail,
              attendeeName: holder.attendee_name,
              eventTitle: event.title,
              eventDate: event.start_date,
              startTime: event.start_time,
              venue: event.venue || event.city,
              address: event.address || '',
              city: event.city || '',
              tickets: userTickets,
              eventId: event.id,
            }).catch((mailErr) => console.warn('[reminders.runReminderJob] Email send failed:', mailErr.message));

            await pool.execute(
              `INSERT INTO notifications (user_id, title, message, type, link, is_read)
               VALUES (?, ?, ?, 'email_reminder_sent', ?, 1)`,
              [userId, 'Email Reminder Sent', `Sent 24h reminder to ${recipientEmail}`, link],
            ).catch(() => {});

            emailed += 1;
          }
        }
      }
    }

    if (created > 0 || emailed > 0) {
      console.log(`[reminders] ${created} in-app and ${emailed} email reminder(s) sent, ${skipped} skipped`);
    }
    return { created, emailed, skipped };
  } catch (err) {
    console.error('[reminders] job failed:', err.message);
    return { created: 0, emailed: 0, skipped: 0, error: err.message };
  }
}

export default runReminderJob;
