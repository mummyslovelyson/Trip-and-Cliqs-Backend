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

test('creating an event with status "published" is stored as pending', async () => {
  const r = await api('POST', '/api/events', {
    token: organizerToken,
    body: eventPayload({
      status: 'published',
      ticket_types: [{ name: 'General', price: 100, quantity: 200 }],
    }),
  });
  assert.equal(r.status, 201);
  pendingEventId = r.json.eventId;
  assert.equal(db.tables.events.find((e) => e.id === pendingEventId).status, 'pending');
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

test('organizer "publish" submits for review — status pending, never published', async () => {
  const r = await api('PATCH', `/api/events/${rejectedEventId}/publish`, { token: organizerToken });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'pending');
  assert.equal(db.tables.events.find((e) => e.id === rejectedEventId).status, 'pending');
  const audit = db.tables.audit_logs.find(
    (a) => a.action === 'submit_event_for_review' && a.entity_id === rejectedEventId,
  );
  assert.ok(audit, 'expected a submit_event_for_review audit entry');
});

test('pending events are hidden from anonymous users', async () => {
  const list = await api('GET', '/api/events');
  assert.equal(list.status, 200);
  assert.ok(
    !list.json.events.some((e) => e.id === pendingEventId),
    'pending event must not appear in the public list',
  );
  const single = await api('GET', `/api/events/${pendingEventId}`);
  assert.equal(single.status, 404, 'pending event must 404 for anonymous GET /:id');
});

test('pending events are visible to their owner and to admins', async () => {
  const asOwner = await api('GET', `/api/events/${pendingEventId}`, { token: organizerToken });
  assert.equal(asOwner.status, 200);
  assert.equal(asOwner.json.status, 'pending');
  const asAdmin = await api('GET', `/api/events/${pendingEventId}`, { token: adminToken });
  assert.equal(asAdmin.status, 200);
});

test('approve/reject endpoints are admin-only', async () => {
  const r = await api('POST', `/api/admin/events/${pendingEventId}/approve`, { token: organizerToken });
  assert.equal(r.status, 403, 'organizers must not reach admin moderation');
  assert.equal(db.tables.events.find((e) => e.id === pendingEventId).status, 'pending');
});

test('admin approval publishes the event and notifies the organizer', async () => {
  const r = await api('POST', `/api/admin/events/${pendingEventId}/approve`, { token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(db.tables.events.find((e) => e.id === pendingEventId).status, 'published');
  await sleep(50); // notification insert is fire-and-forget
  const notif = db.tables.notifications.find(
    (n) => n.user_id === organizerId && n.title.includes('approved'),
  );
  assert.ok(notif, 'organizer should get an in-app approval notification');
  assert.ok(notif.message.includes('Afrobeat Night'), 'notification names the event');
  const audit = db.tables.audit_logs.find(
    (a) => a.action === 'approve_event' && a.entity_id === pendingEventId,
  );
  assert.ok(audit, 'expected an approve_event audit entry');
});

test('approved events become publicly visible with their ticket types', async () => {
  const list = await api('GET', '/api/events');
  assert.ok(list.json.events.some((e) => e.id === pendingEventId), 'published event in public list');
  const single = await api('GET', `/api/events/${pendingEventId}`);
  assert.equal(single.status, 200);
  assert.equal(single.json.status, 'published');
  assert.equal(single.json.ticket_types.length, 1);
});

test('admin rejection marks the event rejected and notifies with the reason', async () => {
  const r = await api('POST', `/api/admin/events/${rejectedEventId}/reject`, {
    token: adminToken,
    body: { reason: 'Insufficient details' },
  });
  assert.equal(r.status, 200);
  assert.equal(db.tables.events.find((e) => e.id === rejectedEventId).status, 'rejected');
  await sleep(50);
  const notif = db.tables.notifications.find(
    (n) => n.user_id === organizerId && n.title.includes('rejected'),
  );
  assert.ok(notif, 'organizer should get an in-app rejection notification');
  assert.ok(notif.message.includes('Insufficient details'), 'rejection reason carried through');
  const audit = db.tables.audit_logs.find(
    (a) => a.action === 'reject_event' && a.entity_id === rejectedEventId,
  );
  assert.ok(audit, 'expected a reject_event audit entry');
  assert.equal(JSON.parse(audit.details).reason, 'Insufficient details');
});

test('rejected events stay hidden from the public but visible to their owner', async () => {
  const single = await api('GET', `/api/events/${rejectedEventId}`);
  assert.equal(single.status, 404);
  const asOwner = await api('GET', `/api/events/${rejectedEventId}`, { token: organizerToken });
  assert.equal(asOwner.status, 200);
  assert.equal(asOwner.json.status, 'rejected');
});

test('organizer can edit a rejected event and resubmit for review', async () => {
  const edit = await api('PUT', `/api/events/${rejectedEventId}`, {
    token: organizerToken,
    body: { title: 'Draft Gala (Revised)', capacity: 800 },
  });
  assert.equal(edit.status, 200);
  const stored = db.tables.events.find((e) => e.id === rejectedEventId);
  assert.equal(stored.title, 'Draft Gala (Revised)', 'content edits apply');
  assert.equal(stored.status, 'rejected', 'edits must not change moderation status');

  const resubmit = await api('PATCH', `/api/events/${rejectedEventId}/publish`, { token: organizerToken });
  assert.equal(resubmit.status, 200);
  assert.equal(
    db.tables.events.find((e) => e.id === rejectedEventId).status,
    'pending',
    'resubmission returns the event to the review queue',
  );
});
