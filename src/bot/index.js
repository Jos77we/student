import { Telegraf } from 'telegraf';
import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { 
  getNCLEXAIResponse, 
  handleNCLEXPurchase, 
  generateNCLEXQuestions,
  NCLEX_CATEGORIES 
} from '../services/ai.service.js';
import { User } from '../models/user.model.js';
import { Material } from '../models/material.model.js';
import { logger } from '../utils/logger.js';
import { getGFSBucket } from '../config/database.js';

if (!config.TELEGRAM_TOKEN) {
  logger.warn('TELEGRAM_TOKEN not set; bot will initialize but cannot be launched until it is provided.');
}

export const bot = new Telegraf(config.TELEGRAM_TOKEN || '');

// Store user sessions for NCLEX conversational flows
const userSessions = new Map();

// Middleware: ensure user exists
bot.use(async (ctx, next) => {
  try {
    if (!ctx.from?.id) return next();
    const tgId = String(ctx.from.id);
    let user = await User.findOne({ telegramId: tgId });
    if (!user) {
      user = new User({
        telegramId: tgId,
        name: ctx.from.username || `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim(),
        examType: 'NCLEX-RN', // Default to NCLEX-RN
        studyLevel: 'Candidate'
      });
      await user.save();
      logger.info('Created new NCLEX user', { telegramId: tgId });
    } else {
      user.lastActive = new Date();
      await user.save();
    }
    ctx.dbUser = user;
  } catch (err) {
    logger.error('User middleware error', err);
  }
  return next();
});

// /start command - NCLEX focused
bot.start(async (ctx) => {
  const welcome = `🎓 *Welcome to NCLEX Prep Bot!*\n\nI'm your dedicated assistant for NCLEX-RN and NCLEX-PN exam preparation. I can help you with:

📚 *Study Materials* by NCLEX category
💡 *Practice Questions* with detailed rationales
🎯 *Test-Taking Strategies* for clinical judgment
📥 *Revision Materials* purchase and download

*NCLEX Test Plan Categories:*
1. Safe and Effective Care Environment
2. Health Promotion and Maintenance  
3. Psychosocial Integrity
4. Physiological Integrity

*Commands:*
• /help — show help
• /buy — browse & purchase NCLEX materials
• /questions — generate practice questions
• resume — continue where you left off

What NCLEX topic would you like to focus on today?`;
  await ctx.replyWithMarkdown(welcome);
});

// /help command
bot.help((ctx) => {
  return ctx.replyWithMarkdown(`*NCLEX Prep Bot Help*\n\nYou can:
• Use /buy to explore and purchase NCLEX materials
• Use /questions to generate practice questions
• Ask about specific NCLEX topics: "Help with cardiac pharmacology"
• Request materials by category: "Need Psychosocial Integrity materials"
• Get study tips: "How to study for NCLEX-RN"
• Or describe what you're studying for personalized help!

*Quick Tips:*
• Focus on one NCLEX category at a time
• Practice with scenario-based questions
• Master prioritization and delegation
• Review medication classifications`);
});

// Enhanced /buy command - Starts NCLEX category selection flow
bot.command('buy', async (ctx) => {
  const userId = String(ctx.from.id);
  
  // Start NCLEX purchase flow
  userSessions.set(userId, {
    state: 'nclex_purchase',
    step: 'category_selection',
    currentCategory: null,
    selectedMaterial: null,
    materials: [],
    promoCode: null
  });

  await ctx.replyWithMarkdown(`🎯 *NCLEX Study Materials Purchase*\n\nPlease select which NCLEX category you're preparing for:\n\n1. **Safe and Effective Care Environment**\n   • Patient safety & infection control\n   • Legal responsibilities & ethics\n   • Delegation & prioritization\n\n2. **Health Promotion and Maintenance**\n   • Growth & development\n   • Health screening & immunizations\n   • Disease prevention\n\n3. **Psychosocial Integrity**\n   • Mental health disorders\n   • Therapeutic communication\n   • Crisis intervention\n\n4. **Physiological Integrity**\n   • Medical-surgical nursing\n   • Pharmacology\n   • Acute & chronic illness\n\n💡 *Reply with the CATEGORY NAME or NUMBER (1-4)*`);
});

// /questions command for generating practice questions
bot.command('questions', async (ctx) => {
  const userId = String(ctx.from.id);
  
  userSessions.set(userId, {
    state: 'question_generation',
    step: 'ask_topic'
  });

  await ctx.replyWithMarkdown(`🧠 *NCLEX Practice Questions Generator*\n\nWhich topic would you like questions on?\n\nExamples:\n• "Cardiac pharmacology"\n• "Delegation scenarios"\n• "Pediatric growth milestones"\n• "Mental health crisis intervention"\n\n💡 You can also specify a category:\n"questions for Psychosocial Integrity"`);
});

// Text message handler
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  const userId = String(ctx.from.id);
  const session = userSessions.get(userId);
  
  logger.debug('Incoming NCLEX message', { from: ctx.from?.id, text, session });

  // Handle NCLEX purchase flow
  if (session && session.state === 'nclex_purchase') {
    return handleNCLEXPurchaseFlow(ctx, session, text);
  }

  // Handle question generation flow
  if (session && session.state === 'question_generation') {
    return handleQuestionGeneration(ctx, session, text);
  }

  // Handle material selection from list
  if (session && session.state === 'awaiting_material_selection') {
    return handleMaterialSelection(ctx, session, text);
  }

  // Handle download confirmation
  if (session && session.state === 'awaiting_download') {
    return handleDownloadConfirmation(ctx, session, text);
  }

  // Clear any completed sessions
  if (session && session.state === 'completed') {
    userSessions.delete(userId);
  }

  // Resume flow
  if (text.toLowerCase() === 'resume') {
    const user = ctx.dbUser;
    if (session) {
      // Return to previous state
      return continueFromSession(ctx, session);
    }
    return ctx.reply(`Welcome back, ${user.name}! Would you like to continue with NCLEX preparation or start a new topic?`);
  }

  // Buying flow detection - start NCLEX purchase flow
  if (text.toLowerCase().includes('/buy') || (text.toLowerCase().includes('buy') && text.length > 10)) {
    const userId = String(ctx.from.id);
    
    userSessions.set(userId, {
      state: 'nclex_purchase',
      step: 'category_selection',
      currentCategory: null,
      selectedMaterial: null,
      materials: [],
      promoCode: null
    });

    await ctx.replyWithMarkdown(`🎯 *NCLEX Materials Purchase*\n\nSelect a category to begin:\n\n1. Safe and Effective Care Environment\n2. Health Promotion and Maintenance\n3. Psychosocial Integrity\n4. Physiological Integrity\n\n💡 Reply with category name or number`);
    return;
  }

  // Practice questions detection
  if (text.toLowerCase().includes('practice') || text.toLowerCase().includes('questions') || text.toLowerCase().includes('quiz')) {
    await ctx.reply('🧠 Generating NCLEX-style practice questions...');
    const questions = await generateNCLEXQuestions(text);
    return ctx.replyWithMarkdown(questions);
  }

  // Default fallback — use NCLEX AI response
  try {
    await ctx.reply('Analyzing your NCLEX query... 🤔');
    const aiResponse = await getNCLEXAIResponse(ctx.dbUser, text, session || {});
    
    if (aiResponse.step) {
      // Handle structured response
      switch(aiResponse.step) {
        case 'category_selection':
          userSessions.set(userId, {
            state: 'nclex_purchase',
            step: 'category_selection',
            currentCategory: null,
            selectedMaterial: null,
            materials: [],
            promoCode: null
          });
          break;
          
        case 'material_selection':
          userSessions.set(userId, {
            state: 'nclex_purchase',
            step: 'material_selection',
            currentCategory: aiResponse.category,
            selectedMaterial: null,
            materials: aiResponse.materials || [],
            promoCode: null
          });
          break;
          
        case 'confirmation':
          userSessions.set(userId, {
            state: 'nclex_purchase',
            step: 'confirmation',
            currentCategory: aiResponse.category,
            selectedMaterial: aiResponse.material,
            materials: [],
            promoCode: aiResponse.promoCode
          });
          break;
      }
      
      await ctx.replyWithMarkdown(aiResponse.message);
    } else {
      await ctx.replyWithMarkdown(aiResponse);
    }
    
  } catch (err) {
    logger.error('Error handling text', err);
    await ctx.reply('⚠️ Sorry — something went wrong while processing your request. Try again or type /help.');
  }
});

/**
 * Handle NCLEX purchase flow
 */
async function handleNCLEXPurchaseFlow(ctx, session, userInput) {
  const userId = String(ctx.from.id);
  
  try {
    // Handle back command
    if (userInput.toLowerCase() === 'back') {
      if (session.step === 'material_selection') {
        session.step = 'category_selection';
        session.currentCategory = null;
        userSessions.set(userId, session);
        return ctx.replyWithMarkdown(`🔙 Returning to category selection.\n\nChoose a category:\n\n1. Safe and Effective Care Environment\n2. Health Promotion and Maintenance\n3. Psychosocial Integrity\n4. Physiological Integrity`);
      } else if (session.step === 'confirmation') {
        session.step = 'material_selection';
        session.selectedMaterial = null;
        userSessions.set(userId, session);
        return displayNCLEXMaterials(ctx, session.materials, session.currentCategory);
      }
    }

    switch(session.step) {
      case 'category_selection':
        // Parse category selection
        let selectedCategory = null;
        
        // Map numbers to categories based on your model's enum
        const categoryMap = {
          '1': 'Safe and Effective Care Environment',
          '2': 'Health Promotion and Maintenance',
          '3': 'Psychosocial Integrity',
          '4': 'Physiological Integrity'
        };
        
        // Check for category numbers
        if (/^[1-4]$/.test(userInput.trim())) {
          selectedCategory = categoryMap[userInput.trim()];
        } 
        // Check for category names
        else {
          // Find matching category (case-insensitive partial match)
          const categories = [
            'Safe and Effective Care Environment',
            'Health Promotion and Maintenance',
            'Psychosocial Integrity',
            'Physiological Integrity'
          ];
          
          for (const category of categories) {
            if (userInput.toLowerCase().includes(category.toLowerCase().slice(0, 20)) || 
                userInput.toLowerCase().includes(category.split(' ')[0].toLowerCase())) {
              selectedCategory = category;
              break;
            }
          }
        }
        
        if (selectedCategory) {
          session.currentCategory = selectedCategory;
          session.step = 'material_selection';
          userSessions.set(userId, session);
          
          await ctx.replyWithMarkdown(`✅ *Selected: ${selectedCategory}*\n\n🔍 Searching for materials in this category...`);
          
          // Search for materials in this category - use 'category' field from your model
          const materials = await Material.find({
            category: selectedCategory
          }).limit(10).lean();
          
          if (materials.length === 0) {
            await ctx.replyWithMarkdown(`📭 No materials found for "${selectedCategory}".\n\nTry another category or type "back" to choose again.`);
            session.step = 'category_selection';
            session.currentCategory = null;
            userSessions.set(userId, session);
            return;
          }
          
          session.materials = materials;
          userSessions.set(userId, session);
          
          return displayNCLEXMaterials(ctx, materials, selectedCategory);
        } else {
          return ctx.replyWithMarkdown(`❌ Please select a valid NCLEX category:\n\n1. Safe and Effective Care Environment\n2. Health Promotion and Maintenance\n3. Psychosocial Integrity\n4. Physiological Integrity\n\n💡 Reply with the category name or number (1-4)`);
        }
        
      case 'material_selection':
        // Handle material selection by number
        const selectedNumber = parseInt(userInput.trim());
        
        if (isNaN(selectedNumber) || selectedNumber < 1 || selectedNumber > session.materials.length) {
          return ctx.replyWithMarkdown(`❌ Please select a valid number between 1 and ${session.materials.length}.\n\n💡 Just reply with the number (1, 2, 3, etc.) of the material you want.`);
        }
        
        const selectedMaterial = session.materials[selectedNumber - 1];
        session.selectedMaterial = selectedMaterial;
        session.step = 'confirmation';
        
        // Generate promo code
        const promoCode = Math.floor(100000 + Math.random() * 900000).toString();
        session.promoCode = promoCode;
        userSessions.set(userId, session);
        
        // Format topics for display
        const topicsList = selectedMaterial.topics && selectedMaterial.topics.length > 0 
          ? selectedMaterial.topics.join(', ')
          : 'General NCLEX topics';
        
        return ctx.replyWithMarkdown(`✅ *Purchase Confirmation*\n\n📦 **Selected Material:** ${selectedMaterial.title}\n📚 **Category:** ${session.currentCategory}\n🎯 **Topics:** ${topicsList}\n💰 **Price:** ${selectedMaterial.price === 'Free' ? 'Free' : `$${selectedMaterial.price} USD`}\n\n🎟️ **Your Promo Code:** \`${promoCode}\`\n\n⚠️ *Please save this code! You'll need it to download your materials.*\n\n📥 Ready to download? Type "download" to continue.\n🔄 To choose different material, type "back".`);
        
      case 'confirmation':
        if (userInput.toLowerCase() === 'download') {
          session.step = 'downloading';
          userSessions.set(userId, session);
          
          await ctx.replyWithMarkdown(`📥 *Downloading your material...*\n\nUsing promo code: ${session.promoCode}`);
          await sendMaterialFile(ctx, session.selectedMaterial);
          
          // Clear session after successful download
          userSessions.delete(userId);
        } else {
          return ctx.replyWithMarkdown(`📥 To download, type "download"\n🔄 To choose different material, type "back"`);
        }
        break;
    }
    
  } catch (error) {
    logger.error('Error in NCLEX purchase flow', error);
    userSessions.delete(userId);
    await ctx.reply('⚠️ Sorry, there was an error processing your request. Please try using /buy again.');
  }
}

/**
 * Display NCLEX materials to user
 */
async function displayNCLEXMaterials(ctx, materials, category) {
  const userId = String(ctx.from.id);
  
  if (materials.length === 0) {
    return ctx.replyWithMarkdown(`📭 No materials found for "${category}".\n\nTry another category or type "back" to choose again.`);
  }
  
  let response = `📚 *${category} Materials*\n\n`;
  
  materials.forEach((material, index) => {
    const shortDesc = material.description 
      ? (material.description.length > 60 ? material.description.substring(0, 60) + '...' : material.description)
      : 'Comprehensive NCLEX review material';
    
    const priceInfo = material.price === 'Free' ? '💰 Free' : `💰 $${material.price} USD`;
    
    // Use topics array instead of single topic
    const topicsList = material.topics && material.topics.length > 0 
      ? material.topics.slice(0, 3).join(', ') 
      : 'General NCLEX topics';
    
    response += `${index + 1}. **${material.title}**\n`;
    response += `   📝 ${shortDesc}\n`;
    response += `   🎯 Topics: ${topicsList}\n`;
    response += `   ${priceInfo}\n\n`;
  });
  
  response += `💡 *Reply with the NUMBER (1-${Math.min(materials.length, 10)}) to select a material.*\n`;
  response += `Or type "back" to choose a different category.`;
  
  // Update session to await material selection
  const session = userSessions.get(userId);
  if (session) {
    session.state = 'nclex_purchase';
    session.step = 'material_selection';
    session.materials = materials;
    userSessions.set(userId, session);
  }
  
  await ctx.replyWithMarkdown(response);
}

/**
 * Handle question generation flow
 */
async function handleQuestionGeneration(ctx, session, userInput) {
  const userId = String(ctx.from.id);
  
  try {
    if (session.step === 'ask_topic') {
      await ctx.reply('🧠 Generating NCLEX practice questions...');
      const questions = await generateNCLEXQuestions(userInput);
      
      userSessions.set(userId, { state: 'completed' });
      
      await ctx.replyWithMarkdown(questions);
      await ctx.replyWithMarkdown(`💡 *Want more questions on a different topic?*\nJust ask! Or type /questions to start over.`);
    }
  } catch (error) {
    logger.error('Error in question generation', error);
    userSessions.delete(userId);
    await ctx.reply('⚠️ Sorry, there was an error generating questions. Please try again.');
  }
}

/**
 * Handle material selection from list (legacy support)
 */
async function handleMaterialSelection(ctx, session, userInput) {
  const userId = String(ctx.from.id);
  const selectedNumber = parseInt(userInput.trim());
  
  if (isNaN(selectedNumber) || selectedNumber < 1 || selectedNumber > session.materials.length) {
    return ctx.replyWithMarkdown(`❌ Please select a valid number between 1 and ${session.materials.length}.\n\n💡 Just reply with the number (1, 2, 3, etc.) of the material you want.`);
  }
  
  const selectedMaterial = session.materials[selectedNumber - 1];
  
  // Generate promo code
  const promoCode = Math.floor(100000 + Math.random() * 900000).toString();
  
  await ctx.replyWithMarkdown(
    `✅ *Purchase Confirmation*\n\n` +
    `📦 **Selected Material:** ${selectedMaterial.title}\n` +
    `📚 **Category:** ${selectedMaterial.category}\n` +
    `🎯 **Topics:** ${selectedMaterial.topics ? selectedMaterial.topics.join(', ') : 'General'}\n` +
    `💰 **Price:** ${selectedMaterial.price === 'Free' ? 'Free' : `$${selectedMaterial.price} USD`}\n\n` +
    `🎟️ **Your Promo Code:** \`${promoCode}\`\n\n` +
    `⚠️ *Please save this code! You'll need it to download your materials.*\n\n` +
    `📥 Ready to download? Type "download ${promoCode}" to continue.`
  );
  
  // Update session for download confirmation
  userSessions.set(userId, {
    state: 'awaiting_download',
    selectedMaterial: selectedMaterial,
    promoCode: promoCode
  });
}

/**
 * Handle download confirmation
 */
async function handleDownloadConfirmation(ctx, session, userInput) {
  const userId = String(ctx.from.id);
  
  if (userInput.toLowerCase().includes('download') || userInput === session.promoCode) {
    await ctx.replyWithMarkdown(`📥 *Downloading your material...*\n\nUsing promo code: ${session.promoCode}`);
    await sendMaterialFile(ctx, session.selectedMaterial);
    
    // Clear session
    userSessions.delete(userId);
  } else {
    await ctx.replyWithMarkdown(`❌ Please enter your promo code: ${session.promoCode}\n\nOr type "download ${session.promoCode}"`);
  }
}

/**
 * Continue from existing session
 */
async function continueFromSession(ctx, session) {
  switch(session.state) {
    case 'nclex_purchase':
      switch(session.step) {
        case 'category_selection':
          return ctx.replyWithMarkdown(`🔍 Continuing NCLEX purchase...\n\nChoose a category:\n\n1. Safe and Effective Care Environment\n2. Health Promotion and Maintenance\n3. Psychosocial Integrity\n4. Physiological Integrity`);
        case 'material_selection':
          return displayNCLEXMaterials(ctx, session.materials, session.currentCategory);
        case 'confirmation':
          return ctx.replyWithMarkdown(`📥 Ready to download "${session.selectedMaterial.title}"?\n\nType "download" to continue with promo code: ${session.promoCode}`);
      }
      break;
      
    case 'question_generation':
      return ctx.reply('🧠 What topic would you like practice questions on?');
  }
  
  return ctx.reply('Welcome back! How can I help with your NCLEX preparation today?');
}

/**
 * Update material statistics when file is sent
 */
async function updateMaterialStats(materialId) {
  try {
    const material = await Material.findById(materialId);
    if (!material) {
      logger.error('Material not found for stats update', { materialId });
      return false;
    }
    
    // Increment download count
    material.downloads = (material.downloads || 0) + 1;
    
    // If the material is not free, increment purchases and revenue
    if (material.price !== 'Free') {
      material.purchases = (material.purchases || 0) + 1;
      
      // Calculate revenue based on price
      const priceValue = parseFloat(material.price);
      if (!isNaN(priceValue)) {
        material.revenue = (material.revenue || 0) + priceValue;
      }
    }
    
    await material.save();
    logger.info('NCLEX material stats updated', {
      materialId: material._id,
      title: material.title,
      category: material.category,
      downloads: material.downloads,
      purchases: material.purchases,
      price: material.price
    });
    
    return true;
  } catch (error) {
    logger.error('Error updating material stats:', error);
    return false;
  }
}

/**
 * Send material PDF file to user via Telegram
 */
async function sendMaterialFile(ctx, material) {
  try {
    logger.info(`Sending NCLEX file: ${material.title}`, { 
      materialId: material._id,
      category: material.category,
      fileId: material.fileId,
      price: material.price 
    });
    
    // Get the file from GridFS
    const bucket = getGFSBucket();
    
    // Check if file exists using your current GridFS setup
    const files = await bucket.find({ _id: new mongoose.Types.ObjectId(material.fileId) }).toArray();
    if (files.length === 0) {
      logger.error('File not found in GridFS', { fileId: material.fileId });
      await ctx.reply('❌ Sorry, the file could not be found in our storage. Please try another material.');
      return;
    }

    const fileInfo = files[0];
    logger.info(`File found: ${fileInfo.filename}`, { size: fileInfo.length });
    
    // Create a download stream
    const downloadStream = bucket.openDownloadStream(new mongoose.Types.ObjectId(material.fileId));
    
    // Collect file data into a buffer
    const chunks = [];
    await new Promise((resolve, reject) => {
      downloadStream.on('data', (chunk) => chunks.push(chunk));
      downloadStream.on('end', resolve);
      downloadStream.on('error', (error) => {
        logger.error('Download stream error:', error);
        reject(error);
      });
    });

    const fileBuffer = Buffer.concat(chunks);
    
    // Check file size (Telegram has limits)
    const maxFileSize = 50 * 1024 * 1024; // 50MB Telegram limit
    if (fileBuffer.length > maxFileSize) {
      logger.warn('File too large for Telegram', { 
        fileName: material.fileName, 
        fileSize: fileBuffer.length,
        maxSize: maxFileSize 
      });
      await ctx.reply('📁 The file is too large to send via Telegram. Please visit our website to download it, or choose a different material.');
      return;
    }

    // Send the file via Telegram
    await ctx.replyWithChatAction('upload_document');
    
    // Use the actual filename from GridFS or fallback to material title
    const fileName = material.fileName || fileInfo.filename || `${material.title.replace(/[^\w\s]/gi, '')}.pdf`;
    
    // Format topics for caption
    const topicsList = material.topics && material.topics.length > 0 
      ? material.topics.join(', ')
      : 'General NCLEX topics';
    
    await ctx.replyWithDocument({
      source: fileBuffer,
      filename: fileName
    }, {
      caption: `📚 *${material.title}*\n📖 Category: ${material.category}\n🎯 Topics: ${topicsList}\n💰 Price: ${material.price === 'Free' ? 'Free' : `$${material.price} USD`}${material.description ? `\n📝 ${material.description.substring(0, 100)}${material.description.length > 100 ? '...' : ''}` : ''}\n\n✅ Downloaded with NCLEX Prep Bot`
    });

    logger.info(`NCLEX file sent successfully: ${material.title}`, { fileSize: fileBuffer.length });
    
    // Update material statistics (downloads, purchases, revenue)
    const statsUpdated = await updateMaterialStats(material._id);
    if (!statsUpdated) {
      logger.warn('Failed to update material statistics', { materialId: material._id });
    }
    
    // Track user download history
    try {
      const user = ctx.dbUser;
      if (user) {
        if (!user.downloadedMaterials) {
          user.downloadedMaterials = [];
        }
        user.downloadedMaterials.push({
          materialId: material._id,
          title: material.title,
          category: material.category,
          downloadedAt: new Date(),
          price: material.price
        });
        await user.save();
        logger.info('User NCLEX download tracked', { 
          userId: user.telegramId, 
          materialId: material._id,
          category: material.category 
        });
      }
    } catch (userError) {
      logger.error('Error tracking user download:', userError);
    }
    
    // Offer follow-up help
    await ctx.replyWithMarkdown(`🎉 *Download complete!*\n\n📚 Need more NCLEX materials?\n💡 Want practice questions on this topic?\n🔄 Try another category?\n\nJust ask! I'm here to help you pass the NCLEX! 💪`);

  } catch (error) {
    logger.error('Error sending NCLEX material file:', error);
    
    // Provide helpful error messages based on the error type
    if (error.message.includes('file') || error.message.includes('not found')) {
      await ctx.reply('❌ Sorry, there was an issue retrieving the file. The file may have been moved or deleted.');
    } else if (error.message.includes('too large') || error.code === 413) {
      await ctx.reply('📁 The file is too large to send via Telegram. Please choose a different material or visit our website for larger files.');
    } else if (error.code === 400) {
      await ctx.reply('❌ Telegram rejected the file. This might be due to file format or size limitations.');
    } else if (error.message.includes('GridFS bucket not initialized')) {
      await ctx.reply('❌ Database connection issue. Please try again in a moment.');
      logger.error('GridFS bucket not initialized - check MongoDB connection');
    } else {
      await ctx.reply('❌ Sorry, there was an error sending the file. Please try again or choose a different material.');
    }
  }
}

/**
 * Utility function to get material by ID (for direct file access)
 */
async function getMaterialById(materialId) {
  try {
    if (!mongoose.Types.ObjectId.isValid(materialId)) {
      throw new Error('Invalid material ID');
    }
    
    const material = await Material.findById(materialId);
    if (!material) {
      throw new Error('Material not found');
    }
    
    return material;
  } catch (error) {
    logger.error('Error getting material by ID:', error);
    throw error;
  }
}

export default bot;