// src/audiosocket/audiosocketServer.ts
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

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket: net.Socket) => {
        // TCP_NODELAY untuk pengiriman real-time tanpa buffer delay
        socket.setNoDelay(true);
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

  private handleNewConnection(socket: net.Socket): void {
    let buffer = Buffer.alloc(0);
    let session: AudioSocketSession = {
      id: `pending-${Date.now()}`,
      taskId: 0,
      socket,
      createdAt: new Date()
    };

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 3) {
        const type = buffer.readUInt8(0);
        const payloadLength = buffer.readUInt16BE(1);

        if (buffer.length < 3 + payloadLength) {
          break;
        }

        const payload = buffer.subarray(3, 3 + payloadLength);
        buffer = buffer.subarray(3 + payloadLength);

        this.processMessage(session, type, payload);
      }
    });

    socket.on('error', () => {
      // Diamkan error saat soket diputus normal
    });

    socket.on('close', () => {
      if (this.sessions.has(session.id)) {
        this.sessions.delete(session.id);
      }
      if (this.callbacks.onSessionEnd) {
        this.callbacks.onSessionEnd(session, 'Socket closed');
      }
    });
  }

  private processMessage(session: AudioSocketSession, type: number, payload: Buffer): void {
    switch (type) {
      case AudioSocketMessageType.UUID: {
        session.id = this.formatUuid(payload);
        
        // Ekstrak Task ID dari 6 byte terakhir (sesuai int.from_bytes(call_uuid_bytes[10:], "big"))
        if (payload.length >= 16) {
          session.taskId = parseInt(payload.subarray(10).toString('hex'), 16);
        }

        this.sessions.set(session.id, session);

        if (this.callbacks.onSessionStart) {
          this.callbacks.onSessionStart(session);
        }
        break;
      }

      case AudioSocketMessageType.AUDIO: {
        if (this.callbacks.onAudioData) {
          this.callbacks.onAudioData(session, payload);
        }
        break;
      }

      case AudioSocketMessageType.HANGUP: {
        if (this.callbacks.onSessionEnd) {
          this.callbacks.onSessionEnd(session, 'Asterisk HANGUP');
        }
        this.closeSocket(session);
        break;
      }

      case AudioSocketMessageType.ERROR: {
        if (this.callbacks.onSessionEnd) {
          this.callbacks.onSessionEnd(session, 'Asterisk ERROR');
        }
        this.closeSocket(session);
        break;
      }
    }
  }

  private formatUuid(buf: Buffer): string {
    if (buf.length !== 16) return buf.toString('hex');
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
   * Mengirim audio dari AI (outbound) ke Asterisk agar terdengar oleh nasabah.
   * Format AudioSocket: Type 0x10 (1 byte) + Length (2 bytes Big-Endian) + PCM payload
   */
  public sendAudio(session: AudioSocketSession, chunk: Buffer): void {
    if (!session.socket || session.socket.destroyed || !session.socket.writable) return;

    // Standar frame Asterisk: 320 bytes (20ms @ 8kHz 16-bit mono)
    const MAX_CHUNK = 320;
    let offset = 0;
    while (offset < chunk.length) {
      const sliceSize = Math.min(chunk.length - offset, MAX_CHUNK);
      const subChunk = chunk.subarray(offset, offset + sliceSize);
      offset += sliceSize;

      const frame = Buffer.allocUnsafe(3 + subChunk.length);
      frame.writeUInt8(AudioSocketMessageType.AUDIO, 0); // 0x10
      frame.writeUInt16BE(subChunk.length, 1);
      subChunk.copy(frame, 3);

      session.socket.write(frame);
    }
  }

  /**
   * Menutup socket audio secara halus TANPA mengirim paket biner 0x00
   * (agar Asterisk app_audiosocket tidak menganggapnya crash/error)
   */
  public closeSocket(session: AudioSocketSession): void {
    if (!session.socket || session.socket.destroyed) return;
    try {
      session.socket.end();
      session.socket.destroy();
    } catch {
      // Ignore
    }
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const session of this.sessions.values()) {
        this.closeSocket(session);
      }
      this.sessions.clear();
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
