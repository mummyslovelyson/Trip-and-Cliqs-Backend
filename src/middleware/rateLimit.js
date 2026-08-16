/**
 * Lightweight in-memory rate limiter.
 *
 * Guards public auth endpoints (login, password reset) against brute-force
 * and email-bombing. Per-process and per-IP; fine for a single-instance
 * deployment. Swap for a Redis-backed limiter if the app ever runs multiple
 * instances behind a load balancer.
 */

const buckets = new Map();

// Sweep expired buckets periodically so the map never grows unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= bucket.windowMs) buckets.delete(key);
  }
}, 60 * 1000).unref?.();

/**
 * @param {{ windowMs?: number, max?: number, message?: string }} opts
 *   windowMs — sliding window length (ms), default 15 minutes.
 *   max      — max requests per window, default 10.
 */
export const rateLimit = ({ windowMs = 15 * 60 * 1000, max = 10, message } = {}) => {
  return (req, res, next) => {
    const ip =
      req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ||
      req.socket?.remoteAddress ||
      'unknown';
    // Include the route so limits don't stack across endpoints.
    const key = `${req.method}:${req.originalUrl.split('?')[0]}:${ip}`;

    const now = Date.now();
    const bucket = buckets.get(key) || { count: 0, windowStart: now, windowMs };
    if (now - bucket.windowStart >= bucket.windowMs) {
      bucket.count = 0;
      bucket.windowStart = now;
      bucket.windowMs = windowMs;
    }
    bucket.count += 1;
    buckets.set(key, bucket);

    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.windowStart + bucket.windowMs - now) / 1000);
      res.setHeader('Retry-After', String(Math.max(retryAfter, 1)));
      return res.status(429).json({
        message: message || 'Too many attempts. Please try again later.',
      });
    }

    next();
  };
};

export default rateLimit;
