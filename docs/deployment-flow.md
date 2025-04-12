# Deployment Flow

This document describes the deployment flow in the XFlowUp-Ops service.

## Overview

The deployment process follows these steps:

1. SQS message is received with deployment request
2. Deployment manager selects appropriate strategy based on service type
3. Strategy executes deployment steps
4. Status updates are sent back to the queue
5. Logs are written to CloudWatch

## Detailed Flow

### 1. Message Reception

The SQS Consumer continuously polls the SQS queue for messages. When a message is received, it is parsed and validated. If the message has a job type of `deployment:request`, it is passed to the Deployment Manager.

### 2. Deployment Initialization

The Deployment Manager:
- Validates the payload
- Sends an initial status update (IN_PROGRESS)
- Selects the appropriate deployment strategy based on the service type

### 3. Strategy Execution

#### GitHub Repository Strategy

For GitHub repository deployments:

1. Clone the repository using the provided URL and branch
2. Check for a Dockerfile in the repository
3. If no Dockerfile is found:
   a. Detect the project type (Node.js, Python, Java, etc.)
   b. Detect special frameworks and tools (Next.js, Nuxt.js, Prisma, Supabase, etc.)
   c. Generate an appropriate Dockerfile based on the project type and frameworks
   d. Apply special handling for frameworks that require specific build steps:
      - For Prisma projects: Create a schema file and generate the client
      - For Supabase projects: Skip CLI download during installation
      - For Next.js/Nuxt.js: Use framework-specific build and start commands
   e. The generator supports multiple languages and frameworks including Node.js, Python, Java, Go, PHP, Ruby, and .NET
4. Build a Docker image from the repository
5. Push the image to ECR
6. Deploy the image to ECS

#### Docker Image Strategy

For Docker image deployments:

1. Validate the Docker image URL and tag
2. Deploy the image to ECS

### 4. Status Updates

Throughout the deployment process, status updates are sent back to the SQS queue:

- `IN_PROGRESS`: When the deployment starts
- `COMPLETED`: When the deployment completes successfully
- `FAILED`: When the deployment fails

The status updates include:
- Service ID
- Project slug
- Status
- Timestamp
- Error message (if applicable)

### 5. Logging

All deployment events are logged to:
- Console (for development)
- Log files
- CloudWatch (for production)

## Error Handling

The service implements robust error handling:

- If a deployment fails, the error is captured and logged
- A FAILED status update is sent to the queue
- The service continues processing other messages

## Cleanup

After deployment:
- Temporary files are cleaned up
- Repository clones are removed
- Resources are properly released

## Sequence Diagram

```
┌─────────┐          ┌─────────────┐          ┌───────────────────┐          ┌─────────────┐          ┌─────────┐
│   SQS   │          │SQS Consumer │          │Deployment Manager │          │  Strategy   │          │   AWS   │
└────┬────┘          └──────┬──────┘          └─────────┬─────────┘          └──────┬──────┘          └────┬────┘
     │                       │                           │                           │                      │
     │   Poll for Messages   │                           │                           │                      │
     │ ─────────────────────>│                           │                           │                      │
     │                       │                           │                           │                      │
     │   Return Message      │                           │                           │                      │
     │ <─────────────────────│                           │                           │                      │
     │                       │                           │                           │                      │
     │                       │ Handle Deployment Request │                           │                      │
     │                       │ ─────────────────────────>│                           │                      │
     │                       │                           │                           │                      │
     │                       │                           │ Update Status (IN_PROGRESS)                      │
     │ <─────────────────────┼───────────────────────────┼───────────────────────────┼──────────────────────┘
     │                       │                           │                           │
     │                       │                           │    Execute Strategy       │
     │                       │                           │ ─────────────────────────>│
     │                       │                           │                           │
     │                       │                           │                           │  Deploy Infrastructure
     │                       │                           │                           │ ─────────────────────>
     │                       │                           │                           │
     │                       │                           │                           │  Return Result
     │                       │                           │                           │ <─────────────────────
     │                       │                           │                           │
     │                       │                           │    Return Result          │
     │                       │                           │ <─────────────────────────│
     │                       │                           │                           │
     │                       │                           │ Update Status (COMPLETED/FAILED)                 │
     │ <─────────────────────┼───────────────────────────┼───────────────────────────┼──────────────────────┘
     │                       │                           │                           │
     │                       │ Return Result             │                           │
     │                       │ <─────────────────────────│                           │
     │                       │                           │                           │
     │  Delete Message       │                           │                           │
     │ <─────────────────────│                           │                           │
     │                       │                           │                           │
```
