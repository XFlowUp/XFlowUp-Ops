import {
  ECS,
  CreateServiceCommand,
  UpdateServiceCommand,
  DeleteServiceCommand,
  DescribeServicesCommand,
  RegisterTaskDefinitionCommand,
  ContainerDefinition,
  KeyValuePair
} from '@aws-sdk/client-ecs';
import { IAM, GetRoleCommand } from '@aws-sdk/client-iam';
import { ElasticLoadBalancingV2 } from '@aws-sdk/client-elastic-load-balancing-v2';
import dotenv from 'dotenv';
import logger from '../../utils/logger';
import { CloudflareDNS } from '../../utils/cloudflare-dns';

dotenv.config();

export class ECSService {
  private ecs: ECS;
  private iam: IAM;
  private elbv2: ElasticLoadBalancingV2;
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

    this.cluster = process.env.AWS_ECS_CLUSTER || '';
    this.executionRoleArn = process.env.AWS_ECS_EXECUTION_ROLE_ARN || '';
    this.vpcId = process.env.AWS_VPC_ID || 'vpc-0123456789abcdef0';

    // Parse subnet IDs, filtering out empty strings
    const subnetIdsStr = process.env.AWS_SUBNET_IDS || 'subnet-0123456789abcdef0,subnet-0123456789abcdef1';
    this.subnetIds = subnetIdsStr.split(',').filter(id => id.trim() !== '');

    this.securityGroupId = process.env.AWS_SECURITY_GROUP_ID || 'sg-0123456789abcdef0';
    this.logGroup = process.env.AWS_CLOUDWATCH_LOG_GROUP || '/ecs/deployment-worker';

    if (!this.cluster || !this.executionRoleArn) {
      throw new Error('Missing ECS configuration');
    }

    // Initialize force recreate option
    this.forceRecreateService = process.env.AWS_ECS_FORCE_RECREATE_SERVICE === 'true';

    // Log the configuration
    logger.info(`ECS Service initialized with cluster: ${this.cluster}`);
    logger.info(`Using execution role ARN: ${this.executionRoleArn}`);
    logger.info(`Using subnets: ${this.subnetIds.join(', ')}`);
    logger.info(`Using security group: ${this.securityGroupId}`);
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
   */
  async deployService(
    serviceName: string,
    imageUri: string,
    environmentVariables: Record<string, string> = {},
    containerPort?: number,
    customDomain?: string,
    healthCheckPath?: string // Optional health check path
  ): Promise<{ serviceName: string; publicEndpoint?: string; healthy: boolean; healthError?: string; customDomainUrl?: string }> {
    try {
      logger.info(`Deploying ECS service: ${serviceName} with image: ${imageUri}`);
      const port = containerPort || 3000;

      // Register task definition outside the inner try block so it's available in the catch block
      logger.info(`Registering task definition for service: ${serviceName}`);
      const taskDefinitionArn = await this.registerTaskDefinition(
        serviceName,
        imageUri,
        environmentVariables,
        port
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
              logger.info(`Creating new service after forced deletion: ${serviceName}`);
              await this.createService(serviceName, taskDefinitionArn, port);
            } else {
              logger.warn(`Failed to delete service for forced recreation. Attempting to update: ${serviceName}`);
              try {
                await this.updateService(serviceName, taskDefinitionArn, port);
              } catch (updateError) {
                logger.error(`Failed to update service after failed forced deletion: ${updateError}`);
                throw new Error(`Service could not be deleted or updated for forced recreation: ${serviceName}`);
              }
            }
          } else if (serviceStatus.isActive) {
            // Update existing active service
            logger.info(`Updating existing active service: ${serviceName}`);
            await this.updateService(serviceName, taskDefinitionArn, port);
          } else {
            // Service exists but is not active - delete and recreate
            logger.info(`Service ${serviceName} exists but is not in ACTIVE state. Deleting and recreating...`);
            const deleted = await this.deleteService(serviceName);

            // Wait a moment after deletion
            await new Promise(resolve => setTimeout(resolve, 5000));

            if (deleted) {
              logger.info(`Creating new service after deleting old inactive one: ${serviceName}`);
              await this.createService(serviceName, taskDefinitionArn, port);
            } else {
              // If deletion failed, try to update anyway
              logger.warn(`Failed to delete inactive service. Attempting to update anyway: ${serviceName}`);
              try {
                await this.updateService(serviceName, taskDefinitionArn, port);
              } catch (updateError) {
                logger.error(`Failed to update service after failed deletion: ${updateError}`);
                throw new Error(`Service is not active and could not be deleted or updated: ${serviceName}`);
              }
            }
          }
        } else {
          // Create new service
          logger.info(`Creating new service: ${serviceName}`);
          await this.createService(serviceName, taskDefinitionArn, port);
        }

        logger.info(`Successfully deployed ECS service: ${serviceName}`);
      } catch (error: any) {
        // Provide more detailed error information
        if (error.name === 'ServiceNotActiveException') {
          logger.error(`ECS deployment error: Service is not active. ${error.message}`);
          logger.info('Attempting to force recreate the service...');

          try {
            // Try to delete and recreate the service
            const deleted = await this.deleteService(serviceName);

            if (deleted) {
              logger.info(`Creating new service after ServiceNotActiveException: ${serviceName}`);
              await this.createService(serviceName, taskDefinitionArn, port);
              logger.info(`Successfully recreated service after ServiceNotActiveException: ${serviceName}`);
              return { serviceName, healthy: false, healthError: 'Service was not active and had to be recreated.' };
            }
          } catch (recreateError) {
            logger.error(`Failed to recreate service after ServiceNotActiveException: ${recreateError}`);
            return { serviceName, healthy: false, healthError: 'Failed to recreate service after ServiceNotActiveException.' };
          }
        } else if (error.name === 'InvalidParameterException' && error.message.includes('still Draining')) {
          logger.error(`ECS deployment error: Service is still draining. ${error.message}`);
          logger.info('Waiting for service to fully drain before recreating...');

          try {
            // Wait for the service to fully drain
            await this.waitForServiceToBeDeleted(serviceName);

            // Now try to create the service again
            logger.info(`Creating new service after waiting for draining to complete: ${serviceName}`);
            await this.createService(serviceName, taskDefinitionArn, port);
            logger.info(`Successfully created service after waiting for draining: ${serviceName}`);
            return { serviceName, healthy: false, healthError: 'Service was draining and had to be recreated.' };
          } catch (recreateError) {
            logger.error(`Failed to create service after waiting for draining: ${recreateError}`);
            return { serviceName, healthy: false, healthError: 'Failed to create service after waiting for draining.' };
          }
        } else if (error.name === 'ClientException' && error.message.includes('networkMode=awsvpc')) {
          logger.error(`ECS deployment error: When using awsvpc network mode, host ports and container ports must match. ${error.message}`);
          return { serviceName, healthy: false, healthError: 'awsvpc network mode port mismatch.' };
        } else if (error.name === 'InvalidParameterException' && error.message.includes('subnet')) {
          logger.error(`ECS deployment error: Invalid subnet configuration. ${error.message}`);
          return { serviceName, healthy: false, healthError: 'Invalid subnet configuration.' };
        } else if (error.name === 'InvalidParameterException' && error.message.includes('security group')) {
          logger.error(`ECS deployment error: Invalid security group configuration. ${error.message}`);
          return { serviceName, healthy: false, healthError: 'Invalid security group configuration.' };
        } else {
          logger.error(`Failed to deploy to ECS: ${error}`);
          return { serviceName, healthy: false, healthError: 'Failed to deploy to ECS.' };
        }

        logger.info('Skipping ECS deployment. The Docker image was built successfully and can be used manually.');
        // We'll return success even if ECS deployment fails, since the Docker image was built
      }

      // Fetch the public endpoint (ALB DNS or public IP)
      // --- BEGIN: Wait for public endpoint to become available ---
      let publicEndpoint: string | undefined = undefined;
      const maxEndpointAttempts = 10;
      const endpointDelayMs = 5000;
      for (let attempt = 1; attempt <= maxEndpointAttempts; attempt++) {
        publicEndpoint = await this.getServicePublicEndpoint(serviceName);
        logger.info(`Fetched public endpoint for service ${serviceName} (attempt ${attempt}): ${publicEndpoint}`);
        if (publicEndpoint) break;
        if (attempt < maxEndpointAttempts) {
          await new Promise(res => setTimeout(res, endpointDelayMs));
        }
      }
      if (!publicEndpoint) {
        logger.error(`Public endpoint (ALB DNS) is required for DNS linking but was not found after ${maxEndpointAttempts} attempts.`);
        throw new Error('Public endpoint (ALB DNS) is required for DNS linking but was not found.');
      }
      // --- END: Wait for public endpoint to become available ---
      // Health check logic
      const { healthy, healthError } = await this.waitForServiceHealthy(serviceName, publicEndpoint, healthCheckPath);
      if (!healthy) {
        logger.error(`ECS service ${serviceName} is not healthy: ${healthError}`);
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
      return { serviceName, publicEndpoint, healthy, healthError, customDomainUrl };
    } catch (error) {
      logger.error(`Failed to deploy service: ${error}`);
      throw error;
    }
  }

  // Add a new method to fetch the public endpoint (ALB DNS or public IP)
  private async getServicePublicEndpoint(serviceName: string): Promise<string | undefined> {
    try {
      const response = await this.ecs.send(
        new DescribeServicesCommand({
          cluster: this.cluster,
          services: [serviceName],
        })
      );
      if (response.services && response.services.length > 0) {
        const service = response.services[0];
        // Try to get the load balancer DNS name if available
        if (service.loadBalancers && service.loadBalancers.length > 0) {
          const lb = service.loadBalancers[0];
          // Try by loadBalancerName (classic LB)
          if (lb.loadBalancerName) {
            const lbResponse = await this.elbv2.describeLoadBalancers({ Names: [lb.loadBalancerName] });
            if (lbResponse.LoadBalancers && lbResponse.LoadBalancers.length > 0) {
              const dnsName = lbResponse.LoadBalancers[0].DNSName;
              logger.info(`Resolved ALB DNS name for ${lb.loadBalancerName}: ${dnsName}`);
              return dnsName;
            } else {
              logger.warn(`Could not resolve DNS name for load balancer: ${lb.loadBalancerName}`);
            }
          }
          // Try by targetGroupArn (ALB/NLB)
          if (lb.targetGroupArn) {
            const tgResponse = await this.elbv2.describeTargetGroups({ TargetGroupArns: [lb.targetGroupArn] });
            if (tgResponse.TargetGroups && tgResponse.TargetGroups.length > 0) {
              const tg = tgResponse.TargetGroups[0];
              if (tg.LoadBalancerArns && tg.LoadBalancerArns.length > 0) {
                // Use the first associated load balancer
                const albArn = tg.LoadBalancerArns[0];
                const albResponse = await this.elbv2.describeLoadBalancers({ LoadBalancerArns: [albArn] });
                if (albResponse.LoadBalancers && albResponse.LoadBalancers.length > 0) {
                  const dnsName = albResponse.LoadBalancers[0].DNSName;
                  logger.info(`Resolved ALB DNS name for ${albArn}: ${dnsName}`);
                  return dnsName;
                } else {
                  logger.warn(`Could not resolve DNS name for ALB ARN: ${albArn}`);
                }
              } else {
                logger.warn(`No LoadBalancerArns found for target group: ${lb.targetGroupArn}`);
              }
            } else {
              logger.warn(`Could not describe target group: ${lb.targetGroupArn}`);
            }
          }
        }
        // If no load balancer, try to get the network interface public IP (for Fargate with public IP)
        // This requires additional API calls (not implemented here for brevity)
      }
      return undefined;
    } catch (error) {
      logger.warn(`Could not fetch public endpoint for service ${serviceName}: ${error}`);
      return undefined;
    }
  }

  private async registerTaskDefinition(
    serviceName: string,
    imageUri: string,
    environmentVariables: Record<string, string>,
    containerPort: number
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
          'awslogs-region': process.env.AWS_REGION || 'us-east-1',
          'awslogs-stream-prefix': serviceName,
        },
      },
    };

    // Log the execution role being used
    logger.info(`Using execution role ARN: ${this.executionRoleArn}`);

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

      // First, update the service to have 0 desired count
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

  /**
   * Automatically create and attach a Target Group and Listener Rule for the ECS service if not present.
   * This ensures the ALB is always connected to the ECS service on creation.
   * @param serviceName
   * @param containerPort
   * @returns {Promise<{targetGroupArn: string, listenerArn: string}>}
   */
  private async ensureTargetGroupAndListener(serviceName: string, containerPort: number): Promise<{ targetGroupArn: string, listenerArn: string }> {
    let targetGroupArn = process.env.AWS_ALB_TARGET_GROUP_ARN;
    const listenerArn = process.env.AWS_ALB_LISTENER_ARN;
    if (!listenerArn) {
      throw new Error('Missing AWS_ALB_LISTENER_ARN in environment variables');
    }
    // If a target group ARN is provided, check its type
    if (targetGroupArn && !targetGroupArn.includes('<REQUIRED')) {
      const describeRes = await this.elbv2.describeTargetGroups({ TargetGroupArns: [targetGroupArn] });
      const tg = describeRes.TargetGroups && describeRes.TargetGroups[0];
      if (!tg) {
        throw new Error(`Target group ARN ${targetGroupArn} not found.`);
      }
      if (tg.TargetType !== 'ip') {
        throw new Error(`Target group ${targetGroupArn} has type '${tg.TargetType}'. It must be 'ip' for ECS Fargate/awsvpc. Please create a new target group of type 'ip'.`);
      }
    } else {
      // Create a new target group for this service
      const tgName = serviceName.length > 32 ? serviceName.substring(0, 32) : serviceName;
      const tgRes = await this.elbv2.createTargetGroup({
        Name: tgName,
        Protocol: 'HTTP',
        Port: containerPort,
        VpcId: this.vpcId,
        TargetType: 'ip',
        HealthCheckPath: '/health',
        HealthCheckProtocol: 'HTTP',
      });
      if (!tgRes.TargetGroups || !tgRes.TargetGroups[0].TargetGroupArn) {
        throw new Error('Failed to create Target Group for ECS service');
      }
      targetGroupArn = tgRes.TargetGroups[0].TargetGroupArn;
      logger.info(`Created new Target Group: ${targetGroupArn}`);
    }
    // Attach a listener rule for this target group, using a truly free priority
    let ruleCreated = false;
    let lastError = null;
    // Get all existing priorities for this listener
    const rulesRes = await this.elbv2.describeRules({ ListenerArn: listenerArn });
    const usedPriorities = new Set<number>();
    for (const rule of rulesRes.Rules || []) {
      if (rule.Priority && rule.Priority !== 'default') {
        usedPriorities.add(Number(rule.Priority));
      }
    }
    // Try to find a free priority in the allowed range
    let priority = Math.abs(this.hashString(serviceName)) % 50000 + 1;
    let attempts = 0;
    while (usedPriorities.has(priority) && attempts < 50000) {
      priority = (priority % 50000) + 1;
      attempts++;
    }
    if (usedPriorities.has(priority)) {
      throw new Error('Could not find a free ALB listener rule priority after 50000 attempts.');
    }
    const pathPattern = `/${serviceName}/*`;
    try {
      await this.elbv2.createRule({
        ListenerArn: listenerArn,
        Priority: priority,
        Conditions: [
          {
            Field: 'path-pattern',
            Values: [pathPattern],
          },
        ],
        Actions: [
          {
            Type: 'forward',
            TargetGroupArn: targetGroupArn,
          },
        ],
      });
      logger.info(`Created ALB listener rule for service ${serviceName} at path ${pathPattern} with priority ${priority}`);
      ruleCreated = true;
    } catch (err: any) {
      lastError = err;
      if (err.name === 'DuplicateRule') {
        logger.warn(`Listener rule for path ${pathPattern} already exists, skipping rule creation.`);
        ruleCreated = true;
      } else {
        logger.error(`Failed to create ALB listener rule: ${err}`);
      }
    }
    if (!ruleCreated) {
      throw new Error(`Failed to create ALB listener rule for service ${serviceName}: ${lastError}`);
    }
    return { targetGroupArn, listenerArn };
  }

  // Simple hash for string to int (for ALB rule priority)
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }

  private async createService(
    serviceName: string,
    taskDefinitionArn: string,
    containerPort: number
  ): Promise<void> {
    try {
      logger.info(`Creating new ECS service: ${serviceName} with task definition: ${taskDefinitionArn}`);
      logger.info(`Using subnets: ${this.subnetIds.join(', ')}`);
      logger.info(`Using security group: ${this.securityGroupId}`);

      // Always ensure Target Group and Listener Rule exist for this service
      const { targetGroupArn } = await this.ensureTargetGroupAndListener(serviceName, containerPort);

      const response = await this.ecs.send(
        new CreateServiceCommand({
          cluster: this.cluster,
          serviceName,
          taskDefinition: taskDefinitionArn,
          desiredCount: 1,
          launchType: 'FARGATE',
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: this.subnetIds,
              securityGroups: [this.securityGroupId],
              assignPublicIp: 'ENABLED',
            },
          },
          loadBalancers: [
            {
              targetGroupArn,
              containerName: serviceName,
              containerPort,
            },
          ],
        })
      );

      logger.info(`Service created successfully: ${response.service?.serviceArn}`);
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
    containerPort: number
  ): Promise<void> {
    try {
      logger.info(`Updating existing ECS service: ${serviceName} with task definition: ${taskDefinitionArn}`);
      logger.info(`Using subnets: ${this.subnetIds.join(', ')}`);
      logger.info(`Using security group: ${this.securityGroupId}`);

      // Always ensure Target Group and Listener Rule exist for this service
      const { targetGroupArn } = await this.ensureTargetGroupAndListener(serviceName, containerPort);

      const response = await this.ecs.send(
        new UpdateServiceCommand({
          cluster: this.cluster,
          service: serviceName,
          taskDefinition: taskDefinitionArn,
          desiredCount: 1,
          forceNewDeployment: true,
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: this.subnetIds,
              securityGroups: [this.securityGroupId],
              assignPublicIp: 'ENABLED',
            },
          },
          loadBalancers: [
            {
              targetGroupArn,
              containerName: serviceName,
              containerPort,
            },
          ],
        })
      );

      logger.info(`Service updated successfully: ${response.service?.serviceArn}`);
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

  // Wait for ECS service and ALB endpoint to be healthy
  private async waitForServiceHealthy(serviceName: string, publicEndpoint?: string, healthCheckPath?: string): Promise<{ healthy: boolean; healthError?: string }> {
    // If no healthCheckPath is provided, skip ALB health check and only check ECS status
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
        const health = service.deployments?.every(dep => dep.rolloutState === 'COMPLETED');
        if (status === 'ACTIVE' && running === desired && health) {
          // Only check ALB endpoint if healthCheckPath is provided
          if (publicEndpoint && healthCheckPath) {
            try {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 5000);
              const res = await fetch(`http://${publicEndpoint}${healthCheckPath}`, { method: 'GET', signal: controller.signal });
              clearTimeout(timeout);
              if (res.ok) {
                logger.info(`Health check passed for ALB endpoint: http://${publicEndpoint}${healthCheckPath}`);
                return { healthy: true };
              }
            } catch (err) {
              logger.warn(`ALB endpoint not healthy yet: ${err}`);
            }
          } else {
            // No health check path provided, consider service healthy if ECS is healthy
            logger.info('No healthCheckPath provided, skipping ALB health check. Considering service healthy if ECS is healthy.');
            return { healthy: true };
          }
        }
        logger.info(`Waiting for ECS service to be healthy (attempt ${attempt}/${maxAttempts})...`);
        await new Promise(res => setTimeout(res, delayMs));
      } catch (err) {
        logger.warn(`Error during health check: ${err}`);
        await new Promise(res => setTimeout(res, delayMs));
      }
    }
    return { healthy: false, healthError: 'Timed out waiting for ECS/ALB health' };
  }
}
