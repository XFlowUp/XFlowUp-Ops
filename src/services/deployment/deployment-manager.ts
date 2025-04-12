import logger from '../../utils/logger';
import { GithubRepoStrategy } from './strategies/github-repo-strategy';
import { DockerImageStrategy } from './strategies/docker-image-strategy';
import { SQSProducer } from '../sqs/sqs-producer';

// Define the deployment types
export enum ServiceType {
  GITHUB_REPO = 'GITHUB_REPO',
  DOCKER_IMAGE = 'DOCKER_IMAGE',
  DATABASE = 'DATABASE',
  FUNCTION = 'FUNCTION'
}

// Define the deployment status
export enum DeploymentStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED'
}

// Define the deployment request payload interface
export interface DeploymentRequestPayload {
  type: ServiceType;
  environmentId: number | bigint;
  projectSlug: string;
  serviceId: number | bigint;
  userId: number | bigint;
  metadata?: {
    environmentId: string;
    environmentValues: Record<string, string>;
  };
  [key: string]: any; // Allow additional properties based on deployment type
}

// Define the deployment strategy interface
export interface DeploymentStrategy {
  deploy(payload: DeploymentRequestPayload): Promise<boolean>;
}

export class DeploymentManager {
  private strategies: Map<ServiceType, DeploymentStrategy>;
  private sqsProducer: SQSProducer;

  constructor() {
    this.strategies = new Map();
    this.sqsProducer = new SQSProducer();

    // Register strategies
    this.strategies.set(ServiceType.GITHUB_REPO, new GithubRepoStrategy());
    this.strategies.set(ServiceType.DOCKER_IMAGE, new DockerImageStrategy());
    // Add more strategies as needed
  }

  async handleDeploymentRequest(payload: DeploymentRequestPayload): Promise<void> {
    logger.info(`Handling deployment request for service type: ${payload.type}`);

    // Log the full deployment payload for debugging
    logger.info(`Full deployment payload: ${JSON.stringify(payload)}`);

    // Log each property of the payload separately for better readability
    logger.info('Deployment payload properties:');
    Object.entries(payload).forEach(([key, value]) => {
      // Don't stringify large objects like githubRepository or metadata
      if (typeof value === 'object' && value !== null) {
        logger.info(`  ${key}: [Object]`);
        // Log nested objects separately
        Object.entries(value).forEach(([nestedKey, nestedValue]) => {
          logger.info(`    ${key}.${nestedKey}: ${JSON.stringify(nestedValue)}`);
        });
      } else {
        logger.info(`  ${key}: ${JSON.stringify(value)}`);
      }
    });

    try {
      // Update deployment status to IN_PROGRESS
      await this.updateDeploymentStatus(payload, DeploymentStatus.IN_PROGRESS);

      // Get the appropriate strategy
      const strategy = this.strategies.get(payload.type as ServiceType);

      if (!strategy) {
        throw new Error(`Unsupported deployment type: ${payload.type}`);
      }

      // Execute the deployment
      const success = await strategy.deploy(payload);

      // Update deployment status based on result
      if (success) {
        await this.updateDeploymentStatus(payload, DeploymentStatus.COMPLETED);
        logger.info(`Deployment completed successfully for service ID: ${payload.serviceId}`);
      } else {
        await this.updateDeploymentStatus(payload, DeploymentStatus.FAILED);
        logger.error(`Deployment failed for service ID: ${payload.serviceId}`);
      }
    } catch (error) {
      logger.error(`Error during deployment: ${error}`);
      await this.updateDeploymentStatus(payload, DeploymentStatus.FAILED, error);
    }
  }

  private async updateDeploymentStatus(
    payload: DeploymentRequestPayload,
    status: DeploymentStatus,
    error?: any
  ): Promise<void> {
    try {
      // Create the status update message
      const statusUpdateMessage = {
        serviceId: payload.serviceId,
        projectSlug: payload.projectSlug,
        status,
        error: error ? error.toString() : undefined,
        timestamp: new Date().toISOString()
      };

      // Log the status update message
      logger.info(`Sending status update message: ${JSON.stringify(statusUpdateMessage)}`);

      // Send status update message to SQS
      const messageId = await this.sqsProducer.sendMessage(
        statusUpdateMessage,
        'deployment:status-update',
        `deployment-${payload.serviceId}`
      );

      logger.info(`Updated deployment status to ${status} for service ID: ${payload.serviceId}`);
      logger.info(`Status update message sent with ID: ${messageId}`);
    } catch (error) {
      logger.error(`Failed to update deployment status: ${error}`);
    }
  }
}
