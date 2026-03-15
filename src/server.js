import app                  from './app.js';
import { config }           from './config/env.js';
import { connectDB, disconnectDB } from './config/database.js';
import { bot }              from './bot/index.js';
import { logger, startupLog } from './utils/logger.js';

const port       = config.PORT || 3000;
const instanceId = Math.random().toString(36).substring(7);

// ── Suppress all console.log/warn/debug — everything goes to log files ─────────
// Only console.error is kept for truly fatal pre-logger failures.
const _originalConsoleLog   = console.log;
const _originalConsoleWarn  = console.warn;
const _originalConsoleDebug = console.debug;

console.log   = (...args) => logger.debug(args.join(' '));
console.warn  = (...args) => logger.warn(args.join(' '));
console.debug = (...args) => logger.debug(args.join(' '));
// console.error stays as-is (fatal issues before logger is ready)

async function start() {
  try {
    // ── Connect DB ────────────────────────────────────────────────────────────
    await connectDB();
    logger.info('MongoDB connected');

    // ── Start HTTP server ─────────────────────────────────────────────────────
    let server;
    await new Promise((resolve) => {
      server = app.listen(port, () => {
        logger.info('HTTP server started', { port });
        resolve();
      });
    });

    // ── Print clean status to console ────────────────────────────────────────
    _originalConsoleLog('');
    _originalConsoleLog('  ✅  MongoDB connected');
    _originalConsoleLog('  ✅  HTTP server running');

    logger.info('Application started', { instanceId, port, env: config.NODE_ENV });

    // ── Graceful shutdown handler (register before bot launch) ────────────────
    const shutdown = async (signal) => {
      _originalConsoleLog('\n  🛑  Shutting down...');
      logger.info('Shutdown initiated', { signal });
      try {
        await bot.stop(signal);
        logger.info('Bot stopped');
      } catch (e) {
        logger.warn('Error stopping bot', { err: e.message });
      }
      server.close(async () => {
        await disconnectDB();
        logger.info('Server closed, DB disconnected');
        _originalConsoleLog('  👋  Goodbye.\n');
        process.exit(0);
      });
    };

    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // ── Launch bot — do NOT await: polling mode never resolves ────────────────
    bot.launch({ drop_pending_updates: true, allowedUpdates: [] })
      .then(() => {
        // This line is only reached if polling somehow ends cleanly
        logger.info('Telegram bot polling ended');
      })
      .catch((err) => {
        if (err.message?.includes('Conflict: terminated by other getUpdates request')) {
          logger.error('Bot conflict — another instance is already running');
          _originalConsoleLog('\n  ❌  Another bot instance is already running. Stop it first.\n');
          process.exit(1);
        }
        logger.error('Bot launch failed', { err: err.message });
        _originalConsoleLog(`\n  ❌  Telegram failed to connect: ${err.message}\n`);
      });

    // Bot starts polling in the background — confirm after a short delay
    setTimeout(() => {
      _originalConsoleLog('  ✅  Telegram bot connected');
      _originalConsoleLog('  📁  Logs → logs/');
      _originalConsoleLog('');
    }, 1500);

  } catch (err) {
    logger.error('Startup failed', { err: err.message, stack: err.stack });
    _originalConsoleLog(`\n  ❌  Startup failed: ${err.message}\n`);
    process.exit(1);
  }
}

start();