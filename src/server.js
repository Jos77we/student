import app from './app.js';
import { config } from './config/env.js';
import { connectDB, disconnectDB } from './config/database.js';
import { bot } from './bot/index.js';
import { logger, startupLog } from './utils/logger.js';
import { exec } from 'child_process';
import fs from 'fs';

const port = config.PORT || 3000;
const instanceId = Math.random().toString(36).substring(7);

// Function to detect NPort tunnel URL
async function detectTunnelUrl() {
  return new Promise((resolve) => {
    // Check if tunnel is already running
    exec('pm2 list | grep nport-tunnel', (error, stdout) => {
      if (!error && stdout.includes('online')) {
        // Try to get the URL from nport logs
        exec('pm2 logs nport-tunnel --lines 5 --nostream', (err, logOutput) => {
          const urlMatch = logOutput.match(/https:\/\/[^\s]+\.nport\.link/);
          if (urlMatch) {
            const tunnelUrl = urlMatch[0];
            process.env.SERVER_ORIGIN = tunnelUrl;
            process.env.FRONTEND_URL = tunnelUrl;
            logger.info('Tunnel URL detected:', tunnelUrl);
            resolve(tunnelUrl);
          } else {
            resolve(null);
          }
        });
      } else {
        resolve(null);
      }
    });
  });
}

// Suppress console logs
const _originalConsoleLog = console.log;
const _originalConsoleWarn = console.warn;
const _originalConsoleDebug = console.debug;

console.log = (...args) => logger.debug(args.join(' '));
console.warn = (...args) => logger.warn(args.join(' '));
console.debug = (...args) => logger.debug(args.join(' '));

async function start() {
  try {
    // Connect DB
    await connectDB();
    logger.info('MongoDB connected');

    // Start HTTP server
    let server;
    await new Promise((resolve) => {
      server = app.listen(port, '0.0.0.0', () => {
        logger.info('HTTP server started', { port });
        resolve();
      });
    });

    // Try to detect tunnel URL
    setTimeout(async () => {
      const tunnelUrl = await detectTunnelUrl();
      if (tunnelUrl) {
        _originalConsoleLog('');
        _originalConsoleLog(`  🌐  Tunnel URL: ${tunnelUrl}`);
        _originalConsoleLog('  ✅  Ready for external access');
      }
    }, 3000);

    // Print status
    _originalConsoleLog('');
    _originalConsoleLog('  ✅  MongoDB connected');
    _originalConsoleLog(`  ✅  HTTP server running on port ${port}`);
    _originalConsoleLog('  ⏳  Tunnel starting... (check pm2 logs)');
    _originalConsoleLog('');

    logger.info('Application started', { instanceId, port, env: config.NODE_ENV });

    // Graceful shutdown handler
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

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Launch bot
    bot.launch({ drop_pending_updates: true, allowedUpdates: [] })
      .then(() => {
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