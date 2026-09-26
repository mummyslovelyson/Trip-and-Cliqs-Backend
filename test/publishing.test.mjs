/**
 * Integration tests for the event publishing workflow.
 *
 * Runs the real Express app over HTTP with an in-memory fake MySQL pool, so no
 * database is required. Covers: organizer submit-for-review, admin approve /
 * reject (with notifications + audit), and public visibility gating.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * Boot: patch the pool, seed an admin, start the real server.
 * ------------------------------------------------------------------ */
let base;
let server;
let db;
let adminHash;

const { default: pool } = await import('../src/config/db.js');

before(async () => {
  const fake = createFakeDb();
  db = fake.db;
  pool.execute = fake.execute;
  pool.query = fake.query;
  pool.getConnection = fake.getConnection;

  adminHash = await bcrypt.hash('AdminPass1!', 10);
  db.tables.users.push({
    id: 1,
    name: 'System Administrator',
    email: 'admin@tribesandcliqs.com',
    password: adminHash,
    role: 'admin',
    status: 'active',
    is_approved: 1,
    email_verified: 1,
    phone: null,
    created_at: new Date().toISOString(),
  });
  db.seq.users = 2;

  ({ server } = await import('../src/server.js'));
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (!server) return;
  return new Promise((resolve) => server.close(resolve));
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
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

const eventPayload = (overrides = {}) => ({
  title: 'Afrobeat Night',
  category: 'Music',
  venue: 'Grand Arena',
  address: 'Independence Ave',
  city: 'Accra',
  country: 'Ghana',
  start_date: '2030-01-15',
  end_date: '2030-01-15',
  start_time: '20:00',
  end_time: '23:59',
  capacity: 500,
  ...overrides,
});

/* ------------------------------------------------------------------ *
 * Workflow state (shared sequentially across tests)
 * ------------------------------------------------------------------ */
let organizerToken;
let adminToken;
let organizerId;
let pendingEventId;
let rejectedEventId;

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

test('admin can log in via the admin login endpoint', async () => {
  const r = await api('POST', '/api/auth/admin/login', {
    body: { email: 'admin@tribesandcliqs.com', password: 'AdminPass1!' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.role, 'admin');
  adminToken = r.json.accessToken;
});

test('organizer registration creates a pending-approval organizer account', async () => {
  const reg = await api('POST', '/api/auth/register', {
    body: {
      name: 'Accra Events Co',
      email: 'org@test.com',
      password: 'Org@Pass1234',
      role: 'organizer',
      organizationName: 'Accra Events Co',
      category: 'Music & Arts',
      city: 'Accra',
      phone: '+233240001122',
      description: 'Premier event collective in West Africa.',
      websiteUrl: 'https://accraevents.co',
    },
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.json.status, 'pending_verification');

  // Verify pending registration with OTP
  const pending = db.tables.pending_registrations.find((p) => p.email === 'org@test.com');
  assert.ok(pending, 'pending registration row created');
  const knownOtp = '112233';
  pending.otp_hash = (await import('crypto')).default.createHash('sha256').update(`pending_otp:${knownOtp}`).digest('hex');

  const r = await api('POST', '/api/auth/verify-email', {
    body: { email: 'org@test.com', otp: knownOtp },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.role, 'organizer');
  assert.equal(r.json.user.is_approved, 0, 'organizer accounts start unapproved');
  assert.equal(r.json.user.status, 'pending', 'organizer status is pending after verification');
  organizerId = db.tables.users.find((u) => u.email === 'org@test.com').id;

  // Admin must approve the organizer before they can access protected routes
  const approve = await api('POST', `/api/admin/organizers/${organizerId}/approve`, { token: adminToken });
  assert.equal(approve.status, 200);

  const org = db.tables.users.find((u) => u.email === 'org@test.com');
  assert.ok(org, 'organizer row inserted');
  assert.equal(org.status, 'active', 'organizer status is active after approval');
  assert.equal(org.is_approved, 1, 'organizer is approved after admin approval');

  // Get a fresh token after approval
  const login = await api('POST', '/api/auth/login', {
    body: { email: 'org@test.com', password: 'Org@Pass1234' },
  });
  assert.equal(login.status, 200);
  organizerToken = login.json.accessToken;
});

test('public registration rejects admin/staff roles', async () => {
  const r = await api('POST', '/api/auth/register', {
    body: { name: 'Hacker', email: 'hacker@test.com', password: 'Hacker@Pass123', role: 'admin' },
  });
  assert.equal(r.status, 400);
  assert.equal(
    db.tables.users.some((u) => u.role === 'admin' && u.email === 'hacker@test.com'),
    false,
    'no admin account should be created',
  );
});

test('creating an event routes to pending review for admin moderation', async () => {
  const r = await api('POST', '/api/events', {
    token: organizerToken,
    body: eventPayload({
      status: 'published',
      ticket_types: [{ name: 'General', price: 100, quantity: 200 }],
    }),
  });
  assert.equal(r.status, 201);
  pendingEventId = r.json.eventId;
  const ev = db.tables.events.find((e) => e.id === pendingEventId);
  assert.equal(ev.status, 'pending', 'organizers cannot bypass review; status is pending');
  assert.equal(ev.approval_status, 'pending', 'approval_status is pending');
});

test('admin approves pending event, which publishes it and makes it live to the public', async () => {
  const app = await api('POST', `/api/admin/events/${pendingEventId}/approve`, { token: adminToken });
  assert.equal(app.status, 200);
  const ev = db.tables.events.find((e) => e.id === pendingEventId);
  assert.equal(ev.status, 'published');
  assert.equal(ev.approval_status, 'approved');

  const list = await api('GET', '/api/events');
  assert.equal(list.status, 200);
  assert.ok(
    list.json.events.some((e) => e.id === pendingEventId),
    'published event must appear in the public list immediately',
  );
  const single = await api('GET', `/api/events/${pendingEventId}`);
  assert.equal(single.status, 200);
  assert.equal(single.json.status, 'published');
  assert.equal(single.json.ticket_types.length, 1);
  assert.equal(single.json.ticket_types[0].name, 'General');
  assert.equal(Number(single.json.ticket_types[0].price), 100);
});

test('creating an event with status "draft" stays a draft', async () => {
  const r = await api('POST', '/api/events', {
    token: organizerToken,
    body: eventPayload({ title: 'Draft Gala', status: 'draft' }),
  });
  assert.equal(r.status, 201);
  rejectedEventId = r.json.eventId;
  assert.equal(db.tables.events.find((e) => e.id === rejectedEventId).status, 'draft');
});

test('draft events are hidden from anonymous users but visible to owner and admins', async () => {
  const list = await api('GET', '/api/events');
  assert.equal(list.status, 200);
  assert.ok(
    !list.json.events.some((e) => e.id === rejectedEventId),
    'draft event must not appear in public list',
  );
  const single = await api('GET', `/api/events/${rejectedEventId}`);
  assert.equal(single.status, 404, 'draft event must 404 for anonymous GET /:id');

  const asOwner = await api('GET', `/api/events/${rejectedEventId}`, { token: organizerToken });
  assert.equal(asOwner.status, 200);
  assert.equal(asOwner.json.status, 'draft');

  const asAdmin = await api('GET', `/api/events/${rejectedEventId}`, { token: adminToken });
  assert.equal(asAdmin.status, 200);
});

test('organizer submits draft for review — status transitions to pending', async () => {
  const r = await api('PATCH', `/api/events/${rejectedEventId}/publish`, { token: organizerToken });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'pending');
  assert.equal(db.tables.events.find((e) => e.id === rejectedEventId).status, 'pending');
  assert.equal(db.tables.events.find((e) => e.id === rejectedEventId).approval_status, 'pending');
});

test('admin can request changes on pending event', async () => {
  const r = await api('POST', `/api/admin/events/${rejectedEventId}/request-changes`, {
    token: adminToken,
    body: { reason: 'Please upload higher-resolution flyer image and specify dress code' },
  });
  assert.equal(r.status, 200);
  const ev = db.tables.events.find((e) => e.id === rejectedEventId);
  assert.equal(ev.approval_status, 'changes_requested');
  assert.equal(ev.status, 'draft');
  assert.equal(ev.rejection_reason, 'Please upload higher-resolution flyer image and specify dress code');

  await sleep(50);
  const notif = db.tables.notifications.find(
    (n) => n.user_id === organizerId && n.title.includes('Changes requested'),
  );
  assert.ok(notif, 'organizer receives in-app changes requested notification');
  assert.ok(notif.message.includes('higher-resolution flyer'), 'feedback is included in notification');
});

test('organizer updates event and resubmits for review', async () => {
  const edit = await api('PUT', `/api/events/${rejectedEventId}`, {
    token: organizerToken,
    body: { title: 'Draft Gala (HD)', dress_code: 'Black Tie' },
  });
  assert.equal(edit.status, 200);

  const resubmit = await api('PATCH', `/api/events/${rejectedEventId}/publish`, { token: organizerToken });
  assert.equal(resubmit.status, 200);
  assert.equal(resubmit.json.status, 'pending');
  assert.equal(db.tables.events.find((e) => e.id === rejectedEventId).status, 'pending');
  assert.equal(db.tables.events.find((e) => e.id === rejectedEventId).approval_status, 'pending');
});

test('admin approval publishes the event after review', async () => {
  const r = await api('POST', `/api/admin/events/${rejectedEventId}/approve`, { token: adminToken });
  assert.equal(r.status, 200);
  const ev = db.tables.events.find((e) => e.id === rejectedEventId);
  assert.equal(ev.status, 'published');
  assert.equal(ev.approval_status, 'approved');

  await sleep(50);
  const notif = db.tables.notifications.find(
    (n) => n.user_id === organizerId && n.title.includes('approved'),
  );
  assert.ok(notif, 'organizer should get an in-app approval notification');
});

test('admin rejection marks the event rejected with reason', async () => {
  const r = await api('POST', `/api/admin/events/${rejectedEventId}/reject`, {
    token: adminToken,
    body: { reason: 'Violates platform guidelines' },
  });
  assert.equal(r.status, 200);
  const ev = db.tables.events.find((e) => e.id === rejectedEventId);
  assert.equal(ev.status, 'rejected');
  assert.equal(ev.approval_status, 'rejected');
  assert.equal(ev.rejection_reason, 'Violates platform guidelines');
});

test('rejected events stay hidden from the public but visible to owner', async () => {
  const single = await api('GET', `/api/events/${rejectedEventId}`);
  assert.equal(single.status, 404);
  const asOwner = await api('GET', `/api/events/${rejectedEventId}`, { token: organizerToken });
  assert.equal(asOwner.status, 200);
  assert.equal(asOwner.json.status, 'rejected');
});
