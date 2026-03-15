/**
 * Payment Service
 * ───────────────
 * Handles the full Wise payment lifecycle inside the Telegram bot:
 *
 *   1. issuePromoCode()      — create PromoCode doc, return the 6-digit code
 *   2. submitPaymentDetails()— user says they've paid; store Wise details
 *   3. confirmPayment()      — mark code completed, create Purchase, return material
 *   4. verifyPromoCode()     — check if a code is valid & completed (for re-download)
 *   5. getUserPurchases()    — list all purchases for a user
 */

import { PromoCode } from '../models/purchase.model.js';
import { Purchase }  from '../models/purchase.model.js';
import { User }      from '../models/user.model.js';
import { Material }  from '../models/material.model.js';
import { logger }    from '../utils/logger.js';

// ─── Wise payment details (set in your .env) ───────────────────────────────────
export const WISE_DETAILS = {
  accountHolder: process.env.WISE_ACCOUNT_HOLDER || 'Your Full Name',
  email:         process.env.WISE_EMAIL          || 'your@email.com',
  paymentLink:   process.env.WISE_PAYMENT_LINK   || 'https://wise.com/pay/me/YOUR_USERNAME',
  iban:          process.env.WISE_IBAN            || 'GB00 WISE 0000 0000 0000 00',
  bic:           process.env.WISE_BIC             || 'TRWIGB2L',
  currency:      'USD',
};

// ─── Generate a unique 6-digit code ───────────────────────────────────────────
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function uniqueCode() {
  for (let i = 0; i < 10; i++) {
    const code = generateCode();
    const exists = await PromoCode.findOne({ code });
    if (!exists) return code;
  }
  throw new Error('Could not generate a unique promo code — try again.');
}

// ─── 1. Issue a promo code ─────────────────────────────────────────────────────
/**
 * Creates a PromoCode document and returns the code string.
 * Called right after the user confirms which material they want.
 */
export async function issuePromoCode(user, material) {
  const code = await uniqueCode();

  const promo = await PromoCode.create({
    code,
    userId:     user._id,
    materialId: material._id,
    amountUSD:  parseFloat(material.price) || 0,
    status:     'awaiting_payment',
  });

  logger.info('[Payment] PromoCode issued', {
    code,
    userId:     user._id,
    materialId: material._id,
    amount:     promo.amountUSD,
  });

  return promo;
}

// ─── 2. Store payment details submitted by the user ───────────────────────────
/**
 * User has sent their Wise transfer. Store the details and mark status.
 * Returns the updated PromoCode doc.
 */
export async function submitPaymentDetails(code, { method, senderName, senderEmail, transactionRef }) {
  const promo = await PromoCode.findOne({ code: code.toUpperCase() });

  if (!promo) throw new Error(`Promo code ${code} not found.`);
  if (promo.status === 'completed') throw new Error('This code has already been used.');
  if (promo.status === 'expired')   throw new Error('This promo code has expired.');

  promo.status = 'awaiting_payment';
  promo.paymentDetails = {
    method:         method || 'wise',
    senderName:     senderName   || null,
    senderEmail:    senderEmail  || null,
    transactionRef: transactionRef || null,
    submittedAt:    new Date(),
  };

  await promo.save();

  logger.info('[Payment] Details submitted', { code, method, senderName, transactionRef });
  return promo;
}

// ─── 3. Confirm payment & create Purchase record ──────────────────────────────
/**
 * Marks the promo code as completed, creates a Purchase document,
 * and adds the material to the user's purchasedMaterials list.
 *
 * In production you'd call this from an admin command or a Wise webhook.
 * For now the bot calls it automatically after the user submits payment details
 * (trust-based flow — you manually verify then run /confirm <code> if needed).
 */
export async function confirmPayment(code, confirmedBy = 'user_submitted') {
  const promo = await PromoCode.findOne({ code: code.toUpperCase() })
    .populate('userId')
    .populate('materialId');

  if (!promo)                        throw new Error(`Code ${code} not found.`);
  if (promo.status === 'completed')  throw new Error('Already confirmed.');
  if (promo.status === 'expired')    throw new Error('Code expired.');
  if (promo.status === 'pending')    throw new Error('Payment details not yet submitted.');

  const user     = promo.userId;
  const material = promo.materialId;

  // Create the Purchase record
  const purchase = await Purchase.create({
    userId:        user._id,
    telegramId:    user.telegramId,
    materialId:    material._id,
    materialTitle: material.title,
    amountUSD:     promo.amountUSD,
    currency:      promo.currency,
    promoCode:     promo.code,
    promoCodeRef:  promo._id,
    paymentMethod: promo.paymentDetails?.method || 'wise',
    paymentStatus: 'completed',
    transactionRef:promo.paymentDetails?.transactionRef || null,
    senderName:    promo.paymentDetails?.senderName     || null,
    senderEmail:   promo.paymentDetails?.senderEmail    || null,
    purchasedAt:   new Date(),
  });

  // Mark promo code done
  promo.status       = 'completed';
  promo.confirmedAt  = new Date();
  promo.confirmedBy  = confirmedBy;
  await promo.save();

  // Add material to user's purchasedMaterials list (deduplicated)
  const matIdStr = material._id.toString();
  if (!user.purchasedMaterials.includes(matIdStr)) {
    user.purchasedMaterials.push(matIdStr);
    await user.save();
  }

  // Update material revenue stats
  try {
    await Material.findByIdAndUpdate(material._id, {
      $inc: { purchases: 1, revenue: promo.amountUSD, downloads: 1 },
    });
  } catch (e) { logger.warn('[Payment] stats update failed:', e.message); }

  logger.info('[Payment] Purchase confirmed', {
    purchaseId: purchase._id,
    code:       promo.code,
    user:       user.telegramId,
    material:   material.title,
    amount:     promo.amountUSD,
  });

  return { purchase, material, user };
}

// ─── 4. Verify a promo code (for re-download or admin check) ──────────────────
export async function verifyPromoCode(code) {
  const promo = await PromoCode.findOne({ code: code.toUpperCase() })
    .populate('materialId')
    .populate('userId');
  return promo; // null if not found
}

// ─── 5. Get all purchases for a user ──────────────────────────────────────────
export async function getUserPurchases(telegramId) {
  return Purchase.find({ telegramId })
    .populate('materialId', 'title category price')
    .sort({ purchasedAt: -1 })
    .lean();
}

// ─── 6. Mark file as delivered ────────────────────────────────────────────────
export async function markFileDelivered(promoCode) {
  const now = new Date();
  await PromoCode.updateOne({ code: promoCode.toUpperCase() }, { fileDeliveredAt: now });
  await Purchase.updateOne({ promoCode: promoCode.toUpperCase() }, { fileDeliveredAt: now });
}