import { DeploymentRequestPayload, DeploymentStrategy } from '../deployment-manager';
import { GitUtils, GitRepository } from '../../../utils/git-utils';
import { ECSService } from '../../aws/ecs-service';
import { ECRService } from '../../aws/ecr-service';
import { DockerfileGenerator, ProjectType } from '../../dockerfile/dockerfile-generator';
import logger from '../../../utils/logger';
import fs from 'fs';
import path from 'path';

export class GithubRepoStrategy implements DeploymentStrategy {
  private gitUtils: GitUtils;
  private ecsService: ECSService;
  private ecrService: ECRService;
  private dockerfileGenerator: DockerfileGenerator;
  private lastPublicEndpoint?: string;

  constructor() {
    this.gitUtils = new GitUtils();
    this.ecsService = new ECSService();
    this.ecrService = new ECRService();
    this.dockerfileGenerator = new DockerfileGenerator();
  }

  async deploy(payload: DeploymentRequestPayload): Promise<boolean> {
    const context = {
      serviceId: payload.serviceId,
      projectSlug: payload.projectSlug,
      deploymentId: payload.messageId || payload.deploymentId || undefined,
      type: payload.type
    };
    logger.info(`[context] Starting GitHub repo deployment`, context);
    // TODO: metrics: increment github_deploy_started

    if (!payload.githubRepository) {
      logger.error(`[context] GitHub repository information is missing`, context);
      // TODO: metrics: increment github_deploy_failed
      throw new Error('GitHub repository information is missing');
    }

    const { url, branch } = payload.githubRepository;
    const token = payload.github_token;

    let repoDir = '';
    this.lastPublicEndpoint = undefined;

    try {
      logger.info(`[context] Cloning repository: ${url} (branch: ${branch})`, context);
      // TODO: metrics: increment github_clone_started
      repoDir = await this.gitUtils.cloneRepository({ url, branch, token });
      logger.info(`[context] Repository cloned to: ${repoDir}`, context);
      // TODO: metrics: increment github_clone_success

      // Check if Dockerfile exists
      const dockerfilePath = path.join(repoDir, 'Dockerfile');
      if (!fs.existsSync(dockerfilePath)) {
        logger.info(`[context] Dockerfile not found. Attempting to generate one...`, context);
        // Detect project type
        const projectType = this.dockerfileGenerator.detectProjectType(repoDir);
        if (projectType === ProjectType.UNKNOWN) {
          logger.error(`[context] Unable to determine project type. Cannot generate Dockerfile.`, context);
          // TODO: metrics: increment github_deploy_failed
          throw new Error('Unable to determine project type. Cannot generate Dockerfile.');
        }
        logger.info(`[context] Detected project type: ${projectType}`, context);        // Determine port from payload - prioritize environmentValues.PORT over top-level port
        let dockerPort = 3000;
        if (payload.metadata?.environmentValues?.PORT && !isNaN(Number(payload.metadata.environmentValues.PORT))) {
          dockerPort = Number(payload.metadata.environmentValues.PORT);
        } else if (payload.containerPort && !isNaN(Number(payload.containerPort))) {
          dockerPort = Number(payload.containerPort);
        } else if (payload.port && !isNaN(Number(payload.port))) {
          dockerPort = Number(payload.port);        }
        // Write environment variables to file for Dockerfile generator
        if (payload.metadata?.environmentValues) {
          const envFilePath = path.join(repoDir, 'environmentValues.json');
          fs.writeFileSync(envFilePath, JSON.stringify(payload.metadata.environmentValues, null, 2));
        }
        // Generate Dockerfile with correct port
        const success = this.dockerfileGenerator.generateDockerfile(projectType, repoDir, dockerPort);
        if (!success) {
          logger.error(`[context] Failed to generate Dockerfile for ${projectType} project.`, context);
          // TODO: metrics: increment github_deploy_failed
          throw new Error(`Failed to generate Dockerfile for ${projectType} project.`);
        }
        logger.info(`[context] Successfully generated Dockerfile for ${projectType} project.`, context);
      }

      // Build and push Docker image
      const imageTag = `${payload.projectSlug}-${payload.serviceId}-${Date.now()}`;
      logger.info(`[context] Building and pushing Docker image: ${imageTag}`, context);
      // TODO: metrics: increment docker_build_started
      try {
        const imageUri = await this.ecrService.buildAndPushImage(repoDir, imageTag);
        logger.info(`[context] Docker image built and pushed: ${imageUri}`, context);
        // TODO: metrics: increment docker_build_success
        // Create or update ECS service
        const serviceName = `${payload.projectSlug}-${payload.serviceId}`;
        const environmentVariables = payload.metadata?.environmentValues || {};        let containerPort = 3000;
        if (payload.metadata?.environmentValues?.PORT && !isNaN(Number(payload.metadata.environmentValues.PORT))) {
          containerPort = Number(payload.metadata.environmentValues.PORT);
        } else if (payload.containerPort && !isNaN(Number(payload.containerPort))) {
          containerPort = Number(payload.containerPort);
        } else if (payload.port && !isNaN(Number(payload.port))) {
          containerPort = Number(payload.port);
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
        return ecsResult.healthy;
      } catch (error) {
        logger.error(`[context] Failed to build/push Docker image or deploy to ECS: ${error}`, context);
        // TODO: metrics: increment github_deploy_failed
        throw new Error(`Failed to push Docker image or deploy to ECS: ${error}`);
      }
    } catch (error) {
      logger.error(`[context] GitHub repo deployment failed: ${error}`, context);
      this.lastPublicEndpoint = undefined;
      // TODO: metrics: increment github_deploy_failed
      return false;
    } finally {
      if (repoDir) {
        logger.info(`[context] Cleaning up repository directory: ${repoDir}`, context);
        await this.gitUtils.cleanupRepository(repoDir);
      }
    }
  }

  getPublicEndpoint(): string | undefined {
    return this.lastPublicEndpoint;
  }
}
