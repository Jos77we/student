import { Telegraf } from 'telegraf';
import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { getNCLEXAIResponse, handleNCLEXPurchase } from '../services/ai.service.js';
import {
  extractTopicsSmart,
  fetchTopicContext,
  generateSingleQuestion,
  buildTopicSchedule,
  checkOllama,
} from '../services/quiz.service.js';
import { User }     from '../models/user.model.js';
import { Material } from '../models/material.model.js';
import { logger, audit } from '../utils/logger.js';
import { getGFSBucket } from '../config/database.js';

if (!config.TELEGRAM_TOKEN) {
  logger.warn('TELEGRAM_TOKEN not set; bot will initialize but cannot be launched until it is provided.');
}

export const bot = new Telegraf(config.TELEGRAM_TOKEN || '');

function escapeMd(text) {
  if (!text) return '';
  return String(text).replace(/[_*`[]/g, '\\$&');
}

// ─── Shared session store ──────────────────────────────────────────────────────
const userSessions = new Map();

// ─── Middleware: upsert user ───────────────────────────────────────────────────
bot.use(async (ctx, next) => {
  try {
    if (!ctx.from?.id) return next();
    const tgId = String(ctx.from.id);
    let user = await User.findOne({ telegramId: tgId });
    if (!user) {
      user = new User({
        telegramId: tgId,
        name: ctx.from.username || `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim(),
        examType: 'NCLEX-RN',
        studyLevel: 'Candidate',
      });
      await user.save();
      logger.info('New user created', { telegramId: tgId });
      audit(tgId, 'user_joined', { name: user.name, username: ctx.from.username });
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

// ─── /start ────────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  audit(String(ctx.from.id), 'command_received', { command: '/start', name: ctx.from?.first_name });
  await ctx.replyWithMarkdown(
    `🎓 *Welcome to NCLEX Prep Bot!*\n\n` +
    `I help you prepare for NCLEX-RN and NCLEX-PN exams.\n\n` +
    `*Commands:*\n` +
    `• /questions — live practice quiz (answer Q by Q)\n` +
    `• /buy — browse & download study materials\n` +
    `• /help — more info\n\n` +
    `Or just ask me anything about nursing! 💉`
  );
});

// ─── /help ─────────────────────────────────────────────────────────────────────
bot.help((ctx) => ctx.replyWithMarkdown(
  `*NCLEX Prep Bot Help*\n\n` +
  `• */questions* or */quiz* — start a 15-question live quiz on any topic\n` +
  `• */buy* — browse study materials by NCLEX category\n\n` +
  `*How the quiz works:*\n` +
  `1. Tell me a topic or category\n` +
  `2. I generate one question at a time\n` +
  `3. Tap A / B / C / D to answer\n` +
  `4. See the correct answer + explanation instantly\n` +
  `5. Repeat for all 15 questions\n\n` +
  `*NCLEX Categories:*\n` +
  `1. Safe and Effective Care Environment\n` +
  `2. Health Promotion and Maintenance\n` +
  `3. Psychosocial Integrity\n` +
  `4. Physiological Integrity`
));

// ─── /buy ──────────────────────────────────────────────────────────────────────
bot.command('buy', async (ctx) => {
  const userId = String(ctx.from.id);
  audit(userId, 'command_received', { command: '/buy' });
  audit(userId, 'purchase_started', { step: 'category_selection' });
  userSessions.set(userId, {
    state: 'nclex_purchase',
    step: 'category_selection',
    currentCategory: null,
    selectedMaterial: null,
    materials: [],
    promoCode: null,
  });
  await ctx.replyWithMarkdown(
    `🎯 *NCLEX Study Materials*\n\nSelect a category:\n\n` +
    `1. *Safe and Effective Care Environment*\n   Patient safety, delegation, ethics\n\n` +
    `2. *Health Promotion and Maintenance*\n   Growth & development, disease prevention\n\n` +
    `3. *Psychosocial Integrity*\n   Mental health, therapeutic communication\n\n` +
    `4. *Physiological Integrity*\n   Med-surg, pharmacology, acute/chronic illness\n\n` +
    `Reply with a category *name or number (1-4)*`
  );
});

// ─── /questions and /quiz ──────────────────────────────────────────────────────
bot.command('questions', (ctx) => startQuizFlow(ctx));
bot.command('quiz',      (ctx) => startQuizFlow(ctx));

function startQuizFlow(ctx) {
  const userId = String(ctx.from.id);
  audit(userId, 'command_received', { command: '/questions' });
  userSessions.set(userId, { state: 'quiz_topic_selection' });
  return ctx.replyWithMarkdown(
    `🎯 *NCLEX Practice Quiz*\n\n` +
    `What topic(s) would you like to be quizzed on?\n\n` +
    `*Single topic:*\n` +
    `• Growth and development\n` +
    `• Pharmacology\n` +
    `• Mental health disorders\n\n` +
    `*Multiple topics* _(15 questions spread evenly)_:\n` +
    `• Pharmacology and cardiac disorders\n` +
    `• Growth and development, infection control\n` +
    `• Mental health, grief, and substance abuse\n\n` +
    `Or reply with a category number:\n` +
    `1. Safe and Effective Care Environment\n` +
    `2. Health Promotion and Maintenance\n` +
    `3. Psychosocial Integrity\n` +
    `4. Physiological Integrity`
  );
}

// ─── Inline button handler (quiz answers) ─────────────────────────────────────
bot.on('callback_query', async (ctx) => {
  const data   = ctx.callbackQuery?.data || '';
  const userId = String(ctx.from.id);

  // ── Payment method selection buttons ─────────────────────────────────────
  // ── pay_confirm button ────────────────────────────────────────────────────
  if (data === 'pay_confirm') {
    const session = userSessions.get(userId);
    if (!session || session.state !== 'nclex_purchase') {
      return ctx.answerCbQuery('Session expired — use /buy to start again.', { show_alert: true });
    }
    await ctx.answerCbQuery();
    return processPaymentAndDeliver(ctx, session, userId);
  }

  // ── pay_method:back button ────────────────────────────────────────────────
  if (data.startsWith('pay_method:')) {
    const choice  = data.split(':')[1];
    const session = userSessions.get(userId);

    if (!session || session.state !== 'nclex_purchase') {
      return ctx.answerCbQuery('Session expired — use /buy to start again.', { show_alert: true });
    }

    await ctx.answerCbQuery();

    if (choice === 'back') {
      session.step = 'material_selection';
      userSessions.set(userId, session);
      return displayNCLEXMaterials(ctx, session.materials, session.currentCategory);
    }

    return; // other choices handled by frontend
  }

  if (!data.startsWith('quiz_answer:')) return ctx.answerCbQuery();

  const [, qIndexStr, chosen] = data.split(':');
  const qIndex  = parseInt(qIndexStr, 10);
  const session = userSessions.get(userId);

  if (!session || !['quiz_active', 'quiz_interject'].includes(session.state)) {
    return ctx.answerCbQuery('Session expired — use /quiz to start again.', { show_alert: true });
  }

  const question = session.questions[qIndex];
  if (!question) return ctx.answerCbQuery('Question not found.', { show_alert: true });

  if (session.answered[qIndex] !== undefined) {
    return ctx.answerCbQuery('Already answered!', { show_alert: true });
  }

  // Record answer
  const isCorrect = chosen === question.correct;
  session.answered[qIndex] = chosen;
  if (isCorrect) session.score += 1;
  userSessions.set(userId, session);

  audit(userId, isCorrect ? 'quiz_answer_correct' : 'quiz_answer_wrong', {
    qNum:    qIndex + 1,
    chosen,
    correct: question.correct,
    topic:   session.schedule?.[qIndex] || session.topics?.[0] || 'NCLEX',
  });

  await ctx.answerCbQuery(isCorrect ? '✅ Correct!' : `❌ Wrong — answer is ${question.correct}`);

  // Edit the question message to reveal result + explanation
  const optLines = Object.entries(question.options).map(([letter, text]) => {
    let marker = '';
    if (letter === question.correct)       marker = ' ✅';
    else if (letter === chosen && !isCorrect) marker = ' ❌';
    return `*${letter}.* ${escapeMd(text)}${marker}`;
  }).join('\n');

  const revealed =
    `*Q${qIndex + 1}/15 — ${escapeMd(question.question)}*\n\n` +
    `${optLines}\n\n` +
    `${isCorrect ? '✅ *Correct!*' : `❌ *Wrong. Correct answer: ${question.correct}*`}\n\n` +
    `📖 *Explanation:*\n${escapeMd(question.explanation)}`;

  try {
    await ctx.editMessageText(revealed, { parse_mode: 'Markdown' });
  } catch (_) {
    await ctx.replyWithMarkdown(revealed);
  }

  // Move to next question after a short pause
  const nextIndex = qIndex + 1;
  if (nextIndex < 15) {
    setTimeout(() => generateAndSendNext(ctx, userId, nextIndex), 1200);
  } else {
    setTimeout(() => sendFinalScore(ctx, userId), 1200);
  }
});

// ─── Text message handler ──────────────────────────────────────────────────────
bot.on('text', async (ctx) => {
  const text   = ctx.message.text.trim();
  const userId = String(ctx.from.id);
  const session = userSessions.get(userId);

  logger.debug('Incoming message', { from: userId, text, state: session?.state });
  audit(userId, 'message_received', { text: text.slice(0, 120), state: session?.state || 'none' });

  // Quiz topic input
  if (session?.state === 'quiz_topic_selection') {
    return handleQuizTopicInput(ctx, text);
  }

  // ── Mid-quiz interject: user typed something while quiz is active ──────────
  // The inline buttons handle actual A/B/C/D answers, so any TEXT message
  // during the quiz is treated as a side question — answer it, then resume.
  if (session?.state === 'quiz_active') {
    return handleQuizInterject(ctx, session, text);
  }

  // While next question is generating, queue the text as a pending interject
  // so it isn't lost — we'll answer it right after the question is sent.
  if (session?.state === 'quiz_next_loading') {
    session.pendingInterject = text;
    userSessions.set(userId, session);
    return ctx.reply('📝 Got your question — I\'ll answer it right after the next question appears.');
  }

  // While first question is loading, just reassure
  if (session?.state === 'quiz_loading') {
    return ctx.reply('⏳ Still setting up your quiz, one moment...');
  }

  // Purchase flow
  if (session?.state === 'nclex_purchase') {
    return handleNCLEXPurchaseFlow(ctx, session, text);
  }
  if (session?.state === 'awaiting_material_selection') {
    return handleMaterialSelection(ctx, session, text);
  }
  // (awaiting_download state no longer used — payment flow handles delivery)

  // Clear completed sessions
  if (session?.state === 'completed') userSessions.delete(userId);

  // Resume
  if (text.toLowerCase() === 'resume') {
    return session ? continueFromSession(ctx, session) : ctx.reply('Welcome back! How can I help?');
  }

  // Buy keyword
  if (/^\/buy$|^buy$/i.test(text.trim()) || (text.toLowerCase().includes('buy') && text.length > 10)) {
    userSessions.set(userId, {
      state: 'nclex_purchase', step: 'category_selection',
      currentCategory: null, selectedMaterial: null, materials: [], promoCode: null,
    });
    await ctx.replyWithMarkdown(
      `🎯 *NCLEX Materials Purchase*\n\nSelect a category:\n\n` +
      `1. Safe and Effective Care Environment\n` +
      `2. Health Promotion and Maintenance\n` +
      `3. Psychosocial Integrity\n` +
      `4. Physiological Integrity\n\n` +
      `Reply with category name or number`
    );
    return;
  }

  // Quiz keyword
  if (/practice|questions|quiz/i.test(text)) {
    return startQuizFlow(ctx);
  }

  // Default: AI response
  try {
    const aiResponse = await getNCLEXAIResponse(ctx.dbUser, text, session || {});
    const msg = typeof aiResponse === 'string' ? aiResponse : aiResponse?.message;
    if (msg) await ctx.replyWithMarkdown(msg);
  } catch (err) {
    logger.error('AI response error', err);
    audit(userId, 'session_error', { stage: 'ai_response', err: err.message, text: text.slice(0, 100) });
    await ctx.reply('⚠️ Sorry, something went wrong. Try again or type /help.');
  }
});

// ─── QUIZ: handle topic input ──────────────────────────────────────────────────
async function handleQuizTopicInput(ctx, userInput) {
  const userId = String(ctx.from.id);

  // Extract one or more topics from the user's message
  let topics;
  try { topics = await extractTopicsSmart(userInput); }
  catch (_) { topics = [userInput.trim()]; }

  // Remove empty/duplicate entries
  topics = [...new Set(topics.filter(t => t && t.length > 1))];
  if (topics.length === 0) topics = [userInput.trim()];

  // Build a 15-slot schedule: each slot says which topic to use
  const schedule = buildTopicSchedule(topics, 15);

  // Lock session
  userSessions.set(userId, { state: 'quiz_loading' });

  // Friendly start message — list topics if multiple
  const topicDisplay = topics.length === 1
    ? `*${escapeMd(topics[0])}*`
    : topics.map((t, i) => `${i+1}. ${escapeMd(t)}`).join('\n');

  await ctx.replyWithMarkdown(
    topics.length === 1
      ? `📝 *Quiz: ${escapeMd(topics[0])}*\n\nGenerating your first question...`
      : `📝 *Mixed Quiz — ${topics.length} topics:*\n\n${topicDisplay}\n\n_15 questions spread evenly across all topics. Generating Q1..._`
  );

  try {
    await checkOllama();

    // Fetch context for each unique topic, merge snippets
    const contextMap = {};
    for (const t of topics) {
      if (!contextMap[t]) {
        const { context, titles } = await fetchTopicContext(t);
        contextMap[t] = { context, titles };
        if (titles.length) logger.info(`[Quiz] Context for "${t}": ${titles.join(', ')}`);
      }
    }

    // Generate Q1 using the first slot's topic
    const firstTopic = schedule[0];
    const q1 = await generateSingleQuestion(firstTopic, 1, contextMap[firstTopic]?.context || '');

    userSessions.set(userId, {
      state:      'quiz_active',
      topics,           // full array of topics
      schedule,         // 15-element array, one topic per question slot
      contextMap,       // topic → { context, titles }
      questions:  [q1],
      answered:   {},
      score:      0,
    });

    audit(userId, 'quiz_started', {
      topics,
      schedule: schedule.slice(0, 3).concat(schedule.length > 3 ? ['...'] : []),
      contextTitles: Object.values(contextMap).flatMap(c => c.titles),
    });
    await sendQuestionMessage(ctx, q1, 0);
    audit(userId, 'quiz_question_sent', { qNum: 1, topic: schedule[0] });

  } catch (err) {
    audit(userId, 'quiz_error', { stage: 'start', err: err.message });
    logger.error('[Quiz] Start error:', err);
    userSessions.delete(userId);
    await ctx.replyWithMarkdown(quizErrorMessage(err));
  }
}

// ─── QUIZ: answer a side-question typed mid-quiz ──────────────────────────────
/**
 * Called when a user types text while quiz_active.
 * We answer their question using Ollama (NCLEX scope), then remind them
 * the quiz is waiting. The current unanswered question stays in the chat —
 * they can tap A/B/C/D whenever they're ready.
 */
async function handleQuizInterject(ctx, session, userText) {
  const userId = String(ctx.from.id);

  // Signal we're answering so a second rapid message doesn't double-trigger
  session.state = 'quiz_interject';
  userSessions.set(userId, session);

  try {
    audit(userId, 'interject_question', { question: userText.slice(0, 200), quizTopic: session.topic || session.topics?.[0] });
    await ctx.replyWithMarkdown(`💬 _Answering your question — quiz will resume after..._`);

    // Ask Ollama for an academic NCLEX-scoped answer
    const answer = await getNCLEXInterjectAnswer(userText, session.topic);
    await ctx.replyWithMarkdown(answer);
    audit(userId, 'interject_answered', { question: userText.slice(0, 100) });

    // Remind them the quiz is still waiting
    const answeredCount  = Object.keys(session.answered).length;
    const remaining      = 15 - answeredCount;
    await ctx.replyWithMarkdown(
      `📌 _Back to your quiz — *${escapeMd(session.topic)}*_\n` +
      `_${remaining} question${remaining !== 1 ? 's' : ''} remaining. ` +
      `Tap A / B / C / D above to continue._`
    );
  } catch (err) {
    logger.error('[Quiz Interject] error:', err);
    await ctx.reply('⚠️ Could not answer that right now. Tap A/B/C/D to continue your quiz.');
  } finally {
    // Always restore quiz_active so the inline buttons keep working
    session.state = 'quiz_active';
    userSessions.set(userId, session);
  }
}

/**
 * Calls Ollama with a focused prompt: answer the question academically
 * within NCLEX scope, keep it concise (no waffle).
 */
async function getNCLEXInterjectAnswer(question, quizTopic) {
  const { callOllama } = await import('../services/ai.service.js').catch(() => ({ callOllama: null }));

  // Build a tight academic prompt
  const prompt =
    `You are an expert NCLEX nursing tutor. A student asked this question while practising ` +
    `on the topic "${quizTopic}":\n\n` +
    `"${question}"\n\n` +
    `Answer concisely and academically within NCLEX-RN/PN scope. ` +
    `Use proper nursing terminology. Max 4 short paragraphs. ` +
    `If the question is unrelated to nursing or NCLEX, politely redirect them.`;

  // Use callOllama from ai_service if available, otherwise inline stream
  if (callOllama) {
    try {
      const text = await callOllama(prompt, { num_predict: 500, temperature: 0.4 });
      return text.trim() || '_No answer available — please ask your instructor._';
    } catch (err) {
      logger.warn('[Interject] callOllama failed:', err.message);
    }
  }

  // Fallback: use the same ollamaStream pattern from quiz_service
  try {
    const fetch  = (await import('node-fetch')).default;
    const OLLAMA_BASE  = process.env.OLLAMA_URL   || 'http://localhost:11434';
    const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);

    const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL, prompt, stream: true,
        options: { temperature: 0.4, num_predict: 500, top_p: 0.9 },
      }),
    });

    let text = '';
    const dec = new TextDecoder();
    await new Promise((resolve, reject) => {
      res.body.on('data', chunk => {
        try {
          for (const line of dec.decode(chunk).split('\n').filter(Boolean)) {
            const j = JSON.parse(line);
            if (j.response) text += j.response;
            if (j.done) { clearTimeout(timer); resolve(); }
          }
        } catch (_) {}
      });
      res.body.on('error', e => { clearTimeout(timer); reject(e); });
      res.body.on('end',   () => { clearTimeout(timer); resolve(); });
    });

    return text.trim() || '_No answer available._';
  } catch (err) {
    logger.error('[Interject] fallback stream failed:', err.message);
    return `⚠️ _Could not fetch an answer right now. Continue with your quiz and review this topic afterwards._`;
  }
}

// ─── QUIZ: generate next question and send ────────────────────────────────────
async function generateAndSendNext(ctx, userId, nextIndex) {
  const session = userSessions.get(userId);
  if (!session) return;

  session.state = 'quiz_next_loading';
  userSessions.set(userId, session);

  const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;

  try {
    // Pick the topic for this slot from the schedule
    const schedule     = session.schedule || Array(15).fill(session.topics?.[0] || session.topic || 'NCLEX');
    const topicForSlot = schedule[nextIndex] || schedule[schedule.length - 1];
    const ctxSnip      = session.contextMap?.[topicForSlot]?.context || session.ctxSnip || '';

    const q = await generateSingleQuestion(topicForSlot, nextIndex + 1, ctxSnip);
    session.questions.push(q);
    session.state = 'quiz_active';
    userSessions.set(userId, session);

    await sendQuestionMessage(ctx, q, nextIndex);
    audit(userId, 'quiz_question_sent', { qNum: nextIndex + 1, topic: topicForSlot });

    // Flush any queued interject
    const pending = session.pendingInterject;
    if (pending) {
      session.pendingInterject = null;
      userSessions.set(userId, session);
      setTimeout(() => handleQuizInterject(ctx, session, pending), 800);
    }

  } catch (err) {
    logger.error(`[Quiz] Q${nextIndex + 1} generate error:`, err);
    audit(userId, 'quiz_error', { stage: `question_${nextIndex + 1}`, topic: session.schedule?.[nextIndex], err: err.message });
    session.state = 'quiz_active';
    session.pendingInterject = null;
    userSessions.set(userId, session);

    try {
      await ctx.telegram.sendMessage(chatId, `⚠️ Skipping Q${nextIndex + 1} — AI hiccup. Moving on...`);
      const skip = nextIndex + 1;
      if (skip < 15) setTimeout(() => generateAndSendNext(ctx, userId, skip), 1000);
      else setTimeout(() => sendFinalScore(ctx, userId), 1000);
    } catch (_) {}
  }
}

// ─── QUIZ: send a question with inline A/B/C/D buttons ────────────────────────
async function sendQuestionMessage(ctx, question, qIndex) {
  const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
  const qNum   = qIndex + 1;

  const text =
    `*Q${qNum}/15*\n\n` +
    `${escapeMd(question.question)}\n\n` +
    Object.entries(question.options).map(([l, t]) => `*${l}.* ${escapeMd(t)}`).join('\n');

  const keyboard = {
    inline_keyboard: [[
      { text: 'A', callback_data: `quiz_answer:${qIndex}:A` },
      { text: 'B', callback_data: `quiz_answer:${qIndex}:B` },
      { text: 'C', callback_data: `quiz_answer:${qIndex}:C` },
      { text: 'D', callback_data: `quiz_answer:${qIndex}:D` },
    ]],
  };

  try {
    await ctx.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
  } catch (err) {
    logger.error('[Quiz] sendQuestionMessage error:', err);
  }
}

// ─── QUIZ: final score ────────────────────────────────────────────────────────
async function sendFinalScore(ctx, userId) {
  const session = userSessions.get(userId);
  if (!session) return;

  const score  = session.score || 0;
  const total  = Object.keys(session.answered).length || 15;
  const pct    = Math.round((score / total) * 100);
  const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;

  let feedback;
  if (pct >= 85)      feedback = `🏆 Outstanding! You're NCLEX-ready on these topics.`;
  else if (pct >= 70) feedback = `👍 Good work! A little more practice and you'll be there.`;
  else if (pct >= 55) feedback = `📚 Fair attempt. Review these topics and try again.`;
  else                feedback = `💪 Keep studying! Use /buy for targeted study materials.`;

  // Build topic line — single vs multiple
  const topics   = session.topics || (session.topic ? [session.topic] : ['NCLEX']);
  const schedule = session.schedule || Array(total).fill(topics[0]);

  let topicLine = `🎯 *Topic:* ${escapeMd(topics[0])}`;

  if (topics.length > 1) {
    // Per-topic score breakdown
    const topicScores = {};
    const topicTotals = {};
    for (const t of topics) { topicScores[t] = 0; topicTotals[t] = 0; }

    for (const [idxStr, chosen] of Object.entries(session.answered)) {
      const idx = parseInt(idxStr);
      const t   = schedule[idx] || topics[0];
      const q   = session.questions[idx];
      if (!topicTotals[t]) topicTotals[t] = 0;
      topicTotals[t]++;
      if (q && chosen === q.correct) {
        if (!topicScores[t]) topicScores[t] = 0;
        topicScores[t]++;
      }
    }

    const breakdown = topics.map(t => {
      const s = topicScores[t] || 0;
      const n = topicTotals[t] || 0;
      const p = n > 0 ? Math.round((s/n)*100) : 0;
      const bar = p >= 70 ? '🟢' : p >= 50 ? '🟡' : '🔴';
      return `  ${bar} ${escapeMd(t)}: ${s}/${n} (${p}%)`;
    }).join('\n');

    topicLine = `🎯 *Topics:*\n${breakdown}`;
  }

  try {
    await ctx.telegram.sendMessage(
      chatId,
      `🎉 *Quiz Complete!*\n\n` +
      `📊 *Score:* ${score}/${total} (${pct}%)\n` +
      `${topicLine}\n\n` +
      `${feedback}\n\n` +
      `➡️ /quiz — try another quiz\n` +
      `➡️ /buy — get study materials`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    logger.error('[Quiz] sendFinalScore error:', err);
  }

  audit(userId, 'quiz_completed', {
    score,
    total,
    pct,
    topics,
    schedule: session.schedule,
  });
  userSessions.delete(userId);
}

// ─── QUIZ: user-friendly error message ────────────────────────────────────────
function quizErrorMessage(err) {
  let reason = 'Something went wrong. Please type /quiz to try again.';
  if (err.message?.includes('ollama serve') || err.message?.includes('ECONNREFUSED')) {
    reason =
      'The local AI (Ollama) is not running.\n\n' +
      '• Start it: `ollama serve`\n' +
      '• Pull model: `ollama pull llama3.2:3b`\n\n' +
      'Then type /quiz to try again.';
  } else if (err.message?.includes('timed out')) {
    reason = 'The AI took too long. Try a simpler topic or use /quiz to try again.';
  }
  return `❌ *Quiz failed to start.*\n\n${reason}`;
}


// ─── HTML helper — safe for any user data or material titles ──────────────────
function h(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sendHTML(ctx, text, extra = {}) {
  const chatId = ctx.chat?.id || ctx.from?.id;
  return ctx.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...extra });
}

// ─── PURCHASE FLOW ─────────────────────────────────────────────────────────────
// All messages use HTML — immune to Telegram Markdown parse errors.
// Steps: category_selection → material_selection → payment_card
//        → awaiting_name → awaiting_email → awaiting_ref → confirming
// ──────────────────────────────────────────────────────────────────────────────
// ─── PURCHASE FLOW ─────────────────────────────────────────────────────────────
// Uses native Telegram features only:
//   • HTML messages     — no Markdown parse errors
//   • Inline keyboards  — buttons for method selection and confirm
//   • ForceReply        — makes chat look like a form field at each step
//
// Steps:  category_selection → material_selection → method_selection
//         → name → email → ref → confirming
//
// ForceReply prompts look like this in the chat:
//   ┌─────────────────────────────┐
//   │ Reply to: Enter your name   │ ← quoted prompt (greyed out)
//   └─────────────────────────────┘
//   [                           ] ← keyboard auto-opens
// ──────────────────────────────────────────────────────────────────────────────

// Utility: send a ForceReply prompt
// The user sees the promptText as a quoted reply they must respond to.
function sendForceReply(ctx, promptText) {
  return sendHTML(ctx, promptText, {
    reply_markup: { force_reply: true, input_field_placeholder: '' },
  });
}

async function handleNCLEXPurchaseFlow(ctx, session, userInput) {
  const userId = String(ctx.from.id);

  // ── "back" at any step ─────────────────────────────────────────────────
  if (userInput.toLowerCase() === 'back') {
    if (session.step === 'material_selection') {
      session.step = 'category_selection'; session.currentCategory = null;
      userSessions.set(userId, session);
      return sendHTML(ctx,
        '🔙 <b>Back to categories:</b>\n\n' +
        '1. Safe and Effective Care Environment\n' +
        '2. Health Promotion and Maintenance\n' +
        '3. Psychosocial Integrity\n' +
        '4. Physiological Integrity'
      );
    }
    if (['method_selection','name','email','ref','confirming'].includes(session.step)) {
      session.step = 'material_selection';
      userSessions.set(userId, session);
      return displayNCLEXMaterials(ctx, session.materials, session.currentCategory);
    }
  }

  switch (session.step) {

    // ── 1. Category ──────────────────────────────────────────────────────
    case 'category_selection': {
      const catMap = {
        '1': 'Safe and Effective Care Environment',
        '2': 'Health Promotion and Maintenance',
        '3': 'Psychosocial Integrity',
        '4': 'Physiological Integrity',
      };
      const selected = catMap[userInput.trim()] ||
        Object.values(catMap).find(c =>
          userInput.toLowerCase().includes(c.toLowerCase().slice(0, 12))
        );
      if (!selected) {
        return sendHTML(ctx,
          '❌ Please choose a category:\n\n' +
          '1. Safe and Effective Care Environment\n' +
          '2. Health Promotion and Maintenance\n' +
          '3. Psychosocial Integrity\n' +
          '4. Physiological Integrity'
        );
      }
      session.currentCategory = selected; session.step = 'material_selection';
      userSessions.set(userId, session);
      await sendHTML(ctx, `🔍 Searching <b>${h(selected)}</b>...`);
      const materials = await Material.find({ category: selected }).limit(10).lean();
      if (!materials.length) {
        await sendHTML(ctx, `📭 No materials in <b>${h(selected)}</b> yet.\n\nTry another category or type <b>back</b>.`);
        session.step = 'category_selection'; userSessions.set(userId, session); return;
      }
      session.materials = materials; userSessions.set(userId, session);
      return displayNCLEXMaterials(ctx, materials, selected);
    }

    // ── 2. Material selection ────────────────────────────────────────────
    case 'material_selection': {
      const num = parseInt(userInput.trim());
      if (isNaN(num) || num < 1 || num > session.materials.length) {
        return sendHTML(ctx, `❌ Reply with a number between 1 and ${session.materials.length}.`);
      }
      const mat = session.materials[num - 1];
      session.selectedMaterial = mat;

      // Issue promo code in DB — links this user+material together
      try {
        const { issuePromoCode } = await import('../services/payment.service.js');
        const promo = await issuePromoCode(ctx.dbUser, mat);
        session.promoCode = promo.code;
        audit(userId, 'purchase_promo_issued', {
          promoCode: promo.code,
          material:  mat.title,
          amount:    mat.price,
          category:  mat.category,
        });
      } catch (e) {
        logger.error('[Buy] issuePromoCode failed:', e);
        session.promoCode = Math.floor(100000 + Math.random() * 900000).toString();
      }

      session.step = 'awaiting_payment';
      userSessions.set(userId, session);
      audit(userId, 'purchase_payment_open', { promoCode: session.promoCode, material: session.selectedMaterial?.title });

      const price  = mat.price === 'Free' ? 'Free' : `$${mat.price} USD`;
      const topics = (mat.topics || []).slice(0, 3).map(t => h(t)).join(', ') || 'General';

      // Build payment URL — must end with / before ? for Telegram to accept it
      const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:5713').replace(/\/$/, '');
      const paymentUrl   = `${frontendBase}/?code=${session.promoCode}`;

      // Telegram rejects localhost URLs in inline buttons — detect and use text link instead
      const isLocalhost  = frontendBase.includes('localhost') || frontendBase.includes('127.0.0.1');

      const msgText =
        `✅ <b>Purchase Confirmation</b>\n\n` +
        `📦 <b>Material:</b> ${h(mat.title)}\n` +
        `📚 <b>Category:</b> ${h(mat.category)}\n` +
        `🎯 <b>Topics:</b> ${topics}\n` +
        `💰 <b>Price:</b> ${price}\n` +
        `🎟 <b>Promo Code:</b> <code>${session.promoCode}</code>\n\n` +
        (isLocalhost
          ? `Open this link to complete payment:\n<a href="${paymentUrl}">${paymentUrl}</a>\n\n<i>Set FRONTEND_URL in .env to your ngrok/production URL to get a button here instead.</i>`
          : `Tap <b>Complete Payment</b> below to pay via Wise.`);

      const replyMarkup = isLocalhost
        ? { inline_keyboard: [[{ text: '← Back to materials', callback_data: 'pay_method:back' }]] }
        : { inline_keyboard: [
            [{ text: '💳 Complete Payment', url: paymentUrl }],
            [{ text: '← Back to materials', callback_data: 'pay_method:back' }],
          ]};

      return sendHTML(ctx, msgText, { reply_markup: replyMarkup });
    }

    // Awaiting payment — user has the link, nothing more to do in chat
    case 'awaiting_payment': {
      const low = userInput.toLowerCase();
      if (low === 'back') {
        session.step = 'material_selection';
        userSessions.set(userId, session);
        return displayNCLEXMaterials(ctx, session.materials, session.currentCategory);
      }
      const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:5713').replace(/\/$/, '');
      const paymentUrl   = `${frontendBase}/?code=${session.promoCode}`;
      const isLocalhost  = frontendBase.includes('localhost') || frontendBase.includes('127.0.0.1');

      if (isLocalhost) {
        return sendHTML(ctx,
          `💳 Open this link to complete your payment:\n<a href="${paymentUrl}">${paymentUrl}</a>\n\nOr type <b>back</b> to choose a different material.`
        );
      }
      return sendHTML(ctx,
        `💳 Tap the button to complete your payment, or type <b>back</b> to choose a different material.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💳 Complete Payment', url: paymentUrl }],
              [{ text: '← Back to materials', callback_data: 'pay_method:back' }],
            ],
          },
        }
      );
    }
    case 'method_selection': {
      const low = userInput.toLowerCase();
      if (low === '1' || low.includes('wise')) {
        session.paymentMethod = 'wise'; session.step = 'name';
        userSessions.set(userId, session);
        return sendWiseCard(ctx, session);
      }
      if (low === '2' || low.includes('bank')) {
        session.paymentMethod = 'bank_transfer'; session.step = 'name';
        userSessions.set(userId, session);
        return sendBankCard(ctx, session);
      }
      return sendHTML(ctx, 'Tap <b>💚 Pay with Wise</b> or <b>🏦 Bank Transfer</b> above.');
    }

    // ── 4. Collect name (ForceReply) ─────────────────────────────────────
    case 'name': {
      if (userInput.trim().length < 2) {
        return sendForceReply(ctx, '❌ Please enter your full name (at least 2 characters):');
      }
      session.senderName = userInput.trim();
      session.step = 'email';
      userSessions.set(userId, session);
      return sendForceReply(ctx,
        `✅ <b>Name:</b> ${h(session.senderName)}\n\n` +
        `📧 Now enter your <b>email address</b> for your receipt:`
      );
    }

    // ── 5. Collect email (ForceReply) ────────────────────────────────────
    case 'email': {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userInput.trim())) {
        return sendForceReply(ctx, '❌ Please enter a valid email address:');
      }
      session.senderEmail = userInput.trim();
      session.step = 'ref';
      userSessions.set(userId, session);
      return sendForceReply(ctx,
        `✅ <b>Email:</b> ${h(session.senderEmail)}\n\n` +
        `🔖 Paste your <b>${session.paymentMethod === 'wise' ? 'Wise transfer ID' : 'bank reference number'}</b>:\n` +
        `<i>(Find this in your payment receipt or banking app)</i>`
      );
    }

    // ── 6. Collect transaction ref (ForceReply) ──────────────────────────
    case 'ref': {
      if (userInput.trim().length < 3) {
        return sendForceReply(ctx, '❌ Please paste your transaction reference:');
      }
      session.transactionRef = userInput.trim();
      session.step = 'confirming';
      userSessions.set(userId, session);
      const mat = session.selectedMaterial;
      return sendHTML(ctx,
        `📋 <b>Payment Summary</b>\n` +
        `─────────────────────\n` +
        `📦 ${h(mat.title)}\n` +
        `💰 <b>${mat.price === 'Free' ? 'Free' : `$${mat.price} USD`}</b>\n` +
        `💳 ${session.paymentMethod === 'wise' ? 'Wise' : 'Bank Transfer'}\n` +
        `🎟 Promo code: <code>${session.promoCode}</code>\n` +
        `👤 ${h(session.senderName)}\n` +
        `📧 ${h(session.senderEmail)}\n` +
        `🔖 Ref: <code>${h(session.transactionRef)}</code>\n` +
        `─────────────────────\n\n` +
        `Everything look correct? Tap <b>Confirm &amp; Send File</b> to complete.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Confirm & Send File', callback_data: 'pay_confirm' }],
              [{ text: '← Back',                callback_data: 'pay_method:back' }],
            ],
          },
        }
      );
    }

    // ── 7. Confirming (text fallback if user types "confirm") ────────────
    case 'confirming': {
      if (userInput.toLowerCase() !== 'confirm') {
        return sendHTML(ctx, 'Tap <b>✅ Confirm &amp; Send File</b> above, or type <b>back</b>.');
      }
      return processPaymentAndDeliver(ctx, session, userId);
    }
  }
}

// ── Wise payment instructions card ────────────────────────────────────────────
async function sendWiseCard(ctx, session) {
  const mat   = session.selectedMaterial;
  const link  = process.env.WISE_PAYMENT_LINK   || 'https://wise.com/pay/me/YOUR_USERNAME';
  const name  = process.env.WISE_ACCOUNT_HOLDER || 'Account Holder';
  const price = mat.price === 'Free' ? 'Free' : `$${mat.price} USD`;
  const code  = session.promoCode;
  await sendHTML(ctx,
    `💚 <b>Pay with Wise</b>\n` +
    `─────────────────────\n` +
    `👤 <b>Account Holder:</b> ${h(name)}\n` +
    `💰 <b>Amount:</b> ${h(String(price))}\n` +
    `🔗 <b>Wise Link:</b> ${h(link)}\n\n` +
    `📌 <b>Payment reference — use this exact code:</b>\n` +
    `<code>${code}</code>\n\n` +
    `<i>Open the Wise link, enter the amount, and paste the code above as the payment reference.</i>\n` +
    `─────────────────────`
  );
  return sendForceReply(ctx, '✅ After paying, enter your <b>full name</b> as it appears on your Wise account:');
}

// ── Bank transfer instructions card ───────────────────────────────────────────
async function sendBankCard(ctx, session) {
  const mat  = session.selectedMaterial;
  const iban = process.env.WISE_IBAN           || 'GB00 WISE 0000 0000 0000 00';
  const bic  = process.env.WISE_BIC            || 'TRWIGB2L';
  const name = process.env.WISE_ACCOUNT_HOLDER || 'Account Holder';
  const code = session.promoCode;
  await sendHTML(ctx,
    `🏦 <b>Bank Transfer Details</b>\n` +
    `─────────────────────\n` +
    `👤 <b>Account Holder:</b> ${h(name)}\n` +
    `🏛 <b>Bank:</b> Wise (TransferWise)\n` +
    `💳 <b>IBAN:</b> <code>${h(iban)}</code>\n` +
    `🔀 <b>BIC/SWIFT:</b> <code>${h(bic)}</code>\n` +
    `💰 <b>Amount:</b> $${h(String(mat.price))} USD\n\n` +
    `📌 <b>Payment reference — use this exact code:</b>\n` +
    `<code>${code}</code>\n\n` +
    `<i>Include the promo code as the reference so your payment is matched to your order.</i>\n` +
    `─────────────────────`
  );
  return sendForceReply(ctx, '✅ After transferring, enter your <b>full name</b> as it appears on your bank account:');
}

// ── Process confirmed payment, save to DB, deliver file ───────────────────────
async function processPaymentAndDeliver(ctx, session, userId) {
  await sendHTML(ctx, '⏳ <b>Processing...</b>');
  try {
    const { submitPaymentDetails, confirmPayment, markFileDelivered } =
      await import('../services/payment.service.js');

    await submitPaymentDetails(session.promoCode, {
      method:         session.paymentMethod,
      senderName:     session.senderName,
      senderEmail:    session.senderEmail,
      transactionRef: session.transactionRef,
    });

    const { purchase, material } = await confirmPayment(session.promoCode, 'user_submitted');

    await sendHTML(ctx,
      `✅ <b>Payment confirmed!</b>\n\n` +
      `📦 ${h(material.title)}\n` +
      `🎟 Code: <code>${session.promoCode}</code>\n` +
      `🔖 Ref: <code>${h(session.transactionRef)}</code>\n\n` +
      `📥 <b>Sending your file now...</b>`
    );

    await sendMaterialFile(ctx, material);
    await markFileDelivered(session.promoCode);

    audit(userId, 'purchase_verified', {
      promoCode: session.promoCode,
      material:  material.title,
      method:    session.paymentMethod,
      ref:       session.transactionRef,
    });
    audit(userId, 'purchase_delivered', {
      promoCode: session.promoCode,
      material:  material.title,
    });

    logger.info('[Purchase] Complete', {
      purchaseId: purchase._id,
      code:       session.promoCode,
      user:       ctx.from.id,
      material:   material.title,
    });

  } catch (err) {
    logger.error('[Purchase] Error:', err);
    audit(userId, 'purchase_error', {
      stage:     'payment_delivery',
      promoCode: session.promoCode,
      err:       err.message,
    });
    await sendHTML(ctx,
      `⚠️ <b>Payment saved, but file delivery failed.</b>\n\n` +
      `Your promo code is <code>${session.promoCode}</code>.\n` +
      `Contact support with this code and we will send your file manually.`
    );
  }
  userSessions.delete(userId);
}

// ── Materials list ─────────────────────────────────────────────────────────────
async function displayNCLEXMaterials(ctx, materials, category) {
  let text = `📚 <b>${h(category)}</b>\n\n`;
  materials.forEach((m, i) => {
    const desc  = m.description ? h(m.description.substring(0, 70)) + '...' : 'NCLEX review material';
    const price = m.price === 'Free' ? '🆓 Free' : `💰 $${h(String(m.price))} USD`;
    text += `${i + 1}. <b>${h(m.title)}</b>\n   ${desc}\n   ${price}\n\n`;
  });
  text += `Reply with the <b>number</b> of the material you want, or type <b>back</b>.`;
  await sendHTML(ctx, text);
}

// Legacy stubs (no longer used — kept to avoid reference errors)
async function handleMaterialSelection() {}
async function handleDownloadConfirmation() {}
async function processConfirmedPayment() {}
async function sendPaymentCard() {}
async function sendWiseInstructions() {}
async function sendBankInstructions() {}

// ── Resume from existing session ──────────────────────────────────────────────
async function continueFromSession(ctx, session) {
  switch (session.state) {
    case 'nclex_purchase':
      if (session.step === 'category_selection') {
        return sendHTML(ctx,
          'Choose a category:\n\n' +
          '1. Safe and Effective Care Environment\n' +
          '2. Health Promotion and Maintenance\n' +
          '3. Psychosocial Integrity\n' +
          '4. Physiological Integrity'
        );
      }
      if (session.step === 'material_selection') {
        return displayNCLEXMaterials(ctx, session.materials, session.currentCategory);
      }
      if (['method_selection','name','email','ref','confirming'].includes(session.step)) {
        // Re-show the order card so user can see their code and continue
        const mat = session.selectedMaterial;
        return sendHTML(ctx,
          `🛒 Continuing your order: <b>${h(mat.title)}</b>\n` +
          `🎟 Code: <code>${session.promoCode}</code>\n\n` +
          `Type <b>back</b> to restart, or continue where you left off.`
        );
      }
      break;
    case 'quiz_topic_selection':
      return startQuizFlow(ctx);
  }
  return ctx.reply('Welcome back! How can I help with NCLEX prep today?');
}

// ── Stream file from GridFS and send to user ───────────────────────────────────
async function sendMaterialFile(ctx, material) {
  try {
    const bucket = getGFSBucket();
    const files  = await bucket.find({ _id: new mongoose.Types.ObjectId(material.fileId) }).toArray();
    if (!files.length) {
      await sendHTML(ctx, '❌ File not found in storage. Contact support with your promo code.');
      return;
    }

    const stream = bucket.openDownloadStream(new mongoose.Types.ObjectId(material.fileId));
    const chunks = [];
    await new Promise((resolve, reject) => {
      stream.on('data',  c => chunks.push(c));
      stream.on('end',   resolve);
      stream.on('error', reject);
    });

    const fileBuffer = Buffer.concat(chunks);
    if (fileBuffer.length > 50 * 1024 * 1024) {
      await sendHTML(ctx, '📁 File is over 50 MB. Contact support — we will send it another way.');
      return;
    }

    await ctx.replyWithChatAction('upload_document');
    const fileInfo  = files[0];
    const fileName  = material.fileName || fileInfo.filename ||
      `${material.title.replace(/[^\w\s]/gi, '')}.pdf`;
    const topicList = (material.topics || []).map(t => h(t)).join(', ') || 'General NCLEX topics';

    await ctx.replyWithDocument(
      { source: fileBuffer, filename: fileName },
      {
        caption:
          `📚 <b>${h(material.title)}</b>\n` +
          `📖 ${h(material.category)}\n` +
          `🎯 ${topicList}\n\n` +
          `✅ <b>Paid and delivered — NCLEX Prep Bot</b>`,
        parse_mode: 'HTML',
      }
    );

    await sendHTML(ctx,
      `🎉 <b>Enjoy your material!</b>\n\n` +
      `💡 /quiz — practice questions\n` +
      `📚 /buy — more materials`
    );

  } catch (err) {
    logger.error('[sendMaterialFile] error:', err);
    await sendHTML(ctx, '❌ Error delivering file. Contact support with your promo code.');
  }
}

export default bot;