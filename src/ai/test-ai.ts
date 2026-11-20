
import dotenv from 'dotenv';
import { AiCLient } from './aiClient';
dotenv.config();

const wsUrl = process.env.AI_WS_URL;

if (!wsUrl) {
  console.error('❌ Error: AI_WS_URL belum diatur di file .env');
  process.exit(1);
}

console.log('🚀 Memulai pengujian koneksi ke Server AI...');

const client = new AiCLient(wsUrl, {
  onStart: (data) => {
    console.log('✅ Handshake SUKSES!');
    console.log('Data diterima dari AI:', data);

    // Kirim dummy audio buffer 800 bytes (PCM 16-bit silence / no sound) untuk menguji pengiriman
    console.log('📤 Mengirim 1 chunk audio dummy (800 bytes silence)...');
    const silenceBuffer = Buffer.alloc(800); // 800 bytes bernilai 0x00
    client.sendAudio(silenceBuffer);

    // Tutup koneksi setelah 3 detik pengujian berhasil
    setTimeout(() => {
      console.log('🧹 Menutup koneksi pengujian...');
      client.close();
      console.log('🎉 Tes selesai dengan sukses!');
      process.exit(0);
    }, 3000);
  },
  onDecision: (decision, raw) => {
    console.log(`🤖 Keputusan AMD diterima: [${decision}]`, raw);
  },
  onError: (err) => {
    console.error('❌ Terjadi error pada WebSocket:', err.message);
  },
  onClose: (code, reason) => {
    console.log(`🔌 Koneksi ditutup (code: ${code}, reason: ${reason})`);
  }
});

// Jalankan koneksi
client.connect();