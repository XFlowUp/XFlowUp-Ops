import { DeploymentManager, ServiceType } from './services/deployment/deployment-manager';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Mock AWS credentials for testing using values from .env.example
process.env.AWS_REGION = process.env.AWS_REGION || 'ap-southeast-1';
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'test-key'; // Using placeholder since .env.example has empty value
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'test-secret'; // Using placeholder since .env.example has empty value
process.env.SQS_REGION = process.env.SQS_REGION || 'ap-southeast-1';
process.env.SQS_ACCESS_KEY_ID = process.env.SQS_ACCESS_KEY_ID || 'test-key'; // Using placeholder since .env.example has empty value
process.env.SQS_SECRET_ACCESS_KEY = process.env.SQS_SECRET_ACCESS_KEY || '+f';
process.env.SQS_IS_FIFO = process.env.SQS_IS_FIFO || 'true';
process.env.SQS_QUEUE_NAME = process.env.SQS_QUEUE_NAME || 'DeployQueue.fifo';
process.env.SQS_URL = process.env.SQS_URL || 'https://sqs.ap-southeast-1.amazonaws.com/897722701745/DeployQueue.fifo';
process.env.AWS_ECS_CLUSTER = process.env.AWS_ECS_CLUSTER || 'your-ecs-cluster';
process.env.AWS_ECS_EXECUTION_ROLE_ARN = process.env.AWS_ECS_EXECUTION_ROLE_ARN || 'arn:aws:iam::your-account-id:role/ecsTaskExecutionRole';
process.env.AWS_ECR_REPOSITORY = process.env.AWS_ECR_REPOSITORY || 'your-account-id.dkr.ecr.ap-southeast-1.amazonaws.com/your-repo';
process.env.AWS_VPC_ID = process.env.AWS_VPC_ID || 'vpc-xxxxxxxx';
process.env.AWS_SUBNET_IDS = process.env.AWS_SUBNET_IDS || 'subnet-xxxxxxxx,subnet-yyyyyyyy';
process.env.AWS_SECURITY_GROUP_ID = process.env.AWS_SECURITY_GROUP_ID || 'sg-xxxxxxxx';
process.env.AWS_CLOUDWATCH_LOG_GROUP = process.env.AWS_CLOUDWATCH_LOG_GROUP || '/ecs/deployment-worker';

// Create a mock deployment request
const mockDeploymentRequest = {
  type: ServiceType.GITHUB_REPO,
  environmentId: 1,
  projectSlug: 'test-project',
  serviceId: 123,
  userId: 456,
  github_token: 'github-token',
  githubRepository: {
    url: 'https://github.com/user/repo',
    branch: 'main'
  },
  metadata: {
    environmentId: '1',
    environmentValues: {
      PORT: '3000',
      NODE_ENV: 'production'
    }
  }
};

// Mock the deployment process
async function testDeploymentManager() {
  console.log('Testing Deployment Manager with mock data...');

  try {
    // Create a deployment manager instance
    const deploymentManager = new DeploymentManager();

    // Override the deploy method of the strategies to avoid actual AWS calls
    // @ts-ignore - Accessing private property for testing
    deploymentManager.strategies.forEach((strategy) => {
      strategy.deploy = async () => {
        console.log(`Mock deployment for strategy: ${strategy.constructor.name}`);
        return true;
      };
    });

    // Handle the mock deployment request
    await deploymentManager.handleDeploymentRequest(mockDeploymentRequest);

    console.log('Mock deployment completed successfully!');
  } catch (error) {
    console.error(`Error during mock deployment: ${error}`);
  }
}

// Run the test
testDeploymentManager();
