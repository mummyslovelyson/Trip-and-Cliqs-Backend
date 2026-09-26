/**
 * Integration tests for:
 * 1. Favorites / Following:
 *    - Following Artists (e.g. Sarkodie)
 *    - Following Categories (e.g. Afrobeat, Music)
 *    - Notifications sent when new event is created featuring an artist/category
 *    - Unified following summary
 * 2. Event Reminders:
 *    - Toggle reminders with granular preferences
 *    - Update reminder preferences
 *    - Notifications on time change, venue change, event cancellation
 *    - Countdown processing (7 days, 24 hours, 1 hour)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { createFakeDb } from './helpers/fakeDb.mjs';

process.env.JWT_SECRET = 'test-secret-key';
process.env.JWT_REFRESH_SECRET = 'test-refresh-key';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.RESEND_API_KEY = '';
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;

let base;
let server;
let db;
let hash;

const { default: pool } = await import('../src/config/db.js');
const { notifyFollowersOfNewEvent, notifyReminderSubscribers, processEventReminders } = await import('../src/utils/eventReminders.js');

before(async () => {
  const fake = createFakeDb();
  db = fake.db;
  pool.execute = fake.execute;
  pool.query = fake.query;
  pool.getConnection = fake.getConnection;

  hash = await bcrypt.hash('password123', 10);

  // Users: 1 = Attendee (Alice), 2 = Organizer (Kwame), 3 = Admin
  db.tables.users.push(
    {
      id: 1, name: 'Alice', email: 'alice@test.com', password: hash,
      role: 'attendee', status: 'active', is_approved: 1, email_verified: 1,
      location: 'Accra, Ghana', created_at: new Date().toISOString(),
    },
    {
      id: 2, name: 'Kwame Productions', email: 'kwame@test.com', password: hash,
      role: 'organizer', status: 'active', is_approved: 1, email_verified: 1,
      location: 'Accra, Ghana', created_at: new Date().toISOString(),
    },
    {
      id: 3, name: 'System Admin', email: 'admin@test.com', password: hash,
      role: 'admin', status: 'active', is_approved: 1, email_verified: 1,
      location: 'Accra, Ghana', created_at: new Date().toISOString(),
    },
  );
  db.seq.users = 4;

  ({ server } = await import('../src/server.js'));
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  if (!server) return;
  return new Promise((resolve) => server.close(resolve));
});

async function login(email, password = 'password123') {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  return data.accessToken || data.token;
}

test('1. Artist Follow & New Event Notification (Follow Sarkodie -> Sarkodie has a new event in Accra)', async () => {
  try {
    const aliceToken = await login('alice@test.com');

    // Alice follows Sarkodie
    const followRes = await fetch(`${base}/users/artists/follow`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceToken}`,
      },
      body: JSON.stringify({ artistName: 'Sarkodie' }),
    });
    const followJson = await followRes.json();
    assert.equal(followRes.status, 200, `Expected 200, got ${followRes.status}: ${JSON.stringify(followJson)}`);
    assert.equal(followJson.isFollowing, true);

  // Check follow status
  const checkRes = await fetch(`${base}/users/artists/check?name=Sarkodie`, {
    headers: { Authorization: `Bearer ${aliceToken}` },
  });
  assert.equal(checkRes.status, 200);
  const checkJson = await checkRes.json();
  assert.equal(checkJson.isFollowing, true);

  // Get followed artists list
  const listRes = await fetch(`${base}/users/artists/following`, {
    headers: { Authorization: `Bearer ${aliceToken}` },
  });
  assert.equal(listRes.status, 200);
  const listJson = await listRes.json();
  assert.ok(listJson.artists.some((a) => a.artist_name === 'Sarkodie'));

  // Now an organizer creates a new published event featuring Sarkodie in Accra
  const newEvent = {
    id: 101,
    title: 'Sarkodie Live at Black Star Square',
    category: 'Music',
    city: 'Accra',
    venue: 'Black Star Square, Accra',
    organizer_id: 2,
    status: 'published',
    tags: ['Sarkodie', 'HipHop', 'Rap'],
    description: 'An unforgettable evening with Sarkodie performing live in Accra!',
  };

  const dispatched = await notifyFollowersOfNewEvent(newEvent, 'Kwame Productions');
  assert.ok(dispatched.artistFollowers >= 1, 'Should notify follower of Sarkodie');

  // Verify Alice received the notification
  const notifs = db.tables.notifications.filter((n) => n.user_id === 1);
  const artistNotif = notifs.find((n) => n.title?.includes('Sarkodie') || n.message?.includes('Sarkodie has a new event in Accra'));
  assert.ok(artistNotif, 'Alice should have received a notification for Sarkodie in Accra');
  assert.match(artistNotif.message, /Sarkodie has a new event in Accra/i);
  } catch (err) {
    console.error('TEST 1 FAILED WITH ERROR:', err);
    throw err;
  }
});

test('2. Category Follow & Unified Following Summary', async () => {
  const aliceToken = await login('alice@test.com');

  // Alice follows Afrobeat category
  const followRes = await fetch(`${base}/users/categories/follow`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${aliceToken}`,
    },
    body: JSON.stringify({ categoryName: 'Afrobeat' }),
  });
  assert.equal(followRes.status, 200);
  const followJson = await followRes.json();
  assert.equal(followJson.isFollowing, true);

  // Check following summary
  const summaryRes = await fetch(`${base}/users/following/summary`, {
    headers: { Authorization: `Bearer ${aliceToken}` },
  });
  assert.equal(summaryRes.status, 200);
  const summary = await summaryRes.json();
  assert.ok(Array.isArray(summary.artists));
  assert.ok(Array.isArray(summary.categories));
  assert.ok(summary.categories.some((c) => c.category_name.toLowerCase() === 'afrobeat'));
  assert.ok(summary.counts.artists >= 1);
  assert.ok(summary.counts.categories >= 1);
});

test('3. Event Reminders: Toggle, Preferences, Schedule & Venue Change Triggers', async () => {
  const aliceToken = await login('alice@test.com');

  // Setup an event in DB
  const eventId = 201;
  db.tables.events.push({
    id: eventId,
    title: 'Ghana Tech Summit 2026',
    slug: 'ghana-tech-summit-2026',
    organizer_id: 2,
    venue: 'Accra International Conference Centre',
    city: 'Accra',
    category: 'Technology',
    start_date: '2026-10-15',
    start_time: '09:00:00',
    end_date: '2026-10-15',
    status: 'published',
    created_at: new Date().toISOString(),
  });

  // Alice toggles Remind Me with custom preferences
  const setRemindRes = await fetch(`${base}/events/${eventId}/reminders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${aliceToken}`,
    },
    body: JSON.stringify({
      preferences: {
        sevenDays: true,
        twentyFourHours: true,
        oneHour: true,
        timeChanged: true,
        venueChanged: true,
        cancelled: true,
      },
    }),
  });
  assert.equal(setRemindRes.status, 200);
  const setRemindJson = await setRemindRes.json();
  assert.equal(setRemindJson.isReminded, true);
  assert.equal(setRemindJson.preferences.sevenDays, true);

  // Check status
  const statusRes = await fetch(`${base}/events/${eventId}/reminders`, {
    headers: { Authorization: `Bearer ${aliceToken}` },
  });
  assert.equal(statusRes.status, 200);
  const statusJson = await statusRes.json();
  assert.equal(statusJson.isReminded, true);
  assert.equal(statusJson.preferences.venueChanged, true);

  // Update preferences
  const updatePrefRes = await fetch(`${base}/events/${eventId}/reminders/preferences`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${aliceToken}`,
    },
    body: JSON.stringify({
      preferences: {
        sevenDays: false,
        twentyFourHours: true,
        oneHour: true,
        timeChanged: true,
        venueChanged: true,
      },
    }),
  });
  assert.equal(updatePrefRes.status, 200);

  // Trigger venue changed reminder notification
  const venueDispatched = await notifyReminderSubscribers(eventId, 'venue_changed', {
    title: 'Venue Changed: Ghana Tech Summit 2026',
    message: 'The event venue has been moved to Grand Arena, Accra.',
  });
  assert.equal(venueDispatched, 1);

  // Trigger time changed reminder notification
  const timeDispatched = await notifyReminderSubscribers(eventId, 'time_changed', {
    title: 'Time Changed: Ghana Tech Summit 2026',
    message: 'The event will now begin at 10:30 AM.',
  });
  assert.equal(timeDispatched, 1);

  // Verify notifications exist in DB
  const userNotifs = db.tables.notifications.filter((n) => n.user_id === 1);
  assert.ok(userNotifs.some((n) => n.title?.includes('Venue Changed')));
  assert.ok(userNotifs.some((n) => n.title?.includes('Time Changed')));

  // Trigger countdown reminders processing
  const countdownResult = await processEventReminders();
  assert.ok(typeof countdownResult.processed === 'number');
});
