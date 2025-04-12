import {
  ECR,
  GetAuthorizationTokenCommand,
  DescribeRepositoriesCommand,
  CreateRepositoryCommand
} from '@aws-sdk/client-ecr';
import { exec } from 'child_process';
import { promisify } from 'util';
import dotenv from 'dotenv';
import logger from '../../utils/logger';
import path from 'path';

dotenv.config();
const execAsync = promisify(exec);

export class ECRService {
  private ecr: ECR;
  private repositoryUri: string;
  private region: string;

  constructor() {
    this.region = process.env.AWS_REGION || '';
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID || '';
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || '';

    if (!this.region || !accessKeyId || !secretAccessKey) {
      throw new Error('Missing AWS configuration');
    }

    this.ecr = new ECR({
      region: this.region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    // Get the ECR repository URI from environment variables
    const accountId = process.env.AWS_ACCOUNT_ID || '';
    const ecrRepo = process.env.AWS_ECR_REPOSITORY || 'xflowup';

    if (!accountId) {
      // For local testing, use a local Docker Hub repository
      this.repositoryUri = 'localhost:5000/xflowup';
      logger.info(`Using local Docker repository URI: ${this.repositoryUri}`);
    } else {
      // Use AWS ECR repository
      this.repositoryUri = `${accountId}.dkr.ecr.${this.region}.amazonaws.com/${ecrRepo}`;
      logger.info(`Using ECR repository URI: ${this.repositoryUri}`);
    }
  }

  async buildAndPushImage(repoDir: string, imageTag: string): Promise<string> {
    try {
      logger.info(`Building and pushing Docker image with tag: ${imageTag}`);

      // Build Docker image first (this doesn't require AWS connectivity)
      const fullImageTag = `${this.repositoryUri}:${imageTag}`;
      await this.buildImage(repoDir, fullImageTag);
      logger.info(`Successfully built Docker image: ${fullImageTag}`);

      try {
        // Get ECR authentication token
        const authData = await this.getAuthToken();

        // Extract repository name from URI
        const repositoryName = this.repositoryUri.split('/').pop() || '';

        // Ensure repository exists
        await this.ensureRepositoryExists(repositoryName);

        // Login to ECR
        await this.dockerLogin(authData.authorizationToken, authData.proxyEndpoint);

        // Push image to ECR
        await this.pushImage(fullImageTag);

        logger.info(`Successfully pushed image to ECR: ${fullImageTag}`);
      } catch (error) {
        logger.error(`Failed to push image to ECR: ${error}`);
        logger.info('Using locally built image instead of pushing to ECR');
        // We'll continue with the local image instead of failing the deployment
      }

      return fullImageTag;
    } catch (error) {
      logger.error(`Failed to build and push image: ${error}`);
      throw error;
    }
  }

  private async getAuthToken(): Promise<{ authorizationToken: string; proxyEndpoint: string }> {
    const response = await this.ecr.send(new GetAuthorizationTokenCommand({}));

    if (!response.authorizationData || response.authorizationData.length === 0) {
      throw new Error('Failed to get ECR authorization token');
    }

    const authData = response.authorizationData[0];
    const authorizationToken = authData.authorizationToken || '';
    const proxyEndpoint = authData.proxyEndpoint || '';

    return { authorizationToken, proxyEndpoint };
  }

  private async ensureRepositoryExists(repositoryName: string): Promise<void> {
    try {
      // Check if repository exists
      await this.ecr.send(
        new DescribeRepositoriesCommand({
          repositoryNames: [repositoryName],
        })
      );
    } catch (error: any) {
      // If repository doesn't exist, create it
      if (error.name === 'RepositoryNotFoundException') {
        logger.info(`Creating ECR repository: ${repositoryName}`);
        await this.ecr.send(
          new CreateRepositoryCommand({
            repositoryName,
          })
        );
      } else {
        throw error;
      }
    }
  }

  private async buildImage(repoDir: string, imageTag: string): Promise<void> {
    try {
      const { stdout, stderr } = await execAsync(`docker build -t ${imageTag} ${repoDir}`);
      logger.debug(`Docker build stdout: ${stdout}`);
      if (stderr) {
        logger.warn(`Docker build stderr: ${stderr}`);
      }
    } catch (error: any) {
      logger.error(`Docker build error: ${error.message}`);
      throw new Error(`Failed to build Docker image: ${error.message}`);
    }
  }

  private async dockerLogin(authorizationToken: string, proxyEndpoint: string): Promise<void> {
    try {
      // Decode auth token (format: 'AWS:base64-encoded-string')
      const decodedToken = Buffer.from(authorizationToken, 'base64').toString('utf-8');
      const [username, password] = decodedToken.split(':');

      // Extract registry URL from proxy endpoint (remove https://)
      const registry = proxyEndpoint.replace('https://', '');

      // Login to Docker
      const { stdout, stderr } = await execAsync(
        `docker login --username ${username} --password ${password} ${registry}`
      );

      logger.debug(`Docker login stdout: ${stdout}`);
      if (stderr) {
        logger.warn(`Docker login stderr: ${stderr}`);
      }
    } catch (error: any) {
      logger.error(`Docker login error: ${error.message}`);
      throw new Error(`Failed to login to ECR: ${error.message}`);
    }
  }

  private async pushImage(imageTag: string): Promise<void> {
    try {
      const { stdout, stderr } = await execAsync(`docker push ${imageTag}`);
      logger.debug(`Docker push stdout: ${stdout}`);
      if (stderr) {
        logger.warn(`Docker push stderr: ${stderr}`);
      }
    } catch (error: any) {
      logger.error(`Docker push error: ${error.message}`);
      throw new Error(`Failed to push Docker image: ${error.message}`);
    }
  }
}
