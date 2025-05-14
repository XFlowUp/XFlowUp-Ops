import {
  CloudWatchLogs,
  CreateLogGroupCommand,
  DescribeLogGroupsCommand,
  CreateLogStreamCommand,
  PutLogEventsCommand
} from '@aws-sdk/client-cloudwatch-logs';
import dotenv from 'dotenv';
import logger from '../../utils/logger';

dotenv.config();

export class CloudWatchStreamLogger {
  private cloudWatchLogs: CloudWatchLogs;
  private logGroupName: string;
  private logStreamName: string;
  private sequenceToken?: string;

  constructor(logGroupName: string, logStreamName: string) {
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
    this.logGroupName = logGroupName;
    this.logStreamName = logStreamName;
  }

  async init(): Promise<void> {
    // Ensure log group exists
    await this.ensureLogGroupExists();
    // Ensure log stream exists
    await this.ensureLogStreamExists();
  }

  private async ensureLogGroupExists(): Promise<void> {
    const response = await this.cloudWatchLogs.send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: this.logGroupName })
    );
    const exists = response.logGroups?.some(g => g.logGroupName === this.logGroupName);
    if (!exists) {
      await this.cloudWatchLogs.send(new CreateLogGroupCommand({ logGroupName: this.logGroupName }));
      logger.info(`Created CloudWatch log group: ${this.logGroupName}`);
    }
  }

  private async ensureLogStreamExists(): Promise<void> {
    try {
      await this.cloudWatchLogs.send(new CreateLogStreamCommand({
        logGroupName: this.logGroupName,
        logStreamName: this.logStreamName,
      }));
      this.sequenceToken = undefined;
    } catch (err: any) {
      if (err.name !== 'ResourceAlreadyExistsException') {
        throw err;
      }
    }
  }

  async putLog(message: string): Promise<void> {
    const params: any = {
      logGroupName: this.logGroupName,
      logStreamName: this.logStreamName,
      logEvents: [{ timestamp: Date.now(), message }],
    };
    if (this.sequenceToken) {
      params.sequenceToken = this.sequenceToken;
    }
    try {
      const result = await this.cloudWatchLogs.send(new PutLogEventsCommand(params));
      this.sequenceToken = result.nextSequenceToken;
    } catch (err: any) {
      if (err.name === 'InvalidSequenceTokenException' && err.expectedSequenceToken) {
        this.sequenceToken = err.expectedSequenceToken;
        await this.putLog(message);
      } else {
        logger.error(`CloudWatch putLog error: ${err}`);
      }
    }
  }
}
