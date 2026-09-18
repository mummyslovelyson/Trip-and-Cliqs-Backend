import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../src/config/db.js';
import { handleChatMessage } from '../src/controllers/chatController.js';

test.after(async () => {
  await pool.end();
});

test('chatController handles general event discovery query', async () => {
  const req = {
    body: { message: 'What upcoming events are happening in Accra?' },
    user: null,
  };

  let jsonResult = null;
  const res = {
    status: () => res,
    json: (data) => {
      jsonResult = data;
    },
  };

  await handleChatMessage(req, res);

  assert.ok(jsonResult, 'Expected JSON response');
  assert.ok(jsonResult.reply, 'Expected reply text in response');
  assert.ok(Array.isArray(jsonResult.suggestions), 'Expected suggestions array');
  assert.ok(Array.isArray(jsonResult.actions), 'Expected actions array');
});

test('chatController handles ticket query for unauthenticated guest', async () => {
  const req = {
    body: { message: 'Can you show my tickets?' },
    user: null,
  };

  let jsonResult = null;
  const res = {
    status: () => res,
    json: (data) => {
      jsonResult = data;
    },
  };

  await handleChatMessage(req, res);

  assert.ok(jsonResult, 'Expected JSON response');
  assert.ok(jsonResult.reply, 'Expected reply text');
  // Should advise user to log in
  assert.ok(
    jsonResult.actions?.some((a) => a.path === '/login') ||
    jsonResult.reply.toLowerCase().includes('log') ||
    jsonResult.reply.toLowerCase().includes('account'),
    'Expected login prompt or action for guest'
  );
});

test('chatController handles event-specific contextual questions', async () => {
  const req = {
    body: {
      message: 'What time does this event start and what are the ticket tiers?',
      context: { currentPath: '/events/1' },
    },
    user: null,
  };

  let jsonResult = null;
  const res = {
    status: () => res,
    json: (data) => {
      jsonResult = data;
    },
  };

  await handleChatMessage(req, res);

  assert.ok(jsonResult, 'Expected JSON response');
  assert.ok(jsonResult.reply, 'Expected reply text');
});
