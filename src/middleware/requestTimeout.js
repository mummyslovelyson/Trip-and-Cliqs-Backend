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

    const timer = setTimeout(() => {
      if (!res.headersSent) {
        res.status(504).json({ message: 'Request timed out. Please try again.' });
      }
    }, timeoutMs);

    // Clear the timer as soon as a response is finished so it doesn't keep
    // the event loop alive for completed requests.
    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));

    next();
  };
};

export default requestTimeout;
