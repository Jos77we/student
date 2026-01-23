import mongoose from 'mongoose';

const { Schema } = mongoose;

const materialSchema = new Schema({
  title: { type: String, required: true },
  topics: [{ type: String, required: true }],
  category: {
    type: String,
    enum: ['Safe and Effective Care Environment', 'Health Promotion and Maintenance', 'Psychosocial Integrity', 'Physiological Integrity'],
    required: true
  },
  description: { type: String },
  keywords: [{ type: String }],
   price: {
    type: String,
    required: true
  },
  currency: {
    type: String,
    default: 'USD',
    enum: ['USD']
  },
  fileId: { type: mongoose.Schema.Types.ObjectId, required: true }, // GridFS file reference
  fileName: { type: String },
  fileSize: { type: Number },
  mimeType: { type: String, default: 'application/pdf' },
  createdBy: { type: String, default: 'system' },
  downloads: { type: Number, default: 0 },
  purchases: { type: Number, default: 0 },
  revenue: { type: Number, default: 0 }
}, { timestamps: true });

materialSchema.index({ topic: 'text', title: 'text', keywords: 'text' });

export const Material = mongoose.models.Material || mongoose.model('Material', materialSchema);

