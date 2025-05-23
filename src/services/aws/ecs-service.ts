import {
  ECS,
  CreateServiceCommand,
  UpdateServiceCommand,
  DeleteServiceCommand,
  DescribeServicesCommand,
  RegisterTaskDefinitionCommand,
  ContainerDefinition,
  KeyValuePair,
  ListTasksCommand,
  DescribeTasksCommand
} from '@aws-sdk/client-ecs';
import { IAM, GetRoleCommand } from '@aws-sdk/client-iam';
import { ElasticLoadBalancingV2 } from '@aws-sdk/client-elastic-load-balancing-v2';
import dotenv from 'dotenv';
import logger from '../../utils/logger';
import { CloudflareDNS } from '../../utils/cloudflare-dns';
import { EC2, DescribeNetworkInterfacesCommand } from './ec2-imports';

dotenv.config();

export class ECSService {
  private ecs: ECS;
  private iam: IAM;
  private elbv2: ElasticLoadBalancingV2;
  private ec2: EC2;
  private cluster: string;
  private executionRoleArn: string;
  private vpcId: string;
  private subnetIds: string[];
  private securityGroupId: string;
  private logGroup: string;
  private forceRecreateService: boolean;
  private roleExists: boolean = false;

  constructor() {
    const region = process.env.AWS_REGION;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

    if (!region || !accessKeyId || !secretAccessKey) {
      throw new Error('Missing AWS configuration');
    }

    // Initialize ECS client
    this.ecs = new ECS({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    // Initialize IAM client
    this.iam = new IAM({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    // Initialize ELBv2 client
    this.elbv2 = new ElasticLoadBalancingV2({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    // Initialize EC2 client
    this.ec2 = new EC2({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    this.cluster = process.env.AWS_ECS_CLUSTER || '';
    this.executionRoleArn = process.env.AWS_ECS_EXECUTION_ROLE_ARN || '';
    // VPC, subnet, and security group are now optional for public IP deployments
    this.vpcId = process.env.AWS_VPC_ID || '';
    const subnetIdsStr = process.env.AWS_SUBNET_IDS || '';
    this.subnetIds = subnetIdsStr ? subnetIdsStr.split(',').filter(id => id.trim() !== '') : [];
    this.securityGroupId = process.env.AWS_SECURITY_GROUP_ID || '';
    this.logGroup = process.env.AWS_CLOUDWATCH_LOG_GROUP || '/ecs/deployment-worker';

    if (!this.cluster || !this.executionRoleArn) {
      throw new Error('Missing ECS configuration');
    }

    // Initialize force recreate option
    this.forceRecreateService = process.env.AWS_ECS_FORCE_RECREATE_SERVICE === 'true';

    // Log the configuration
    logger.info(`ECS Service initialized with cluster: ${this.cluster}`);
    logger.info(`Using execution role ARN: ${this.executionRoleArn}`);
    if (this.subnetIds.length > 0) logger.info(`Using subnets: ${this.subnetIds.join(', ')}`);
    if (this.securityGroupId) logger.info(`Using security group: ${this.securityGroupId}`);
    logger.info(`Force recreate service: ${this.forceRecreateService}`);

    // Check if the execution role exists
    this.checkExecutionRoleExists();
  }

  private async checkExecutionRoleExists(): Promise<void> {
    try {
      // Extract the role name from the ARN
      const roleName = this.executionRoleArn.split('/').pop();

      if (!roleName) {
        logger.warn(`Could not extract role name from ARN: ${this.executionRoleArn}`);
        return;
      }

      logger.info(`Checking if execution role exists: ${roleName}`);

      const response = await this.iam.send(
        new GetRoleCommand({
          RoleName: roleName,
        })
      );

      if (response.Role) {
        logger.info(`Execution role exists: ${roleName}`);
        this.roleExists = true;
      }
    } catch (error) {
      logger.warn(`Execution role does not exist or cannot be accessed: ${error}`);
      logger.warn('You may need to create the ecsTaskExecutionRole with the AmazonECSTaskExecutionRolePolicy attached.');

      // We'll continue anyway, but the deployment will likely fail if the role doesn't exist
      this.roleExists = false;
    }
  }

  /**
   * Deploy ECS service and optionally link a custom domain.
   * @param serviceName
   * @param imageUri
   * @param environmentVariables
   * @param containerPort
   * @param customDomain (optional) - full domain to link, e.g. app.example.com
   * @param healthCheckPath (optional) - health check path
   */  async deployService(
    serviceName: string,
    imageUri: string,
    environmentVariables: Record<string, string> = {},
    containerPort?: number,
    customDomain?: string,
    healthCheckPath?: string, // Optional health check path
    deploymentId?: string // Added deploymentId parameter
  ): Promise<{ serviceName: string; publicEndpoint?: string; healthy: boolean; healthError?: string; customDomainUrl?: string; logStreamName?: string }> {
    let publicEndpoint: string | undefined;
    let logStreamName: string | undefined;
    try {
      logger.info(`Deploying ECS service: ${serviceName} with image: ${imageUri}`);
      const port = containerPort || 3000;      // Register task definition outside the inner try block so it's available in the catch block
      logger.info(`Registering task definition for service: ${serviceName}`);
      const taskDefinitionArn = await this.registerTaskDefinition(
        serviceName,
        imageUri,
        environmentVariables,
        port,
        deploymentId
      );
      logger.info(`Task definition registered with ARN: ${taskDefinitionArn}`);

      try {
        // Check if service exists and is active
        logger.info(`Checking if service ${serviceName} exists and is active`);
        const serviceStatus = await this.checkServiceExists(serviceName);

        if (serviceStatus.exists) {
          if (this.forceRecreateService) {
            // Force recreate the service regardless of its state
            logger.info(`Force recreate option is enabled. Deleting and recreating service: ${serviceName}`);
            const deleted = await this.deleteService(serviceName);

            // Wait a moment after deletion
            await new Promise(resolve => setTimeout(resolve, 5000));

            if (deleted) {
              logger.info(`Creating new service after force deletion: ${serviceName}`);
              publicEndpoint = await this.createService(serviceName, taskDefinitionArn, port, healthCheckPath);
            } else {
              logger.error(`Failed to delete service ${serviceName} for force recreation.`);
              return { serviceName, healthy: false, healthError: 'Failed to delete service for force recreation.', publicEndpoint: undefined };
            }
          } else if (serviceStatus.isActive) {
            // Update existing active service
            logger.info(`Updating existing active service: ${serviceName}`);
            publicEndpoint = await this.updateService(serviceName, taskDefinitionArn, port, healthCheckPath);
          } else {
            // Service exists but is not active - delete and recreate
            logger.info(`Service ${serviceName} exists but is not in ACTIVE state. Deleting and recreating...`);
            const deleted = await this.deleteService(serviceName);

            // Wait a moment after deletion
            await new Promise(resolve => setTimeout(resolve, 5000));

            if (deleted) {
              logger.info(`Creating new service after non-active deletion: ${serviceName}`);
              publicEndpoint = await this.createService(serviceName, taskDefinitionArn, port, healthCheckPath);
            } else {
              logger.error(`Failed to delete non-active service ${serviceName} for recreation.`);
              return { serviceName, healthy: false, healthError: 'Failed to delete non-active service for recreation.', publicEndpoint: undefined };
            }
          }
        } else {
          // Create new service
          logger.info(`Creating new service: ${serviceName}`);
          publicEndpoint = await this.createService(serviceName, taskDefinitionArn, port, healthCheckPath);
        }

        logger.info(`Successfully deployed ECS service: ${serviceName}`);
      } catch (error: any) {
        // Provide more detailed error information
        if (error.name === 'ServiceNotActiveException') {
          logger.error(`ECS deployment error: Service is not active. ${error.message}`);
          // ... (rest of specific error handling)
          return { serviceName, healthy: false, healthError: 'ServiceNotActiveException, failed to recreate.', publicEndpoint: undefined };
        } else if (error.name === 'InvalidParameterException' && error.message.includes('still Draining')) {
          // ... (rest of specific error handling)
          return { serviceName, healthy: false, healthError: 'Service was draining and had to be recreated.', publicEndpoint: undefined };
        } else if (error.name === 'ClientException' && error.message.includes('networkMode=awsvpc')) {
          // ... (rest of specific error handling)
          return { serviceName, healthy: false, healthError: 'awsvpc network mode port mismatch.', publicEndpoint: undefined };
        } else if (error.name === 'InvalidParameterException' && error.message.includes('subnet')) {
          // ... (rest of specific error handling)
          return { serviceName, healthy: false, healthError: 'Invalid subnet configuration.', publicEndpoint: undefined };
        } else if (error.name === 'InvalidParameterException' && error.message.includes('security group')) {
          // ... (rest of specific error handling)
          return { serviceName, healthy: false, healthError: 'Invalid security group configuration.', publicEndpoint: undefined };
        } else {
          logger.error(`Failed to deploy to ECS: ${error}`);
          return { serviceName, healthy: false, healthError: `Failed to deploy to ECS: ${error.message}`, publicEndpoint: undefined };
        }
      }

      // publicEndpoint should have been set by createService or updateService call.
      if (!publicEndpoint) {
        logger.error(`ALB DNS (publicEndpoint) was not set after service create/update for ${serviceName}. This indicates an issue in the deployment flow.`);
        return { serviceName, healthy: false, healthError: 'Failed to obtain ALB DNS during deployment.', publicEndpoint: undefined };
      }
      // Health check logic
      const { healthy, healthError } = await this.waitForServiceHealthy(serviceName, publicEndpoint, healthCheckPath);
      if (!healthy) {
        logger.error(`ECS service ${serviceName} is not healthy: ${healthError}`);
      }
      // Fetch running task ID to construct log stream name
      try {
        const taskId = await this.getRunningTaskId(serviceName);
        if (taskId) {
          const streamPrefix = deploymentId || serviceName;
          logStreamName = `${streamPrefix}/${serviceName}/${taskId}`;
        }
      } catch (err) {
        logger.warn(`Could not fetch ECS task ID for log stream name: ${err}`);
      }
      // Link custom domain if provided and public endpoint is available
      let customDomainUrl: string | undefined = undefined;
      if (customDomain && publicEndpoint) {
        logger.info(`Linking custom domain ${customDomain} to ECS service ${serviceName}`);
        const dnsResult = await this.linkCustomDomain(customDomain, publicEndpoint);
        if (dnsResult) {
          customDomainUrl = customDomain;
          logger.info(`Custom domain ${customDomain} successfully linked to ${publicEndpoint}`);
        } else {
          logger.warn(`Failed to link custom domain ${customDomain}`);
        }
      }
      return { serviceName, publicEndpoint, healthy, healthError, customDomainUrl, logStreamName };
    } catch (error) {
      logger.error(`Failed to deploy service: ${error}`);
      throw error;
    }
  }

  // Helper to get the running ECS task ID for a service
  private async getRunningTaskId(serviceName: string): Promise<string | undefined> {
    try {
      const listTasksRes = await this.ecs.send(new ListTasksCommand({
        cluster: this.cluster,
        serviceName,
        desiredStatus: 'RUNNING',
        maxResults: 1
      }));
      if (listTasksRes.taskArns && listTasksRes.taskArns.length > 0) {
        const taskArn = listTasksRes.taskArns[0];
        const taskId = taskArn.split('/').pop();
        return taskId;
      }
    } catch (err) {
      logger.warn(`Error fetching running ECS task ID: ${err}`);
    }
    return undefined;
  }

  private async registerTaskDefinition(
    serviceName: string,
    imageUri: string,
    environmentVariables: Record<string, string>,
    containerPort: number,
    deploymentId?: string
  ): Promise<string> {
    // Convert environment variables to ECS format
    const environment: KeyValuePair[] = Object.entries(environmentVariables).map(
      ([name, value]) => ({
        name,
        value,
      })
    );

    // Create container definition
    const containerDefinition: ContainerDefinition = {
      name: serviceName,
      image: imageUri,
      essential: true,
      environment,
      portMappings: [
        {
          containerPort,
          hostPort: containerPort,
          protocol: 'tcp',
        },
      ],
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': this.logGroup,
          'awslogs-region': process.env.AWS_REGION || 'ap-southeast-1',
          'awslogs-create-group': 'true',
          'awslogs-stream-prefix': deploymentId || serviceName,
        },
      },
    };      // Log the execution role being used
    logger.info(`Using execution role ARN: ${this.executionRoleArn}`);
      // Log CloudWatch configuration
    logger.info(`Using deploymentId as log stream name: ${deploymentId || 'undefined, falling back to serviceName'}`);
    this.logCloudWatchConfig(deploymentId, serviceName);

    // Check if the role exists
    if (!this.roleExists) {
      logger.warn('The execution role may not exist or cannot be accessed.');
      logger.warn('Attempting to register task definition anyway, but it may fail.');
      logger.warn('Please ensure the ecsTaskExecutionRole exists with the AmazonECSTaskExecutionRolePolicy attached.');
    }

    // Register task definition
    try {
      // Extract role name from ARN for better error messages
      const roleName = this.executionRoleArn.split('/').pop() || 'unknown';

      const response = await this.ecs.send(
        new RegisterTaskDefinitionCommand({
          family: serviceName,
          executionRoleArn: this.executionRoleArn,
          taskRoleArn: this.executionRoleArn, // Use the same role for task role
          networkMode: 'awsvpc',
          requiresCompatibilities: ['FARGATE'],
          cpu: '256', // 0.25 vCPU
          memory: '512', // 0.5 GB
          containerDefinitions: [containerDefinition],
        })
      );

      logger.info(`Task definition registered successfully with ARN: ${response.taskDefinition?.taskDefinitionArn}`);
      return response.taskDefinition?.taskDefinitionArn || '';
    } catch (error: any) {
      if (error.name === 'InvalidParameterException' && error.message.includes('Unable to assume role')) {
        logger.error(`Error registering task definition: ${error.message}`);
        logger.error('The specified execution role does not exist or does not have the correct permissions.');
        logger.error('Please create the ecsTaskExecutionRole with the AmazonECSTaskExecutionRolePolicy attached.');
        logger.error('You can create this role in the AWS IAM console or using the AWS CLI.');
        logger.error('AWS CLI command to create the role:');
        logger.error('aws iam create-role --role-name ecsTaskExecutionRole --assume-role-policy-document \'{\'Version\':\'2012-10-17\',\'Statement\':[{\'Effect\':\'Allow\',\'Principal\':{\'\'Service\'\':[\'ecs-tasks.amazonaws.com\']},\'Action\':\'sts:AssumeRole\'}]}\'');
        logger.error('AWS CLI command to attach the policy:');
        logger.error('aws iam attach-role-policy --role-name ecsTaskExecutionRole --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy');
        throw new Error(`Failed to register task definition: ${error.message}`);
      }
      throw error;
    }
  }

  private async checkServiceExists(serviceName: string): Promise<{ exists: boolean; isActive: boolean; serviceArn?: string }> {
    try {
      const response = await this.ecs.send(
        new DescribeServicesCommand({
          cluster: this.cluster,
          services: [serviceName],
        })
      );

      if (response.services && response.services.length > 0 && response.services[0].status !== 'INACTIVE') {
        const service = response.services[0];
        const isActive = service.status === 'ACTIVE';
        logger.info(`Service ${serviceName} exists with status: ${service.status}`);
        return {
          exists: true,
          isActive,
          serviceArn: service.serviceArn
        };
      }

      logger.info(`Service ${serviceName} does not exist or is inactive`);
      return { exists: false, isActive: false };
    } catch (error) {
      logger.error(`Error checking if service exists: ${error}`);
      return { exists: false, isActive: false };
    }
  }

  private async deleteService(serviceName: string): Promise<boolean> {
    try {
      logger.info(`Attempting to delete service: ${serviceName}`);

      // Check current service status
      const serviceStatusResponse = await this.ecs.send(
        new DescribeServicesCommand({
          cluster: this.cluster,
          services: [serviceName],
        })
      );

      const currentService = serviceStatusResponse.services?.[0];

      if (currentService && currentService.status === 'ACTIVE') {
        // Only update desired count if the service is ACTIVE
        logger.info(`Service ${serviceName} is ACTIVE. Setting desired count to 0.`);
        await this.ecs.send(
          new UpdateServiceCommand({
            cluster: this.cluster,
            service: serviceName,
            desiredCount: 0,
          })
        );
        logger.info(`Updated service ${serviceName} to 0 desired count`);

        // Wait for the service to scale down
        logger.info(`Waiting for service ${serviceName} to scale down...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      } else if (currentService) {
        logger.info(`Service ${serviceName} is already in ${currentService.status} state. Skipping update to desired count.`);
      } else {
        logger.info(`Service ${serviceName} not found or in an unexpected state. Proceeding with deletion attempt.`);
      }

      // Now delete the service
      await this.ecs.send(
        new DeleteServiceCommand({
          cluster: this.cluster,
          service: serviceName,
          force: true, // Force delete even if there are still tasks
        })
      );

      logger.info(`Successfully deleted service: ${serviceName}`);

      // Wait for the service to fully drain before returning
      // This is important because ECS services go into DRAINING state before they're fully deleted
      logger.info(`Waiting for service ${serviceName} to fully drain...`);
      await this.waitForServiceToBeDeleted(serviceName);

      logger.info(`Service ${serviceName} has been fully drained and is ready for recreation`);
      return true;
    } catch (error) {
      logger.error(`Error deleting service: ${error}`);
      return false;
    }
  }

  private async waitForServiceToBeDeleted(serviceName: string): Promise<void> {
    const maxAttempts = 10;
    const delayBetweenAttempts = 5000; // 5 seconds

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await this.ecs.send(
          new DescribeServicesCommand({
            cluster: this.cluster,
            services: [serviceName],
          })
        );

        // If the service is not found or is inactive, it's fully deleted
        if (!response.services || response.services.length === 0 ||
            response.services[0].status === 'INACTIVE') {
          logger.info(`Service ${serviceName} is fully deleted after ${attempt + 1} attempts`);
          return;
        }

        // If the service is still draining, wait and try again
        if (response.services[0].status === 'DRAINING') {
          logger.info(`Service ${serviceName} is still in DRAINING state. Waiting... (Attempt ${attempt + 1}/${maxAttempts})`);
          await new Promise(resolve => setTimeout(resolve, delayBetweenAttempts));
          continue;
        }

        // If the service is in any other state, log it and continue waiting
        logger.info(`Service ${serviceName} is in ${response.services[0].status} state. Waiting... (Attempt ${attempt + 1}/${maxAttempts})`);
        await new Promise(resolve => setTimeout(resolve, delayBetweenAttempts));
      } catch (error) {
        // If we get an error (like service not found), the service is probably deleted
        logger.info(`Service ${serviceName} appears to be deleted (error checking status). Proceeding.`);
        return;
      }
    }

    // If we've reached the maximum number of attempts, log a warning but proceed anyway
    logger.warn(`Reached maximum wait attempts for service ${serviceName} to be deleted. Proceeding anyway.`);
  }

  private async createService(
    serviceName: string,
    taskDefinitionArn: string,
    containerPort: number,
    healthCheckPath?: string // Added healthCheckPath parameter
  ): Promise<string> { // Return ALB DNS
    try {
      logger.info(`Creating new ECS service: ${serviceName} with task definition: ${taskDefinitionArn}`);
      if (this.subnetIds.length > 0) logger.info(`Using subnets: ${this.subnetIds.join(', ')}`);
      if (this.securityGroupId) logger.info(`Using security group: ${this.securityGroupId}`);

      // --- BEGIN: Create or use Target Group ---
      // Add a unique suffix to avoid DuplicateTargetGroupNameException
      const uniqueSuffix = Date.now().toString(36).slice(-6);
      const tgName = `tg-${serviceName}`.substring(0, 25) + `-${uniqueSuffix}`;
      let tgArn: string;
      const createTgRes = await this.elbv2.createTargetGroup({
        Name: tgName,
        Protocol: 'HTTP',
        Port: containerPort,
        VpcId: this.vpcId,
        TargetType: 'ip',
        HealthCheckProtocol: 'HTTP',
        HealthCheckPath: healthCheckPath || '/', // Use provided healthCheckPath or default to '/'
      });
      tgArn = createTgRes.TargetGroups![0].TargetGroupArn!;
      logger.info(`Created new Target Group: ${tgName}`);
      // --- BEGIN: Always create a new ALB for each service ---
      let albName = `alb-${serviceName}`.substring(0, 25) + `-${uniqueSuffix}`;
      if (albName.length > 32) {
        const crypto = require('crypto');
        const hash = crypto.createHash('md5').update(serviceName + uniqueSuffix).digest('hex').substring(0, 6);
        albName = `alb-${serviceName.substring(0, 19)}-${hash}`.substring(0, 32);
      }
      const createAlbRes = await this.elbv2.createLoadBalancer({
        Name: albName,
        Subnets: this.subnetIds,
        SecurityGroups: this.securityGroupId ? [this.securityGroupId] : undefined,
        Scheme: 'internet-facing',
        Type: 'application',
      });
      const albArn = createAlbRes.LoadBalancers![0].LoadBalancerArn!;
      const albDns = createAlbRes.LoadBalancers![0].DNSName!;
      logger.info(`Created ALB: ${albName} (${albDns})`);
      // Listener on port 80 (ALB public)
      const createListenerRes = await this.elbv2.createListener({
        LoadBalancerArn: albArn,
        Protocol: 'HTTP',
        Port: 80,
        DefaultActions: [{
          Type: 'forward',
          TargetGroupArn: tgArn,
        }],
      });
      const listenerArn = createListenerRes.Listeners![0].ListenerArn!;
      logger.info(`Created Listener on ALB: ${albName}`);
      // --- END: Always create a new ALB for each service ---

      const networkConfig: any = {
        awsvpcConfiguration: {
          assignPublicIp: 'ENABLED',
        },
      };
      if (this.subnetIds.length > 0) networkConfig.awsvpcConfiguration.subnets = this.subnetIds;
      if (this.securityGroupId) networkConfig.awsvpcConfiguration.securityGroups = [this.securityGroupId];

      await this.ecs.send(
        new CreateServiceCommand({
          cluster: this.cluster,
          serviceName,
          taskDefinition: taskDefinitionArn,
          desiredCount: 1,
          launchType: 'FARGATE',
          networkConfiguration: networkConfig,
          loadBalancers: [{
            targetGroupArn: tgArn,
            containerName: serviceName,
            containerPort: containerPort,
          }],
        })
      );
      logger.info(`Service created successfully: ${serviceName}`);
      return albDns; // Return the ALB DNS name
    } catch (error: any) {
      if (error.name === 'InvalidParameterException') {
        logger.error(`Error creating service: ${error.message}`);
        if (error.message.includes('subnet')) {
          logger.error('Invalid subnet configuration. Please check your subnet IDs.');
        } else if (error.message.includes('security group')) {
          logger.error('Invalid security group configuration. Please check your security group ID.');
        } else if (error.message.includes('role')) {
          logger.error('Invalid role configuration. Please check your execution role ARN.');
        }
      }
      throw error;
    }
  }

  private async updateService(
    serviceName: string,
    taskDefinitionArn: string,
    containerPort: number,
    healthCheckPath?: string // Added healthCheckPath parameter
  ): Promise<string> { // Changed return type from Promise<void> to Promise<string>
    try {
      logger.info(`Updating existing ECS service: ${serviceName} with task definition: ${taskDefinitionArn}`);
      if (this.subnetIds.length > 0) logger.info(`Using subnets: ${this.subnetIds.join(', ')}`);
      if (this.securityGroupId) logger.info(`Using security group: ${this.securityGroupId}`);

      // --- BEGIN: Create or use Target Group ---
      const uniqueSuffix = Date.now().toString(36).slice(-6);
      const tgName = `tg-${serviceName}`.substring(0, 25) + `-${uniqueSuffix}`;
      let tgArn: string;
      const createTgRes = await this.elbv2.createTargetGroup({
        Name: tgName,
        Protocol: 'HTTP',
        Port: containerPort,
        VpcId: this.vpcId,
        TargetType: 'ip',
        HealthCheckProtocol: 'HTTP',
        HealthCheckPath: healthCheckPath || '/', // Use provided healthCheckPath or default to '/'
      });
      tgArn = createTgRes.TargetGroups![0].TargetGroupArn!;
      logger.info(`Created new Target Group: ${tgName}`);
      // --- BEGIN: Always create a new ALB for each service ---
      let albName = `alb-${serviceName}`.substring(0, 25) + `-${uniqueSuffix}`;
      if (albName.length > 32) {
        const crypto = require('crypto');
        const hash = crypto.createHash('md5').update(serviceName + uniqueSuffix).digest('hex').substring(0, 6);
        albName = `alb-${serviceName.substring(0, 19)}-${hash}`.substring(0, 32);
      }
      const createAlbRes = await this.elbv2.createLoadBalancer({
        Name: albName,
        Subnets: this.subnetIds,
        SecurityGroups: this.securityGroupId ? [this.securityGroupId] : undefined,
        Scheme: 'internet-facing',
        Type: 'application',
      });
      const albArn = createAlbRes.LoadBalancers![0].LoadBalancerArn!;
      const albDns = createAlbRes.LoadBalancers![0].DNSName!; // albDns is available here
      logger.info(`Created ALB: ${albName} (${albDns})`);
      // Listener on port 80 (ALB public)
      const createListenerRes = await this.elbv2.createListener({
        LoadBalancerArn: albArn,
        Protocol: 'HTTP',
        Port: 80,
        DefaultActions: [{
          Type: 'forward',
          TargetGroupArn: tgArn,
        }],
      });
      const listenerArn = createListenerRes.Listeners![0].ListenerArn!;
      logger.info(`Created Listener on ALB: ${albName}`);
      // --- END: Always create a new ALB for each service ---

      const networkConfig: any = {
        awsvpcConfiguration: {
          assignPublicIp: 'ENABLED',
        },
      };
      if (this.subnetIds.length > 0) networkConfig.awsvpcConfiguration.subnets = this.subnetIds;
      if (this.securityGroupId) networkConfig.awsvpcConfiguration.securityGroups = [this.securityGroupId];

      const response = await this.ecs.send(
        new UpdateServiceCommand({
          cluster: this.cluster,
          service: serviceName,
          taskDefinition: taskDefinitionArn,
          desiredCount: 1,
          forceNewDeployment: true,
          networkConfiguration: networkConfig,
          loadBalancers: [{
            targetGroupArn: tgArn,
            containerName: serviceName,
            containerPort: containerPort,
          }],
        })
      );

      logger.info(`Service updated successfully: ${response.service?.serviceArn}`);
      return albDns; // Return the ALB DNS name
    } catch (error: any) {
      if (error.name === 'InvalidParameterException') {
        logger.error(`Error updating service: ${error.message}`);
        if (error.message.includes('subnet')) {
          logger.error('Invalid subnet configuration. Please check your subnet IDs.');
        } else if (error.message.includes('security group')) {
          logger.error('Invalid security group configuration. Please check your security group ID.');
        } else if (error.message.includes('role')) {
          logger.error('Invalid role configuration. Please check your execution role ARN.');
        }
      }
      throw error;
    }
  }

  /**
   * Link a custom domain to the ECS service by updating the DNS record via Cloudflare.
   * @param customDomain The full custom domain (e.g., app.example.com)
   * @param publicEndpoint The ALB DNS name to point the domain to
   * @returns The DNS record name if successful
   */
  async linkCustomDomain(customDomain: string, publicEndpoint: string): Promise<string | null> {
    if (!customDomain || !publicEndpoint) {
      logger.warn('Custom domain or public endpoint not provided. Skipping DNS linking.');
      return null;
    }
    // Split domain into subdomain and root domain (e.g., sub.example.com -> sub, example.com)
    const parts = customDomain.split('.');
    if (parts.length < 2) {
      logger.error('Invalid custom domain format.');
      return null;
    }
    const domain = parts.slice(-2).join('.');
    const subdomain = parts.slice(0, -2).join('.') || '@';
    // Use CNAME for subdomains, A for apex if needed (Cloudflare recommends CNAME for ALB)
    const type = 'CNAME';
    logger.info(`Linking custom domain ${customDomain} to ALB endpoint ${publicEndpoint}`);
    try {
      const record = await CloudflareDNS.upsertDNSRecord(subdomain, domain, publicEndpoint, type);
      logger.info(`Custom domain ${customDomain} now points to ${publicEndpoint}`);
      return record;
    } catch (err) {
      logger.error(`Failed to link custom domain: ${err}`);
      return null;
    }
  }
  // Wait for ECS service and public IP to be healthy
  private async waitForServiceHealthy(serviceName: string, publicEndpoint?: string, healthCheckPath?: string): Promise<{ healthy: boolean; healthError?: string }> {
    // If no healthCheckPath is provided, skip public IP health check and only check ECS status
    const maxAttempts = 20;
    const delayMs = 10000; // 10 seconds
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Check ECS service health
        const response = await this.ecs.send(new DescribeServicesCommand({
          cluster: this.cluster,
          services: [serviceName],
        }));
        const service = response.services?.[0];
        if (!service) {
          return { healthy: false, healthError: 'Service not found' };
        }
        const running = service.runningCount || 0;
        const desired = service.desiredCount || 1;
        const status = service.status;
        
        logger.info(`ECS service ${serviceName} status: ${status}, running: ${running}, desired: ${desired}`);
        
        // Check if service is running with desired count
        if (status === 'ACTIVE' && running === desired && running > 0) {
          // Only check public IP endpoint if healthCheckPath is provided
          if (publicEndpoint && healthCheckPath) {
            try {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 5000);
              const res = await fetch(`http://${publicEndpoint}${healthCheckPath}`, { method: 'GET', signal: controller.signal });
              clearTimeout(timeout);
              if (res.ok) {
                logger.info(`Health check passed for public IP endpoint: http://${publicEndpoint}${healthCheckPath}`);
                return { healthy: true };
              }
            } catch (err) {
              logger.warn(`Public IP endpoint not healthy yet: ${err}`);
            }
          } else {
            // No health check path provided, consider service healthy if ECS is healthy
            logger.info(`No healthCheckPath provided, considering service healthy. ECS status: ${status}, running: ${running}/${desired}`);
            return { healthy: true };
          }
        }
        logger.info(`Waiting for ECS service to be healthy (attempt ${attempt}/${maxAttempts})... Status: ${status}, Running: ${running}/${desired}`);
        await new Promise(res => setTimeout(res, delayMs));
      } catch (err) {
        logger.warn(`Error during health check: ${err}`);
        await new Promise(res => setTimeout(res, delayMs));
      }
    }
    return { healthy: false, healthError: 'Timed out waiting for ECS service to be healthy' };
  }

  // Fetch the ALB DNS name for the service (if ALB is used)
  private async getServicePublicEndpoint(serviceName: string): Promise<string | undefined> {
    try {
      // Find the ALB for this service
      let albName = `alb-${serviceName}`;
      if (albName.length > 32) {
        const crypto = require('crypto');
        const hash = crypto.createHash('md5').update(serviceName).digest('hex').substring(0, 6);
        albName = `alb-${serviceName.substring(0, 25)}-${hash}`.substring(0, 32);
      }
      // Try to fetch by name, if not found, try to fetch by target group association
      try {
        const albs = await this.elbv2.describeLoadBalancers({ Names: [albName] });
        if (!albs.LoadBalancers || albs.LoadBalancers.length === 0) return undefined;
        const alb = albs.LoadBalancers[0];
        return alb.DNSName;
      } catch (err: any) {
        // If not found by name, try to find by target group association
        const tgName = `tg-${serviceName}`.substring(0, 32);
        const tgRes = await this.elbv2.describeTargetGroups({ Names: [tgName] });
        if (tgRes.TargetGroups && tgRes.TargetGroups.length > 0) {
          const tg = tgRes.TargetGroups[0];
          if (tg.LoadBalancerArns && tg.LoadBalancerArns.length > 0) {
            const albRes = await this.elbv2.describeLoadBalancers({ LoadBalancerArns: [tg.LoadBalancerArns[0]] });
            if (albRes.LoadBalancers && albRes.LoadBalancers.length > 0) {
              return albRes.LoadBalancers[0].DNSName;
            }
          }
        }
        return undefined;
      }
    } catch (error) {
      logger.warn(`Could not fetch ALB DNS for service ${serviceName}: ${error}`);
      return undefined;
    }
  }
  // Log the CloudWatch configuration being used
  private logCloudWatchConfig(deploymentId?: string, serviceName?: string): void {    logger.info(`Using CloudWatch log group: ${this.logGroup}`);
    logger.info(`Using CloudWatch log stream: ${deploymentId || serviceName}`);
    logger.info(`Using CloudWatch region: ${process.env.AWS_REGION || 'ap-southeast-1'}`);    logger.info(`Log configuration: ${JSON.stringify({
      logDriver: 'awslogs',
      options: {
        'awslogs-group': this.logGroup,
        'awslogs-region': process.env.AWS_REGION || 'ap-southeast-1',
        'awslogs-create-group': 'true',
        'awslogs-stream': deploymentId || serviceName
      }
    }, null, 2)}`);
    }
}
