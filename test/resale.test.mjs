/**
 * Integration tests for the ticket resale marketplace:
 *  - list active resale listings for an event
 *  - create a listing (ownership, price, duplicate, event-start guards)
 *  - cancel a listing (owner / admin only)
 *  - purchase a listing (transfers the ticket, marks it sold, creates order)
 *  - dev-mode purchase completes instantly without a Paystack key
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
    is_approved: 1, email_verified: 1,
    phone: null, avatar: null, created_at: new Date().toISOString(),
  });
  db.tables.users.push(
    user(1, 'Alice Attendee', 'alice@test.com', 'attendee'),
    user(2, 'Bob Buyer', 'bob@test.com', 'attendee'),
    user(3, 'Carol', 'carol@test.com', 'attendee'),
  );
  db.seq.users = 4;

  db.tables.events.push({
    id: 1, organizer_id: 2, title: 'Resale Fest', slug: 'resale-fest',
    category: 'Music', venue: 'Main Hall', city: 'Accra', country: 'Ghana',
    start_date: inDays(10), start_time: '20:00', capacity: 100,
    status: 'published', is_featured: 0, approval_status: 'approved',
    visibility: 'public', created_at: new Date().toISOString(),
  });
  db.seq.events = 2;

  db.tables.ticket_types.push(
    { id: 1, event_id: 1, name: 'VIP', price: 100, quantity_total: 50, quantity_sold: 2, is_vip: 1 },
    { id: 2, event_id: 1, name: 'General', price: 40, quantity_total: 200, quantity_sold: 5, is_vip: 0 },
  );
  db.seq.ticket_types = 3;

  // Alice owns two active tickets for the event; Bob owns one.
  db.tables.tickets.push(
    { id: 1, order_item_id: null, user_id: 1, event_id: 1, ticket_type_id: 1, ticket_number: 'TC-AAA1', qr_code: 'qr1', seat_number: null, status: 'active', created_at: new Date().toISOString() },
    { id: 2, order_item_id: null, user_id: 1, event_id: 1, ticket_type_id: 2, ticket_number: 'TC-AAA2', qr_code: 'qr2', seat_number: null, status: 'active', created_at: new Date().toISOString() },
    { id: 3, order_item_id: null, user_id: 2, event_id: 1, ticket_type_id: 2, ticket_number: 'TC-BBB1', qr_code: 'qr3', seat_number: null, status: 'active', created_at: new Date().toISOString() },
  );
  db.seq.tickets = 4;

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

const login = async (email) => {
  const r = await api('POST', '/api/auth/login', { body: { email, password: 'password123' } });
  assert.equal(r.status, 200, `login failed for ${email}`);
  return r.json.accessToken;
};

let aliceToken;
let bobToken;

test('attendee can list a ticket for resale', async () => {
  aliceToken = await login('alice@test.com');
  const r = await api('POST', '/api/resale', { token: aliceToken, body: { ticketId: 1, price: 85 } });
  assert.equal(r.status, 201);
  assert.ok(r.json.listingId);
  const row = db.tables.resale_listings.find((l) => l.id === r.json.listingId);
  assert.ok(row);
  assert.equal(row.seller_id, 1);
  assert.equal(row.event_id, 1);
  assert.equal(Number(row.price), 85);
  assert.equal(row.status, 'active');
});

test('cannot list someone else\u2019s ticket or an invalid price', async () => {
  bobToken = await login('bob@test.com');
  const notOwned = await api('POST', '/api/resale', { token: bobToken, body: { ticketId: 1, price: 50 } });
  assert.equal(notOwned.status, 403);
  const badPrice = await api('POST', '/api/resale', { token: aliceToken, body: { ticketId: 2, price: 0 } });
  assert.equal(badPrice.status, 400);
});

test('cannot list the same ticket twice', async () => {
  const dup = await api('POST', '/api/resale', { token: aliceToken, body: { ticketId: 1, price: 90 } });
  assert.equal(dup.status, 400);
  assert.match(dup.json.message, /already listed/i);
});

test('cannot list a ticket for a past event', async () => {
  db.tables.tickets.push({
    id: 4, order_item_id: null, user_id: 1, event_id: 1, ticket_type_id: 2,
    ticket_number: 'TC-OLD', qr_code: 'qr-old', seat_number: null,
    status: 'active', created_at: new Date().toISOString(),
  });
  db.seq.tickets = 5;
  // Event 2 started 3 days ago.
  db.tables.events.push({
    id: 2, organizer_id: 2, title: 'Past Show', slug: 'past-show',
    category: 'Music', venue: 'Hall', city: 'Accra', country: 'Ghana',
    start_date: inDays(-3), start_time: '20:00', capacity: 100,
    status: 'published', is_featured: 0, approval_status: 'approved',
    visibility: 'public', created_at: new Date().toISOString(),
  });
  db.seq.events = 3;
  db.tables.tickets.push({
    id: 5, order_item_id: null, user_id: 1, event_id: 2, ticket_type_id: 2,
    ticket_number: 'TC-OLD2', qr_code: 'qr-old2', seat_number: null,
    status: 'active', created_at: new Date().toISOString(),
  });
  db.seq.tickets = 6;

  const r = await api('POST', '/api/resale', { token: aliceToken, body: { ticketId: 5, price: 10 } });
  assert.equal(r.status, 400);
  assert.match(r.json.message, /already started/i);
});

test('event resale list only returns active listings', async () => {
  const r = await api('GET', '/api/resale/event/1');
  assert.equal(r.status, 200);
  assert.equal(r.json.listings.length, 1);
  assert.equal(r.json.listings[0].seller.name, 'Alice Attendee');
  assert.equal(r.json.listings[0].ticketTypeName, 'VIP');
  assert.equal(Number(r.json.listings[0].price), 85);
});

test('my listings shows my listing with status', async () => {
  const r = await api('GET', '/api/resale/mine', { token: aliceToken });
  assert.equal(r.status, 200);
  assert.equal(r.json.listings.length, 1);
  assert.equal(r.json.listings[0].status, 'active');
});

test('buyer can purchase a resale listing and receives the ticket', async () => {
  const listing = db.tables.resale_listings.find((l) => l.seller_id === 1);
  const r = await api('POST', `/api/resale/${listing.id}/purchase`, { token: bobToken });
  // Dev mode (no Paystack key): completes instantly.
  assert.equal(r.status, 201);
  assert.equal(r.json.authorizationUrl, null);

  const sold = db.tables.resale_listings.find((l) => l.id === listing.id);
  assert.equal(sold.status, 'sold');
  assert.equal(sold.sold_to, 2);

  // Seller's original ticket transferred, buyer got a new active ticket.
  const original = db.tables.tickets.find((t) => t.id === listing.ticket_id);
  assert.equal(original.status, 'transferred');
  const buyerTicket = db.tables.tickets.find((t) => t.user_id === 2 && t.status === 'active');
  assert.ok(buyerTicket, 'buyer received an active ticket');

  // An order was recorded for the buyer.
  const order = db.tables.orders.find((o) => o.user_id === 2 && o.event_id === 1);
  assert.ok(order, 'order created');
  assert.equal(Number(order.total_amount), 85);
  assert.equal(order.payment_status, 'completed');

  // Both parties were notified.
  const buyerNotif = db.tables.notifications.find((n) => n.user_id === 2);
  assert.ok(buyerNotif, 'buyer notified');
  const sellerNotif = db.tables.notifications.find((n) => n.user_id === 1 && n.type === 'payment');
  assert.ok(sellerNotif, 'seller notified');
});

test('sold listing disappears from the event resale list', async () => {
  const r = await api('GET', '/api/resale/event/1');
  assert.equal(r.status, 200);
  assert.equal(r.json.listings.length, 0);
});

test('cannot buy your own listing or a sold listing', async () => {
  // Alice lists ticket 2, then tries to buy it herself.
  const create = await api('POST', '/api/resale', { token: aliceToken, body: { ticketId: 2, price: 40 } });
  const listingId = create.json.listingId;
  const self = await api('POST', `/api/resale/${listingId}/purchase`, { token: aliceToken });
  assert.equal(self.status, 400);
  assert.match(self.json.message, /cannot buy your own/i);

  // Carol buys it, then Bob tries to buy it again.
  const carolToken = await login('carol@test.com');
  const ok = await api('POST', `/api/resale/${listingId}/purchase`, { token: carolToken });
  assert.equal(ok.status, 201);
  const again = await api('POST', `/api/resale/${listingId}/purchase`, { token: bobToken });
  assert.equal(again.status, 400);
  assert.match(again.json.message, /no longer available/i);
});

test('seller can cancel an active listing', async () => {
  // Alice lists her third ticket (id 4 was pushed earlier for the past-event
  // test; use a fresh one).
  db.tables.tickets.push({
    id: 6, order_item_id: null, user_id: 1, event_id: 1, ticket_type_id: 2,
    ticket_number: 'TC-CCC1', qr_code: 'qr-c', seat_number: null,
    status: 'active', created_at: new Date().toISOString(),
  });
  db.seq.tickets = 7;
  const create = await api('POST', '/api/resale', { token: aliceToken, body: { ticketId: 6, price: 30 } });
  console.log('[debug] cancel-test create:', create.status, JSON.stringify(create.json));
  const listingId = create.json.listingId;

  // A non-owner cannot cancel it.
  const forbidden = await api('DELETE', `/api/resale/${listingId}`, { token: bobToken });
  assert.equal(forbidden.status, 403);

  const r = await api('DELETE', `/api/resale/${listingId}`, { token: aliceToken });
  assert.equal(r.status, 200);
  const row = db.tables.resale_listings.find((l) => l.id === listingId);
  assert.equal(row.status, 'cancelled');
});

test('completeOrder path transfers the ticket when a resale order completes', async () => {
  // Simulate the production path: order created pending with resale_listing_id,
  // then completeOrder() finalizes it. Alice lists ticket 6 again (new one).
  db.tables.tickets.push({
    id: 7, order_item_id: null, user_id: 1, event_id: 1, ticket_type_id: 2,
    ticket_number: 'TC-DDD1', qr_code: 'qr-d', seat_number: null,
    status: 'active', created_at: new Date().toISOString(),
  });
  db.seq.tickets = 8;
  const create = await api('POST', '/api/resale', { token: aliceToken, body: { ticketId: 7, price: 55 } });
  const listingId = create.json.listingId;

  // Insert a pending order wired to the listing and mark it completed via the
  // order controller path (webhook equivalent: completeOrder -> transfer).
  db.tables.orders.push({
    id: 99, user_id: 3, event_id: 1, total_amount: 55, discount_amount: 0,
    payment_method: 'paystack', payment_status: 'pending',
    payment_reference: 'TC-DEV99', resale_listing_id: listingId,
    order_status: 'active', created_at: new Date().toISOString(),
  });
  db.seq.orders = 100;

  const { completeResaleOrder } = await import('../src/controllers/resaleController.js');
  await completeResaleOrder(99, 'TC-DEV99');

  const listing = db.tables.resale_listings.find((l) => l.id === listingId);
  assert.equal(listing.status, 'sold');
  assert.equal(listing.sold_to, 3);
  const original = db.tables.tickets.find((t) => t.id === 7);
  assert.equal(original.status, 'transferred');
  const buyerTicket = db.tables.tickets.find((t) => t.user_id === 3 && t.status === 'active');
  assert.ok(buyerTicket, 'buyer received ticket via completeOrder');
});
