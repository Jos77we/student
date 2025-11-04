import mongoose from 'mongoose';

const { Schema } = mongoose;

const materialSchema = new Schema({
  title: { type: String, required: true },
  topic: { type: String, required: true },
  level: {
    type: String,
    enum: ['fundamentals', 'Entry-Level', 'med-surg', 'pediatrics', 'ob-gyn', 'pharmacology', 'advanced'],
    default: 'fundamentals'
  },
  description: { type: String },
  keywords: [{ type: String }],
  fileId: { type: mongoose.Schema.Types.ObjectId, required: true }, // GridFS file reference
  fileName: { type: String },
  fileSize: { type: Number },
  mimeType: { type: String, default: 'application/pdf' },
  createdBy: { type: String, default: 'system' }
}, { timestamps: true });

materialSchema.index({ topic: 'text', title: 'text', keywords: 'text' });

export const Material = mongoose.models.Material || mongoose.model('Material', materialSchema);
