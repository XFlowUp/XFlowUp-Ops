import logger from '../../utils/logger';
import { GithubRepoStrategy } from './strategies/github-repo-strategy';
import { DockerImageStrategy } from './strategies/docker-image-strategy';
import { SQSProducer } from '../sqs/sqs-producer';
import { CloudflareDNS } from '../../utils/cloudflare-dns';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { CloudWatchStreamLogger } from '../aws/cloudwatch-stream-logger';

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
  deploy(payload: DeploymentRequestPayload, deploymentId?: string, streamLog?: (msg: string) => Promise<void>): Promise<boolean>;
}

export class DeploymentManager {
  private strategies: Map<ServiceType, DeploymentStrategy>;
  private sqsProducer: SQSProducer;
  private statusQueueUrl: string | undefined;
  private cloudWatchLogger?: CloudWatchStreamLogger;

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
    logger.info(`Handling deployment request for service type: ${payload.type}`);    const deploymentId = (payload as any).deploymentId || `fallback-${payload.serviceId}-${Date.now()}`;
    const logGroupName = '/ecs/log-builder';
    const logStreamName = deploymentId;
    this.cloudWatchLogger = new CloudWatchStreamLogger(logGroupName, logStreamName);
    await this.cloudWatchLogger.init();
    const streamLog = async (msg: string) => {
      logger.info(`[STREAM_LOG] ${msg}`);
      await this.cloudWatchLogger?.putLog(msg);
    };
    await streamLog(`Deployment started for service type: ${payload.type}, deploymentId: ${deploymentId}`);
    // --- END: CloudWatch log streaming setup ---
    // Log the full deployment payload for debugging
    logger.info(`Full deployment payload: ${JSON.stringify(payload)}`);
    await streamLog(`Full deployment payload: ${JSON.stringify(payload)}`);

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
      streamLog(`  ${key}: ${JSON.stringify(value)}`);
    });

    try {
      // Update deployment status to IN_PROGRESS
      if (process.env.SKIP_DEPLOYMENT_STATUS_SQS !== 'true') {
        await this.updateDeploymentStatus(payload, DeploymentStatus.IN_PROGRESS);
        await streamLog('Deployment status set to IN_PROGRESS');
      } else {
        logger.info('Skipping SQS deployment status update (IN_PROGRESS) due to SKIP_DEPLOYMENT_STATUS_SQS=true');
        await streamLog('Skipping SQS deployment status update (IN_PROGRESS)');
      }

      // Get the appropriate strategy
      const strategy = this.strategies.get(payload.type as ServiceType);

      if (!strategy) {
        await streamLog(`Unsupported deployment type: ${payload.type}`);
        throw new Error(`Unsupported deployment type: ${payload.type}`);
      }

      // Execute the deployment
      const deployResult = await strategy.deploy(payload, deploymentId, streamLog);
      let success: boolean = false;
      let logStreamName: string | undefined;
      // Type guard for deployResult
      if (typeof deployResult === 'object' && deployResult !== null) {
        if ('healthy' in deployResult) {
          success = !!(deployResult as any).healthy;
        } else if ('success' in deployResult) {
          success = !!(deployResult as any).success;
        } else {
          success = !!deployResult;
        }
        if ('logStreamName' in deployResult) {
          logStreamName = (deployResult as any).logStreamName;
        }
      } else {
        success = !!deployResult;
      }
      await streamLog(`Strategy.deploy returned: ${success}`);
      let publicEndpoint: string | undefined;
      // --- BEGIN: Add retries for fetching public endpoint ---
      if (payload.type === ServiceType.GITHUB_REPO && typeof (strategy as any).getPublicEndpoint === 'function') {
        logger.info(`[CloudFlare DNS] Attempting to get public endpoint for service ID: ${payload.serviceId}`);
        const maxRetries = 5;
        const retryDelayMs = 5000;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          publicEndpoint = (strategy as any).getPublicEndpoint();
          await streamLog(`[CloudFlare DNS] getPublicEndpoint attempt ${attempt}: ${publicEndpoint}`);
          if (publicEndpoint) {
            logger.info(`[CloudFlare DNS] Successfully retrieved public endpoint: ${publicEndpoint} for service ID: ${payload.serviceId} (attempt ${attempt})`);
            break;
          } else {
            logger.warn(`[CloudFlare DNS] Public endpoint not available yet (attempt ${attempt}/${maxRetries}) for service ID: ${payload.serviceId}`);
            if (attempt < maxRetries) {
              await new Promise(res => setTimeout(res, retryDelayMs));
            }
          }
        }
        if (!publicEndpoint) {
          logger.error(`[CloudFlare DNS] Failed to retrieve public endpoint for service ID: ${payload.serviceId} after ${maxRetries} attempts. Aborting deployment.`);
          await streamLog(`[CloudFlare DNS] Failed to retrieve public endpoint after ${maxRetries} attempts.`);
          throw new Error('Public endpoint (ALB DNS) is required for DNS linking but was not found.');
        }
      } else {
        logger.warn(`[CloudFlare DNS] Service type ${payload.type} does not support public endpoints or getPublicEndpoint function is not available. This will prevent CloudFlare DNS linking.`);
      }
      // --- END: Add retries for fetching public endpoint ---
      let assignedUrl: string | undefined;
      let isAccessible = false;
      let status: DeploymentStatus = DeploymentStatus.FAILED;
      let errorMsg: any = undefined;
      if (success && publicEndpoint) {
        // Assign random subdomain via Cloudflare
        const domain = process.env.DOMAIN || 'your-domain.com';
        logger.info(`[CloudFlare DNS] Using domain: ${domain}`);
        await streamLog(`[CloudFlare DNS] Using domain: ${domain}`);

        // Generate a random subdomain based on project slug and a unique identifier
        const randomSubdomain = this.generateRandomSubdomain(payload.projectSlug);
        logger.info(`[CloudFlare DNS] Generated random subdomain: ${randomSubdomain}`);
        await streamLog(`[CloudFlare DNS] Generated random subdomain: ${randomSubdomain}`);

        logger.info(`[CloudFlare DNS] Attempting to link ECS to CloudFlare DNS: ${randomSubdomain}.${domain} -> ${publicEndpoint}`);
        await streamLog(`[CloudFlare DNS] Attempting to link ECS to CloudFlare DNS: ${randomSubdomain}.${domain} -> ${publicEndpoint}`);
        try {
          logger.info(`[CloudFlare DNS] Calling upsertDNSRecord with params: subdomain=${randomSubdomain}, domain=${domain}, endpoint=${publicEndpoint}`);
          await streamLog(`[CloudFlare DNS] Calling upsertDNSRecord with params: subdomain=${randomSubdomain}, domain=${domain}, endpoint=${publicEndpoint}`);
          const urlResult = await CloudflareDNS.upsertDNSRecord(randomSubdomain, domain, publicEndpoint);
          if (urlResult) {
            assignedUrl = urlResult;
            logger.info(`[CloudFlare DNS] Successfully linked ECS to CloudFlare DNS. Assigned URL: ${assignedUrl} -> ${publicEndpoint}`);
            await streamLog(`[CloudFlare DNS] Successfully linked ECS to CloudFlare DNS. Assigned URL: ${assignedUrl} -> ${publicEndpoint}`);
          } else {
            logger.warn(`[CloudFlare DNS] upsertDNSRecord returned empty result. No URL was assigned.`);
            await streamLog(`[CloudFlare DNS] upsertDNSRecord returned empty result. No URL was assigned.`);
            assignedUrl = undefined;
          }

          // Verify the site is live
          if (assignedUrl) {
            // Determine the health check path from the payload, defaulting to '/'
            const healthCheckPathFromPayload = payload.healthCheckPath || '/';
            // Ensure the healthCheckPath starts with a '/'
            const fullHealthCheckPath = healthCheckPathFromPayload.startsWith('/') ? healthCheckPathFromPayload : `/${healthCheckPathFromPayload}`;

            const urlToCheck = `http://${assignedUrl}${fullHealthCheckPath}`;
            logger.info(`[CloudFlare DNS] Verifying site accessibility at: ${urlToCheck}`);
            await streamLog(`[CloudFlare DNS] Verifying site accessibility at: ${urlToCheck}`);
            // Add retry logic for health check
            const maxHealthRetries = 20;
            const healthRetryDelay = 15000; // 5 seconds
            for (let attempt = 1; attempt <= maxHealthRetries; attempt++) {
              try {
                logger.info(`[CloudFlare DNS] Health check attempt ${attempt}: Sending GET request to ${urlToCheck} with 10s timeout`);
                await streamLog(`[CloudFlare DNS] Health check attempt ${attempt}: Sending GET request to ${urlToCheck} with 10s timeout`);
                await axios.get(urlToCheck, { timeout: 10000 });
                logger.info(`[CloudFlare DNS] Health check PASSED: Site is live at ${urlToCheck}`);
                await streamLog(`[CloudFlare DNS] Health check PASSED: Site is live at ${urlToCheck}`);
                isAccessible = true;
                break;
              } catch (err) {
                logger.warn(`[CloudFlare DNS] Health check attempt ${attempt} FAILED: Could not verify site is live at ${urlToCheck}`);
                await streamLog(`[CloudFlare DNS] Health check attempt ${attempt} FAILED: Could not verify site is live at ${urlToCheck}`);
                logger.warn(`[CloudFlare DNS] Health check error details: ${err}`);
                await streamLog(`[CloudFlare DNS] Health check error details: ${err}`);
                if (attempt < maxHealthRetries) {
                  await new Promise(res => setTimeout(res, healthRetryDelay));
                }
              }
            }
          } else {
            logger.warn(`[CloudFlare DNS] Skipping health check because no URL was assigned`);
            await streamLog(`[CloudFlare DNS] Skipping health check because no URL was assigned`);
          }

          // Add accessibility status to the payload for the status message
          (payload as any).isAccessible = isAccessible;
          (payload as any).deploymentUrl = assignedUrl;

          // Only proceed with status updates and SQS messages if the site is accessible
          if (isAccessible) {
            logger.info(`[CloudFlare DNS] Site is accessible. Proceeding with status updates and SQS messages for service ID: ${payload.serviceId}`);
            await streamLog(`[CloudFlare DNS] Site is accessible. Proceeding with status updates and SQS messages for service ID: ${payload.serviceId}`);

            // Update deployment status based on result, include URL if available
            if (process.env.SKIP_DEPLOYMENT_STATUS_SQS !== 'true') {
              logger.info(`[CloudFlare DNS] Updating deployment status to COMPLETED for service ID: ${payload.serviceId}`);
              await streamLog(`[CloudFlare DNS] Updating deployment status to COMPLETED for service ID: ${payload.serviceId}`);
              await this.updateDeploymentStatus({ ...payload, deploymentUrl: assignedUrl }, DeploymentStatus.COMPLETED);
              logger.info(`[CloudFlare DNS] Successfully updated deployment status to COMPLETED for service ID: ${payload.serviceId}`);
              await streamLog(`[CloudFlare DNS] Successfully updated deployment status to COMPLETED for service ID: ${payload.serviceId}`);
            } else {
              logger.info('[CloudFlare DNS] Skipping SQS deployment status update (COMPLETED) due to SKIP_DEPLOYMENT_STATUS_SQS=true');
              await streamLog('[CloudFlare DNS] Skipping SQS deployment status update (COMPLETED) due to SKIP_DEPLOYMENT_STATUS_SQS=true');
            }

            logger.info(`[CloudFlare DNS] Deployment completed successfully for service ID: ${payload.serviceId}`);
            await streamLog(`[CloudFlare DNS] Deployment completed successfully for service ID: ${payload.serviceId}`);

            // Send SQS message with deployment URL, status, and project info
            if (process.env.SKIP_DEPLOYMENT_STATUS_SQS !== 'true') {              const sqsMessage = {
                serviceId: payload.serviceId,
                projectSlug: payload.projectSlug,
                status: DeploymentStatus.COMPLETED,
                deploymentUrl: assignedUrl, // Ensure random url is included
                publicEndpoint,
                isAccessible: true,
                deploymentId, // Include deploymentId for backend tracking
                logGroupName,
                logStreamName, // <-- include the full log stream name
                timestamp: new Date().toISOString(),
                originalMessage: payload
              };

              logger.info(`[CloudFlare DNS] Sending SQS message for successful deployment: ${JSON.stringify(sqsMessage)}`);
              await streamLog(`[CloudFlare DNS] Sending SQS message for successful deployment: ${JSON.stringify(sqsMessage)}`);

              await this.sqsProducer.sendMessage(
                sqsMessage,
                'deployment:status-update',
                `deployment-${payload.serviceId}`,
                this.statusQueueUrl // Pass status queue URL if set
              );

              logger.info(`[CloudFlare DNS] Successfully sent SQS message for service ID: ${payload.serviceId}`);
              await streamLog(`[CloudFlare DNS] Successfully sent SQS message for service ID: ${payload.serviceId}`);
            } else {
              logger.info('[CloudFlare DNS] Skipping SQS deployment status sendMessage (COMPLETED) due to SKIP_DEPLOYMENT_STATUS_SQS=true');
              await streamLog('[CloudFlare DNS] Skipping SQS deployment status sendMessage (COMPLETED) due to SKIP_DEPLOYMENT_STATUS_SQS=true');
            }
          } else {
            logger.warn(`[CloudFlare DNS] Deployment URL is not accessible. Skipping status update and SQS message for service ID: ${payload.serviceId}`);
            await streamLog(`[CloudFlare DNS] Deployment URL is not accessible. Skipping status update and SQS message for service ID: ${payload.serviceId}`);
            logger.warn(`[CloudFlare DNS] This means the ECS was deployed but the health check failed. The site might still be starting up or there might be an issue with the application.`);
            await streamLog(`[CloudFlare DNS] This means the ECS was deployed but the health check failed. The site might still be starting up or there might be an issue with the application.`);
          }
        } catch (err) {
          logger.error(`[CloudFlare DNS] Failed to assign subdomain via Cloudflare: ${err}`);
          await streamLog(`[CloudFlare DNS] Failed to assign subdomain via Cloudflare: ${err}`);
          logger.error(`[CloudFlare DNS] Error details:`, err);
          await streamLog(`[CloudFlare DNS] Error details: ${err}`);
          logger.error(`[CloudFlare DNS] This error occurred while trying to link ECS to CloudFlare DNS for service ID: ${payload.serviceId}`);
          await streamLog(`[CloudFlare DNS] This error occurred while trying to link ECS to CloudFlare DNS for service ID: ${payload.serviceId}`);
          logger.error(`[CloudFlare DNS] Deployment may have succeeded but DNS linking failed. Check CloudFlare settings and API access.`);
          await streamLog(`[CloudFlare DNS] Deployment may have succeeded but DNS linking failed. Check CloudFlare settings and API access.`);
        }
        status = isAccessible ? DeploymentStatus.COMPLETED : DeploymentStatus.FAILED;
      } else {
        logger.info(`[CloudFlare DNS] Skipping CloudFlare DNS linking because either deployment was not successful or no public endpoint was available`);
        await streamLog(`[CloudFlare DNS] Skipping CloudFlare DNS linking because either deployment was not successful or no public endpoint was available`);
        if (!success) {
          logger.error(`[CloudFlare DNS] Deployment was not successful for service ID: ${payload.serviceId}`);
          await streamLog(`[CloudFlare DNS] Deployment was not successful for service ID: ${payload.serviceId}`);
        }
        if (!publicEndpoint) {
          logger.error(`[CloudFlare DNS] No public endpoint available for service ID: ${payload.serviceId}`);
          await streamLog(`[CloudFlare DNS] No public endpoint available for service ID: ${payload.serviceId}`);
        }
        status = DeploymentStatus.FAILED;
      }
      // Always send status update at the end
      if (process.env.SKIP_DEPLOYMENT_STATUS_SQS !== 'true') {
        logger.info(`[CloudFlare DNS] Sending final status update (${status}) for service ID: ${payload.serviceId}`);
        await streamLog(`[CloudFlare DNS] Sending final status update (${status}) for service ID: ${payload.serviceId}`);
        await this.updateDeploymentStatus({ ...payload, deploymentUrl: assignedUrl, isAccessible, logStreamName }, status, errorMsg);
        logger.info(`[CloudFlare DNS] Successfully sent final status update (${status}) for service ID: ${payload.serviceId}`);
        await streamLog(`[CloudFlare DNS] Successfully sent final status update (${status}) for service ID: ${payload.serviceId}`);
      }
    } catch (error) {
      logger.error(`[CloudFlare DNS] Unhandled error during deployment process: ${error}`);
      await streamLog(`[CloudFlare DNS] Unhandled error during deployment process: ${error}`);
      logger.error(`[CloudFlare DNS] Error details:`, error);
      await streamLog(`[CloudFlare DNS] Error details: ${error}`);
      logger.error(`[CloudFlare DNS] This is a critical error that occurred during the deployment process for service ID: ${payload.serviceId}`);
      await streamLog(`[CloudFlare DNS] This is a critical error that occurred during the deployment process for service ID: ${payload.serviceId}`);
      if (process.env.SKIP_DEPLOYMENT_STATUS_SQS !== 'true') {
        logger.info(`[CloudFlare DNS] Sending FAILED status update with error details for service ID: ${payload.serviceId}`);
        await streamLog(`[CloudFlare DNS] Sending FAILED status update with error details for service ID: ${payload.serviceId}`);
        await this.updateDeploymentStatus(payload, DeploymentStatus.FAILED, error);
        logger.info(`[CloudFlare DNS] Successfully sent FAILED status update with error details for service ID: ${payload.serviceId}`);
        await streamLog(`[CloudFlare DNS] Successfully sent FAILED status update with error details for service ID: ${payload.serviceId}`);
      }
      logger.error(`[CloudFlare DNS] Deployment process terminated with errors for service ID: ${payload.serviceId}`);
      await streamLog(`[CloudFlare DNS] Deployment process terminated with errors for service ID: ${payload.serviceId}`);
    }
  }

  /**
   * Generates a random subdomain based on the project slug
   * @param projectSlug The project slug to base the subdomain on
   * @returns A random subdomain
   */
  private generateRandomSubdomain(projectSlug: string): string {
    // Generate a short UUID (first 8 characters)
    const shortUuid = uuidv4().split('-')[0];
    // Clean the project slug (remove special characters, convert to lowercase)
    const cleanSlug = projectSlug.toLowerCase().replace(/[^a-z0-9]/g, '');
    // Combine the clean slug with the short UUID
    return `${cleanSlug}-${shortUuid}`;
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
        timestamp: new Date().toISOString(),
        // Include deploymentUrl and accessibility status if available
        deploymentUrl: (payload as any).deploymentUrl,
        isAccessible: (payload as any).isAccessible || false,
        // Include the original message for reference
        originalMessage: payload
      };

      // Log the status update message
      logger.info(`Sending status update message: ${JSON.stringify(statusUpdateMessage)}`);

      // Send status update message to SQS
      const messageId = await this.sqsProducer.sendMessage(
        statusUpdateMessage,
        'deployment:status-update',
        `deployment-${payload.serviceId}`,
        this.statusQueueUrl // Use the status queue URL
      );

      logger.info(`Updated deployment status to ${status} for service ID: ${payload.serviceId}`);
      logger.info(`Status update message sent with ID: ${messageId}`);
    } catch (error) {
      logger.error(`Failed to update deployment status: ${error}`);
    }
  }
}
