/**
 * NCLEX Quiz Bot Handlers
 * ────────────────────────
 * Drop-in replacement for the quiz sections of bot/index.js.
 *
 * HOW TO INTEGRATE:
 *   1. Remove from index.js:
 *        - handleQuizTopicSelection()
 *        - sendQuizQuestion()
 *        - sendQuizSummary()
 *        - bot.on('callback_query', ...) for quiz_answer
 *        - bot.command('questions', ...)
 *        - bot.command('quiz', ...)
 *        - startQuizFlow()
 *
 *   2. At the top of index.js add:
 *        import { registerQuizHandlers, startQuizFlow } from './quiz_bot_handlers.js';
 *
 *   3. After `export const bot = new Telegraf(...)` add:
 *        registerQuizHandlers(bot, userSessions);
 *
 *   The userSessions Map is shared — pass the same one used for purchase flow.
 *
 * SESSION STATES used by this module:
 *   quiz_topic_selection  — waiting for user to type a topic
 *   quiz_loading          — generating Q1 (locked, ignore stray messages)
 *   quiz_active           — quiz in progress, waiting for inline button tap
 *   quiz_next_loading     — generating next question after answer
 */

import { logger } from '../utils/logger.js';
import {
  extractTopicSmart,
  fetchTopicContext,
  generateSingleQuestion,
  checkOllama,
} from '../services/quiz.service.js';

// ── Markdown escaper (Telegram legacy Markdown) ────────────────────────────────
function esc(text) {
  if (!text) return '';
  return String(text).replace(/[_*`[]/g, '\\$&');
}

// ── Score emoji ────────────────────────────────────────────────────────────────
function scoreEmoji(pct) {
  if (pct >= 85) return '🏆';
  if (pct >= 70) return '👍';
  if (pct >= 55) return '📚';
  return '💪';
}

// ── Register all quiz-related handlers on the bot instance ────────────────────
export function registerQuizHandlers(bot, userSessions) {

  // ── /questions and /quiz commands ──────────────────────────────────────────
  bot.command('questions', ctx => startQuizFlow(ctx, userSessions));
  bot.command('quiz',      ctx => startQuizFlow(ctx, userSessions));

  // ── Inline button handler (A / B / C / D answer taps) ─────────────────────
  bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery?.data || '';
    if (!data.startsWith('quiz_answer:')) return ctx.answerCbQuery();

    const [, qIndexStr, chosen] = data.split(':');
    const qIndex  = parseInt(qIndexStr, 10);
    const userId  = String(ctx.from.id);
    const session = userSessions.get(userId);

    // ── Guard: session must be active ───────────────────────────────────────
    if (!session || session.state !== 'quiz_active') {
      return ctx.answerCbQuery('Session expired — use /quiz to start again.', { show_alert: true });
    }

    const question = session.questions[qIndex];
    if (!question) return ctx.answerCbQuery('Question not found.', { show_alert: true });

    // ── Guard: already answered ──────────────────────────────────────────────
    if (session.answered[qIndex] !== undefined) {
      return ctx.answerCbQuery('Already answered!', { show_alert: true });
    }

    // ── Record answer ────────────────────────────────────────────────────────
    const isCorrect = chosen === question.correct;
    session.answered[qIndex] = chosen;
    if (isCorrect) session.score += 1;
    userSessions.set(userId, session);

    // ── Acknowledge tap immediately ──────────────────────────────────────────
    await ctx.answerCbQuery(isCorrect ? '✅ Correct!' : `❌ Wrong — answer is ${question.correct}`);

    // ── Edit the question message to reveal answer + explanation ─────────────
    const optLines = Object.entries(question.options).map(([letter, text]) => {
      let marker = '';
      if (letter === question.correct) marker = ' ✅';
      else if (letter === chosen && !isCorrect) marker = ' ❌';
      return `*${letter}.* ${esc(text)}${marker}`;
    }).join('\n');

    const revealed =
      `*Q${qIndex + 1}/15 — ${esc(question.question)}*\n\n` +
      `${optLines}\n\n` +
      `${isCorrect ? '✅ *Correct!*' : `❌ *Wrong. Correct answer: ${question.correct}*`}\n\n` +
      `📖 *Explanation:*\n${esc(question.explanation)}`;

    try {
      await ctx.editMessageText(revealed, { parse_mode: 'Markdown' });
    } catch (_) {
      // If edit fails (e.g. message too old), send as new message
      await ctx.replyWithMarkdown(revealed);
    }

    // ── Move to next question or end ─────────────────────────────────────────
    const nextIndex = qIndex + 1;
    if (nextIndex < 15) {
      // Small delay so the reveal message is readable before next Q appears
      setTimeout(() => sendNextQuestion(ctx, userId, nextIndex, userSessions), 1200);
    } else {
      setTimeout(() => sendFinalScore(ctx, userId, userSessions), 1200);
    }
  });
}

// ── Public: kick off the quiz flow (called from /questions, /quiz, text handler) ─
export async function startQuizFlow(ctx, userSessions) {
  const userId = String(ctx.from.id);
  userSessions.set(userId, { state: 'quiz_topic_selection' });

  return ctx.replyWithMarkdown(
    `🎯 *NCLEX Practice Quiz*\n\n` +
    `What topic would you like to be quizzed on?\n\n` +
    `*Examples:*\n` +
    `• Growth and development\n` +
    `• Pharmacology\n` +
    `• Mental health disorders\n` +
    `• Fluid and electrolyte balance\n` +
    `• Infection control\n\n` +
    `Or reply with a category number:\n` +
    `1. Safe and Effective Care Environment\n` +
    `2. Health Promotion and Maintenance\n` +
    `3. Psychosocial Integrity\n` +
    `4. Physiological Integrity`
  );
}

// ── Called from the main text handler when state === 'quiz_topic_selection' ───
export async function handleQuizTopicSelection(ctx, userInput, userSessions) {
  const userId = String(ctx.from.id);

  // Extract clean topic
  let topic;
  try {
    topic = await extractTopicSmart(userInput);
  } catch (_) {
    topic = userInput.trim();
  }

  // Lock session so stray messages don't retrigger
  userSessions.set(userId, { state: 'quiz_loading' });

  // Tell the user we're starting
  await ctx.replyWithMarkdown(
    `📝 *Quiz: ${esc(topic)}*\n\n` +
    `Generating your first question...`
  );

  try {
    // Verify Ollama is up
    await checkOllama();

    // Fetch DB context once — reused for all 15 questions
    const { context: ctxSnip, titles } = await fetchTopicContext(topic);

    if (titles.length > 0) {
      logger.info(`[Quiz] Using context from: ${titles.join(', ')}`);
    }

    // Generate Q1
    const q1 = await generateSingleQuestion(topic, 1, ctxSnip);

    // Store session
    userSessions.set(userId, {
      state:    'quiz_active',
      topic,
      ctxSnip,              // reused for subsequent questions
      questions: [q1],      // grows as questions are generated
      answered:  {},
      score:     0,
      total:     15,
    });

    // Send Q1
    await sendQuestionMessage(ctx, q1, 0);

  } catch (err) {
    logger.error('[Quiz] Setup error:', err);
    userSessions.delete(userId);

    let reason = 'Something went wrong.';
    if (err.message?.includes('ollama serve') || err.message?.includes('ECONNREFUSED')) {
      reason = 'The local AI (Ollama) is not running.\n\n• Start: `ollama serve`\n• Pull: `ollama pull llama3.2:3b`';
    } else if (err.message?.includes('timed out')) {
      reason = 'The AI took too long. Try again with /quiz.';
    }

    await ctx.replyWithMarkdown(`❌ *Quiz failed to start.*\n\n${reason}`);
  }
}

// ── Generate and send the next question after an answer ───────────────────────
async function sendNextQuestion(ctx, userId, nextIndex, userSessions) {
  const session = userSessions.get(userId);
  if (!session) return;

  // Mark as loading so stray messages are ignored
  session.state = 'quiz_next_loading';
  userSessions.set(userId, session);

  const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;

  try {
    // Generate the next question
    const q = await generateSingleQuestion(session.topic, nextIndex + 1, session.ctxSnip);

    // Append to session
    session.questions.push(q);
    session.state = 'quiz_active';
    userSessions.set(userId, session);

    await sendQuestionMessage(ctx, q, nextIndex);

  } catch (err) {
    logger.error(`[Quiz] Failed to generate Q${nextIndex + 1}:`, err);
    session.state = 'quiz_active'; // unlock so user can still interact
    userSessions.set(userId, session);

    try {
      await ctx.telegram.sendMessage(
        chatId,
        `⚠️ Skipping Q${nextIndex + 1} — AI error. Continuing to next question...`
      );
      // Try to skip ahead
      if (nextIndex + 1 < 15) {
        setTimeout(() => sendNextQuestion(ctx, userId, nextIndex + 1, userSessions), 1000);
      } else {
        setTimeout(() => sendFinalScore(ctx, userId, userSessions), 1000);
      }
    } catch (_) {}
  }
}

// ── Send a question as a Telegram message with A/B/C/D inline buttons ─────────
async function sendQuestionMessage(ctx, question, qIndex) {
  const qNum = qIndex + 1;
  const text =
    `*Q${qNum}/15*\n\n` +
    `${esc(question.question)}\n\n` +
    Object.entries(question.options)
      .map(([l, t]) => `*${l}.* ${esc(t)}`)
      .join('\n');

  const keyboard = {
    inline_keyboard: [[
      { text: 'A', callback_data: `quiz_answer:${qIndex}:A` },
      { text: 'B', callback_data: `quiz_answer:${qIndex}:B` },
      { text: 'C', callback_data: `quiz_answer:${qIndex}:C` },
      { text: 'D', callback_data: `quiz_answer:${qIndex}:D` },
    ]],
  };

  const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
  try {
    await ctx.telegram.sendMessage(chatId, text, {
      parse_mode:   'Markdown',
      reply_markup: keyboard,
    });
  } catch (err) {
    logger.error('[Quiz] sendQuestionMessage error:', err);
  }
}

// ── Final score summary ────────────────────────────────────────────────────────
async function sendFinalScore(ctx, userId, userSessions) {
  const session = userSessions.get(userId);
  if (!session) return;

  const score   = session.score || 0;
  const total   = Object.keys(session.answered).length;
  const pct     = total > 0 ? Math.round((score / total) * 100) : 0;
  const emoji   = scoreEmoji(pct);
  const chatId  = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;

  let feedback;
  if (pct >= 85) feedback = 'Outstanding! You are NCLEX-ready on this topic. 🎉';
  else if (pct >= 70) feedback = 'Good work! A little more practice and you\'ll be ready.';
  else if (pct >= 55) feedback = 'Fair attempt. Review this topic and try again.';
  else feedback = 'Keep studying! Use /buy for targeted study materials on this topic.';

  try {
    await ctx.telegram.sendMessage(
      chatId,
      `${emoji} *Quiz Complete!*\n\n` +
      `📊 *Score:* ${score}/${total} (${pct}%)\n` +
      `🎯 *Topic:* ${esc(session.topic)}\n\n` +
      `${feedback}\n\n` +
      `➡️ /quiz — try another topic\n` +
      `➡️ /buy — get study materials\n` +
      `➡️ /help — all commands`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    logger.error('[Quiz] sendFinalScore error:', err);
  }

  userSessions.delete(userId);
}