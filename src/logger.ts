import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: ['req.headers.authorization', 'headers.authorization', 'OPENAI_API_KEY', 'PAGE_ACCESS_TOKEN'],
    remove: true
  }
});


