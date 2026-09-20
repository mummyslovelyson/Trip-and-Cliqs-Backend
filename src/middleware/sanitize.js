/**
 * Deep Request Sanitization & Prototype Pollution Defense Middleware
 */

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Sanitizes a single string value from malicious HTML / JavaScript execution scripts.
 */
function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  return str
    // Remove script tags and contents
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    // Remove inline event handlers (onload, onclick, onerror, etc.)
    .replace(/\bon\w+\s*=\s*(['"]).*?\1/gi, '')
    // Neutralize dangerous tags
    .replace(/<\/?(iframe|object|embed|applet|meta|link|style)\b[^>]*>/gi, '')
    // Neutralize javascript: and data: pseudo protocols
    .replace(/javascript\s*:/gi, 'blocked:')
    .replace(/data\s*:\s*text\/html/gi, 'blocked:');
}

/**
 * Recursively scrubs an object, array, or primitive.
 */
function deepSanitize(val) {
  if (val === null || val === undefined) return val;

  if (Buffer.isBuffer(val)) {
    return val; // Never mutate raw buffers (needed for cryptographic webhook signatures)
  }

  if (Array.isArray(val)) {
    return val.map((item) => deepSanitize(item));
  }

  if (typeof val === 'object' && val.constructor === Object) {
    const cleanObj = {};
    for (const key of Object.keys(val)) {
      // Prototype pollution block
      if (DANGEROUS_KEYS.has(key)) {
        continue;
      }
      cleanObj[key] = deepSanitize(val[key]);
    }
    return cleanObj;
  }

  if (typeof val === 'string') {
    return sanitizeString(val);
  }

  return val;
}

/**
 * Express middleware to sanitize incoming inputs.
 */
export function sanitizeRequest(req, _res, next) {
  if (req.body && !Buffer.isBuffer(req.body)) {
    req.body = deepSanitize(req.body);
  }
  if (req.query) {
    req.query = deepSanitize(req.query);
  }
  if (req.params) {
    req.params = deepSanitize(req.params);
  }
  next();
}

export default sanitizeRequest;
