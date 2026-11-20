// src/logger/logger.ts

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

// ANSI color codes untuk terminal & docker logs
const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
};

function formatTimestamp(): string {
  const now = new Date();
  const YYYY = now.getFullYear();
  const MM = String(now.getMonth() + 1).padStart(2, '0');
  const DD = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');

  return `${YYYY}-${MM}-${DD} ${hh}:${mm}:${ss}.${ms}`;
}

export class Logger {
  private tag: string;

  constructor(tag: string = 'System') {
    this.tag = tag;
  }

  private print(level: LogLevel, color: string, message: string, ...args: unknown[]): void {
    const time = `${COLORS.dim}[${formatTimestamp()}]${COLORS.reset}`;
    const levelStr = `${color}${COLORS.bold}[${level}]${COLORS.reset}`;
    const tagStr = `${COLORS.cyan}[${this.tag}]${COLORS.reset}`;

    if (args.length > 0) {
      console.log(`${time} ${levelStr} ${tagStr} ${message}`, ...args);
    } else {
      console.log(`${time} ${levelStr} ${tagStr} ${message}`);
    }
  }

  public info(message: string, ...args: unknown[]): void {
    this.print('INFO', COLORS.green, message, ...args);
  }

  public warn(message: string, ...args: unknown[]): void {
    this.print('WARN', COLORS.yellow, message, ...args);
  }

  public error(message: string, ...args: unknown[]): void {
    this.print('ERROR', COLORS.red, message, ...args);
  }

  public debug(message: string, ...args: unknown[]): void {
    this.print('DEBUG', COLORS.magenta, message, ...args);
  }

  /**
   * Membuat child logger dengan tag/modul spesifik (misal: Logger per Task ID atau per Modul)
   */
  public forModule(moduleName: string): Logger {
    return new Logger(moduleName);
  }
}

// Default export instance singleton
export const logger = new Logger('System');
