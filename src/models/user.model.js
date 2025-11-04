import mongoose from 'mongoose';

const { Schema } = mongoose;

const userSchema = new Schema({
  telegramId: { type: String, required: true, unique: true },
  name: { type: String },
  email: { type: String, default: null },
  level: { type: String, default: 'unknown' }, // e.g., "fundamentals", "med-surg", "peds"
  purchasedMaterials: [{ type: String }],
  progress: { type: Schema.Types.Mixed, default: {} },
  lastActive: { type: Date, default: Date.now }
}, { timestamps: true });

export const User = mongoose.models.User || mongoose.model('User', userSchema);
