/**
 * Payment Routes — Flutterwave Inline Modal
 * ──────────────────────────────────────────
 * Endpoints:
 *   GET  /api/payment/order/:code   — load order details for the payment frontend
 *   POST /api/payment/verify        — verify Flutterwave tx + fulfill order + deliver file
 *   POST /api/payment/webhook       — Flutterwave backup webhook (secured by verif-hash)
 *   GET  /api/payment/status/:code  — poll order status
 *
 * Flow:
 *   1. Bot generates a PromoCode and sends user a link → /pay?code=XXXXXX
 *   2. Frontend GETs /api/payment/order/:code  → shows material details + amount
 *   3. User pays via Flutterwave modal (card, M-Pesa, mobile money, etc.)
 *   4. Flutterwave fires modal callback → frontend POSTs /api/payment/verify
 *   5. We verify with Flutterwave, create Purchase record, deliver PDF to Telegram
 *   6. Flutterwave also POSTs to /api/payment/webhook as a backup
 *
 * Required env vars:
 *   FLW_SECRET_KEY         — starts with FLWSECK_ (from Flutterwave dashboard)
 *   FLW_PUBLIC_KEY         — starts with FLWPUBK_ (injected into the HTML page)
 *   FLW_WEBHOOK_SECRET     — string you set in the Flutterwave dashboard webhook section
 *   FLW_ENCRYPTION_KEY     — 3DES encryption key (from dashboard)
 *   TELEGRAM_BOT_TOKEN     — your bot token (used to deliver the file)
 *   FRONTEND_URL           — full URL of your payment page host, e.g. https://pay.yourdomain.com
 */

import express           from 'express';
import fetch             from 'node-fetch';
import { bot }           from '../bot/index.js';
import { PromoCode }     from '../models/purchase.model.js';
import { Purchase }      from '../models/purchase.model.js';
import { Material }      from '../models/material.model.js';
import { getGFSBucket }  from '../config/database.js';
import mongoose          from 'mongoose';
import { logger, audit } from '../utils/logger.js';

const router   = express.Router();
const FLW_BASE = 'https://api.flutterwave.com/v3';

// ─── HTML-escape helper ───────────────────────────────────────────────────────
function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── Verify a transaction directly with Flutterwave API ──────────────────────
async function verifyFlwTransaction(transactionId) {
  const secretKey = process.env.FLW_SECRET_KEY;
  if (!secretKey) {
    throw new Error('FLW_SECRET_KEY is not set in environment variables.');
  }

  const res = await fetch(`${FLW_BASE}/transactions/${transactionId}/verify`, {
    method:  'GET',
    headers: {
      Authorization:  `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Flutterwave verification HTTP ${res.status}: ${body}`);
  }

  return res.json();
}

// ─── Core fulfill logic — idempotent, safe to call twice ─────────────────────
async function fulfillOrder(promoCodeStr, flwTransactionId, paymentType) {
  const promo = await PromoCode.findOne({ code: promoCodeStr.toUpperCase() })
    .populate('materialId')
    .populate('userId');

  if (!promo) {
    throw new Error(`PromoCode "${promoCodeStr}" not found in database.`);
  }

  // ── Idempotency: if already done, just re-deliver the file ─────────────────
  if (promo.status === 'completed') {
    logger.info('[Payment] Order already completed — re-delivering file', { code: promoCodeStr });
    await deliverFileTelegram(promo.userId.telegramId, promo.materialId, promoCodeStr, flwTransactionId);
    return;
  }

  const material = promo.materialId;
  const user     = promo.userId;

  // ── Create Purchase record ──────────────────────────────────────────────────
  const purchase = await Purchase.create({
    userId:         user._id,
    telegramId:     user.telegramId,
    materialId:     material._id,
    materialTitle:  material.title,
    amountUSD:      promo.amountUSD,
    currency:       promo.currency || 'USD',
    promoCode:      promo.code,
    promoCodeRef:   promo._id,
    paymentMethod:  paymentType || 'flutterwave',
    paymentStatus:  'completed',
    transactionRef: String(flwTransactionId),
    purchasedAt:    new Date(),
  });

  // ── Mark PromoCode as completed ─────────────────────────────────────────────
  promo.status                        = 'completed';
  promo.confirmedAt                   = new Date();
  promo.confirmedBy                   = 'flutterwave';
  promo.paymentDetails.transactionRef = String(flwTransactionId);
  promo.paymentDetails.submittedAt    = promo.paymentDetails.submittedAt || new Date();
  await promo.save();

  // ── Update user's purchasedMaterials (deduplicated) ─────────────────────────
  const matIdStr = material._id.toString();
  if (!user.purchasedMaterials.includes(matIdStr)) {
    user.purchasedMaterials.push(matIdStr);
    await user.save();
  }

  // ── Update material stats (fire-and-forget, don't block fulfillment) ────────
  Material.findByIdAndUpdate(material._id, {
    $inc: { purchases: 1, revenue: promo.amountUSD, downloads: 1 },
  }).catch(e => logger.warn('[Payment] Material stats update failed:', e.message));

  logger.info('[Payment] Purchase confirmed', {
    purchaseId: purchase._id,
    code:       promo.code,
    telegramId: user.telegramId,
    amount:     promo.amountUSD,
    flwId:      flwTransactionId,
  });

  audit(user.telegramId, 'purchase_verified', {
    promoCode:   promo.code,
    material:    material.title,
    amount:      promo.amountUSD,
    flwId:       String(flwTransactionId),
    paymentType: paymentType || 'flutterwave',
  });

  // ── Deliver file via Telegram (non-blocking) ─────────────────────────────
  deliverFileTelegram(user.telegramId, material, promo.code, flwTransactionId)
    .catch(err => logger.error('[Payment] File delivery failed after fulfillment:', err.message));
}

// ─── GET /api/payment/order/:code ─────────────────────────────────────────────
// Called by the frontend to load order details before showing the payment modal.
router.get('/order/:code', async (req, res) => {
  try {
    const code  = (req.params.code || '').toUpperCase().trim();
    if (!code)  return res.status(400).json({ ok: false, error: 'No promo code provided.' });

    const promo = await PromoCode.findOne({ code })
      .populate('materialId', 'title category topics price')
      .lean();

    if (!promo) {
      return res.status(404).json({ ok: false, error: 'Promo code not found. Return to the bot and use /buy.' });
    }

    if (promo.status === 'completed') {
      return res.status(409).json({ ok: false, error: 'This order has already been paid.' });
    }

    if (promo.status === 'expired') {
      return res.status(410).json({ ok: false, error: 'This promo code has expired. Please use /buy to generate a new one.' });
    }

    const mat = promo.materialId;
    return res.json({
      ok:    true,
      order: {
        promoCode:     promo.code,
        materialTitle: mat?.title    || 'NCLEX Study Material',
        category:      mat?.category || '',
        topics:        mat?.topics   || [],
        amountUSD:     promo.amountUSD,
        currency:      promo.currency || 'USD',
      },
    });

  } catch (err) {
    logger.error('[Payment] /order/:code error:', err);
    return res.status(500).json({ ok: false, error: 'Server error. Try again in a moment.' });
  }
});

// ─── POST /api/payment/verify ─────────────────────────────────────────────────
// Called by the frontend AFTER the Flutterwave modal fires its success callback.
// Body: { transactionId: number, txRef: string, promoCode: string }
router.post('/verify', async (req, res) => {
  const { transactionId, txRef, promoCode } = req.body || {};

  // Basic input validation
  if (!transactionId) {
    return res.status(400).json({ ok: false, error: 'transactionId is required.' });
  }
  if (!promoCode) {
    return res.status(400).json({ ok: false, error: 'promoCode is required.' });
  }

  logger.info('[Payment] /verify called', { transactionId, txRef, promoCode });

  try {
    // ── Step 1: Verify the transaction with Flutterwave ─────────────────────
    const verification = await verifyFlwTransaction(transactionId);

    if (verification.status !== 'success') {
      logger.warn('[Payment] Flutterwave API returned non-success', { transactionId, status: verification.status });
      return res.status(402).json({ ok: false, error: 'Could not verify payment with Flutterwave.' });
    }

    const txData = verification.data;

    if (txData.status !== 'successful') {
      logger.warn('[Payment] Transaction not successful', { transactionId, txStatus: txData.status });
      return res.status(402).json({ ok: false, error: `Payment status is "${txData.status}". Expected "successful".` });
    }

    // ── Step 2: Confirm the promo code exists and amount matches ────────────
    const promo = await PromoCode.findOne({ code: promoCode.toUpperCase() }).lean();

    if (!promo) {
      return res.status(404).json({ ok: false, error: 'Promo code not found.' });
    }

    // Allow ±$0.50 for currency rounding differences
    const amountDiff = Math.abs(txData.amount - promo.amountUSD);
    if (amountDiff > 0.50) {
      logger.warn('[Payment] Amount mismatch', {
        expected: promo.amountUSD,
        received: txData.amount,
        diff:     amountDiff,
      });
      return res.status(402).json({
        ok:    false,
        error: `Payment amount $${txData.amount} does not match order amount $${promo.amountUSD}.`,
      });
    }

    // ── Step 3: Fulfill the order ────────────────────────────────────────────
    await fulfillOrder(promoCode, transactionId, txData.payment_type);

    return res.json({
      ok:      true,
      message: 'Payment confirmed! Your study material will arrive on Telegram shortly.',
    });

  } catch (err) {
    logger.error('[Payment] /verify error:', { message: err.message, stack: err.stack });
    return res.status(500).json({
      ok:    false,
      error: `Verification error. Contact support with your promo code: ${promoCode}. (${err.message})`,
    });
  }
});

// ─── POST /api/payment/webhook ─────────────────────────────────────────────────
// Flutterwave sends this if the browser closed before the modal callback fired.
// Set the webhook URL in your Flutterwave dashboard → Settings → Webhooks.
// Set the "Secret Hash" in the dashboard to match FLW_WEBHOOK_SECRET in your .env.
router.post('/webhook', async (req, res) => {
  // ── Verify signature ──────────────────────────────────────────────────────
  const signature = req.headers['verif-hash'];
  const expected  = process.env.FLW_WEBHOOK_SECRET;

  if (!expected) {
    logger.error('[Payment] FLW_WEBHOOK_SECRET is not configured');
    return res.status(500).json({ error: 'Webhook secret not configured on server.' });
  }

  if (!signature || signature !== expected) {
    logger.warn('[Payment] Webhook rejected — invalid signature', {
      received: signature ? '(present but wrong)' : '(missing)',
    });
    return res.status(401).json({ error: 'Unauthorized: invalid webhook signature.' });
  }

  // ── Acknowledge immediately (Flutterwave expects 200 within 5 s) ──────────
  res.status(200).json({ received: true });

  const { event, data } = req.body || {};
  logger.info('[Payment] Webhook received', { event, txRef: data?.tx_ref, status: data?.status });

  // Only process successful charges
  if (event !== 'charge.completed' || data?.status !== 'successful') {
    logger.info('[Payment] Webhook ignored (not a successful charge)', { event, status: data?.status });
    return;
  }

  try {
    // ── Re-verify with Flutterwave API (never trust the webhook body alone) ──
    const verification = await verifyFlwTransaction(data.id);

    if (verification.data?.status !== 'successful') {
      logger.warn('[Payment] Webhook re-verification failed', {
        txId:   data.id,
        status: verification.data?.status,
      });
      return;
    }

    // ── Extract promo code from tx_ref ────────────────────────────────────
    // tx_ref format: "NCLEX-<promoCode>-<timestamp>"
    const parts     = (data.tx_ref || '').split('-');
    const promoCode = parts[1];

    if (!promoCode) {
      logger.warn('[Payment] Webhook: cannot extract promo code from tx_ref', { tx_ref: data.tx_ref });
      return;
    }

    await fulfillOrder(promoCode, data.id, data.payment_type);

  } catch (err) {
    logger.error('[Payment] Webhook fulfillment error:', { message: err.message, stack: err.stack });
  }
});

// ─── GET /api/payment/status/:code ────────────────────────────────────────────
// The frontend can poll this to show a real-time status indicator.
router.get('/status/:code', async (req, res) => {
  try {
    const promo = await PromoCode.findOne({ code: req.params.code.toUpperCase() })
      .select('status confirmedAt fileDeliveredAt')
      .lean();

    if (!promo) return res.status(404).json({ ok: false, error: 'Order not found.' });

    return res.json({
      ok:              true,
      status:          promo.status,
      confirmedAt:     promo.confirmedAt     || null,
      fileDeliveredAt: promo.fileDeliveredAt || null,
    });
  } catch (err) {
    logger.error('[Payment] /status error:', err.message);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

// ─── Deliver the purchased PDF file via Telegram ─────────────────────────────
async function deliverFileTelegram(telegramId, material, promoCode, flwTransactionId) {
  // 1. Notify user that payment was confirmed
  await bot.telegram.sendMessage(
    telegramId,
    `✅ <b>Payment confirmed!</b>\n\n` +
    `📦 <b>${esc(material.title)}</b>\n` +
    `🎟 Code: <code>${promoCode}</code>\n` +
    `🔖 Transaction: <code>${esc(String(flwTransactionId))}</code>\n\n` +
    `📥 <b>Sending your file now…</b>`,
    { parse_mode: 'HTML' }
  );

  // 2. Fetch file from GridFS
  const bucket = getGFSBucket();
  const files  = await bucket.find({ _id: new mongoose.Types.ObjectId(material.fileId) }).toArray();

  if (!files.length) {
    await bot.telegram.sendMessage(
      telegramId,
      `⚠️ File not found in storage.\nContact support with code <code>${promoCode}</code>.`,
      { parse_mode: 'HTML' }
    );
    logger.error('[Payment] File not found in GridFS', { fileId: material.fileId, promoCode });
    return;
  }

  // 3. Stream file into a buffer
  const stream = bucket.openDownloadStream(new mongoose.Types.ObjectId(material.fileId));
  const chunks = [];
  await new Promise((resolve, reject) => {
    stream.on('data',  c => chunks.push(c));
    stream.on('end',   resolve);
    stream.on('error', reject);
  });

  const buf = Buffer.concat(chunks);

  // 4. Telegram's file size limit is 50 MB
  if (buf.length > 50 * 1024 * 1024) {
    await bot.telegram.sendMessage(
      telegramId,
      `⚠️ File is too large to send via Telegram (over 50 MB).\nContact support with code <code>${promoCode}</code> and we will send it another way.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // 5. Send the document
  const fileInfo  = files[0];
  const fileName  = material.fileName || fileInfo.filename ||
    `${(material.title || 'material').replace(/[^\w\s]/gi, '')}.pdf`;
  const topicList = (material.topics || []).slice(0, 4).map(esc).join(', ') || 'General NCLEX topics';

  await bot.telegram.sendDocument(
    telegramId,
    { source: buf, filename: fileName },
    {
      caption:
        `📚 <b>${esc(material.title)}</b>\n` +
        `📖 ${esc(material.category || '')}\n` +
        `🎯 ${topicList}\n\n` +
        `✅ <b>Paid and delivered — NCLEX Prep Bot</b>`,
      parse_mode: 'HTML',
    }
  );

  // 6. Update delivery timestamps
  const now = new Date();
  await PromoCode.updateOne({ code: promoCode.toUpperCase() }, { fileDeliveredAt: now });
  await Purchase.updateOne({ promoCode: promoCode.toUpperCase() }, { fileDeliveredAt: now });

  // 7. Follow-up message
  await bot.telegram.sendMessage(
    telegramId,
    `🎉 <b>Enjoy your material!</b>\n\n💡 /quiz — practice with questions\n📚 /buy — browse more materials`,
    { parse_mode: 'HTML' }
  );

  logger.info('[Payment] File delivered via Telegram', { telegramId, promoCode, material: material.title });
  audit(telegramId, 'purchase_delivered', { promoCode, material: material.title });
}

export default router;