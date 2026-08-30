/**
 * Global per-IP rate limiter using a sliding-window counter in memory.
 *
 * Applied to ALL routes as a baseline. Route-specific limiters stack on top
 * (more restrictive windows for sensitive endpoints like login, registration,
 * ticket purchase).
 *
 * Env vars (all optional):
 *   RATE_LIMIT_WINDOW_MS  — window length in ms (default 60 000 = 1 min)
 *   RATE_LIMIT_MAX        — max requests per window per IP (default 100)
 */

const buckets = new Map();

const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000;
const MAX = parseInt(process.env.RATE_LIMIT_MAX, 10) || (process.env.NODE_ENV === 'production' ? 120 : 600);

// Sweep stale entries every 2 minutes so memory stays bounded.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= WINDOW_MS * 2) buckets.delete(key);
  }
}, 120_000);
if (sweep.unref) sweep.unref();

const getClientIp = (req) =>
  req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ||
  req.socket?.remoteAddress ||
  'unknown';

export const globalRateLimit = (req, res, next) => {
  // Exempt frequent lightweight status polling endpoints
  if (req.path === '/api/public/maintenance' || req.path === '/public/maintenance') {
    return next();
  }

  const ip = getClientIp(req);
  const now = Date.now();
  if (res.headersSent || res.writableEnded) return next();

  let bucket = buckets.get(ip);

  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    buckets.set(ip, bucket);
  }

  bucket.count += 1;

  // Set standard rate-limit headers on every response.
  try {
    if (!res.headersSent) {
      res.setHeader('X-RateLimit-Limit', String(MAX));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, MAX - bucket.count)));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil((bucket.windowStart + WINDOW_MS) / 1000)));
    }
  } catch {
    // Ignore header set race conditions
  }

  if (bucket.count > MAX) {
    const retryAfter = Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000);
    try {
      if (!res.headersSent) res.setHeader('Retry-After', String(Math.max(retryAfter, 1)));
    } catch {}
    return res.status(429).json({
      message: 'Too many requests. Please slow down and try again later.',
    });
  }

  next();
};

export default globalRateLimit;
