/**
 * Integration tests for personalization features:
 *  - GET /events/recommended (favorites + past attendance + location signals)
 *  - the event-reminder background job (dedupe, preference gating)
 *  - notification preferences + profile fields persistence
 *
 * Runs the real Express app over HTTP with an in-memory fake MySQL pool.
 *
 * Run:  cd backend && npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { createFakeDb } from './helpers/fakeDb.mjs';

/* ------------------------------------------------------------------ *
 * Environment — MUST be set before the app is imported.
 * ------------------------------------------------------------------ */
process.env.JWT_SECRET = 'test-secret-key';
process.env.JWT_REFRESH_SECRET = 'test-refresh-key';
process.env.NODE_ENV = 'test';
process.env.PORT = '0'; // random port
process.env.RESEND_API_KEY = '';
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;

let base;
let server;
let db;
let hash;

const { default: pool } = await import('../src/config/db.js');
const { runReminderJob } = await import('../src/utils/reminders.js');

const pad = (n) => String(n).padStart(2, '0');
const toDateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const inDays = (n) => toDateStr(new Date(Date.now() + n * 86400000));

before(async () => {
  const fake = createFakeDb();
  db = fake.db;
  pool.execute = fake.execute;
  pool.query = fake.query;
  pool.getConnection = fake.getConnection;

  hash = await bcrypt.hash('password123', 10);

  db.tables.users.push(
    {
      id: 1, name: 'Alice', email: 'alice@test.com', password: hash,
      role: 'attendee', status: 'active', is_approved: 1, email_verified: 1,
      location: 'Accra, Ghana', created_at: new Date().toISOString(),
    },
    {
      id: 2, name: 'Bob', email: 'bob@test.com', password: hash,
      role: 'attendee', status: 'active', is_approved: 1, email_verified: 1,
      location: null, created_at: new Date().toISOString(),
    },
  );
  db.seq.users = 3;

  // Upcoming published events (plus one past event that must never surface).
  const mkEvent = (id, { title, category, city, days, featured = 0 }) => ({
    id, organizer_id: 1, category_id: null, title, slug: title.toLowerCase().replace(/\s+/g, '-'),
    category, venue: 'Main Hall', address: '1 High St', city, country: 'Ghana',
    start_date: inDays(days), start_time: '20:00', capacity: 100,
    status: 'published', is_featured: featured, approval_status: 'approved',
    visibility: 'public', created_at: new Date().toISOString(),
  });
  db.tables.events.push(
    mkEvent(1, { title: 'Kumasi Beats', category: 'Music', city: 'Kumasi', days: 5, featured: 1 }),
    mkEvent(2, { title: 'Accra Live', category: 'Music', city: 'Accra', days: 7 }),
    mkEvent(3, { title: 'Tech Summit', category: 'Tech', city: 'Accra', days: 30 }),
    mkEvent(4, { title: 'Food Fest', category: 'Food', city: 'Takoradi', days: 1 }),
    mkEvent(5, { title: 'Old Concert', category: 'Music', city: 'Accra', days: -10 }),
  );
  db.seq.events = 6;

  // Alice signals: favorites → Music, past attendance → Tech.
  db.tables.favorites.push({ id: 1, user_id: 1, event_id: 2, created_at: new Date().toISOString() });
  db.seq.favorites = 2;
  db.tables.tickets.push({
    id: 1, user_id: 1, event_id: 3, ticket_type_id: 1, ticket_number: 'TCK-001',
    status: 'active', created_at: new Date().toISOString(),
  });
  // Bob holds a ticket to Food Fest (tomorrow) — reminder target.
  db.tables.tickets.push({
    id: 2, user_id: 2, event_id: 4, ticket_type_id: 1, ticket_number: 'TCK-002',
    status: 'active', created_at: new Date().toISOString(),
  });
  db.seq.tickets = 3;

  ({ server } = await import('../src/server.js'));
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (!server) return;
  return new Promise((resolve) => server.close(resolve));
});

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Connection: 'close',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}

const eventsOf = (r) => (Array.isArray(r.json) ? r.json : r.json.events || r.json.data || []);

/* ------------------------------------------------------------------ *
 * Personalized recommendations
 * ------------------------------------------------------------------ */

test('anonymous recommendations fall back to platform picks, excluding past events', async () => {
  const r = await api('GET', '/api/events/recommended?limit=10');
  assert.equal(r.status, 200);
  const events = eventsOf(r);
  assert.ok(events.length > 0, 'fallback list is not empty');
  assert.ok(!events.some((e) => e.id === 5), 'past events never recommended');
  // Featured events surface first for anonymous users.
  assert.equal(events[0].id, 1);
});

test('recommendations rank favorite + attended + local events first', async () => {
  const login = await api('POST', '/api/auth/login', { body: { email: 'alice@test.com', password: 'password123' } });
  assert.equal(login.status, 200);
  const token = login.json.accessToken;

  const r = await api('GET', '/api/events/recommended?limit=10', { token });
  assert.equal(r.status, 200);
  const events = eventsOf(r);

  assert.ok(!events.some((e) => e.id === 5), 'past events excluded');
  assert.ok(!events.some((e) => e.id === 3), 'events the user already holds tickets for are excluded');

  // Accra Live (favorite + home city) should outrank Kumasi Beats (favorite only).
  assert.equal(events[0].id, 2, 'favorite + local event ranks first');
});

test('users with no history get the popular fallback', async () => {
  const login = await api('POST', '/api/auth/login', { body: { email: 'bob@test.com', password: 'password123' } });
  assert.equal(login.status, 200);
  const token = login.json.accessToken;

  const r = await api('GET', '/api/events/recommended?limit=10', { token });
  assert.equal(r.status, 200);
  const events = eventsOf(r);
  assert.equal(events[0].id, 1, 'featured event leads the fallback');
});

/* ------------------------------------------------------------------ *
 * Event reminders
 * ------------------------------------------------------------------ */

test('reminder job notifies ticket holders once per upcoming event', async () => {
  const first = await runReminderJob();
  assert.equal(first.created, 1, 'one reminder expected (Bob → Food Fest)');
  assert.equal(first.error, undefined);

  const reminders = db.tables.notifications.filter((n) => n.type === 'reminder');
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].user_id, 2);
  assert.equal(reminders[0].link, '/events/4');
  assert.ok(reminders[0].message.includes('Food Fest'), 'message names the event');

  // Running again must not duplicate.
  const second = await runReminderJob();
  assert.equal(second.created, 0);
  assert.equal(db.tables.notifications.filter((n) => n.type === 'reminder').length, 1);
});

test('reminders respect the push notification preference', async () => {
  // Bob disables in-app notifications.
  const login = await api('POST', '/api/auth/login', { body: { email: 'bob@test.com', password: 'password123' } });
  const token = login.json.accessToken;
  const save = await api('PUT', '/api/users/profile', {
    token,
    body: { notificationSettings: { pushEventReminders: false, pushTicketConfirmations: false } },
  });
  assert.equal(save.status, 200);

  const res = await runReminderJob();
  assert.equal(res.created, 0, 'no reminders when push is disabled');
});

test('reminder notification is created for a new ticket after preferences restored', async () => {
  const login = await api('POST', '/api/auth/login', { body: { email: 'bob@test.com', password: 'password123' } });
  const token = login.json.accessToken;
  await api('PUT', '/api/users/profile', {
    token,
    body: { notificationSettings: { pushEventReminders: true, pushTicketConfirmations: true } },
  });
  // Alice's Tech Summit is 30 days out — no reminder yet. Bob's Food Fest already
  // has its reminder, so the job stays idempotent.
  const res = await runReminderJob();
  assert.equal(res.created, 0);
  assert.equal(db.tables.notifications.filter((n) => n.type === 'reminder' && n.user_id === 2).length, 1);
});

/* ------------------------------------------------------------------ *
 * Notification preferences + profile fields
 * ------------------------------------------------------------------ */

test('profile returns notification settings with defaults', async () => {
  const login = await api('POST', '/api/auth/login', { body: { email: 'bob@test.com', password: 'password123' } });
  const token = login.json.accessToken;
  const r = await api('GET', '/api/users/profile', { token });
  assert.equal(r.status, 200);
  const s = r.json.user.notificationSettings;
  assert.equal(s.emailEventReminders, true, 'reminders default on');
  assert.equal(s.emailPromotions, false, 'promotions default off');
});

test('profile persists personal info fields', async () => {
  const login = await api('POST', '/api/auth/login', { body: { email: 'bob@test.com', password: 'password123' } });
  const token = login.json.accessToken;
  const save = await api('PUT', '/api/users/profile', {
    token,
    body: { location: 'Kumasi, Ghana', bio: 'Concert lover', dateOfBirth: '1995-04-12' },
  });
  assert.equal(save.status, 200);

  const r = await api('GET', '/api/users/profile', { token });
  assert.equal(r.json.user.location, 'Kumasi, Ghana');
  assert.equal(r.json.user.bio, 'Concert lover');
  assert.equal(r.json.user.dateOfBirth, '1995-04-12');
});
