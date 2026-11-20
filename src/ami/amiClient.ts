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

  constructor(config: AmiConfig, callbacks: AmiClientCallbacks = {}) {
    this.config = config;
    this.callbacks = callbacks;
  }

  /**
   * Membuka koneksi TCP ke Asterisk AMI
   */
  public connect(): void {
    if (this.socket) return;

    this.shouldReconnect = true;
    console.log(`[AMI] Connecting to Asterisk at ${this.config.host}:${this.config.port}...`);

    this.socket = net.createConnection({
      host: this.config.host,
      port: this.config.port
    });

    this.socket.setEncoding('utf-8');

    this.socket.on('connect', () => {
      console.log('[AMI] TCP Socket connected. Waiting for Asterisk banner & authenticating...');
      if (this.callbacks.onConnect) {
        this.callbacks.onConnect();
      }
      this.login();
    });

    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.processBuffer();
    });

    this.socket.on('error', (err: Error) => {
      console.error('[AMI] Socket error:', err.message);
      if (this.callbacks.onError) {
        this.callbacks.onError(err);
      }
    });

    this.socket.on('close', (hadError: boolean) => {
      this.isAuthenticated = false;
      this.socket = null;
      console.log(`[AMI] Connection closed (hadError: ${hadError})`);
      
      if (this.callbacks.onClose) {
        this.callbacks.onClose(hadError);
      }

      if (this.shouldReconnect) {
        console.log('[AMI] Reconnecting in 5 seconds...');
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      }
    });
  }

  /**
   * Mengirim Action Login ke Asterisk AMI
   */
  private login(): void {
    this.sendAction('Login', {
      Username: this.config.user,
      Secret: this.config.secret,
      Events: 'on'
    });
  }

  /**
   * Mengirim generic Action ke Asterisk AMI
   */
  public sendAction(action: string, params: AmiActionParams = {}): void {
    if (!this.socket || this.socket.destroyed) {
      console.warn(`[AMI] Cannot send Action '${action}', socket is not connected.`);
      return;
    }

    let message = `Action: ${action}\r\n`;
    for (const [key, value] of Object.entries(params)) {
      message += `${key}: ${value}\r\n`;
    }
    message += '\r\n'; // AMI pesan diakhiri dengan baris kosong ganda

    this.socket.write(message);
  }

  /**
   * Mengirim UserEvent ke Dialplan Asterisk (misal hasil AMD: HUMAN / MACHINE)
   */
  public sendUserEvent(userEvent: string, params: AmiActionParams = {}): void {
    this.sendAction('UserEvent', {
      UserEvent: userEvent,
      ...params
    });
  }

  /**
   * Memutus (Hangup) channel panggilan telepon di Asterisk
   */
  public hangup(channel: string, cause: number = 16): void {
    this.sendAction('Hangup', {
      Channel: channel,
      Cause: cause
    });
  }

  /**
   * Memproses buffer teks masuk dan memecah pesan berdasarkan delimiter CRLF ganda
   */
  private processBuffer(): void {
    let delimiterIndex: number;

    // Setiap paket AMI selalu diakhiri dengan '\r\n\r\n'
    while ((delimiterIndex = this.buffer.indexOf('\r\n\r\n')) !== -1) {
      const rawPacket = this.buffer.substring(0, delimiterIndex);
      this.buffer = this.buffer.substring(delimiterIndex + 4);

      if (rawPacket.trim().length > 0) {
        this.handlePacket(rawPacket);
      }
    }
  }

  /**
   * Mem-parsing teks mentah menjadi key-value pairs
   */
  private handlePacket(rawPacket: string): void {
    // Abaikan banner pertama Asterisk (contoh: "Asterisk Call Manager/5.0.3")
    if (rawPacket.startsWith('Asterisk Call Manager/')) {
      return;
    }

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

    // Identifikasi apakah ini Response atau Event
    if (packetData.response) {
      this.handleResponse(packetData as unknown as AmiResponse);
    } else if (packetData.event) {
      this.handleEvent(packetData as unknown as AmiEvent);
    }
  }

  private handleResponse(res: AmiResponse): void {
    if (res.response.toLowerCase() === 'success') {
      if (!this.isAuthenticated) {
        this.isAuthenticated = true;
        console.log('[AMI] Authentication accepted! Ready to send commands.');
        if (this.callbacks.onAuthenticated) {
          this.callbacks.onAuthenticated();
        }
      }
    } else if (res.response.toLowerCase() === 'error') {
      console.error(`[AMI] Action error: ${res.message || 'Unknown error'}`);
    }
  }

  private handleEvent(event: AmiEvent): void {
    if (this.callbacks.onEvent) {
      this.callbacks.onEvent(event);
    }
  }

  /**
   * Menutup koneksi secara manual (tanpa auto-reconnect)
   */
  public disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.end();
      this.socket.destroy();
      this.socket = null;
    }
    this.isAuthenticated = false;
    console.log('[AMI] Disconnected manually.');
  }

  public get authenticated(): boolean {
    return this.isAuthenticated;
  }
}