import mongoose from 'mongoose';

const { Schema } = mongoose;

const purchaseSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  materialId: { type: Schema.Types.ObjectId, ref: 'Material', required: true },
  amountUSD: { type: Number, required: true },
  paymentMethod: { type: String, enum: ['stripe', 'paypal', 'crypto', 'mpesa', 'other'], default: 'other' },
  paymentStatus: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  transactionId: { type: String },
  purchasedAt: { type: Date, default: Date.now }
}, { timestamps: true });

export const Purchase = mongoose.models.Purchase || mongoose.model('Purchase', purchaseSchema);
