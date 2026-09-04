/**
 * Integration tests for the admin user-management workflow.
 *
 * Runs the real Express app over HTTP with an in-memory fake MySQL pool, so no
 * database is required. Covers: list filters (role / status / sort), events &
 * tickets counts, suspend/unsuspend with recorded reasons, delete, edit, and
 * admin-account protection.
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

/* ------------------------------------------------------------------ *
 * Boot: patch the pool, seed users, start the real server.
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
  const at = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

  db.tables.users.push(
    {
      id: 1, name: 'System Administrator', email: 'admin@tribesandcliqs.com',
      password: adminHash, role: 'admin', status: 'active', is_approved: 1,
      email_verified: 1, phone: null, created_at: at(100),
    },
    {
      id: 2, name: 'Alice Attendee', email: 'alice@test.com', password: 'x',
      role: 'attendee', status: 'active', is_approved: 0, email_verified: 1,
      phone: '+233201111111', created_at: at(3),
    },
    {
      id: 3, name: 'Bob Pending Org', email: 'bob@test.com', password: 'x',
      role: 'organizer', status: 'pending', is_approved: 0, email_verified: 1,
      phone: null, created_at: at(2),
    },
    {
      id: 4, name: 'Carol Approved Org', email: 'carol@test.com', password: 'x',
      role: 'organizer', status: 'active', is_approved: 1, email_verified: 1,
      phone: null, created_at: at(5),
    },
    {
      id: 5, name: 'Dave Suspended', email: 'dave@test.com', password: 'x',
      role: 'attendee', status: 'suspended', is_approved: 0, email_verified: 1,
      phone: null, suspend_reason: 'Spam', suspended_at: at(1), created_at: at(10),
    },
    {
      id: 6, name: 'Second Admin', email: 'admin2@test.com', password: 'x',
      role: 'admin', status: 'active', is_approved: 1, email_verified: 1,
      phone: null, created_at: at(9),
    },
  );
  db.seq.users = 7;

  db.tables.organizer_profiles.push(
    { id: 1, user_id: 3, organization_name: 'Bob Events', is_verified: 0 },
    { id: 2, user_id: 4, organization_name: 'Carol Productions', is_verified: 1, approved_at: at(4) },
  );
  db.seq.organizer_profiles = 3;

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

let adminToken;

const userById = (id) => db.tables.users.find((u) => u.id === id);

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

test('role filter returns only that role', async () => {
  const r = await api('GET', '/api/admin/users?role=attendee&limit=100', { token: adminToken });
  assert.equal(r.status, 200);
  const emails = r.json.users.map((u) => u.email).sort();
  assert.deepEqual(emails, ['alice@test.com', 'dave@test.com']);
});

test('"active" status includes attendees, approved organizers, and admins', async () => {
  const r = await api('GET', '/api/admin/users?status=active&limit=100', { token: adminToken });
  assert.equal(r.status, 200);
  const emails = r.json.users.map((u) => u.email).sort();
  assert.deepEqual(emails, ['admin2@test.com', 'admin@tribesandcliqs.com', 'alice@test.com', 'carol@test.com']);
});

test('"approved" status only lists approved organizers', async () => {
  const r = await api('GET', '/api/admin/users?status=approved&limit=100', { token: adminToken });
  assert.equal(r.status, 200);
  const emails = r.json.users.map((u) => u.email).sort();
  assert.deepEqual(emails, ['carol@test.com']);
});

test('"pending" status only lists unapproved organizers, never attendees', async () => {
  const r = await api('GET', '/api/admin/users?status=pending&limit=100', { token: adminToken });
  assert.equal(r.status, 200);
  const emails = r.json.users.map((u) => u.email);
  assert.deepEqual(emails, ['bob@test.com']);
});

test('"suspended" status only lists suspended users', async () => {
  const r = await api('GET', '/api/admin/users?status=suspended&limit=100', { token: adminToken });
  assert.equal(r.status, 200);
  const emails = r.json.users.map((u) => u.email);
  assert.deepEqual(emails, ['dave@test.com']);
  assert.equal(r.json.users[0].isSuspended, true);
  assert.equal(r.json.users[0].suspendReason, 'Spam');
});

test('sort=name orders users A-Z by name', async () => {
  const r = await api('GET', '/api/admin/users?sort=name&limit=100', { token: adminToken });
  assert.equal(r.status, 200);
  const names = r.json.users.map((u) => u.name);
  assert.deepEqual(names, [...names].sort());
});

test('list rows expose eventsCount and ticketsCount', async () => {
  const r = await api('GET', '/api/admin/users?limit=100', { token: adminToken });
  assert.equal(r.status, 200);
  for (const u of r.json.users) {
    assert.ok('eventsCount' in u, 'eventsCount key present');
    assert.ok('ticketsCount' in u, 'ticketsCount key present');
  }
});

test('user detail returns counts and suspension info', async () => {
  const r = await api('GET', '/api/admin/users/5', { token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.email, 'dave@test.com');
  assert.equal(r.json.user.isSuspended, true);
  assert.equal(r.json.user.suspendReason, 'Spam');
  assert.ok('eventsCount' in r.json.user);
  assert.ok('ticketsCount' in r.json.user);
  assert.equal(r.json.user.password, undefined, 'password never leaks');
});

test('suspend records the reason, notifies, and audits', async () => {
  const r = await api('POST', '/api/admin/users/2/suspend', {
    token: adminToken,
    body: { reason: 'Harassment reports' },
  });
  assert.equal(r.status, 200);
  assert.equal(userById(2).status, 'suspended');
  assert.equal(userById(2).suspend_reason, 'Harassment reports');
  assert.ok(userById(2).suspended_at, 'suspended_at timestamp recorded');

  const notif = db.tables.notifications.find((n) => n.user_id === 2 && n.title.includes('suspended'));
  assert.ok(notif, 'suspended user gets an in-app notification');
  assert.ok(notif.message.includes('Harassment reports'), 'notification carries the reason');

  const audit = db.tables.audit_logs.find((a) => a.action === 'suspend_user' && a.entity_id === 2);
  assert.ok(audit, 'suspend action is audited');
  assert.equal(JSON.parse(audit.details).reason, 'Harassment reports');
});

test('suspend rejects an already-suspended user', async () => {
  const r = await api('POST', '/api/admin/users/5/suspend', { token: adminToken, body: {} });
  assert.equal(r.status, 400);
});

test('admin accounts cannot be suspended', async () => {
  const r = await api('POST', '/api/admin/users/6/suspend', { token: adminToken, body: {} });
  assert.equal(r.status, 400);
  assert.equal(userById(6).status, 'active');
});

test('unsuspend clears the reason and audits', async () => {
  const r = await api('POST', '/api/admin/users/2/unsuspend', { token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(userById(2).status, 'active');
  assert.equal(userById(2).suspend_reason, null);
  assert.equal(userById(2).suspended_at, null);
  const audit = db.tables.audit_logs.find((a) => a.action === 'unsuspend_user' && a.entity_id === 2);
  assert.ok(audit, 'unsuspend action is audited');
});

test('unsuspend rejects non-suspended users', async () => {
  const r = await api('POST', '/api/admin/users/4/unsuspend', { token: adminToken });
  assert.equal(r.status, 400);
});

test('update can change name, email, phone, and role', async () => {
  const r = await api('PUT', '/api/admin/users/2', {
    token: adminToken,
    body: { name: 'Alice A.', phone: '+233202222222', role: 'attendee' },
  });
  assert.equal(r.status, 200);
  assert.equal(userById(2).name, 'Alice A.');
  assert.equal(userById(2).phone, '+233202222222');
  const audit = db.tables.audit_logs.find((a) => a.action === 'admin_update_user' && a.entity_id === 2);
  assert.ok(audit, 'update is audited');
  assert.equal(JSON.parse(audit.details).changed.name, 'Alice A.');
});

test('update rejects invalid email', async () => {
  const r = await api('PUT', '/api/admin/users/2', {
    token: adminToken,
    body: { email: 'not-an-email' },
  });
  assert.equal(r.status, 400);
});

test('role promotion to admin is blocked', async () => {
  const r = await api('PUT', '/api/admin/users/2', {
    token: adminToken,
    body: { role: 'admin' },
  });
  assert.equal(r.status, 400);
  assert.equal(userById(2).role, 'attendee');
});

test('admin accounts cannot be modified via update', async () => {
  const r = await api('PUT', '/api/admin/users/6', {
    token: adminToken,
    body: { role: 'attendee' },
  });
  assert.equal(r.status, 400);
  assert.equal(userById(6).role, 'admin');
});

test('promoting an attendee to organizer creates their organizer profile', async () => {
  const r = await api('PUT', '/api/admin/users/2', {
    token: adminToken,
    body: { role: 'organizer' },
  });
  assert.equal(r.status, 200);
  assert.equal(userById(2).role, 'organizer');
  const profile = db.tables.organizer_profiles.find((op) => op.user_id === 2);
  assert.ok(profile, 'organizer_profiles row created on promotion');
});

test('approve/reject organizer endpoints reject non-organizers', async () => {
  const plainId = 1; // User 1 is seeded as an attendee
  const approve = await api('POST', `/api/admin/organizers/${plainId}/approve`, { token: adminToken });
  assert.equal(approve.status, 400, 'attendees cannot be approved as organizers');
  const reject = await api('POST', `/api/admin/organizers/${plainId}/reject`, { token: adminToken, body: {} });
  assert.equal(reject.status, 400, 'attendees cannot be rejected as organizers');
});

test('admin approval of a pending organizer works end-to-end', async () => {
  const r = await api('POST', '/api/admin/organizers/3/approve', { token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(userById(3).is_approved, 1);
  assert.equal(userById(3).status, 'active');
  const audit = db.tables.audit_logs.find((a) => a.action === 'approve_organizer' && a.entity_id === 3);
  assert.ok(audit, 'approval is audited');
});

test('rejecting a pending organizer records the reason and audits', async () => {
  const r = await api('POST', '/api/admin/organizers/2/reject', {
    token: adminToken,
    body: { reason: 'Incomplete documentation' },
  });
  assert.equal(r.status, 200);
  assert.equal(userById(2).status, 'rejected');
  assert.equal(userById(2).is_approved, 0);
  const notif = db.tables.notifications.find((n) => n.user_id === 2 && n.message.includes('Incomplete documentation'));
  assert.ok(notif, 'rejection notification carries the reason');
  const audit = db.tables.audit_logs.find((a) => a.action === 'reject_organizer' && a.entity_id === 2);
  assert.ok(audit, 'rejection is audited');
});

test('admin accounts cannot be deleted', async () => {
  const r = await api('DELETE', '/api/admin/users/6', { token: adminToken });
  assert.equal(r.status, 400);
  assert.ok(userById(6), 'admin row still exists');
});

test('delete removes the user and audits the action', async () => {
  const r = await api('DELETE', '/api/admin/users/5', { token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(userById(5), undefined, 'user row removed');
  const audit = db.tables.audit_logs.find((a) => a.action === 'delete_user' && a.entity_id === 5);
  assert.ok(audit, 'delete is audited');
  assert.equal(JSON.parse(audit.details).name, 'Dave Suspended');
});

test('delete of a missing user returns 404', async () => {
  const r = await api('DELETE', '/api/admin/users/999', { token: adminToken });
  assert.equal(r.status, 404);
});

test('user detail exposes the stored password hash only as passwordHash', async () => {
  const r = await api('GET', '/api/admin/users/4', { token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.password, undefined, 'plaintext password key never exposed');
  assert.ok(typeof r.json.user.passwordHash === 'string', 'passwordHash is present for admins');
  assert.equal(r.json.user.emailVerified, true);
});

test('admin can reset a user password to a custom value', async () => {
  const r = await api('POST', '/api/admin/users/4/reset-password', {
    token: adminToken,
    body: { password: 'FreshP@ss123' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.temporaryPassword, undefined, 'no temp password when a custom one is supplied');
  assert.equal(await bcrypt.compare('FreshP@ss123', userById(4).password), true, 'password was updated');
  const audit = db.tables.audit_logs.find((a) => a.action === 'admin_reset_password' && a.entity_id === 4);
  assert.ok(audit, 'reset is audited');
});

test('admin can generate a temporary password when none is provided', async () => {
  const r = await api('POST', '/api/admin/users/4/reset-password', { token: adminToken, body: {} });
  assert.equal(r.status, 200);
  assert.ok(r.json.temporaryPassword, 'temporary password returned once');
  assert.ok(r.json.temporaryPassword.length >= 10, 'temp password meets length policy');
  assert.equal(await bcrypt.compare(r.json.temporaryPassword, userById(4).password), true, 'stored hash matches generated value');
});

test('reset rejects weak passwords', async () => {
  const r = await api('POST', '/api/admin/users/4/reset-password', { token: adminToken, body: { password: 'short' } });
  assert.equal(r.status, 400);
});

test('admin account passwords cannot be reset via this endpoint', async () => {
  const r = await api('POST', '/api/admin/users/6/reset-password', { token: adminToken, body: {} });
  assert.equal(r.status, 400);
});

test('reset of a missing user returns 404', async () => {
  const r = await api('POST', '/api/admin/users/999/reset-password', { token: adminToken, body: {} });
  assert.equal(r.status, 404);
});

test('reset-password endpoint is admin-only', async () => {
  const { generateToken } = await import('../src/utils/jwt.js');
  const userToken = generateToken({ id: 1, role: 'attendee', email: 'alice@test.com' });
  const r = await api('POST', '/api/admin/users/4/reset-password', { token: userToken, body: {} });
  assert.equal(r.status, 403, 'attendees cannot reset passwords');
});

test('user-management endpoints are admin-only', async () => {
  const { generateToken } = await import('../src/utils/jwt.js');
  const userToken = generateToken({ id: 1, role: 'attendee', email: 'alice@test.com' });

  const list = await api('GET', '/api/admin/users', { token: userToken });
  assert.equal(list.status, 403, 'attendees cannot list users');
  const suspend = await api('POST', '/api/admin/users/4/suspend', { token: userToken, body: {} });
  assert.equal(suspend.status, 403, 'attendees cannot suspend users');
});
