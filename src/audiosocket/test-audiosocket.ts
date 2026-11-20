// src/audiosocket/test-audiosocket.ts
import net from 'node:net';
import crypto from 'node:crypto';
import { AudioSocketServer } from './audiosocketServer';
import { AudioSocketMessageType } from './audiosocket.type';

const TEST_PORT = 9099;
const TEST_HOST = '127.0.0.1';

console.log('🚀 Memulai pengujian AudioSocket Server & Binary Parser...');

// 1. Inisialisasi AudioSocket Server
const server = new AudioSocketServer(
  { host: TEST_HOST, port: TEST_PORT },
  {
    onSessionStart: (session) => {
      console.log(`✅ [Server] Sesi panggilan terdeteksi! UUID: ${session.id}`);
    },
    onAudioData: (session, chunk) => {
      console.log(`🎵 [Server] Chunk audio diterima dari [${session.id}] - Ukuran: ${chunk.length} bytes`);
    },
    onSessionEnd: (session, reason) => {
      console.log(`🔌 [Server] Sesi panggilan berakhir: [${session.id}] (Alasan: ${reason})`);
    }
  }
);

async function runTest() {
  await server.start();

  console.log('📡 [Simulasi Asterisk] Menghubungkan client Asterisk ke port 9099...');
  const client = net.createConnection({ host: TEST_HOST, port: TEST_PORT }, () => {
    console.log('🔗 [Simulasi Asterisk] Client tersambung.');

    // Step A: Kirim 16-byte UUID frame (Type 0x01)
    console.log('📤 [Simulasi Asterisk] Mengirim frame UUID (16 bytes)...');
    const randomUuidBytes = crypto.randomBytes(16);
    const uuidHeader = Buffer.alloc(3);
    uuidHeader.writeUInt8(AudioSocketMessageType.UUID, 0);
    uuidHeader.writeUInt16BE(16, 1);
    client.write(Buffer.concat([uuidHeader, randomUuidBytes]));

    // Step B: Setelah 500ms, kirim frame Audio 800 bytes PCM (Type 0x10)
    setTimeout(() => {
      console.log('📤 [Simulasi Asterisk] Mengirim frame Audio PCM (800 bytes)...');
      const audioPayload = Buffer.alloc(800, 0x55); // Dummy PCM audio
      const audioHeader = Buffer.alloc(3);
      audioHeader.writeUInt8(AudioSocketMessageType.AUDIO, 0);
      audioHeader.writeUInt16BE(800, 1);
      client.write(Buffer.concat([audioHeader, audioPayload]));
    }, 500);

    // Step C: Setelah 1.5 detik, kirim frame Hangup (Type 0x00)
    setTimeout(() => {
      console.log('📤 [Simulasi Asterisk] Mengirim frame Hangup...');
      const hangupHeader = Buffer.alloc(3);
      hangupHeader.writeUInt8(AudioSocketMessageType.HANGUP, 0);
      hangupHeader.writeUInt16BE(0, 1);
      client.write(hangupHeader);
      client.end();
    }, 1500);
  });

  // Step D: Selesai pengujian dan stop server setelah 3 detik
  setTimeout(async () => {
    console.log('🧹 [Test] Menghentikan AudioSocket Server...');
    await server.stop();
    console.log('🎉 Semua pengujian AudioSocket BERHASIL!');
    process.exit(0);
  }, 3000);
}

runTest().catch((err) => {
  console.error('❌ Error dalam pengujian:', err);
  process.exit(1);
});