import { DockerfileGenerator, ProjectType } from '../../src/services/dockerfile/dockerfile-generator';
import fs from 'fs';
import path from 'path';

// Set NODE_ENV to test
process.env.NODE_ENV = 'test';

// Mock fs module
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readdirSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

describe('DockerfileGenerator', () => {
  let dockerfileGenerator: DockerfileGenerator;

  beforeEach(() => {
    dockerfileGenerator = new DockerfileGenerator();
    jest.clearAllMocks();
  });

  describe('detectProjectType', () => {
    it('should detect Node.js project', () => {
      // Mock fs.existsSync to return true for package.json
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        return path.endsWith('package.json');
      });

      const projectType = dockerfileGenerator.detectProjectType('/test/repo');
      expect(projectType).toBe(ProjectType.NODE_JS);
    });

    it('should detect Python project', () => {
      // Mock fs.existsSync to return true for requirements.txt
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        return path.endsWith('requirements.txt');
      });

      const projectType = dockerfileGenerator.detectProjectType('/test/repo');
      expect(projectType).toBe(ProjectType.PYTHON);
    });

    it('should detect Java project', () => {
      // Mock fs.existsSync to return true for pom.xml
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        return path.endsWith('pom.xml');
      });

      const projectType = dockerfileGenerator.detectProjectType('/test/repo');
      expect(projectType).toBe(ProjectType.JAVA);
    });

    it('should return UNKNOWN for unrecognized project', () => {
      // Mock fs.existsSync to return false for all files
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      (fs.readdirSync as jest.Mock).mockReturnValue([]);

      const projectType = dockerfileGenerator.detectProjectType('/test/repo');
      expect(projectType).toBe(ProjectType.UNKNOWN);
    });
  });

  describe('generateDockerfile', () => {
    it('should generate Dockerfile for Node.js project', () => {
      // Mock fs.existsSync and fs.readFileSync
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        return path.endsWith('package.json');
      });
      (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({
        scripts: {
          start: 'node server.js'
        }
      }));

      const success = dockerfileGenerator.generateDockerfile(ProjectType.NODE_JS, '/test/repo');

      expect(success).toBe(true);
      expect(fs.writeFileSync).toHaveBeenCalled();

      // Get the Dockerfile content from the mock call
      const dockerfileContent = (fs.writeFileSync as jest.Mock).mock.calls[0][1];

      // Verify the Dockerfile content
      expect(dockerfileContent).toContain('FROM node:18-alpine');
      expect(dockerfileContent).toContain('WORKDIR /app');
      expect(dockerfileContent).toContain('COPY package*.json ./');
      expect(dockerfileContent).toContain('RUN npm ci');
      expect(dockerfileContent).toContain('COPY . .');
      expect(dockerfileContent).toContain('EXPOSE 3000');
      expect(dockerfileContent).toContain('CMD ["npm", "start"]');
    });

    it('should generate Dockerfile for Python project', () => {
      // Mock fs.existsSync
      (fs.existsSync as jest.Mock).mockImplementation((path: string) => {
        return path.endsWith('requirements.txt');
      });

      const success = dockerfileGenerator.generateDockerfile(ProjectType.PYTHON, '/test/repo');

      expect(success).toBe(true);
      expect(fs.writeFileSync).toHaveBeenCalled();

      // Get the Dockerfile content from the mock call
      const dockerfileContent = (fs.writeFileSync as jest.Mock).mock.calls[0][1];

      // Verify the Dockerfile content
      expect(dockerfileContent).toContain('FROM python:3.9-slim');
      expect(dockerfileContent).toContain('WORKDIR /app');
      expect(dockerfileContent).toContain('COPY requirements.txt .');
      expect(dockerfileContent).toContain('RUN pip install --no-cache-dir -r requirements.txt');
      expect(dockerfileContent).toContain('COPY . .');
      expect(dockerfileContent).toContain('EXPOSE 8000');
    });

    it('should return false for UNKNOWN project type', () => {
      const success = dockerfileGenerator.generateDockerfile(ProjectType.UNKNOWN, '/test/repo');
      expect(success).toBe(false);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });
});
