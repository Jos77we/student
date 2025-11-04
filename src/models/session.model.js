import mongoose from 'mongoose';

const { Schema } = mongoose;

const sessionSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  context: { type: Array, default: [] }, // stores short chat memory (system/user/assistant messages)
  lastPrompt: { type: String, default: null },
  lastResponse: { type: String, default: null },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 1000 * 60 * 60 * 24) } // 24h
}, { timestamps: true });

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // auto-delete after expiration

export const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);
