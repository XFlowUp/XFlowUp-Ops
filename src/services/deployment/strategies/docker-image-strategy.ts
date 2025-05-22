import { DeploymentRequestPayload, DeploymentStrategy } from '../deployment-manager';
import { ECSService } from '../../aws/ecs-service';
import logger from '../../../utils/logger';

export class DockerImageStrategy implements DeploymentStrategy {
  private ecsService: ECSService;
  private lastPublicEndpoint?: string;

  constructor() {
    this.ecsService = new ECSService();
  }

  async deploy(payload: DeploymentRequestPayload): Promise<boolean> {
    const context = {
      serviceId: payload.serviceId,
      projectSlug: payload.projectSlug,
      deploymentId: payload.messageId || payload.deploymentId || undefined,
      type: payload.type
    };
    logger.info(`[context] Starting Docker image deployment`, context);
    // TODO: metrics: increment docker_image_deploy_started
    this.lastPublicEndpoint = undefined;
    try {
      if (!payload.docker_image_url) {
        logger.error(`[context] Docker image URL is missing`, context);
        // TODO: metrics: increment docker_image_deploy_failed
        throw new Error('Docker image URL is missing');
      }
      // Get the Docker image URL and tag
      const imageUrl = payload.docker_image_url;
      const imageTag = payload.docker_image_tag || 'latest';
      const imageUri = `${imageUrl}:${imageTag}`;
      logger.info(`[context] Using image URI: ${imageUri}`, context);
      // Create or update ECS service
      const serviceName = `${payload.projectSlug}-${payload.serviceId}`;
      const environmentVariables = payload.metadata?.environmentValues || {};
      let containerPort = 3000;
      if (payload.port && !isNaN(Number(payload.port))) {
        containerPort = Number(payload.port);
      } else if (payload.containerPort && !isNaN(Number(payload.containerPort))) {
        containerPort = Number(payload.containerPort);
      } else if (environmentVariables.PORT && !isNaN(Number(environmentVariables.PORT))) {
        containerPort = Number(environmentVariables.PORT);
      }
      logger.info(`[context] Deploying to ECS: ${serviceName} on port ${containerPort}`, context);
      // TODO: metrics: increment ecs_deploy_started
      const ecsResult = await this.ecsService.deployService(
        serviceName,
        imageUri,
        environmentVariables,
        containerPort
      );
      logger.info(`[context] ECS deployment result: ${JSON.stringify(ecsResult)}`, context);
      // TODO: metrics: increment ecs_deploy_success if ecsResult.healthy
      this.lastPublicEndpoint = ecsResult.publicEndpoint;
      logger.info(`[context] Docker image deployment completed for service ID: ${payload.serviceId}`, context);
      return ecsResult.healthy;
    } catch (error) {
      logger.error(`[context] Docker image deployment failed: ${error}`, context);
      this.lastPublicEndpoint = undefined;
      // TODO: metrics: increment docker_image_deploy_failed
      return false;
    }
  }

  getPublicEndpoint(): string | undefined {
    return this.lastPublicEndpoint;
  }
}
