import mongoose from 'mongoose';

const { Schema } = mongoose;

// ─── PromoCode ─────────────────────────────────────────────────────────────────
// One document per issued promo code.
// Links a user + material together, tracks whether payment was confirmed.
const promoCodeSchema = new Schema({
  code:         { type: String, required: true, unique: true, uppercase: true, trim: true },
  userId:       { type: Schema.Types.ObjectId, ref: 'User', required: true },
  materialId:   { type: Schema.Types.ObjectId, ref: 'Material', required: true },
  amountUSD:    { type: Number, required: true },
  currency:     { type: String, default: 'USD' },

  // lifecycle: pending → awaiting_payment → completed | expired | refunded
  status: {
    type: String,
    enum: ['pending', 'awaiting_payment', 'completed', 'expired', 'refunded'],
    default: 'pending',
  },

  // Payment details submitted by the user (Wise / bank transfer)
  paymentDetails: {
    method:          { type: String, enum: ['wise', 'bank_transfer', 'other'], default: 'wise' },
    senderName:      { type: String, default: null },
    senderEmail:     { type: String, default: null },
    transactionRef:  { type: String, default: null },   // Wise transfer ID or bank ref
    submittedAt:     { type: Date,   default: null },
  },

  // Admin confirmation (or future auto-confirmation via webhook)
  confirmedAt:  { type: Date, default: null },
  confirmedBy:  { type: String, default: null }, // 'admin' | 'webhook' | 'auto'

  // File delivery
  fileDeliveredAt: { type: Date, default: null },

  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
  },
}, { timestamps: true });

promoCodeSchema.index({ userId: 1 });
promoCodeSchema.index({ status: 1 });
promoCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // auto-delete expired codes

export const PromoCode = mongoose.models.PromoCode || mongoose.model('PromoCode', promoCodeSchema);

// ─── Purchase ──────────────────────────────────────────────────────────────────
// Created when a promo code is marked completed (payment confirmed).
// This is the final purchase record — the source of truth for access rights.
const purchaseSchema = new Schema({
  // Who bought it
  userId:       { type: Schema.Types.ObjectId, ref: 'User', required: true },
  telegramId:   { type: String, required: true },   // denormalised for fast lookup

  // What they bought
  materialId:   { type: Schema.Types.ObjectId, ref: 'Material', required: true },
  materialTitle:{ type: String },                    // snapshot at time of purchase

  // Payment
  amountUSD:    { type: Number, required: true },
  currency:     { type: String, default: 'USD' },
  promoCode:    { type: String, required: true },    // the code that unlocked this
  promoCodeRef: { type: Schema.Types.ObjectId, ref: 'PromoCode' },

  paymentMethod:   { type: String, enum: ['wise', 'bank_transfer', 'other'], default: 'wise' },
  paymentStatus:   { type: String, enum: ['pending', 'completed', 'failed', 'refunded'], default: 'completed' },
  transactionRef:  { type: String, default: null },  // Wise ID / bank ref from user

  // Wise-specific details submitted by buyer
  senderName:   { type: String, default: null },
  senderEmail:  { type: String, default: null },

  // Delivery
  fileDeliveredAt: { type: Date, default: null },
  purchasedAt:     { type: Date, default: Date.now },
}, { timestamps: true });

purchaseSchema.index({ userId: 1 });
purchaseSchema.index({ telegramId: 1 });
purchaseSchema.index({ materialId: 1 });
purchaseSchema.index({ promoCode: 1 });

export const Purchase = mongoose.models.Purchase || mongoose.model('Purchase', purchaseSchema);