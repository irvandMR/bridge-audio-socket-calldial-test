// src/ai/aiClient.ts
import WebSocket, { RawData } from 'ws';
import { 
  AiClientCallback, 
  AiServerMessage, 
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

  constructor(
    baseUrl: string, 
    channelOrCallbacks?: string | AiClientCallback, 
    callbacks?: AiClientCallback
  ) {
    this.baseUrl = baseUrl;
    if (typeof channelOrCallbacks === 'string') {
      this.channelName = channelOrCallbacks;
      this.callbacks = callbacks || {};
    } else {
      this.channelName = undefined;
      this.callbacks = channelOrCallbacks || {};
    }
  }

  private buildUrl(): string {
    const sep = this.baseUrl.includes('?') ? '&' : '?';
    let url = `${this.baseUrl}${sep}nc=0`;
    if (this.channelName) {
      url += `&channel=${encodeURIComponent(this.channelName)}`;
    }
    return url;
  }

  public connect(): void {
    if (this.ws) return;

    const fullUrl = this.buildUrl();
    this.ws = new WebSocket(fullUrl);

    this.ws.on('open', () => {
      this.isConnected = true;
    });

    this.ws.on('message', (data: RawData) => {
      this.handleIncomingMessage(data);
    });

    this.ws.on('error', (err: Error) => {
      if (this.callbacks.onError) {
        this.callbacks.onError(err);
      }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.isConnected = false;
      if (this.callbacks.onClose) {
        this.callbacks.onClose(code, reason.toString('utf-8'));
      }
    });
  }

  public sendAudio(audioChunk: Buffer): void {
    if (!this.ws || !this.isConnected || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(audioChunk, { binary: true });
  }

  public close(): void {
    if (this.ws) {
      try { this.ws.close(); } catch { }
      this.ws = null;
      this.isConnected = false;
    }
  }

  public get ready(): boolean {
    return this.isConnected;
  }

  private handleIncomingMessage(rawData: RawData): void {
    try {
      const text = rawData.toString('utf-8');
      const msg: RawVmMessage = JSON.parse(text);
      const mType = String(msg.type || '').toLowerCase();
      const status = String(msg.status || '').toUpperCase();
      const label = String(msg.label || '').toUpperCase();
      const noAudio = msg.no_audio === true;

      // 1. Handshake awal dari AI
      if (mType === 'vm_start') {
        if (this.callbacks.onStart) {
          this.callbacks.onStart(msg as VmStartMessage);
        }
        return;
      }

      // 2. Deteksi Utama AMD
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
      // Abaikan jika frame bukan JSON valid
    }
  }
}
