// src/bridge/bridgeService.ts
import { CONFIG } from '../config/config';
import { AmiClient } from '../ami/amiClient';
import { AmiEvent } from '../ami/ami.type';
import { AudioSocketServer } from '../audiosocket/audiosocketServer';
import { AudioSocketSession } from '../audiosocket/audiosocket.type';
import { CallSession } from './callSession';
import { Logger } from '../logger/logger';

interface ChannelMetadata {
  channel: string;
  callerId?: string;     // Nomor Trunk CallerID (misal: 6820112613461234)
  phoneNumber?: string;  // Nomor Tujuan / HP Nasabah (misal: 085771518294)
  exten?: string;
  state?: string;
  uniqueid?: string;
}

export class BridgeService {
  private ami: AmiClient;
  private server: AudioSocketServer;
  private sessions = new Map<string, CallSession>();
  private log = new Logger('Bridge');
  
  // Mapping Task ID & Channel
  private taskToChannel = new Map<string, string>();
  private channelToTask = new Map<string, string>();
  private channelDetails = new Map<string, ChannelMetadata>();

  constructor() {
    this.ami = new AmiClient(CONFIG.ami, {
      onEvent: (event: AmiEvent) => this.handleAmiEvent(event)
    });

    this.server = new AudioSocketServer(CONFIG.audioSocket, {
      onSessionStart: async (session: AudioSocketSession) => {
        const taskId = session.taskId;
        const taskIdStr = String(taskId);

        // Cari channel dari mapping atau query via AMI Getvar CHAN_<task_id>
        let channelName = this.taskToChannel.get(taskIdStr);
        if (!channelName && taskId > 0) {
          channelName = await this.ami.getVar(`CHAN_${taskId}`);
          if (channelName) {
            this.taskToChannel.set(taskIdStr, channelName);
            this.channelToTask.set(channelName, taskIdStr);
          }
        }

        const details = channelName ? this.channelDetails.get(channelName) : undefined;
        
        // Ambil Phone Number nasabah dari variabel dialplan PHONE_NUMBER jika belum ada
        let phone = details?.phoneNumber;
        if (!phone && channelName) {
          phone = await this.ami.getVar('PHONE_NUMBER', channelName);
          if (phone && details) {
            details.phoneNumber = phone;
          }
        }

        const callerId = details?.callerId || 'N/A';
        const phoneCustomer = phone || details?.exten || 'N/A';

        // Tampilkan Caller ID Trunk dan Nomor HP Nasabah secara terpisah
        this.log.info(
          `📞 Call Connected -> Task #${taskId} | Channel: ${channelName || 'N/A'} | CallerID: ${callerId} | Phone: ${phoneCustomer}`
        );

        const call = new CallSession(
          session,
          CONFIG.ai.wsUrl,
          this.ami,
          this.server,
          channelName,
          details?.uniqueid,
          (id: string) => this.sessions.delete(id)
        );
        this.sessions.set(session.id.toLowerCase(), call);
      },

      onAudioData: (session: AudioSocketSession, chunk: Buffer) => {
        const call = this.sessions.get(session.id.toLowerCase());
        call?.pushAudio(chunk);
      },

      onSessionEnd: (session: AudioSocketSession) => {
        const call = this.sessions.get(session.id.toLowerCase());
        call?.destroy();
      }
    });
  }

  private handleAmiEvent(event: AmiEvent): void {
    const raw = event as Record<string, any>;
    const eventName = event.event?.toLowerCase();
    const channel = event.channel;

    // 1. Simpan metadata nomor & state panggilan
    if (['newchannel', 'newcallerid', 'newstate', 'dialbegin'].includes(eventName || '')) {
      if (channel) {
        const existing = this.channelDetails.get(channel) || { channel };
        existing.callerId = raw.calleridnum || raw.connectedlinenum || existing.callerId;
        existing.exten = raw.exten || raw.dialstring || existing.exten;
        existing.state = raw.channelstatedesc || existing.state;
        existing.uniqueid = raw.uniqueid || existing.uniqueid;
        this.channelDetails.set(channel, existing);
      }
    }

    // 2. Tangkap variabel TASK_ID, CHAN_<id>, dan PHONE_NUMBER dari Asterisk Dialplan
    if (eventName === 'varset') {
      const varName = String(raw.variable || '').toUpperCase();
      const val = String(raw.value || '').trim();

      if (channel && val && val !== '(null)') {
        const existing = this.channelDetails.get(channel) || { channel };

        if (varName === 'TASK_ID' || varName === 'TASKID') {
          this.taskToChannel.set(val, channel);
          this.channelToTask.set(channel, val);
        } else if (varName.startsWith('CHAN_')) {
          const tid = varName.split('_')[1];
          if (tid) {
            this.taskToChannel.set(tid, val);
            this.channelToTask.set(val, tid);
          }
        } else if (varName === 'PHONE_NUMBER' || varName === 'PHONE') {
          existing.phoneNumber = val;
          this.channelDetails.set(channel, existing);
        }
      }
    }

    // 3. Customer menutup telepon di HP
    if (['hangup', 'softhanguprequest'].includes(eventName || '') && channel) {
      const taskIdStr = this.channelToTask.get(channel);
      if (taskIdStr) {
        this.log.info(`📴 Customer Hangup -> Task #${taskIdStr} (${channel})`);
      }
      this.channelDetails.delete(channel);
      if (taskIdStr) {
        this.taskToChannel.delete(taskIdStr);
        this.channelToTask.delete(channel);
      }
    }
  }

  public async start(): Promise<void> {
    this.ami.connect();
    await this.server.start();
    this.log.info('🚀 Bridge Service is running & ready for calls!');
  }

  public async stop(): Promise<void> {
    this.log.info('Stopping Bridge Service...');
    for (const call of this.sessions.values()) {
      call.destroy();
    }
    this.sessions.clear();
    this.ami.disconnect();
    await this.server.stop();
  }
}
