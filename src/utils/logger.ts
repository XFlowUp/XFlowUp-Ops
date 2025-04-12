import winston from 'winston';
import dotenv from 'dotenv';

dotenv.config();

const logLevel = process.env.LOG_LEVEL || 'info';

// Create a simple logger for tests
const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'xflowup-ops' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    })
  ],
});

// Only add file transports if not in test environment
if (process.env.NODE_ENV !== 'test') {
  try {
    // Create logs directory if needed
    const fs = require('fs');
    const path = require('path');
    const logsDir = 'logs';

    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    // Add file transports
    logger.add(new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error'
    }));

    logger.add(new winston.transports.File({
      filename: path.join(logsDir, 'combined.log')
    }));
  } catch (error) {
    console.warn(`Could not create file transports: ${error}`);
  }
}

export default logger;
