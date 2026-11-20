
export interface AmiConfig {
  host: string;
  port: number;
  user: string;
  secret: string;
}

export type AmiActionParams = Record<string, string | number>;

export interface AmiResponse {
  response: string; // 'Success' | 'Error'
  message?: string;
  [key: string]: string | undefined;
}

export interface AmiEvent {
  event: string;
  channel?: string;
  uniqueid?: string;
  [key: string]: string | undefined;
}

export interface AmiClientCallbacks {
  onConnect?: () => void;
  onAuthenticated?: () => void;
  onEvent?: (event: AmiEvent) => void;
  onError?: (err: Error) => void;
  onClose?: (hadError: boolean) => void;
}   