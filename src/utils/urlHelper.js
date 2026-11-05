/**
 * URL Utilities for resolving and sanitizing URLs across email, payment callbacks,
 * redirects, and CORS origins.
 */

/**
 * Resolves a single, clean, valid base URL from an environment string or configuration.
 * Handles:
 * - Multiple space-separated URLs: "https://tribesandcliqsevent.vercel.app https://tribesandcliqs.com"
 * - Comma-separated URLs: "https://tribesandcliqsevent.vercel.app, https://tribesandcliqs.com"
 * - Semicolon or newline-separated URLs
 * - Leading/trailing quotes (', ", `)
 * - Trailing slashes
 * - Malformed strings
 *
 * @param {string} [rawUrl] - Raw URL string (e.g., process.env.FRONTEND_URL)
 * @param {string} [fallback] - Fallback URL if rawUrl cannot be resolved
 * @returns {string} Sanitized base URL without trailing slash or whitespace
 */
export const resolveSingleFrontendUrl = (rawUrl, fallback = null) => {
  const defaultFallback = process.env.NODE_ENV === 'production'
    ? 'https://tribesandcliqsevent.vercel.app'
    : 'http://localhost:5173';
  const effectiveFallback = (fallback && typeof fallback === 'string' && fallback.trim())
    ? fallback.trim().replace(/\/+$/, '')
    : defaultFallback;

  if (!rawUrl || typeof rawUrl !== 'string') {
    return effectiveFallback;
  }

  // Split on whitespace, commas, semicolons, carriage returns, or newlines
  const tokens = rawUrl
    .split(/[\s,;\r\n]+/)
    .map((token) => token.trim().replace(/^['"`<(\[]+|['"`>)\]]+$/g, '').replace(/\/+$/, ''))
    .filter(Boolean);

  for (const token of tokens) {
    if (token.startsWith('http://') || token.startsWith('https://')) {
      try {
        const parsed = new URL(token);
        const origin = `${parsed.protocol}//${parsed.host}`;
        const pathname = parsed.pathname && parsed.pathname !== '/'
          ? parsed.pathname.replace(/\/+$/, '')
          : '';
        return `${origin}${pathname}`;
      } catch {
        // Continue searching tokens
      }
    }
  }

  return effectiveFallback;
};

/**
 * Returns the currently active single frontend base URL.
 */
export const getFrontendUrl = () => resolveSingleFrontendUrl(process.env.FRONTEND_URL);

/**
 * Safely constructs a full frontend URL for a given path, guaranteeing no double slashes,
 * no extraneous origins, and no whitespace.
 *
 * @param {string} [path] - Subpath (e.g. '/organizer', 'my-tickets', or full URL)
 * @returns {string} Fully-qualified sanitized URL
 */
export const createFrontendLink = (path = '') => {
  const base = getFrontendUrl();
  const cleanPath = String(path || '').trim();
  if (!cleanPath) return base;
  if (cleanPath.startsWith('http://') || cleanPath.startsWith('https://')) {
    return resolveSingleFrontendUrl(cleanPath);
  }
  return `${base}${cleanPath.startsWith('/') ? '' : '/'}${cleanPath}`;
};

/**
 * Parses all valid origins from an environment string for CORS or whitelist checks.
 *
 * @param {string} [rawOrigins] - Comma/space separated origins string
 * @param {string[]} [defaults] - Default origins to include
 * @returns {Set<string>} Set of valid origins
 */
export const parseAllowedOrigins = (rawOrigins, defaults = []) => {
  const originSet = new Set(defaults);

  if (!rawOrigins || typeof rawOrigins !== 'string') {
    return originSet;
  }

  const tokens = rawOrigins
    .split(/[\s,;\r\n]+/)
    .map((token) => token.trim().replace(/^['"`<(\[]+|['"`>)\]]+$/g, '').replace(/\/+$/, ''))
    .filter(Boolean);

  for (const token of tokens) {
    if (token.startsWith('http://') || token.startsWith('https://')) {
      try {
        const parsed = new URL(token);
        originSet.add(`${parsed.protocol}//${parsed.host}`);
      } catch {}
    }
  }

  return originSet;
};

export default {
  resolveSingleFrontendUrl,
  getFrontendUrl,
  createFrontendLink,
  parseAllowedOrigins,
};
