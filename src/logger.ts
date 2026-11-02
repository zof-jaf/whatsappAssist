import pino, { type Logger } from 'pino';

export type { Logger };

export interface LoggerOptions {
  level: string;
  pretty: boolean;
}

export function createLogger(options: LoggerOptions): Logger {
  return pino({
    level: options.level,
    base: { service: 'whatsapp-ai-bot' },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.x-api-key',
        'req.headers["x-api-key"]',
        'req.headers["x-webhook-hmac"]',
        'token',
        'apiKey',
      ],
      censor: '[REDACTED]',
    },
    transport: options.pretty
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname,service',
            singleLine: false,
          },
        }
      : undefined,
  });
}

export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
