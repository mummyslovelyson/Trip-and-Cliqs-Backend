import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleChatMessage,
  searchEvents,
  createAgentBookingHold,
  verifyAgentPayment,
  getUserMonthlySpending,
  agentTools,
} from '../src/controllers/chatController.js';
import pool from '../src/config/db.js';

test('Cliq AI: Tools suite exports all required controlled tools', () => {
  assert.equal(typeof agentTools.search_events, 'function');
  assert.equal(typeof agentTools.get_event_details, 'function');
  assert.equal(typeof agentTools.get_ticket_types, 'function');
  assert.equal(typeof agentTools.check_ticket_availability, 'function');
  assert.equal(typeof agentTools.calculate_order_total, 'function');
  assert.equal(typeof agentTools.get_payment_methods, 'function');
  assert.equal(typeof agentTools.reserve_tickets, 'function');
  assert.equal(typeof agentTools.create_order, 'function');
  assert.equal(typeof agentTools.check_payment_status, 'function');
  assert.equal(typeof agentTools.verify_payment, 'function');
  assert.equal(typeof agentTools.issue_ticket, 'function');
  assert.equal(typeof agentTools.get_user_tickets, 'function');
  assert.equal(typeof agentTools.get_user_upcoming_events, 'function');
  assert.equal(typeof agentTools.get_user_spending, 'function');
  assert.equal(typeof agentTools.transfer_ticket, 'function');
  assert.equal(typeof agentTools.cancel_order, 'function');
  assert.equal(typeof agentTools.request_refund, 'function');
  assert.equal(typeof agentTools.send_ticket, 'function');
  assert.equal(typeof agentTools.schedule_event_reminder, 'function');
});

test('Cliq AI: Payment methods tool returns supported Ghana payment options', () => {
  const methods = agentTools.get_payment_methods();
  assert.ok(Array.isArray(methods));
  assert.ok(methods.some((m) => m.id === 'mtn_momo'));
  assert.ok(methods.some((m) => m.id === 'telecel_cash'));
  assert.ok(methods.some((m) => m.id === 'card'));
});

test('Cliq AI: Multi-step request with booking, pricing, and reminder', async () => {
  let jsonOutput = null;
  const req = {
    body: {
      message: 'Cliq, find me a concert in Accra next Friday under GHS 300, book two tickets, and remind me one day before.',
      conversationHistory: [],
      context: {},
    },
    user: { id: 1, name: 'Kwame Mensah', email: 'kwame@example.com' },
  };
  const res = {
    json: (d) => { jsonOutput = d; return d; },
    status: () => res,
  };

  await handleChatMessage(req, res);
  assert.ok(jsonOutput, 'Agent responded to multi-step query');
  assert.ok(typeof jsonOutput.reply === 'string');
  assert.ok(jsonOutput.booking || jsonOutput.events, 'Agent handled either booking summary or event match');
});

test('Cliq AI: Order summary calculation with service fee and review checkpoint', async () => {
  let jsonOutput = null;
  const req = {
    body: {
      message: 'Book two VIP tickets for AfroBeats Live',
      conversationHistory: [],
      context: {},
    },
    user: { id: 1, name: 'Ama Serwaa', email: 'ama@example.com' },
  };
  const res = {
    json: (d) => { jsonOutput = d; return d; },
    status: () => res,
  };

  await handleChatMessage(req, res);
  assert.ok(jsonOutput);
  if (jsonOutput.booking && jsonOutput.booking.status === 'summary') {
    assert.equal(jsonOutput.booking.quantity, 2);
    assert.ok(jsonOutput.booking.total >= jsonOutput.booking.subtotal);
    assert.ok(jsonOutput.actions.some((a) => a.type === 'CONTINUE_PAYMENT'));
  }
});

test('Cliq AI: Explicit human approval via "Confirm & Pay" transitions to 10-minute hold', async () => {
  const [events] = await pool.execute("SELECT id, title FROM events WHERE status = 'published' LIMIT 1");
  if (!events || events.length === 0) return;
  const event = events[0];

  const [tiers] = await pool.execute(
    "SELECT id, name, (quantity - quantity_sold) AS rem FROM ticket_types WHERE event_id = ? AND is_active = TRUE AND (quantity - quantity_sold) > 0 LIMIT 1",
    [event.id]
  );
  if (!tiers || tiers.length === 0) return;
  const tier = tiers[0];
  const qty = Math.min(2, Math.max(1, Number(tier.rem || 1)));

  const [users] = await pool.execute("SELECT id, name, email FROM users LIMIT 1");
  const testUser = users && users.length > 0 ? users[0] : { id: 1, name: 'Kofi Manu', email: 'kofi@example.com' };

  let jsonOutput = null;
  const req = {
    body: {
      message: 'Confirm & Pay',
      conversationHistory: [],
      context: {
        booking: {
          eventId: event.id,
          tierId: tier.id,
          quantity: qty,
          status: 'summary',
        },
      },
    },
    user: testUser,
  };
  const res = {
    json: (d) => { jsonOutput = d; return d; },
    status: () => res,
  };

  await handleChatMessage(req, res);
  assert.ok(jsonOutput);
  assert.equal(jsonOutput.booking?.status, 'reserved');
  assert.equal(jsonOutput.booking?.remainingSeconds, 600);
});

test('Cliq AI: Security - Strictly rejects unverified "I have paid" claim', async () => {
  let jsonOutput = null;
  const req = {
    body: {
      message: 'I have paid GHS 500.',
      conversationHistory: [],
      context: {
        booking: {
          orderId: 99999999,
          reference: 'TC_fake_fake_ref',
        },
      },
    },
    user: { id: 1, name: 'Test User', email: 'test@example.com' },
  };
  const res = {
    json: (d) => { jsonOutput = d; return d; },
    status: () => res,
  };

  await handleChatMessage(req, res);
  assert.ok(jsonOutput);
  assert.notEqual(jsonOutput.intent, 'PAYMENT_CONFIRMED', 'Unverified payment must never be marked confirmed');
});

test('Cliq AI: Autonomous attend request in Kumasi or Accra searches, secures reservation hold, and prepares payment confirmation', async () => {
  const [users] = await pool.execute("SELECT id, name, email FROM users LIMIT 1");
  const testUser = users && users.length > 0 ? users[0] : { id: 1, name: 'Kofi Manu', email: 'kofi@example.com' };

  let jsonOutput = null;
  const req = {
    body: {
      message: 'I want to attend an event at Kumasi or Accra',
      conversationHistory: [],
      mode: 'voice',
    },
    user: testUser,
  };
  const res = {
    json: (d) => { jsonOutput = d; return d; },
    status: () => res,
  };

  await handleChatMessage(req, res);
  assert.ok(jsonOutput, 'Expected JSON response');
  assert.ok(jsonOutput.reply, 'Expected reply message');
  assert.ok(
    jsonOutput.booking.status === 'summary' || jsonOutput.booking.status === 'reserved',
    'Expected order summary or hold reservation'
  );
  assert.ok(jsonOutput.booking.total > 0, 'Expected positive total amount');
  assert.ok(
    jsonOutput.actions.some((a) => a.type === 'PAY_NOW' || a.type === 'CONTINUE_PAYMENT'),
    'Expected payment confirmation action'
  );
});
