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
      // ⚡ OPTIMASI LATENCY: Handler dibuat sinkron murni (0ms blocking)
      onSessionStart: (session: AudioSocketSession) => {
        const taskId = session.taskId;
        const taskIdStr = String(taskId);

        // Cek apakah channel sudah ada di cache sinkron
        const cachedChannel = this.taskToChannel.get(taskIdStr);
        const cachedDetails = cachedChannel ? this.channelDetails.get(cachedChannel) : undefined;

        // 1. BUKA SESI & WEBSOCKET AI INSTAN (0 ms) TANPA AWAIT
        const call = new CallSession(
          session,
          CONFIG.ai.wsUrl,
          this.ami,
          this.server,
          cachedChannel,
          cachedDetails?.uniqueid,
          (id: string) => this.sessions.delete(id)
        );
        this.sessions.set(session.id.toLowerCase(), call);

        // 2. JALANKAN PENCARIAN METADATA CHANNEL DI BACKGROUND (NON-BLOCKING)
        this.resolveChannelMetadataInBackground(call, taskId, cachedChannel, cachedDetails);
      },

      onAudioData: (session: AudioSocketSession, chunk: Buffer) => {
        const call = this.sessions.get(session.id.toLowerCase());
        call?.pushAudio(chunk);
      },

      onSessionEnd: (session: AudioSocketSession, reason?: string) => {
        const call = this.sessions.get(session.id.toLowerCase());
        if (call) {
          this.log.info(`🔌 AudioSocket Asterisk closed untuk Task #${call.taskId} (reason: ${reason || 'normal'})`);
          if (reason?.includes('HANGUP')) {
            call.handleCustomerHangup();
          } else {
            call.destroy(`Asterisk AudioSocket End (${reason || 'closed'})`);
          }
        }
      }
    });
  }

  /**
   * Resolusi nama channel dan nomor telepon secara asinkron di latar belakang
   * Streaming audio ke AI sudah berjalan paralel tanpa menunggu fungsi ini selesai.
   */
  private async resolveChannelMetadataInBackground(
    call: CallSession,
    taskId: number,
    cachedChannel?: string,
    cachedDetails?: ChannelMetadata
  ): Promise<void> {
    const taskIdStr = String(taskId);
    let channelName = cachedChannel;

    // Jika belum ada di cache, query via AMI Getvar CHAN_<task_id>
    if (!channelName && taskId > 0) {
      channelName = await this.ami.getVar(`CHAN_${taskId}`);
      if (channelName) {
        this.taskToChannel.set(taskIdStr, channelName);
        this.channelToTask.set(channelName, taskIdStr);
        call.channel = channelName;
        call.sendCallStatus('up');
      }
    }

    const details = channelName ? (this.channelDetails.get(channelName) || cachedDetails) : cachedDetails;
    if (details?.uniqueid && !call.uniqueid) {
      call.uniqueid = details.uniqueid;
    }

    // Ambil Phone Number nasabah dari dialplan jika belum ada
    let phone = details?.phoneNumber;
    if (!phone && channelName) {
      phone = await this.ami.getVar('PHONE_NUMBER', channelName);
      if (phone && details) {
        details.phoneNumber = phone;
      }
    }

    const callerId = details?.callerId || 'N/A';
    const phoneCustomer = phone || details?.exten || 'N/A';

    this.log.info(
      `📞 Call Connected -> Task #${taskId} | Channel: ${channelName || 'N/A'} | CallerID: ${callerId} | Phone: ${phoneCustomer}`
    );
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

    // 3. Customer menutup telepon di HP (Hangup / UserEvent: CustomerHangup)
    const isHangupEvent = ['hangup', 'softhanguprequest'].includes(eventName || '');
    const isCustomerHangupUserEvent = eventName === 'userevent' && String(raw.userevent || '').toLowerCase() === 'customerhangup';

    if ((isHangupEvent || isCustomerHangupUserEvent) && channel) {
      const taskIdStr = this.channelToTask.get(channel) || String(raw.taskid || '');
      const call = this.getCallSessionByChannelOrTask(channel, taskIdStr);
      if (call) {
        call.handleCustomerHangup();
      }

      if (taskIdStr) {
        this.log.info(`📴 Customer Hangup -> Task #${taskIdStr} (${channel})`);
        this.taskToChannel.delete(taskIdStr);
      }
      this.channelDetails.delete(channel);
      this.channelToTask.delete(channel);
    }
  }

  private getCallSessionByChannelOrTask(channel?: string, taskId?: string): CallSession | undefined {
    for (const session of this.sessions.values()) {
      if (channel && session.channel === channel) return session;
      if (taskId && String(session.taskId) === taskId) return session;
    }
    return undefined;
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
