import logger from '../../utils/logger';
import { GithubRepoStrategy } from './strategies/github-repo-strategy';
import { DockerImageStrategy } from './strategies/docker-image-strategy';
import { SQSProducer } from '../sqs/sqs-producer';
import { CloudflareDNS } from '../../utils/cloudflare-dns';
import axios from 'axios';

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
  private statusQueueUrl: string | undefined;

  constructor(statusQueueUrl?: string) {
    this.strategies = new Map();
    this.sqsProducer = new SQSProducer();
    this.statusQueueUrl = statusQueueUrl || process.env.SQS_STATUS_URL;
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
      if (process.env.SKIP_DEPLOYMENT_STATUS_SQS !== 'true') {
        await this.updateDeploymentStatus(payload, DeploymentStatus.IN_PROGRESS);
      } else {
        logger.info('Skipping SQS deployment status update (IN_PROGRESS) due to SKIP_DEPLOYMENT_STATUS_SQS=true');
      }

      // Get the appropriate strategy
      const strategy = this.strategies.get(payload.type as ServiceType);

      if (!strategy) {
        throw new Error(`Unsupported deployment type: ${payload.type}`);
      }

      // Execute the deployment
      const success = await strategy.deploy(payload);
      let publicEndpoint: string | undefined;
      if (payload.type === ServiceType.GITHUB_REPO && typeof (strategy as any).getPublicEndpoint === 'function') {
        publicEndpoint = (strategy as any).getPublicEndpoint();
      }
      let assignedUrl: string | undefined;
      if (success && publicEndpoint) {
        // Assign subdomain via Cloudflare
        const domain = process.env.DOMAIN || 'your-domain.com';
        const subdomain = payload.projectSlug;
        try {
          const urlResult = await CloudflareDNS.upsertDNSRecord(subdomain, domain, publicEndpoint, 'CNAME');
          assignedUrl = urlResult || undefined;
          logger.info(`Assigned subdomain: ${assignedUrl} -> ${publicEndpoint}`);
          // Optionally, verify the site is live
          const urlToCheck = `http://${assignedUrl}`;
          try {
            await axios.get(urlToCheck, { timeout: 10000 });
            logger.info(`Verified site is live at ${urlToCheck}`);
          } catch (err) {
            logger.warn(`Could not verify site is live at ${urlToCheck}: ${err}`);
          }
        } catch (err) {
          logger.error(`Failed to assign subdomain via Cloudflare: ${err}`);
        }
      }

      // Update deployment status based on result, include URL if available
      if (success) {
        if (process.env.SKIP_DEPLOYMENT_STATUS_SQS !== 'true') {
          await this.updateDeploymentStatus({ ...payload, deploymentUrl: assignedUrl }, DeploymentStatus.COMPLETED);
        } else {
          logger.info('Skipping SQS deployment status update (COMPLETED) due to SKIP_DEPLOYMENT_STATUS_SQS=true');
        }
        logger.info(`Deployment completed successfully for service ID: ${payload.serviceId}`);
        // Send SQS message with deployment URL, status, and project info
        if (process.env.SKIP_DEPLOYMENT_STATUS_SQS !== 'true') {
          await this.sqsProducer.sendMessage(
            {
              serviceId: payload.serviceId,
              projectSlug: payload.projectSlug,
              status: DeploymentStatus.COMPLETED,
              deploymentUrl: assignedUrl,
              publicEndpoint,
              timestamp: new Date().toISOString(),
            },
            'deployment:status-update',
            `deployment-${payload.serviceId}`,
            this.statusQueueUrl // Pass status queue URL if set
          );
        } else {
          logger.info('Skipping SQS deployment status sendMessage (COMPLETED) due to SKIP_DEPLOYMENT_STATUS_SQS=true');
        }
      } else {
        if (process.env.SKIP_DEPLOYMENT_STATUS_SQS !== 'true') {
          await this.updateDeploymentStatus(payload, DeploymentStatus.FAILED);
        } else {
          logger.info('Skipping SQS deployment status update (FAILED) due to SKIP_DEPLOYMENT_STATUS_SQS=true');
        }
        logger.error(`Deployment failed for service ID: ${payload.serviceId}`);
      }
    } catch (error) {
      logger.error(`Error during deployment: ${error}`);
      if (process.env.SKIP_DEPLOYMENT_STATUS_SQS !== 'true') {
        await this.updateDeploymentStatus(payload, DeploymentStatus.FAILED, error);
      } else {
        logger.info('Skipping SQS deployment status update (FAILED, error) due to SKIP_DEPLOYMENT_STATUS_SQS=true');
      }
    }
  }

  private async updateDeploymentStatus(
    payload: DeploymentRequestPayload,
    status: DeploymentStatus,
    error?: any
  ): Promise<void> {
    if (process.env.SKIP_DEPLOYMENT_STATUS_SQS === 'true') {
      logger.info('Skipping updateDeploymentStatus SQS message due to SKIP_DEPLOYMENT_STATUS_SQS=true');
      return;
    }
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
