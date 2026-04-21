import express from 'express';
import { json } from 'express';
import { config } from './config/env.js';
import { bot } from './bot/index.js';
import { logger } from './utils/logger.js';
import materialRoutes from './routes/material.routes.js';
import userRoutes from './routes/user.routes.js';
import paymentRoutes from './routes/payment.routes.js';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '../public');

// Function to get the public URL (checks tunnel first)
function getPublicUrl(req) {
  // Priority: 1. Environment variable, 2. Tunnel detection, 3. Request host
  if (process.env.SERVER_ORIGIN && !process.env.SERVER_ORIGIN.includes('localhost')) {
    return process.env.SERVER_ORIGIN;
  }
  
  // Detect if we're using NPort tunnel
  if (process.env.NPORT_SUBDOMAIN) {
    return `https://${process.env.NPORT_SUBDOMAIN}.nport.link`;
  }
  
  // Fallback to request host
  if (req && req.get('host')) {
    const protocol = req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
    return `${protocol}://${req.get('host')}`;
  }
  
  return 'http://localhost:3000';
}

// CORS configuration
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const allowed = [
      'http://localhost:5173',
      'http://localhost:5713',
      'http://localhost:3000',
      /\.nport\.link$/,  // Allow all nport.link subdomains
      process.env.FRONTEND_URL,
    ].filter(Boolean);
    
    const isAllowed = allowed.some(u => {
      if (u instanceof RegExp) return u.test(origin);
      return origin.startsWith(u);
    });
    
    if (isAllowed) return cb(null, true);
    cb(new Error(`CORS: ${origin} not allowed`));
  },
  credentials: true,
}));

// Webhook needs raw body for signature verification
app.use('/api/payment/webhook',
  express.raw({ type: 'application/json' }),
  (req, _res, next) => {
    if (Buffer.isBuffer(req.body)) {
      try { req.body = JSON.parse(req.body.toString()); } catch (_) { req.body = {}; }
    }
    next();
  }
);

// Serve payment page with dynamic URL injection
app.get('/payment', (req, res) => {
  try {
    const htmlPath = path.join(publicDir, 'payment_page.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    
    // Get the public URL for this request
    const publicUrl = getPublicUrl(req);
    const flwPublicKey = process.env.FLW_PUBLIC_KEY || '';
    
    // Inject environment variables into the HTML
    html = html.replace(/window\.FLW_PUBLIC_KEY = null;/, `window.FLW_PUBLIC_KEY = '${flwPublicKey}';`);
    html = html.replace(/window\.API_BASE = null;/, `window.API_BASE = '${publicUrl}';`);
    html = html.replace(/window\.TUNNEL_URL = null;/, `window.TUNNEL_URL = '${publicUrl}';`);
    
    res.send(html);
  } catch (err) {
    logger.error('Failed to serve payment page:', err);
    res.status(500).send('Payment page unavailable');
  }
});

// JSON body parser for all other routes
app.use(json({ limit: '10mb' }));

// Routes
app.use('/api/materials', materialRoutes);
app.use('/api/users', userRoutes);
app.use('/api/payment', paymentRoutes);

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok', env: config.NODE_ENV, tunnel: process.env.NPORT_SUBDOMAIN || 'none' }));

// Debug endpoint to check current public URL
app.get('/debug/url', (req, res) => {
  res.json({
    serverOrigin: process.env.SERVER_ORIGIN,
    detectedUrl: getPublicUrl(req),
    nportSubdomain: process.env.NPORT_SUBDOMAIN,
    host: req.get('host'),
    protocol: req.get('x-forwarded-proto')
  });
});

// Telegram webhook (production mode)
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