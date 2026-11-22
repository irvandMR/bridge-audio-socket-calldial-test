// src/bridge/callSession.ts
import { AudioSocketSession } from '../audiosocket/audiosocket.type';
import { AiClient } from '../ai/aiClient';
import { AmiClient } from '../ami/amiClient';
import { AmdDecision, RawVmMessage, VmStartMessage } from '../ai/ai.type';
import { AudioSocketServer } from '../audiosocket/audiosocketServer';
import { Logger } from '../logger/logger';

const CHUNK_SIZE_INBOUND = 800; // 50ms @ 8kHz PCM 16-bit Mono
const AI_TIMEOUT_FALLBACK_MS = 10000; // 10 detik batas waktu respon AI sebelum fallback ke agen

export class CallSession {
  public readonly uuid: string;
  public readonly taskId: number;
  public channel?: string;
  public uniqueid?: string;

  private session: AudioSocketSession;
  private aiClient: AiClient;
  private ami: AmiClient;
  private server: AudioSocketServer;
  private onEndCallback: (uuid: string) => void;
  private isDestroyed: boolean = false;
  private hasDecided: boolean = false;
  private inboundBuffer = Buffer.alloc(0);
  private fallbackTimer: NodeJS.Timeout | null = null;
  private log: Logger;

  constructor(
    session: AudioSocketSession,
    aiWsUrl: string,
    ami: AmiClient,
    server: AudioSocketServer,
    channel: string | undefined,
    uniqueid: string | undefined,
    onEnd: (uuid: string) => void
  ) {
    this.uuid = session.id.toLowerCase();
    this.taskId = session.taskId;
    this.session = session;
    this.channel = channel;
    this.uniqueid = uniqueid;
    this.ami = ami;
    this.server = server;
    this.onEndCallback = onEnd;
    this.log = new Logger(`Call #${this.taskId}`);

    // Buka sesi WebSocket AI INSTAN (0 ms)
    this.aiClient = new AiClient(aiWsUrl, channel, {
      onOpen: (url: string, durationMs: number) => {
        this.log.info(`⚡ Terhubung ke AI (${durationMs}ms) -> ${url}`);
      },
      onStart: (data: VmStartMessage) => {
        this.log.info(`🤖 AI Ready (sr=${data.sr || 8000}Hz)`);
      },
      onDecision: (decision: AmdDecision, raw: RawVmMessage) => {
        this.handleAmdDecision(decision, raw);
      },
      // 🛡️ LOG ERROR & AUTO-FALLBACK: Jika socket AI gagal/mati, alihkan langsung ke agen manusia!
      onError: (err: Error) => {
        this.fallbackToAgent(`Socket AI error/unreachable: ${err.message}`);
      },
      onClose: (code: number, reason: string) => {
        if (!this.hasDecided) {
          this.fallbackToAgent(`Socket AI tertutup prematur (code ${code}: ${reason || 'connection dropped'})`);
        } else {
          this.destroy();
        }
      }
    });

    this.log.info(`🌐 Membuka WebSocket ke AI: ${this.aiClient.getWsUrl()}`);
    this.aiClient.connect();

    // 🛡️ SAFETY TIMER: Jika dalam 10 detik AI tidak merespon/macet, langsung transfer ke agen
    this.fallbackTimer = setTimeout(() => {
      if (!this.hasDecided && !this.isDestroyed) {
        this.fallbackToAgent(`Timeout ${AI_TIMEOUT_FALLBACK_MS / 1000}s menunggu respon AI`);
      }
    }, AI_TIMEOUT_FALLBACK_MS);
  }

  /**
   * Menerima audio dari Asterisk dan diteruskan ke AiClient
   */
  public pushAudio(chunk: Buffer): void {
    if (this.isDestroyed) return;

    this.inboundBuffer = Buffer.concat([this.inboundBuffer, chunk]);

    while (this.inboundBuffer.length >= CHUNK_SIZE_INBOUND && !this.isDestroyed) {
      const audioChunk = this.inboundBuffer.subarray(0, CHUNK_SIZE_INBOUND);
      this.inboundBuffer = this.inboundBuffer.subarray(CHUNK_SIZE_INBOUND);
      this.aiClient.sendAudio(audioChunk);
    }
  }

  /**
   * Eksekusi keputusan resmi dari AI
   */
  private handleAmdDecision(decision: AmdDecision, raw: RawVmMessage): void {
    if (this.isDestroyed || this.hasDecided) return;
    this.hasDecided = true;
    this.clearFallbackTimer();

    const conf = raw.confidence || raw.p_live_human || raw.p_voicemail || '';
    const confStr = conf ? ` (conf: ${conf})` : '';

    if (decision === 'HUMAN') {
      this.log.info(`👤 Result: HUMAN${confStr} -> Transferring to human agent.`);
      
      this.ami.sendUserEvent(
        this.taskId, 
        'HUMAN', 
        `HUMAN_DETECTED${confStr}`, 
        this.uniqueid || '', 
        this.channel
      );

      this.server.closeSocket(this.session);
    } else if (decision === 'NOTHING') {
      this.log.info(`🔇 Result: NOTHING (Silence) -> Terminating call.`);
      this.ami.sendUserEvent(
        this.taskId, 
        'NOTHING', 
        'NO_AUDIO_DETECTED', 
        this.uniqueid || '', 
        this.channel
      );
      this.server.closeSocket(this.session);
      if (this.channel) {
        this.ami.hangup(this.channel, 16);
      }
    } else if (decision === 'MACHINE') {
      this.log.info(`📼 Result: MACHINE / VOICEMAIL${confStr} -> Terminating call.`);
      this.ami.sendUserEvent(
        this.taskId, 
        'MACHINE', 
        `VOICEMAIL_DETECTED${confStr}`, 
        this.uniqueid || '', 
        this.channel
      );
      this.server.closeSocket(this.session);
      if (this.channel) {
        this.ami.hangup(this.channel, 16);
      }
    }

    this.destroy();
  }

  /**
   * 🛡️ MEKANISME FAIL-SAFE / GRACEFUL FALLBACK:
   * Jika server AI mati, socket error, atau timeout, nasabah TIDAK dimatikan.
   * Melainkan langsung ditransfer ke agen manusia dengan log error yang jelas!
   */
  private fallbackToAgent(reason: string): void {
    if (this.isDestroyed || this.hasDecided) return;
    this.hasDecided = true;
    this.clearFallbackTimer();

    this.log.error(`❌ [AI FAILURE] ${reason}`);
    this.log.info(`👤 [AUTO-FALLBACK] Mengalihkan nasabah Task #${this.taskId} LANGSUNG ke Agen Manusia...`);

    // Kirim UserEvent HUMAN agar calldial-server langsung memindahkan channel ke agen
    this.ami.sendUserEvent(
      this.taskId,
      'HUMAN',
      `FALLBACK_TRANSFER: ${reason}`,
      this.uniqueid || '',
      this.channel
    );

    // Tutup socket audio agar Asterisk melepaskan channel untuk di-redirect ke agen
    this.server.closeSocket(this.session);
    this.destroy();
  }

  private clearFallbackTimer(): void {
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  public destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.clearFallbackTimer();

    this.aiClient.close();
    this.onEndCallback(this.uuid);
  }
}
