import mongoose from 'mongoose';
import { config } from './env.js';
import { logger } from '../utils/logger.js';

let gfsBucket = null;

export const connectDB = async () => {
  try {
    await mongoose.connect(config.MONGO_URI);
    logger.info('✅ Connected to MongoDB');

    gfsBucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: 'materials'
    });
    logger.info('📦 GridFS bucket initialized');
  } catch (error) {
    logger.error('MongoDB connection failed:', error);
    process.exit(1);
  }
};

export const getGFSBucket = () => {
  if (!gfsBucket) {
    throw new Error('GridFS bucket not initialized yet');
  }
  return gfsBucket;
};

export async function disconnectDB() {
  await mongoose.disconnect();
  logger.info('MongoDB disconnected');
}