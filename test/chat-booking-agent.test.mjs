import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../src/config/db.js';
import {
  handleChatMessage,
  createAgentBookingHold,
  verifyAgentPayment,
} from '../src/controllers/chatController.js';

test.after(async () => {
  await pool.end();
});

test('AI Agent: Understands request and searches events in Kumasi for the weekend', async () => {
  const req = {
    body: { message: 'I want to attend a concert in Kumasi this weekend.' },
    user: null,
  };

  let result = null;
  const res = {
    status: () => res,
    json: (data) => { result = data; },
  };

  await handleChatMessage(req, res);

  assert.ok(result, 'Expected JSON response');
  assert.ok(result.reply, 'Expected reply text');
  assert.equal(result.intent, 'SEARCH_EVENTS');
  assert.ok(Array.isArray(result.events), 'Expected events array');
});

test('AI Agent: Creates ticket selection and in-chat order summary for VIP tickets', async () => {
  // First get an existing published event with tiers
  const [events] = await pool.execute(`
    SELECT e.id, e.title, tt.id AS tier_id, tt.name AS tier_name, tt.price
    FROM events e
    JOIN ticket_types tt ON tt.event_id = e.id
    WHERE e.status = 'published' AND tt.is_active = TRUE
    LIMIT 1
  `);

  if (!events || events.length === 0) {
    // skip gracefully if no seed event
    return;
  }

  const ev = events[0];
  const req = {
    body: {
      message: `Book two ${ev.tier_name} tickets for ${ev.title}`,
      context: { eventId: ev.id },
    },
    user: { id: 1, name: 'Kwame', email: 'kwame@test.com' },
  };

  let result = null;
  const res = {
    status: () => res,
    json: (data) => { result = data; },
  };

  await handleChatMessage(req, res);

  assert.ok(result, 'Expected JSON response');
  assert.equal(result.intent, 'BOOKING_SUMMARY');
  assert.ok(result.booking, 'Expected structured booking object');
  assert.equal(result.booking.status, 'summary');
  assert.equal(result.booking.quantity, 2);
  assert.equal(result.booking.unitPrice, Number(ev.price));
  assert.ok(result.booking.total > result.booking.subtotal || result.booking.total >= result.booking.subtotal);
  assert.ok(result.reply.includes('Subtotal') || result.reply.includes('Total'), 'Expected formatted order breakdown in reply');
});

test('AI Agent: After-sales - calculates user monthly spending', async () => {
  const req = {
    body: { message: 'How much have I spent on events this month?' },
    user: { id: 1, name: 'Kwame', email: 'kwame@test.com' },
  };

  let result = null;
  const res = {
    status: () => res,
    json: (data) => { result = data; },
  };

  await handleChatMessage(req, res);

  assert.ok(result, 'Expected JSON response');
  assert.equal(result.intent, 'MONTHLY_SPEND');
  assert.ok(result.spending, 'Expected spending payload');
  assert.ok(typeof result.spending.total === 'number');
  assert.ok(result.reply.includes('spent'), 'Expected spending in reply');
});

test('AI Agent: Security - does NOT confirm unverified payment on "I have paid"', async () => {
  const req = {
    body: {
      message: 'I have paid',
      context: { reference: 'TC_fake_unpaid_ref_12345' },
    },
    user: { id: 1, name: 'Kwame', email: 'kwame@test.com' },
  };

  let result = null;
  const res = {
    status: () => res,
    json: (data) => { result = data; },
  };

  await handleChatMessage(req, res);

  assert.ok(result, 'Expected JSON response');
  // It must NOT say confirmed for an unverified/missing reference
  assert.notEqual(result.intent, 'PAYMENT_CONFIRMED', 'Should not confirm unverified payment');
});
