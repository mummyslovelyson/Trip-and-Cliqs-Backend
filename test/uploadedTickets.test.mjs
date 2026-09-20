import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
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
let orgToken;
let attendeeToken;
let organizerId = 2;
let attendeeId = 3;
let testEventId = 1;

const { default: pool } = await import('../src/config/db.js');

before(async () => {
  const fake = createFakeDb();
  db = fake.db;
  pool.execute = fake.execute;
  pool.query = fake.query;
  pool.getConnection = fake.getConnection;

  const passwordHash = await bcrypt.hash('TestPass1!', 10);
  db.tables.users.push(
    {
      id: 1,
      name: 'Admin',
      email: 'admin@test.com',
      password: passwordHash,
      role: 'admin',
      status: 'active',
      is_approved: 1,
      email_verified: 1,
    },
    {
      id: organizerId,
      name: 'Organizer One',
      email: 'org@test.com',
      password: passwordHash,
      role: 'organizer',
      status: 'active',
      is_approved: 1,
      email_verified: 1,
    },
    {
      id: attendeeId,
      name: 'Attendee One',
      email: 'attendee@test.com',
      password: passwordHash,
      role: 'attendee',
      status: 'active',
      is_approved: 1,
      email_verified: 1,
    }
  );

  db.tables.events.push({
    id: testEventId,
    organizer_id: organizerId,
    title: 'Festival of Music',
    description: 'Annual Concert',
    status: 'published',
    start_date: '2026-10-01',
    created_at: new Date().toISOString(),
  });

  orgToken = jwt.sign({ id: organizerId, role: 'organizer', email: 'org@test.com' }, process.env.JWT_SECRET);
  attendeeToken = jwt.sign({ id: attendeeId, role: 'attendee', email: 'attendee@test.com' }, process.env.JWT_SECRET);

  ({ server } = await import('../src/server.js'));
  await new Promise((resolve) => {
    if (server.listening) {
      const { port } = server.address();
      base = `http://localhost:${port}`;
      return resolve();
    }
    server.on('listening', () => {
      const { port } = server.address();
      base = `http://localhost:${port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server?.close) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('organizer can create ticket type with pre-generated uploaded tickets and quantity is auto-set', async () => {
  const payload = {
    name: 'VIP PDF Pass',
    price: 150,
    uploadedTickets: [
      { file_url: 'http://localhost:5000/uploads/vip_pass_001.pdf', file_name: 'vip_pass_001.pdf' },
      { file_url: 'http://localhost:5000/uploads/vip_pass_002.pdf', file_name: 'vip_pass_002.pdf' },
    ],
  };

  const res = await fetch(`${base}/api/tickets/${testEventId}/types`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${orgToken}`,
    },
    body: JSON.stringify(payload),
  });

  assert.equal(res.status, 201);
  const data = await res.json();
  assert.ok(data.ticketTypeId);
  const ticketType = db.tables.ticket_types.find((t) => t.id === data.ticketTypeId);
  assert.ok(ticketType);
  assert.equal(ticketType.quantity, 2);

  // Check inventory endpoint
  const invRes = await fetch(`${base}/api/tickets/types/${data.ticketTypeId}/inventory`, {
    headers: { Authorization: `Bearer ${orgToken}` },
  });
  assert.equal(invRes.status, 200);
  const invData = await invRes.json();
  assert.equal(invData.tickets.length, 2);
  assert.equal(invData.tickets[0].file_name, 'vip_pass_001.pdf');
  assert.equal(invData.tickets[0].is_assigned, 0);
});

test('order fulfillment claims unassigned uploaded ticket pass and attaches to issued ticket', async () => {
  const { generateTicketsForOrder } = await import('../src/controllers/orderController.js');

  const ticketType = db.tables.ticket_types.find((t) => t.name === 'VIP PDF Pass');
  assert.ok(ticketType);

  const testOrderId = 101;
  const testOrderItemId = 501;

  db.tables.orders.push({
    id: testOrderId,
    user_id: attendeeId,
    event_id: testEventId,
    total_amount: 150,
    status: 'completed',
    created_at: new Date().toISOString(),
  });

  db.tables.order_items.push({
    id: testOrderItemId,
    order_id: testOrderId,
    ticket_type_id: ticketType.id,
    quantity: 1,
    unit_price: 150,
  });

  await generateTicketsForOrder(testOrderId);

  const issuedTickets = db.tables.tickets.filter((t) => t.order_item_id === testOrderItemId);
  assert.equal(issuedTickets.length, 1);
  const t = issuedTickets[0];
  assert.equal(t.ticket_file_url, 'http://localhost:5000/uploads/vip_pass_001.pdf');
  assert.equal(t.ticket_file_name, 'vip_pass_001.pdf');

  // Verify that the uploaded_ticket in inventory is marked as assigned
  const claimedItem = db.tables.uploaded_tickets.find((u) => u.file_name === 'vip_pass_001.pdf');
  assert.ok(claimedItem);
  assert.equal(claimedItem.is_assigned, 1);
});
