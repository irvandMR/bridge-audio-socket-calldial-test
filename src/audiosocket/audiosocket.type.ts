import net from 'node:net';

export enum AudioSocketMessageType {
  HANGUP = 0x00,
  UUID = 0x01,
  AUDIO = 0x10,
  ERROR = 0xff,
}

export interface AudioSocketConfig {
  host: string;
  port: number;
}

export interface AudioSocketSession {
  id: string; // UUID panggilan dari Asterisk
  socket: net.Socket;
  createdAt: Date;
}

export interface AudioSocketCallbacks {
  onSessionStart?: (session: AudioSocketSession) => void;
  onAudioData?: (session: AudioSocketSession, chunk: Buffer) => void;
  onSessionEnd?: (session: AudioSocketSession, reason: string) => void;
}