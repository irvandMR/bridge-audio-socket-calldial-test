import { BridgeService } from './bridge/bridgeService';

console.log('╔════════════════════════════════════════════════════════╗');
console.log('║       BRIDGE AUDIOSOCKET - AI CALLDIAL STARTING        ║');
console.log('╚════════════════════════════════════════════════════════╝');

const bridge = new BridgeService();

bridge.start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

// Graceful OS Shutdown
process.on('SIGINT', async () => {
  await bridge.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await bridge.stop();
  process.exit(0);
});
