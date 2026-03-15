/**
 * Payment Routes — Flutterwave Inline Modal
 * ──────────────────────────────────────────
 * The frontend uses the flutterwave-react-v3 modal (no redirect).
 * After the modal callback fires with a successful transaction_id,
 * the frontend calls POST /api/payment/verify to confirm and deliver.
 *
 * Active endpoints:
 *   GET  /api/payment/order/:code   — load order details for the frontend
 *   POST /api/payment/verify        — verify Flutterwave tx + fulfill order
 *   POST /api/payment/webhook       — Flutterwave backup webhook
 *   GET  /api/payment/status/:code  — poll order status
 */

import express       from 'express';
import fetch         from 'node-fetch';
import { bot }       from '../bot/index.js';
import { PromoCode } from '../models/purchase.model.js';
import { Purchase }  from '../models/purchase.model.js';
import { Material }  from '../models/material.model.js';
import { getGFSBucket } from '../config/database.js';
import mongoose      from 'mongoose';
import { logger, audit } from '../utils/logger.js';

const router   = express.Router();
const FLW_BASE = 'https://api.flutterwave.com/v3';

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Verify a transaction with Flutterwave ────────────────────────────────────
async function verifyFlwTx(transactionId) {
  const r = await fetch(`${FLW_BASE}/transactions/${transactionId}/verify`, {
    headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` },
  });
  return r.json();
}

// ─── Confirm purchase + deliver file ─────────────────────────────────────────
async function fulfillOrder(promoCode, flwTxId, paymentType) {
  const promo = await PromoCode.findOne({ code: promoCode.toUpperCase() })
    .populate('materialId')
    .populate('userId');

  if (!promo) throw new Error(`PromoCode ${promoCode} not found`);

  // Idempotent — if already completed, just re-deliver the file
  if (promo.status === 'completed') {
    logger.info('[Payment] Already completed, re-delivering file', { promoCode });
    await deliverFile(promo.userId.telegramId, promo.materialId, promoCode, flwTxId);
    return;
  }

  const material = promo.materialId;
  const user     = promo.userId;

  // Create purchase record
  const purchase = await Purchase.create({
    userId:        user._id,
    telegramId:    user.telegramId,
    materialId:    material._id,
    materialTitle: material.title,
    amountUSD:     promo.amountUSD,
    currency:      promo.currency,
    promoCode:     promo.code,
    promoCodeRef:  promo._id,
    paymentMethod: paymentType || 'flutterwave',
    paymentStatus: 'completed',
    transactionRef: String(flwTxId),
    purchasedAt:   new Date(),
  });

  // Mark promo code completed
  promo.status                        = 'completed';
  promo.confirmedAt                   = new Date();
  promo.confirmedBy                   = 'flutterwave_modal';
  promo.paymentDetails.transactionRef = String(flwTxId);
  promo.paymentDetails.submittedAt    = promo.paymentDetails.submittedAt || new Date();
  await promo.save();

  // Add to user's purchased materials (deduplicated)
  const mid = material._id.toString();
  if (!user.purchasedMaterials.includes(mid)) {
    user.purchasedMaterials.push(mid);
    await user.save();
  }

  // Update material stats
  Material.findByIdAndUpdate(material._id, {
    $inc: { purchases: 1, revenue: promo.amountUSD, downloads: 1 },
  }).catch(e => logger.warn('[Payment] stats update failed:', e.message));

  logger.info('[Payment] Purchase confirmed', {
    purchaseId: purchase._id,
    code:       promo.code,
    telegramId: user.telegramId,
    amount:     promo.amountUSD,
    flwTxId,
  });
  audit(user.telegramId, 'purchase_verified', {
    promoCode:  promo.code,
    material:   material.title,
    amount:     promo.amountUSD,
    flwTxId:    String(flwTxId),
    paymentType,
  });

  // Deliver file (non-blocking — don't let delivery failure roll back the record)
  deliverFile(user.telegramId, material, promo.code, flwTxId)
    .catch(err => logger.error('[Payment] File delivery failed:', err));
}

// ─── GET /api/payment/order/:code ─────────────────────────────────────────────
router.get('/order/:code', async (req, res) => {
  try {
    const promo = await PromoCode.findOne({ code: req.params.code.toUpperCase() })
      .populate('materialId', 'title category topics price')
      .lean();

    if (!promo)                       return res.status(404).json({ ok: false, error: 'Promo code not found.' });
    if (promo.status === 'completed') return res.status(409).json({ ok: false, error: 'This order has already been paid.' });
    if (promo.status === 'expired')   return res.status(410).json({ ok: false, error: 'This promo code has expired.' });

    const mat = promo.materialId;
    return res.json({
      ok: true,
      order: {
        promoCode:     promo.code,
        materialTitle: mat?.title    || 'NCLEX Material',
        category:      mat?.category || '',
        topics:        mat?.topics   || [],
        amountUSD:     promo.amountUSD,
        currency:      promo.currency || 'USD',
      },
    });
  } catch (err) {
    logger.error('[Payment] order fetch error:', err);
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

// ─── POST /api/payment/verify ─────────────────────────────────────────────────
// Called by the frontend AFTER the Flutterwave modal callback fires.
// Body: { transactionId, txRef, promoCode }
router.post('/verify', async (req, res) => {
  const { transactionId, txRef, promoCode } = req.body;

  if (!transactionId || !promoCode) {
    return res.status(400).json({ ok: false, error: 'transactionId and promoCode are required.' });
  }

  try {
    // Step 1: verify the transaction with Flutterwave
    const verification = await verifyFlwTx(transactionId);

    if (verification.status !== 'success') {
      logger.warn('[Payment] Flutterwave verification failed', { transactionId, verification });
      return res.status(402).json({ ok: false, error: 'Payment verification failed.' });
    }

    const txData = verification.data;

    if (txData.status !== 'successful') {
      return res.status(402).json({ ok: false, error: `Payment status: ${txData.status}` });
    }

    // Step 2: confirm the promo code matches the amount
    const promo = await PromoCode.findOne({ code: promoCode.toUpperCase() }).lean();
    if (!promo) {
      return res.status(404).json({ ok: false, error: 'Promo code not found.' });
    }

    // Allow small rounding differences
    if (Math.abs(txData.amount - promo.amountUSD) > 0.5) {
      logger.warn('[Payment] Amount mismatch', { expected: promo.amountUSD, received: txData.amount });
      return res.status(402).json({ ok: false, error: 'Payment amount does not match order.' });
    }

    // Step 3: fulfill the order
    await fulfillOrder(promoCode, transactionId, txData.payment_type);

    return res.json({ ok: true, message: 'Payment confirmed. File will arrive on Telegram shortly.' });

  } catch (err) {
    logger.error('[Payment] verify error:', err);
    return res.status(500).json({ ok: false, error: 'Server error during verification. Contact support with your promo code.' });
  }
});

// ─── POST /api/payment/webhook ─────────────────────────────────────────────────
// Backup: Flutterwave sends this if the user closed the browser before the
// modal callback fired. Secured by verif-hash header.
router.post('/webhook', async (req, res) => {
  const signature = req.headers['verif-hash'];
  if (!signature || signature !== process.env.FLW_WEBHOOK_SECRET) {
    logger.warn('[Payment] Webhook invalid signature');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Acknowledge immediately
  res.status(200).json({ received: true });

  const { event, data } = req.body || {};
  logger.info('[Payment] Webhook event', { event, status: data?.status, tx_ref: data?.tx_ref });

  if (event !== 'charge.completed' || data?.status !== 'successful') return;

  try {
    const verification = await verifyFlwTx(data.id);
    if (verification.data?.status !== 'successful') {
      logger.warn('[Payment] Webhook verification failed', { tx_ref: data.tx_ref });
      return;
    }

    // Extract promo code from tx_ref: "NCLEX-601762-1234567890" → "601762"
    const promoCode = data.tx_ref?.split('-')[1];
    if (!promoCode) { logger.warn('[Payment] Cannot parse promo from tx_ref', { tx_ref: data.tx_ref }); return; }

    await fulfillOrder(promoCode, data.id, data.payment_type);

  } catch (err) {
    logger.error('[Payment] Webhook fulfillment error:', err);
  }
});

// ─── GET /api/payment/status/:code ────────────────────────────────────────────
router.get('/status/:code', async (req, res) => {
  try {
    const promo = await PromoCode.findOne({ code: req.params.code.toUpperCase() })
      .select('status confirmedAt fileDeliveredAt')
      .lean();
    if (!promo) return res.status(404).json({ ok: false, error: 'Not found' });
    return res.json({ ok: true, status: promo.status, confirmedAt: promo.confirmedAt, fileDeliveredAt: promo.fileDeliveredAt });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ─── Deliver file to Telegram ─────────────────────────────────────────────────
async function deliverFile(telegramId, material, promoCode, flwTxId) {
  await bot.telegram.sendMessage(telegramId,
    `✅ <b>Payment confirmed!</b>\n\n` +
    `📦 ${esc(material.title)}\n` +
    `🎟 Code: <code>${promoCode}</code>\n` +
    `🔖 Transaction: <code>${esc(String(flwTxId))}</code>\n\n` +
    `📥 <b>Sending your file now...</b>`,
    { parse_mode: 'HTML' }
  );

  const bucket = getGFSBucket();
  const files  = await bucket.find({ _id: new mongoose.Types.ObjectId(material.fileId) }).toArray();

  if (!files.length) {
    await bot.telegram.sendMessage(telegramId,
      `⚠️ File not found in storage. Contact support with code <code>${promoCode}</code>.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const stream = bucket.openDownloadStream(new mongoose.Types.ObjectId(material.fileId));
  const chunks = [];
  await new Promise((resolve, reject) => {
    stream.on('data',  c => chunks.push(c));
    stream.on('end',   resolve);
    stream.on('error', reject);
  });

  const buf = Buffer.concat(chunks);

  if (buf.length > 50 * 1024 * 1024) {
    await bot.telegram.sendMessage(telegramId,
      `⚠️ File too large for Telegram. Contact support with code <code>${promoCode}</code>.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const fileInfo = files[0];
  const fileName = material.fileName || fileInfo.filename || `${material.title.replace(/[^\w\s]/gi,'')}.pdf`;
  const topics   = (material.topics || []).map(esc).join(', ') || 'General NCLEX topics';

  await bot.telegram.sendDocument(telegramId,
    { source: buf, filename: fileName },
    {
      caption:
        `📚 <b>${esc(material.title)}</b>\n` +
        `📖 ${esc(material.category)}\n` +
        `🎯 ${topics}\n\n` +
        `✅ <b>Paid and delivered via NCLEX Prep Bot</b>`,
      parse_mode: 'HTML',
    }
  );

  await PromoCode.updateOne({ code: promoCode }, { fileDeliveredAt: new Date() });
  await Purchase.updateOne({ promoCode },        { fileDeliveredAt: new Date() });

  await bot.telegram.sendMessage(telegramId,
    `🎉 <b>Enjoy your material!</b>\n\n💡 /quiz — practice questions\n📚 /buy — more materials`,
    { parse_mode: 'HTML' }
  );

  logger.info('[Payment] File delivered', { telegramId, promoCode, material: material.title });
  audit(telegramId, 'purchase_delivered', { promoCode, material: material.title });
}

export default router;