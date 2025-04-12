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
import dotenv from 'dotenv';
import logger from '../../utils/logger';

dotenv.config();

export class ECSService {
  private ecs: ECS;
  private iam: IAM;
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

  async deployService(
    serviceName: string,
    imageUri: string,
    environmentVariables: Record<string, string> = {}
  ): Promise<string> {
    try {
      logger.info(`Deploying ECS service: ${serviceName} with image: ${imageUri}`);

      // Register task definition outside the inner try block so it's available in the catch block
      logger.info(`Registering task definition for service: ${serviceName}`);
      const taskDefinitionArn = await this.registerTaskDefinition(
        serviceName,
        imageUri,
        environmentVariables
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
              await this.createService(serviceName, taskDefinitionArn);
            } else {
              logger.warn(`Failed to delete service for forced recreation. Attempting to update: ${serviceName}`);
              try {
                await this.updateService(serviceName, taskDefinitionArn);
              } catch (updateError) {
                logger.error(`Failed to update service after failed forced deletion: ${updateError}`);
                throw new Error(`Service could not be deleted or updated for forced recreation: ${serviceName}`);
              }
            }
          } else if (serviceStatus.isActive) {
            // Update existing active service
            logger.info(`Updating existing active service: ${serviceName}`);
            await this.updateService(serviceName, taskDefinitionArn);
          } else {
            // Service exists but is not active - delete and recreate
            logger.info(`Service ${serviceName} exists but is not in ACTIVE state. Deleting and recreating...`);
            const deleted = await this.deleteService(serviceName);

            // Wait a moment after deletion
            await new Promise(resolve => setTimeout(resolve, 5000));

            if (deleted) {
              logger.info(`Creating new service after deleting old inactive one: ${serviceName}`);
              await this.createService(serviceName, taskDefinitionArn);
            } else {
              // If deletion failed, try to update anyway
              logger.warn(`Failed to delete inactive service. Attempting to update anyway: ${serviceName}`);
              try {
                await this.updateService(serviceName, taskDefinitionArn);
              } catch (updateError) {
                logger.error(`Failed to update service after failed deletion: ${updateError}`);
                throw new Error(`Service is not active and could not be deleted or updated: ${serviceName}`);
              }
            }
          }
        } else {
          // Create new service
          logger.info(`Creating new service: ${serviceName}`);
          await this.createService(serviceName, taskDefinitionArn);
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
              await this.createService(serviceName, taskDefinitionArn);
              logger.info(`Successfully recreated service after ServiceNotActiveException: ${serviceName}`);
              return serviceName; // Return success if we managed to recreate the service
            }
          } catch (recreateError) {
            logger.error(`Failed to recreate service after ServiceNotActiveException: ${recreateError}`);
          }
        } else if (error.name === 'InvalidParameterException' && error.message.includes('still Draining')) {
          logger.error(`ECS deployment error: Service is still draining. ${error.message}`);
          logger.info('Waiting for service to fully drain before recreating...');

          try {
            // Wait for the service to fully drain
            await this.waitForServiceToBeDeleted(serviceName);

            // Now try to create the service again
            logger.info(`Creating new service after waiting for draining to complete: ${serviceName}`);
            await this.createService(serviceName, taskDefinitionArn);
            logger.info(`Successfully created service after waiting for draining: ${serviceName}`);
            return serviceName; // Return success if we managed to create the service
          } catch (recreateError) {
            logger.error(`Failed to create service after waiting for draining: ${recreateError}`);
          }
        } else if (error.name === 'ClientException' && error.message.includes('networkMode=awsvpc')) {
          logger.error(`ECS deployment error: When using awsvpc network mode, host ports and container ports must match. ${error.message}`);
        } else if (error.name === 'InvalidParameterException' && error.message.includes('subnet')) {
          logger.error(`ECS deployment error: Invalid subnet configuration. ${error.message}`);
        } else if (error.name === 'InvalidParameterException' && error.message.includes('security group')) {
          logger.error(`ECS deployment error: Invalid security group configuration. ${error.message}`);
        } else {
          logger.error(`Failed to deploy to ECS: ${error}`);
        }

        logger.info('Skipping ECS deployment. The Docker image was built successfully and can be used manually.');
        // We'll return success even if ECS deployment fails, since the Docker image was built
      }

      return serviceName;
    } catch (error) {
      logger.error(`Failed to deploy service: ${error}`);
      throw error;
    }
  }

  private async registerTaskDefinition(
    serviceName: string,
    imageUri: string,
    environmentVariables: Record<string, string>
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
          containerPort: 3000, // Assuming the app runs on port 3000
          hostPort: 3000, // When using awsvpc network mode, hostPort must match containerPort
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

  private async createService(
    serviceName: string,
    taskDefinitionArn: string
  ): Promise<void> {
    try {
      logger.info(`Creating new ECS service: ${serviceName} with task definition: ${taskDefinitionArn}`);
      logger.info(`Using subnets: ${this.subnetIds.join(', ')}`);
      logger.info(`Using security group: ${this.securityGroupId}`);

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
    taskDefinitionArn: string
  ): Promise<void> {
    try {
      logger.info(`Updating existing ECS service: ${serviceName} with task definition: ${taskDefinitionArn}`);
      logger.info(`Using subnets: ${this.subnetIds.join(', ')}`);
      logger.info(`Using security group: ${this.securityGroupId}`);

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
}
