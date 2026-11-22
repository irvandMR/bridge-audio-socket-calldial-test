// src/bridge/callSession.ts
import { AudioSocketSession } from '../audiosocket/audiosocket.type';
import { AiClient } from '../ai/aiClient';
import { AmiClient } from '../ami/amiClient';
import { AmdDecision, RawVmMessage, VmStartMessage } from '../ai/ai.type';
import { AudioSocketServer } from '../audiosocket/audiosocketServer';
import { AudioResampler } from '../utils/audioResampler';
import { Logger } from '../logger/logger';

const AI_TIMEOUT_FALLBACK_MS = 10000; // 10 detik batas waktu respon AI sebelum fallback ke agen

export class CallSession {
  public readonly uuid: string;
  public readonly taskId: number;
  public channel?: string;
  public uniqueid?: string;
  public isCustomerHangup: boolean = false;

  private session: AudioSocketSession;
  private aiClient: AiClient;
  private ami: AmiClient;
  private server: AudioSocketServer;
  private onEndCallback: (uuid: string) => void;
  private isDestroyed: boolean = false;
  private hasDecided: boolean = false;
  private hasSpoken: boolean = false;
  private totalInboundBytes: number = 0;
  private totalOutboundBytes: number = 0;
  private outboundRemainder: Buffer = Buffer.alloc(0);
  private lastStreamLogTime: number = 0;
  private hasSentHangupStatus: boolean = false;
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
        // Batalkan timer koneksi setelah WebSocket berhasil terhubung & siap
        this.clearFallbackTimer();

        // 📢 Kirim status panggilan "up" agar server AI tahu panggilan sudah diangkat & langsung memutar greeting!
        this.sendCallStatus('up');
      },
      onStart: (data: VmStartMessage) => {
        this.log.info(`🤖 AI Ready (sr=${data.sr || 8000}Hz)`);
      },
      // 🔊 BIDIRECTIONAL: Alirkan suara dari bot AI (24kHz) -> di-convert ke 8kHz untuk Asterisk
      onAudio: (audioChunk: Buffer) => {
        if (this.isDestroyed) return;
        this.totalOutboundBytes += audioChunk.length;

        // Decimate 24000 Hz ke 8000 Hz (3 input samples = 6 bytes -> 1 output sample = 2 bytes)
        const full = Buffer.concat([this.outboundRemainder, audioChunk]);
        const remainderBytes = full.length % 6;
        const usableBytes = full.length - remainderBytes;

        if (usableBytes > 0) {
          const chunk24k = full.subarray(0, usableBytes);
          this.outboundRemainder = full.subarray(usableBytes);
          const chunk8k = AudioResampler.resample24kTo8k(chunk24k);

          if (!this.hasSpoken) {
            this.hasSpoken = true;
            this.log.info(`🔊 Suara AI diterima (${audioChunk.length} bytes @ 24kHz -> di-convert ke ${chunk8k.length} bytes @ 8kHz) -> Mengalirkan ke nasabah...`);
          }

          this.server.sendAudio(this.session, chunk8k);
        } else {
          this.outboundRemainder = full;
        }
      },
      onMessage: (rawText: string) => {
        this.log.info(`📩 Respon AI: ${rawText}`);
        this.handleCustomAiCommand(rawText);
      },
      onDecision: (decision: AmdDecision, raw: RawVmMessage) => {
        this.handleAmdDecision(decision, raw);
      },
      // 🛡️ LOG ERROR & AUTO-FALLBACK: HANYA saat terjadi error teknis/koneksi pada socket AI
      onError: (err: Error) => {
        if (!this.isCustomerHangup) {
          this.fallbackToAgent(`Socket AI error/unreachable: ${err.message}`);
        }
      },
      onClose: (_code: number, _reason: string) => {
        // Ketika socket AI ditutup (selesai bicara, nasabah tutup, atau AI selesai), tutup sesi normal
        this.destroy();
      }
    });

    this.log.info(`🌐 Membuka WebSocket ke AI: ${this.aiClient.getWsUrl()}`);
    this.aiClient.connect();

    // 🛡️ SAFETY TIMER: Hanya aktif untuk timeout koneksi awal (misal server AI mati/unresponsive)
    this.fallbackTimer = setTimeout(() => {
      if (!this.hasDecided && !this.isDestroyed && !this.hasSpoken) {
        this.fallbackToAgent(`Timeout ${AI_TIMEOUT_FALLBACK_MS / 1000}s koneksi ke AI`);
      }
    }, AI_TIMEOUT_FALLBACK_MS);
  }

  /**
   * Menerima audio 8000 Hz dari Asterisk -> di-convert ke 16000 Hz untuk server AI
   */
  public pushAudio(chunk: Buffer): void {
    if (this.isDestroyed) return;

    if (this.totalInboundBytes === 0) {
      this.log.info(`🎙️ Audio pertama dari Asterisk diterima (${chunk.length} bytes @ 8kHz -> di-convert ke 16kHz) -> Mengalirkan ke AI`);
    }

    this.totalInboundBytes += chunk.length;

    // Resample 8000 Hz ke 16000 Hz (1 sample = 2 bytes -> 2 samples = 4 bytes)
    const chunk16k = AudioResampler.resample8kTo16k(chunk);
    this.aiClient.sendAudio(chunk16k);

    const now = Date.now();
    if (now - this.lastStreamLogTime >= 3000) {
      this.lastStreamLogTime = now;
      const inSec = (this.totalInboundBytes / 16000).toFixed(1);
      const outSec = (this.totalOutboundBytes / 48000).toFixed(1); // 48000 bytes/detik @ 24kHz 16-bit
      this.log.info(`📊 Audio Stream -> Nasabah ke AI: ${this.totalInboundBytes} bytes (~${inSec}s) | AI ke Nasabah: ${this.totalOutboundBytes} bytes (~${outSec}s)`);
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
   * Menangani event JSON resmi dari AI sesuai spesifikasi Bot
   */
  private handleCustomAiCommand(rawText: string): void {
    try {
      const msg = JSON.parse(rawText);
      const mType = String(msg.type || '').toLowerCase();
      const action = String(msg.action || '').toLowerCase();
      const decision = String(msg.decision || '').toLowerCase();
      const status = String(msg.status || '').toLowerCase();
      const label = String(msg.label || '').toLowerCase();

      // 1. VOICEMAIL / MESIN OPERATOR DETECTED
      if (mType === 'raw_vm' && label === 'voicemail') {
        this.log.info(`📼 [DETEKSI] = VOICEMAIL! Mengakhiri panggilan...`);
        this.hasDecided = true;
        this.ami.sendUserEvent(this.taskId, 'MACHINE', 'VOICEMAIL_DETECTED', this.uniqueid || '', this.channel);
        this.server.closeSocket(this.session);
        if (this.channel) {
          this.ami.hangup(this.channel, 16);
        }
        this.destroy();
        return;
      }

      // 2. HUMAN DETECTED (Mulai ngobrol dengan bot - Bot melanjutkan percakapan)
      if (mType === 'raw_vm' && label === 'human') {
        this.log.info(`👤 [DETEKSI] = HUMAN! Bot melanjutkan percakapan...`);
        this.ami.sendUserEvent(this.taskId, 'HUMAN', 'HUMAN_DETECTED', this.uniqueid || '', this.channel);
        // Socket TIDAK ditutup agar percakapan dua arah terus berlanjut
        return;
      }

      // 3. ESKALASI KE AGEN MANUSIA
      if (action === 'transfer_agent' || decision === 'agent') {
        this.log.info(`👥 [DETEKSI] = TRANSFER AGENT! Mengalihkan ke Agen Manusia...`);
        this.hasDecided = true;
        this.ami.sendUserEvent(this.taskId, 'AGENT', 'TRANSFER_REQUESTED', this.uniqueid || '', this.channel);
        this.server.closeSocket(this.session);
        this.destroy();
        return;
      }

      // 4. PERCAKAPAN DENGAN BOT SELESAI
      if (action === 'hangup' || status === 'completed' || mType === 'bot_done') {
        this.log.info(`🏁 [DETEKSI] = PERCAKAPAN BOT TUNTAS! Menutup panggilan...`);
        this.hasDecided = true;
        this.ami.sendUserEvent(this.taskId, 'BOT_DONE', 'CONVERSATION_FINISHED', this.uniqueid || '', this.channel);
        this.server.closeSocket(this.session);
        if (this.channel) {
          this.ami.hangup(this.channel, 16);
        }
        this.destroy();
        return;
      }
    } catch {
      // Abaikan jika bukan format JSON
    }
  }

  /**
   * Mengirim event status panggilan (ringing, up, hangup) ke server AI
   */
  public sendCallStatus(status: 'ringing' | 'up' | 'hangup', cause?: string, reason?: string): void {
    if (status === 'hangup') {
      if (this.hasSentHangupStatus) return;
      this.hasSentHangupStatus = true;
    }

    const payload: Record<string, any> = {
      event: 'call_status',
      status,
      task_id: String(this.taskId),
      channel: this.channel || ''
    };

    if (status === 'hangup') {
      payload.cause = cause || '16';
      payload.reason = reason || 'Normal Clearing';
    }

    this.log.info(`📤 Mengirim call_status [${status}] ke AI: ${JSON.stringify(payload)}`);
    this.aiClient.sendJson(payload);
  }

  /**
   * Dipanggil saat nasabah menutup telepon di HP (Asterisk HANGUP)
   */
  public handleCustomerHangup(): void {
    if (this.isDestroyed || this.isCustomerHangup) return;
    this.isCustomerHangup = true;
    this.hasDecided = true;
    this.clearFallbackTimer();
    this.sendCallStatus('hangup', '16', 'Customer Hangup');
    this.log.info(`📴 Nasabah menutup telepon. Mengakhiri sesi tanpa dialihkan ke agen.`);
    this.destroy();
  }

  /**
   * 🛡️ MEKANISME FAIL-SAFE / GRACEFUL FALLBACK:
   * HANYA jika server AI mati, socket error teknis, atau timeout koneksi awal.
   * Jika nasabah yang menutup telepon, fungsi ini TIDAK AKAN berjalan.
   */
  private fallbackToAgent(reason: string): void {
    if (this.isDestroyed || this.hasDecided || this.isCustomerHangup) return;
    this.hasDecided = true;
    this.clearFallbackTimer();

    this.log.error(`❌ [AI FAILURE] ${reason}`);
    this.log.info(`👤 [AUTO-FALLBACK] Mengalihkan nasabah Task #${this.taskId} LANGSUNG ke Agen Manusia...`);

    // Kirim UserEvent AGENT agar calldial-server langsung memindahkan channel ke agen
    this.ami.sendUserEvent(
      this.taskId,
      'AGENT',
      `AI_DISCONNECTED_FALLBACK: ${reason}`,
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

    this.sendCallStatus('hangup', '16', 'Normal Clearing');
    this.aiClient.close();
    this.onEndCallback(this.uuid);
  }
}
