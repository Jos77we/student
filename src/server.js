import app from './app.js';
import { config } from './config/env.js';
import { connectDB, disconnectDB } from './config/database.js';
import { bot } from './bot/index.js';
import { logger } from './utils/logger.js';

const port = config.PORT || 3000;

// Prevent multiple instances
const instanceId = Math.random().toString(36).substring(7);
logger.info(`Starting application instance: ${instanceId}`);

async function start() {
  try {
    await connectDB();

    const server = app.listen(port, () => {
      logger.info(`✅ HTTP server listening on port ${port}`);
    });

    // Launch bot with drop_pending_updates to clean any pending updates
    try {
      await bot.launch({ 
        drop_pending_updates: true,
        allowedUpdates: []
      });
      logger.info('🤖 Telegram bot launched (polling mode)');
    } catch (err) {
      if (err.message.includes('Conflict: terminated by other getUpdates request')) {
        logger.error('❌ Another bot instance is already running. Please stop it first.');
        process.exit(1);
      }
      logger.error('Failed to launch bot', err);
    }

    // graceful shutdown
    const shutdown = async (signal) => {
      logger.info(`🛑 ${signal} received, shutting down gracefully...`);
      try {
        await bot.stop(signal);
        logger.info('🤖 Bot stopped');
      } catch (e) {
        logger.warn('Error stopping bot', e);
      }
      server.close(async () => {
        await disconnectDB();
        logger.info('✅ HTTP server closed, DB disconnected. Exiting.');
        process.exit(0);
      });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    logger.error('Startup failed', err);
    process.exit(1);
  }
}

start();