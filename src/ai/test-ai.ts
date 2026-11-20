import { CONFIG } from '../config/config';
import { AiClient } from './aiClient';
import { VmStartMessage, RawVmMessage, AmdDecision } from './ai.type';

console.log('🚀 Memulai pengujian koneksi ke Server AI...');

const client = new AiClient(CONFIG.ai.wsUrl, {
  onStart: (data: VmStartMessage) => {
    console.log('✅ Handshake SUKSES!');
    console.log('Data diterima dari AI:', data);

    // Kirim dummy audio buffer 800 bytes (PCM 16-bit silence / no sound) untuk menguji pengiriman
    console.log('📤 Mengirim 1 chunk audio dummy (800 bytes silence)...');
    const silenceBuffer = Buffer.alloc(800);
    client.sendAudio(silenceBuffer);

    // Tutup koneksi setelah 3 detik pengujian berhasil
    setTimeout(() => {
      console.log('🧹 Menutup koneksi pengujian...');
      client.close();
      console.log('🎉 Tes selesai dengan sukses!');
      process.exit(0);
    }, 3000);
  },
  onDecision: (decision: AmdDecision | string, raw: RawVmMessage) => {
    console.log(`🤖 Keputusan AMD diterima: [${decision}]`, raw);
  },
  onError: (err: Error) => {
    console.error('❌ Terjadi error pada WebSocket:', err.message);
  },
  onClose: (code: number, reason: string) => {
    console.log(`🔌 Koneksi ditutup (code: ${code}, reason: ${reason})`);
  }
});

// Jalankan koneksi
client.connect();
