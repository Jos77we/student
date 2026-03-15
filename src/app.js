import express          from 'express';
import { json }         from 'express';
import { config }       from './config/env.js';
import { bot }          from './bot/index.js';
import { logger }       from './utils/logger.js';
import materialRoutes   from './routes/material.routes.js';
import userRoutes       from './routes/user.routes.js';
import paymentRoutes    from './routes/payment.routes.js';
import cors             from 'cors';

const app = express();

// ─── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);   // server-to-server, Postman, etc.
    const allowed = [
      'http://localhost:5173',            // Vite default
      'http://localhost:5713',            // custom Vite port
      'http://localhost:3000',
      process.env.FRONTEND_URL,          // production frontend
    ].filter(Boolean);
    if (allowed.some(u => origin.startsWith(u))) return cb(null, true);
    cb(new Error(`CORS: ${origin} not allowed`));
  },
  credentials: true,
}));

// ─── Webhook needs raw body for signature verification ────────────────────────
app.use('/api/payment/webhook',
  express.raw({ type: 'application/json' }),
  (req, _res, next) => {
    if (Buffer.isBuffer(req.body)) {
      try { req.body = JSON.parse(req.body.toString()); } catch (_) { req.body = {}; }
    }
    next();
  }
);

// ─── JSON body parser for all other routes ────────────────────────────────────
app.use(json({ limit: '10mb' }));

// ─── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/materials', materialRoutes);
app.use('/api/users',     userRoutes);
app.use('/api/payment',   paymentRoutes);

// ─── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', env: config.NODE_ENV }));

// ─── Telegram webhook (production mode) ───────────────────────────────────────
app.post('/webhook/telegram', (req, res) => {
  try {
    bot.handleUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    logger.error('Webhook processing error', err);
    res.sendStatus(500);
  }
});

export default app;