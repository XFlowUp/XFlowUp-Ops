import {
  CloudWatchLogs,
  CreateLogGroupCommand,
  DescribeLogGroupsCommand,
  PutLogEventsCommand
} from '@aws-sdk/client-cloudwatch-logs';
import dotenv from 'dotenv';
import logger from '../../utils/logger';

dotenv.config();

export class CloudWatchService {
  private cloudWatchLogs: CloudWatchLogs;
  private logGroupName: string;

  constructor() {
    const region = process.env.AWS_REGION;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

    if (!region || !accessKeyId || !secretAccessKey) {
      throw new Error('Missing AWS configuration');
    }

    this.cloudWatchLogs = new CloudWatchLogs({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    this.logGroupName = process.env.AWS_CLOUDWATCH_LOG_GROUP || '';
    if (!this.logGroupName) {
      throw new Error('Missing CloudWatch log group name');
    }
  }

  async initialize(): Promise<void> {
    try {
      await this.ensureLogGroupExists();
    } catch (error) {
      logger.error(`Failed to initialize CloudWatch service: ${error}`);
      throw error;
    }
  }

  async logDeploymentEvent(
    serviceName: string,
    message: string,
    logStreamName?: string
  ): Promise<void> {
    try {
      const streamName = logStreamName || `${serviceName}-${Date.now()}`;
      
      await this.putLogEvent(streamName, message);
      
      logger.debug(`Logged deployment event to CloudWatch: ${message}`);
    } catch (error) {
      logger.error(`Failed to log deployment event: ${error}`);
    }
  }

  private async ensureLogGroupExists(): Promise<void> {
    try {
      // Check if log group exists
      const response = await this.cloudWatchLogs.send(
        new DescribeLogGroupsCommand({
          logGroupNamePrefix: this.logGroupName,
        })
      );

      const logGroupExists = response.logGroups?.some(
        (group) => group.logGroupName === this.logGroupName
      );

      if (!logGroupExists) {
        // Create log group if it doesn't exist
        await this.cloudWatchLogs.send(
          new CreateLogGroupCommand({
            logGroupName: this.logGroupName,
          })
        );
        logger.info(`Created CloudWatch log group: ${this.logGroupName}`);
      }
    } catch (error) {
      logger.error(`Error ensuring log group exists: ${error}`);
      throw error;
    }
  }

  private async putLogEvent(logStreamName: string, message: string): Promise<void> {
    try {
      await this.cloudWatchLogs.send(
        new PutLogEventsCommand({
          logGroupName: this.logGroupName,
          logStreamName,
          logEvents: [
            {
              timestamp: Date.now(),
              message,
            },
          ],
        })
      );
    } catch (error: any) {
      // If the log stream doesn't exist, CloudWatch will create it automatically
      // when we try to put log events, but we might need to retry
      if (error.name === 'ResourceNotFoundException') {
        logger.info(`Log stream ${logStreamName} not found, retrying...`);
        
        // Wait a moment for the log stream to be created
        await new Promise((resolve) => setTimeout(resolve, 1000));
        
        // Retry putting the log event
        await this.cloudWatchLogs.send(
          new PutLogEventsCommand({
            logGroupName: this.logGroupName,
            logStreamName,
            logEvents: [
              {
                timestamp: Date.now(),
                message,
              },
            ],
          })
        );
      } else {
        throw error;
      }
    }
  }
}
