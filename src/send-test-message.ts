import { SQS } from '@aws-sdk/client-sqs';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

// Load environment variables
dotenv.config();

// Set up AWS SQS client
const region = process.env.SQS_REGION || process.env.AWS_REGION || 'ap-southeast-1';
const accessKeyId = process.env.SQS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.SQS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
const queueUrl = process.env.SQS_URL;
const isFifo = process.env.SQS_IS_FIFO === 'true';

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

// Create a test deployment request message
async function sendTestMessage() {
  try {
    const messageId = uuidv4();
    
    // Create the message body
    const messageBody = {
      messageId,
      message: {
        type: 'GITHUB_REPO',
        environmentId: 1,
        projectSlug: 'test-project',
        serviceId: 123,
        userId: 456,
        github_token: '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', // Replace with a valid GitHub token
        githubRepository: {
          url: 'https://github.com/h3nr1-HieuLD/DefaultNextJS.git', // Replace with a valid repository URL
          branch: 'main'
        },
        metadata: {
          environmentId: '1',
          environmentValues: {
            PORT: '3000',
            NODE_ENV: 'production'
          }
        },
        containerPort: 3000 // <--- Add this line to explicitly set the port
      },
      date: new Date().toISOString(),
      MessageAttributes: {
        job: {
          DataType: 'String',
          StringValue: 'deployment:production'
        }
      }
    };
    
    // Create the SQS message
    const sqsMessage: any = {
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(messageBody),
    };
    
    // Add FIFO-specific attributes if needed
    if (isFifo) {
      sqsMessage.MessageGroupId = 'deployment-test';
      sqsMessage.MessageDeduplicationId = messageId;
    }
    
    // Send the message
    const result = await sqs.sendMessage(sqsMessage);
    
    console.log('Test message sent successfully!');
    console.log('Message ID:', result.MessageId);
    console.log('Message body:', JSON.stringify(messageBody, null, 2));
    
  } catch (error) {
    console.error('Error sending test message:', error);
  }
}

// Run the function
sendTestMessage();
