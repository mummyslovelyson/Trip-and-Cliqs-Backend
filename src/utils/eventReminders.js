import pool from '../config/db.js';
import { sendNotification, sendNotificationToMany } from './notify.js';

/**
 * Dispatch notifications to followers of artists, organizers, and categories
 * when an event is published or announced.
 *
 * Example from blueprint:
 * Follow Sarkodie -> When a new event is created: "Sarkodie has a new event in Accra."
 */
export const notifyFollowersOfNewEvent = async (event, organizerName = '') => {
  try {
    if (!event || !event.id) return;
    const notifiedUserIds = new Set();

    const title = event.title || 'Untitled Event';
    const city = event.city || 'Accra';
    const category = event.category || '';
    const eventTags = Array.isArray(event.tags)
      ? event.tags
      : (typeof event.tags === 'string' ? JSON.parse(event.tags || '[]') : []);

    // ──────────────── 1. ARTIST FOLLOWERS ────────────────
    // Look up all distinct artists currently followed by users
    const [artistRows] = await pool.execute(
      `SELECT DISTINCT artist_name, user_id FROM artist_follows`
    );

    const titleLower = title.toLowerCase();
    const descLower = (event.description || '').toLowerCase();
    const tagsLower = eventTags.map((t) => String(t).toLowerCase());

    const matchedArtistFollowers = new Map(); // artistName -> [userIds]

    for (const r of artistRows) {
      const art = r.artist_name.trim();
      const artLower = art.toLowerCase();
      // Match if artist name is in tags, title, description, or custom artists list
      const isMatch =
        tagsLower.includes(artLower) ||
        titleLower.includes(artLower) ||
        descLower.includes(artLower);

      if (isMatch) {
        if (!matchedArtistFollowers.has(art)) {
          matchedArtistFollowers.set(art, []);
        }
        matchedArtistFollowers.get(art).push(r.user_id);
      }
    }

    // Send artist notifications
    let artistCount = 0;
    for (const [artistName, userIds] of matchedArtistFollowers.entries()) {
      const targetIds = userIds.filter((uid) => !notifiedUserIds.has(uid) && Number(uid) !== Number(event.organizer_id));
      targetIds.forEach((uid) => notifiedUserIds.add(uid));

      if (targetIds.length > 0) {
        artistCount += targetIds.length;
        await sendNotificationToMany(targetIds, {
          title: `New Event: ${artistName}`,
          message: `${artistName} has a new event in ${city}: "${title}".`,
          type: 'event',
          link: `/events/${event.id}`,
        });
      }
    }

    // ──────────────── 2. ORGANIZER FOLLOWERS ────────────────
    let orgCount = 0;
    if (event.organizer_id) {
      const [orgFollowers] = await pool.execute(
        `SELECT follower_id FROM organizer_follows WHERE organizer_id = ?`,
        [event.organizer_id],
      );

      const orgUserIds = orgFollowers
        .map((r) => r.follower_id)
        .filter((uid) => !notifiedUserIds.has(uid) && Number(uid) !== Number(event.organizer_id));

      orgUserIds.forEach((uid) => notifiedUserIds.add(uid));

      if (orgUserIds.length > 0) {
        orgCount += orgUserIds.length;
        const orgLabel = organizerName || 'An organizer you follow';
        await sendNotificationToMany(orgUserIds, {
          title: `New Event from ${orgLabel}`,
          message: `${orgLabel} has a new event in ${city}: "${title}".`,
          type: 'event',
          link: `/events/${event.id}`,
        });
      }
    }

    // ──────────────── 3. CATEGORY FOLLOWERS ────────────────
    let catCount = 0;
    if (category) {
      const [catFollowers] = await pool.execute(
        `SELECT user_id FROM category_follows WHERE LOWER(category_name) = LOWER(?)`,
        [category],
      );

      const catUserIds = catFollowers
        .map((r) => r.user_id)
        .filter((uid) => !notifiedUserIds.has(uid) && Number(uid) !== Number(event.organizer_id));

      catUserIds.forEach((uid) => notifiedUserIds.add(uid));

      if (catUserIds.length > 0) {
        catCount += catUserIds.length;
        await sendNotificationToMany(catUserIds, {
          title: `New ${category} Event`,
          message: `A new ${category} event was announced in ${city}: "${title}".`,
          type: 'event',
          link: `/events/${event.id}`,
        });
      }
    }

    return {
      notifiedCount: notifiedUserIds.size,
      artistFollowers: artistCount,
      organizerFollowers: orgCount,
      categoryFollowers: catCount,
    };
  } catch (err) {
    console.error('[notifyFollowersOfNewEvent] failed:', err.message);
    return { notifiedCount: 0, artistFollowers: 0, organizerFollowers: 0, categoryFollowers: 0 };
  }
};

/**
 * Dispatch contextual lifecycle reminder notifications:
 * - 'time_changed'
 * - 'venue_changed'
 * - 'event_cancelled'
 * - 'sales_opening'
 * - 'almost_sold_out'
 */
export const notifyReminderSubscribers = async (eventId, triggerType, { title, message, extraData } = {}) => {
  try {
    const [subscribers] = await pool.execute(
      `SELECT er.user_id, er.preferences, e.title AS event_title, e.venue, e.city, e.start_date, e.start_time
       FROM event_reminders er
       JOIN events e ON e.id = er.event_id
       WHERE er.event_id = ?`,
      [eventId],
    );

    if (!subscribers.length) return 0;

    const notifTitle = title || `Update: ${subscribers[0].event_title}`;
    const notifMessage = message || `There is an update regarding "${subscribers[0].event_title}".`;

    const targetUserIds = [];
    for (const sub of subscribers) {
      let prefs = sub.preferences;
      if (typeof prefs === 'string') {
        try { prefs = JSON.parse(prefs); } catch { prefs = {}; }
      }
      prefs = prefs || {};

      // Filter by user preference if configured
      if (triggerType === 'time_changed' && prefs.timeChanged === false) continue;
      if (triggerType === 'venue_changed' && prefs.venueChanged === false) continue;
      if (triggerType === 'event_cancelled' && prefs.cancelled === false) continue;
      if (triggerType === 'sales_opening' && prefs.salesOpening === false) continue;
      if (triggerType === 'almost_sold_out' && prefs.almostSoldOut === false) continue;

      targetUserIds.push(sub.user_id);
    }

    if (targetUserIds.length > 0) {
      await sendNotificationToMany(targetUserIds, {
        title: notifTitle,
        message: notifMessage,
        type: 'reminder',
        link: `/events/${eventId}`,
      });
    }
    return targetUserIds.length;
  } catch (err) {
    console.error('[notifyReminderSubscribers] failed:', err.message);
    return 0;
  }
};

/**
 * Process scheduled time-based reminders:
 * - 7 days before
 * - 24 hours before
 * - 1 hour before
 */
export const processEventReminders = async () => {
  try {
    const [rows] = await pool.execute(
      `SELECT er.id AS reminder_id, er.user_id, er.event_id, er.preferences, er.notified_stages,
              e.title, e.venue, e.city, e.start_date, e.start_time
       FROM event_reminders er
       JOIN events e ON e.id = er.event_id
       WHERE e.status = 'published' AND e.start_date >= CURRENT_DATE`
    );

    const now = new Date();
    let sentCount = 0;

    for (const row of rows) {
      if (!row.start_date) continue;

      let prefs = row.preferences;
      if (typeof prefs === 'string') {
        try { prefs = JSON.parse(prefs); } catch { prefs = {}; }
      }
      prefs = prefs || {};

      let notifiedStages = row.notified_stages;
      if (typeof notifiedStages === 'string') {
        try { notifiedStages = JSON.parse(notifiedStages); } catch { notifiedStages = []; }
      }
      notifiedStages = Array.isArray(notifiedStages) ? notifiedStages : [];

      // Calculate start timestamp
      const datePart = new Date(row.start_date).toISOString().split('T')[0];
      const timePart = row.start_time || '18:00:00';
      const eventTime = new Date(`${datePart}T${timePart}`);
      const diffHours = (eventTime.getTime() - now.getTime()) / (1000 * 60 * 60);

      let stageToSend = null;
      let notifTitle = '';
      let notifMessage = '';

      // Stage: 7 Days Before (diff approx 144h - 192h)
      if (prefs.sevenDays !== false && diffHours >= 144 && diffHours <= 192 && !notifiedStages.includes('7_days')) {
        stageToSend = '7_days';
        notifTitle = `7 Days Until ${row.title}!`;
        notifMessage = `Get ready! "${row.title}" is happening in 7 days in ${row.city || 'Ghana'}.`;
      }
      // Stage: 24 Hours Before (diff approx 18h - 30h)
      else if (prefs.twentyFourHours !== false && diffHours >= 18 && diffHours <= 30 && !notifiedStages.includes('24_hours')) {
        stageToSend = '24_hours';
        notifTitle = `Tomorrow: ${row.title}!`;
        notifMessage = `Only 24 hours to go until "${row.title}"! Review your ticket and venue details.`;
      }
      // Stage: 1 Hour Before (diff approx 0.5h - 1.5h)
      else if (prefs.oneHour !== false && diffHours >= 0.5 && diffHours <= 1.5 && !notifiedStages.includes('1_hour')) {
        stageToSend = '1_hour';
        notifTitle = `Starting in 1 Hour: ${row.title}!`;
        notifMessage = `"${row.title}" starts in 1 hour at ${row.venue || row.city}. Gates are open!`;
      }

      if (stageToSend) {
        await sendNotification({
          userId: row.user_id,
          title: notifTitle,
          message: notifMessage,
          type: 'reminder',
        });

        notifiedStages.push(stageToSend);
        await pool.execute(
          `UPDATE event_reminders SET notified_stages = ? WHERE id = ?`,
          [JSON.stringify(notifiedStages), row.reminder_id],
        );
        sentCount++;
      }
    }

    return { processed: rows.length, sent: sentCount };
  } catch (err) {
    console.error('[processEventReminders] failed:', err.message);
    return { error: err.message };
  }
};
