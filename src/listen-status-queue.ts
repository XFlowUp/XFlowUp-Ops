import { SQS } from '@aws-sdk/client-sqs';
import dotenv from 'dotenv';

dotenv.config();

const region = process.env.SQS_REGION || process.env.AWS_REGION || 'ap-southeast-1';
const accessKeyId = process.env.SQS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.SQS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
const queueUrl = process.env.SQS_STATUS_URL;

if (!accessKeyId || !secretAccessKey || !queueUrl) {
  console.error('Missing required AWS credentials or SQS_STATUS_URL');
  process.exit(1);
}

const sqs = new SQS({
  region,
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
});

async function listenToStatusQueue() {
  console.log(`Listening to SQS status queue: ${queueUrl}`);
  while (true) {
    try {
      const response = await sqs.receiveMessage({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20, // long polling
        VisibilityTimeout: 60,
      });
      if (response.Messages && response.Messages.length > 0) {
        for (const message of response.Messages) {
          try {
            console.log('--- Received SQS Status Message ---');
            console.log(message.Body);
            // Optionally, parse and pretty-print
            try {
              const parsed = JSON.parse(message.Body || '');
              console.log('Parsed:', JSON.stringify(parsed, null, 2));
            } catch {}
            // Delete message after processing
            if (message.ReceiptHandle) {
              await sqs.deleteMessage({
                QueueUrl: queueUrl,
                ReceiptHandle: message.ReceiptHandle,
              });
              console.log('Deleted message from status queue.');
            }
          } catch (err) {
            console.error('Error processing status message:', err);
          }
        }
      }
    } catch (err) {
      console.error('Error receiving messages from status queue:', err);
      await new Promise(res => setTimeout(res, 5000));
    }
  }
}

listenToStatusQueue();
