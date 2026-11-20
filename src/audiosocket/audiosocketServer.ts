import net from 'node:net';
import { 
  AudioSocketConfig, 
  AudioSocketCallbacks, 
  AudioSocketSession, 
  AudioSocketMessageType 
} from './audiosocket.type';

export class AudioSocketServer {
  private server: net.Server | null = null;
  private config: AudioSocketConfig;
  private callbacks: AudioSocketCallbacks;
  private sessions: Map<string, AudioSocketSession> = new Map();

  constructor(config: AudioSocketConfig, callbacks: AudioSocketCallbacks = {}) {
    this.config = config;
    this.callbacks = callbacks;
  }

  /**
   * Menjalankan TCP Server untuk mendengarkan koneksi AudioSocket dari Asterisk
   */
  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket: net.Socket) => {
        this.handleNewConnection(socket);
      });

      this.server.on('error', (err: Error) => {
        console.error('[AudioSocket] Server error:', err.message);
        reject(err);
      });

      this.server.listen(this.config.port, this.config.host, () => {
        console.log(`[AudioSocket] Server listening on ${this.config.host}:${this.config.port}`);
        resolve();
      });
    });
  }

  /**
   * Menangani koneksi baru dari Asterisk
   */
  private handleNewConnection(socket: net.Socket): void {
    let buffer = Buffer.alloc(0);
    let session: AudioSocketSession = {
      id: `pending-${Date.now()}`,
      socket,
      createdAt: new Date()
    };

    const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[AudioSocket] Incoming connection from Asterisk: ${remoteAddr}`);

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      // Loop selama masih ada minimal 3 byte (1 byte Type + 2 byte Length)
      while (buffer.length >= 3) {
        const type = buffer.readUInt8(0);
        const payloadLength = buffer.readUInt16BE(1);

        // Jika data payload belum lengkap diterima, tunggu chunk berikutnya
        if (buffer.length < 3 + payloadLength) {
          break;
        }

        // Ambil payload dan buang pesan yang sudah selesai diproses dari buffer
        const payload = buffer.subarray(3, 3 + payloadLength);
        buffer = buffer.subarray(3 + payloadLength);

        this.processMessage(session, type, payload);
      }
    });

    socket.on('error', (err: Error) => {
      console.error(`[AudioSocket] Socket error for session [${session.id}]:`, err.message);
    });

    socket.on('close', (hadError: boolean) => {
      console.log(`[AudioSocket] Socket closed for session [${session.id}] (hadError: ${hadError})`);
      if (this.sessions.has(session.id)) {
        this.sessions.delete(session.id);
      }
      if (this.callbacks.onSessionEnd) {
        this.callbacks.onSessionEnd(session, 'Socket closed');
      }
    });
  }

  /**
   * Memproses tipe pesan AudioSocket
   */
  private processMessage(session: AudioSocketSession, type: number, payload: Buffer): void {
    switch (type) {
      case AudioSocketMessageType.UUID: {
        const uuidString = this.formatUuid(payload);
        session.id = uuidString;
        this.sessions.set(session.id, session);
        console.log(`[AudioSocket] Call UUID received: ${session.id}`);

        if (this.callbacks.onSessionStart) {
          this.callbacks.onSessionStart(session);
        }
        break;
      }

      case AudioSocketMessageType.AUDIO: {
        // Payload berisi Linear PCM 16-bit 8000Hz mono audio
        if (this.callbacks.onAudioData) {
          this.callbacks.onAudioData(session, payload);
        }
        break;
      }

      case AudioSocketMessageType.HANGUP: {
        console.log(`[AudioSocket] Hangup received from Asterisk for call: ${session.id}`);
        if (this.callbacks.onSessionEnd) {
          this.callbacks.onSessionEnd(session, 'Asterisk HANGUP');
        }
        session.socket.end();
        break;
      }

      case AudioSocketMessageType.ERROR: {
        console.error(`[AudioSocket] Error frame received from Asterisk for call: ${session.id}`);
        if (this.callbacks.onSessionEnd) {
          this.callbacks.onSessionEnd(session, 'Asterisk ERROR');
        }
        session.socket.destroy();
        break;
      }

      default:
        console.warn(`[AudioSocket] Unknown frame type: 0x${type.toString(16)} (Length: ${payload.length})`);
    }
  }

  /**
   * Mengubah 16 byte binary UUID menjadi string UUID standar (8-4-4-4-12)
   */
  private formatUuid(buf: Buffer): string {
    if (buf.length !== 16) {
      return buf.toString('hex');
    }
    const hex = buf.toString('hex');
    return [
      hex.substring(0, 8),
      hex.substring(8, 12),
      hex.substring(12, 16),
      hex.substring(16, 20),
      hex.substring(20, 32)
    ].join('-');
  }

  /**
   * Mengirimkan audio balik ke Asterisk (jika nanti dibutuhkan bot bersuara)
   */
  public sendAudio(session: AudioSocketSession, audioChunk: Buffer): void {
    if (!session.socket || session.socket.destroyed) return;

    const header = Buffer.alloc(3);
    header.writeUInt8(AudioSocketMessageType.AUDIO, 0);
    header.writeUInt16BE(audioChunk.length, 1);

    session.socket.write(Buffer.concat([header, audioChunk]));
  }

  /**
   * Mengirim sinyal Hangup ke Asterisk untuk memutus AudioSocket
   */
  public sendHangup(session: AudioSocketSession): void {
    if (!session.socket || session.socket.destroyed) return;

    const header = Buffer.alloc(3);
    header.writeUInt8(AudioSocketMessageType.HANGUP, 0);
    header.writeUInt16BE(0, 1);

    session.socket.write(header);
    session.socket.end();
  }

  /**
   * Menghentikan server
   */
  public stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const session of this.sessions.values()) {
        session.socket.destroy();
      }
      this.sessions.clear();

      if (this.server) {
        this.server.close(() => {
          console.log('[AudioSocket] Server stopped.');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}