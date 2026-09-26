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
let adminToken;
let attendeeToken;

const { default: pool } = await import('../src/config/db.js');

before(async () => {
  const fake = createFakeDb();
  db = fake.db;
  pool.execute = fake.execute;
  pool.query = fake.query;
  pool.getConnection = fake.getConnection;

  const passwordHash = await bcrypt.hash('TestPass123!', 10);

  // Seed Admin
  db.tables.users.push({
    id: 1,
    name: 'Super Admin',
    email: 'admin@tribes.com',
    password: passwordHash,
    role: 'admin',
    status: 'active',
    is_approved: 1,
    email_verified: 1,
    created_at: new Date().toISOString(),
  });

  // Seed Attendee
  db.tables.users.push({
    id: 2,
    name: 'Kwame Mensah',
    email: 'kwame@example.com',
    password: passwordHash,
    role: 'attendee',
    status: 'active',
    is_approved: 0,
    email_verified: 1,
    phone: '+233241112233',
    location: 'Accra, Ghana',
    created_at: new Date().toISOString(),
  });

  db.seq.users = 3;

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
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

test('0. Log in users and acquire access tokens', async () => {
  const adminRes = await api('POST', '/api/auth/admin/login', {
    body: { email: 'admin@tribes.com', password: 'TestPass123!' },
  });
  assert.equal(adminRes.status, 200);
  adminToken = adminRes.json.accessToken;

  const attendeeRes = await api('POST', '/api/auth/login', {
    body: { email: 'kwame@example.com', password: 'TestPass123!' },
  });
  assert.equal(attendeeRes.status, 200);
  attendeeToken = attendeeRes.json.accessToken;
});

test('1. Attendee can submit application to become an event organizer', async () => {
  const res = await api('POST', '/api/users/apply-organizer', {
    token: attendeeToken,
    body: {
      organizationName: 'Accra Nights Collective',
      category: 'Nightlife & Parties',
      location: 'Osu, Accra',
      phone: '+233241112233',
      description: 'Curating premium rooftop events and community gatherings in Accra.',
      website: 'https://accranights.com',
      logoUrl: 'https://accranights.com/logo.png',
      socialMedia: { instagram: '@accranights', twitter: '@accranights' },
    },
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'pending');
  assert.equal(res.json.organizationName, 'Accra Nights Collective');

  // Verify DB state
  const kwame = db.tables.users.find((u) => u.id === 2);
  assert.equal(kwame.role, 'organizer');
  assert.equal(kwame.status, 'pending');
  assert.equal(Boolean(kwame.is_approved), false);

  const profile = db.tables.organizer_profiles.find((p) => p.user_id === 2);
  assert.ok(profile);
  assert.equal(profile.organization_name, 'Accra Nights Collective');
  assert.equal(Boolean(profile.is_verified), false);
});

test('2. Organizer can check application status endpoint', async () => {
  const res = await api('GET', '/api/users/organizer-status', { token: attendeeToken });

  assert.equal(res.status, 200);
  assert.equal(res.json.role, 'organizer');
  assert.equal(res.json.status, 'pending');
  assert.equal(res.json.isVerified, false);
  assert.equal(res.json.organizationName, 'Accra Nights Collective');
});

test('3. Admin can approve organizer and activate verified badge', async () => {
  const res = await api('POST', '/api/admin/organizers/2/approve', { token: adminToken });

  assert.equal(res.status, 200);
  assert.match(res.json.message, /approved successfully/i);

  // Check DB state
  const kwame = db.tables.users.find((u) => u.id === 2);
  assert.equal(kwame.status, 'active');
  assert.equal(Boolean(kwame.is_approved), true);

  const profile = db.tables.organizer_profiles.find((p) => p.user_id === 2);
  assert.equal(Boolean(profile.is_verified), true);
});

test('4. Admin can suspend and unsuspend organizer with verified status handling', async () => {
  // Suspend
  const suspendRes = await api('POST', '/api/admin/users/2/suspend', {
    token: adminToken,
    body: { reason: 'Investigation into event safety' },
  });
  assert.equal(suspendRes.status, 200);

  let kwame = db.tables.users.find((u) => u.id === 2);
  let profile = db.tables.organizer_profiles.find((p) => p.user_id === 2);
  assert.equal(kwame.status, 'suspended');
  assert.equal(Boolean(profile.is_verified), false);

  // Unsuspend
  const unsuspendRes = await api('POST', '/api/admin/users/2/unsuspend', { token: adminToken });
  assert.equal(unsuspendRes.status, 200);

  kwame = db.tables.users.find((u) => u.id === 2);
  profile = db.tables.organizer_profiles.find((p) => p.user_id === 2);
  assert.equal(kwame.status, 'active');
  assert.equal(Boolean(profile.is_verified), true);
});

test('5. Admin can reject organizer application with feedback reason', async () => {
  const res = await api('POST', '/api/admin/organizers/2/reject', {
    token: adminToken,
    body: { reason: 'Incomplete business registration documentation' },
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'rejected');

  const kwame = db.tables.users.find((u) => u.id === 2);
  const profile = db.tables.organizer_profiles.find((p) => p.user_id === 2);
  assert.equal(kwame.status, 'rejected');
  assert.equal(Boolean(kwame.is_approved), false);
  assert.equal(Boolean(profile.is_verified), false);
  assert.equal(kwame.suspend_reason, 'Incomplete business registration documentation');
});
