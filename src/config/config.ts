import dotenv from 'dotenv';
dotenv.config();

function getEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`[Config Error] Missing required environment variable: "${key}" in .env`);
  }
  return value;
}

export const CONFIG = {
  // Protocol Constants
  AUDIOSOCKET_TYPE_HANGUP: 0x00,
  AUDIOSOCKET_TYPE_UUID: 0x01,
  AUDIOSOCKET_TYPE_AUDIO: 0x10,
  CHUNK_SIZE_INBOUND: 800,

  // Server & Client Configurations (Strict Type-Safe, No Hardcoded Fallback)
  audioSocket: {
    host: getEnv('AUDIOSOCKET_HOST'),
    port: parseInt(getEnv('AUDIOSOCKET_PORT'), 10),
  },
  ami: {
    host: getEnv('AMI_HOST'),
    port: parseInt(getEnv('AMI_PORT'), 10),
    user: getEnv('AMI_USER'),
    secret: getEnv('AMI_SECRET'),
  },
  ai: {
    wsUrl: getEnv('AI_WS_URL'),
  }
};