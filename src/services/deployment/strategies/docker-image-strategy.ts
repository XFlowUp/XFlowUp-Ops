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
    logger.info(`Starting Docker image deployment for service ID: ${payload.serviceId}`);
    this.lastPublicEndpoint = undefined;
    try {
      if (!payload.docker_image_url) {
        throw new Error('Docker image URL is missing');
      }
      // Get the Docker image URL and tag
      const imageUrl = payload.docker_image_url;
      const imageTag = payload.docker_image_tag || 'latest';
      const imageUri = `${imageUrl}:${imageTag}`;
      // Create or update ECS service
      const serviceName = `${payload.projectSlug}-${payload.serviceId}`;
      const environmentVariables = payload.metadata?.environmentValues || {};
      // Deploy to ECS and get public endpoint
      const ecsResult = await this.ecsService.deployService(
        serviceName,
        imageUri,
        environmentVariables
      );
      logger.info(`ECS deployment result: ${JSON.stringify(ecsResult)}`);
      this.lastPublicEndpoint = ecsResult.publicEndpoint;
      logger.info(`Docker image deployment completed for service ID: ${payload.serviceId}`);
      return true;
    } catch (error) {
      logger.error(`Docker image deployment failed: ${error}`);
      this.lastPublicEndpoint = undefined;
      return false;
    }
  }

  getPublicEndpoint(): string | undefined {
    return this.lastPublicEndpoint;
  }
}
