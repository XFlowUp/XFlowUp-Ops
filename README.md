# XFlowUp-Ops

XFlowUp-Ops is the operations service for the XFlowUp platform. It handles infrastructure deployment based on messages received from AWS SQS.

## Features

- Listens to AWS SQS for deployment requests
- Supports multiple deployment strategies:
  - GitHub repository deployment
  - Docker image deployment
- Automatically generates Dockerfiles for repositories that don't have one
- Supports multiple programming languages and frameworks:
  - Node.js/TypeScript
    - Special handling for Next.js, Nuxt.js, Prisma, and Supabase
  - Python (Flask, Django)
  - Java (Maven, Gradle)
  - Go
  - PHP (Laravel)
  - Ruby (Rails)
  - .NET
- Deploys infrastructure using AWS ECS and ECR
- Provides deployment status updates
- Logs deployment events to AWS CloudWatch

## Architecture

The service follows a modular architecture with the following components:

- **SQS Consumer**: Listens to AWS SQS for deployment requests
- **Deployment Manager**: Orchestrates the deployment process
- **Deployment Strategies**: Implements different deployment approaches
- **Dockerfile Generator**: Automatically generates Dockerfiles for different project types
- **AWS Services**: Interfaces with AWS services (ECS, ECR, CloudWatch)

## Prerequisites

- Node.js 16+
- AWS Account with appropriate permissions
- Docker (for building and pushing images)
- Git (for cloning repositories)

## Installation

1. Clone the repository
2. Install dependencies:

```bash
npm install
```

3. Configure environment variables by copying `.env.example` to `.env` and filling in the values:

```bash
cp .env.example .env
```

## Configuration

The service requires the following environment variables:

### AWS Configuration
- `AWS_REGION`: AWS region
- `AWS_ACCESS_KEY_ID`: AWS access key ID
- `AWS_SECRET_ACCESS_KEY`: AWS secret access key

### SQS Configuration
- `SQS_REGION`: SQS region
- `SQS_ACCESS_KEY_ID`: SQS access key ID
- `SQS_SECRET_ACCESS_KEY`: SQS secret access key
- `SQS_IS_FIFO`: Whether the SQS queue is FIFO (true/false)
- `SQS_QUEUE_NAME`: SQS queue name
- `SQS_URL`: SQS queue URL

### ECS Configuration
- `AWS_ECS_CLUSTER`: ECS cluster name
- `AWS_ECS_EXECUTION_ROLE_ARN`: ECS execution role ARN

### ECR Configuration
- `AWS_ECR_REPOSITORY`: ECR repository URI

### VPC Configuration
- `AWS_VPC_ID`: VPC ID
- `AWS_SUBNET_IDS`: Comma-separated list of subnet IDs
- `AWS_SECURITY_GROUP_ID`: Security group ID

### ALB Configuration
- `AWS_ALB_LISTENER_ARN`: ALB listener ARN

### CloudWatch Configuration
- `AWS_CLOUDWATCH_LOG_GROUP`: CloudWatch log group name

### Domain Configuration
- `DOMAIN`: Domain name

### Application Configuration
- `LOG_LEVEL`: Logging level (debug, info, warn, error)
- `TEMP_REPO_DIR`: Temporary directory for cloning repositories

### SQS Status Queue (for deployment status updates)
- `SQS_STATUS_URL`: SQS queue URL for deployment status/result messages (separate from deployment request queue)

### Cloudflare DNS Automation
- `CLOUDFLARE_API_TOKEN`: Cloudflare API token (must have DNS:Edit permission for the zone)
- `CLOUDFLARE_ZONE_ID`: Cloudflare Zone ID for your domain

## Enhanced Deployment Flow

After a successful deployment to AWS:
- The service automatically assigns a subdomain (e.g., `projectslug.your-domain.com`) to the deployed website using Cloudflare DNS.
- It verifies the site is live (HTTP check).
- It sends a deployment status message (including the assigned URL and build status) to the SQS status queue (`SQS_STATUS_URL`).
- All actions are logged for traceability.

## Usage

### Development

```bash
npm run dev
```

### Production

```bash
npm run build
npm start
```

### Testing

```bash
npm test
```

### Sending a Test Message

To test the deployment process, you can send a test message to the SQS queue:

```bash
npm run send-test-message
```

Make sure to update the GitHub repository URL and token in `src/send-test-message.ts` before running.

### Running a Mock Test

To test the deployment process without making actual AWS API calls:

```bash
npm run mock-test
```

This will simulate the deployment process using mock strategies.

## Deployment Message Format

The service expects SQS messages in the following format:

```json
{
  "messageId": "unique-message-id",
  "message": {
    "type": "GITHUB_REPO",
    "environmentId": 1,
    "projectSlug": "project-slug",
    "serviceId": 123,
    "userId": 456,
    "github_token": "github-token",
    "githubRepository": {
      "url": "https://github.com/user/repo",
      "branch": "main"
    },
    "metadata": {
      "environmentId": "1",
      "environmentValues": {
        "PORT": "3000",
        "NODE_ENV": "production"
      }
    }
  },
  "MessageAttributes": {
    "job": {
      "DataType": "String",
      "StringValue": "deployment:request"
    }
  }
}
```

## License

MIT
