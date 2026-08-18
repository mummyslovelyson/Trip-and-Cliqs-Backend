/**
 * Abuse detection — tracks failed authentication attempts per IP.
 *
 * After FAIL_THRESHOLD failures within the tracking window the IP is
 * temporarily blocked. Block duration doubles on repeated bans (up to
 * a maximum) to throttle persistent attackers.
 *
 * Env vars (all optional):
 *   ABUSE_FAIL_THRESHOLD  — failures before ban (default 20)
 *   ABUSE_WINDOW_MS       — tracking window (default 5 min)
 *   ABUSE_BAN_BASE_MS     — initial ban length (default 15 min)
 *   ABUSE_BAN_MAX_MS      — max ban length (default 2 hours)
 */

const hits = new Map();     // ip -> { count, windowStart }
const bans = new Map();     // ip -> { expiresAt, banLevel }

const FAIL_THRESHOLD = parseInt(process.env.ABUSE_FAIL_THRESHOLD, 10) || 20;
const WINDOW_MS = parseInt(process.env.ABUSE_WINDOW_MS, 10) || 5 * 60_000;
const BAN_BASE_MS = parseInt(process.env.ABUSE_BAN_BASE_MS, 10) || 15 * 60_000;
const BAN_MAX_MS = parseInt(process.env.ABUSE_BAN_MAX_MS, 10) || 2 * 60 * 60_000;

const getClientIp = (req) =>
  req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ||
  req.socket?.remoteAddress ||
  'unknown';

// Sweep stale entries every 5 minutes.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [ip, ban] of bans) {
    if (now > ban.expiresAt) bans.delete(ip);
  }
  for (const [ip, h] of hits) {
    if (now - h.windowStart > WINDOW_MS * 3) hits.delete(ip);
  }
}, 300_000);
if (sweep.unref) sweep.unref();

/**
 * Express middleware — blocks banned IPs before they hit the handler.
 * Place after authenticate on protected routes.
 */
export const blockBannedIps = (req, res, next) => {
  const ip = getClientIp(req);
  const ban = bans.get(ip);
  if (ban && Date.now() < ban.expiresAt) {
    const retryAfter = Math.ceil((ban.expiresAt - Date.now()) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({
      message: 'Your IP has been temporarily blocked due to suspicious activity.',
    });
  }
  if (ban) bans.delete(ip); // ban expired
  next();
};

/**
 * Call this after a FAILED auth attempt (wrong password, invalid token, etc.)
 * to track the IP. After FAIL_THRESHOLD failures the IP is banned.
 */
export const recordAuthFailure = (req) => {
  const ip = getClientIp(req);
  const now = Date.now();
  let h = hits.get(ip);

  if (!h || now - h.windowStart > WINDOW_MS) {
    h = { count: 0, windowStart: now };
    hits.set(ip, h);
  }

  h.count += 1;

  if (h.count >= FAIL_THRESHOLD) {
    const existing = bans.get(ip);
    const level = existing ? existing.banLevel + 1 : 1;
    const duration = Math.min(BAN_BASE_MS * Math.pow(2, level - 1), BAN_MAX_MS);
    bans.set(ip, { expiresAt: now + duration, banLevel: level });
    hits.delete(ip);
    console.warn(`[abuse] IP ${ip} banned for ${Math.round(duration / 60_000)}m after ${h.count} failures`);
  }
};

/**
 * Call this after a SUCCESSFUL auth to reset the failure counter.
 */
export const recordAuthSuccess = (req) => {
  const ip = getClientIp(req);
  hits.delete(ip);
};

export default { blockBannedIps, recordAuthFailure, recordAuthSuccess };
