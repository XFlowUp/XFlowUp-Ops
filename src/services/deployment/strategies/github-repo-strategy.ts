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

  async deploy(payload: DeploymentRequestPayload, deploymentId?: string, streamLog?: (msg: string) => Promise<void>): Promise<boolean> {
    const context = {
      serviceId: payload.serviceId,
      projectSlug: payload.projectSlug,
      deploymentId: deploymentId || payload.deploymentId || payload.messageId || undefined,
      type: payload.type
    };
    logger.info(`[context] Starting GitHub repo deployment`, context);
    if (streamLog) await streamLog(`[context] Starting GitHub repo deployment: ${JSON.stringify(context)}`);
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
        logger.info(`[context] Detected project type: ${projectType}`, context);
        
        // Determine port from payload - prioritize environmentValues.PORT over top-level port
        let dockerPort = 3000;
        
        if (payload.metadata?.environmentValues?.PORT && !isNaN(Number(payload.metadata.environmentValues.PORT))) {
          dockerPort = Number(payload.metadata.environmentValues.PORT);
        } else if (payload.containerPort && !isNaN(Number(payload.containerPort))) {
          dockerPort = Number(payload.containerPort);
        } else if (payload.port && !isNaN(Number(payload.port))) {
          dockerPort = Number(payload.port);
        }
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
      if (streamLog) await streamLog(`[context] Building and pushing Docker image: ${imageTag}`);
      // TODO: metrics: increment docker_build_started
      try {
        const imageUri = await this.ecrService.buildAndPushImage(repoDir, imageTag, streamLog);
        logger.info(`[context] Docker image built and pushed: ${imageUri}`, context);
        if (streamLog) await streamLog(`[context] Docker image built and pushed: ${imageUri}`);
        // TODO: metrics: increment docker_build_success
        
        // Create or update ECS service
        const serviceName = `${payload.projectSlug}-${payload.serviceId}`;
        const environmentVariables = payload.metadata?.environmentValues || {};
        let containerPort = 3000;
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
        if (streamLog) await streamLog(`[context] Deploying to ECS: ${serviceName} on port ${containerPort}`);
        // TODO: metrics: increment ecs_deploy_started        // Ensure we have a valid deploymentId
        const effectiveDeploymentId = payload.deploymentId || context.deploymentId || `manual-deploy-${Date.now()}`;
        logger.info(`[context] Using deployment ID for CloudWatch logs: ${effectiveDeploymentId}`, context);
        
        const ecsResult = await this.ecsService.deployService(
          serviceName,
          imageUri,
          environmentVariables,
          containerPort,
          undefined, // customDomain
          undefined, // healthCheckPath
          effectiveDeploymentId,
          streamLog
        );
        logger.info(`[context] ECS deployment result: ${JSON.stringify(ecsResult)}`, context);
        if (streamLog) await streamLog(`[context] ECS deployment result: ${JSON.stringify(ecsResult)}`);
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
