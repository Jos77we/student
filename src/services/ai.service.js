import fetch from 'node-fetch';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { Material } from '../models/material.model.js';
import { buildStudyPrompt, buildPurchasePrompt } from './prompt.service.js';

/**
 * Smart search that breaks down query and searches word-by-word across all fields
 */
async function findRelevantMaterials(userQuery, limit = 10) {
  try {
    // Extract all meaningful words and phrases from the query
    const searchTokens = extractSearchTokens(userQuery);
    
    logger.info(`Search tokens extracted:`, { searchTokens });

    if (searchTokens.length === 0) {
      return await getFallbackMaterials(limit);
    }

    // Build an elaborate OR query searching each token across all fields
    const searchConditions = searchTokens.flatMap(token => [
      { title: { $regex: token, $options: 'i' } },
      { topic: { $regex: token, $options: 'i' } },
      { description: { $regex: token, $options: 'i' } },
      { level: { $regex: token, $options: 'i' } },
      { keywords: { $in: [new RegExp(token, 'i')] } }
    ]);

    const query = { $or: searchConditions };

    logger.info(`Searching with query:`, JSON.stringify(query, null, 2));

    // Execute search
    let results = await Material.find(query)
      .limit(limit * 2) // Get more initially for scoring
      .lean();

    // If no results, try partial matching
    if (results.length === 0) {
      logger.info('No direct matches, trying partial matching');
      const partialConditions = searchTokens.flatMap(token => [
        { title: { $regex: `.*${token}.*`, $options: 'i' } },
        { topic: { $regex: `.*${token}.*`, $options: 'i' } },
        { description: { $regex: `.*${token}.*`, $options: 'i' } }
      ]);

      const partialQuery = { $or: partialConditions };
      results = await Material.find(partialQuery)
        .limit(limit * 2)
        .lean();
    }

    // Score and rank results based on token matches
    const scoredResults = scoreMaterialRelevance(results, searchTokens);
    
    // Return top results
    const finalResults = scoredResults.slice(0, limit);
    
    logger.info(`Found ${finalResults.length} relevant materials out of ${results.length} total`);
    return finalResults;

  } catch (err) {
    logger.error('Error in smart material search:', err);
    return await getFallbackMaterials(limit);
  }
}

/**
 * Extract all meaningful search tokens from user query
 */
function extractSearchTokens(userQuery) {
  const query = userQuery.toLowerCase().trim();
  
  // Remove common stop words but keep nursing/education relevant words
  const stopWords = [
    'i', 'me', 'my', 'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 
    'to', 'for', 'of', 'with', 'by', 'as', 'is', 'are', 'was', 'were', 'be',
    'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'must', 'can', 'shall', 'that', 'this',
    'these', 'those', 'am', 'looking', 'for', 'with', 'topics', 'in', 'currently',
    'at', 'want', 'need', 'like', 'about', 'some', 'any', 'help', 'study', 'learn',
    'please', 'could', 'would', 'should', 'material', 'materials', 'exam', 'exams',
    'paper', 'papers', 'test', 'tests', 'preparing', 'studying'
  ];

  // First, extract multi-word phrases (exam names, topics)
  const phrases = extractPhrases(query);
  
  // Then extract individual meaningful words
  const words = query
    .split(/[\s\.,!?;:]+/)
    .filter(word => word.length > 2)
    .filter(word => !stopWords.includes(word))
    .filter(word => !phrases.some(phrase => phrase.includes(word))); // Avoid duplicates

  // Combine phrases and words, remove duplicates
  const allTokens = [...phrases, ...words];
  const uniqueTokens = [...new Set(allTokens)];

  logger.info(`Extracted tokens:`, { phrases, words, uniqueTokens });
  
  return uniqueTokens;
}

/**
 * Extract meaningful phrases from query
 */
function extractPhrases(query) {
  const phrases = [];
  
  // Common nursing exam patterns
  const examPatterns = [
    /hesi admission assessment exam/gi,
    /hesi admission exam/gi,
    /hesi assessment/gi,
    /hesi exam/gi,
    /nclex exam/gi,
    /nursing entrance exam/gi,
    /admission assessment/gi,
    /pre-health sciences/gi,
    /pre health sciences/gi
  ];

  // Common topic patterns
  const topicPatterns = [
    /mathematics|math/gi,
    /anatomy physiology/gi,
    /medical surgical/gi,
    /patient care/gi,
    /nursing fundamentals/gi,
    /pharmacology drugs/gi,
    /cardiac care/gi,
    /pediatric nursing/gi
  ];

  // Level patterns
  const levelPatterns = [
    /entry level/gi,
    /entry-level/gi,
    /med surg/gi,
    /medical surgical/gi,
    /fundamentals level/gi,
    /advanced level/gi
  ];

  // Check for exam patterns
  examPatterns.forEach(pattern => {
    const matches = query.match(pattern);
    if (matches) {
      phrases.push(...matches.map(m => m.toLowerCase().trim()));
    }
  });

  // Check for topic patterns
  topicPatterns.forEach(pattern => {
    const matches = query.match(pattern);
    if (matches) {
      phrases.push(...matches.map(m => m.toLowerCase().trim()));
    }
  });

  // Check for level patterns
  levelPatterns.forEach(pattern => {
    const matches = query.match(pattern);
    if (matches) {
      phrases.push(...matches.map(m => m.toLowerCase().trim()));
    }
  });

  return [...new Set(phrases)];
}

/**
 * Score materials based on token matches across all fields
 */
function scoreMaterialRelevance(materials, searchTokens) {
  return materials.map(material => {
    let score = 0;
    const matches = {};

    searchTokens.forEach(token => {
      // Title matches (highest weight)
      if (material.title && material.title.toLowerCase().includes(token)) {
        score += 5;
        matches[token] = (matches[token] || 0) + 1;
      }

      // Topic matches (high weight)
      if (material.topic && material.topic.toLowerCase().includes(token)) {
        score += 4;
        matches[token] = (matches[token] || 0) + 1;
      }

      // Keyword matches (high weight)
      if (material.keywords && material.keywords.some(kw => 
        kw.toLowerCase().includes(token))) {
        score += 4;
        matches[token] = (matches[token] || 0) + 1;
      }

      // Level matches (medium weight)
      if (material.level && material.level.toLowerCase().includes(token)) {
        score += 3;
        matches[token] = (matches[token] || 0) + 1;
      }

      // Description matches (lower weight)
      if (material.description && material.description.toLowerCase().includes(token)) {
        score += 2;
        matches[token] = (matches[token] || 0) + 1;
      }
    });

    // Bonus for multiple token matches in same field
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
  .filter(item => item.relevanceScore > 0) // Only keep items with some matches
  .sort((a, b) => b.relevanceScore - a.relevanceScore);
}

/**
 * Get fallback materials when no good matches
 */
async function getFallbackMaterials(limit = 5) {
  return await Material.find()
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

/**
 * Analyze search quality and determine if we need clarification
 */
function needsMoreClarification(searchTokens, results, userQuery) {
  // If no results at all
  if (results.length === 0) {
    return `I couldn't find any materials matching your search. Could you provide more details about:\n\n• The specific exam name\n• Main topics you need\n• Your current nursing level\n\nFor example: "NCLEX pharmacology questions for med-surg level"`;
  }

  // If results have very low relevance scores
  const goodMatches = results.filter(item => item.relevanceScore >= 3);
  if (goodMatches.length === 0) {
    const matchedTokens = results[0]?.matchedTokens || [];
    
    if (matchedTokens.length > 0) {
      return `I found some materials related to ${matchedTokens.join(', ')}, but I want to make sure I get you exactly what you need. Could you tell me:\n\n• Is there a specific exam type? (HESI, NCLEX, etc.)\n• What's the main topic focus?\n• Any particular nursing specialty?`;
    } else {
      return `I found some general materials, but I'd like to narrow it down for you. Could you specify:\n\n• What type of nursing exam are you preparing for?\n• Which subjects or topics are most challenging?\n• What's your current education level?`;
    }
  }

  // If too many results, help to narrow down
  if (results.length > 8 && goodMatches.length > 5) {
    const commonTopics = [...new Set(results.slice(0, 5).map(r => r.topic))].slice(0, 3);
    return `I found several good options! To help me pick the best one, could you tell me which of these is most important:\n\n• ${commonTopics.join('\n• ')}\n\nOr specify the exact exam name if you know it?`;
  }

  return null; // No clarification needed
}

/**
 * Get AI response with smart search and clarification
 */
async function getAIResponse(user, message, options = {}) {
  // First, perform intelligent search
  const relatedMaterials = await findRelevantMaterials(message);
  const searchTokens = extractSearchTokens(message);
  
  // Check if we need clarification
  const clarificationNeeded = needsMoreClarification(searchTokens, relatedMaterials, message);
  
  // If clarification is needed and this is a purchase intent, ask first
  if (clarificationNeeded && /buy|purchase/i.test(message)) {
    return clarificationNeeded;
  }

  let finalPrompt;

  if (/buy|purchase|payment/i.test(message)) {
    finalPrompt = buildPurchasePrompt(user, message, relatedMaterials);
  } else {
    finalPrompt = buildStudyPrompt(user, message, relatedMaterials);
  }

  if (!config.OPENROUTER_KEY) {
    logger.debug('AI stub active — returning smart search results.');
    
    // Enhanced simulated response based on smart search
    if (/buy|purchase/i.test(message)) {
      if (relatedMaterials.length === 0) {
        return `🔍 I searched our materials but didn't find exact matches. \n\nI have nursing resources for:\n• Various exam types (HESI, NCLEX, etc.)\n• Different specialty areas\n• Multiple education levels\n\nCould you tell me more specifically what you need?`;
      }
      
      const goodMatches = relatedMaterials.filter(item => item.relevanceScore >= 3);
      
      if (goodMatches.length === 1) {
        const material = goodMatches[0];
        return `🎯 Perfect match! I found exactly what you need:\n\n*${material.title}*\n📚 Topic: ${material.topic}\n🎯 Level: ${material.level}\n${material.description ? `📝 ${material.description}\n` : ''}\nThis closely matches your search. Sending you the file now!`;
      } 
      else if (goodMatches.length > 0) {
        let response = `🎯 I found ${goodMatches.length} great matches for you:\n\n`;
        goodMatches.slice(0, 5).forEach((material, index) => {
          const shortDesc = material.description 
            ? (material.description.length > 80 ? material.description.substring(0, 80) + '...' : material.description)
            : 'Comprehensive nursing material';
            
          response += `${index + 1}. *${material.title}*\n   📚 ${material.topic} | 🎯 ${material.level}\n   📝 ${shortDesc}\n\n`;
        });
        response += `💡 Reply with the NUMBER (1-${Math.min(goodMatches.length, 5)}) to get that material.`;
        return response;
      }
      else {
        // Poor matches but some results
        let response = `🔍 I found some materials that might be relevant:\n\n`;
        relatedMaterials.slice(0, 3).forEach((material, index) => {
          response += `${index + 1}. *${material.title}* (${material.topic} - ${material.level})\n`;
        });
        response += `\nIf these don't match what you need, could you tell me:\n• The exact exam name?\n• Specific topics?\n• Your current level?`;
        return response;
      }
    }
    
    return `🧠 NurseAid: I'll help you with "${message}". (AI service not configured)`;
  }

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://yourapp.com',
        'X-Title': 'NurseAid Bot'
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
        messages: [{ role: 'user', content: finalPrompt }],
        max_tokens: options.maxTokens || 800
      })
    });

    const data = await res.json();
    
    if (data?.choices?.[0]?.message?.content) {
      return data.choices[0].message.content.trim();
    }
    
    return '⚠️ Unexpected response from AI service.';
  } catch (err) {
    logger.error('AI request failed', err);
    return '🚨 AI service temporarily unavailable.';
  }
}

/**
 * Smart material recommendation
 */
async function recommendMaterials(topicQuery, limit = 5) {
  const materials = await findRelevantMaterials(topicQuery, limit);
  logger.info(`Smart recommendation: ${materials.length} materials for "${topicQuery}"`);
  return materials;
}

/**
 * Generate simulated questions based on a topic
 */
async function simulateQuestions(topic) {
  const cleanTopic = topic.replace(/[^\w\s]/gi, '').trim();
  
  if (!config.OPENROUTER_KEY) {
    return `🧠 *Practice Questions for ${cleanTopic || 'Nursing'}*\n\n1. What are the key concepts in ${cleanTopic || 'this area'}?\n2. How would you apply ${cleanTopic || 'this knowledge'} in clinical practice?\n3. What nursing considerations are important for ${cleanTopic || 'this topic'}?\n4. How would you assess patient needs related to ${cleanTopic || 'this condition'}?\n5. What interventions would be most effective?\n\n*Study tip:* Focus on understanding the underlying principles!`;
  }

  try {
    const prompt = `Generate 5 challenging nursing exam questions about: "${cleanTopic}".
Make them realistic and focused on application, assessment, and critical thinking.`;

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://yourapp.com',
        'X-Title': 'NurseAid Bot'
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 600
      })
    });

    const data = await res.json();
    
    if (data?.choices?.[0]?.message?.content) {
      return `🧠 *Practice Questions for ${cleanTopic || 'Nursing'}*\n\n${data.choices[0].message.content.trim()}`;
    }
    
    return `🧠 *Practice Questions for ${cleanTopic || 'Nursing'}*\n\n1. Key concepts in ${cleanTopic || 'this area'}\n2. Clinical applications\n3. Nursing assessments\n4. Appropriate interventions\n5. Evaluation methods`;
  } catch (err) {
    logger.error('AI question simulation failed', err);
    return `🧠 *Practice Questions for ${cleanTopic || 'Nursing'}*\n\nFocus on understanding core concepts and their clinical applications!`;
  }
}

// Export all necessary functions
export {
  findRelevantMaterials,
  extractSearchTokens,
  getAIResponse,
  recommendMaterials,
  simulateQuestions
};