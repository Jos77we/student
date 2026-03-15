/**
 * AI Service — powered by Ollama (llama3.2:3b) running locally.
 * ALL AI calls go through callOllama(). OpenRouter has been removed.
 */

import fetch from 'node-fetch';
import { logger } from '../utils/logger.js';
import { Material } from '../models/material.model.js';
import { buildStudyPrompt } from './prompt.service.js';

// ─── Ollama config ─────────────────────────────────────────────────────────────
const OLLAMA_BASE  = process.env.OLLAMA_URL  || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';

// NCLEX Categories — matches the material.model enum exactly
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

// ─── Core Ollama wrapper ───────────────────────────────────────────────────────

/**
 * Send a prompt to the local Ollama instance and return the response text.
 * Uses streaming so there's no hard timeout waiting for a full response.
 * @param {string} prompt
 * @param {object} [opts]   - optional overrides { temperature, num_predict }
 * @returns {Promise<string>} raw text from the model
 */
export async function callOllama(prompt, opts = {}) {
  const url = `${OLLAMA_BASE}/api/generate`;

  logger.debug(`[Ollama] Sending prompt to ${OLLAMA_MODEL} (${prompt.length} chars)`);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: true,
        options: {
          temperature: opts.temperature ?? 0.7,
          num_predict: opts.num_predict ?? 2048,
          top_p: opts.top_p ?? 0.9
        }
      })
    });
  } catch (err) {
    // Network / connection error
    const msg = err.code === 'ECONNREFUSED'
      ? `Cannot connect to Ollama at ${OLLAMA_BASE}. Make sure "ollama serve" is running.`
      : `Ollama fetch error: ${err.message}`;
    logger.error(`[Ollama] ${msg}`);
    throw new Error(msg);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama HTTP ${res.status}: ${body}`);
  }

  // Collect streaming tokens
  let fullText  = '';
  let tokenCount = 0;
  const decoder = new TextDecoder();

  await new Promise((resolve, reject) => {
    res.body.on('data', (chunk) => {
      try {
        const lines = decoder.decode(chunk).split('\n').filter(Boolean);
        for (const line of lines) {
          const json = JSON.parse(line);
          if (json.response) {
            fullText += json.response;
            tokenCount++;
          }
          if (json.done) resolve();
        }
      } catch (_) { /* partial chunk — ignore */ }
    });
    res.body.on('error', reject);
    res.body.on('end',   resolve);
  });

  logger.debug(`[Ollama] Received ${tokenCount} tokens`);
  return fullText;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generatePromoCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function extractNCLEXSearchTokens(userQuery, category = null) {
  const query = userQuery.toLowerCase().trim();

  const stopWords = new Set([
    'i','me','my','the','a','an','and','or','but','in','on','at','to','for','of',
    'with','by','as','is','are','was','were','be','been','being','have','has','had',
    'do','does','did','will','would','could','should','may','might','must','can',
    'shall','that','this','these','those','am','looking','want','need','like','about',
    'some','any','help','study','learn','please','material','materials','exam','exams',
    'paper','papers','test','tests','preparing','studying','buy','purchase','nclex','rn','pn'
  ]);

  // Pull out category-specific phrases first
  const categoryPhrases = [];
  if (category) {
    for (const kw of (NCLEX_CATEGORIES[category] || [])) {
      const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      const matches = query.match(re);
      if (matches) categoryPhrases.push(...matches.map(m => m.toLowerCase().trim()));
    }
  }

  const words = query
    .split(/[\s.,!?;:]+/)
    .filter(w => w.length > 2 && !stopWords.has(w))
    .filter(w => !categoryPhrases.some(p => p.includes(w) || w.includes(p)));

  return [...new Set([...categoryPhrases, ...words])];
}

function scoreNCLEXRelevance(materials, searchTokens, category = null) {
  return materials.map(material => {
    let score = 0;
    const matches = {};

    if (category && material.category?.toLowerCase().includes(category.toLowerCase())) {
      score += 8;
    }

    for (const token of searchTokens) {
      if (material.title?.toLowerCase().includes(token))        { score += 5; matches[token] = (matches[token]||0)+1; }
      if (material.category?.toLowerCase().includes(token))     { score += 6; matches[token] = (matches[token]||0)+1; }
      if (Array.isArray(material.topics)) {
        const n = material.topics.filter(t => t.toLowerCase().includes(token)).length;
        if (n > 0) { score += 4*n; matches[token] = (matches[token]||0)+n; }
      }
      if (material.keywords?.some(k => k.toLowerCase().includes(token))) { score += 4; matches[token] = (matches[token]||0)+1; }
      if (material.description?.toLowerCase().includes(token))  { score += 2; matches[token] = (matches[token]||0)+1; }
    }

    const total = Object.values(matches).reduce((s,c) => s+c, 0);
    if (total > 1) score += total * 2;

    return { ...material, relevanceScore: score, matchedTokens: Object.keys(matches) };
  })
  .filter(m => m.relevanceScore > 0)
  .sort((a, b) => b.relevanceScore - a.relevanceScore);
}

async function findNCLEXMaterials(userQuery, category = null, limit = 10) {
  try {
    const searchTokens = extractNCLEXSearchTokens(userQuery, category);
    logger.info('[Materials] Search tokens:', { searchTokens, category });

    let query;
    if (searchTokens.length === 0) {
      query = category ? { category } : {};
    } else {
      const conditions = searchTokens.flatMap(t => [
        { title:       { $regex: t, $options: 'i' } },
        { topics:      { $regex: t, $options: 'i' } },
        { description: { $regex: t, $options: 'i' } },
        { keywords:    { $in: [new RegExp(t, 'i')] } }
      ]);
      query = category
        ? { $and: [{ category }, { $or: conditions }] }
        : { $or: conditions };
    }

    let results = await Material.find(query).limit(limit * 2).lean();

    if (results.length === 0 && category) {
      // Fallback: just return anything in the category
      results = await Material.find({ category }).limit(limit).lean();
    }

    const scored = searchTokens.length > 0
      ? scoreNCLEXRelevance(results, searchTokens, category).slice(0, limit)
      : results.slice(0, limit);

    logger.info(`[Materials] Found ${scored.length} results`);
    return scored;
  } catch (err) {
    logger.error('[Materials] Search error:', err);
    return [];
  }
}

// ─── Purchase flow ─────────────────────────────────────────────────────────────

export async function handleNCLEXPurchase(user, category = null, selectedMaterial = null) {
  try {
    if (!category) {
      return {
        step: 'category_selection',
        message:
          `🎯 *NCLEX Study Materials*\n\nSelect a category:\n\n` +
          `1. *Safe and Effective Care Environment*\n   Patient safety, delegation, ethics\n\n` +
          `2. *Health Promotion and Maintenance*\n   Growth & development, disease prevention\n\n` +
          `3. *Psychosocial Integrity*\n   Mental health, therapeutic communication\n\n` +
          `4. *Physiological Integrity*\n   Med-surg, pharmacology, acute/chronic illness\n\n` +
          `Reply with a category *name or number (1-4)*`,
        categories: Object.keys(NCLEX_CATEGORIES)
      };
    }

    if (category && !selectedMaterial) {
      const materials = await findNCLEXMaterials('', category, 10);

      if (materials.length === 0) {
        return {
          step: 'error',
          message: `📭 No materials found for *${category}*.\n\nTry another category or type "back".`
        };
      }

      let response = `📚 *${category} Materials*\n\n`;
      materials.forEach((m, i) => {
        const desc = m.description
          ? (m.description.length > 60 ? m.description.substring(0, 60) + '...' : m.description)
          : 'Comprehensive NCLEX review material';
        const topics = m.topics?.slice(0, 3).join(', ') || 'General NCLEX topics';
        const price  = m.price === 'Free' ? '💰 Free' : `💰 $${m.price} USD`;
        response += `${i + 1}. *${m.title}*\n   📝 ${desc}\n   🎯 ${topics}\n   ${price}\n\n`;
      });
      response += `Reply with the *number* of the material you want, or type "back".`;

      return { step: 'material_selection', message: response, materials, category };
    }

    if (selectedMaterial) {
      const promoCode = generatePromoCode();
      const topics    = selectedMaterial.topics?.join(', ') || 'General NCLEX topics';
      const priceStr  = selectedMaterial.price === 'Free' ? 'Free' : `$${selectedMaterial.price} USD`;

      return {
        step: 'confirmation',
        message:
          `✅ *Purchase Confirmation*\n\n` +
          `📦 *Material:* ${selectedMaterial.title}\n` +
          `📚 *Category:* ${category}\n` +
          `🎯 *Topics:* ${topics}\n` +
          `💰 *Price:* ${priceStr}\n\n` +
          `🎟️ *Your Promo Code:* \`${promoCode}\`\n\n` +
          `⚠️ Save this code!\n\n` +
          `📥 Type "download" to receive your file.\n` +
          `🔄 Type "back" to choose a different material.`,
        promoCode,
        material:  selectedMaterial,
        category
      };
    }
  } catch (err) {
    logger.error('[Purchase] Error:', err);
    return { step: 'error', message: '🚨 An error occurred. Please try /buy again.' };
  }
}

// ─── General AI response ───────────────────────────────────────────────────────

export async function getNCLEXAIResponse(user, message, context = {}) {
  // Route purchase intents to the structured flow
  if (/\/buy|^buy$|purchase/i.test(message.trim())) {
    return handleNCLEXPurchase(user);
  }

  // Find related materials for context
  const materials = await findNCLEXMaterials(message);

  // Build a concise Ollama prompt using the existing prompt service helper
  const prompt = buildStudyPrompt(user, message, materials.slice(0, 3), 'NCLEX');

  try {
    const text = await callOllama(prompt, { num_predict: 800 });
    return { step: 'ai_response', message: text.trim() };
  } catch (err) {
    logger.error('[AI] Ollama call failed:', err.message);

    // Graceful degradation: return materials info if AI is unavailable
    if (materials.length > 0) {
      let fallback = `📚 *Related NCLEX Materials*\n\n`;
      materials.slice(0, 3).forEach((m, i) => {
        fallback += `${i + 1}. *${m.title}*\n   Category: ${m.category || 'General'}\n   Topics: ${m.topics?.slice(0, 3).join(', ') || 'General'}\n\n`;
      });
      fallback += `💡 Type /buy to purchase, /questions to practise.\n\n`;
      fallback += `⚠️ _AI tutor offline — make sure \`ollama serve\` is running._`;
      return { step: 'fallback', message: fallback };
    }

    return {
      step: 'error',
      message: `🚨 AI tutor is offline.\n\nEnsure Ollama is running:\n• \`ollama serve\`\n• \`ollama pull ${OLLAMA_MODEL}\`\n\nType /help for other options.`
    };
  }
}

// Re-export for backward compatibility
export {
  findNCLEXMaterials,
  extractNCLEXSearchTokens,
  generatePromoCode,
  NCLEX_CATEGORIES
};