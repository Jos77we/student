import express from 'express';
import { json } from 'express';
import { config } from './config/env.js';
import { bot } from './bot/index.js';
import { logger } from './utils/logger.js';
import materialRoutes from './routes/material.routes.js';
import userRoutes from './routes/user.routes.js';
import cors from 'cors';

const app = express();

app.use(cors({
  origin: 'http://localhost:8080', // Your Next.js frontend port
  credentials: true
}));
app.use(json({ limit: '10mb' }));

// ✅ Mount materials API route
app.use('/api/materials', materialRoutes);
app.use('/api/users', userRoutes);
app.get('/health', (req, res) => res.json({ status: 'ok', env: config.NODE_ENV }));

// If you want to use webhooks later, point Telegram webhook to /webhook/telegram
// and set TELEGRAM webhook to your.domain/webhook/telegram
app.post('/webhook/telegram', (req, res) => {
  // Telegraf expects the raw update object
  try {
    bot.handleUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    logger.error('Webhook processing error', err);
    res.sendStatus(500);
  }
});

export default app;
