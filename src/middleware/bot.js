/**
 * Honeypot bot trap for public form endpoints.
 *
 * The frontend auth forms render a visually-hidden `website` field that
 * humans never see (and therefore submit empty). Naive automation that
 * auto-fills every text input will fill it — the request is swallowed with
 * a fake 200 so the bot cannot learn the real API shape.
 *
 * Apply to public, unauthenticated POST routes (register, login, password
 * reset). Requests must have run through `express.json()` first.
 */
export const honeypot = (req, res, next) => {
  const trap = req.body?.website;
  if (trap && String(trap).trim().length > 0) {
    return res.status(200).json({ message: 'Request received.' });
  }
  next();
};

export default honeypot;
