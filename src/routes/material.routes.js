import express from 'express';
import multer from 'multer';
import mongoose from 'mongoose';
import { Material } from '../models/material.model.js';
import { logger } from '../utils/logger.js';
import { getGFSBucket } from '../config/database.js';
import cors from "cors";

const router = express.Router();
router.use(cors());

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
    const { title, topics, category, description, keywords, price, createdBy } = req.body;
    const file = req.file;

    console.log('Uploaded file:', file);
    
    if (!file) {
      return res.status(400).json({ message: 'No PDF file uploaded.' });
    }

    // Validate required fields
    if (!title) {
      return res.status(400).json({ message: 'Title is required.' });
    }

    if (!topics) {
      return res.status(400).json({ message: 'Topics are required.' });
    }

    if (!category) {
      return res.status(400).json({ message: 'Category is required.' });
    }

    // Validate category
    const validCategories = ['Safe and Effective Care Environment', 'Health Promotion and Maintenance', 'Psychosocial Integrity', 'Physiological Integrity'];
    if (!validCategories.includes(category)) {
      return res.status(400).json({ 
        message: 'Invalid category. Must be one of: ' + validCategories.join(', ') 
      });
    }

    // Validate price if provided
    if (!price) {
      return res.status(400).json({ message: 'Price is required.' });
    }

    // Validate price format (optional - can be adjusted based on your needs)
    if (isNaN(parseFloat(price)) && price !== 'Free') {
      return res.status(400).json({ 
        message: 'Price must be a valid number or "Free".' 
      });
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
      topics: topics ? topics.split(',').map(topic => topic.trim()) : [],
      category,
      description,
      keywords: keywords ? keywords.split(',').map(keyword => keyword.trim()) : [],
      price,
      currency: 'USD', // Default currency as per model
      fileId: uploadedFile._id,
      fileName: uploadedFile.filename,
      fileSize: uploadedFile.length,
      mimeType: uploadedFile.contentType,
      createdBy: createdBy || 'system',
      downloads: 0, // Initialize download count
      purchases: 0, // Initialize purchase count
      revenue: 0    // Initialize revenue
    });

    console.log('Material to save:', material);
    await material.save();
    logger.info(`New material uploaded: ${title} with price: ${price} USD`);

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
    const { topics, category, search } = req.query;
    const query = {};
    
    // Apply filters
    if (topics) {
      // Handle multiple topics (comma-separated)
      const topicsArray = topics.split(',').map(topic => topic.trim());
      query.topics = { $in: topicsArray };
    }
    if (category) query.category = category;
    if (search) query.$text = { $search: search };

    const materials = await Material.find(query).sort({ createdAt: -1 });
    res.json({ 
      count: materials.length, 
      data: materials 
    });
  } catch (error) {
    logger.error('Error fetching materials:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

/**
 * @route GET /api/materials/:id
 * @desc Get single material by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const material = await Material.findById(req.params.id);
    if (!material) {
      return res.status(404).json({ message: 'Material not found.' });
    }
    res.json({ data: material });
  } catch (error) {
    logger.error('Error fetching material:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

/**
 * @route PUT /api/materials/:id
 * @desc Update material metadata including price
 */
router.put('/:id', async (req, res) => {
  try {
    const { title, topics, category, description, keywords, price, currency } = req.body;
    
    // Validate price if provided
    if (price && isNaN(parseFloat(price)) && price !== 'Free') {
      return res.status(400).json({ 
        message: 'Price must be a valid number or "Free".' 
      });
    }
    
    // Validate category if provided
    if (category) {
      const validCategories = ['Safe and Effective Care Environment', 'Health Promotion and Maintenance', 'Psychosocial Integrity', 'Physiological Integrity'];
      if (!validCategories.includes(category)) {
        return res.status(400).json({ 
          message: 'Invalid category. Must be one of: ' + validCategories.join(', ') 
        });
      }
    }
    
    const updateData = {
      ...(title && { title }),
      ...(topics && { topics: topics.split(',').map(topic => topic.trim()) }),
      ...(category && { category }),
      ...(description && { description }),
      ...(keywords && { keywords: keywords.split(',').map(keyword => keyword.trim()) }),
      ...(price && { price }),
      ...(currency && { currency })
    };
    
    const material = await Material.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );
    
    if (!material) {
      return res.status(404).json({ message: 'Material not found.' });
    }
    
    logger.info(`Material updated: ${material.title} with new price: ${material.price} ${material.currency}`);
    res.json({ 
      message: 'Material updated successfully.', 
      data: material 
    });
  } catch (error) {
    logger.error('Error updating material:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

/**
 * @route DELETE /api/materials/:id
 * @desc Delete material and its associated file
 */
router.delete('/:id', async (req, res) => {
  try {
    const material = await Material.findById(req.params.id);
    if (!material) {
      return res.status(404).json({ message: 'Material not found.' });
    }

    const bucket = getGFSBucket();
    
    // Delete the file from GridFS
    await bucket.delete(material.fileId);
    
    // Delete the material document
    await Material.findByIdAndDelete(req.params.id);
    
    logger.info(`Material deleted: ${material.title} (${material.price} ${material.currency})`);
    res.json({ 
      message: 'Material and associated file deleted successfully.' 
    });
  } catch (error) {
    logger.error('Error deleting material:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

/**
 * @route GET /api/materials/analytics/summary
 * @desc Get material analytics summary for dashboard
 */
router.get('/analytics/summary', async (req, res) => {
  try {
    // Get total materials count
    const totalMaterials = await Material.countDocuments();
    
    // Get total downloads (sum of all download counts)
    const totalDownloadsResult = await Material.aggregate([
      {
        $group: {
          _id: null,
          totalDownloads: { $sum: "$downloads" }
        }
      }
    ]);
    
    // Get today's date for purchases
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    // Get purchases today (materials created today with price > 0)
    const purchasesToday = await Material.countDocuments({
      createdAt: { $gte: today, $lt: tomorrow },
      price: { $ne: "Free" }
    });
    
    // Get average downloads per material
    const avgDownloadsPerMaterial = totalMaterials > 0 
      ? Math.round(totalDownloadsResult[0]?.totalDownloads / totalMaterials * 10) / 10 
      : 0;
    
    // Calculate new materials this week
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    
    const newThisWeek = await Material.countDocuments({
      createdAt: { $gte: oneWeekAgo }
    });
    
    res.json({
      totalMaterials,
      totalDownloads: totalDownloadsResult[0]?.totalDownloads || 0,
      purchasesToday,
      avgDownloadsPerMaterial,
      newThisWeek
    });
  } catch (error) {
    logger.error('Error fetching analytics summary:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

/**
 * @route GET /api/materials/analytics/topic-trends
 * @desc Get downloads by topics for chart (updated for array field)
 */
router.get('/analytics/topic-trends', async (req, res) => {
  try {
    // Get current month
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    
    // Aggregate downloads by topics (unwind the array)
    const topicTrends = await Material.aggregate([
      {
        $match: {
          createdAt: { $gte: startOfMonth, $lte: endOfMonth }
        }
      },
      {
        $unwind: "$topics"
      },
      {
        $group: {
          _id: "$topics",
          downloads: { $sum: "$downloads" },
          count: { $sum: 1 }
        }
      },
      {
        $project: {
          topic: "$_id",
          downloads: 1,
          count: 1,
          _id: 0
        }
      },
      {
        $sort: { downloads: -1 }
      },
      {
        $limit: 10 // Limit to top 10 topics
      }
    ]);
    
    res.json(topicTrends);
  } catch (error) {
    logger.error('Error fetching topic trends:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

/**
 * @route GET /api/materials/analytics/category-trends
 * @desc Get downloads by category for chart
 */
router.get('/analytics/category-trends', async (req, res) => {
  try {
    // Get current month
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    
    // Aggregate downloads by category
    const categoryTrends = await Material.aggregate([
      {
        $match: {
          createdAt: { $gte: startOfMonth, $lte: endOfMonth }
        }
      },
      {
        $group: {
          _id: "$category",
          downloads: { $sum: "$downloads" },
          count: { $sum: 1 }
        }
      },
      {
        $project: {
          category: "$_id",
          downloads: 1,
          count: 1,
          _id: 0
        }
      },
      {
        $sort: { downloads: -1 }
      }
    ]);
    
    res.json(categoryTrends);
  } catch (error) {
    logger.error('Error fetching category trends:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

/**
 * @route GET /api/materials/analytics/all-with-stats
 * @desc Get all materials with their statistics
 */
router.get('/analytics/all-with-stats', async (req, res) => {
  try {
    const materials = await Material.find({})
      .sort({ createdAt: -1 })
      .select('title topics category downloads purchases revenue price currency createdAt createdBy');
    
    // Format the response to match frontend expectations
    const formattedMaterials = materials.map(material => ({
      id: material._id.toString(),
      title: material.title,
      topics: material.topics || [],
      category: material.category, // Changed from topic to category
      uploads: 1,
      downloads: material.downloads || 0,
      purchases: material.purchases || 0,
      revenue: material.revenue || 0,
      price: material.price || 'Free',
      currency: material.currency || 'USD',
      uploadDate: material.createdAt.toISOString().split('T')[0],
      uploadedBy: material.createdBy || 'system',
      createdAt: material.createdAt // Add this for frontend date formatting
    }));
    
    res.json({
      count: formattedMaterials.length,
      data: formattedMaterials
    });
  } catch (error) {
    logger.error('Error fetching materials with stats:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

/**
 * @route PATCH /api/materials/:id/increment-download
 * @desc Increment download count for a material
 */
router.patch('/:id/increment-download', async (req, res) => {
  try {
    const material = await Material.findByIdAndUpdate(
      req.params.id,
      { $inc: { downloads: 1 } },
      { new: true }
    );
    
    if (!material) {
      return res.status(404).json({ message: 'Material not found.' });
    }
    
    res.json({ 
      message: 'Download count incremented.', 
      downloads: material.downloads 
    });
  } catch (error) {
    logger.error('Error incrementing download count:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

/**
 * @route PATCH /api/materials/:id/increment-purchase
 * @desc Increment purchase count and revenue for a material
 */
router.patch('/:id/increment-purchase', async (req, res) => {
  try {
    const material = await Material.findById(req.params.id);
    if (!material) {
      return res.status(404).json({ message: 'Material not found.' });
    }
    
    // Calculate revenue based on price (skip if free)
    let revenueIncrement = 0;
    if (material.price !== 'Free') {
      const priceValue = parseFloat(material.price);
      if (!isNaN(priceValue)) {
        revenueIncrement = priceValue;
      }
    }
    
    const updatedMaterial = await Material.findByIdAndUpdate(
      req.params.id,
      { 
        $inc: { 
          purchases: 1,
          revenue: revenueIncrement
        } 
      },
      { new: true }
    );
    
    res.json({ 
      message: 'Purchase recorded.', 
      purchases: updatedMaterial.purchases,
      revenue: updatedMaterial.revenue
    });
  } catch (error) {
    logger.error('Error incrementing purchase:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

/**
 * @route GET /api/materials/categories/list
 * @desc Get list of all available categories
 */
router.get('/categories/list', async (req, res) => {
  try {
    const categories = [
      'Safe and Effective Care Environment',
      'Health Promotion and Maintenance',
      'Psychosocial Integrity',
      'Physiological Integrity'
    ];
    
    res.json({
      categories,
      count: categories.length
    });
  } catch (error) {
    logger.error('Error fetching categories list:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

/**
 * @route GET /api/materials/topics/unique
 * @desc Get all unique topics from materials
 */
router.get('/topics/unique', async (req, res) => {
  try {
    const topics = await Material.distinct('topics');
    
    res.json({
      topics: topics.sort(),
      count: topics.length
    });
  } catch (error) {
    logger.error('Error fetching unique topics:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

export default router;