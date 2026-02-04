import fetch from 'node-fetch';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { Material } from '../models/material.model.js';
import { buildStudyPrompt, buildPurchasePrompt } from './prompt.service.js';

// NCLEX Categories for structured selection - updated to match your model's enum
const NCLEX_CATEGORIES = {
  'Safe and Effective Care Environment': [
    'patient safety', 'infection control', 'legal responsibilities', 'ethics',
    'delegation', 'prioritization', 'management of care', 'emergency preparedness',
    'HIPAA', 'patient rights', 'confidentiality'
  ],
  'Health Promotion and Maintenance': [
    'growth and development', 'prenatal care', 'postnatal care',
    'health screening', 'immunizations', 'lifestyle modification',
    'health education', 'disease prevention'
  ],
  'Psychosocial Integrity': [
    'mental health', 'depression', 'anxiety', 'schizophrenia',
    'crisis intervention', 'substance abuse', 'therapeutic communication',
    'coping mechanisms', 'stress management', 'abuse', 'neglect', 'grief'
  ],
  'Physiological Integrity': [
    'medical-surgical nursing', 'pharmacology', 'drug actions',
    'side effects', 'IV therapy', 'fluids', 'oxygenation',
    'respiratory care', 'cardiac disorders', 'renal disorders',
    'neurological disorders', 'endocrine disorders',
    'fluid and electrolyte balance', 'acute illness',
    'chronic illness management', 'wound care'
  ]
};

// Generate 6-digit promo code
function generatePromoCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// NCLEX-specific search that uses your actual model structure
async function findNCLEXMaterials(userQuery, category = null, limit = 10) {
  try {
    // If user confirms /buy, show categories first
    if (userQuery.toLowerCase().includes('/buy') && !category) {
      return { type: 'category_selection', categories: [
        'Safe and Effective Care Environment',
        'Health Promotion and Maintenance',
        'Psychosocial Integrity',
        'Physiological Integrity'
      ] };
    }

    // Extract search tokens
    const searchTokens = extractNCLEXSearchTokens(userQuery, category);
    
    logger.info(`NCLEX search tokens:`, { searchTokens, category });

    if (searchTokens.length === 0) {
      return await getNCLEXFallbackMaterials(category, limit);
    }

    // Build search query with category priority
    const searchConditions = searchTokens.flatMap(token => [
      { title: { $regex: token, $options: 'i' } },
      { $or: [
        { topics: { $regex: token, $options: 'i' } },
        { description: { $regex: token, $options: 'i' } },
        { keywords: { $in: [new RegExp(token, 'i')] } }
      ]}
    ]);

    // Add category filter if specified
    const query = category 
      ? { 
          $and: [
            { category: category },
            { $or: searchConditions }
          ]
        }
      : { $or: searchConditions };

    logger.info(`NCLEX search query:`, JSON.stringify(query, null, 2));

    // Execute search
    let results = await Material.find(query)
      .limit(limit * 2)
      .lean();

    // If no results, try partial matching
    if (results.length === 0) {
      logger.info('No direct matches, trying partial matching');
      const partialConditions = searchTokens.flatMap(token => [
        { title: { $regex: `.*${token}.*`, $options: 'i' } },
        { $or: [
          { topics: { $elemMatch: { $regex: `.*${token}.*`, $options: 'i' } } },
          { description: { $regex: `.*${token}.*`, $options: 'i' } }
        ]}
      ]);

      const partialQuery = category 
        ? { 
            $and: [
              { category: category },
              { $or: partialConditions }
            ]
          }
        : { $or: partialConditions };
      
      results = await Material.find(partialQuery)
        .limit(limit * 2)
        .lean();
    }

    // Score results with NCLEX-specific weighting
    const scoredResults = scoreNCLEXRelevance(results, searchTokens, category);
    
    // Return top results
    const finalResults = scoredResults.slice(0, limit);
    
    logger.info(`Found ${finalResults.length} NCLEX materials`);
    return { type: 'materials', data: finalResults };

  } catch (err) {
    logger.error('Error in NCLEX material search:', err);
    return await getNCLEXFallbackMaterials(category, limit);
  }
}

// Extract NCLEX-specific search tokens
function extractNCLEXSearchTokens(userQuery, category = null) {
  const query = userQuery.toLowerCase().trim();
  
  // NCLEX-specific stop words
  const stopWords = [
    'i', 'me', 'my', 'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 
    'to', 'for', 'of', 'with', 'by', 'as', 'is', 'are', 'was', 'were', 'be',
    'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'must', 'can', 'shall', 'that', 'this',
    'these', 'those', 'am', 'looking', 'for', 'with', 'topics', 'in', 'currently',
    'at', 'want', 'need', 'like', 'about', 'some', 'any', 'help', 'study', 'learn',
    'please', 'could', 'would', 'should', 'material', 'materials', 'exam', 'exams',
    'paper', 'papers', 'test', 'tests', 'preparing', 'studying', 'buy', 'purchase',
    'nclex', 'rn', 'pn'
  ];

  // Extract category-specific phrases
  const categoryPhrases = [];
  if (category) {
    const categoryKeywords = NCLEX_CATEGORIES[category] || [];
    categoryKeywords.forEach(keyword => {
      const pattern = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      const matches = query.match(pattern);
      if (matches) {
        categoryPhrases.push(...matches.map(m => m.toLowerCase().trim()));
      }
    });
  }

  // Extract individual meaningful words
  const words = query
    .split(/[\s\.,!?;:]+/)
    .filter(word => word.length > 2)
    .filter(word => !stopWords.includes(word))
    .filter(word => !categoryPhrases.some(phrase => 
      phrase.includes(word) || word.includes(phrase)));

  // Combine all tokens
  const allTokens = [...categoryPhrases, ...words];
  const uniqueTokens = [...new Set(allTokens)];

  logger.info(`Extracted NCLEX tokens:`, { categoryPhrases, words, uniqueTokens });
  
  return uniqueTokens;
}

// Score materials with NCLEX-specific weighting - updated for your model
function scoreNCLEXRelevance(materials, searchTokens, category = null) {
  return materials.map(material => {
    let score = 0;
    const matches = {};

    // Bonus for matching category
    if (category && material.category && 
        material.category.toLowerCase().includes(category.toLowerCase())) {
      score += 8;
    }

    searchTokens.forEach(token => {
      // Title matches
      if (material.title && material.title.toLowerCase().includes(token)) {
        score += 5;
        matches[token] = (matches[token] || 0) + 1;
      }

      // Category matches (high weight)
      if (material.category && material.category.toLowerCase().includes(token)) {
        score += 6;
        matches[token] = (matches[token] || 0) + 1;
      }

      // Topics array matches
      if (material.topics && Array.isArray(material.topics)) {
        const topicMatches = material.topics.filter(topic => 
          topic.toLowerCase().includes(token));
        if (topicMatches.length > 0) {
          score += 4 * topicMatches.length;
          matches[token] = (matches[token] || 0) + topicMatches.length;
        }
      }

      // Keyword matches
      if (material.keywords && material.keywords.some(kw => 
        kw.toLowerCase().includes(token))) {
        score += 4;
        matches[token] = (matches[token] || 0) + 1;
      }

      // Description matches
      if (material.description && material.description.toLowerCase().includes(token)) {
        score += 2;
        matches[token] = (matches[token] || 0) + 1;
      }
    });

    // Bonus for multiple token matches
    const totalMatches = Object.values(matches).reduce((sum, count) => sum + count, 0);
    if (totalMatches > 1) {
      score += totalMatches * 2;
    }

    return {
      ...material,
      relevanceScore: score,
      matchedTokens: Object.keys(matches)
    };
  })
  .filter(item => item.relevanceScore > 0)
  .sort((a, b) => b.relevanceScore - a.relevanceScore);
}

// Get fallback NCLEX materials
async function getNCLEXFallbackMaterials(category = null, limit = 5) {
  const query = category 
    ? { category: category }
    : {};
  
  return await Material.find(query)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

// Handle NCLEX purchase flow - updated for your model
async function handleNCLEXPurchase(user, category = null, selectedMaterial = null) {
  try {
    // Step 1: If no category selected, show categories
    if (!category) {
      return {
        step: 'category_selection',
        message: `🎯 *NCLEX Study Materials*\n\nPlease select which category you're preparing for:\n\n1. **Safe and Effective Care Environment**\n   • Patient safety & infection control\n   • Legal responsibilities & ethics\n   • Delegation & prioritization\n\n2. **Health Promotion and Maintenance**\n   • Growth & development\n   • Health screening & immunizations\n   • Disease prevention\n\n3. **Psychosocial Integrity**\n   • Mental health disorders\n   • Therapeutic communication\n   • Crisis intervention\n\n4. **Physiological Integrity**\n   • Medical-surgical nursing\n   • Pharmacology\n   • Acute & chronic illness\n\nReply with the *CATEGORY NAME* or *NUMBER* (1-4)`,
        categories: Object.keys(NCLEX_CATEGORIES)
      };
    }

    // Step 2: If category selected but no material, show materials
    if (category && !selectedMaterial) {
      const searchResult = await findNCLEXMaterials('', category, 10);
      
      if (searchResult.type === 'materials' && searchResult.data.length > 0) {
        let response = `📚 *NCLEX ${category} Materials*\n\n`;
        
        searchResult.data.forEach((material, index) => {
          const shortDesc = material.description 
            ? (material.description.length > 60 ? material.description.substring(0, 60) + '...' : material.description)
            : 'Comprehensive NCLEX review material';
            
          const topicsList = material.topics && material.topics.length > 0 
            ? material.topics.slice(0, 3).join(', ')
            : 'General NCLEX topics';
            
          response += `${index + 1}. **${material.title}**\n`;
          response += `   📝 ${shortDesc}\n`;
          response += `   🎯 Topics: ${topicsList}\n`;
          response += `   ⭐ Relevance: ${material.relevanceScore || 'High'}/10\n\n`;
        });
        
        response += `💡 Reply with the *NUMBER* (1-${Math.min(searchResult.data.length, 10)}) to select a material.\n`;
        response += `Or type "back" to choose a different category.`;
        
        return {
          step: 'material_selection',
          message: response,
          materials: searchResult.data,
          category: category
        };
      } else {
        return {
          step: 'error',
          message: `📭 No materials found for "${category}".\n\nPlease try another category or contact support.`
        };
      }
    }

    // Step 3: Material selected - generate promo code and confirm
    if (selectedMaterial) {
      const promoCode = generatePromoCode();
      
      // Store purchase info (you would save this to your database)
      const purchaseInfo = {
        userId: user.id,
        materialId: selectedMaterial._id,
        materialTitle: selectedMaterial.title,
        category: category,
        promoCode: promoCode,
        purchaseDate: new Date(),
        status: 'pending'
      };
      
      // Log purchase (replace with actual database save)
      logger.info('Purchase initiated:', purchaseInfo);
      
      // Format topics for display
      const topicsList = selectedMaterial.topics && selectedMaterial.topics.length > 0 
        ? selectedMaterial.topics.join(', ')
        : 'General NCLEX topics';
      
      return {
        step: 'confirmation',
        message: `✅ *Purchase Confirmation*\n\n📦 **Selected Material:** ${selectedMaterial.title}\n📚 **Category:** ${category}\n🎯 **Topics:** ${topicsList}\n\n🎟️ **Your Promo Code:** \`${promoCode}\`\n\n⚠️ *Please save this code! You'll need it to download your materials.*\n\n📥 Ready to download? Type "download" to continue.\n🔄 To choose different material, type "back".`,
        promoCode: promoCode,
        material: selectedMaterial,
        category: category
      };
    }

  } catch (err) {
    logger.error('Error in NCLEX purchase flow:', err);
    return {
      step: 'error',
      message: '🚨 An error occurred. Please try again or contact support.'
    };
  }
}

// Get AI response for NCLEX-focused interactions
async function getNCLEXAIResponse(user, message, context = {}) {
  // Check for purchase intent
  if (/\/buy|buy|purchase|payment/i.test(message)) {
    // Parse category selection from message
    let selectedCategory = null;
    
    // Check for category numbers
    if (/^[1-4]$/.test(message.trim())) {
      const categories = Object.keys(NCLEX_CATEGORIES);
      selectedCategory = categories[parseInt(message.trim()) - 1];
    } 
    // Check for category names
    else {
      Object.keys(NCLEX_CATEGORIES).forEach(category => {
        if (message.toLowerCase().includes(category.toLowerCase().slice(0, 20))) {
          selectedCategory = category;
        }
      });
    }
    
    // Check for material selection (e.g., "1", "2", etc.)
    let selectedMaterial = null;
    if (context.materials && /^[0-9]+$/.test(message.trim())) {
      const index = parseInt(message.trim()) - 1;
      if (index >= 0 && index < context.materials.length) {
        selectedMaterial = context.materials[index];
      }
    }
    
    // Handle purchase flow
    const purchaseResult = await handleNCLEXPurchase(
      user, 
      selectedCategory || context.currentCategory, 
      selectedMaterial || context.selectedMaterial
    );
    
    return purchaseResult;
  }
  
  // For study queries, use smart search
  const searchResult = await findNCLEXMaterials(message);
  
  if (searchResult.type === 'category_selection') {
    // This shouldn't happen in normal flow, but handle it
    return handleNCLEXPurchase(user);
  }
  
  const relatedMaterials = searchResult.data || [];
  const searchTokens = extractNCLEXSearchTokens(message);
  
  // Check if we need clarification
  const clarificationNeeded = needsNCLEXClarification(searchTokens, relatedMaterials, message);
  
  if (clarificationNeeded) {
    return { step: 'clarification', message: clarificationNeeded };
  }
  
  // Use AI for detailed responses
  let finalPrompt;
  
  if (/study|learn|question|quiz|practice/i.test(message)) {
    finalPrompt = buildStudyPrompt(user, message, relatedMaterials, 'NCLEX');
  } else {
    finalPrompt = buildPurchasePrompt(user, message, relatedMaterials, 'NCLEX');
  }
  
  if (!config.OPENROUTER_KEY) {
    // Simulated response for NCLEX
    if (relatedMaterials.length > 0) {
      let response = `🧠 *NCLEX Study Assistant*\n\nI found ${relatedMaterials.length} materials for your query:\n\n`;
      
      relatedMaterials.slice(0, 3).forEach((material, index) => {
        const topicsList = material.topics && material.topics.length > 0 
          ? material.topics.slice(0, 3).join(', ')
          : 'General';
        
        response += `${index + 1}. **${material.title}**\n`;
        response += `   📚 Category: ${material.category || 'General'}\n`;
        response += `   🎯 Topics: ${topicsList}\n`;
        if (material.description) {
          response += `   📝 ${material.description.substring(0, 80)}...\n`;
        }
        response += '\n';
      });
      
      response += `💡 To purchase any material, type \`/buy\`\n`;
      response += `📚 For practice questions, ask about specific topics`;
      
      return { step: 'study_assistance', message: response, materials: relatedMaterials };
    } else {
      return { 
        step: 'no_materials', 
        message: `📭 I couldn't find specific NCLEX materials for that.\n\nTry:\n• Asking about specific NCLEX categories\n• Using \`/buy\` to browse materials\n• Requesting practice questions on a topic` 
      };
    }
  }
  
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://yourapp.com',
        'X-Title': 'NCLEX Study Bot'
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
        messages: [{ role: 'user', content: finalPrompt }],
        max_tokens: 800
      })
    });
    
    const data = await res.json();
    
    if (data?.choices?.[0]?.message?.content) {
      return { step: 'ai_response', message: data.choices[0].message.content.trim() };
    }
    
    return { step: 'error', message: '⚠️ AI service returned unexpected response.' };
  } catch (err) {
    logger.error('AI request failed', err);
    return { step: 'error', message: '🚨 AI service temporarily unavailable.' };
  }
}

// NCLEX-specific clarification needs
function needsNCLEXClarification(searchTokens, results, userQuery) {
  if (results.length === 0) {
    return `🔍 *No NCLEX Materials Found*\n\nI couldn't find materials matching your search.\n\nPlease specify:\n• Which of the 4 main categories?\n• Specific topics within that category\n\nExample: "pharmacology questions for cardiac care"`;
  }
  
  const goodMatches = results.filter(item => item.relevanceScore >= 3);
  if (goodMatches.length === 0) {
    return `🔍 *Need More Specifics*\n\nI found some materials but they're not a perfect match.\n\nCould you tell me:\n• Which test plan category?\n• What's your biggest challenge?`;
  }
  
  if (results.length > 8) {
    const categories = [...new Set(results.slice(0, 5).map(r => r.category || r.topic))].slice(0, 3);
    return `📚 *Multiple Options Available*\n\nI found materials in these areas:\n${categories.map(c => `• ${c}`).join('\n')}\n\nWhich one are you most interested in?`;
  }
  
  return null;
}

// NCLEX practice questions
async function generateNCLEXQuestions(topic, category = null) {
  const cleanTopic = topic.replace(/[^\w\s]/gi, '').trim();
  
  if (!config.OPENROUTER_KEY) {
    const categoryInfo = category ? ` in ${category}` : '';
    return `🧠 *NCLEX Practice Questions${categoryInfo}*\n\nTopic: ${cleanTopic || 'General Nursing'}\n\n1. What is the priority nursing intervention?\n2. Which assessment finding requires immediate action?\n3. How would you evaluate patient understanding?\n4. What are potential complications to monitor?\n5. Which teaching point is most important?\n\n💡 *NCLEX Tip:* Focus on safety, prioritization, and patient-centered care!`;
  }
  
  try {
    const prompt = `Generate 5 challenging NCLEX-style questions about "${cleanTopic}"${
      category ? ` in the category: ${category}` : ''
    }. Make them multiple choice with rationales. Focus on critical thinking, prioritization, and clinical judgment.`;
    
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://yourapp.com',
        'X-Title': 'NCLEX Study Bot'
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 800
      })
    });
    
    const data = await res.json();
    
    if (data?.choices?.[0]?.message?.content) {
      return `🧠 *NCLEX Practice Questions*\n\n${data.choices[0].message.content.trim()}`;
    }
    
    return `🧠 *NCLEX Practice Questions*\n\nFocus on application-level questions and clinical reasoning!`;
  } catch (err) {
    logger.error('AI question generation failed', err);
    return `🧠 *NCLEX Practice Questions*\n\nPractice with scenario-based questions focusing on nursing judgment!`;
  }
}

// Export all functions
export {
  findNCLEXMaterials,
  extractNCLEXSearchTokens,
  getNCLEXAIResponse,
  handleNCLEXPurchase,
  generateNCLEXQuestions,
  generatePromoCode,
  NCLEX_CATEGORIES
};