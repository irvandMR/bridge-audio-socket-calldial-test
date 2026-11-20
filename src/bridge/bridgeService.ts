import { CONFIG } from '../config/config';
import { AmiClient } from '../ami/amiClient';
import { AmiEvent } from '../ami/ami.type';
import { AudioSocketServer } from '../audiosocket/audiosocketServer';
import { AudioSocketSession } from '../audiosocket/audiosocket.type';
import { CallSession } from './callSession';

export class BridgeService {
  private ami: AmiClient;
  private server: AudioSocketServer;
  private sessions: Map<string, CallSession> = new Map<string, CallSession>();
  private uuidToChannel: Map<string, string> = new Map<string, string>();

  constructor() {
    this.ami = new AmiClient(CONFIG.ami, {
      onAuthenticated: () => console.log('[AMI] Authenticated to Asterisk PBX.'),
      onEvent: (event: AmiEvent) => this.handleAmiEvent(event),
      onError: (err: Error) => console.error('[AMI] Error:', err.message)
    });

    this.server = new AudioSocketServer(CONFIG.audioSocket, {
      onSessionStart: (session: AudioSocketSession) => {
        const uuid = session.id.toLowerCase();
        const channel = this.uuidToChannel.get(uuid);
        console.log(`\n📞 [Call Start] UUID: ${uuid} | Channel: ${channel || 'Unknown'}`);

        const call = new CallSession(
          session,
          CONFIG.ai.wsUrl,
          this.ami,
          this.server,
          channel,
          (id: string) => this.sessions.delete(id)
        );
        this.sessions.set(uuid, call);
      },

      onAudioData: (session: AudioSocketSession, chunk: Buffer) => {
        const call = this.sessions.get(session.id.toLowerCase());
        call?.pushAudio(chunk);
      },

      onSessionEnd: (session: AudioSocketSession, reason: string) => {
        console.log(`⏹️ [Call End] UUID: ${session.id} (${reason})`);
        const call = this.sessions.get(session.id.toLowerCase());
        call?.destroy();
      }
    });
  }

  private handleAmiEvent(event: AmiEvent): void {
    // Tangkap mapping AUDIOSOCKET_UUID dari dialplan
    if (event.event?.toLowerCase() === 'varset') {
      const varName = (event as Record<string, any>).variable;
      const varValue = (event as Record<string, any>).value;
      if (varName && varName.toUpperCase().includes('AUDIOSOCKET_UUID') && varValue && event.channel) {
        const uuid = String(varValue).trim().toLowerCase();
        this.uuidToChannel.set(uuid, event.channel);
        console.log(`[AMI] Mapped UUID [${uuid}] -> Channel [${event.channel}]`);
      }
    }

    // Bersihkan mapping jika channel hangup
    if (event.event?.toLowerCase() === 'hangup' && event.channel) {
      for (const [uuid, ch] of this.uuidToChannel.entries()) {
        if (ch === event.channel) {
          this.uuidToChannel.delete(uuid);
          break;
        }
      }
    }
  }

  public async start(): Promise<void> {
    this.ami.connect();
    await this.server.start();
    console.log('🚀 Bridge Voice Bot Service is Running & Ready!\n');
  }

  public async stop(): Promise<void> {
    console.log('🛑 Stopping Bridge Service...');
    for (const call of this.sessions.values()) {
      call.destroy();
    }
    this.sessions.clear();
    this.ami.disconnect();
    await this.server.stop();
  }
}
