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
  public outboundResponse: 'agent' | 'ai' = 'agent';

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
  private hasSentHumanEvent: boolean = false;
  private fallbackTimer: NodeJS.Timeout | null = null;
  private log: Logger;

  constructor(
    session: AudioSocketSession,
    aiWsUrl: string,
    ami: AmiClient,
    server: AudioSocketServer,
    channel: string | undefined,
    uniqueid: string | undefined,
    onEnd: (uuid: string) => void,
    outboundResponse: 'agent' | 'ai' = 'agent'
  ) {
    this.uuid = session.id.toLowerCase();
    this.taskId = session.taskId;
    this.session = session;
    this.channel = channel;
    this.uniqueid = uniqueid;
    this.outboundResponse = outboundResponse;
    this.ami = ami;
    this.server = server;
    this.onEndCallback = onEnd;
    this.log = new Logger(`Call #${this.taskId}`);

    // Buka sesi WebSocket AI INSTAN (0 ms)
    this.aiClient = new AiClient(
      aiWsUrl, 
      channel, 
      {
        onOpen: (url: string, durationMs: number) => {
          this.log.info(`⚡ Terhubung ke AI (${durationMs}ms) [Mode: ${this.outboundResponse.toUpperCase()}] -> ${url}`);
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
        onClose: (code: number, reason: string) => {
          this.log.info(`🔌 WebSocket AI closed (code: ${code}, reason: ${reason || 'normal'})`);
          this.destroy(`WebSocket AI closed (${code})`);
        }
      },
      this.outboundResponse
    );

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

  public setOutboundResponse(response: 'agent' | 'ai'): void {
    if (this.outboundResponse !== response) {
      this.log.info(`🔄 Update OUTBOUND_RESPONSE: ${this.outboundResponse} -> ${response}`);
      this.outboundResponse = response;
      this.aiClient.setOutboundResponse(response);
    }
  }

  /**
   * Eksekusi keputusan resmi dari AI
   */
  private handleAmdDecision(decision: AmdDecision, raw: RawVmMessage): void {
    if (this.isDestroyed || this.hasDecided) return;
    this.clearFallbackTimer();

    const conf = raw.confidence || raw.p_live_human || raw.p_voicemail || '';
    const confStr = conf ? ` (conf: ${conf})` : '';

    if (decision === 'HUMAN') {
      if (!this.hasSentHumanEvent) {
        this.hasSentHumanEvent = true;
        this.log.info(`👤 [DETEKSI] = HUMAN${confStr}! Mode: ${this.outboundResponse.toUpperCase()}`);

        if (this.outboundResponse === 'agent') {
          // MODE AGENT: Transfer nasabah ke agen manusia melalui dialer Asterisk
          this.log.info(`👥 [MODE AGENT] Menghubungkan nasabah ke Agen Manusia...`);
          this.hasDecided = true;
          this.ami.sendUserEvent(this.taskId, 'HUMAN', `HUMAN_DETECTED${confStr}`, this.channel);
          this.server.closeSocket(this.session);
          this.destroy('Transferred to Human Agent');
          return;
        } else {
          // MODE AI: Pure AI Voicebot - nasabah mengobrol penuh dengan bot AI
          this.log.info(`🤖 [MODE AI] Nasabah terhubung dengan Pure AI Bot. Melanjutkan percakapan dua arah...`);
          // Format payload AMI tanpa Channel agar Asterisk tidak me-redirect / menutup channel audio
          this.ami.sendUserEvent(this.taskId, 'HUMAN', `HUMAN_DETECTED${confStr}`);
          // PENTING: Socket & channel Asterisk TIDAK ditutup agar bot AI terus berbicara dua arah
          return;
        }
      }
      return;
    } else if (decision === 'NOTHING') {
      this.hasDecided = true;
      this.log.info(`🔇 Result: NOTHING (Silence) -> Terminating call.`);
      this.ami.sendUserEvent(this.taskId, 'NOTHING', 'NO_AUDIO_DETECTED');
      this.server.closeSocket(this.session);
      if (this.channel) {
        this.ami.hangup(this.channel, 16);
      }
    } else if (decision === 'MACHINE') {
      this.hasDecided = true;
      this.log.info(`📼 Result: MACHINE / VOICEMAIL${confStr} -> Terminating call.`);
      this.ami.sendUserEvent(this.taskId, 'MACHINE', `VOICEMAIL_DETECTED${confStr}`);
      this.server.closeSocket(this.session);
      if (this.channel) {
        this.ami.hangup(this.channel, 16);
      }
    }

    this.destroy('AMD Decision');
  }

  /**
   * Menangani event JSON resmi dari AI sesuai spesifikasi Bot
   */
  private handleCustomAiCommand(rawText: string): void {
    try {
      const msg = JSON.parse(rawText);
      const mType = String(msg.type || '').toLowerCase();
      const action = String(msg.action || msg.Action || '').toLowerCase();
      const decision = String(msg.decision || '').toLowerCase();
      const status = String(msg.status || '').toLowerCase();
      const botStatus = String(msg.bot_status || '').toLowerCase();
      const label = String(msg.label || '').toLowerCase();

      // 1. VOICEMAIL / MESIN OPERATOR DETECTED
      if (mType === 'raw_vm' && (label === 'voicemail' || status === 'machine')) {
        this.log.info(`📼 [DETEKSI] = VOICEMAIL! Mengakhiri panggilan...`);
        this.hasDecided = true;
        this.clearFallbackTimer();
        this.ami.sendUserEvent(this.taskId, 'MACHINE', 'VOICEMAIL_DETECTED');
        this.server.closeSocket(this.session);
        if (this.channel) {
          this.ami.hangup(this.channel, 16);
        }
        this.destroy('Voicemail Detected');
        return;
      }

      // 2. HUMAN DETECTED (Mulai ngobrol dengan bot - cek mode agent vs ai)
      if (mType === 'raw_vm' && (label === 'human' || label === 'live_human' || status === 'human')) {
        if (!this.hasSentHumanEvent) {
          this.hasSentHumanEvent = true;
          this.log.info(`👤 [DETEKSI] = HUMAN! Mode: ${this.outboundResponse.toUpperCase()}`);

          if (this.outboundResponse === 'agent') {
            this.log.info(`👥 [MODE AGENT] Menghubungkan nasabah ke Agen Manusia...`);
            this.hasDecided = true;
            this.clearFallbackTimer();
            this.ami.sendUserEvent(this.taskId, 'HUMAN', 'HUMAN_DETECTED', this.channel);
            this.server.closeSocket(this.session);
            this.destroy('Transferred to Human Agent');
            return;
          } else {
            this.log.info(`🤖 [MODE AI] Nasabah terhubung dengan Pure AI Bot. Melanjutkan percakapan dua arah...`);
            this.ami.sendUserEvent(this.taskId, 'HUMAN', 'HUMAN_DETECTED');
            return;
          }
        }
        // Socket TIDAK ditutup agar percakapan dua arah terus berlanjut
        return;
      }

      // 3. ESKALASI KE AGEN MANUSIA
      if (action === 'transfer_agent' || decision === 'agent') {
        this.log.info(`👥 [DETEKSI] = TRANSFER AGENT! Mengalihkan ke Agen Manusia...`);
        this.hasDecided = true;
        this.clearFallbackTimer();
        this.ami.sendUserEvent(this.taskId, 'AGENT', 'TRANSFER_REQUESTED');
        this.server.closeSocket(this.session);
        this.destroy('Transfer Agent Requested');
        return;
      }

      // 4. PERCAKAPAN DENGAN BOT SELESAI (hangup, terminate, task_completed, bot_done)
      const isHangupAction = action === 'hangup' || action === 'terminate';
      const isCompletedStatus = status === 'completed' || botStatus === 'task_completed';
      const isBotDoneType = mType === 'bot_done';

      if (isHangupAction || isCompletedStatus || isBotDoneType) {
        const trigger = action || botStatus || mType;
        this.log.info(`🏁 [DETEKSI] = PERCAKAPAN BOT TUNTAS (${trigger})! Menutup panggilan nasabah...`);
        this.hasDecided = true;
        this.clearFallbackTimer();
        this.ami.sendUserEvent(this.taskId, 'BOT_DONE', 'CONVERSATION_FINISHED');
        this.server.closeSocket(this.session);
        if (this.channel) {
          this.ami.hangup(this.channel, 16);
        }
        this.destroy(`Bot Finished (${trigger})`);
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
      channel: this.channel || '',
      outbound_response: this.outboundResponse
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
    this.log.info(`📴 Nasabah menutup telepon (Asterisk HANGUP).`);
    this.destroy('Customer Hangup');
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

    // Kirim UserEvent AGENT DENGAN Channel agar calldial-server langsung memindahkan channel ke agen
    this.ami.sendUserEvent(
      this.taskId,
      'AGENT',
      `AI_DISCONNECTED_FALLBACK: ${reason}`,
      this.channel
    );

    // Tutup socket audio agar Asterisk melepaskan channel untuk di-redirect ke agen
    this.server.closeSocket(this.session);
    this.destroy('Fallback to Agent');
  }

  private clearFallbackTimer(): void {
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  public destroy(source: string = 'internal'): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.clearFallbackTimer();

    this.log.info(`🛑 Sesi dihentikan [Penyebab: ${source}]`);
    this.sendCallStatus('hangup', '16', source);

    // 1. Tutup koneksi audio TCP AudioSocket ke Asterisk
    this.server.closeSocket(this.session);

    // 2. Kirim perintah Hangup ke Asterisk AMI HANYA jika panggilan memang selesai / hangup
    // JANGAN hangup channel jika sesi berakhir karena transfer ke agen manusia!
    const isTransferToAgent = source.toLowerCase().includes('agent');
    if (this.channel && !this.isCustomerHangup && !isTransferToAgent) {
      this.ami.hangup(this.channel, 16);
    }

    // 3. Tutup WebSocket AI
    this.aiClient.close();
    this.onEndCallback(this.uuid);
  }
}
