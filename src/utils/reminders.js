import pool from '../config/db.js';

// Reminders go out when the event starts within this window.
const REMINDER_WINDOW_HOURS = 24;

const pad = (n) => String(n).padStart(2, '0');
const toDateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Send in-app event reminders to every active ticket holder whose event
 * starts within the reminder window. Each (user, event) pair is notified at
 * most once — deduplicated by an existing `reminder` notification carrying
 * the event link. Respects each user's push notification preference.
 *
 * Returns { created, skipped } so callers (and tests) can assert behaviour.
 */
export async function runReminderJob() {
  try {
    const today = toDateStr(new Date());
    const tomorrow = toDateStr(new Date(Date.now() + REMINDER_WINDOW_HOURS * 60 * 60 * 1000));

    const [holders] = await pool.execute(
      `SELECT DISTINCT user_id, event_id FROM tickets WHERE status = 'active'`,
    );
    const holdersList = Array.isArray(holders) ? holders : [];
    if (!holdersList.length) return { created: 0, skipped: 0 };

    // Group holders by event to avoid re-fetching event rows.
    const holdersByEvent = new Map();
    for (const h of holdersList) {
      if (h.user_id == null) continue;
      if (!holdersByEvent.has(h.event_id)) holdersByEvent.set(h.event_id, []);
      holdersByEvent.get(h.event_id).push(h.user_id);
    }

    let created = 0;
    let skipped = 0;

    for (const [eventId, userIds] of holdersByEvent) {
      const [eventRows] = await pool.execute(
        `SELECT id, title, start_date, start_time, city FROM events
         WHERE id = ? AND status = 'published' AND start_date >= ? AND start_date <= ?`,
        [eventId, today, tomorrow],
      );
      const event = eventRows[0];
      if (!event) continue;

      for (const userId of userIds) {
        // In-app reminders follow the push notification preference.
        const [prefRows] = await pool.execute(
          `SELECT push_enabled FROM notification_preferences WHERE user_id = ?`,
          [userId],
        );
        const pushEnabled = prefRows.length ? prefRows[0].push_enabled !== 0 && prefRows[0].push_enabled !== false : true;
        if (!pushEnabled) {
          skipped += 1;
          continue;
        }

        const link = `/events/${eventId}`;
        const [existing] = await pool.execute(
          `SELECT id FROM notifications WHERE user_id = ? AND type = 'reminder' AND link = ?`,
          [userId, link],
        );
        if (existing.length) {
          skipped += 1;
          continue;
        }

        const startsAt = new Date(`${event.start_date}T${event.start_time || '00:00'}`);
        const when = startsAt.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        const where = event.city ? ` in ${event.city}` : '';
        await pool.execute(
          `INSERT INTO notifications (user_id, title, message, type, link, is_read)
           VALUES (?, ?, ?, 'reminder', ?, 0)`,
          [userId, 'Event reminder', `"${event.title}" starts ${when}${where}. Don't miss it!`, link],
        );
        created += 1;
      }
    }

    if (created > 0) console.log(`[reminders] ${created} reminder(s) sent, ${skipped} skipped`);
    return { created, skipped };
  } catch (err) {
    console.error('[reminders] job failed:', err.message);
    return { created: 0, skipped: 0, error: err.message };
  }
}

export default runReminderJob;
