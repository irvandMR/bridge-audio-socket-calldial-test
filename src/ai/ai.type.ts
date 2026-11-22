// src/ai/ai.type.ts

export type AmdDecision = 'HUMAN' | 'MACHINE' | 'NOTHING';

export interface VmStartMessage {
  type: 'vm_start';
  sr?: number;
}

export interface RawVmMessage {
  type?: string;
  status?: string;     // 'HUMAN' | 'MACHINE' | 'NOTHING'
  label?: string;      // 'LIVE_HUMAN' | 'VOICEMAIL' | 'HUMAN' | 'NOTHING'
  no_audio?: boolean;  // true -> silence / no audio
  confidence?: number | string;
  p_live_human?: number | string;
  p_voicemail?: number | string;
  [key: string]: any;
}

export type AiServerMessage = VmStartMessage | RawVmMessage;

export interface AiClientCallback {
  onOpen?: (url: string, durationMs: number) => void;
  onStart?: (data: VmStartMessage) => void;
  onAudio?: (audioChunk: Buffer) => void; // Binary PCM audio dari AI untuk diteruskan ke nasabah
  onDecision?: (decision: AmdDecision, raw: RawVmMessage) => void;
  onMessage?: (rawText: string) => void;
  onError?: (error: Error) => void;
  onClose?: (code: number, reason: string) => void;
}
