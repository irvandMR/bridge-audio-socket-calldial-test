// src/bridge/callSession.ts
import { AudioSocketSession } from '../audiosocket/audiosocket.type';
import { AiClient } from '../ai/aiClient';
import { AmiClient } from '../ami/amiClient';
import { AmdDecision, RawVmMessage } from '../ai/ai.type';
import { AudioSocketServer } from '../audiosocket/audiosocketServer';
import { Logger } from '../logger/logger';

const CHUNK_SIZE_INBOUND = 800; // 50ms @ 8kHz PCM 16-bit Mono

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
  private inboundBuffer = Buffer.alloc(0);
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

    // Buka sesi WebSocket AI INSTAN detik ini juga tanpa delay (0 ms blocking)
    this.aiClient = new AiClient(aiWsUrl, channel, {
      onDecision: (decision: AmdDecision, raw: RawVmMessage) => {
        this.handleAmdDecision(decision, raw);
      },
      onError: (err) => {
        this.log.warn(`AI Socket warning: ${err.message}`);
      },
      onClose: () => {
        this.destroy();
      }
    });

    this.aiClient.connect();
  }

  /**
   * Menerima audio dari Asterisk.
   * Langsung di-forward ke AiClient bahkan saat socket sedang proses TLS handshake (zero audio loss).
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

  private handleAmdDecision(decision: AmdDecision, raw: RawVmMessage): void {
    if (this.isDestroyed) return;

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

      // Tutup AudioSocket secara halus agar channel tetap hidup untuk dial agen
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

  public destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    this.aiClient.close();
    this.onEndCallback(this.uuid);
  }
}
