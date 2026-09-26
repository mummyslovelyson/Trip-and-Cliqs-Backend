/**
 * Integration tests for Social Features ("Tribes & Cliqs"):
 * 1. Follow friends (user_follows table, notifications)
 * 2. Unfollow friends
 * 3. Follow status & friend list & friend search
 * 4. Friends attending detection ("X of your friends are attending this event")
 * 5. Invite friends to event (event_invites table, in-app notification)
 * 6. Get my event invites & respond to invites (accept/decline)
 * 7. Squad / Meetup chat (meetup_messages table)
 */
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
let hash;

const { default: pool } = await import('../src/config/db.js');

before(async () => {
  const fake = createFakeDb();
  db = fake.db;
  pool.execute = fake.execute;
  pool.query = fake.query;
  pool.getConnection = fake.getConnection;

  hash = await bcrypt.hash('password123', 10);

  // Users:
  // 1 = Alice (attendee)
  // 2 = Bob (attendee)
  // 3 = Charlie (attendee)
  // 4 = David (attendee)
  db.tables.users.push(
    {
      id: 1, name: 'Alice Smith', email: 'alice@tribes.com', password: hash,
      role: 'attendee', status: 'active', is_approved: 1, email_verified: 1,
      created_at: new Date().toISOString(),
    },
    {
      id: 2, name: 'Bob Mensah', email: 'bob@tribes.com', password: hash,
      role: 'attendee', status: 'active', is_approved: 1, email_verified: 1,
      created_at: new Date().toISOString(),
    },
    {
      id: 3, name: 'Charlie Doe', email: 'charlie@tribes.com', password: hash,
      role: 'attendee', status: 'active', is_approved: 1, email_verified: 1,
      created_at: new Date().toISOString(),
    },
    {
      id: 4, name: 'David Appiah', email: 'david@tribes.com', password: hash,
      role: 'attendee', status: 'active', is_approved: 1, email_verified: 1,
      created_at: new Date().toISOString(),
    },
  );
  db.seq.users = 5;

  // An Event for testing
  db.tables.events.push({
    id: 10,
    organizer_id: 1,
    title: 'Afrofuture Festival 2026',
    category: 'Music',
    city: 'Accra',
    venue: 'Black Star Square',
    start_date: '2026-12-28',
    status: 'published',
    created_at: new Date().toISOString(),
  });
  db.seq.events = 11;

  ({ server } = await import('../src/server.js'));
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  if (!server) return;
  return new Promise((resolve) => server.close(resolve));
});

async function login(email, password = 'password123') {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  return data.accessToken || data.token;
}


test('1. Follow and unfollow a friend', async () => {
  const aliceToken = await login('alice@tribes.com');

  // Alice follows Bob (id: 2)
  const followRes = await fetch(`${base}/users/friends/2/follow`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${aliceToken}` },
  });
  assert.equal(followRes.status, 201);
  const followData = await followRes.json();
  assert.equal(followData.following, true);

  // Check follow status
  const statusRes = await fetch(`${base}/users/friends/2/status`, {
    headers: { Authorization: `Bearer ${aliceToken}` },
  });
  assert.equal(statusRes.status, 200);
  const statusData = await statusRes.json();
  assert.equal(statusData.isFollowing, true);

  // Check notification created for Bob
  const bobNotifs = db.tables.notifications.filter((n) => n.user_id === 2);
  assert.ok(bobNotifs.length > 0);
  assert.ok(bobNotifs.some((n) => n.title.includes('Tribe') || n.title.includes('Friend') || n.message.includes('Alice')));

  // Check Alice's friends list
  const listRes = await fetch(`${base}/users/friends/list`, {
    headers: { Authorization: `Bearer ${aliceToken}` },
  });
  assert.equal(listRes.status, 200);
  const listData = await listRes.json();
  assert.equal(listData.counts.following, 1);
  assert.equal(listData.following[0].name, 'Bob Mensah');

  // Unfollow Bob
  const unfollowRes = await fetch(`${base}/users/friends/2/follow`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${aliceToken}` },
  });
  assert.equal(unfollowRes.status, 200);
  const unfollowData = await unfollowRes.json();
  assert.equal(unfollowData.following, false);
});

test('2. Friends Attending Detection ("5 of your friends are attending this event")', async () => {
  const aliceToken = await login('alice@tribes.com');

  // Alice follows Bob (2) and Charlie (3)
  await fetch(`${base}/users/friends/2/follow`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${aliceToken}` },
  });
  await fetch(`${base}/users/friends/3/follow`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${aliceToken}` },
  });

  // Bob and Charlie have active tickets for Event 10
  db.tables.tickets.push(
    { id: 1, user_id: 2, event_id: 10, status: 'active', ticket_code: 'TKT-BOB-01' },
    { id: 2, user_id: 3, event_id: 10, status: 'active', ticket_code: 'TKT-CHARLIE-01' },
    { id: 3, user_id: 4, event_id: 10, status: 'active', ticket_code: 'TKT-DAVID-01' }, // David is attending, but Alice doesn't follow him
  );

  const friendsAttendingRes = await fetch(`${base}/meetups/event/10/friends-attending`, {
    headers: { Authorization: `Bearer ${aliceToken}` },
  });
  assert.equal(friendsAttendingRes.status, 200);
  const data = await friendsAttendingRes.json();

  assert.equal(data.count, 2);
  assert.equal(data.headline, '2 of your friends are attending this event');
  assert.equal(data.friends.length, 2);
  const names = data.friends.map((f) => f.name);
  assert.ok(names.includes('Bob Mensah'));
  assert.ok(names.includes('Charlie Doe'));
});

test('3. Event Invites: Invite friends, receive invite, accept invite', async () => {
  const aliceToken = await login('alice@tribes.com');
  const bobToken = await login('bob@tribes.com');

  // Alice invites Bob to event 10
  const inviteRes = await fetch(`${base}/meetups/event/10/invite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${aliceToken}`,
    },
    body: JSON.stringify({
      recipientIds: [2],
      note: 'Hey Bob, pull up with the squad!',
    }),
  });
  assert.equal(inviteRes.status, 201);
  const inviteData = await inviteRes.json();
  assert.equal(inviteData.invitedCount, 1);

  // Bob checks his invites
  const myInvitesRes = await fetch(`${base}/meetups/invites/mine`, {
    headers: { Authorization: `Bearer ${bobToken}` },
  });
  assert.equal(myInvitesRes.status, 200);
  const myInvitesData = await myInvitesRes.json();
  assert.ok(myInvitesData.invites.length > 0);
  const targetInvite = myInvitesData.invites.find((i) => i.eventId === 10);
  assert.ok(targetInvite);
  assert.equal(targetInvite.sender.name, 'Alice Smith');
  assert.equal(targetInvite.note, 'Hey Bob, pull up with the squad!');
  assert.equal(targetInvite.status, 'pending');

  // Bob accepts the invite
  const respondRes = await fetch(`${base}/meetups/invites/${targetInvite.id}/respond`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bobToken}`,
    },
    body: JSON.stringify({ status: 'accepted' }),
  });
  assert.equal(respondRes.status, 200);
  const respondData = await respondRes.json();
  assert.equal(respondData.status, 'accepted');

  // Notification sent back to Alice that Bob accepted
  const aliceNotifs = db.tables.notifications.filter((n) => n.user_id === 1);
  assert.ok(aliceNotifs.some((n) => n.message.includes('Bob') && n.message.includes('accepted')));
});

test('4. Squad Outing Chat: Post and retrieve messages', async () => {
  const aliceToken = await login('alice@tribes.com');
  const bobToken = await login('bob@tribes.com');

  // Create a meetup / group outing
  const createMeetupRes = await fetch(`${base}/meetups/event/10`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${aliceToken}`,
    },
    body: JSON.stringify({
      title: 'Accra VIP Tribe Outing',
      description: 'Meeting at gate 3 before the show',
      meetingSpot: 'Gate 3',
      meetAt: '2026-12-28 18:00',
    }),
  });
  assert.equal(createMeetupRes.status, 201);
  const meetupData = await createMeetupRes.json();
  const meetupId = meetupData.meetup.id;

  // Alice sends a message
  const msg1Res = await fetch(`${base}/meetups/${meetupId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${aliceToken}`,
    },
    body: JSON.stringify({ message: 'Welcome to the tribe outing everyone!' }),
  });
  assert.equal(msg1Res.status, 201);
  const msg1 = await msg1Res.json();
  assert.equal(msg1.messageItem.message, 'Welcome to the tribe outing everyone!');

  // Bob joins and replies
  const msg2Res = await fetch(`${base}/meetups/${meetupId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bobToken}`,
    },
    body: JSON.stringify({ message: 'Let’s go! Looking forward to it.' }),
  });
  assert.equal(msg2Res.status, 201);

  // Fetch all messages
  const listMsgRes = await fetch(`${base}/meetups/${meetupId}/messages`, {
    headers: { Authorization: `Bearer ${bobToken}` },
  });
  assert.equal(listMsgRes.status, 200);
  const listMsgData = await listMsgRes.json();
  assert.equal(listMsgData.messages.length, 2);
  assert.equal(listMsgData.messages[0].userName, 'Alice Smith');
  assert.equal(listMsgData.messages[1].userName, 'Bob Mensah');
});
