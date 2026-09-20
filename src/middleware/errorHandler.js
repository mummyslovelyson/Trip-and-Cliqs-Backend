import crypto from 'crypto';

/**
 * Enterprise Centralized Error Handler Middleware
 *
 * Translates PostgreSQL errors, JWT validation failures, Multer upload errors,
 * and JSON parsing exceptions into uniform, secure HTTP responses.
 *
 * Prevents information disclosure (SQL schemas, stack traces, file paths) in production.
 */
export const errorHandler = (err, req, res, _next) => {
  if (res.headersSent) return;

  const isProduction = process.env.NODE_ENV === 'production';
  const refId = crypto.randomBytes(6).toString('hex'); // Incident correlation ID

  // Always log full error trace with correlation ID on server console
  console.error(`[Error ref:${refId}]`, {
    path: req.originalUrl,
    method: req.method,
    message: err.message,
    code: err.code,
    stack: err.stack,
  });

  // 1. JSON Body Syntax Error (malformed payload from client)
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      status: 'error',
      message: 'Malformed JSON payload provided in request body.',
      refId,
    });
  }

  // 2. Multer & File Upload Errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      status: 'error',
      message: 'Uploaded file is too large. Maximum allowed size is 5 MB.',
      refId,
    });
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({
      status: 'error',
      message: 'Unexpected file upload field.',
      refId,
    });
  }
  if (err.message && err.message.includes('Only image files')) {
    return res.status(400).json({
      status: 'error',
      message: err.message,
      refId,
    });
  }

  // 3. JWT & Authentication Errors
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      status: 'error',
      code: 'TOKEN_EXPIRED',
      message: 'Your session has expired. Please refresh your session or sign in again.',
      refId,
    });
  }
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      status: 'error',
      code: 'INVALID_TOKEN',
      message: 'Authentication token is invalid.',
      refId,
    });
  }

  // 4. CORS & Origin Errors
  if (err.message && err.message.includes('not allowed by CORS')) {
    return res.status(403).json({
      status: 'error',
      message: 'Origin not allowed by CORS policy.',
      refId,
    });
  }

  // 5. PostgreSQL Database Specific Errors
  if (err.code) {
    // Unique violation (e.g. duplicate email, slug, or ticket number)
    if (err.code === '23505') {
      const detail = err.detail || '';
      let field = 'entry';
      if (detail.includes('email')) field = 'Email address';
      else if (detail.includes('slug')) field = 'Event slug';
      else if (detail.includes('ticket_number')) field = 'Ticket number';

      return res.status(409).json({
        status: 'error',
        message: `${field} is already in use. Please use a different value.`,
        refId,
      });
    }

    // Foreign key violation (referenced ID does not exist)
    if (err.code === '23503') {
      return res.status(400).json({
        status: 'error',
        message: 'The referenced item or parent record does not exist.',
        refId,
      });
    }

    // Invalid text representation / syntax (e.g. malformed UUID or integer)
    if (err.code === '22P02') {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid parameter or identifier format provided.',
        refId,
      });
    }

    // Deadlock detected
    if (err.code === '40P01') {
      return res.status(503).json({
        status: 'error',
        message: 'A temporary transaction conflict occurred. Please retry your request.',
        refId,
      });
    }
  }

  // 6. Explicitly set HTTP status from custom error
  const status = Number(err.status || err.statusCode || 500);

  // 7. Generic internal errors
  if (status >= 500 && isProduction) {
    return res.status(500).json({
      status: 'error',
      message: 'An internal error occurred. Our engineering team has been notified.',
      refId,
    });
  }

  res.status(status).json({
    status: 'error',
    message: err.message || 'An unexpected error occurred.',
    refId,
    ...(!isProduction && { stack: err.stack }),
  });
};

export default errorHandler;
