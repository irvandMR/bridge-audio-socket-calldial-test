// src/ami/amiClient.ts
import net from 'node:net';
import { 
  AmiConfig, 
  AmiClientCallbacks, 
  AmiResponse, 
  AmiEvent, 
  AmiActionParams 
} from './ami.type';

export class AmiClient {
  private socket: net.Socket | null = null;
  private config: AmiConfig;
  private callbacks: AmiClientCallbacks;
  
  private buffer: string = '';
  private isAuthenticated: boolean = false;
  private shouldReconnect: boolean = true;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private actionResolvers = new Map<string, (response: AmiResponse) => void>();

  constructor(config: AmiConfig, callbacks: AmiClientCallbacks = {}) {
    this.config = config;
    this.callbacks = callbacks;
  }

  public connect(): void {
    if (this.socket) return;

    this.shouldReconnect = true;

    this.socket = net.createConnection({
      host: this.config.host,
      port: this.config.port
    });

    this.socket.setEncoding('utf-8');

    this.socket.on('connect', () => {
      this.login();
    });

    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.processBuffer();
    });

    this.socket.on('error', (err: Error) => {
      if (this.callbacks.onError) {
        this.callbacks.onError(err);
      }
    });

    this.socket.on('close', (hadError: boolean) => {
      this.isAuthenticated = false;
      this.socket = null;
      if (this.callbacks.onClose) {
        this.callbacks.onClose(hadError);
      }
      if (this.shouldReconnect) {
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      }
    });
  }

  private login(): void {
    this.sendAction('Login', {
      Username: this.config.user,
      Secret: this.config.secret,
      Events: 'on'
    });
  }

  public sendAction(action: string, params: AmiActionParams = {}): void {
    if (!this.socket || this.socket.destroyed) return;

    let message = `Action: ${action}\r\n`;
    for (const [key, value] of Object.entries(params)) {
      message += `${key}: ${value}\r\n`;
    }
    message += '\r\n';

    this.socket.write(message);
  }

  /**
   * Mengirim UserEvent AMDResult ke Asterisk AMI agar ditangkap oleh Node.js userevent.js
   * - Mode 'ai': kirim tanpa Channel agar Asterisk tidak me-redirect channel nasabah.
   * - Mode 'agent': sertakan Channel agar dialer memindahkan channel ke agen manusia.
   */
  public sendUserEvent(taskId: number, result: string, cause: string = '', channel?: string): void {
    const params: AmiActionParams = {
      UserEvent: 'AMDResult',
      taskid: taskId,
      result: result,
      cause: cause
    };
    if (channel) {
      params.Channel = channel;
    }
    this.sendAction('UserEvent', params);
  }

  public hangup(channel: string, cause: number = 16): void {
    this.sendAction('Hangup', {
      Channel: channel,
      Cause: cause
    });
  }

  /**
   * Mengambil nilai variabel Asterisk via AMI (Action: Getvar)
   */
  public getVar(variable: string, channel?: string): Promise<string> {
    return new Promise((resolve) => {
      const actionId = `var_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const params: AmiActionParams = {
        ActionID: actionId,
        Variable: variable
      };
      if (channel) {
        params.Channel = channel;
      }

      const timer = setTimeout(() => {
        this.actionResolvers.delete(actionId);
        resolve('');
      }, 1000);

      this.actionResolvers.set(actionId, (res) => {
        clearTimeout(timer);
        this.actionResolvers.delete(actionId);
        const val = res.value || '';
        resolve(val === '(null)' ? '' : val);
      });

      this.sendAction('Getvar', params);
    });
  }

  private processBuffer(): void {
    if (this.buffer.startsWith('Asterisk Call Manager/')) {
      const bannerEndIdx = this.buffer.indexOf('\r\n');
      if (bannerEndIdx !== -1) {
        this.buffer = this.buffer.substring(bannerEndIdx + 2);
      } else {
        return;
      }
    }

    let delimiterIndex: number;
    while ((delimiterIndex = this.buffer.indexOf('\r\n\r\n')) !== -1) {
      const rawPacket = this.buffer.substring(0, delimiterIndex);
      this.buffer = this.buffer.substring(delimiterIndex + 4);

      if (rawPacket.trim().length > 0) {
        this.handlePacket(rawPacket);
      }
    }
  }

  private handlePacket(rawPacket: string): void {
    const lines = rawPacket.split('\r\n');
    const packetData: Record<string, string> = {};

    for (const line of lines) {
      const separatorIdx = line.indexOf(':');
      if (separatorIdx !== -1) {
        const key = line.substring(0, separatorIdx).trim().toLowerCase();
        const value = line.substring(separatorIdx + 1).trim();
        packetData[key] = value;
      }
    }

    if (packetData.response) {
      const res = packetData as unknown as AmiResponse;
      if (res.actionid && this.actionResolvers.has(res.actionid)) {
        this.actionResolvers.get(res.actionid)!(res);
      }
      this.handleResponse(res);
    } else if (packetData.event) {
      this.handleEvent(packetData as unknown as AmiEvent);
    }
  }

  private handleResponse(res: AmiResponse): void {
    if (res.response.toLowerCase() === 'success') {
      if (!this.isAuthenticated) {
        this.isAuthenticated = true;
        console.log('✅ [AMI] Terhubung & Terautentikasi ke Asterisk PBX!');
        if (this.callbacks.onAuthenticated) {
          this.callbacks.onAuthenticated();
        }
      }
    }
  }

  private handleEvent(event: AmiEvent): void {
    if (this.callbacks.onEvent) {
      this.callbacks.onEvent(event);
    }
  }

  public disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.isAuthenticated = false;
  }
}
