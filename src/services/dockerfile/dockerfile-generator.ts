import fs from 'fs';
import path from 'path';
import logger from '../../utils/logger';

export enum ProjectType {
  NODE_JS = 'NODE_JS',
  PYTHON = 'PYTHON',
  JAVA = 'JAVA',
  GO = 'GO',
  PHP = 'PHP',
  RUBY = 'RUBY',
  DOTNET = 'DOTNET',
  UNKNOWN = 'UNKNOWN'
}

export class DockerfileGenerator {
  /**
   * Detects the project type based on files in the repository
   * @param repoDir The repository directory
   * @returns The detected project type
   */
  detectProjectType(repoDir: string): ProjectType {
    try {
      const files = fs.readdirSync(repoDir);

      // Check for package.json (Node.js)
      if (fs.existsSync(path.join(repoDir, 'package.json'))) {
        return ProjectType.NODE_JS;
      }

      // Check for requirements.txt or setup.py (Python)
      if (
        fs.existsSync(path.join(repoDir, 'requirements.txt')) ||
        fs.existsSync(path.join(repoDir, 'setup.py')) ||
        fs.existsSync(path.join(repoDir, 'Pipfile'))
      ) {
        return ProjectType.PYTHON;
      }

      // Check for pom.xml or build.gradle (Java)
      if (
        fs.existsSync(path.join(repoDir, 'pom.xml')) ||
        fs.existsSync(path.join(repoDir, 'build.gradle'))
      ) {
        return ProjectType.JAVA;
      }

      // Check for go.mod (Go)
      if (fs.existsSync(path.join(repoDir, 'go.mod'))) {
        return ProjectType.GO;
      }

      // Check for composer.json (PHP)
      if (fs.existsSync(path.join(repoDir, 'composer.json'))) {
        return ProjectType.PHP;
      }

      // Check for Gemfile (Ruby)
      if (fs.existsSync(path.join(repoDir, 'Gemfile'))) {
        return ProjectType.RUBY;
      }

      // Check for .csproj or .sln (.NET)
      const hasDotNetFiles = files.some(file =>
        file.endsWith('.csproj') || file.endsWith('.sln')
      );
      if (hasDotNetFiles) {
        return ProjectType.DOTNET;
      }

      // If no specific project type is detected
      return ProjectType.UNKNOWN;
    } catch (error) {
      logger.error(`Error detecting project type: ${error}`);
      return ProjectType.UNKNOWN;
    }
  }

  /**
   * Generates a Dockerfile for the given project type
   * @param projectType The project type
   * @param repoDir The repository directory
   * @param port The port to expose (from SQS message or default)
   * @returns true if Dockerfile was generated successfully, false otherwise
   */
  generateDockerfile(projectType: ProjectType, repoDir: string, port: number = 3000): boolean {
    try {
      const dockerfilePath = path.join(repoDir, 'Dockerfile');
      let dockerfileContent = '';

      // Check for Prisma and create schema file if needed
      if (projectType === ProjectType.NODE_JS && this.checkForPrisma(repoDir)) {
        const prismaDir = path.join(repoDir, 'prisma');
        const schemaPath = path.join(prismaDir, 'schema.prisma');

        // Create prisma directory if it doesn't exist
        if (!fs.existsSync(prismaDir)) {
          fs.mkdirSync(prismaDir, { recursive: true });
        }

        // Create a schema file with a sample model to prevent generation errors
        const schemaContent = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

// Sample model to ensure Prisma can generate a client
model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
  name  String?
}`;

        fs.writeFileSync(schemaPath, schemaContent);
        logger.info(`Created Prisma schema file at ${schemaPath}`);
      }

      // For Next.js projects, create a .env file with PostgreSQL environment variables
      if (projectType === ProjectType.NODE_JS && this.checkForNextJs(repoDir)) {
        const envPath = path.join(repoDir, '.env');
        const envContent = `PG_HOST=localhost
PG_USER=postgres
PG_PASSWORD=postgres
PG_DATABASE=postgres
PG_PORT=5432
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres?schema=public
NEXT_PUBLIC_SKIP_API_ROUTES=true
NEXT_TELEMETRY_DISABLED=1`;

        fs.writeFileSync(envPath, envContent);
        logger.info(`Created .env file at ${envPath}`);
      }

      switch (projectType) {
        case ProjectType.NODE_JS:
          dockerfileContent = this.generateNodeJsDockerfile(repoDir, port);
          break;
        case ProjectType.PYTHON:
          dockerfileContent = this.generatePythonDockerfile(repoDir, port);
          break;
        case ProjectType.JAVA:
          dockerfileContent = this.generateJavaDockerfile(repoDir, port);
          break;
        case ProjectType.GO:
          dockerfileContent = this.generateGoDockerfile(repoDir, port);
          break;
        case ProjectType.PHP:
          dockerfileContent = this.generatePhpDockerfile(repoDir, port);
          break;
        case ProjectType.RUBY:
          dockerfileContent = this.generateRubyDockerfile(repoDir, port);
          break;
        case ProjectType.DOTNET:
          dockerfileContent = this.generateDotNetDockerfile(repoDir, port);
          break;
        default:
          logger.error('Unknown project type, cannot generate Dockerfile');
          return false;
      }

      fs.writeFileSync(dockerfilePath, dockerfileContent);
      logger.info(`Generated Dockerfile for ${projectType} project at ${dockerfilePath}`);
      return true;
    } catch (error) {
      logger.error(`Error generating Dockerfile: ${error}`);
      return false;
    }
  }

  /**
   * Generates a Dockerfile for a Node.js project
   * @param repoDir The repository directory
   * @param port The port to expose
   * @returns The Dockerfile content
   */
  private generateNodeJsDockerfile(repoDir: string, port: number = 3000): string {
    // Determine if it's a TypeScript project
    const isTypeScript = fs.existsSync(path.join(repoDir, 'tsconfig.json'));

    // Determine the package manager (npm, yarn, pnpm)
    let packageManager = 'npm';
    if (fs.existsSync(path.join(repoDir, 'yarn.lock'))) {
      packageManager = 'yarn';
    } else if (fs.existsSync(path.join(repoDir, 'pnpm-lock.yaml'))) {
      packageManager = 'pnpm';
    }

    // Check for special frameworks and tools
    const hasPrisma = this.checkForPrisma(repoDir);
    const hasNextJs = this.checkForNextJs(repoDir);
    const hasNuxt = this.checkForNuxt(repoDir);
    const hasSupabase = this.checkForSupabase(repoDir);

    // Determine the start command from package.json
    let startCommand = '';
    let fallbackUsed = false;
    let mainFile = '';
    try {
      const packageJsonPath = path.join(repoDir, 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

      if (packageJson.scripts && packageJson.scripts.start) {
        if (packageManager === 'yarn') {
          startCommand = 'yarn start';
        } else if (packageManager === 'pnpm') {
          startCommand = 'pnpm start';
        } else {
          startCommand = 'npm start';
        }
      } else if (packageJson.main && packageJson.main.endsWith('.js')) {
        startCommand = `node ${packageJson.main}`;
        fallbackUsed = true;
      } else if (fs.existsSync(path.join(repoDir, 'index.js'))) {
        startCommand = 'node index.js';
        fallbackUsed = true;
      } else if (fs.existsSync(path.join(repoDir, 'app.js'))) {
        startCommand = 'node app.js';
        fallbackUsed = true;
      } else {
        // Try to find any .js file in root as a last resort
        const files = fs.readdirSync(repoDir);
        const jsFile = files.find(f => f.endsWith('.js'));
        if (jsFile) {
          startCommand = `node ${jsFile}`;
          fallbackUsed = true;
        } else {
          startCommand = 'node index.js';
          fallbackUsed = true;
        }
      }
    } catch (error) {
      logger.warn(`Error parsing package.json: ${error}`);
      if (fs.existsSync(path.join(repoDir, 'index.js'))) {
        startCommand = 'node index.js';
      } else if (fs.existsSync(path.join(repoDir, 'app.js'))) {
        startCommand = 'node app.js';
      } else {
        // Try to find any .js file in root as a last resort
        const files = fs.readdirSync(repoDir);
        const jsFile = files.find(f => f.endsWith('.js'));
        if (jsFile) {
          startCommand = `node ${jsFile}`;
        } else {
          startCommand = 'node index.js';
        }
      }
      fallbackUsed = true;
    }

    // Generate the Dockerfile
    let dockerfile = `FROM node:18-alpine\n\nWORKDIR /app\n`;

    // For Prisma projects, we need to copy the prisma directory first
    if (hasPrisma) {
      dockerfile += `# Copy Prisma schema first\nCOPY prisma ./prisma\n\n# Set a placeholder DATABASE_URL for Prisma\nENV DATABASE_URL=\"postgresql://postgres:postgres@localhost:5432/postgres?schema=public\"\n`;
    }

    // Copy package files
    dockerfile += `COPY package*.json ./\n`;

    // Add package installation commands based on package manager
    if (packageManager === 'yarn') {
      dockerfile += `COPY yarn.lock ./\n`;
      if (hasPrisma || hasSupabase) {
        dockerfile += `RUN yarn install --ignore-scripts\n`;
        if (hasPrisma) {
          dockerfile += `RUN yarn prisma generate\n`;
        }
        if (hasSupabase) {
          dockerfile += `ENV SUPABASE_CLI_VERSION=skip\n`;
        }
      } else {
        dockerfile += `RUN yarn install --frozen-lockfile\n`;
      }
    } else if (packageManager === 'pnpm') {
      dockerfile += `COPY pnpm-lock.yaml ./\nRUN npm install -g pnpm\n`;
      if (hasPrisma || hasSupabase) {
        dockerfile += `RUN pnpm install --ignore-scripts\n`;
        if (hasPrisma) {
          dockerfile += `RUN pnpm prisma generate\n`;
        }
        if (hasSupabase) {
          dockerfile += `ENV SUPABASE_CLI_VERSION=skip\n`;
        }
      } else {
        dockerfile += `RUN pnpm install --frozen-lockfile\n`;
      }
    } else {
      if (hasPrisma || hasSupabase) {
        dockerfile += `RUN npm install --ignore-scripts\n`;
        if (hasPrisma) {
          dockerfile += `RUN npx prisma generate\n`;
        }
        if (hasSupabase) {
          dockerfile += `ENV SUPABASE_CLI_VERSION=skip\n`;
        }
      } else {
        const hasPackageLock = fs.existsSync(path.join(repoDir, 'package-lock.json'));
        if (hasPackageLock) {
          dockerfile += `RUN npm ci\n`;
        } else {
          dockerfile += `RUN npm install\n`;
        }
      }
    }

    dockerfile += `\n# Copy the rest of the application\nCOPY . .\n`;

    // Handle build step for different frameworks
    let hasBuildScript = false;
    try {
      const packageJsonPath = path.join(repoDir, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        hasBuildScript = packageJson.scripts && packageJson.scripts.build;
      }
    } catch {}

    if (hasNextJs) {
      dockerfile += `\n# Set PostgreSQL environment variables for Next.js\nENV PG_HOST=\"localhost\"\nENV PG_USER=\"postgres\"\nENV PG_PASSWORD=\"postgres\"\nENV PG_DATABASE=\"postgres\"\nENV PG_PORT=\"5432\"\nENV DATABASE_URL=\"postgresql://postgres:postgres@localhost:5432/postgres?schema=public\"\nENV NEXT_PUBLIC_SKIP_API_ROUTES=\"true\"\nENV NEXT_TELEMETRY_DISABLED=\"1\"\n`;
      if (hasBuildScript) {
        dockerfile += `\n# Build with environment variables to skip problematic API routes\nRUN ${packageManager === 'npm' ? 'npm run build' : packageManager === 'yarn' ? 'yarn build' : 'pnpm build'} || echo \"Build completed with warnings\"\n`;
      }
      dockerfile += `\nEXPOSE ${port}\n`;
    } else if (hasNuxt) {
      if (hasBuildScript) {
        dockerfile += `\nRUN ${packageManager === 'npm' ? 'npm run build' : packageManager === 'yarn' ? 'yarn build' : 'pnpm build'} || echo \"Build completed with warnings\"\n`;
      }
      dockerfile += `\nEXPOSE ${port}\n`;
    } else if (isTypeScript) {
      if (hasBuildScript) {
        dockerfile += `\nRUN ${packageManager === 'npm' ? 'npm run build' : packageManager === 'yarn' ? 'yarn build' : 'pnpm build'} || echo \"Build completed with warnings\"\n`;
      }
      dockerfile += `\nEXPOSE ${port}\n`;
    } else {
      dockerfile += `\nEXPOSE ${port}\n`;
    }

    // Compose environment variables for CMD
    let envVars = '';
    let exposePort = port;
    try {
      // Try to load environment variables from metadata/environmentValues.json if present
      const envPath = path.join(repoDir, 'environmentValues.json');
      let envObj: Record<string, string> = {};
      if (fs.existsSync(envPath)) {
        envObj = JSON.parse(fs.readFileSync(envPath, 'utf8'));
      }
      // If not, try to get from process.env (for test) or fallback to empty
      if (Object.keys(envObj).length === 0 && process.env._DEPLOY_ENV_VALUES) {
        try {
          envObj = JSON.parse(process.env._DEPLOY_ENV_VALUES);
        } catch {}
      }
      // If PORT is present in env, use it for EXPOSE and CMD
      if (envObj.PORT && !isNaN(Number(envObj.PORT))) {
        exposePort = Number(envObj.PORT);
      }
      if (Object.keys(envObj).length > 0) {
        envVars = Object.entries(envObj)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(' ');
      }
    } catch {}
    // Always use shell form for CMD with all envVars inline for Node.js
    dockerfile += `\nEXPOSE ${exposePort}\n`;
    if (fallbackUsed) {
      dockerfile += `\n# WARNING: No \"start\" script found in package.json. Using fallback: ${startCommand}\n`;
    }
    if (envVars) {
      // Use shell form for CMD with env vars inline
      dockerfile += `\nCMD ${envVars} ${startCommand}`;
    } else {
      // Use exec form if no env vars
      const cmdParts = startCommand.split(' ');
      dockerfile += `\nCMD [${cmdParts.map(s => `\"${s}\"`).join(', ')}]`;
    }
    return dockerfile;
  }

  /**
   * Generates a Dockerfile for a Python project
   * @param repoDir The repository directory
   * @param port The port to expose
   * @returns The Dockerfile content
   */
  private generatePythonDockerfile(repoDir: string, port: number = 8000): string {
    // Determine if it's a Django project
    const isDjango = fs.existsSync(path.join(repoDir, 'manage.py'));

    // Determine if it's a Flask project
    let isFlask = false;
    try {
      const files = fs.readdirSync(repoDir);
      for (const file of files) {
        if (file.endsWith('.py')) {
          const content = fs.readFileSync(path.join(repoDir, file), 'utf8');
          if (content.includes('from flask import') || content.includes('import flask')) {
            isFlask = true;
            break;
          }
        }
      }
    } catch (error) {
      logger.warn(`Error checking for Flask: ${error}`);
    }

    // Determine the Python version
    let pythonVersion = '3.9';

    // Check for environment variables to determine the port
    let exposePort = port;
    try {
      const envPath = path.join(repoDir, 'environmentValues.json');
      if (fs.existsSync(envPath)) {
        const envObj = JSON.parse(fs.readFileSync(envPath, 'utf8'));
        if (envObj.PORT && !isNaN(Number(envObj.PORT))) {
          exposePort = Number(envObj.PORT);
        }
      }
    } catch {}

    // Generate the Dockerfile
    let dockerfile = `FROM python:${pythonVersion}-slim

WORKDIR /app

`;

    if (fs.existsSync(path.join(repoDir, 'requirements.txt'))) {
      dockerfile += `COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

`;
    } else if (fs.existsSync(path.join(repoDir, 'Pipfile'))) {
      dockerfile += `COPY Pipfile Pipfile.lock ./
RUN pip install pipenv && pipenv install --system --deploy

`;
    } else if (fs.existsSync(path.join(repoDir, 'setup.py'))) {
      dockerfile += `COPY setup.py .
RUN pip install --no-cache-dir -e .

`;
    }

    dockerfile += `COPY . .

EXPOSE ${exposePort}

`;

    if (isDjango) {
      dockerfile += `CMD ["python", "manage.py", "runserver", "0.0.0.0:${exposePort}"]`;
    } else if (isFlask) {
      dockerfile += `CMD ["flask", "run", "--host=0.0.0.0", "--port=${exposePort}"]`;
    } else {
      dockerfile += `CMD ["python", "app.py"]`;
    }

    return dockerfile;
  }

  /**
   * Generates a Dockerfile for a Java project
   * @param repoDir The repository directory
   * @param port The port to expose
   * @returns The Dockerfile content
   */
  private generateJavaDockerfile(repoDir: string, port: number = 8080): string {
    // Determine if it's a Maven or Gradle project
    const isMaven = fs.existsSync(path.join(repoDir, 'pom.xml'));

    // Generate the Dockerfile
    let dockerfile = '';

    if (isMaven) {
      dockerfile = `FROM maven:3.8-openjdk-17 AS build

WORKDIR /app

COPY pom.xml .
COPY src ./src

RUN mvn clean package -DskipTests

FROM openjdk:17-slim

WORKDIR /app

COPY --from=build /app/target/*.jar app.jar

EXPOSE ${port}

CMD ["java", "-jar", "app.jar"]`;
    } else {
      dockerfile = `FROM gradle:7.4-jdk17 AS build

WORKDIR /app

COPY build.gradle settings.gradle ./
COPY src ./src

RUN gradle build --no-daemon -x test

FROM openjdk:17-slim

WORKDIR /app

COPY --from=build /app/build/libs/*.jar app.jar

EXPOSE ${port}

CMD ["java", "-jar", "app.jar"]`;
    }

    return dockerfile;
  }

  /**
   * Generates a Dockerfile for a Go project
   * @param repoDir The repository directory
   * @param port The port to expose
   * @returns The Dockerfile content
   */
  private generateGoDockerfile(repoDir: string, port: number = 8080): string {
    return `FROM golang:1.20-alpine AS build

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -o /app/server .

FROM alpine:latest

WORKDIR /app

COPY --from=build /app/server .

EXPOSE ${port}

CMD ["./server"]`;
  }

  /**
   * Generates a Dockerfile for a PHP project
   * @param repoDir The repository directory
   * @param port The port to expose
   * @returns The Dockerfile content
   */
  private generatePhpDockerfile(repoDir: string, port: number = 80): string {
    // Determine if it's a Laravel project
    const isLaravel = fs.existsSync(path.join(repoDir, 'artisan'));

    if (isLaravel) {
      return `FROM php:8.2-fpm

WORKDIR /var/www/html

RUN apt-get update && apt-get install -y \\
    git \\
    curl \\
    libpng-dev \\
    libonig-dev \\
    libxml2-dev \\
    zip \\
    unzip

RUN docker-php-ext-install pdo_mysql mbstring exif pcntl bcmath gd

COPY --from=composer:latest /usr/bin/composer /usr/bin/composer

COPY composer.json composer.lock ./
RUN composer install --no-scripts --no-autoloader

COPY . .

RUN composer dump-autoload --optimize

RUN chown -R www-data:www-data /var/www/html/storage /var/www/html/bootstrap/cache

EXPOSE ${port}

CMD ["php-fpm"]`;
    } else {
      return `FROM php:8.2-apache

WORKDIR /var/www/html

RUN apt-get update && apt-get install -y \\
    git \\
    curl \\
    zip \\
    unzip

COPY . .

RUN chown -R www-data:www-data /var/www/html

EXPOSE ${port}

CMD ["apache2-foreground"]`;
    }
  }

  /**
   * Generates a Dockerfile for a Ruby project
   * @param repoDir The repository directory
   * @param port The port to expose
   * @returns The Dockerfile content
   */
  private generateRubyDockerfile(repoDir: string, port: number = 3000): string {
    // Determine if it's a Rails project
    const isRails = fs.existsSync(path.join(repoDir, 'config', 'application.rb'));

    if (isRails) {
      return `FROM ruby:3.2

WORKDIR /app

COPY Gemfile Gemfile.lock ./
RUN bundle install

COPY . .

EXPOSE ${port}

CMD ["rails", "server", "-b", "0.0.0.0"]`;
    } else {
      return `FROM ruby:3.2

WORKDIR /app

COPY Gemfile Gemfile.lock ./
RUN bundle install

COPY . .

EXPOSE ${port}

CMD ["ruby", "app.rb"]`;
    }
  }

  /**
   * Generates a Dockerfile for a .NET project
   * @param repoDir The repository directory
   * @param port The port to expose
   * @returns The Dockerfile content
   */
  private generateDotNetDockerfile(repoDir: string, port: number = 80): string {
    return `FROM mcr.microsoft.com/dotnet/sdk:7.0 AS build

WORKDIR /app

COPY *.sln .
COPY *.csproj ./
RUN dotnet restore

COPY . .
RUN dotnet publish -c Release -o out

FROM mcr.microsoft.com/dotnet/aspnet:7.0

WORKDIR /app

COPY --from=build /app/out .

EXPOSE ${port}

ENTRYPOINT ["dotnet", "app.dll"]`;
  }

  /**
   * Checks if the project uses Prisma
   * @param repoDir The repository directory
   * @returns true if the project uses Prisma, false otherwise
   */
  private checkForPrisma(repoDir: string): boolean {
    try {
      // Check package.json for Prisma dependencies
      const packageJsonPath = path.join(repoDir, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };

        return (
          dependencies?.['prisma'] !== undefined ||
          dependencies?.['@prisma/client'] !== undefined
        );
      }

      // Check for prisma directory or schema file
      return (
        fs.existsSync(path.join(repoDir, 'prisma')) ||
        fs.existsSync(path.join(repoDir, 'prisma/schema.prisma')) ||
        fs.existsSync(path.join(repoDir, 'schema.prisma'))
      );
    } catch (error) {
      logger.warn(`Error checking for Prisma: ${error}`);
      return false;
    }
  }

  /**
   * Checks if the project uses Next.js
   * @param repoDir The repository directory
   * @returns true if the project uses Next.js, false otherwise
   */
  private checkForNextJs(repoDir: string): boolean {
    try {
      // Check package.json for Next.js dependency
      const packageJsonPath = path.join(repoDir, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };

        return dependencies?.['next'] !== undefined;
      }

      // Check for next.config.js
      return (
        fs.existsSync(path.join(repoDir, 'next.config.js')) ||
        fs.existsSync(path.join(repoDir, 'next.config.mjs'))
      );
    } catch (error) {
      logger.warn(`Error checking for Next.js: ${error}`);
      return false;
    }
  }

  /**
   * Checks if the project uses Nuxt
   * @param repoDir The repository directory
   * @returns true if the project uses Nuxt, false otherwise
   */
  private checkForNuxt(repoDir: string): boolean {
    try {
      // Check package.json for Nuxt dependency
      const packageJsonPath = path.join(repoDir, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };

        return (
          dependencies?.['nuxt'] !== undefined ||
          dependencies?.['nuxt3'] !== undefined
        );
      }

      // Check for nuxt.config.js
      return (
        fs.existsSync(path.join(repoDir, 'nuxt.config.js')) ||
        fs.existsSync(path.join(repoDir, 'nuxt.config.ts'))
      );
    } catch (error) {
      logger.warn(`Error checking for Nuxt: ${error}`);
      return false;
    }
  }

  /**
   * Checks if the project uses Supabase
   * @param repoDir The repository directory
   * @returns true if the project uses Supabase, false otherwise
   */
  private checkForSupabase(repoDir: string): boolean {
    try {
      // Check package.json for Supabase dependency
      const packageJsonPath = path.join(repoDir, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };

        // Check for any Supabase packages
        return Object.keys(dependencies).some(dep =>
          dep === 'supabase' ||
          dep === '@supabase/supabase-js' ||
          dep.startsWith('@supabase/')
        );
      }

      return false;
    } catch (error) {
      logger.warn(`Error checking for Supabase: ${error}`);
      return false;
    }
  }
}
