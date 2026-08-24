// NamastePOS backend - Winston structured logger

const winston = require('winston');
const env = require('./env');

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

const devFmt = printf(({ level, message, timestamp: ts, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${ts} ${level} ${stack || message}${metaStr}`;
});

const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  format: env.isProd()
    ? combine(timestamp(), errors({ stack: true }), json())
    : combine(colorize(), timestamp({ format: 'HH:mm:ss' }), errors({ stack: true }), devFmt),
  transports: [new winston.transports.Console()],
  silent: env.isTest(),
});

module.exports = logger;
