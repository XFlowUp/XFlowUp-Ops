import { SQS } from '@aws-sdk/client-sqs';
import dotenv from 'dotenv';
import logger from '../../utils/logger';
import { DeploymentManager, DeploymentStatus } from '../deployment/deployment-manager';

dotenv.config();

export interface SQSMessage {
  messageId: string;
  message: any;
  date: string;
  MessageAttributes: {
    job: {
      DataType: string;
      StringValue: string;
    };
  };
}

export interface StatusUpdateMessage {
  serviceId: number | string;
  projectSlug: string;
  status: DeploymentStatus;
  error?: string;
  timestamp: string;
}

// Simple in-memory idempotency store (for demo; use Redis/DynamoDB for production)
const processedMessageIds = new Set<string>();

export class SQSConsumer {
  private sqs: SQS;
  private queueUrl: string;
  private deploymentManager: DeploymentManager;
  private isRunning: boolean = false;

  constructor() {
    const region = process.env.SQS_REGION || process.env.AWS_REGION;
    const accessKeyId = process.env.SQS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.SQS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;

    if (!region || !accessKeyId || !secretAccessKey) {
      throw new Error('Missing AWS SQS configuration');
    }

    this.sqs = new SQS({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    this.queueUrl = process.env.SQS_URL || '';
    if (!this.queueUrl) {
      throw new Error('Missing SQS queue URL');
    }

    this.deploymentManager = new DeploymentManager();
  }

  async start(): Promise<void> {
    this.isRunning = true;
    logger.info('Starting SQS consumer');

    while (this.isRunning) {
      try {
        await this.pollMessages();
      } catch (error) {
        logger.error(`Error polling messages: ${error}`);
        // Wait before retrying to avoid hammering the SQS service
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  stop(): void {
    this.isRunning = false;
    logger.info('Stopping SQS consumer');
  }

  private async pollMessages(): Promise<void> {
    const response = await this.sqs.receiveMessage({
      QueueUrl: this.queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 20, // Long polling
      VisibilityTimeout: 300, // Increase timeout to 5 minutes to allow for longer processing
    });

    if (response.Messages && response.Messages.length > 0) {
      for (const message of response.Messages) {
        try {
          await this.processMessage(message);
          // Always try to delete the message, even if processing fails
          await this.deleteMessage(message.ReceiptHandle!);
        } catch (error) {
          logger.error(`Error processing message: ${error}`);
          // Still try to delete the message to prevent reprocessing
          if (message.ReceiptHandle) {
            try {
              await this.deleteMessage(message.ReceiptHandle);
            } catch (deleteError) {
              logger.error(`Failed to delete message after processing error: ${deleteError}`);
            }
          }
        }
      }
    }
  }

  private async processMessage(message: any): Promise<void> {
    if (!message.Body) {
      logger.warn('Received message with no body');
      return;
    }

    try {
      // Log the raw message for debugging
      logger.info(`Raw SQS message: ${JSON.stringify(message)}`);

      const body: SQSMessage = JSON.parse(message.Body);
      const context = {
        messageId: body.messageId,
        serviceId: body.message?.serviceId,
        projectSlug: body.message?.projectSlug,
        jobType: body.MessageAttributes?.job?.StringValue
      };
      logger.info(`[context] Processing message`, context);

      // Idempotency check
      if (processedMessageIds.has(body.messageId)) {
        logger.warn(`[context] Duplicate message detected (idempotency): ${body.messageId}. Skipping.`, context);
        return;
      }
      processedMessageIds.add(body.messageId);
      // TODO: Use Redis/DynamoDB for distributed idempotency in production

      logger.info(`[context] Full message body: ${JSON.stringify(body)}`, context);
      logger.info(`[context] Message content: ${JSON.stringify(body.message)}`, context);

      // Check the job type
      const jobType = body.MessageAttributes?.job?.StringValue;

      if (jobType === 'deployment:product' || jobType === 'deployment:request' || jobType === 'deployment:production') {
        logger.info(`[context] Processing deployment request for job type: ${jobType}`, context);
        // TODO: metrics: increment deployment_received
        await this.deploymentManager.handleDeploymentRequest(body.message);
        // TODO: metrics: increment deployment_success
      } else if (jobType === 'deployment:test') {
        logger.info(`[context] Received test message: ${JSON.stringify(body.message)}`, context);
        logger.info(`[context] Test message processed successfully`, context);
      } else if (jobType === 'deployment:status-update') {
        await this.handleStatusUpdate(body.message);
      } else {
        logger.warn(`[context] Unknown job type: ${jobType}`, context);
      }
    } catch (error) {
      logger.error(`[context] Error parsing message body: ${error}`);
      // TODO: metrics: increment message_parse_failure
    }
  }

  private async handleStatusUpdate(message: StatusUpdateMessage): Promise<void> {
    try {
      // Log the full status update message
      logger.info(`Full status update message: ${JSON.stringify(message)}`);

      logger.info(`Processing deployment status update: ${message.status} for service ID: ${message.serviceId}`);

      // Here you can add code to update the deployment status in your database
      // For example, you might want to update a deployment record with the new status

      // For now, we'll just log the status update
      logger.info(`Deployment status updated to ${message.status} for service ID: ${message.serviceId}, project: ${message.projectSlug}`);

      // Log all properties of the message
      Object.entries(message).forEach(([key, value]) => {
        logger.info(`Status update property - ${key}: ${JSON.stringify(value)}`);
      });

      if (message.error) {
        logger.error(`Deployment error: ${message.error}`);
      }
    } catch (error) {
      logger.error(`Error handling status update: ${error}`);
      // Don't throw the error so we can still delete the message
    }
  }

  private async deleteMessage(receiptHandle: string): Promise<void> {
    try {
      await this.sqs.deleteMessage({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
      });
      logger.info(`Deleted message with receipt handle: ${receiptHandle}`);
    } catch (error) {
      logger.error(`Error deleting message from SQS: ${error}`);
      // Throw the error so the caller can handle it
      throw error;
    }
  }
}
