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

  constructor() {
    this.gitUtils = new GitUtils();
    this.ecsService = new ECSService();
    this.ecrService = new ECRService();
    this.dockerfileGenerator = new DockerfileGenerator();
  }

  async deploy(payload: DeploymentRequestPayload): Promise<boolean> {
    logger.info(`Starting GitHub repo deployment for service ID: ${payload.serviceId}`);

    if (!payload.githubRepository) {
      throw new Error('GitHub repository information is missing');
    }

    const { url, branch } = payload.githubRepository;
    const token = payload.github_token;

    let repoDir = '';

    try {
      // Clone the repository
      repoDir = await this.gitUtils.cloneRepository({
        url,
        branch,
        token
      });

      // Check if Dockerfile exists
      const dockerfilePath = path.join(repoDir, 'Dockerfile');
      if (!fs.existsSync(dockerfilePath)) {
        logger.info(`Dockerfile not found in the repository. Attempting to generate one...`);

        // Detect project type
        const projectType = this.dockerfileGenerator.detectProjectType(repoDir);

        if (projectType === ProjectType.UNKNOWN) {
          throw new Error('Unable to determine project type. Cannot generate Dockerfile.');
        }

        logger.info(`Detected project type: ${projectType}`);

        // Generate Dockerfile
        const success = this.dockerfileGenerator.generateDockerfile(projectType, repoDir);

        if (!success) {
          throw new Error(`Failed to generate Dockerfile for ${projectType} project.`);
        }

        logger.info(`Successfully generated Dockerfile for ${projectType} project.`);
      }

      // Build and push Docker image
      const imageTag = `${payload.projectSlug}-${payload.serviceId}-${Date.now()}`;

      try {
        const imageUri = await this.ecrService.buildAndPushImage(repoDir, imageTag);

        // Create or update ECS service
        const serviceName = `${payload.projectSlug}-${payload.serviceId}`;
        const environmentVariables = payload.metadata?.environmentValues || {};

        // Deploy to ECS
        await this.ecsService.deployService(
          serviceName,
          imageUri,
          environmentVariables
        );
      } catch (error) {
        logger.error(`Failed to build and push Docker image: ${error}`);
        throw new Error(`Failed to push Docker image: ${error}`);
      }

      logger.info(`GitHub repo deployment completed for service ID: ${payload.serviceId}`);
      return true;
    } catch (error) {
      logger.error(`GitHub repo deployment failed: ${error}`);
      return false;
    } finally {
      // Clean up repository directory
      if (repoDir) {
        await this.gitUtils.cleanupRepository(repoDir);
      }
    }
  }
}
