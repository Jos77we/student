import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Material } from '../models/material.model.js';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function ingestMaterials(file = '../../data/materials_sample.json') {
  try {
    const filePath = path.resolve(__dirname, file);
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(data)) throw new Error('Invalid materials file format');

    await Material.deleteMany({});
    await Material.insertMany(data);
    logger.info(`✅ Ingested ${data.length} materials successfully`);
  } catch (err) {
    logger.error('❌ Material ingestion failed', err);
  }
}
