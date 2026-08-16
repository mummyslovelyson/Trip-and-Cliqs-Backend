/**
 * Integration tests for community features:
 *  - following organizers (follow/unfollow, following list, following events)
 *  - event meet-ups (create, join, leave, full-capacity, delete, my meet-ups)
 *  - event detail exposes organizer follow info
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

const inDays = (n) => {
  const d = new Date(Date.now() + n * 86400000);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

before(async () => {
  const fake = createFakeDb();
  db = fake.db;
  pool.execute = fake.execute;
  pool.query = fake.query;
  pool.getConnection = fake.getConnection;

  hash = await bcrypt.hash('password123', 10);

  const user = (id, name, email, role) => ({
    id, name, email, password: hash, role, status: 'active',
    is_approved: role === 'organizer' ? 1 : 1, email_verified: 1,
    phone: null, avatar: null, created_at: new Date().toISOString(),
  });
  db.tables.users.push(
    user(1, 'Alice Attendee', 'alice@test.com', 'attendee'),
    user(2, 'Org A', 'orga@test.com', 'organizer'),
    user(3, 'Org B', 'orgb@test.com', 'organizer'),
    user(4, 'Bob Attendee', 'bob@test.com', 'attendee'),
  );
  db.seq.users = 5;

  db.tables.organizer_profiles.push(
    { id: 1, user_id: 2, organization_name: 'Org A Productions', is_verified: 1 },
    { id: 2, user_id: 3, organization_name: 'Org B Events', is_verified: 1 },
  );
  db.seq.organizer_profiles = 3;

  const mkEvent = (id, organizerId, title, days) => ({
    id, organizer_id: organizerId, title, slug: title.toLowerCase().replace(/\s+/g, '-'),
    category: 'Music', venue: 'Main Hall', city: 'Accra', country: 'Ghana',
    start_date: inDays(days), start_time: '20:00', capacity: 100,
    status: 'published', is_featured: 0, approval_status: 'approved',
    visibility: 'public', created_at: new Date().toISOString(),
  });
  db.tables.events.push(
    mkEvent(1, 2, 'Org A Concert', 5),
    mkEvent(2, 3, 'Org B Showcase', 6),
    mkEvent(3, 2, 'Org A Past Event', -5),
  );
  db.seq.events = 4;

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

let aliceToken;
let bobToken;

const login = async (email) => {
  const r = await api('POST', '/api/auth/login', { body: { email, password: 'password123' } });
  assert.equal(r.status, 200, `login failed for ${email}`);
  return r.json.accessToken;
};

/* ------------------------------------------------------------------ *
 * Following organizers
 * ------------------------------------------------------------------ */

test('attendee can follow an organizer', async () => {
  aliceToken = await login('alice@test.com');
  const r = await api('POST', '/api/users/organizers/2/follow', { token: aliceToken });
  assert.equal(r.status, 200);
  assert.equal(r.json.following, true);
  const row = db.tables.organizer_follows.find((f) => f.follower_id === 1 && f.organizer_id === 2);
  assert.ok(row, 'follow row inserted');
});

test('cannot follow yourself or a non-organizer', async () => {
  const self = await api('POST', '/api/users/organizers/1/follow', { token: aliceToken });
  assert.equal(self.status, 400);
  const attendee = await api('POST', '/api/users/organizers/4/follow', { token: aliceToken });
  assert.equal(attendee.status, 404);
});

test('following list returns the organizer with follower count', async () => {
  const r = await api('GET', '/api/users/following', { token: aliceToken });
  assert.equal(r.status, 200);
  assert.equal(r.json.following.length, 1);
  const org = r.json.following[0];
  assert.equal(org.id, 2);
  assert.equal(org.organizationName, 'Org A Productions');
  assert.equal(org.followersCount, 1);
});

test('following events only lists upcoming published events from followed organizers', async () => {
  const r = await api('GET', '/api/users/following/events', { token: aliceToken });
  assert.equal(r.status, 200);
  const ids = r.json.events.map((e) => e.id).sort();
  assert.deepEqual(ids, [1], 'only Org A upcoming event');
});

test('event detail exposes organizer follow state', async () => {
  // Alice follows Org A → isFollowing true on their event.
  const asAlice = await api('GET', '/api/events/1', { token: aliceToken });
  assert.equal(asAlice.status, 200);
  assert.equal(asAlice.json.organizer.id, 2);
  assert.equal(asAlice.json.organizer.followersCount, 1);
  assert.equal(asAlice.json.organizer.isFollowing, true);

  // Anonymous → no join state.
  const anon = await api('GET', '/api/events/1');
  assert.equal(anon.status, 200);
  assert.equal(anon.json.organizer.isFollowing, false);
  assert.equal(anon.json.organizer.followersCount, 1);
});

test('unfollow removes the organizer and clears following events', async () => {
  const r = await api('DELETE', '/api/users/organizers/2/follow', { token: aliceToken });
  assert.equal(r.status, 200);
  assert.equal(r.json.following, false);
  assert.equal(db.tables.organizer_follows.length, 0);

  const evs = await api('GET', '/api/users/following/events', { token: aliceToken });
  assert.equal(evs.json.events.length, 0);

  // Re-follow so the meet-up tests below have a consistent baseline.
  await api('POST', '/api/users/organizers/2/follow', { token: aliceToken });
});

/* ------------------------------------------------------------------ *
 * Meet-ups
 * ------------------------------------------------------------------ */

test('create a meet-up for an event (host auto-joins)', async () => {
  const r = await api('POST', '/api/meetups/event/1', {
    token: aliceToken,
    body: { title: 'Pre-show dinner', description: 'Dinner at the cafe next door', meetingSpot: 'Cafe Verde', maxMembers: 2 },
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.meetup.title, 'Pre-show dinner');
  assert.equal(r.json.meetup.hostId, 1);
  assert.equal(r.json.meetup.memberCount, 1);
  assert.equal(r.json.meetup.joined, true);
});

test('create meet-up validates missing title and missing event', async () => {
  const noTitle = await api('POST', '/api/meetups/event/1', { token: aliceToken, body: {} });
  assert.equal(noTitle.status, 400);
  const noEvent = await api('POST', '/api/meetups/event/999', {
    token: aliceToken,
    body: { title: 'Phantom' },
  });
  assert.equal(noEvent.status, 404);
});

test('event meet-ups list shows join state for the viewer', async () => {
  bobToken = await login('bob@test.com');
  const anon = await api('GET', '/api/meetups/event/1');
  assert.equal(anon.status, 200);
  assert.equal(anon.json.meetups.length, 1);
  assert.equal(anon.json.meetups[0].joined, false);

  const asAlice = await api('GET', '/api/meetups/event/1', { token: aliceToken });
  assert.equal(asAlice.json.meetups[0].joined, true);
});

test('joining increments membership; duplicate join is rejected', async () => {
  const join = await api('POST', '/api/meetups/1/join', { token: bobToken });
  assert.equal(join.status, 200);
  const again = await api('POST', '/api/meetups/1/join', { token: bobToken });
  assert.equal(again.status, 400);
  const list = await api('GET', '/api/meetups/event/1', { token: aliceToken });
  assert.equal(list.json.meetups[0].memberCount, 2);
});

test('meet-up with a member limit rejects when full', async () => {
  // maxMembers caps total members including the host → 2 = host + 1 guest.
  const created = await api('POST', '/api/meetups/event/1', {
    token: aliceToken,
    body: { title: 'Full group', maxMembers: 2 },
  });
  assert.equal(created.status, 201);
  const meetupId = created.json.meetup.id;

  const join = await api('POST', `/api/meetups/${meetupId}/join`, { token: bobToken });
  assert.equal(join.status, 200);
  // Third person (Org A logs in as a regular user) hits the cap.
  const orgToken = await login('orga@test.com');
  const full = await api('POST', `/api/meetups/${meetupId}/join`, { token: orgToken });
  assert.equal(full.status, 400);
});

test('my meet-ups lists created and joined groups', async () => {
  const r = await api('GET', '/api/meetups/mine', { token: bobToken });
  assert.equal(r.status, 200);
  assert.equal(r.json.meetups.length, 2, 'Bob joined both meet-ups');
});

test('leaving a meet-up removes membership', async () => {
  const leave = await api('POST', '/api/meetups/1/leave', { token: bobToken });
  assert.equal(leave.status, 200);
  const list = await api('GET', '/api/meetups/event/1', { token: aliceToken });
  assert.equal(list.json.meetups[0].memberCount, 1);
});

test('only the host (or admin) can delete a meet-up', async () => {
  const created = await api('POST', '/api/meetups/event/1', {
    token: bobToken,
    body: { title: "Bob's group" },
  });
  assert.equal(created.status, 201);
  const meetupId = created.json.meetup.id;

  const forbidden = await api('DELETE', `/api/meetups/${meetupId}`, { token: aliceToken });
  assert.equal(forbidden.status, 403);

  const ok = await api('DELETE', `/api/meetups/${meetupId}`, { token: bobToken });
  assert.equal(ok.status, 200);
  assert.equal(db.tables.event_meetups.some((m) => m.id === meetupId), false);
});

test('meet-up endpoints require authentication', async () => {
  const create = await api('POST', '/api/meetups/event/1', { body: { title: 'X' } });
  assert.equal(create.status, 401);
  const join = await api('POST', '/api/meetups/1/join');
  assert.equal(join.status, 401);
});
