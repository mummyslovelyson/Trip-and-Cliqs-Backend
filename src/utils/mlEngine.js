/**
 * Machine Learning Engine for Tribes & Cliqs Event Platform
 * Includes:
 * 1. TF-IDF & Metadata Cosine Similarity Event Recommendation
 * 2. Attendee Sentiment & Urgency Classifier
 * 3. Event Demand & Sell-Out Velocity Predictor
 */

const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can', 'did', 'do',
  'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having',
  'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it',
  'its', 'itself', 'just', 'me', 'more', 'most', 'my', 'myself', 'no', 'nor', 'not', 'now', 'of', 'off', 'on',
  'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'she', 'should', 'so',
  'some', 'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they',
  'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'while', 'who', 'whom', 'why', 'with', 'would', 'you', 'your', 'yours', 'yourself', 'yourselves',
  'event', 'events', 'show', 'tickets', 'ticket', 'attend', 'going',
]);

/**
 * Tokenize and normalize text
 */
export function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

/**
 * Compute Term Frequency (TF) map
 */
export function computeTF(tokens) {
  const tf = {};
  if (!tokens || tokens.length === 0) return tf;
  for (const token of tokens) {
    tf[token] = (tf[token] || 0) + 1;
  }
  const total = tokens.length;
  for (const token in tf) {
    tf[token] = tf[token] / total;
  }
  return tf;
}

/**
 * Compute Inverse Document Frequency (IDF) across event corpus
 */
export function computeIDF(documents) {
  const idf = {};
  const N = documents.length || 1;

  for (const doc of documents) {
    const uniqueTokens = new Set(doc.tokens || []);
    for (const token of uniqueTokens) {
      idf[token] = (idf[token] || 0) + 1;
    }
  }

  for (const token in idf) {
    idf[token] = Math.log(1 + N / (1 + idf[token])) + 1;
  }

  return idf;
}

/**
 * Compute vector dot product and cosine similarity
 */
export function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (const term in vecA) {
    const valA = vecA[term];
    normA += valA * valA;
    if (vecB[term]) {
      dotProduct += valA * vecB[term];
    }
  }

  for (const term in vecB) {
    const valB = vecB[term];
    normB += valB * valB;
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Extract feature text from event row
 */
export function getEventFeatureText(event) {
  const parts = [
    event.title || '',
    event.title || '', // Double weight title
    event.category || '',
    event.category || '', // Double weight category
    event.city || '',
    event.venue || '',
    event.description || '',
  ];
  return parts.join(' ');
}

/**
 * Content-Based Machine Learning Event Recommendation
 * Ranks candidate events against user's taste profile using Cosine Similarity on TF-IDF vectors.
 */
export function rankEventsWithML(candidates = [], userHistory = {}) {
  if (!candidates || candidates.length === 0) return [];

  // Build corpus tokens
  const tokenizedEvents = candidates.map((ev) => ({
    event: ev,
    tokens: tokenize(getEventFeatureText(ev)),
  }));

  const idf = computeIDF(tokenizedEvents);

  // Build TF-IDF vectors for all candidates
  const eventVectors = tokenizedEvents.map(({ event, tokens }) => {
    const tf = computeTF(tokens);
    const vector = {};
    for (const term in tf) {
      vector[term] = tf[term] * (idf[term] || 1);
    }
    return { event, vector, tokens };
  });

  // Construct User Taste Vector from past tickets, favorites, or current query
  const userTokens = [
    ...(userHistory.favoriteCategories || []).flatMap((c) => [c, c]),
    ...(userHistory.attendedCategories || []).flatMap((c) => [c, c]),
    ...tokenize(userHistory.query || ''),
    ...(userHistory.recentEventTitles || []).flatMap((t) => tokenize(t)),
    tokenize(userHistory.userCity || ''),
  ].filter(Boolean);

  let userVector = null;
  if (userTokens.length > 0) {
    const userTF = computeTF(userTokens);
    userVector = {};
    for (const term in userTF) {
      userVector[term] = userTF[term] * (idf[term] || 1);
    }
  }

  // Calculate ML Match Score for each event
  const ranked = eventVectors.map(({ event, vector }) => {
    let rawScore = 0;
    let matchPercentage = 75; // Baseline popular event score

    if (userVector) {
      rawScore = cosineSimilarity(userVector, vector);

      // Category and city affinity boosts
      let boost = 0;
      if (userHistory.favoriteCategories?.includes(event.category)) boost += 0.18;
      if (userHistory.attendedCategories?.includes(event.category)) boost += 0.12;
      if (userHistory.userCity && event.city?.toLowerCase() === userHistory.userCity.toLowerCase()) boost += 0.08;

      const combinedScore = Math.min(1.0, rawScore + boost);
      matchPercentage = Math.min(99, Math.round(65 + combinedScore * 34));
    } else if (event.is_featured) {
      matchPercentage = 95;
    }

    // Determine primary matching factor for explainable recommendations
    let matchReason = 'Matches popular events in Ghana';
    if (userHistory.favoriteCategories?.includes(event.category)) {
      matchReason = `Based on your interest in ${event.category}`;
    } else if (userHistory.userCity && event.city?.toLowerCase() === userHistory.userCity.toLowerCase()) {
      matchReason = `Happening near you in ${event.city}`;
    } else if (event.category) {
      matchReason = `Trending in ${event.category}`;
    }

    // Predict demand and sell-out velocity
    const demandPrediction = predictEventDemand(event);

    return {
      ...event,
      matchScore: matchPercentage,
      matchReason,
      demandBadge: demandPrediction.badge,
      sellOutRisk: demandPrediction.risk,
    };
  });

  // Sort by match score descending, then by date ascending
  return ranked.sort((a, b) => b.matchScore - a.matchScore || new Date(a.start_date) - new Date(b.start_date));
}

/**
 * Predictive Event Demand & Sell-Out Velocity
 */
export function predictEventDemand(event) {
  const capacity = Number(event.capacity) || 100;
  const sold = Number(event.quantity_sold || event.view_count || 0);

  const now = new Date();
  const eventDate = event.start_date ? new Date(event.start_date) : new Date(now.getTime() + 7 * 86400000);
  const diffDays = Math.max(1, Math.ceil((eventDate - now) / (1000 * 60 * 60 * 24)));

  const fillRatio = Math.min(1, sold / Math.max(1, capacity));

  // High velocity if fill ratio is high or date is approaching fast
  if (fillRatio >= 0.85 || (fillRatio >= 0.6 && diffDays <= 3)) {
    return {
      badge: '🔥 High Demand - Almost Sold Out',
      risk: 'CRITICAL',
      soldPercentage: Math.round(fillRatio * 100),
    };
  }
  if (fillRatio >= 0.5 || diffDays <= 5) {
    return {
      badge: '⚡ Selling Fast',
      risk: 'HIGH',
      soldPercentage: Math.round(fillRatio * 100),
    };
  }
  return {
    badge: '🎟️ Tickets Available',
    risk: 'NORMAL',
    soldPercentage: Math.round(fillRatio * 100),
  };
}

/**
 * Attendee Query Sentiment & Urgency Classifier
 */
export function classifySentimentAndUrgency(text) {
  if (!text || typeof text !== 'string') {
    return { sentiment: 'neutral', urgency: 'normal', isDispute: false };
  }

  const lower = text.toLowerCase();

  const urgentKeywords = [
    'scam', 'fraud', 'stolen', 'charged twice', 'double charged', 'money deducted',
    'cannot enter', 'stuck at gate', 'denied entry', 'fake ticket', 'emergency',
    'help immediately', 'urgent', 'police', 'unauthorized', 'refund my money',
    'didn’t get ticket', 'did not receive ticket', 'where is my ticket',
  ];

  const negativeKeywords = [
    'bad', 'terrible', 'worst', 'horrible', 'angry', 'disappointed', 'fail',
    'failed', 'issue', 'problem', 'error', 'broken', 'rip off', 'sucks', 'cheat',
  ];

  const positiveKeywords = [
    'great', 'love', 'awesome', 'amazing', 'excited', 'party', 'fire', 'dope',
    'lit', 'good', 'thank you', 'thanks', 'perfect', 'cool', 'vibes',
  ];

  const isUrgent = urgentKeywords.some((keyword) => lower.includes(keyword));
  const hasNegative = negativeKeywords.some((keyword) => lower.includes(keyword));
  const hasPositive = positiveKeywords.some((keyword) => lower.includes(keyword));

  let sentiment = 'neutral';
  if (isUrgent || hasNegative) {
    sentiment = 'negative';
  } else if (hasPositive) {
    sentiment = 'positive';
  }

  return {
    sentiment,
    urgency: isUrgent ? 'high' : 'normal',
    isDispute: isUrgent,
  };
}

export default {
  tokenize,
  computeTF,
  computeIDF,
  cosineSimilarity,
  rankEventsWithML,
  predictEventDemand,
  classifySentimentAndUrgency,
};
