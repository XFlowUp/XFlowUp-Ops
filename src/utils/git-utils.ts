import simpleGit, { SimpleGit } from 'simple-git';
import fs from 'fs';
import path from 'path';
import logger from './logger';

export interface GitRepository {
  url: string;
  branch: string;
  token?: string;
}

export class GitUtils {
  private git: SimpleGit;
  private tempDir: string;

  constructor() {
    this.tempDir = process.env.TEMP_REPO_DIR || './tmp/repos';
    this.git = simpleGit();
    this.ensureTempDirExists();
  }

  private ensureTempDirExists(): void {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
      logger.info(`Created temporary directory: ${this.tempDir}`);
    }
  }

  private getRepoDir(repoUrl: string): string {
    // Extract repo name from URL and create a unique directory
    const repoName = repoUrl.split('/').pop()?.replace('.git', '') || 'repo';
    const timestamp = new Date().getTime();
    return path.join(this.tempDir, `${repoName}-${timestamp}`);
  }

  async cloneRepository(repository: GitRepository): Promise<string> {
    const { url, branch, token } = repository;
    const repoDir = this.getRepoDir(url);
    
    try {
      logger.info(`Cloning repository: ${url}, branch: ${branch}`);
      
      // Construct URL with token if provided
      let cloneUrl = url;
      if (token && url.startsWith('https://')) {
        cloneUrl = url.replace('https://', `https://${token}@`);
      }
      
      await this.git.clone(cloneUrl, repoDir);
      
      // Checkout specific branch if provided
      if (branch) {
        const localGit = simpleGit(repoDir);
        await localGit.checkout(branch);
      }
      
      logger.info(`Repository cloned successfully to: ${repoDir}`);
      return repoDir;
    } catch (error) {
      logger.error(`Failed to clone repository: ${error}`);
      throw new Error(`Failed to clone repository: ${error}`);
    }
  }

  async cleanupRepository(repoDir: string): Promise<void> {
    try {
      if (fs.existsSync(repoDir)) {
        fs.rmSync(repoDir, { recursive: true, force: true });
        logger.info(`Cleaned up repository directory: ${repoDir}`);
      }
    } catch (error) {
      logger.error(`Failed to clean up repository: ${error}`);
    }
  }
}
