import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
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
import supportRoutes from './routes/support.js';
import chatRoutes from './routes/chat.js';
import { getSetting } from './utils/settings.js';
import { maintenanceMiddleware } from './middleware/maintenance.js';
import { globalRateLimit } from './middleware/globalRateLimit.js';
import { requestTimeout } from './middleware/requestTimeout.js';
import { blockBannedIps } from './middleware/abuse.js';
import pool from './config/db.js';
import './config/initDb.js';
import { queueStats } from './utils/jobQueue.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 30_000;

/* ------------------------------------------------------------------ */
/* Security & parsing middleware                                       */
/* ------------------------------------------------------------------ */

// Helmet — security headers tightened.
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    hsts: { maxAge: 15552000, includeSubDomains: true, preload: true },
    contentSecurityPolicy: process.env.NODE_ENV === 'production' ? undefined : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }),
);

// Compression — gzip responses > 1 KB.
app.use(compression({ threshold: 1024 }));

// Enforce HTTPS in production.
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    if (req.secure || req.protocol === 'https') return next();
    return res.redirect(301, `https://${req.get('host')}${req.originalUrl}`);
  });
}

// CORS — allow the configured frontend origin(s), localhost, and Vercel domains.
const parseOrigins = () => {
  const custom = (process.env.FRONTEND_URL || '').split(',').map((o) => o.trim()).filter(Boolean);
  const defaults = [
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:5000',
    'http://127.0.0.1:5173',
    'https://tribesandcliqsevent.vercel.app',
    
  ];
  return new Set([...defaults, ...custom]);
};

const allowedOrigins = parseOrigins();

const isOriginAllowed = (origin) => {
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  if (/^https:\/\/.*\.vercel\.app$/.test(origin)) return true;
  return false;
};

app.use(
  cors({
    origin(origin, cb) {
      if (isOriginAllowed(origin)) return cb(null, true);
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

// Tighter body-size limits per content type.
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// HTTP request logging.
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Serve uploaded files statically.
const uploadDir = path.resolve(process.env.UPLOAD_DIR || 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

/* ------------------------------------------------------------------ */
/* Global middleware — rate limit, abuse block, timeout, maintenance    */
/* ------------------------------------------------------------------ */
app.use(globalRateLimit);
app.use(blockBannedIps);
app.use(requestTimeout());
app.use(maintenanceMiddleware);

/* ------------------------------------------------------------------ */
/* Health check — deep (DB + job queue)                                */
/* ------------------------------------------------------------------ */
app.get('/health', async (_req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    jobs: queueStats(),
  };

  try {
    const start = Date.now();
    await pool.execute('SELECT 1');
    health.db = { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    health.status = 'degraded';
    health.db = { status: 'error', message: err.message };
  }

  const status = health.status === 'ok' ? 200 : 503;
  res.status(status).json(health);
});

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
app.use('/api/support', supportRoutes);
app.use('/api/chat', chatRoutes);

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

// Public maintenance status check (used by frontend to show maintenance page).
app.get('/api/public/maintenance', async (_req, res) => {
  try {
    const maintenanceMode = await getSetting('maintenance_mode');
    const maintenanceMessage = await getSetting('maintenance_message');
    res.json({
      maintenance: maintenanceMode === 'true' || maintenanceMode === true,
      message: maintenanceMessage || 'We are currently performing scheduled maintenance. Please try again later.',
    });
  } catch (err) {
    console.error('[publicMaintenance]', err);
    res.json({ maintenance: false });
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
app.use((err, _req, res, _next) => {
  if (res.headersSent) return;
  console.error('[error]', err.message);

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ message: 'File too large. Maximum size is 5 MB.' });
  }
  if (err.message?.includes('Only image files')) {
    return res.status(400).json({ message: err.message });
  }
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
if (process.env.NODE_ENV !== 'test') {
  await import('./config/initDb.js');
}

/* ------------------------------------------------------------------ */
/* Background jobs                                                     */
/* ------------------------------------------------------------------ */
if (process.env.NODE_ENV !== 'test') {
  const { runReminderJob } = await import('./utils/reminders.js');
  runReminderJob();
  setInterval(runReminderJob, 15 * 60 * 1000).unref();
}

/* ------------------------------------------------------------------ */
/* Start server                                                        */
/* ------------------------------------------------------------------ */
const server = app.listen(PORT, () => {
  console.log(`Tribes & Cliqs backend running on http://localhost:${PORT}`);
  console.log(`   Frontend URL: ${FRONTEND_URL}`);
  console.log(`   Global rate limit: ${process.env.RATE_LIMIT_MAX || 100} req/min per IP`);
  console.log(`   Request timeout: ${process.env.REQUEST_TIMEOUT_MS || 30000}ms`);
});

/* ------------------------------------------------------------------ */
/* Graceful shutdown                                                    */
/* ------------------------------------------------------------------ */
let isShuttingDown = false;

const gracefulShutdown = (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[shutdown] ${signal} received — draining connections...`);

  // Stop accepting new connections.
  server.close(async () => {
    console.log('[shutdown] HTTP server closed');

    try {
      await pool.end();
      console.log('[shutdown] Database pool closed');
    } catch (err) {
      console.error('[shutdown] Error closing DB pool:', err.message);
    }

    process.exit(0);
  });

  // Force exit if draining takes too long.
  setTimeout(() => {
    console.error(`[shutdown] Forced exit after ${SHUTDOWN_TIMEOUT_MS}ms`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  if (err.code === 'ERR_HTTP_HEADERS_SENT') {
    console.warn('[server] Warning: ERR_HTTP_HEADERS_SENT suppressed:', err.message);
    return;
  }
  console.error('[server] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[server] Unhandled Rejection at:', promise, 'reason:', reason);
});

// The server instance is exported so tests (node --test) can close it and
// let the process exit cleanly.
export { server };
export default app;
