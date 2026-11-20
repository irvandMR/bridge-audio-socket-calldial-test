import { AudioSocketSession } from '../audiosocket/audiosocket.type';
import { AiClient } from '../ai/aiClient';
import { AmiClient } from '../ami/amiClient';
import { AmdDecision, RawVmMessage, VmStartMessage } from '../ai/ai.type';
import { AudioSocketServer } from '../audiosocket/audiosocketServer';

export class CallSession {
  public readonly uuid: string;
  public channel?: string;

  private session: AudioSocketSession;
  private aiClient: AiClient;
  private ami: AmiClient;
  private server: AudioSocketServer;
  private onEndCallback: (uuid: string) => void;
  private isDestroyed: boolean = false;

  constructor(
    session: AudioSocketSession,
    aiWsUrl: string,
    ami: AmiClient,
    server: AudioSocketServer,
    channel: string | undefined,
    onEnd: (uuid: string) => void
  ) {
    this.uuid = session.id.toLowerCase();
    this.session = session;
    this.channel = channel;
    this.ami = ami;
    this.server = server;
    this.onEndCallback = onEnd;

    // Inisialisasi client AI khusus untuk panggilan ini
    this.aiClient = new AiClient(aiWsUrl, {
      onStart: (data: VmStartMessage) => console.log(`🤖 [AI][${this.uuid}] Ready. (SR: ${data.sr}Hz)`),
      onDecision: (decision: AmdDecision | string, raw: RawVmMessage) => this.handleAmdDecision(decision, raw),
      onError: (err: Error) => console.error(`❌ [AI][${this.uuid}] Error:`, err.message),
      onClose: (_code: number, _reason: string) => this.destroy()
    });

    this.aiClient.connect();
  }

  /**
   * Teruskan audio PCM dari Asterisk ke server AI
   */
  public pushAudio(chunk: Buffer): void {
    if (!this.isDestroyed && this.aiClient.ready) {
      this.aiClient.sendAudio(chunk);
    }
  }

  /**
   * Eksekusi keputusan AI (HUMAN / MACHINE / NOTHING)
   */
  private handleAmdDecision(decision: AmdDecision | string, raw: RawVmMessage): void {
    if (this.isDestroyed) return;

    const result = decision.toUpperCase();
    console.log(`🎯 [AMD Decision][${this.uuid}] Result: [${result}]`);

    // 1. Kirim UserEvent ke Asterisk Dialplan
    this.ami.sendUserEvent('AMDResult', {
      UUID: this.uuid,
      Channel: this.channel || 'Unknown',
      Result: result,
      Confidence: raw.confidence ?? 0
    });

    // 2. Tindakan Asterisk berdasarkan hasil AMD
    if (result === 'HUMAN') {
      console.log(`🙋 [HUMAN] Terdeteksi manusia! Tutup AudioSocket agar dialplan transfer ke agen.`);
      this.server.sendHangup(this.session);
    } else {
      console.log(`🤖 [${result}] Terdeteksi ${result}! Putus panggilan telepon.`);
      this.server.sendHangup(this.session);
      if (this.channel) {
        this.ami.hangup(this.channel, 16);
      }
    }

    this.destroy();
  }

  /**
   * Bersihkan koneksi dan memori sesi ini
   */
  public destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    this.aiClient.close();
    this.onEndCallback(this.uuid);
  }
}
