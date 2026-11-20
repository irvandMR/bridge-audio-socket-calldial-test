
export type AmdDecision = 'HUMAN' | 'MACHINE' | 'NOTHING';

export interface VmStartMessage {
  type: 'vm_start';
  sr: number;
}

export interface RawVmMessage {
  type: 'raw_vm';
  prediction: AmdDecision | string;
  confidence?: number;
  [key: string]: any;
}

export type AiServerMessage = VmStartMessage | RawVmMessage;

export interface AiClientCallback {
  onStart?: (data: VmStartMessage) => void;
  onDecision?: (data: AmdDecision | string, raw: RawVmMessage) => void;
  onError?: (error: Error) => void;
  onClose?: (code: number, reason: string) => void;
}