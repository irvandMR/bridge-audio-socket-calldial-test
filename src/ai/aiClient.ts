// src/ai/aiClient.ts
import WebSocket, { RawData } from 'ws';
import { 
  AiClientCallback, 
  VmStartMessage, 
  RawVmMessage,
  AmdDecision 
} from './ai.type';

export class AiClient {
  private ws: WebSocket | null = null;
  private baseUrl: string;
  private channelName?: string;
  private callbacks: AiClientCallback;
  private isConnected: boolean = false;
  private earlyQueue: Buffer[] = []; // Buffer penampung chunk audio selama TLS handshake

  constructor(
    baseUrl: string, 
    channelOrCallbacks?: string | AiClientCallback, 
    callbacks?: AiClientCallback
  ) {
    this.baseUrl = baseUrl;
    if (typeof channelOrCallbacks === 'string') {
      this.channelName = channelOrCallbacks;
      this.callbacks = callbacks || {};
    } else if (channelOrCallbacks && typeof channelOrCallbacks === 'object') {
      this.channelName = undefined;
      this.callbacks = channelOrCallbacks;
    } else {
      this.channelName = undefined;
      this.callbacks = callbacks || {};
    }
  }

  public getWsUrl(): string {
    return this.buildUrl();
  }

  private buildUrl(): string {
    let url = this.baseUrl;
    if (this.channelName && !url.includes('channel=')) {
      const sep = url.includes('?') ? '&' : '?';
      url += `${sep}channel=${encodeURIComponent(this.channelName)}`;
    }
    return url;
  }

  public connect(): void {
    if (this.ws) return;

    const fullUrl = this.buildUrl();
    const startTime = Date.now();

    // Optimasi WebSocket:
    // 1. perMessageDeflate: false -> matikan kompresi agar latensi 0 ms untuk PCM raw
    // 2. handshakeTimeout: 5000 -> fail cepat jika network down
    this.ws = new WebSocket(fullUrl, {
      perMessageDeflate: false,
      handshakeTimeout: 5000
    });

    // Pasang TCP_NODELAY seketika saat socket TCP TLS terbentuk
    this.ws.on('upgrade', (response) => {
      response.socket.setNoDelay(true);
    });

    this.ws.on('open', () => {
      this.isConnected = true;
      const durationMs = Date.now() - startTime;

      if (this.callbacks.onOpen) {
        this.callbacks.onOpen(fullUrl, durationMs);
      }

      // Flush semua audio yang sempat masuk saat handshake sedang berlangsung
      if (this.earlyQueue.length > 0) {
        for (const queuedChunk of this.earlyQueue) {
          this.ws?.send(queuedChunk, { binary: true });
        }
        this.earlyQueue = [];
      }
    });

    this.ws.on('message', (data: RawData, isBinary: boolean) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as any);

      // Deteksi cepat jika payload adalah format teks JSON ({ atau [)
      const firstByte = buf.length > 0 ? buf[0] : 0;
      const isJson = firstByte === 0x7B /* { */ || firstByte === 0x5B /* [ */;

      // Jika binary audio dari AI, forward langsung ke Asterisk AudioSocket (zero-latency)
      if (isBinary || (!isJson && buf.length > 0)) {
        if (this.callbacks.onAudio) {
          this.callbacks.onAudio(buf);
        }
        return;
      }

      this.handleIncomingMessage(data);
    });

    this.ws.on('error', (err: Error) => {
      if (this.callbacks.onError) {
        this.callbacks.onError(err);
      }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.isConnected = false;
      this.earlyQueue = [];
      if (this.callbacks.onClose) {
        this.callbacks.onClose(code, reason.toString('utf-8'));
      }
    });
  }

  /**
   * Mengirim audio ke AI secara real-time.
   * Jika socket masih dalam proses handshake, chunk otomatis ditampung agar kata pertama tidak hilang.
   */
  public sendAudio(audioChunk: Buffer): void {
    if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(audioChunk, { binary: true }, (err) => {
        if (err && this.callbacks.onError) {
          this.callbacks.onError(new Error(`Gagal mengirim audio ke WebSocket AI: ${err.message}`));
        }
      });
    } else if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      this.earlyQueue.push(audioChunk);
    }
  }

  public close(): void {
    if (this.ws) {
      try { this.ws.close(); } catch { }
      this.ws = null;
      this.isConnected = false;
      this.earlyQueue = [];
    }
  }

  public get ready(): boolean {
    return this.isConnected;
  }

  private handleIncomingMessage(rawData: RawData): void {
    try {
      const text = rawData.toString('utf-8');

      if (this.callbacks.onMessage) {
        this.callbacks.onMessage(text);
      }

      const msg: RawVmMessage = JSON.parse(text);
      const mType = String(msg.type || '').toLowerCase();
      const status = String(msg.status || '').toUpperCase();
      const label = String(msg.label || '').toUpperCase();
      const noAudio = msg.no_audio === true;

      if (mType === 'vm_start') {
        if (this.callbacks.onStart) {
          this.callbacks.onStart(msg as VmStartMessage);
        }
        return;
      }

      let decision: AmdDecision | null = null;
      if (status === 'HUMAN' || label === 'LIVE_HUMAN' || label === 'HUMAN') {
        decision = 'HUMAN';
      } else if (noAudio || label === 'NOTHING' || status === 'NOTHING') {
        decision = 'NOTHING';
      } else if (status === 'MACHINE' || label === 'VOICEMAIL' || label === 'MACHINE') {
        decision = 'MACHINE';
      }

      if (decision && this.callbacks.onDecision) {
        this.callbacks.onDecision(decision, msg);
      }
    } catch {
      // Abaikan jika non-JSON
    }
  }
}
