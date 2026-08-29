/**
 * Request timeout middleware.
 *
 * Kills the request if the handler hasn't responded within the specified
 * duration. Prevents slow queries or external API calls from hogging
 * connections indefinitely.
 *
 * Default: 30 seconds. Override per-route:
 *   router.post('/slow', requestTimeout(60_000), handler);
 */

const DEFAULT_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 30_000;

export const requestTimeout = (timeoutMs = DEFAULT_TIMEOUT_MS) => {
  return (req, res, next) => {
    // Already timed out or response already sent — skip.
    if (res.writableEnded || res.headersSent) return next();

    let isTimedOut = false;
    const timer = setTimeout(() => {
      if (!res.headersSent && !res.writableEnded) {
        isTimedOut = true;
        try {
          res.status(504).json({ message: 'Request timed out. Please try again.' });
        } catch {
          // Ignore
        }
      }
    }, timeoutMs);

    // Guard against controller calls after timeout has already responded
    const origJson = res.json.bind(res);
    const origSend = res.send.bind(res);
    const origEnd = res.end.bind(res);

    res.json = function (...args) {
      if (isTimedOut || res.headersSent || res.writableEnded) return this;
      return origJson(...args);
    };

    res.send = function (...args) {
      if (isTimedOut || res.headersSent || res.writableEnded) return this;
      return origSend(...args);
    };

    res.end = function (...args) {
      if (isTimedOut || res.writableEnded) return this;
      return origEnd(...args);
    };

    // Clear the timer as soon as a response is finished so it doesn't keep
    // the event loop alive for completed requests.
    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));

    next();
  };
};

export default requestTimeout;
