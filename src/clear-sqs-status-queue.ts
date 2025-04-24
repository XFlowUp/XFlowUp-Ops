import { SQS } from '@aws-sdk/client-sqs';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Set up AWS SQS client
const region = process.env.SQS_REGION || process.env.AWS_REGION || 'ap-southeast-1';
const accessKeyId = process.env.SQS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.SQS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
const queueUrl = process.env.SQS_STATUS_URL;

if (!accessKeyId || !secretAccessKey || !queueUrl) {
  console.error('Missing required AWS credentials or SQS queue URL');
  process.exit(1);
}

const sqs = new SQS({
  region,
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
});

async function purgeQueue() {
  try {
    console.log(`Purging queue: ${queueUrl}`);
    await sqs.purgeQueue({ QueueUrl: queueUrl });
    console.log('Queue purged successfully!');
  } catch (error: any) {
    if (error?.name === 'PurgeQueueInProgress') {
      console.log('A purge operation is already in progress. Please wait at least 60 seconds before trying again.');
    } else {
      console.error('Error purging queue:', error);
    }
  }
}

// For FIFO queues, purgeQueue might not be enough, so we'll also try to receive and delete all messages
async function clearAllMessages() {
  console.log('Starting to clear all messages from the queue...');
  let messagesDeleted = 0;
  let emptyReceives = 0;

  while (emptyReceives < 3) { // Stop after 3 consecutive empty receives
    try {
      const response = await sqs.receiveMessage({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10, // Maximum allowed by AWS
        WaitTimeSeconds: 1,
        VisibilityTimeout: 30,
      });

      if (!response.Messages || response.Messages.length === 0) {
        emptyReceives++;
        console.log(`No messages received (${emptyReceives}/3 empty receives)`);
        continue;
      }

      emptyReceives = 0; // Reset counter if we received messages

      for (const message of response.Messages) {
        if (message.ReceiptHandle) {
          await sqs.deleteMessage({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          });
          messagesDeleted++;
          console.log(`Deleted message ${messagesDeleted}`);
        }
      }
    } catch (error: any) {
      console.error('Error processing messages:', error);
      break;
    }
  }

  console.log(`Finished clearing messages. Total messages deleted: ${messagesDeleted}`);
}

async function main() {
  try {
    // First try to purge the queue (fastest method)
    await purgeQueue();

    // Then also try to receive and delete all messages to be thorough
    await clearAllMessages();

    console.log('Queue clearing operations completed.');
  } catch (error: any) {
    console.error('Error:', error);
  }
}

main();
