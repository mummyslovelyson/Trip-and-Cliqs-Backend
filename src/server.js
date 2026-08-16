import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

import authRoutes from './routes/auth.js';
import eventRoutes from './routes/events.js';
import ticketRoutes from './routes/tickets.js';
import orderRoutes from './routes/orders.js';
import userRoutes from './routes/users.js';
import organizerRoutes from './routes/organizer.js';
import adminRoutes from './routes/admin.js';
import meetupRoutes from './routes/meetups.js';
import resaleRoutes from './routes/resale.js';
import uploadRoutes from './routes/upload.js';
import { getSetting } from './utils/settings.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

/* ------------------------------------------------------------------ */
/* Security & parsing middleware                                       */
/* ------------------------------------------------------------------ */

// Helmet sets sensible security headers. Cross-Origin-Resource-Policy is
// relaxed so uploaded images served from the server are embeddable.
// HSTS is enabled so browsers force HTTPS once the site is served securely.
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    hsts: { maxAge: 15552000, includeSubDomains: true, preload: true },
  }),
);

// Enforce HTTPS in production. `trust proxy` is required so req.secure
// reflects the X-Forwarded-Proto header set by the reverse proxy (Nginx,
// Caddy, Cloudflare, etc.). In development everything runs on localhost
// over plain HTTP, so the redirect is skipped.
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    if (req.secure || req.protocol === 'https') return next();
    return res.redirect(301, `https://${req.get('host')}${req.originalUrl}`);
  });
}

// CORS — allow the configured frontend origin(s).
const allowedOrigins = FRONTEND_URL.split(',').map((o) => o.trim());
app.use(
  cors({
    origin(origin, cb) {
      // Allow requests with no origin (curl, Postman, server-to-server, webhooks).
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Refresh-Token'],
  }),
);

// Raw body capture ONLY for the Paystack webhook route so we can verify
// signatures later. For everything else, use JSON / urlencoded parsers.
app.use('/api/orders/verify-payment', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// HTTP request logging.
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Serve uploaded files statically.
const uploadDir = path.resolve(process.env.UPLOAD_DIR || 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

/* ------------------------------------------------------------------ */
/* Health check                                                        */
/* ------------------------------------------------------------------ */
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */
app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/users', userRoutes);
app.use('/api/organizer', organizerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/meetups', meetupRoutes);
app.use('/api/resale', resaleRoutes);
app.use('/api/upload', uploadRoutes);

// Public, unauthenticated platform settings (currency display config).
app.get('/api/public/settings', async (_req, res) => {
  try {
    const [currency, usdRate] = await Promise.all([getSetting('currency'), getSetting('usd_rate')]);
    res.json({
      settings: {
        currency: currency || 'GHS',
        usdRate: Number(usdRate) > 0 ? Number(usdRate) : 15,
      },
    });
  } catch (err) {
    console.error('[publicSettings]', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/* ------------------------------------------------------------------ */
/* 404 handler                                                         */
/* ------------------------------------------------------------------ */
app.use((req, res) => {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
});

/* ------------------------------------------------------------------ */
/* Centralised error handler                                           */
/* ------------------------------------------------------------------ */
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);

  // Multer file-size / type errors.
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ message: 'File too large. Maximum size is 5 MB.' });
  }
  if (err.message?.includes('Only image files')) {
    return res.status(400).json({ message: err.message });
  }
  // CORS errors.
  if (err.message?.includes('not allowed by CORS')) {
    return res.status(403).json({ message: err.message });
  }

  const status = err.status || 500;
  res.status(status).json({
    message: err.message || 'Internal server error',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

/* ------------------------------------------------------------------ */
/* Database schema sync                                                 */
/* ------------------------------------------------------------------ */
// Ensure the schema exists and is up to date before serving traffic.
// initDb.js executes schema.sql plus idempotent migrations (CREATE TABLE IF
// NOT EXISTS, guarded ALTERs), so older databases pick up newly added tables
// such as password_reset_tokens on the next boot. Skipped under NODE_ENV=test,
// where the test harness swaps in an in-memory fake pool.
if (process.env.NODE_ENV !== 'test') {
  await import('./config/initDb.js');
}

/* ------------------------------------------------------------------ */
/* Background jobs                                                     */
/* ------------------------------------------------------------------ */
// Event reminders: notify ticket holders before their events start. Runs once
// at boot, then every 15 minutes. Skipped under NODE_ENV=test where the test
// harness swaps in an in-memory fake pool.
if (process.env.NODE_ENV !== 'test') {
  const { runReminderJob } = await import('./utils/reminders.js');
  runReminderJob();
  setInterval(runReminderJob, 15 * 60 * 1000).unref();
}

/* ------------------------------------------------------------------ */
/* Start server                                                        */
/* ------------------------------------------------------------------ */
const server = app.listen(PORT, () => {
  console.log(`🚀 Tribes & Cliqs backend running on http://localhost:${PORT}`);
  console.log(`   Frontend URL: ${FRONTEND_URL}`);
});

// The server instance is exported so tests (node --test) can close it and
// let the process exit cleanly.
export { server };
export default app;
