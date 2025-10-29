import pino from 'pino';

const isDevelopment = process.env.NODE_ENV !== 'production';

const baseOptions = {
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'headers.authorization',
      'OPENAI_API_KEY',
      'PAGE_ACCESS_TOKEN',
      // PII fields
      '*.phone',
      '*.email',
      '*.address'
    ],
    remove: true
  }
};

const prettyOptions = {
  ...baseOptions,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname',
      singleLine: false
    }
  }
};

export const logger = pino(isDevelopment ? prettyOptions : baseOptions);


