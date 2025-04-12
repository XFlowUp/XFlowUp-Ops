import dotenv from 'dotenv';
import { SQSConsumer } from './services/sqs/sqs-consumer';
import { CloudWatchService } from './services/aws/cloudwatch-service';
import logger from './utils/logger';
import fs from 'fs';
import path from 'path';

// Load environment variables
dotenv.config();

// Ensure temp directory exists
const tempDir = process.env.TEMP_REPO_DIR || './tmp/repos';
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
  logger.info(`Created temporary directory: ${tempDir}`);
}

// Ensure logs directory exists
if (!fs.existsSync('logs')) {
  fs.mkdirSync('logs');
  logger.info('Created logs directory');
}

async function startApplication() {
  try {
    logger.info('Starting XFlowUp-Ops application');

    // Initialize CloudWatch service
    try {
      const cloudWatchService = new CloudWatchService();
      await cloudWatchService.initialize();
      logger.info('CloudWatch service initialized successfully');
    } catch (error) {
      logger.warn(`CloudWatch service initialization failed: ${error}. Continuing without CloudWatch logging.`);
    }

    // Start SQS consumer
    const sqsConsumer = new SQSConsumer();
    await sqsConsumer.start();

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT signal, shutting down...');
      sqsConsumer.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM signal, shutting down...');
      sqsConsumer.stop();
      process.exit(0);
    });

    logger.info('XFlowUp-Ops application started successfully');
  } catch (error) {
    logger.error(`Failed to start application: ${error}`);
    process.exit(1);
  }
}

// Start the application
startApplication();
