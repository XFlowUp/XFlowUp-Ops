import { Injectable } from '@nestjs/common';
import { execSync } from 'child_process';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import logger from '../utils/logger';

@Injectable()
export class DockerService {
  /**
   * Build a Docker image from a directory, tag it, scan it, and push to ECR.
   * Throws on any error (including vulnerabilities).
   * @param repoDir Path to the directory containing the Dockerfile
   * @param imageTag Full image tag (e.g. 123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/my-repo:my-tag)
   * @returns The image tag that was pushed
   */
  async buildAndPushImage(repoDir: string, imageTag: string): Promise<string> {
    // Ensure repoDir exists
    if (!existsSync(repoDir)) {
      logger.error(`Repo directory does not exist: ${repoDir}`);
      throw new Error(`Repo directory does not exist: ${repoDir}`);
    }
    // Build image
    logger.info(`[DockerService] Building Docker image: ${imageTag}`);
    execSync(`docker build -t ${imageTag} ${repoDir}`, { stdio: 'inherit' });
    // Security scan (Trivy)
    logger.info(`[DockerService] Scanning Docker image for vulnerabilities: ${imageTag}`);
    try {
      execSync(`trivy image --exit-code 1 --severity CRITICAL,HIGH ${imageTag}`, { stdio: 'inherit' });
    } catch (err) {
      logger.error(`[DockerService] Docker image failed security scan: ${imageTag}`);
      throw new Error(`Docker image failed security scan: ${imageTag}`);
    }
    // Login to ECR (assumes AWS CLI v2 is configured)
    logger.info('[DockerService] Logging in to ECR...');
    execSync(`aws ecr get-login-password | docker login --username AWS --password-stdin ${this.getRegistry(imageTag)}`, { stdio: 'inherit' });
    // Push image
    logger.info(`[DockerService] Pushing Docker image to ECR: ${imageTag}`);
    execSync(`docker push ${imageTag}`, { stdio: 'inherit' });
    logger.info(`[DockerService] Image pushed successfully: ${imageTag}`);
    return imageTag;
  }

  /**
   * Extract the registry from a full image tag
   */
  private getRegistry(imageTag: string): string {
    // e.g. 123456789012.dkr.ecr.ap-southeast-1.amazonaws.com
    return imageTag.split('/')[0];
  }

  private log(msg: string) {
    logger.info(`[DockerService] ${msg}`);
  }
}
