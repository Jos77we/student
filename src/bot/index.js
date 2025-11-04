import { Telegraf } from 'telegraf';
import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { getAIResponse, recommendMaterials, simulateQuestions } from '../services/ai.service.js';
import { User } from '../models/user.model.js';
import { Material } from '../models/material.model.js';
import { logger } from '../utils/logger.js';
import { getGFSBucket } from '../config/database.js';

if (!config.TELEGRAM_TOKEN) {
  logger.warn('TELEGRAM_TOKEN not set; bot will initialize but cannot be launched until it is provided.');
}

export const bot = new Telegraf(config.TELEGRAM_TOKEN || '');

// Store user sessions for conversational flows
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
        name: ctx.from.username || `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim()
      });
      await user.save();
      logger.info('Created new user', { telegramId: tgId });
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

// /start command
bot.start(async (ctx) => {
  const welcome = `👋 Hi — I'm *NurseAid*, your study buddy for nursing courses.
I can help you with topic reviews, revision papers, and simulated exam questions.

Commands:
• /help — show help
• /buy — explore and purchase revision materials
• resume — continue where you left off

What topic would you like help with today?`;
  await ctx.replyWithMarkdown(welcome);
});

// /help command
bot.help((ctx) => {
  return ctx.replyWithMarkdown(`You can:
• Use /buy to explore available nursing materials
• Ask for specific topics: "I need help with cardiology"
• Request practice questions: "Give me questions on pharmacology"
• Or just describe what you're studying!`);
});

// Enhanced /buy command - Starts conversational flow
bot.command('buy', async (ctx) => {
  const userId = String(ctx.from.id);
  
  // Start conversational buy flow
  userSessions.set(userId, {
    state: 'buy_flow',
    step: 'ask_interest',
    materials: null
  });

  await ctx.replyWithMarkdown(`🎯 *Great! Let me help you find the perfect nursing materials.*

I have exam papers, revision guides, and practice materials across all nursing specialties.

To help me find what you need, could you tell me:

🤔 *What are you currently studying or preparing for?*

You can mention:
• Specific topics (like "cardiology", "pediatrics", "pharmacology")
• Exam types you're preparing for
• Your current level or course
• Any particular challenges you're facing

Or just describe what you need help with!`);
});

// Text message handler
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  const userId = String(ctx.from.id);
  const session = userSessions.get(userId);
  
  logger.debug('Incoming message', { from: ctx.from?.id, text, session });

  // Handle buy flow conversations
  if (session && session.state === 'buy_flow') {
    return handleBuyFlow(ctx, session, text);
  }

  // Handle material selection from list
  if (session && session.state === 'awaiting_selection' && session.materials) {
    return handleMaterialSelection(ctx, session, text);
  }

  // Clear any completed sessions
  if (session && session.state === 'completed') {
    userSessions.delete(userId);
  }

  // Resume flow
  if (text.toLowerCase() === 'resume') {
    const user = ctx.dbUser;
    return ctx.reply(`Resuming your study, ${user.name}. Would you like to continue last topic or take a new pretest?`);
  }

  // Buying flow detection - start conversational flow
  if (text.toLowerCase().includes('buy') || text.toLowerCase().includes('purchase') || text.toLowerCase().includes('want to buy')) {
    const userId = String(ctx.from.id);
    
    userSessions.set(userId, {
      state: 'buy_flow',
      step: 'ask_interest',
      materials: null
    });

    await ctx.replyWithMarkdown(`🎯 *I'd love to help you find the right materials!*

To get you exactly what you need, could you tell me:

• What *specific topic* are you studying?
• What *type of exam* are you preparing for?
• What's your *current level* (fundamentals, med-surg, advanced, etc.)?
• Any particular *challenges* you're facing?

Just describe what you're working on and I'll find the best matches!`);
    return;
  }

  // Check if the user requested recommendations
  if (text.toLowerCase().includes('material') || text.toLowerCase().includes('topic') || text.toLowerCase().includes('notes')) {
    await ctx.reply('🔍 Searching for study materials related to your topic...');
    const materials = await recommendMaterials(text);
    return displayMaterials(ctx, materials, text);
  }

  // If user wants simulated questions
  if (text.toLowerCase().includes('simulate') || text.toLowerCase().includes('practice') || text.toLowerCase().includes('questions')) {
    await ctx.reply('🧠 Generating simulated questions for your topic...');
    const simulated = await simulateQuestions(text);
    return ctx.reply(simulated);
  }

  // Default fallback — ask AI to interpret question
  try {
    await ctx.reply('Let me think... 🤖');
    const aiReply = await getAIResponse(ctx.dbUser, text);
    await ctx.reply(aiReply);
  } catch (err) {
    logger.error('Error handling text', err);
    await ctx.reply('Sorry — something went wrong while I tried to answer. Try again or type /help.');
  }
});

/**
 * Handle the conversational buy flow
 */
async function handleBuyFlow(ctx, session, userInput) {
  const userId = String(ctx.from.id);
  
  try {
    if (session.step === 'ask_interest') {
      // User has described what they need - now search for materials
      await ctx.reply(`🔍 Perfect! Let me search for materials related to "${userInput}"...`);
      
      const materials = await recommendMaterials(userInput, 10);
      session.materials = materials;
      
      if (materials.length === 0) {
        userSessions.set(userId, { state: 'completed' });
        
        return ctx.replyWithMarkdown(`🤔 I couldn't find exact matches for "${userInput}", but here are some popular categories:

*Popular Nursing Topics:*
• Cardiovascular Nursing
• Pediatric Care & Development  
• Pharmacology & Medication Administration
• Medical-Surgical Nursing
• Obstetrics & Gynecology
• Mental Health Nursing
• Anatomy & Physiology
• Nursing Fundamentals

Try using /buy again with one of these topics, or be more specific about what you need!`);
      }
      
      // Move to display step
      session.step = 'display_results';
      userSessions.set(userId, session);
      
      return displayMaterials(ctx, materials, userInput);
    }
    
  } catch (error) {
    logger.error('Error in buy flow', error);
    userSessions.delete(userId);
    await ctx.reply('Sorry, there was an error processing your request. Please try using /buy again.');
  }
}

/**
 * Display materials to user - handles both single and multiple results
 */
async function displayMaterials(ctx, materials, userInput) {
  const userId = String(ctx.from.id);
  
  if (materials.length === 0) {
    return ctx.reply(`I couldn't find any materials matching "${userInput}". Try being more specific or use a different topic.`);
  }
  
  if (materials.length === 1) {
    // Single perfect match - send directly
    const material = materials[0];
    
    await ctx.replyWithMarkdown(
      `✅ *Perfect match found!*\n\n` +
      `*${material.title}*\n` +
      `📚 *Topic:* ${material.topic}\n` +
      `🎯 *Level:* ${material.level}\n` +
      `📝 *Description:* ${material.description || 'Comprehensive nursing exam material'}\n` +
      `\n📄 *Downloading your file...*`
    );
    
    // Send the PDF file
    await sendMaterialFile(ctx, material);
    
    userSessions.set(userId, { state: 'completed' });
    
  } else {
    // Multiple matches - show list for selection
    let response = `📚 *I found ${materials.length} materials matching your needs:*\n\n`;
    
    materials.forEach((material, index) => {
      const shortDesc = material.description 
        ? (material.description.length > 80 ? material.description.substring(0, 80) + '...' : material.description)
        : 'Comprehensive nursing exam material';
        
      response += `${index + 1}. *${material.title}*\n` +
                 `   📚 ${material.topic} | 🎯 ${material.level}\n` +
                 `   📝 ${shortDesc}\n\n`;
    });
    
    response += '\n💡 *Please reply with the NUMBER of the material you want* (1, 2, 3, etc.)';
    
    // Store materials in user session for selection
    userSessions.set(userId, {
      state: 'awaiting_selection',
      materials: materials,
      query: userInput
    });
    
    await ctx.replyWithMarkdown(response);
  }
}

/**
 * Handle material selection from list
 */
async function handleMaterialSelection(ctx, session, userInput) {
  const userId = String(ctx.from.id);
  const selection = userInput.trim();
  const selectedNumber = parseInt(selection);
  
  if (isNaN(selectedNumber) || selectedNumber < 1 || selectedNumber > session.materials.length) {
    return ctx.replyWithMarkdown(`❌ Please select a valid number between 1 and ${session.materials.length}.\n\n💡 Just reply with the number (1, 2, 3, etc.) of the material you want.`);
  }
  
  const selectedMaterial = session.materials[selectedNumber - 1];
  
  await ctx.replyWithMarkdown(
    `✅ *Excellent choice!*\n\n` +
    `*${selectedMaterial.title}*\n` +
    `📚 *Topic:* ${selectedMaterial.topic}\n` +
    `🎯 *Level:* ${selectedMaterial.level}\n` +
    `📝 *Description:* ${selectedMaterial.description || 'Comprehensive nursing exam material'}\n` +
    `\n📄 *Downloading your file...*`
  );
  
  // Send the PDF file
  await sendMaterialFile(ctx, selectedMaterial);
  
  // Clear the session
  userSessions.set(userId, { state: 'completed' });
}

/**
 * Send material PDF file to user via Telegram
 */
async function sendMaterialFile(ctx, material) {
  try {
    logger.info(`Sending file for material: ${material.title}`, { fileId: material.fileId });
    
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
    const fileName = material.fileName || fileInfo.filename || `${material.title}.pdf`;
    
    await ctx.replyWithDocument({
      source: fileBuffer,
      filename: fileName
    }, {
      caption: `📚 ${material.title}\n📖 Topic: ${material.topic}\n🎯 Level: ${material.level}${material.description ? `\n📝 ${material.description}` : ''}`
    });

    logger.info(`File sent successfully: ${material.title}`, { fileSize: fileBuffer.length });
    
    // Offer follow-up help
    await ctx.replyWithMarkdown(`🎉 *File sent successfully!*\n\nNeed more materials or have questions? Just ask! 💬`);

  } catch (error) {
    logger.error('Error sending material file:', error);
    
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