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

// Function to send a deployment:product message
async function sendProductDeploymentMessage() {
  try {
    const messageId = uuidv4();

    // Get command line arguments for repository URL and branch
    const args = process.argv.slice(2);
    const repoUrl = args[0] || 'https://github.com/h3nr1-HieuLD/DefaultNextJS';
    const branch = args[1] || 'main';
    const serviceId = args[2] || '123';

    // Create the message body for a GitHub repository deployment
    const messageBody = {
      messageId,
      message: {
        serviceId: serviceId,
        serviceType: 'GITHUB_REPO',
        config: {
          repositoryUrl: repoUrl,
          branch: branch,
          buildCommand: 'npm run build',
          startCommand: 'npm start',
          environmentVariables: {
            NODE_ENV: 'production',
            PORT: '3000',
            PG_HOST: 'localhost',
            PG_USER: 'postgres',
            PG_PASSWORD: 'postgres',
            PG_DATABASE: 'postgres',
            PG_PORT: '5432',
            DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/postgres?schema=public',
            NEXT_PUBLIC_SKIP_API_ROUTES: 'true',
            NEXT_TELEMETRY_DISABLED: '1'
          }
        }
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
      sqsMessage.MessageGroupId = 'deployment';
      sqsMessage.MessageDeduplicationId = messageId;
    }

    // Send the message
    const result = await sqs.sendMessage(sqsMessage);

    console.log('Production deployment message sent successfully!');
    console.log('Message ID:', result.MessageId);
    console.log('Repository URL:', repoUrl);
    console.log('Branch:', branch);
    console.log('Service ID:', serviceId);

  } catch (error) {
    console.error('Error sending product deployment message:', error);
  }
}

// Run the function
sendProductDeploymentMessage();
