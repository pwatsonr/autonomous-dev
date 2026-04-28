# PRD-014: Deployment Backends Framework

| Field       | Value                                      |
|-------------|--------------------------------------------|
| **Title**   | Deployment Backends Framework               |
| **PRD ID**  | PRD-014                                    |
| **Version** | 1.0                                        |
| **Date**    | 2026-04-28                                 |
| **Author**  | Patrick Watson                             |
| **Status**  | Draft                                      |
| **Plugin**  | autonomous-dev                             |

---

## 1. Problem Statement

The autonomous-dev pipeline's deploy phase (PRD-001 §6.3 FR-304) is currently a placeholder that commits changes and opens a pull request. While this satisfies the state machine requirement to transition from `integration` to `deploy` to `monitor`, it provides no actual deployment capability. Real-world deployment requires building artifacts, pushing to registries, applying infrastructure changes, performing health checks, and rolling back on failure—all while adapting to diverse target environments ranging from cloud providers to Kubernetes clusters to homelab configurations.

**The current stub deployment approach fails in several critical ways:**

1. **No artifact building**: Generated code remains as uncommitted changes in git worktrees with no path to executable artifacts (container images, binaries, static sites, lambda functions).

2. **No environment abstraction**: Operators cannot specify whether code should deploy to their local Docker daemon, a GCP Cloud Run service, an AWS ECS cluster, or their homelab Kubernetes setup—the system only knows how to create git branches.

3. **No deployment verification**: After "deployment" (PR creation), there's no health checking, monitoring, or rollback capability. The system has no awareness of whether deployed code actually works.

4. **No multi-environment support**: Production workflows require separate dev/staging/prod environments with different configurations, approval gates, and deployment targets. The current model supports only a single implicit "environment" (the PR).

5. **No cost/resource management**: Cloud deployments consume billable resources that must be tracked, capped, and cleaned up. Local deployments consume disk/CPU that must be monitored. The current model has no resource abstraction.

**The solution is a backends framework** that generalizes deployment into a pluggable interface. Each backend (local, gcp, aws, azure, k8s, static, docker-local) implements a uniform contract for build/deploy/health-check/rollback operations. The framework handles environment selection, credential management, trust integration, and observability while backends focus on their specific deployment mechanics.

This approach transforms the deploy phase from a git-only operation into a true deployment capability that can target any environment an operator configures, with the safety and observability characteristics required for autonomous operation.

---

## 2. Goals

| ID   | Goal                                                                                         |
|------|----------------------------------------------------------------------------------------------|
| G-01 | Replace the stub deploy phase with a backends framework that supports pluggable deployment targets through a uniform TypeScript interface. |
| G-02 | Ship 4 bundled backends (local, static, docker-local, github-pages) that prove the framework without requiring cloud credentials, enabling immediate operator adoption. |
| G-03 | Define extension hooks for cloud backends (gcp, aws, azure, k8s) that ship as separate plugins, demonstrating the framework's extensibility without bloating the core. |
| G-04 | Support multi-environment deployment (dev/staging/prod) with per-environment configuration, trust gates, and approval workflows integrated with PRD-007's escalation framework. |
| G-05 | Implement comprehensive deployment lifecycle management including build context assembly, artifact generation, deployment execution, health verification, and automated rollback capabilities. |
| G-06 | Provide cost and resource tracking that integrates with PRD-001's governance framework, supporting both cloud spend monitoring and local resource consumption limits. |
| G-07 | Ensure deployment operations are fully auditable with structured logging, deployment records, and integration with PRD-007's audit trail requirements. |
| G-08 | Maintain backward compatibility where existing repos default to the `local` backend (equivalent to today's behavior) until operators explicitly configure alternative backends. |

## 3. Non-Goals

| ID    | Non-Goal                                                                                    |
|-------|---------------------------------------------------------------------------------------------|
| NG-01 | Not a CI/CD replacement. The framework assumes CI has run successfully (PRD-010) and focuses solely on deployment of validated artifacts. |
| NG-02 | Not an infrastructure-as-code authoring system. Backends consume operator-provided infrastructure (existing clusters, configured services) rather than creating it. |
| NG-03 | Not a multi-cloud orchestration platform. Each backend targets a single deployment environment; cross-cloud deployments are achieved through multiple backend configurations, not unified orchestration. |
| NG-04 | Not a service mesh or traffic management system. Backends deploy individual applications; advanced networking, load balancing, and canary deployments are handled by the target environment (K8s ingress, cloud load balancers). |
| NG-05 | Not a monitoring or observability system. Health checks verify basic deployment success; comprehensive monitoring is provided by external systems (Prometheus, cloud monitoring) that backends may optionally integrate with. |
| NG-06 | Not a secrets management system. Backends consume operator-provided credentials via standard mechanisms (AWS profiles, kubeconfig files) without storing or managing secrets themselves. |

---

## 4. User Stories

### Backend Selection and Configuration

| ID    | Story                                                                                                                                                              | Priority |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| US-01 | As an operator, I want to configure my repository to use the `docker-local` backend for development so that generated web applications are built into containers and run locally where I can test them immediately. | P0       |
| US-02 | As an operator, I want to configure production deployments to use the `gcp` backend with Cloud Run while keeping dev deployments on `docker-local` so that I can test locally and deploy to production with the same codebase. | P1       |
| US-03 | As an operator, I want to create a `.autonomous-dev/deploy.yaml` file that specifies different backends per environment so that dev uses `docker-local`, staging uses `k8s`, and prod uses `gcp`. | P0       |
| US-04 | As an operator, I want to configure backend-specific settings (like Docker registry, GCP project, or Kubernetes namespace) in the deployment configuration so that each backend has the context it needs to operate. | P0       |

### Development Workflow

| ID    | Story                                                                                                                                                              | Priority |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| US-05 | As a developer, I want the `local` backend to behave exactly like today's deploy phase (commit + PR) so that repositories without deployment configuration continue working without changes. | P0       |
| US-06 | As a developer, I want the `static` backend to rsync generated static sites to my web server so that documentation changes and static web applications are automatically published. | P1       |
| US-07 | As a developer, I want the `github-pages` backend to deploy generated documentation to GitHub Pages so that API docs and project websites are automatically updated when the autonomous system generates them. | P1       |
| US-08 | As a developer, I want the system to automatically select the appropriate backend for my repository based on detected project type (static site, Node.js app, Python service) if I haven't configured one explicitly. | P2       |

### Cloud Deployment

| ID    | Story                                                                                                                                                              | Priority |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| US-09 | As an operator with GCP credentials, I want to install the `autonomous-dev-deploy-gcp` plugin and configure it to deploy web services to Cloud Run so that generated applications are production-ready and scalable. | P1       |
| US-10 | As an operator with AWS access, I want to install the `autonomous-dev-deploy-aws` plugin and deploy containers to ECS Fargate so that I can use my existing AWS infrastructure for autonomous deployments. | P1       |
| US-11 | As an operator with a Kubernetes cluster, I want to install the `autonomous-dev-deploy-k8s` plugin and deploy applications via kubectl so that generated services integrate with my existing K8s workloads. | P1       |
| US-12 | As an operator, I want cloud backends to automatically clean up failed deployments to avoid accumulating orphaned resources that continue billing me. | P1       |

### Environment Management

| ID    | Story                                                                                                                                                              | Priority |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| US-13 | As an operator, I want to require manual approval for production deployments regardless of trust level so that critical environments are protected even during autonomous operation. | P0       |
| US-14 | As an operator, I want development environment deployments to proceed automatically at trust levels L2+ while staging and production require approval gates so that I can iterate quickly in dev without compromising safety in higher environments. | P0       |
| US-15 | As an operator, I want different cost caps per environment so that dev deployments can spend $10/day but production deployments require approval for spend over $100/day. | P1       |
| US-16 | As an operator, I want to configure different backend settings per environment so that dev uses a local Docker registry while prod uses ECR, even when both use container-based backends. | P1       |

### Deployment Operations

| ID    | Story                                                                                                                                                              | Priority |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| US-17 | As an operator, I want to see structured deployment logs that show build start/completion, artifact creation, deployment execution, and health check results so that I can diagnose deployment failures. | P0       |
| US-18 | As an operator, I want automatic rollback when health checks fail so that broken deployments don't remain live in production environments. | P0       |
| US-19 | As an operator, I want to manually trigger rollback for any deployment within 24 hours via `autonomous-dev deploy rollback REQ-NNNNNN` so that I can revert problematic changes quickly. | P0       |
| US-20 | As an operator, I want deployment cost tracking integrated with the existing cost governance so that cloud deployment costs count toward my daily/monthly spending limits. | P1       |

### Observability and Troubleshooting

| ID    | Story                                                                                                                                                              | Priority |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| US-21 | As an operator, I want each deployment to create a unique deployment record with artifact metadata, environment details, and deployment timestamp so that I can audit what was deployed when and where. | P0       |
| US-22 | As an operator, I want to view live deployment status during long-running operations (like container image builds) so that I know the system is making progress and hasn't stalled. | P1       |
| US-23 | As an operator, I want failed deployments to include diagnostic information (build logs, error messages, resource states) in the escalation so that I can understand what went wrong without manually investigating. | P0       |
| US-24 | As an operator, I want deployment events to appear in the web portal (PRD-009) so that I can monitor deployment progress alongside other pipeline phases in a unified dashboard. | P1       |

---

## 5. Functional Requirements

### 5.1 Backend Interface and Lifecycle

| ID      | Priority | Requirement                                                                                        |
|---------|----------|----------------------------------------------------------------------------------------------------|
| FR-1401 | P0       | The system SHALL define a TypeScript interface `DeploymentBackend` with methods: `build(ctx: BuildContext): Promise<BuildArtifact>`, `deploy(artifact: BuildArtifact, env: TargetEnvironment): Promise<DeploymentRecord>`, `healthCheck(deployment: DeploymentRecord): Promise<HealthStatus>`, `rollback(deployment: DeploymentRecord): Promise<RollbackResult>`, and optional `monitor(deployment: DeploymentRecord): Promise<MonitorHandle>`. |
| FR-1402 | P0       | Each backend SHALL implement the interface with a unique `name` string property that identifies the backend type (e.g., "local", "gcp", "docker-local"). |
| FR-1403 | P0       | The `build()` method SHALL accept a `BuildContext` containing repository path, request ID, target environment, detected language/framework, and any build parameters from the deployment configuration. |
| FR-1404 | P0       | The `build()` method SHALL produce a `BuildArtifact` containing artifact metadata, content-addressed identifier, and any backend-specific data needed for deployment. |
| FR-1405 | P0       | The `deploy()` method SHALL execute the deployment using the provided artifact and target environment, returning a `DeploymentRecord` with deployment ID, deployed endpoint (if applicable), timestamp, and rollback metadata. |
| FR-1406 | P0       | The `healthCheck()` method SHALL verify basic deployment functionality and return a `HealthStatus` indicating success, failure, or degraded state with diagnostic information. |
| FR-1407 | P0       | The `rollback()` method SHALL revert the deployment to the previous stable state using information from the `DeploymentRecord` and return success/failure status. |
| FR-1408 | P1       | The optional `monitor()` method SHALL return a long-lived handle that can stream logs, metrics, or status updates for integration with the web portal (PRD-009). |
| FR-1409 | P0       | All backend methods SHALL be idempotent: calling the same method with the same parameters SHALL produce the same outcome or safely no-op if already completed. |
| FR-1410 | P1       | Each backend SHALL declare its expected cost characteristics: `free`, `pay-per-build`, `pay-per-runtime`, or `custom` to support cost governance integration. |

### 5.2 Backend Registration and Discovery

| ID      | Priority | Requirement                                                                                        |
|---------|----------|----------------------------------------------------------------------------------------------------|
| FR-1411 | P0       | The system SHALL ship with four bundled backends: `local` (current behavior), `static` (rsync to server), `docker-local` (build and run containers locally), and `github-pages` (deploy to GitHub Pages). |
| FR-1412 | P0       | The system SHALL support dynamic backend registration where plugins can register additional backends through a registration API during plugin initialization. |
| FR-1413 | P1       | Cloud backend plugins SHALL be distributed as separate plugins (`autonomous-dev-deploy-gcp`, `autonomous-dev-deploy-aws`, `autonomous-dev-deploy-azure`, `autonomous-dev-deploy-k8s`) that register with the core framework when installed. |
| FR-1414 | P0       | The system SHALL validate backend implementations at registration time, ensuring all required interface methods are present and callable. |
| FR-1415 | P1       | The system SHALL provide a `autonomous-dev deploy backends` command that lists all registered backends with their capabilities and current status. |
| FR-1416 | P1       | Backend registration SHALL support capability declarations (e.g., "supports-rollback", "requires-credentials", "multi-environment") for UI and validation purposes. |

### 5.3 Environment and Configuration Management

| ID      | Priority | Requirement                                                                                        |
|---------|----------|----------------------------------------------------------------------------------------------------|
| FR-1417 | P0       | Each repository SHALL support a deployment configuration file at `.autonomous-dev/deploy.yaml` specifying backend and environment settings. |
| FR-1418 | P0       | The deployment configuration SHALL support environment-specific sections (dev, staging, prod) with independent backend selection and settings. |
| FR-1419 | P0       | If no deployment configuration exists, the system SHALL default to the `local` backend for all environments, maintaining backward compatibility. |
| FR-1420 | P0       | Environment configuration SHALL support backend-specific settings sections (e.g., `gcp.project`, `k8s.namespace`, `static.target_host`) that are passed to the backend during deployment. |
| FR-1421 | P1       | The system SHALL support environment inheritance where staging inherits dev settings and prod inherits staging settings, with explicit overrides allowed. |
| FR-1422 | P1       | Environment names SHALL be configurable per repository, allowing custom naming schemes beyond the default dev/staging/prod. |
| FR-1423 | P0       | The system SHALL validate deployment configurations on daemon startup, reporting configuration errors clearly rather than failing during deployment. |
| FR-1424 | P1       | Configuration changes SHALL be hot-reloadable without daemon restart, taking effect at the next deployment operation. |

### 5.4 Build Context and Artifact Management

| ID      | Priority | Requirement                                                                                        |
|---------|----------|----------------------------------------------------------------------------------------------------|
| FR-1425 | P0       | The system SHALL detect project type (static site, Node.js, Python, Go, Rust, Java) based on repository contents and provide this information to backends in the build context. |
| FR-1426 | P0       | Build context SHALL include repository absolute path, request ID, target environment name, Git commit SHA of the code being deployed, and any environment-specific build parameters. |
| FR-1427 | P0       | Backends SHALL store build artifacts in a content-addressed location under `.autonomous-dev/artifacts/{content-hash}/` to enable artifact reuse and integrity verification. |
| FR-1428 | P1       | The system SHALL support artifact caching where identical build contexts produce references to existing artifacts rather than rebuilding. |
| FR-1429 | P0       | Build artifacts SHALL include metadata (creation timestamp, build duration, artifact size, dependency versions) for observability and debugging. |
| FR-1430 | P1       | The system SHALL implement artifact garbage collection, removing unused artifacts older than a configurable retention period (default: 30 days). |
| FR-1431 | P1       | Build artifacts SHALL support integrity verification through checksums to detect corruption or tampering. |

### 5.5 Credential and Secret Management

| ID      | Priority | Requirement                                                                                        |
|---------|----------|----------------------------------------------------------------------------------------------------|
| FR-1432 | P0       | Backends SHALL access credentials through standard platform mechanisms: AWS profiles (`~/.aws/credentials`), Google Cloud SDK (`gcloud auth`), Kubernetes config (`~/.kube/config`), SSH keys (`~/.ssh/`). |
| FR-1433 | P0       | The deployment framework SHALL NOT store, cache, or log credentials in any form. |
| FR-1434 | P0       | Deployment configurations MAY reference environment variable names for credentials (e.g., `docker_registry_token_env: DOCKER_TOKEN`) following the existing `intake.*.token_env` pattern from PRD-008. |
| FR-1435 | P0       | Backend credential validation SHALL occur during configuration validation, not during deployment, to fail fast on credential issues. |
| FR-1436 | P1       | The system SHALL support credential rotation by detecting credential changes and updating internal references without requiring configuration changes. |
| FR-1437 | P1       | Backends SHALL implement timeout-based credential refresh for long-running operations to handle token expiration gracefully. |

### 5.6 Deployment Execution and Orchestration

| ID      | Priority | Requirement                                                                                        |
|---------|----------|----------------------------------------------------------------------------------------------------|
| FR-1438 | P0       | The deployment phase SHALL begin after successful integration test completion and PR merge, receiving the final Git commit SHA as input. |
| FR-1439 | P0       | For each configured environment, the system SHALL execute deployment in sequence: build → deploy → healthCheck, with failure in any step aborting the environment and triggering rollback. |
| FR-1440 | P0       | Multi-environment deployments SHALL execute in order (dev → staging → prod) with each environment requiring successful completion of the previous environment. |
| FR-1441 | P0       | Trust level integration SHALL apply environment-specific approval gates: dev may proceed autonomously at L2+, staging requires approval at L0-L1, prod always requires approval regardless of trust level. |
| FR-1442 | P1       | Deployment operations SHALL support configurable timeouts per phase (build timeout, deploy timeout, health check timeout) to prevent indefinite hangs. |
| FR-1443 | P1       | The system SHALL support parallel environment deployment where environments are truly independent (e.g., separate test clusters). |
| FR-1444 | P0       | Failed deployments SHALL trigger automatic rollback for the failed environment without affecting other successfully deployed environments. |

### 5.7 Health Checking and Monitoring

| ID      | Priority | Requirement                                                                                        |
|---------|----------|----------------------------------------------------------------------------------------------------|
| FR-1445 | P0       | Health checks SHALL execute immediately after deployment completion with a configurable timeout (default: 60 seconds). |
| FR-1446 | P0       | Health check implementation SHALL be backend-specific: HTTP endpoint checks for web services, container status for Docker, pod readiness for Kubernetes. |
| FR-1447 | P0       | Health check failure SHALL trigger automatic rollback unless the deployment is marked as `no-auto-rollback` in the configuration. |
| FR-1448 | P1       | Health checks SHALL support retry logic with configurable attempts (default: 3) and backoff intervals to handle transient startup issues. |
| FR-1449 | P1       | The system SHALL support custom health check commands specified in deployment configuration for complex applications requiring specialized validation. |
| FR-1450 | P1       | Continuous monitoring SHALL be available through the optional `monitor()` backend method, providing real-time status updates for the web portal. |
| FR-1451 | P1       | Health check results SHALL be stored in deployment records for historical analysis and debugging of intermittent deployment issues. |

### 5.8 Rollback and Recovery

| ID      | Priority | Requirement                                                                                        |
|---------|----------|----------------------------------------------------------------------------------------------------|
| FR-1452 | P0       | Every successful deployment SHALL create a rollback record containing sufficient information to revert to the previous stable state. |
| FR-1453 | P0       | Rollback records SHALL be retained for a configurable period (default: 24 hours) after which manual rollback is no longer supported. |
| FR-1454 | P0       | The system SHALL support manual rollback via `autonomous-dev deploy rollback REQ-NNNNNN [environment]` for any deployment within the retention period. |
| FR-1455 | P0       | Automatic rollback SHALL be triggered by health check failures and SHALL complete within the deployment timeout period. |
| FR-1456 | P1       | Rollback operations SHALL be logged with the same detail level as forward deployments for audit and debugging purposes. |
| FR-1457 | P1       | Failed rollback operations SHALL escalate immediately to human intervention with detailed diagnostic information. |
| FR-1458 | P1       | The system SHALL support rollback validation through health checks to ensure rollback operations restored service functionality. |

### 5.9 Cost Tracking and Resource Management

| ID      | Priority | Requirement                                                                                        |
|---------|----------|----------------------------------------------------------------------------------------------------|
| FR-1459 | P0       | Deployment costs SHALL integrate with PRD-001's cost governance framework, contributing to daily and monthly spending limits. |
| FR-1460 | P0       | Each backend SHALL report deployment costs in a standardized format: build cost, runtime cost, and projected monthly cost for continuous services. |
| FR-1461 | P1       | The system SHALL enforce per-environment cost caps configured in deployment settings, escalating when caps are exceeded. |
| FR-1462 | P1       | Cloud backends SHALL implement resource cleanup on deployment failure to prevent accumulating billable orphaned resources. |
| FR-1463 | P1       | Local backends SHALL track disk and CPU usage, contributing to resource governance limits defined in PRD-001. |
| FR-1464 | P1       | Cost projections SHALL be calculated before deployment and included in approval gate notifications for high-cost deployments. |
| FR-1465 | P1       | The system SHALL provide cost tracking APIs for backends to report real-time spending to external cost monitoring systems. |

### 5.10 Audit Trail and Observability

| ID      | Priority | Requirement                                                                                        |
|---------|----------|----------------------------------------------------------------------------------------------------|
| FR-1466 | P0       | Every deployment operation SHALL log structured events to both the standard daemon log and a per-deployment log file under `<repo>/.autonomous-dev/deploys/<deploy-id>/`. |
| FR-1467 | P0       | Deployment events SHALL integrate with PRD-007's audit trail, recording deployment start, build completion, artifact creation, deployment execution, health check results, and rollback events. |
| FR-1468 | P0       | Each deployment SHALL receive a unique deployment ID in the format `DEP-{request-id}-{environment}-{timestamp}` for tracking and correlation. |
| FR-1469 | P0       | Deployment records SHALL be persisted to `<repo>/.autonomous-dev/deploys/<deploy-id>/deployment.json` containing all metadata needed for rollback and audit purposes. |
| FR-1470 | P1       | Deployment logs SHALL include timing information (phase durations), resource consumption (build time, artifact size), and outcome data for performance analysis. |
| FR-1471 | P1       | Failed deployments SHALL capture diagnostic snapshots (error messages, resource states, configuration used) for troubleshooting escalations. |
| FR-1472 | P1       | The system SHALL support log streaming to external systems (ELK, Splunk, CloudWatch) through configurable log forwarding adapters. |

---

## 6. Non-Functional Requirements

| ID       | Priority | Requirement                                                                                      |
|----------|----------|--------------------------------------------------------------------------------------------------|
| NFR-1401 | P0       | **Deployment Latency**: Local deployments MUST complete within 2 minutes, cloud deployments within 10 minutes, excluding application startup time. |
| NFR-1402 | P0       | **Rollback Speed**: Automatic rollback MUST complete within 5 minutes of health check failure to minimize service disruption. |
| NFR-1403 | P0       | **Credential Security**: Credentials MUST never be logged, cached, or transmitted in plaintext. All credential access MUST use secure platform APIs. |
| NFR-1404 | P0       | **Resource Cleanup**: Failed deployments MUST clean up created resources within 10 minutes to prevent resource leaks and unexpected costs. |
| NFR-1405 | P1       | **Deployment Reliability**: The deployment process MUST survive network interruptions and resume gracefully for operations longer than 30 seconds. |
| NFR-1406 | P1       | **Backend Isolation**: Backend failures MUST NOT affect other backends or core deployment framework functionality. |
| NFR-1407 | P1       | **Configuration Validation**: Invalid deployment configurations MUST be detected within 5 seconds of loading with clear error messages. |
| NFR-1408 | P1       | **Artifact Integrity**: Build artifacts MUST be verified for integrity before deployment using checksums to detect corruption. |
| NFR-1409 | P1       | **Observability**: All deployment operations MUST emit structured logs and metrics suitable for automated monitoring and alerting. |
| NFR-1410 | P0       | **Backward Compatibility**: Repositories without deployment configuration MUST continue functioning exactly as before with zero behavioral changes. |

---

## 7. Architecture

### 7.1 System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Autonomous-Dev Pipeline                      │
│  intake → prd → tdd → plan → spec → code → review → integration │
└─────────────────────────────┬───────────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────────┐
│                    Deploy Phase (Enhanced)                     │
│                                                                 │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────┐ │
│  │ Config Loader   │    │ Backend Router  │    │ Trust Gates │ │
│  │ - .../deploy.yaml│    │ - Select backend│    │ - Environment│ │
│  │ - Environment   │────▶│ - Route to impl │────▶│   approval  │ │
│  │   selection     │    │                 │    │ - Cost caps │ │
│  └─────────────────┘    └─────────────────┘    └─────────────┘ │
│                                   │                             │
└───────────────────────────────────┼─────────────────────────────┘
                                    │
┌───────────────────────────────────▼─────────────────────────────┐
│                     Backend Framework                          │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────┐ │
│  │   Bundled   │  │   Cloud     │  │ Kubernetes  │  │ Custom  │ │
│  │  Backends   │  │  Backends   │  │   Backend   │  │Backends │ │
│  │             │  │             │  │             │  │         │ │
│  │ • local     │  │ • gcp       │  │ • k8s       │  │ • ...   │ │
│  │ • static    │  │ • aws       │  │             │  │         │ │
│  │ • docker-   │  │ • azure     │  │             │  │         │ │
│  │   local     │  │             │  │             │  │         │ │
│  │ • github-   │  │             │  │             │  │         │ │
│  │   pages     │  │             │  │             │  │         │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────┘ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Target Environments                          │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────┐ │
│  │    Local    │  │   Cloud     │  │ Kubernetes  │  │Homelab  │ │
│  │             │  │             │  │             │  │         │ │
│  │ • Git repos │  │ • Cloud Run │  │ • Pods      │  │ • k3s   │ │
│  │ • Docker    │  │ • ECS       │  │ • Services  │  │ • VMs   │ │
│  │ • Static    │  │ • ACR/ECR   │  │ • Ingress   │  │ • Bare  │ │
│  │   files     │  │ • Lambda    │  │             │  │   metal │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 7.2 Backend Interface Flow

```
                    ┌─────────────────────────┐
                    │     Deploy Phase        │
                    │                         │
                    │  1. Load config         │
                    │  2. Select environments │
                    │  3. Apply trust gates   │
                    └────────────┬────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────────┐
│                    For Each Environment                            │
│                                                                    │
│  build(context) ────▶ deploy(artifact, env) ────▶ healthCheck()   │
│       │                        │                        │         │
│       ▼                        ▼                        ▼         │
│  BuildArtifact           DeploymentRecord          HealthStatus    │
│                                 │                        │         │
│                                 ▼                        │         │
│                          Store for rollback              │         │
│                                                          │         │
│                            Success? ◀───────────────────┘         │
│                               │ No                                 │
│                               ▼                                    │
│                          rollback()                               │
│                               │                                    │
│                               ▼                                    │
│                          Escalate                                 │
└────────────────────────────────────────────────────────────────────┘
```

---

## 8. Backend Interface Specification

### 8.1 Core Types

```typescript
interface BuildContext {
  requestId: string;
  repositoryPath: string;
  targetEnvironment: TargetEnvironment;
  gitCommitSha: string;
  detectedLanguage?: ProjectLanguage;
  detectedFramework?: string;
  buildParameters?: Record<string, any>;
  environmentConfig: EnvironmentConfig;
}

interface BuildArtifact {
  artifactId: string; // Content-addressed identifier
  contentHash: string;
  createdAt: string;
  buildDurationMs: number;
  artifactSizeBytes: number;
  artifactPath: string; // Local path to artifact
  metadata: Record<string, any>; // Backend-specific data
}

interface TargetEnvironment {
  name: string; // "dev", "staging", "prod"
  backendType: string; // "gcp", "aws", "k8s", etc.
  config: EnvironmentConfig;
  trustLevel: number;
  approvalRequired: boolean;
}

interface EnvironmentConfig {
  backend: string;
  settings: Record<string, any>; // Backend-specific config
  costCap?: number; // USD per deployment
  timeouts?: {
    build?: number; // Seconds
    deploy?: number;
    healthCheck?: number;
  };
}

interface DeploymentRecord {
  deploymentId: string;
  requestId: string;
  environment: string;
  artifactId: string;
  deployedAt: string;
  deployedEndpoint?: string; // URL if applicable
  rollbackData: Record<string, any>; // Backend-specific rollback info
  cost?: number; // Actual deployment cost in USD
  status: 'deploying' | 'healthy' | 'degraded' | 'failed';
}

interface HealthStatus {
  healthy: boolean;
  checkType: string; // "http", "container", "custom"
  responseTime?: number;
  details?: string;
  degradedReasons?: string[];
}

interface RollbackResult {
  success: boolean;
  rolledBackTo?: string; // Previous deployment ID
  error?: string;
  rollbackDurationMs?: number;
}

interface MonitorHandle {
  close(): Promise<void>;
  getLogs(): AsyncIterable<string>;
  getMetrics?(): Promise<Record<string, number>>;
}
```

### 8.2 Backend Interface

```typescript
interface DeploymentBackend {
  readonly name: string;
  readonly capabilities: BackendCapabilities;
  readonly costModel: 'free' | 'pay-per-build' | 'pay-per-runtime' | 'custom';

  // Core lifecycle methods
  build(context: BuildContext): Promise<BuildArtifact>;
  deploy(artifact: BuildArtifact, env: TargetEnvironment): Promise<DeploymentRecord>;
  healthCheck(deployment: DeploymentRecord): Promise<HealthStatus>;
  rollback(deployment: DeploymentRecord): Promise<RollbackResult>;

  // Optional monitoring
  monitor?(deployment: DeploymentRecord): Promise<MonitorHandle>;

  // Lifecycle hooks
  validateConfig?(config: EnvironmentConfig): Promise<ConfigValidationResult>;
  cleanup?(deployment: DeploymentRecord): Promise<void>;
}

interface BackendCapabilities {
  supportsRollback: boolean;
  supportsMonitoring: boolean;
  supportsMultipleEnvironments: boolean;
  requiresCredentials: boolean;
  supportedProjectTypes: ProjectLanguage[];
}
```

---

## 9. Bundled Backends (Phase 1)

### 9.1 Local Backend

**Purpose**: Maintain backward compatibility with current git-based "deployment."

**Implementation**:
- `build()`: No-op, returns a git commit artifact
- `deploy()`: Commits changes and creates PR (existing behavior)
- `healthCheck()`: Always succeeds if PR is created
- `rollback()`: Reverts the commit/closes PR

**Configuration**: None required

**Use case**: Default behavior for repos without deployment config

### 9.2 Static Backend

**Purpose**: Deploy static sites and documentation via rsync.

**Implementation**:
- `build()`: Runs static site generator (detected or configured)
- `deploy()`: rsyncs generated files to configured host
- `healthCheck()`: HTTP GET to verify deployed content
- `rollback()`: rsyncs previous version from backup directory

**Configuration**:
```yaml
static:
  target_host: "web.example.com"
  target_path: "/var/www/html/"
  ssh_key_path: "~/.ssh/deploy_key"
  build_command: "npm run build"  # Optional
```

**Use case**: Documentation sites, marketing pages, static web apps

### 9.3 Docker-Local Backend

**Purpose**: Build and run containers locally for development testing.

**Implementation**:
- `build()`: Builds Docker image using detected Dockerfile
- `deploy()`: Stops existing container, starts new one with configured ports
- `healthCheck()`: Checks container status and port connectivity
- `rollback()`: Stops current container, restarts previous image

**Configuration**:
```yaml
docker-local:
  dockerfile_path: "./Dockerfile"  # Default: auto-detect
  ports: ["3000:3000"]
  environment_vars:
    NODE_ENV: "development"
  registry: "localhost:5000"  # Optional local registry
```

**Use case**: Local development and testing of containerized applications

### 9.4 GitHub Pages Backend

**Purpose**: Deploy documentation and static sites to GitHub Pages.

**Implementation**:
- `build()`: Runs static site generator if configured
- `deploy()`: Pushes to `gh-pages` branch using GitHub API
- `healthCheck()`: Verifies content is accessible via github.io URL
- `rollback()`: Reverts `gh-pages` branch to previous commit

**Configuration**:
```yaml
github-pages:
  repository: "owner/repo"  # Auto-detected from git remote
  branch: "gh-pages"  # Default
  custom_domain: "docs.example.com"  # Optional
  build_command: "npm run docs"  # Optional
```

**Use case**: Project documentation, API docs, project websites

---

## 10. Cloud Backend Extension Model (Phase 2)

### 10.1 Plugin Architecture

Cloud backends are distributed as separate plugins that register with the core framework:

```
plugins/autonomous-dev-deploy-gcp/
├── package.json
├── src/
│   ├── gcp_backend.ts
│   ├── cloud_run_deployer.ts
│   ├── cloud_build_artifact.ts
│   └── index.ts
└── .claude-plugin/
    └── plugin.json
```

### 10.2 Registration Pattern

```typescript
// In autonomous-dev-deploy-gcp/src/index.ts
import { DeploymentBackendRegistry } from 'autonomous-dev';
import { GCPBackend } from './gcp_backend';

export function activate(context: PluginContext) {
  const backend = new GCPBackend();
  DeploymentBackendRegistry.register(backend);
}
```

### 10.3 Backend Plugin Manifest

```json
{
  "name": "autonomous-dev-deploy-gcp",
  "version": "1.0.0",
  "description": "Google Cloud Platform deployment backend",
  "main": "dist/index.js",
  "dependencies": {
    "autonomous-dev": "^1.0.0",
    "@google-cloud/run": "^3.0.0",
    "@google-cloud/build": "^4.0.0"
  },
  "claude-plugin": {
    "activation": "auto",
    "capabilities": ["deployment-backend"],
    "extensionPoints": {
      "deployment-backends": ["gcp"]
    }
  }
}
```

### 10.4 Cloud Backend Specifications

#### GCP Backend
- **Build**: Uses Cloud Build to create container images
- **Deploy**: Deploys to Cloud Run services
- **Health**: Checks service readiness and endpoint health
- **Rollback**: Reverts to previous Cloud Run revision
- **Cost tracking**: Integrates with Cloud Billing API

#### AWS Backend
- **Build**: Uses CodeBuild or local Docker build + ECR push
- **Deploy**: Deploys to ECS Fargate services
- **Health**: Checks ECS task health and ALB target health
- **Rollback**: Updates ECS service to previous task definition
- **Cost tracking**: Estimated based on instance types and runtime

#### Azure Backend
- **Build**: Uses Azure Container Registry build tasks
- **Deploy**: Deploys to Azure Container Apps
- **Health**: Checks app replica status and endpoint health
- **Rollback**: Reverts to previous container app revision
- **Cost tracking**: Integrates with Azure Cost Management API

#### Kubernetes Backend
- **Build**: Builds images locally or via cluster-based builds
- **Deploy**: Applies Kubernetes manifests via kubectl
- **Health**: Checks pod readiness and service endpoint health
- **Rollback**: Rolls back deployments using kubectl rollout
- **Cost tracking**: Node-hour estimates based on resource requests

---

## 11. Configuration Schema

### 11.1 Repository Deployment Configuration

File: `.autonomous-dev/deploy.yaml`

```yaml
# Global deployment settings
metadata:
  schema_version: "1.0"
  default_environment: "dev"

# Environment definitions
environments:
  dev:
    backend: "docker-local"
    auto_deploy: true
    cost_cap_usd: 10
    settings:
      docker-local:
        ports: ["3000:3000"]
        environment_vars:
          NODE_ENV: "development"
    timeouts:
      build: 300  # 5 minutes
      deploy: 120
      health_check: 60

  staging:
    backend: "k8s"
    auto_deploy: false  # Requires approval
    cost_cap_usd: 100
    inherits: "dev"  # Inherits settings from dev, overrides below
    settings:
      k8s:
        namespace: "staging"
        manifest_template: "./k8s/staging.yaml"
        kubeconfig: "~/.kube/config"

  prod:
    backend: "gcp"
    auto_deploy: false
    cost_cap_usd: 500
    approval_required: true  # Always requires approval regardless of trust
    settings:
      gcp:
        project: "my-company-prod"
        service_name: "my-service"
        region: "us-central1"
        memory: "1Gi"
        cpu: "1000m"
        min_instances: 1
        max_instances: 10

# Global build settings
build:
  timeout_seconds: 600
  artifact_retention_days: 30
  cache_enabled: true

# Cost governance
cost:
  daily_cap_usd: 200
  monthly_cap_usd: 5000
  escalate_threshold_usd: 100  # Escalate deploys over this amount

# Rollback settings
rollback:
  retention_hours: 24
  auto_rollback_on_health_failure: true
  health_check_retries: 3
  health_check_interval_seconds: 30
```

### 11.2 Environment Inheritance

```yaml
environments:
  # Base configuration
  dev:
    backend: "docker-local"
    cost_cap_usd: 10
    settings:
      docker-local:
        ports: ["3000:3000"]
        environment_vars:
          NODE_ENV: "development"
          DEBUG: "true"

  # Staging inherits from dev, overrides specific settings
  staging:
    inherits: "dev"
    backend: "k8s"  # Override backend
    cost_cap_usd: 100  # Override cost cap
    settings:
      k8s:
        namespace: "staging"
        # docker-local settings are inherited but ignored since backend changed

  # Production inherits from staging
  prod:
    inherits: "staging"
    backend: "gcp"  # Override backend again
    cost_cap_usd: 500
    settings:
      gcp:
        project: "prod-project"
        # k8s settings inherited but ignored
```

---

## 12. Trust & Approval Integration

### 12.1 Environment Trust Matrix

| Environment | L0 (Full Oversight) | L1 (Guided) | L2 (PRD-Only) | L3 (Autonomous) |
|-------------|---------------------|-------------|---------------|-----------------|
| dev         | Human               | Human       | System        | System          |
| staging     | Human               | Human       | Human         | System          |
| prod        | Human               | Human       | Human         | Human*          |

\* Production deployments can be configured to always require approval regardless of trust level via `approval_required: true`.

### 12.2 Cost-Based Escalation

```yaml
# In global configuration
cost_escalation:
  # Escalate deployments over these amounts regardless of trust level
  immediate_escalation_usd: 1000
  approval_required_usd: 500
  
  # Per-environment overrides
  environments:
    dev:
      approval_required_usd: 50
    staging:
      approval_required_usd: 200
    prod:
      approval_required_usd: 100  # Lower threshold for prod
```

### 12.3 Approval Gate Integration

Deployment approval gates integrate with PRD-007's escalation framework:

```typescript
interface DeploymentApprovalEscalation {
  type: "deployment_approval";
  environment: string;
  estimatedCost: number;
  deploymentPlan: {
    backend: string;
    artifacts: BuildArtifact[];
    targetEndpoints: string[];
  };
  options: [
    { id: "approve", label: "Approve deployment", risk: "medium" },
    { id: "modify", label: "Request changes", risk: "none" },
    { id: "cancel", label: "Cancel deployment", risk: "none" }
  ];
}
```

---

## 13. Assist Plugin Updates

### 13.1 New Skills

The autonomous-dev-assist plugin gains new capabilities for deployment operations:

| Skill Name | Description | Example Usage |
|------------|-------------|---------------|
| `deploy-framework-guide` | Explains the deployment backends framework and helps operators choose appropriate backends | "What deployment backend should I use for my Node.js app?" |
| `gcp-backend-setup` | Guides through GCP backend configuration and credential setup | "Help me deploy to Google Cloud Run" |
| `aws-backend-setup` | Guides through AWS backend configuration and ECS/ECR setup | "Configure AWS ECS deployment for my container" |
| `k8s-backend-setup` | Guides through Kubernetes backend configuration and manifest creation | "Deploy to my Kubernetes cluster" |
| `azure-backend-setup` | Guides through Azure backend configuration and Container Apps setup | "Set up Azure Container Apps deployment" |
| `deployment-troubleshooting` | Analyzes deployment failures and suggests fixes | "My GCP deployment failed with error X" |
| `cost-optimization` | Analyzes deployment costs and suggests optimizations | "How can I reduce my cloud deployment costs?" |
| `homelab-backend-cross-ref` | References homelab deployment options from sibling repository | "Deploy to my home Kubernetes cluster" |

### 13.2 Evaluation Suite Extension

New test case category: `deploy-guide` with ~18 test cases covering:

1. **Backend Selection** (4 cases)
   - Local development setup
   - Static site deployment
   - Container-based application
   - Serverless function deployment

2. **Cloud Configuration** (6 cases)
   - GCP Cloud Run setup
   - AWS ECS Fargate setup
   - Azure Container Apps setup
   - Multi-cloud deployment strategy
   - Cost optimization guidance
   - Credential configuration

3. **Environment Management** (4 cases)
   - Dev/staging/prod environment setup
   - Environment inheritance configuration
   - Approval gate configuration
   - Multi-environment deployment flow

4. **Troubleshooting** (4 cases)
   - Deployment failure analysis
   - Rollback guidance
   - Health check debugging
   - Cost escalation resolution

### 13.3 Wizard Phase Enhancement

The setup wizard gains deployment configuration capabilities:

```
autonomous-dev setup wizard

...existing steps...

[Step 6: Deployment Configuration]
How will you deploy applications built by autonomous-dev?

1) Local development only (git commits + PRs)
2) Static sites (documentation, marketing pages)
3) Containerized applications (Docker)
4) Cloud services (GCP, AWS, Azure)
5) Kubernetes clusters
6) Custom setup

> 3

[Containerized Applications Setup]
Where should containers be deployed?

1) Local Docker daemon (development)
2) Cloud container services (GCP Cloud Run, AWS Fargate, etc.)
3) Kubernetes cluster
4) Multiple environments (local dev + cloud staging/prod)

> 4

[Multi-Environment Setup]
I'll help you configure multiple deployment environments.

Development Environment:
- Backend: docker-local (containers run locally)
- Auto-deploy: Yes
- Cost cap: $10/day

Staging Environment:
- Backend: [gcp/aws/azure/k8s] (choose)
- Auto-deploy: Requires approval
- Cost cap: $100/day

Production Environment:
- Backend: [gcp/aws/azure/k8s] (choose)
- Auto-deploy: Always requires approval
- Cost cap: $500/day

Would you like to configure cloud credentials now? [y/n]
```

---

## 14. Testing Strategy

### 14.1 Backend Conformance Test Suite

Every backend implementation must pass a standardized conformance test suite:

```typescript
describe('Backend Conformance Tests', () => {
  let backend: DeploymentBackend;
  
  beforeEach(() => {
    backend = createBackendUnderTest();
  });

  describe('Interface Compliance', () => {
    it('implements required methods', () => {
      expect(backend.build).toBeDefined();
      expect(backend.deploy).toBeDefined();
      expect(backend.healthCheck).toBeDefined();
      expect(backend.rollback).toBeDefined();
    });

    it('has valid capabilities declaration', () => {
      expect(backend.capabilities).toBeDefined();
      expect(typeof backend.capabilities.supportsRollback).toBe('boolean');
    });
  });

  describe('Build Phase', () => {
    it('builds successfully with valid context', async () => {
      const artifact = await backend.build(validBuildContext);
      expect(artifact.artifactId).toBeTruthy();
      expect(artifact.contentHash).toBeTruthy();
    });

    it('handles build failures gracefully', async () => {
      await expect(backend.build(invalidBuildContext)).rejects.toThrow();
    });
  });

  describe('Deploy Phase', () => {
    it('deploys successfully with valid artifact', async () => {
      const deployment = await backend.deploy(validArtifact, testEnvironment);
      expect(deployment.deploymentId).toBeTruthy();
      expect(deployment.status).toBe('deploying');
    });
  });

  describe('Health Check Phase', () => {
    it('reports health status', async () => {
      const status = await backend.healthCheck(testDeployment);
      expect(typeof status.healthy).toBe('boolean');
    });
  });

  describe('Rollback Phase', () => {
    it('rolls back successfully when supported', async () => {
      if (backend.capabilities.supportsRollback) {
        const result = await backend.rollback(testDeployment);
        expect(typeof result.success).toBe('boolean');
      }
    });
  });
});
```

### 14.2 Integration Testing

**Happy Path Tests** (per backend):
1. **Simple Deployment**: Build → Deploy → Health Check → Success
2. **Rollback Flow**: Deploy → Health Fail → Auto Rollback → Success
3. **Multi-Environment**: Deploy dev → staging → prod with approval gates
4. **Cost Integration**: Track costs, hit cost cap, escalate appropriately

**Failure Injection Tests**:
1. **Build Failures**: Invalid Dockerfile, missing dependencies, timeout
2. **Deploy Failures**: Invalid credentials, resource limits, network issues
3. **Health Check Failures**: Service won't start, endpoint unreachable
4. **Rollback Failures**: Previous version unavailable, rollback timeout

**Resource Management Tests**:
1. **Cleanup**: Verify orphaned resources are cleaned up after failures
2. **Cost Tracking**: Verify costs are reported and accumulated correctly
3. **Timeout Handling**: Verify operations respect configured timeouts

### 14.3 Mock Backend for Testing

```typescript
class MockBackend implements DeploymentBackend {
  name = 'mock';
  capabilities = {
    supportsRollback: true,
    supportsMonitoring: false,
    supportsMultipleEnvironments: true,
    requiresCredentials: false,
    supportedProjectTypes: ['javascript', 'python']
  };
  costModel = 'free' as const;

  async build(context: BuildContext): Promise<BuildArtifact> {
    return {
      artifactId: `mock-artifact-${context.requestId}`,
      contentHash: 'mock-hash-123',
      createdAt: new Date().toISOString(),
      buildDurationMs: 1000,
      artifactSizeBytes: 1024,
      artifactPath: '/tmp/mock-artifact',
      metadata: { mock: true }
    };
  }

  async deploy(artifact: BuildArtifact, env: TargetEnvironment): Promise<DeploymentRecord> {
    return {
      deploymentId: `mock-deploy-${Date.now()}`,
      requestId: artifact.artifactId.split('-')[2],
      environment: env.name,
      artifactId: artifact.artifactId,
      deployedAt: new Date().toISOString(),
      deployedEndpoint: 'http://mock.local:3000',
      rollbackData: { previousVersion: 'mock-v1' },
      status: 'healthy'
    };
  }

  async healthCheck(deployment: DeploymentRecord): Promise<HealthStatus> {
    return {
      healthy: true,
      checkType: 'mock',
      responseTime: 50
    };
  }

  async rollback(deployment: DeploymentRecord): Promise<RollbackResult> {
    return {
      success: true,
      rolledBackTo: 'mock-deploy-previous',
      rollbackDurationMs: 2000
    };
  }
}
```

---

## 15. Migration & Rollout

### 15.1 Phase 1: Bundled Backends (Weeks 1-4)

**Deliverables**:
- Core deployment framework with TypeScript interfaces
- Four bundled backends: local, static, docker-local, github-pages  
- Configuration loader and environment management
- Trust integration with approval gates
- Basic cost tracking and audit logging
- Conformance test suite and documentation

**Migration Strategy**:
- All existing repos automatically use `local` backend (zero behavior change)
- Operators can opt-in to new backends via `.autonomous-dev/deploy.yaml`
- CLI commands added: `autonomous-dev deploy backends`, `autonomous-dev deploy rollback`
- Web portal (PRD-009) updated to show deployment status and logs

**Exit Criteria**:
- 100% backward compatibility maintained
- At least one operator successfully deploys using `docker-local` backend
- Static site deployment works end-to-end with `github-pages` backend
- Rollback functionality verified in staging environment

### 15.2 Phase 2: Cloud Backend Plugins (Weeks 5-8)

**Deliverables**:
- Plugin architecture for external backends
- Three cloud backend plugins: `autonomous-dev-deploy-gcp`, `autonomous-dev-deploy-aws`, `autonomous-dev-deploy-azure`
- Kubernetes backend plugin: `autonomous-dev-deploy-k8s`
- Enhanced cost tracking with cloud billing integration
- Advanced health checking and monitoring capabilities
- Multi-environment deployment workflows

**Migration Strategy**:
- Cloud backends distributed as separate plugins via npm
- Installation guides and setup wizards for each cloud provider
- Credential setup documentation and validation tools
- Reference implementation guides for custom backends

**Exit Criteria**:
- At least two cloud backends successfully deployed to production
- Multi-environment workflow (dev → staging → prod) validated
- Cost tracking integration working with real cloud bills
- Custom backend authored by external contributor

### 15.3 Phase 3: Advanced Features (Weeks 9-12)

**Deliverables**:
- Homelab backend integration (cross-reference to separate homelab repo)
- Advanced monitoring and observability features
- Cost optimization recommendations
- Template-based deployment configurations
- Integration with external CI/CD systems

**Migration Strategy**:
- Optional feature rollout based on operator demand
- Homelab backends reference implementation in separate repository
- Advanced features gated behind feature flags
- Documentation and training materials for complex deployments

**Exit Criteria**:
- Full feature set deployed and validated
- Performance metrics meet all NFR targets
- Documentation complete and tested by external teams
- Framework ready for open-source publication

---

## 16. Security

### 16.1 Credential Isolation

| Security Control | Implementation | Verification |
|------------------|---------------|--------------|
| **No credential storage** | Backends access credentials through platform APIs only (`aws configure`, `gcloud auth`, `kubectl config`) | Static analysis scans for credential patterns in logs and config files |
| **Credential validation** | Test credentials during config validation, not during deployment | Audit logs show validation attempts without credential values |
| **Environment isolation** | Different credentials per environment (dev/staging/prod) | Config validation enforces separate credential sources |
| **Rotation support** | Backends detect credential changes and refresh tokens | Automated testing with expired credentials |

### 16.2 Access Control

```yaml
# Per-environment access control
environments:
  dev:
    backend: "docker-local"
    # No special access controls - local only
    
  staging:
    backend: "gcp"
    access_control:
      required_approvers: ["staging-team"]
      max_auto_deploy_cost: 100
      
  prod:
    backend: "gcp"
    access_control:
      required_approvers: ["prod-admin", "security-team"]
      approval_required: true  # Always, regardless of trust level
      max_deployment_size: "5GB"
      security_scan_required: true
```

### 16.3 Deployment Audit

| Audit Requirement | Implementation | Retention |
|-------------------|----------------|-----------|
| **Who deployed** | Operator identity in deployment records | 2 years |
| **What was deployed** | Git SHA, artifact hash, environment config | 2 years |
| **When deployed** | ISO 8601 timestamps for all phases | 2 years |
| **Cost impact** | Real-time cost tracking and projections | 7 years (tax) |
| **Approval chain** | Link to escalation records for manual approvals | 2 years |
| **Rollback history** | Complete rollback audit trail | 1 year |

### 16.4 Network Security

**Outbound Connections**:
- Cloud backends: Only to official provider APIs (*.googleapis.com, *.amazonaws.com, etc.)
- Container registries: Operator-configured registries only
- Health checks: Target deployed applications only

**Inbound Connections**:
- Health check endpoints: Limited to deployment verification
- Monitoring endpoints: Optional, operator-configured only

**Secrets in Transit**:
- All API communication over HTTPS/TLS
- Container registry authentication via standard token mechanisms
- No secrets transmitted in URL parameters or headers

---

## 17. Risks & Mitigations

| ID | Risk | Likelihood | Impact | Mitigation |
|----|------|------------|--------|------------|
| R1 | **Credential leakage in logs or state files** | Medium | High | Static analysis scans, log sanitization, credential-free storage design. All credential access through secure platform APIs only. |
| R2 | **Cloud cost runaway from failed cleanup** | Medium | High | Per-deployment cost caps, resource tagging for cleanup, timeout-based resource deletion, cost monitoring alerts. |
| R3 | **Deployment corruption or data loss** | Low | Critical | Pre-deployment snapshots, atomic deployment operations, mandatory rollback testing, health check validation. |
| R4 | **Backend plugin security vulnerabilities** | Medium | Medium | Plugin sandboxing, security review for cloud backends, principle of least privilege for plugin APIs. |
| R5 | **Cross-environment deployment accidents** | Low | High | Environment isolation validation, explicit approval gates for prod, staging area requirements. |
| R6 | **Health check false positives/negatives** | High | Medium | Multi-layer health checks, configurable retry logic, manual health check override capability. |
| R7 | **Rollback failures leaving service down** | Medium | High | Rollback pre-validation, multiple rollback strategies per backend, emergency manual recovery procedures. |
| R8 | **Configuration drift between environments** | Medium | Medium | Configuration inheritance validation, environment comparison tools, deployment diff previews. |
| R9 | **Backend plugin incompatibility** | Medium | Low | Conformance test suite enforcement, API versioning, backward compatibility requirements. |
| R10 | **Scalability limits with multiple environments** | Low | Medium | Parallel deployment support, resource pooling, backend-specific optimization patterns. |

---

## 18. Open Questions

| ID | Question | Impact | Owner | Status |
|----|----------|--------|-------|--------|
| OQ-1 | Should the framework support blue-green deployments or canary releases, or should these be handled by the target environment (e.g., Kubernetes rolling updates, cloud provider features)? | Determines framework complexity vs. relying on platform capabilities | Platform team | Open |
| OQ-2 | How should the system handle deployments that require database migrations? Should this be a backend responsibility or a separate migration framework? | Affects backend interface design and migration safety | Database team | Open |
| OQ-3 | What is the right balance between framework-provided health checks and backend-specific health checking logic? Should there be standardized health check patterns? | Impacts health check reliability and backend implementation complexity | Backend authors | Open |
| OQ-4 | Should cost tracking include amortized infrastructure costs (e.g., cluster overhead) or only direct deployment costs? How should shared resource costs be allocated? | Affects cost accuracy and governance thresholds | Finance team | Open |
| OQ-5 | How should the framework handle multi-region deployments? Should this be multiple environments or a single environment with region configuration? | Determines configuration complexity and deployment orchestration | Infrastructure team | Open |
| OQ-6 | What is the appropriate timeout for cloud deployments? Should timeouts be backend-specific, environment-specific, or globally configured? | Affects deployment reliability and operator experience | Platform team | Open |
| OQ-7 | Should the framework provide built-in secret management (e.g., inject environment variables from external secret stores) or rely entirely on platform capabilities? | Determines framework scope and security model | Security team | Open |
| OQ-8 | How should the system handle deployments that require external dependencies (databases, message queues) that aren't part of the deployment itself? | Affects deployment validation and health checking | Architecture team | Open |
| OQ-9 | Should rollback be time-based (last 24 hours) or version-based (last N successful deployments)? What's the right default retention policy? | Affects storage requirements and recovery capabilities | Operations team | Open |
| OQ-10 | How should the framework integrate with external CI/CD systems that operators might want to use alongside autonomous deployment (e.g., for compliance scanning, approval workflows)? | Determines integration patterns and workflow complexity | DevOps team | Open |

---

## 19. References

| Document | Relationship | Key Integration Points |
|----------|--------------|----------------------|
| **[PRD-001: System Core & Daemon Engine](/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/prd/PRD-001-system-core.md)** | Foundation | Pipeline state machine (deploy phase), cost governance integration, daemon lifecycle management |
| **[PRD-004: Parallel Execution Engine](/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/prd/PRD-004-parallel-execution.md)** | Upstream dependency | Integration phase produces final commit SHA that deploy phase consumes as build input |
| **[PRD-007: Escalation & Trust Framework](/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/prd/PRD-007-escalation-trust.md)** | Cross-cutting concern | Trust level gates for environment-specific approval, escalation integration for deployment failures |
| **[PRD-008: Unified Request Submission Packaging](/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/prd/PRD-008-unified-request-submission.md)** | Adjacent | Request metadata and audit trail integration, cost tracking consistency |
| **[PRD-009: Web Control Plane (autonomous-dev-portal)](/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/prd/PRD-009-web-control-plane.md)** | Consumer | Portal displays deployment status, logs, and cost information; provides deployment approval interface |
| **[PRD-010: GitHub Actions CI/CD Pipeline](/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/prd/PRD-010-github-actions-pipeline.md)** | Upstream dependency | CI validation must complete successfully before deploy phase begins; security scanning integration |
| **PRD-011: Pipeline Variants & Extension Hooks** (referenced) | Framework pattern | Extension hooks model used for backend plugin registration and lifecycle management |
| **PRD-013: Code Quality Standards** (referenced) | Build input | Standards compliance validation feeds into build context for deployment |
| **Homelab Plugin Repository** (separate repo) | Sibling integration | Forward reference to homelab-specific backends (homelab-k3s, homelab-vm, homelab-bare-metal) |

---

*End of PRD-014: Deployment Backends Framework*

---

## 20. Review-Driven Design Updates (Post-Review Revision)

### 20.1 Backend Credential Proxy (SEC-004 CRITICAL)

**Issue**: Backend plugins gain access to AWS/GCP credentials via standard platform APIs and could exfiltrate to external servers.

**Resolution**: All cloud-credential access SHALL go through a **CredentialProxy** service:
1. The proxy holds the platform credentials (loaded from operator-managed sources: `~/.aws/credentials`, `gcloud auth`, kubeconfig).
2. Backend plugins request **operation-scoped credentials**: e.g., `proxy.acquire('aws', 'ECS:RegisterTaskDefinition', { cluster: 'prod' })`. The proxy returns a **scoped, short-lived (15-minute)** STS-AssumeRole / Cloud-IAM-token / kubeconfig-context credential limited to the requested operation and target.
3. Backend plugins receive credentials via stdin or a unix socket — never as env vars or files (which can be captured by sibling processes).
4. The proxy logs every credential issuance with: backend plugin name + version, operation requested, target environment, scope, time-to-live, audit hash of the request.
5. Network egress from backend processes is restricted: backends run with a per-process firewall allowing only the cloud provider's API endpoints (e.g., `*.amazonaws.com`, `*.googleapis.com`) and the local daemon socket. No arbitrary outbound HTTP.

This makes credential exfiltration require defeating both the proxy scope and the egress filter — a much higher bar.

### 20.2 Build Parameter Sanitization (SEC-005 HIGH)

**Issue**: BuildContext carries deployment config that may contain shell metacharacters; backends could pass these unsanitized to shell commands.

**Resolution**: 
1. The `BuildContext` interface (§5.2) gains a `parameters: ValidatedParameters` field where every value passes through a server-side validator before reaching the backend.
2. Backend plugins SHALL NOT use shell strings; they MUST use `execFile` with explicit argv arrays. The conformance test suite (§14) includes a "shell-injection in parameters" attack case that every backend must pass.
3. Configuration values that must be passed to shell tools (e.g., GCP project IDs to `gcloud`) are validated against strict allowlist regexes (`^[a-z][a-z0-9-]{4,28}[a-z0-9]$` for GCP project ID, etc.) before forwarding.

### 20.3 Rollback Record Integrity (SEC-006 MEDIUM)

**Issue**: DeploymentRecord stored on disk could be tampered with to make rollback execute attacker-controlled commands.

**Resolution**: Every DeploymentRecord is signed with HMAC-SHA256 using the same key infrastructure as PRD-009 §22.3 audit log integrity. The rollback command verifies the signature before execution; mismatch fails the rollback with an explicit security warning to the operator.

### 20.4 Wizard Phase 6 Collision Resolved

**Issue**: §13.3 inserted itself as "Step 6" but Phase 6 in the canonical sequence is "Daemon install + start."

**Resolution**: PRD-014 contributes **Phase 16** (Deployment Backend Configuration) in the unified phase registry. The §13.3 mock terminal output remains valid; only the phase number changes.

### 20.5 Cloud Skill Consolidation

**Issue**: §13.1 proposed four separate skills (`gcp-backend-setup`, `aws-backend-setup`, `azure-backend-setup`, `k8s-backend-setup`) that duplicate workflow.

**Resolution**: Replace with a single parameterized **`cloud-backend-setup`** skill that takes a backend type as input and walks through the corresponding configuration flow. The skill internally branches on backend type, sharing common steps (credential file location, env validation, dry-run deploy) and presenting backend-specific steps where needed. Skill count drops from 4 to 1; assist eval suite re-targets accordingly.

### 20.6 NG-02 Tightening

**Issue**: NG-02 said "not infrastructure-as-code authoring" but `docker-local` and `static` backends mutate infrastructure.

**Resolution**: NG-02 reworded: "Not building or maintaining a full infrastructure-as-code authoring system (e.g., Terraform, Pulumi). Backends SHALL execute discrete, idempotent infrastructure operations the operator has pre-defined; backends SHALL NOT compose multi-resource topologies dynamically."

---
