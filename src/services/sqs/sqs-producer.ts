import { SQS } from '@aws-sdk/client-sqs';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger';

dotenv.config();

export class SQSProducer {
  private sqs: SQS;
  private queueUrl: string;
  private isFifo: boolean;

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

    this.isFifo = process.env.SQS_IS_FIFO === 'true';
  }

  async sendMessage(message: any, jobType: string, messageGroupId: string = 'general', overrideQueueUrl?: string): Promise<string> {
    const messageId = uuidv4();
    const sqsMessage: any = {
      QueueUrl: overrideQueueUrl || this.queueUrl,
      MessageBody: JSON.stringify({
        messageId,
        message,
        date: new Date().toISOString(),
        MessageAttributes: {
          job: {
            DataType: 'String',
            StringValue: jobType,
          },
        },
      }),
    };
    if (this.isFifo) {
      sqsMessage.MessageGroupId = messageGroupId;
      sqsMessage.MessageDeduplicationId = messageId;
    }
    try {
      const result = await this.sqs.sendMessage(sqsMessage);
      logger.info(`Message sent to SQS: ${messageId}, job: ${jobType}`);
      return messageId;
    } catch (error) {
      logger.error(`Failed to send message to SQS: ${error}`);
      throw error;
    }
  }
}
