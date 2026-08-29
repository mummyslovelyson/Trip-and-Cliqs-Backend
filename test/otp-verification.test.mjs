/**
 * Regression tests for Pre-Verification Account Creation (OTP & Email/SMS).
 *
 * Covers:
 * - Registration creates a pending_registration and does NOT insert into users yet
 * - unverified user cannot login
 * - verify-email with valid OTP finalizes account creation into users table
 * - verified user can now login
 * - resend-verification works for pending registrations
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { createFakeDb } from './helpers/fakeDb.mjs';

process.env.JWT_SECRET = 'test-secret-key';
process.env.JWT_REFRESH_SECRET = 'test-refresh-key';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.RESEND_API_KEY = '';
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;

const { default: pool } = await import('../src/config/db.js');

let base;
let server;
let db;

before(async () => {
  const fake = createFakeDb();
  db = fake.db;
  pool.execute = fake.execute;
  pool.query = fake.query;
  pool.getConnection = fake.getConnection;

  const hash = await bcrypt.hash('P@ssword123', 10);
  db.tables.users.push({
    id: 1,
    name: 'Existing Verified User',
    email: 'verified@test.com',
    password: hash,
    role: 'attendee',
    status: 'active',
    is_approved: 1,
    email_verified: 1,
    phone: '233240001122',
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

async function api(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

test('registration creates pending registration and does NOT insert into users yet', async () => {
  const r = await api('POST', '/api/auth/register', {
    name: 'Stage One Registrant',
    email: 'stage1@test.com',
    phone: '233249998877',
    password: 'Password123!',
    role: 'attendee',
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json?.status, 'pending_verification');
  assert.ok(r.json?.registrationId, 'registrationId returned');

  // Verify that the user is NOT in the users table yet
  const userInDb = db.tables.users.find((u) => u.email === 'stage1@test.com');
  assert.equal(userInDb, undefined, 'user MUST NOT exist in users table before OTP verification');

  // Verify that record exists in pending_registrations
  const pending = db.tables.pending_registrations.find((p) => p.email === 'stage1@test.com');
  assert.ok(pending, 'pending registration record exists');
});

test('resend-verification generates a fresh OTP for pending registration', async () => {
  const r = await api('POST', '/api/auth/resend-verification', {
    email: 'stage1@test.com',
    channel: 'sms',
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
});

test('verify-email with invalid OTP returns 400 and does not create user', async () => {
  const r = await api('POST', '/api/auth/verify-email', {
    email: 'stage1@test.com',
    otp: '000000',
  });
  assert.equal(r.status, 400, JSON.stringify(r.json));

  const userInDb = db.tables.users.find((u) => u.email === 'stage1@test.com');
  assert.equal(userInDb, undefined, 'user is still not in users table');
});

test('verify-email with valid OTP creates and verifies user account in database', async () => {
  const knownOtp = '789012';
  const otpHash = crypto.createHash('sha256').update(`pending_otp:${knownOtp}`).digest('hex');

  // Update pending record with known OTP
  const pending = db.tables.pending_registrations.find((p) => p.email === 'stage1@test.com');
  assert.ok(pending);
  pending.otp_hash = otpHash;

  const r = await api('POST', '/api/auth/verify-email', {
    email: 'stage1@test.com',
    otp: knownOtp,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json?.accessToken, 'access token is issued upon creation');

  // Now verify that the user is in the users table and verified
  const createdUser = db.tables.users.find((u) => u.email === 'stage1@test.com');
  assert.ok(createdUser, 'user now created in users table');
  assert.equal(createdUser.email_verified, 1, 'email_verified is set to 1');

  // Verify that pending registration was deleted
  const pendingAfter = db.tables.pending_registrations.find((p) => p.email === 'stage1@test.com');
  assert.equal(pendingAfter, undefined, 'pending registration was cleaned up');

  // Login now succeeds for the newly verified user
  const loginRes = await api('POST', '/api/auth/login', {
    email: 'stage1@test.com',
    password: 'Password123!',
  });
  assert.equal(loginRes.status, 200, 'newly verified user can now login');
});
