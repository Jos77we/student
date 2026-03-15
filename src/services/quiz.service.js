/**
 * NCLEX Quiz Service — Live Q&A mode
 * ────────────────────────────────────
 * Generates ONE question at a time on demand.
 * The bot calls generateSingleQuestion(topic, qNum, contextSnip)
 * each time the user answers the previous question.
 *
 * No PDF, no batch wait, no long startup delay.
 */

import fetch    from 'node-fetch';
import { Material } from '../models/material.model.js';
import { logger }   from '../utils/logger.js';

const OLLAMA_BASE  = process.env.OLLAMA_URL   || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';
const OLLAMA_URL   = `${OLLAMA_BASE}/api/generate`;
const PER_Q_TIMEOUT = 90_000; // 90s per question

// ─── Known topic catalogue ─────────────────────────────────────────────────────
export const KNOWN_TOPICS = [
  'Patient safety and infection control',
  'Legal responsibilities and ethics',
  'Delegation and prioritization',
  'Management of care',
  'Disaster and emergency preparedness',
  'Patient rights and confidentiality',
  'Growth and development',
  'Prenatal antenatal and postnatal care',
  'Health screening and immunizations',
  'Lifestyle modification and health education',
  'Disease prevention',
  'Mental health disorders',
  'Crisis intervention',
  'Substance abuse',
  'Therapeutic communication',
  'Coping mechanisms',
  'Stress management',
  'Abuse and neglect',
  'Grief',
  'Medical-surgical nursing',
  'Pharmacology',
  'IV therapy and fluids',
  'Oxygenation and respiratory care',
  'Cardiac disorders',
  'Renal disorders',
  'Neurological disorders',
  'Endocrine disorders',
  'Fluid and electrolyte balance',
  'Acute and chronic illness management',
  'Wound care',
  'Basic care and comfort',
  'Pharmacological and parenteral therapies',
  'Reduction of risk potential',
  'Physiological adaptation',
];

const CATEGORY_MAP = {
  '1': 'Safe and Effective Care Environment',
  '2': 'Health Promotion and Maintenance',
  '3': 'Psychosocial Integrity',
  '4': 'Physiological Integrity',
};

// ─── Console helpers ───────────────────────────────────────────────────────────
const SPIN = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
let _si = 0;
const cok   = m => console.log(`  ✅  ${m}`);
const cwarn = m => console.log(`  ⚠️   ${m}`);
const cfail = m => console.log(`  ❌  ${m}`);
const cspin = m => process.stdout.write(`\r  ${SPIN[_si++%SPIN.length]}  ${m.padEnd(70)}`);
const cend  = () => process.stdout.write('\n');

// ─── Ollama health check ───────────────────────────────────────────────────────
export async function checkOllama() {
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/tags`, { method: 'GET' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    cok(`Ollama reachable at ${OLLAMA_BASE}`);
  } catch (err) {
    throw new Error(
      `Ollama not reachable at ${OLLAMA_BASE}.\n` +
      `Run: ollama serve\nPull model: ollama pull ${OLLAMA_MODEL}\n(${err.message})`
    );
  }
}

// ─── Core streaming call ───────────────────────────────────────────────────────
async function ollamaStream(prompt, opts = {}, timeoutMs = PER_Q_TIMEOUT) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(OLLAMA_URL, {
      method:  'POST',
      signal:  ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:  OLLAMA_MODEL,
        prompt,
        stream: true,
        options: {
          temperature: opts.temperature ?? 0.55,
          num_predict: opts.num_predict ?? 450,
          top_p:       opts.top_p       ?? 0.9,
        },
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError')   throw new Error(`Ollama timed out after ${timeoutMs/1000}s`);
    if (err.code === 'ECONNREFUSED') throw new Error(`Cannot connect to Ollama. Run: ollama serve`);
    throw new Error(`Ollama error: ${err.message}`);
  }

  if (!res.ok) {
    clearTimeout(timer);
    throw new Error(`Ollama HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  }

  let text = '', tokens = 0;
  const dec = new TextDecoder();

  await new Promise((resolve, reject) => {
    res.body.on('data', chunk => {
      try {
        for (const line of dec.decode(chunk).split('\n').filter(Boolean)) {
          const j = JSON.parse(line);
          if (j.response) { text += j.response; tokens++; }
          if (j.done)     { clearTimeout(timer); resolve(); }
        }
      } catch (_) {}
    });
    res.body.on('error', e => { clearTimeout(timer); reject(e); });
    res.body.on('end',   () => { clearTimeout(timer); resolve(); });
  });

  return { text, tokens };
}

// ─── Topic extraction ──────────────────────────────────────────────────────────
export async function extractTopicSmart(raw) {
  const lower = raw.trim().toLowerCase();

  // 1. Known topic match (longest first)
  const hit = KNOWN_TOPICS
    .filter(t => lower.includes(t.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
  if (hit) { logger.info(`[Topic] known: "${hit}"`); return hit; }

  // 2. Category number
  const num = raw.trim().match(/^([1-4])$/);
  if (num) return CATEGORY_MAP[num[1]];

  // 3. Ollama one-liner (15s, 15 tokens)
  try {
    const p =
      `Extract ONLY the nursing topic from this message. Plain text only, nothing else.\n` +
      `Known topics: ${KNOWN_TOPICS.slice(0, 12).join(', ')}, etc.\n` +
      `Message: "${raw.trim()}"\nTopic:`;
    const { text } = await ollamaStream(p, { temperature: 0.1, num_predict: 15 }, 15_000);
    const clean = text.trim().split('\n')[0].replace(/^["']|["']$/g, '').trim();
    if (clean.length > 2 && clean.length < 80) { logger.info(`[Topic] ollama: "${clean}"`); return clean; }
  } catch (e) { logger.warn('[Topic] ollama failed:', e.message); }

  // 4. Regex strip
  const stripped = raw.trim()
    .replace(/^(i want(?: to(?: have)?)?|i need|give me|generate|create|show me|quiz me on|questions on|questions about|on the topic of?|about|for|regarding|can (?:you |i )?(?:get|give me|have)|please(?: give me)?|i'?d like(?: to(?: have)?)?)\s+/gi, '')
    .replace(/\s+(questions?|quiz|topic|material|content|nclex|practice|exam|test|please)\s*$/gi, '')
    .trim();
  logger.info(`[Topic] regex: "${stripped}"`);
  return stripped || raw.trim();
}

/**
 * Extract MULTIPLE topics from a user message.
 * Handles inputs like:
 *   "quiz me on pharmacology and cardiac disorders"
 *   "growth and development, mental health, wound care"
 *   "1, 3" (category numbers)
 *
 * Returns an array of clean topic strings.
 * Falls back to [single topic] if only one is found.
 */
export async function extractTopicsSmart(raw) {
  const lower = raw.trim().toLowerCase();

  // ── Helper: find all known topics that appear in a string ─────────────────
  // Uses both full match AND first-two-word prefix match so that
  // "mental health" matches "Mental health disorders".
  function findKnownTopicsIn(text) {
    const t = text.toLowerCase();
    return KNOWN_TOPICS.filter(kt => {
      const kl = kt.toLowerCase();
      if (t.includes(kl)) return true;
      // Match on the first two significant words of the known topic
      const words = kl.split(/\s+/).filter(w => w.length > 3);
      if (words.length >= 2 && t.includes(words[0]) && t.includes(words[1])) return true;
      return false;
    }).sort((a, b) => b.length - a.length);
  }

  // ── Step 1: scan for known topics in the full message ───────────────────────
  const fullMatch = findKnownTopicsIn(lower);

  if (fullMatch.length >= 2) {
    const unique = [...new Set(fullMatch)];
    logger.info(`[Topics] found ${unique.length} known topics: ${unique.join(' | ')}`);
    return unique;
  }

  if (fullMatch.length === 1) {
    const remaining = lower.replace(fullMatch[0].toLowerCase(), '').trim()
      .replace(/^(and|,|&|\+|plus|with|quiz|questions?|on|about|for)\s*/gi, '')
      .replace(/\s*(and|,|&|\+|plus|with|quiz|questions?|on|about|for)$/gi, '')
      .trim();
    if (remaining.length > 3) {
      const secondMatches = findKnownTopicsIn(remaining);
      const second = secondMatches.find(t => t !== fullMatch[0]);
      if (second) {
        logger.info(`[Topics] known match + remainder: ${fullMatch[0]} | ${second}`);
        return [fullMatch[0], second];
      }
    }
    logger.info(`[Topic] single known match: "${fullMatch[0]}"`);
    return [fullMatch[0]];
  }

  // ── Step 2: comma/slash split (unambiguous separators) ──────────────────────
  const commaParts = raw.split(/[,\/]/).map(p => p.trim()).filter(p => p.length > 2);
  if (commaParts.length >= 2) {
    const topics = await Promise.all(commaParts.map(p => extractTopicSmart(p)));
    const unique = [...new Set(topics.filter(t => t && t.length > 1))];
    if (unique.length >= 2) {
      logger.info(`[Topics] comma/slash split → ${unique.join(' | ')}`);
      return unique;
    }
  }

  // ── Step 3: "and" split — validate each part resolves to a distinct topic ──
  const andParts = raw.split(/\s+and\s+/i).map(p => p.trim()).filter(p => p.length > 2);
  if (andParts.length >= 2) {
    const resolved   = await Promise.all(andParts.map(p => extractTopicSmart(p)));
    const fullSingle = await extractTopicSmart(raw);
    const unique     = [...new Set(resolved.filter(t => t && t.length > 1))];
    const allSame    = unique.every(t => t.toLowerCase() === fullSingle.toLowerCase());
    if (unique.length >= 2 && !allSame) {
      logger.info(`[Topics] "and" split validated → ${unique.join(' | ')}`);
      return unique;
    }
    return [fullSingle];
  }

  // ── Step 4: fallback — single topic ─────────────────────────────────────────
  const single = await extractTopicSmart(raw);
  logger.info(`[Topics] single: "${single}"`);
  return [single];
}

/**
 * Build a schedule of which topic to use for each of the 15 question slots.
 * Topics are distributed as evenly as possible.
 *
 * Examples:
 *   1 topic  → [topic] repeated 15 times
 *   2 topics → [t1,t2,t1,t2,...] — 8 and 7
 *   3 topics → [t1,t2,t3,t1,t2,t3,...] — 5, 5, 5
 *   5 topics → [t1,t2,t3,t4,t5,t1,t2,t3,t4,t5,t1,t2,t3,t4,t5] — 3 each
 *
 * @param {string[]} topics  — array of topic strings
 * @param {number}   total   — 15
 * @returns {string[]}       — array of length `total`
 */
export function buildTopicSchedule(topics, total = 15) {
  if (!topics || topics.length === 0) return Array(total).fill('NCLEX');
  if (topics.length === 1) return Array(total).fill(topics[0]);

  // Cap at total number of topics (no point having more topics than questions)
  const ts = topics.slice(0, total);
  const schedule = [];
  for (let i = 0; i < total; i++) {
    schedule.push(ts[i % ts.length]);
  }
  return schedule;
}

// ─── Fetch DB context (called once, snippet reused for all 15 questions) ────────
export async function fetchTopicContext(topic) {
  try {
    const safe  = topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const full  = new RegExp(safe.replace(/\s+/g, '.*'), 'i');
    const words = topic.split(/\s+/).filter(w => w.length > 3);
    const wordQ = words.flatMap(w => [
      { title:       { $regex: w, $options: 'i' } },
      { topics:      { $regex: w, $options: 'i' } },
      { description: { $regex: w, $options: 'i' } },
      { keywords:    { $regex: w, $options: 'i' } },
    ]);

    const docs = await Material.find({
      $or: [{ title:full },{ topics:full },{ description:full },{ keywords:full }, ...wordQ]
    }).limit(3).lean();

    if (!docs.length) {
      logger.info(`[Context] no docs for "${topic}"`);
      return { found: false, context: '', titles: [] };
    }

    const titles  = docs.map(d => d.title);
    logger.info(`[Context] ${titles.join(' | ')}`);
    const context = docs.map((d, i) => {
      const tl = Array.isArray(d.topics) ? d.topics.join(', ') : (d.topics || '');
      return `[Doc${i+1}] ${d.title}\nTopics: ${tl}\n${d.description?.substring(0,200)||''}`;
    }).join('\n\n').substring(0, 500);

    return { found: true, context, titles };
  } catch (e) {
    logger.error('[Context] DB error:', e);
    return { found: false, context: '', titles: [] };
  }
}

// ─── Parse tagged format ───────────────────────────────────────────────────────
function parseQuestion(raw, qNum) {
  const line = tag => {
    const re = new RegExp(`##${tag}[\\t ]*(.+?)(?=\\n##|\\n\\n##|$)`, 'is');
    const m  = raw.match(re);
    return m ? m[1].trim().replace(/\s+/g, ' ') : null;
  };

  const question    = line(`Q${qNum}`) || line(`Q\\d+`);
  const optA        = line('A');
  const optB        = line('B');
  const optC        = line('C');
  const optD        = line('D');
  const ansRaw      = line('ANS');
  const explanation = line('EXP');

  if (!question || !optA || !optB || !ansRaw) return null;
  const correct = ansRaw.trim()[0].toUpperCase();
  if (!['A','B','C','D'].includes(correct)) return null;

  return {
    number:      qNum,
    question,
    options:     { A: optA||'Option A', B: optB||'Option B', C: optC||'Option C', D: optD||'Option D' },
    correct,
    explanation: explanation || `The correct answer is ${correct}.`,
  };
}

function makePlaceholder(topic, qNum) {
  return {
    number:      qNum,
    question:    `Regarding ${topic}: which nursing action reflects best clinical judgment?`,
    options:     { A:'Assess the patient first', B:'Notify the physician', C:'Administer medication', D:'Document the finding' },
    correct:     'A',
    explanation: 'Assessment is always the first step of the nursing process (ADPIE).',
  };
}

// ─── MAIN EXPORT: generate one question on demand ─────────────────────────────
/**
 * Generate and return a single NCLEX question.
 * The bot calls this each time it needs to send the next question.
 *
 * @param {string} topic       - Clean topic (from extractTopicSmart)
 * @param {number} qNum        - 1–15
 * @param {string} contextSnip - DB context string (or '' if none found)
 * @returns {Promise<{number, question, options:{A,B,C,D}, correct, explanation}>}
 */
export async function generateSingleQuestion(topic, qNum, contextSnip = '') {
  const prompt =
`You are an NCLEX exam writer. Write ONE nursing exam question about "${topic}".
Use EXACTLY this format with ## markers. Nothing outside the markers.
${contextSnip ? `\nContext (reference only):\n${contextSnip}\n` : ''}
##Q${qNum}
<one clinical scenario question — one sentence>
##A <option text>
##B <option text>
##C <option text>
##D <option text>
##ANS <single letter A B C or D>
##EXP <why correct answer is right and why the others are wrong>
##END`;

  console.log(`\n  📝 Generating Q${qNum}/15 for "${topic}"...`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      cspin(`Q${qNum}/15 — attempt ${attempt}`);
      const { text, tokens } = await ollamaStream(prompt);
      cend();

      const q = parseQuestion(text, qNum);
      if (q) {
        cok(`Q${qNum} ready (${tokens} tokens, correct=${q.correct})`);
        return q;
      }
      cfail(`Q${qNum} parse failed attempt ${attempt}`);
      logger.warn(`[Quiz] Q${qNum} parse failed. Raw: ${text.slice(0,100)}`);
    } catch (e) {
      cend();
      cfail(`Q${qNum} attempt ${attempt}: ${e.message}`);
      logger.warn(`[Quiz] Q${qNum} attempt ${attempt}:`, e.message);
      if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * attempt));
      else {
        // On final attempt, if it's an Ollama connectivity error, propagate it
        if (e.message.includes('Ollama') || e.message.includes('ECONNREFUSED')) throw e;
      }
    }
  }

  cwarn(`Q${qNum} using placeholder`);
  return makePlaceholder(topic, qNum);
}