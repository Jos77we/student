import express from 'express';
import { User } from '../models/user.model.js';
import { Purchase } from '../models/purchase.model.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

/**
 * @route GET /api/users
 * @desc Get all users for admin dashboard
 * @access Private (Admin only - add authentication middleware later)
 */
router.get('/', async (req, res) => {
  try {
    // Parse query parameters for pagination and filtering
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const status = req.query.status; // 'active' or 'inactive'
    const search = req.query.search; // Search by name or telegram ID
    const skip = (page - 1) * limit;

    // Build query
    let query = {};
    
    if (status) {
      query.status = status;
    }
    
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { telegramId: { $regex: search, $options: 'i' } }
      ];
    }

    // Get users with pagination
    const users = await User.find(query)
      .sort({ createdAt: -1 }) // Newest first
      .skip(skip)
      .limit(limit)
      .lean();

    // Get total count for pagination
    const totalUsers = await User.countDocuments(query);
    const totalPages = Math.ceil(totalUsers / limit);

    // Format users for frontend
    const formattedUsers = await Promise.all(
      users.map(async (user) => {
        // Calculate purchases count
        const purchasesCount = user.purchasedMaterials?.length || 0;
        
        // Calculate total spent (you need to implement this based on your purchase model)
        // This is a placeholder - adjust based on your actual purchase/transaction model
        const totalSpent = await calculateTotalSpent(user._id);
        
        // Determine status (active if lastActive within last 30 days)
        const isActive = isUserActive(user.lastActive);
        
        // Format Telegram handle
        const telegramHandle = user.telegramId.startsWith('@') 
          ? user.telegramId 
          : `@${user.telegramId}`;

        return {
          id: user._id,
          name: user.name || 'Unknown',
          telegram: telegramHandle,
          signupDate: formatDate(user.createdAt),
          purchases: purchasesCount,
          totalSpent: `$${totalSpent}`,
          status: isActive ? 'active' : 'inactive',
          rawData: {
            telegramId: user.telegramId,
            email: user.email || '',
            level: user.level || 'unknown',
            lastActive: user.lastActive,
            createdAt: user.createdAt
          }
        };
      })
    );

    // Calculate summary statistics
    const summary = {
      totalUsers,
      activeUsers: formattedUsers.filter(u => u.status === 'active').length,
      totalPurchases: formattedUsers.reduce((sum, user) => sum + user.purchases, 0),
      totalRevenue: formattedUsers.reduce((sum, user) => {
        const revenue = parseFloat(user.totalSpent.replace('$', '')) || 0;
        return sum + revenue;
      }, 0),
      averageSpentPerUser: totalUsers > 0 
        ? (formattedUsers.reduce((sum, user) => {
            const revenue = parseFloat(user.totalSpent.replace('$', '')) || 0;
            return sum + revenue;
          }, 0) / totalUsers).toFixed(2)
        : 0
    };

    return res.status(200).json({
      success: true,
      data: {
        users: formattedUsers,
        pagination: {
          currentPage: page,
          totalPages,
          totalUsers,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1
        },
        summary,
        filters: {
          status: status || 'all',
          search: search || ''
        }
      }
    });

  } catch (error) {
    logger.error(`Error fetching users for dashboard: ${error.message}`);
    
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * @route GET /api/users/:id
 * @desc Get single user details
 * @access Private (Admin only)
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Find by MongoDB ID or telegramId
    let user;
    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      user = await User.findById(id).lean();
    } else {
      user = await User.findOne({ telegramId: id }).lean();
    }

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Get detailed purchase history if you have a Purchase model
    const purchaseHistory = await getPurchaseHistory(user._id);
    
    // Calculate statistics
    const purchasesCount = user.purchasedMaterials?.length || 0;
    const totalSpent = await calculateTotalSpent(user._id);
    const isActive = isUserActive(user.lastActive);
    
    const formattedUser = {
      id: user._id,
      name: user.name || 'Unknown',
      telegramId: user.telegramId,
      email: user.email || 'Not provided',
      level: user.level || 'unknown',
      status: isActive ? 'active' : 'inactive',
      signupDate: formatDate(user.createdAt),
      lastActive: formatDate(user.lastActive),
      purchases: purchasesCount,
      totalSpent: `$${totalSpent}`,
      purchasedMaterials: user.purchasedMaterials || [],
      progress: user.progress || {},
      
      // Detailed statistics
      statistics: {
        daysSinceSignup: Math.floor((Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24)),
        lastActiveDaysAgo: Math.floor((Date.now() - new Date(user.lastActive).getTime()) / (1000 * 60 * 60 * 24)),
        averagePurchaseValue: purchasesCount > 0 ? (totalSpent / purchasesCount).toFixed(2) : 0
      },
      
      // Purchase history (if available)
      purchaseHistory: purchaseHistory
    };

    return res.status(200).json({
      success: true,
      data: formattedUser
    });

  } catch (error) {
    logger.error(`Error fetching user details: ${error.message}`);
    
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * @route GET /api/users/stats/summary
 * @desc Get dashboard summary statistics
 * @access Private (Admin only)
 */
router.get('/stats/summary', async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    
    // Calculate active users (active in last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const activeUsersCount = await User.countDocuments({
      lastActive: { $gte: thirtyDaysAgo }
    });

    // Get new users this month
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const newUsersThisMonth = await User.countDocuments({
      createdAt: { $gte: startOfMonth }
    });

    // Calculate total purchases across all users
    const allUsers = await User.find({}, 'purchasedMaterials');
    const totalPurchases = allUsers.reduce((sum, user) => {
      return sum + (user.purchasedMaterials?.length || 0);
    }, 0);

    // Calculate total revenue (placeholder - implement based on your model)
    const totalRevenue = await calculateTotalRevenue();

    // Get users by level distribution
    const levelDistribution = await User.aggregate([
      { $group: { _id: '$level', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    return res.status(200).json({
      success: true,
      data: {
        totalUsers,
        activeUsers: activeUsersCount,
        newUsersThisMonth,
        totalPurchases,
        totalRevenue: `$${totalRevenue}`,
        levelDistribution,
        engagementRate: totalUsers > 0 ? ((activeUsersCount / totalUsers) * 100).toFixed(1) + '%' : '0%'
      }
    });

  } catch (error) {
    logger.error(`Error fetching dashboard stats: ${error.message}`);
    
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * @route GET /api/users/export/csv
 * @desc Export users to CSV
 * @access Private (Admin only)
 */
router.get('/export/csv', async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 }).lean();
    
    const csvData = await Promise.all(
      users.map(async (user) => {
        const purchasesCount = user.purchasedMaterials?.length || 0;
        const totalSpent = await calculateTotalSpent(user._id);
        const isActive = isUserActive(user.lastActive);
        
        return {
          Name: user.name || 'Unknown',
          'Telegram ID': user.telegramId,
          Email: user.email || '',
          Level: user.level || 'unknown',
          'Signup Date': formatDate(user.createdAt, 'csv'),
          'Last Active': formatDate(user.lastActive, 'csv'),
          Purchases: purchasesCount,
          'Total Spent': `$${totalSpent}`,
          Status: isActive ? 'active' : 'inactive'
        };
      })
    );

    // Convert to CSV string
    const headers = ['Name', 'Telegram ID', 'Email', 'Level', 'Signup Date', 'Last Active', 'Purchases', 'Total Spent', 'Status'];
    const csvRows = csvData.map(row => 
      headers.map(header => {
        const cell = row[header] || '';
        return `"${cell.toString().replace(/"/g, '""')}"`;
      }).join(',')
    );
    
    const csvString = [headers.join(','), ...csvRows].join('\n');

    // Set response headers for file download
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=users_${new Date().toISOString().split('T')[0]}.csv`);
    
    return res.status(200).send(csvString);

  } catch (error) {
    logger.error(`Error exporting users to CSV: ${error.message}`);
    
    return res.status(500).json({
      success: false,
      message: 'Error exporting data'
    });
  }
});

// Helper Functions

/**
 * Calculate total spent by a user
 * You need to implement this based on your purchase/transaction model
 */
async function calculateTotalSpent(userId) {
  try {
    // If you have a Purchase model with prices, use this:
    // const purchases = await Purchase.find({ userId }).select('amount');
    // const total = purchases.reduce((sum, purchase) => sum + (purchase.amount || 0), 0);
    
    // For now, using placeholder logic based on purchasedMaterials count
    // Each material costs $20 (adjust based on your pricing)
    const user = await User.findById(userId).select('purchasedMaterials').lean();
    const purchaseCount = user?.purchasedMaterials?.length || 0;
    
    // Default price per material - change this based on your actual pricing
    const pricePerMaterial = 20;
    return purchaseCount * pricePerMaterial;
  } catch (error) {
    logger.error(`Error calculating total spent: ${error.message}`);
    return 0;
  }
}

/**
 * Calculate total revenue across all users
 */
async function calculateTotalRevenue() {
  try {
    // Sum up all purchases across all users
    // If you have a Purchase model, use aggregate query
    // For now, using placeholder logic
    const allUsers = await User.find({}, 'purchasedMaterials').lean();
    const totalPurchases = allUsers.reduce((sum, user) => {
      return sum + (user.purchasedMaterials?.length || 0);
    }, 0);
    
    const pricePerMaterial = 20;
    return totalPurchases * pricePerMaterial;
  } catch (error) {
    logger.error(`Error calculating total revenue: ${error.message}`);
    return 0;
  }
}

/**
 * Get purchase history for a user
 */
async function getPurchaseHistory(userId) {
  try {
    // If you have a Purchase model, implement this
    // const purchases = await Purchase.find({ userId })
    //   .populate('materialId', 'title price')
    //   .sort({ purchaseDate: -1 })
    //   .lean();
    // return purchases;
    
    // Placeholder - return empty array
    return [];
  } catch (error) {
    logger.error(`Error getting purchase history: ${error.message}`);
    return [];
  }
}

/**
 * Check if user is active (based on last activity)
 */
function isUserActive(lastActive) {
  if (!lastActive) return false;
  
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return new Date(lastActive) >= thirtyDaysAgo;
}

/**
 * Format date for display
 */
function formatDate(date, format = 'display') {
  if (!date) return 'N/A';
  
  const d = new Date(date);
  
  if (format === 'csv') {
    return d.toISOString().split('T')[0]; // YYYY-MM-DD
  }
  
  // For display: DD/MM/YYYY
  const day = d.getDate().toString().padStart(2, '0');
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const year = d.getFullYear();
  
  return `${day}/${month}/${year}`;
}

export default router;