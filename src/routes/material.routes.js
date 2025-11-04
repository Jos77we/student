import express from 'express';
import multer from 'multer';
import mongoose from 'mongoose';
import { Material } from '../models/material.model.js';
import { logger } from '../utils/logger.js';
import { getGFSBucket } from '../config/database.js';

const router = express.Router();

// Multer setup
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Only PDF files are allowed!'));
    }
    cb(null, true);
  }
});

/**
 * @route POST /api/materials/upload
 * @desc Upload a new nursing revision PDF
 */
router.post('/upload', upload.single('pdf'), async (req, res) => {
  try {
    const { title, topic, level, description, keywords, createdBy } = req.body;
    const file = req.file;

    console.log('Uploaded file:', file);
    
    if (!file) {
      return res.status(400).json({ message: 'No PDF file uploaded.' });
    }

    const bucket = getGFSBucket();
    
    // Create a promise to handle the upload
    const uploadFile = () => {
      return new Promise((resolve, reject) => {
        const uploadStream = bucket.openUploadStream(file.originalname, {
          contentType: file.mimetype
        });

        let uploadedFileInfo = null;

        uploadStream.on('finish', () => {
          // The file info is available on the stream itself after finish
          resolve({
            _id: uploadStream.id,
            filename: uploadStream.filename,
            length: uploadStream.length,
            contentType: uploadStream.options?.contentType || file.mimetype
          });
        });

        uploadStream.on('error', (error) => {
          reject(error);
        });

        // End the stream with the file buffer
        uploadStream.end(file.buffer);
      });
    };

    // Wait for the upload to complete
    const uploadedFile = await uploadFile();
    console.log('GridFS upload completed:', uploadedFile);

    // Create and save the material document
    const material = new Material({
      title,
      topic,
      level,
      description,
      keywords: keywords ? keywords.split(',') : [],
      fileId: uploadedFile._id,
      fileName: uploadedFile.filename,
      fileSize: uploadedFile.length,
      mimeType: uploadedFile.contentType,
      createdBy
    });

    console.log('Material to save:', material);
    await material.save();
    logger.info(`New material uploaded: ${title}`);

    res.status(201).json({
      message: 'PDF uploaded successfully.',
      data: material
    });

  } catch (error) {
    logger.error('Error uploading material:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

/**
 * @route GET /api/materials/:id/download
 * @desc Download a material PDF by ID
 */
router.get('/:id/download', async (req, res) => {
  try {
    const material = await Material.findById(req.params.id);
    if (!material) {
      return res.status(404).json({ message: 'Material not found.' });
    }

    const bucket = getGFSBucket();
    
    // Check if file exists before attempting to download
    const files = await bucket.find({ _id: material.fileId }).toArray();
    if (files.length === 0) {
      return res.status(404).json({ message: 'File not found in storage.' });
    }

    const downloadStream = bucket.openDownloadStream(material.fileId);

    downloadStream.on('error', (error) => {
      logger.error('Download stream error:', error);
      res.status(500).json({ message: 'Error downloading file' });
    });

    res.set({
      'Content-Type': material.mimeType,
      'Content-Disposition': `attachment; filename="${material.fileName}"`,
      'Content-Length': material.fileSize
    });

    downloadStream.pipe(res);

  } catch (error) {
    logger.error('Error downloading material:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

/**
 * @route GET /api/materials
 * @desc Fetch materials metadata
 */
router.get('/', async (req, res) => {
  try {
    const { topic, level, search } = req.query;
    const query = {};
    if (topic) query.topic = topic;
    if (level) query.level = level;
    if (search) query.$text = { $search: search };

    const materials = await Material.find(query).sort({ createdAt: -1 });
    res.json({ count: materials.length, data: materials });
  } catch (error) {
    logger.error('Error fetching materials:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

export default router;