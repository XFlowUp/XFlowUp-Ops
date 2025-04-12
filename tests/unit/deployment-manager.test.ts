import { DeploymentManager, ServiceType, DeploymentStatus } from '../../src/services/deployment/deployment-manager';
import { GithubRepoStrategy } from '../../src/services/deployment/strategies/github-repo-strategy';
import { DockerImageStrategy } from '../../src/services/deployment/strategies/docker-image-strategy';
import { SQSProducer } from '../../src/services/sqs/sqs-producer';

// Set NODE_ENV to test
process.env.NODE_ENV = 'test';

// Mock the strategies and SQS producer
jest.mock('../../src/services/deployment/strategies/github-repo-strategy');
jest.mock('../../src/services/deployment/strategies/docker-image-strategy');
jest.mock('../../src/services/sqs/sqs-producer');

describe('DeploymentManager', () => {
  let deploymentManager: DeploymentManager;
  let mockGithubRepoStrategy: jest.Mocked<GithubRepoStrategy>;
  let mockDockerImageStrategy: jest.Mocked<DockerImageStrategy>;
  let mockSQSProducer: jest.Mocked<SQSProducer>;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Create mock instances
    mockGithubRepoStrategy = new GithubRepoStrategy() as jest.Mocked<GithubRepoStrategy>;
    mockDockerImageStrategy = new DockerImageStrategy() as jest.Mocked<DockerImageStrategy>;
    mockSQSProducer = new SQSProducer() as jest.Mocked<SQSProducer>;

    // Set up the mock implementations
    (GithubRepoStrategy as jest.MockedClass<typeof GithubRepoStrategy>).mockImplementation(() => mockGithubRepoStrategy);
    (DockerImageStrategy as jest.MockedClass<typeof DockerImageStrategy>).mockImplementation(() => mockDockerImageStrategy);
    (SQSProducer as jest.MockedClass<typeof SQSProducer>).mockImplementation(() => mockSQSProducer);

    // Create a new instance for each test
    deploymentManager = new DeploymentManager();
  });

  test('should handle GitHub repo deployment request successfully', async () => {
    // Mock successful deployment
    mockGithubRepoStrategy.deploy.mockResolvedValue(true);
    mockSQSProducer.sendMessage.mockResolvedValue('test-message-id');

    // Create test payload
    const payload = {
      type: ServiceType.GITHUB_REPO,
      environmentId: 1,
      projectSlug: 'test-project',
      serviceId: 123,
      userId: 456,
      githubRepository: {
        url: 'https://github.com/test/repo',
        branch: 'main'
      },
      metadata: {
        environmentId: '1',
        environmentValues: {
          PORT: '3000'
        }
      }
    };

    // Handle the deployment request
    await deploymentManager.handleDeploymentRequest(payload);

    // Verify that the GitHub repo strategy was called
    expect(mockGithubRepoStrategy.deploy).toHaveBeenCalledWith(payload);

    // Verify that status updates were sent
    expect(mockSQSProducer.sendMessage).toHaveBeenCalledTimes(2);

    // First call should be for IN_PROGRESS status
    expect(mockSQSProducer.sendMessage.mock.calls[0][0]).toMatchObject({
      serviceId: 123,
      projectSlug: 'test-project',
      status: DeploymentStatus.IN_PROGRESS
    });

    // Second call should be for COMPLETED status
    expect(mockSQSProducer.sendMessage.mock.calls[1][0]).toMatchObject({
      serviceId: 123,
      projectSlug: 'test-project',
      status: DeploymentStatus.COMPLETED
    });
  });

  test('should handle Docker image deployment request successfully', async () => {
    // Mock successful deployment
    mockDockerImageStrategy.deploy.mockResolvedValue(true);
    mockSQSProducer.sendMessage.mockResolvedValue('test-message-id');

    // Create test payload
    const payload = {
      type: ServiceType.DOCKER_IMAGE,
      environmentId: 1,
      projectSlug: 'test-project',
      serviceId: 123,
      userId: 456,
      docker_image_url: 'docker.io/test/image',
      docker_image_tag: 'latest',
      metadata: {
        environmentId: '1',
        environmentValues: {
          PORT: '3000'
        }
      }
    };

    // Handle the deployment request
    await deploymentManager.handleDeploymentRequest(payload);

    // Verify that the Docker image strategy was called
    expect(mockDockerImageStrategy.deploy).toHaveBeenCalledWith(payload);

    // Verify that status updates were sent
    expect(mockSQSProducer.sendMessage).toHaveBeenCalledTimes(2);

    // First call should be for IN_PROGRESS status
    expect(mockSQSProducer.sendMessage.mock.calls[0][0]).toMatchObject({
      serviceId: 123,
      projectSlug: 'test-project',
      status: DeploymentStatus.IN_PROGRESS
    });

    // Second call should be for COMPLETED status
    expect(mockSQSProducer.sendMessage.mock.calls[1][0]).toMatchObject({
      serviceId: 123,
      projectSlug: 'test-project',
      status: DeploymentStatus.COMPLETED
    });
  });

  test('should handle deployment failure correctly', async () => {
    // Mock failed deployment
    mockGithubRepoStrategy.deploy.mockResolvedValue(false);
    mockSQSProducer.sendMessage.mockResolvedValue('test-message-id');

    // Create test payload
    const payload = {
      type: ServiceType.GITHUB_REPO,
      environmentId: 1,
      projectSlug: 'test-project',
      serviceId: 123,
      userId: 456,
      githubRepository: {
        url: 'https://github.com/test/repo',
        branch: 'main'
      }
    };

    // Handle the deployment request
    await deploymentManager.handleDeploymentRequest(payload);

    // Verify that the GitHub repo strategy was called
    expect(mockGithubRepoStrategy.deploy).toHaveBeenCalledWith(payload);

    // Verify that status updates were sent
    expect(mockSQSProducer.sendMessage).toHaveBeenCalledTimes(2);

    // First call should be for IN_PROGRESS status
    expect(mockSQSProducer.sendMessage.mock.calls[0][0]).toMatchObject({
      serviceId: 123,
      projectSlug: 'test-project',
      status: DeploymentStatus.IN_PROGRESS
    });

    // Second call should be for FAILED status
    expect(mockSQSProducer.sendMessage.mock.calls[1][0]).toMatchObject({
      serviceId: 123,
      projectSlug: 'test-project',
      status: DeploymentStatus.FAILED
    });
  });

  test('should handle unsupported deployment type', async () => {
    mockSQSProducer.sendMessage.mockResolvedValue('test-message-id');

    // Create test payload with unsupported type
    const payload = {
      type: 'UNSUPPORTED_TYPE' as ServiceType,
      environmentId: 1,
      projectSlug: 'test-project',
      serviceId: 123,
      userId: 456
    };

    // Handle the deployment request
    await deploymentManager.handleDeploymentRequest(payload);

    // Verify that status updates were sent
    expect(mockSQSProducer.sendMessage).toHaveBeenCalledTimes(2);

    // First call should be for IN_PROGRESS status
    expect(mockSQSProducer.sendMessage.mock.calls[0][0]).toMatchObject({
      serviceId: 123,
      projectSlug: 'test-project',
      status: DeploymentStatus.IN_PROGRESS
    });

    // Second call should be for FAILED status
    expect(mockSQSProducer.sendMessage.mock.calls[1][0]).toMatchObject({
      serviceId: 123,
      projectSlug: 'test-project',
      status: DeploymentStatus.FAILED
    });

    // Error message should include unsupported type
    expect(mockSQSProducer.sendMessage.mock.calls[1][0].error).toContain('Unsupported deployment type');
  });
});
