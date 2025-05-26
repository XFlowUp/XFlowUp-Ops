import { DeploymentRequestPayload, DeploymentStrategy } from '../deployment-manager';
import { ECSService } from '../../aws/ecs-service';
import logger from '../../../utils/logger';

// Import database clients for health checks
import { Client as PgClient } from 'pg';
import mysql from 'mysql2/promise';
import mariadb from 'mariadb';
import { MongoClient } from 'mongodb';
import Redis from 'ioredis';

const DATABASE_IMAGE_MAP: Record<string, { image: string; defaultPort: number; scheme: string }> = {
  postgres: { image: 'postgres:latest', defaultPort: 5432, scheme: 'postgresql' },
  mysql: { image: 'mysql:latest', defaultPort: 3306, scheme: 'mysql' },
  mariadb: { image: 'mariadb:latest', defaultPort: 3306, scheme: 'mariadb' },
  mongo: { image: 'mongo:latest', defaultPort: 27017, scheme: 'mongodb' },
  redis: { image: 'redis:latest', defaultPort: 6379, scheme: 'redis' },
  // Add more as needed
};

export class DatabaseStrategy implements DeploymentStrategy {
  private ecsService: ECSService;
  private lastConnectionUrl?: string;

  constructor() {
    this.ecsService = new ECSService();
  }

  async deploy(payload: DeploymentRequestPayload, deploymentId?: string, streamLog?: (msg: string) => Promise<void>): Promise<boolean> {
    // --- ECS/Fargate DB deployment logic ---
    // 1. Always use default DB port for both hostPort and containerPort (awsvpc requirement)
    // 2. Compose connection URL using ECS public IP (never ALB/Cloudflare DNS)
    // 3. Health checks use ECS public IP and port
    // 4. Warn if ECS result contains a DNS name that looks like Cloudflare/ALB
    const context = {
      serviceId: payload.serviceId || payload.databaseServiceId,
      projectSlug: payload.projectSlug,
      deploymentId: deploymentId || payload.deploymentId || payload.messageId || undefined,
      type: payload.type
    };
    logger.info(`[context] Starting Database deployment`, context);
    if (streamLog) await streamLog(`[context] Starting Database deployment: ${JSON.stringify(context)}`);
    this.lastConnectionUrl = undefined;
    try {
      // Get databaseType from payload
      let databaseType: string | undefined = undefined;
      if (payload.metadata && 'databaseType' in payload.metadata && payload.metadata.databaseType) {
        databaseType = payload.metadata.databaseType;
      } else if (payload.metadata?.environmentValues?.databaseType) {
        databaseType = payload.metadata.environmentValues.databaseType;
      } else if (payload.databaseType) {
        databaseType = payload.databaseType;
      }
      if (!databaseType || !DATABASE_IMAGE_MAP[databaseType]) {
        logger.error(`[context] Unsupported or missing databaseType: ${databaseType}`, context);
        if (streamLog) await streamLog(`[context] Unsupported or missing databaseType: ${databaseType}`);
        throw new Error('Unsupported or missing databaseType');
      }
      const { image, defaultPort, scheme } = DATABASE_IMAGE_MAP[databaseType];
      const imageUri = image;
      const serviceName = `${payload.projectSlug || 'db'}-${payload.serviceId || payload.databaseServiceId}`;
      const environmentVariables = payload.metadata?.environmentValues || {};
      // Always use the default port for both hostPort and containerPort (Fargate/awsvpc requirement)
      let requestedPort = Number(environmentVariables.PORT);
      if (requestedPort && requestedPort !== defaultPort) {
        logger.warn(`[context] ECS/Fargate requires hostPort and containerPort to match. Ignoring requested PORT (${requestedPort}) and using default port (${defaultPort}) for both.`, context);
        if (streamLog) await streamLog(`[context] WARNING: ECS/Fargate requires hostPort and containerPort to match. Ignoring requested PORT (${requestedPort}) and using default port (${defaultPort}) for both.`);
      }
      const hostPort = defaultPort;
      const containerPort = defaultPort;
      logger.info(`[context] Deploying database to ECS: ${serviceName} using image ${imageUri} with hostPort ${hostPort} -> containerPort ${containerPort}`);
      if (streamLog) await streamLog(`[context] Deploying database to ECS: ${serviceName} using image ${imageUri} with hostPort ${hostPort} -> containerPort ${containerPort}`);
      // Call ECS deployService with only defaultPort for both hostPort and containerPort
      const ecsResult = await this.ecsService.deployService(
        serviceName,
        imageUri,
        environmentVariables,
        containerPort,
        undefined, // customDomain
        undefined, // healthCheckPath
        deploymentId,
        streamLog,
        hostPort, // pass hostPort, but it's always defaultPort
        true // noLoadBalancer: skip ALB for DBs
      );
      logger.info(`[context] ECS deployment result: ${JSON.stringify(ecsResult)}`, context);
      if (streamLog) await streamLog(`[context] ECS deployment result: ${JSON.stringify(ecsResult)}`);
      // Compose connection URL
      const username = environmentVariables.POSTGRES_USER || environmentVariables.MYSQL_USER || environmentVariables.MARIADB_USER || environmentVariables.MONGO_INITDB_ROOT_USERNAME || environmentVariables.REDIS_USER || 'admin';
      const password = environmentVariables.POSTGRES_PASSWORD || environmentVariables.MYSQL_PASSWORD || environmentVariables.MARIADB_PASSWORD || environmentVariables.MONGO_INITDB_ROOT_PASSWORD || environmentVariables.REDIS_PASSWORD || 'password';
      const dbName = environmentVariables.POSTGRES_DB || environmentVariables.MYSQL_DATABASE || environmentVariables.MARIADB_DATABASE || environmentVariables.MONGO_INITDB_DATABASE || environmentVariables.REDIS_DB || 'postgres';
      // Use the public endpoint from ECS result, fallback to serviceName if not available
      // For DBs, never use ALB DNS or Cloudflare DNS. Only use ECS public IP and port.
      const host = ecsResult.publicEndpoint || serviceName;
      // Warn if host looks like a Cloudflare or ALB DNS (should not happen for DBs)
      if (/cloudflare|alb|amazonaws\.com/i.test(host)) {
        logger.warn(`[context] WARNING: ECS publicEndpoint looks like a Cloudflare/ALB DNS: ${host}. This is not recommended for database connections.`, context);
        if (streamLog) await streamLog(`[context] WARNING: ECS publicEndpoint looks like a Cloudflare/ALB DNS: ${host}. This is not recommended for database connections.`);
      }
      const port = hostPort;
      let connectionUrl = '';
      if (databaseType === 'postgres') {
        connectionUrl = `${scheme}://${username}:${password}@${host}:${port}/${dbName}`;
      } else if (databaseType === 'mysql' || databaseType === 'mariadb') {
        connectionUrl = `${scheme}://${username}:${password}@${host}:${port}/${dbName}`;
      } else if (databaseType === 'mongo') {
        connectionUrl = `${scheme}://${username}:${password}@${host}:${port}/${dbName}`;
      } else if (databaseType === 'redis') {
        connectionUrl = password ? `${scheme}://:${password}@${host}:${port}` : `${scheme}://${host}:${port}`;
      }
      this.lastConnectionUrl = connectionUrl;
      logger.info(`[context] Database connection URL: ${connectionUrl}`, context);
      if (streamLog) await streamLog(`[context] Database connection URL: ${connectionUrl}`);
      // Health check: always use the ECS public IP and port, never ALB DNS or HTTP endpoint
      let healthy = false;
      let healthError = '';
      const maxRetries = 50; // e.g. try for up to 1 minute (12 x 5s)
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          if (databaseType === 'postgres') {
            const client = new PgClient({ connectionString: connectionUrl, connectionTimeoutMillis: 5000 });
            await client.connect();
            await client.end();
            healthy = true;
          } else if (databaseType === 'mysql') {
            const conn = await mysql.createConnection({ host, port, user: username, password, database: dbName, connectTimeout: 5000 });
            await conn.end();
            healthy = true;
          } else if (databaseType === 'mariadb') {
            const conn = await mariadb.createConnection({ host, port, user: username, password, database: dbName, connectTimeout: 5000 });
            await conn.end();
            healthy = true;
          } else if (databaseType === 'mongo') {
            const client = new MongoClient(connectionUrl, { connectTimeoutMS: 5000 });
            await client.connect();
            await client.close();
            healthy = true;
          } else if (databaseType === 'redis') {
            const redis = new Redis(connectionUrl, { connectTimeout: 5000 });
            await redis.ping();
            await redis.quit();
            healthy = true;
          }
          if (healthy) {
            logger.info(`[context] Database health check succeeded on attempt ${attempt}`, context);
            if (streamLog) await streamLog(`[context] Database health check succeeded on attempt ${attempt}`);
            break;
          }
        } catch (err) {
          healthError = (err as Error).message;
          logger.warn(`[context] Database health check attempt ${attempt} failed: ${healthError}`, context);
          if (streamLog) await streamLog(`[context] Database health check attempt ${attempt} failed: ${healthError}`);
          if (attempt < maxRetries) {
            await new Promise(res => setTimeout(res, 5000)); // wait 5 seconds before retry
          }
        }
      }
      if (!healthy) {
        logger.error(`[context] Database health check failed after ${maxRetries} attempts: ${healthError}`, context);
        if (streamLog) await streamLog(`[context] Database health check failed after ${maxRetries} attempts: ${healthError}`);
      }
      logger.info(`[context] Database deployment completed for service ID: ${payload.serviceId || payload.databaseServiceId}`, context);
      if (streamLog) await streamLog(`[context] Database deployment completed for service ID: ${payload.serviceId || payload.databaseServiceId}`);
      // Return healthy status (true/false)
      return healthy;
    } catch (error) {
      logger.error(`[context] Database deployment failed: ${error}`, context);
      if (streamLog) await streamLog(`[context] Database deployment failed: ${error}`);
      this.lastConnectionUrl = undefined;
      return false;
    }
  }

  getPublicEndpoint(): string | undefined {
    // For databases, this is the connection URL (not a public HTTP endpoint)
    return this.lastConnectionUrl;
  }
}

export {};
