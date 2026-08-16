/**
 * Regression tests for the password reset flow.
 *
 * Runs the real Express app over HTTP with an in-memory fake MySQL pool, so no
 * database is required. Covers: forgot-password storing a hashed one-time
 * token, reset-password updating the password and burning tokens, and error
 * paths (bad token, weak password) returning 4xx rather than a 500.
 *
 * Run:  cd backend && npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
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

  const hash = await bcrypt.hash('oldPassword123', 10);
  db.tables.users.push({
    id: 1,
    name: 'Test User',
    email: 'user@test.com',
    password: hash,
    role: 'attendee',
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

async function api(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}

/** Insert a valid reset token row the same way the controller would. */
function mintToken(userId, rawToken) {
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  db.tables.password_reset_tokens.push({
    id: db.tables.password_reset_tokens.length + 1,
    user_id: userId,
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + 3600_000).toISOString().slice(0, 19).replace('T', ' '),
    used: 0,
    created_at: new Date().toISOString(),
  });
}

test('forgot-password succeeds and stores a hashed one-time token', async () => {
  const r = await api('POST', '/api/auth/forgot-password', { email: 'user@test.com' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(db.tables.password_reset_tokens.length, 1);
  const stored = db.tables.password_reset_tokens[0];
  assert.equal(stored.used, 0);
  assert.equal(stored.user_id, 1);
  assert.ok(/^[0-9a-f]{64}$/.test(stored.token_hash), 'token is stored as a sha-256 hex hash');
});

test('forgot-password for an unknown email still returns 200 (no enumeration)', async () => {
  const r = await api('POST', '/api/auth/forgot-password', { email: 'nobody@test.com' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(db.tables.password_reset_tokens.length, 1, 'no token row for unknown users');
});

test('reset-password updates the password and burns every outstanding token', async () => {
  const raw = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000';
  mintToken(1, raw);

  const r = await api('POST', '/api/auth/reset-password', { token: raw, password: 'NewPass123' });
  assert.equal(r.status, 200, JSON.stringify(r.json));

  const user = db.tables.users.find((u) => u.id === 1);
  assert.equal(await bcrypt.compare('NewPass123', user.password), true, 'password was updated');
  assert.equal(
    db.tables.password_reset_tokens.filter((t) => t.user_id === 1 && t.used === 0).length,
    0,
    'all reset tokens for the user are burned',
  );
});

test('reusing a burned token returns 400, not a 500', async () => {
  const raw = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000'; // burned above
  const r = await api('POST', '/api/auth/reset-password', { token: raw, password: 'NewPass123' });
  assert.equal(r.status, 400, JSON.stringify(r.json));
});

test('reset-password with an unknown token returns 400', async () => {
  const r = await api('POST', '/api/auth/reset-password', { token: 'nope', password: 'NewPass123' });
  assert.equal(r.status, 400, JSON.stringify(r.json));
});

test('reset-password with a weak password returns 400', async () => {
  const r = await api('POST', '/api/auth/reset-password', { token: 'whatever', password: 'short' });
  assert.equal(r.status, 400, JSON.stringify(r.json));
});
