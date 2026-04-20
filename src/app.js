import express          from 'express';
import { json }         from 'express';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path             from 'path';
import { config }       from './config/env.js';
import { bot }          from './bot/index.js';
import { logger }       from './utils/logger.js';
import materialRoutes   from './routes/material.routes.js';
import userRoutes       from './routes/user.routes.js';
import paymentRoutes    from './routes/payment.routes.js';
import cors             from 'cors';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ─── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);   // server-to-server, Postman, etc.
    const allowed = [
      'http://localhost:5173',
      'http://localhost:5713',
      'http://localhost:3000',
      process.env.FRONTEND_URL,
    ].filter(Boolean);
    if (allowed.some(u => origin.startsWith(u))) return cb(null, true);
    cb(new Error(`CORS: ${origin} not allowed`));
  },
  credentials: true,
}));

// ─── Serve the Flutterwave payment page at GET /pay?code=XXXXXX ───────────────
// The HTML file lives at <project-root>/public/payment_page.html
// We inject the Flutterwave public key and the API base URL at request time
// so we never have to hard-code secrets in the frontend file.
app.get('/pay', (_req, res) => {
  try {
    const htmlPath = path.join(__dirname, '..', 'public', 'payment_page.html');
    let html = readFileSync(htmlPath, 'utf8');

    // Replace the placeholder with the real public key (safe to expose in HTML)
    html = html.replace(
      'YOUR_FLUTTERWAVE_PUBLIC_KEY_HERE',
      process.env.FLW_PUBLIC_KEY || ''
    );

    // If the frontend is served from the same Express server, API_BASE is empty
    // (requests go to the same origin). If hosted separately, set FRONTEND_URL.
    // Here we leave API_BASE as empty string — same-origin is correct.
    html = html.replace(
      "window.API_BASE || ''",
      "''"
    );

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    logger.error('Could not serve payment page:', err.message);
    res.status(500).send('Payment page not found. Check that public/payment_page.html exists.');
  }
});

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

// ─── API Routes ────────────────────────────────────────────────────────────────
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