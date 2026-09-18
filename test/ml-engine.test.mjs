import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize,
  computeTF,
  computeIDF,
  cosineSimilarity,
  rankEventsWithML,
  predictEventDemand,
  classifySentimentAndUrgency,
} from '../src/utils/mlEngine.js';

test('tokenize removes stopwords and punctuation', () => {
  const tokens = tokenize('Hello! This is an amazing Afrobeats Concert in Accra.');
  assert.ok(tokens.includes('afrobeats'));
  assert.ok(tokens.includes('concert'));
  assert.ok(tokens.includes('accra'));
  assert.ok(!tokens.includes('this'));
  assert.ok(!tokens.includes('is'));
});

test('cosineSimilarity calculates 1.0 for identical vectors and 0 for disjoint', () => {
  const vecA = { afrobeats: 0.8, accra: 0.6 };
  const vecB = { afrobeats: 0.8, accra: 0.6 };
  const simIdentical = cosineSimilarity(vecA, vecB);
  assert.ok(Math.abs(simIdentical - 1.0) < 0.001);

  const vecC = { tech: 0.9, kumasi: 0.5 };
  const simDisjoint = cosineSimilarity(vecA, vecC);
  assert.equal(simDisjoint, 0);
});

test('rankEventsWithML scores matching category and city higher', () => {
  const events = [
    { id: 1, title: 'Afrobeats Mega Bash', category: 'Music', city: 'Accra', capacity: 500 },
    { id: 2, title: 'Kumasi Tech Summit', category: 'Technology', city: 'Kumasi', capacity: 200 },
    { id: 3, title: 'Accra Business Dinner', category: 'Business', city: 'Accra', capacity: 50 },
  ];

  const userHistory = {
    favoriteCategories: ['Music'],
    attendedCategories: ['Music'],
    userCity: 'Accra',
    query: 'afrobeats concert',
  };

  const ranked = rankEventsWithML(events, userHistory);
  assert.equal(ranked[0].id, 1, 'Afrobeats event should rank highest for music lover');
  assert.ok(ranked[0].matchScore >= 80, 'Expected matchScore to be >= 80%');
  assert.ok(ranked[0].demandBadge, 'Expected demand badge');
});

test('classifySentimentAndUrgency identifies urgent ticketing disputes', () => {
  const urgent = classifySentimentAndUrgency('My money was deducted and I was charged twice but did not receive ticket!');
  assert.equal(urgent.urgency, 'high');
  assert.equal(urgent.sentiment, 'negative');
  assert.equal(urgent.isDispute, true);

  const happy = classifySentimentAndUrgency('Awesome! Love this event, thanks so much!');
  assert.equal(happy.urgency, 'normal');
  assert.equal(happy.sentiment, 'positive');
});
