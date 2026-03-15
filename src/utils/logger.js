/**
 * Logger — structured file logging with Winston + daily rotation
 * ───────────────────────────────────────────────────────────────
 * Log files written to  logs/
 *   app-YYYY-MM-DD.log        all levels (debug+)      JSON
 *   error-YYYY-MM-DD.log      error only               JSON
 *   audit-YYYY-MM-DD.log      user session events      JSON  ← main monitoring file
 *
 * Console output: only startup / shutdown banners — nothing else.
 *
 * Usage:
 *   import { logger, audit } from './utils/logger.js';
 *
 *   logger.info('message', { meta })          — general application log
 *   logger.error('message', { err })          — errors
 *   logger.debug('message', { data })         — debug (suppressed in production)
 *
 *   audit(userId, event, data)                — user session audit trail
 *     e.g. audit('7049080106', 'quiz_started', { topic: 'Pharmacology' })
 *
 * Audit event names (use consistently):
 *   user_joined            new user created
 *   command_received       /start /buy /quiz /help
 *   message_received       any text message
 *   quiz_started           user began a quiz session
 *   quiz_question_sent     question delivered to user
 *   quiz_answer_received   user tapped A/B/C/D
 *   quiz_answer_correct    correct answer
 *   quiz_answer_wrong      wrong answer
 *   quiz_completed         all 15 questions answered
 *   quiz_error             error during question generation
 *   purchase_started       user initiated /buy flow
 *   purchase_promo_issued  promo code created in DB
 *   purchase_payment_open  user opened payment page
 *   purchase_verified      Flutterwave payment confirmed
 *   purchase_delivered     file sent to user
 *   purchase_error         error during purchase flow
 *   interject_question     user asked a side question mid-quiz
 *   interject_answered     side question answered
 *   session_error          unhandled error in a user session
 */

import winston             from 'winston';
import { createRequire }   from 'module';
import path                from 'path';
import { fileURLToPath }   from 'url';
import fs                  from 'fs';

// ── Paths ──────────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// logger lives at  src/utils/logger.js
// logs go to       <project-root>/logs/
const LOG_DIR   = path.join(__dirname, '..', '..', 'logs');

// Ensure logs directory exists
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ── DailyRotateFile (CJS module) ───────────────────────────────────────────────
const require       = createRequire(import.meta.url);
const DailyRotate   = require('winston-daily-rotate-file');

// ── Log format — clean JSON for files, human-readable for console ──────────────
const jsonFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// ── Rotating file transports ───────────────────────────────────────────────────
function makeRotatingFile(filename, level) {
  return new DailyRotate({
    filename:       path.join(LOG_DIR, `${filename}-%DATE%.log`),
    datePattern:    'YYYY-MM-DD',
    level,
    format:         jsonFormat,
    maxSize:        '20m',
    maxFiles:       '30d',      // keep 30 days
    zippedArchive:  true,
  });
}

// ── Main application logger ────────────────────────────────────────────────────
export const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  transports: [
    makeRotatingFile('app',   'debug'),    // all levels
    makeRotatingFile('error', 'error'),    // errors only

    // Console: only startup/shutdown — filter to a custom 'startup' level trick
    // We achieve "startup-only console" by logging console messages at a
    // special meta flag and suppressing everything else.
    new winston.transports.Console({
      level: 'info',
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, _startup }) => {
          // Only print to console if the message has the _startup flag
          if (!_startup) return '';
          return `${level}: ${message}`;
        })
      ),
    }),
  ],
});

// ── Separate audit logger (user session events) ────────────────────────────────
const auditLogger = winston.createLogger({
  level: 'info',
  transports: [
    makeRotatingFile('audit', 'info'),
  ],
});

/**
 * Write a structured user session audit event.
 *
 * @param {string} telegramId  — Telegram user ID (string)
 * @param {string} event       — event name from the list above
 * @param {object} [data]      — any extra fields relevant to the event
 */
export function audit(telegramId, event, data = {}) {
  auditLogger.info(event, {
    telegramId: String(telegramId),
    event,
    ts: new Date().toISOString(),
    ...data,
  });
}

/**
 * Convenience: log a startup banner to both console AND the app log file.
 * Use ONLY in server.js for the "server is running" messages.
 */
export function startupLog(message) {
  // File log (normal info level)
  logger.info(message);
  // Console (uses the _startup flag to pass through the console filter)
  logger.info(message, { _startup: true });
}