// src/index.ts
import { BridgeService } from './bridge/bridgeService';
import { logger } from './logger/logger';

logger.info('========================================================');
logger.info('       BRIDGE AUDIOSOCKET - AI VOICE BOT STARTING       ');
logger.info('========================================================');

const bridge = new BridgeService();

bridge.start().catch((err) => {
  logger.error('Fatal startup error:', err);
  process.exit(1);
});

// Graceful OS Shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT. Shutting down gracefully...');
  await bridge.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM. Shutting down gracefully...');
  await bridge.stop();
  process.exit(0);
});
