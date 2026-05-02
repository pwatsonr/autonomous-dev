/**
 * Deployment backend interface and supporting types (SPEC-023-1-01).
 *
 * Cross-reference: TDD-023 §5 (DeploymentBackend), §7 (BuildContext +
 * supporting types), §8 (HMAC-signed DeploymentRecord).
 *
 * Strict TypeScript, no `any`. Every backend bundled in PLAN-023-1
 * (`local`, `static`, `docker-local`, `github-pages`) and every future
 * cloud backend (TDD-024) implements `DeploymentBackend` from this module.
 *
 * `BackendCapability` is a string-literal union rather than a free-form
 * string so adding a capability is a compiler-enforced change.
 *
 * @module intake/deploy/types
 */

/**
 * Capabilities a backend can declare. Adding a new capability requires
 * widening this union and updating every backend's metadata.
 */
export type BackendCapability =
  | 'github-pr'
  | 'local-fs'
  | 'remote-rsync'
  | 'localhost-docker'
  | 'github-pages'
  | 'gcp-cloud-run'
  | 'aws-ecs-fargate'
  | 'azure-container-apps'
  | 'k8s-kubectl-apply';

/** Static metadata describing a backend at registration time. */
export interface BackendMetadata {
  /** Canonical id, lowercase-kebab. */
  name: string;
  /** Semver version string. */
  version: string;
  /** Targets the backend can deploy to. */
  supportedTargets: BackendCapability[];
  /** Capabilities the backend exposes; usually a superset of supportedTargets. */
  capabilities: BackendCapability[];
  /** External tools that must be on PATH at runtime (e.g., 'gh', 'git', 'docker'). */
  requiredTools: string[];
}

/**
 * Output of `DeploymentBackend.build()`. Persisted at
 * `<request>/.autonomous-dev/builds/<artifactId>/manifest.json` with a
 * sibling SHA-256 checksum (see `artifact-store.ts`).
 */
export interface BuildArtifact {
  /** ULID identifier for the artifact. */
  artifactId: string;
  /** Discriminator describing what `location` points at. */
  type: 'commit' | 'directory' | 'docker-image' | 'archive';
  /** Path / image ref / git ref interpreted by the backend that built it. */
  location: string;
  /** Lowercase-hex SHA-256 of the artifact's deterministic representation. */
  checksum: string;
  /** Total artifact size in bytes (for directories: sum of file sizes). */
  sizeBytes: number;
  /** Backend-specific metadata (e.g., docker `image_id`). */
  metadata: Record<string, string | number | boolean>;
}

/**
 * Validated, typed parameter map handed to a backend's `deploy()` method.
 * Always the OUTPUT of `validateParameters`, never raw operator input.
 */
export interface DeployParameters {
  [key: string]: string | number | boolean;
}

/**
 * Pure context handed to `DeploymentBackend.build()`. The build is a pure
 * function of context — no side effects on the repo allowed.
 */
export interface BuildContext {
  /** Absolute path to the request worktree. */
  repoPath: string;
  /** Commit SHA the build represents. */
  commitSha: string;
  /** Branch name the build was triggered from. */
  branch: string;
  /** Request id from the orchestrator (used to namespace artifacts). */
  requestId: string;
  /** True iff the worktree was clean when the context was created. */
  cleanWorktree: boolean;
  /** Already-validated parameters (output of `validateParameters`). */
  params: DeployParameters;
}

/**
 * Output of `DeploymentBackend.deploy()`. Persisted with an HMAC-SHA256
 * signature so rollback can verify integrity (see `record-signer.ts`).
 */
export interface DeploymentRecord {
  /** ULID identifier for the deploy event. */
  deployId: string;
  /** Backend `metadata.name` that produced this record. */
  backend: string;
  /** Logical environment (e.g., 'staging', 'integration-test'). */
  environment: string;
  /** Reference to the `BuildArtifact` that was deployed. */
  artifactId: string;
  /** ISO-8601 timestamp the deploy completed at. */
  deployedAt: string;
  /** Lifecycle status. */
  status: 'deployed' | 'failed' | 'rolled-back';
  /** Backend-specific details (e.g., `pr_url`, `container_id`). */
  details: Record<string, string | number | boolean>;
  /**
   * Lowercase-hex HMAC-SHA256 over the canonical JSON of every other
   * field. EMPTY string before `signDeploymentRecord` is invoked.
   */
  hmac: string;
}

/** Output of `DeploymentBackend.healthCheck()`. */
export interface HealthStatus {
  /** Aggregate health: true iff every check in `checks` passed. */
  healthy: boolean;
  /** Per-check breakdown so operators can pinpoint failures. */
  checks: { name: string; passed: boolean; message?: string }[];
  /** Short human-readable reason when `healthy` is false. */
  unhealthyReason?: string;
}

/** Output of `DeploymentBackend.rollback()`. */
export interface RollbackResult {
  /** True iff rollback completed without errors. */
  success: boolean;
  /** Artifact id of the previous deploy that was restored, if any. */
  restoredArtifactId?: string;
  /** Non-fatal warnings AND fatal errors. Empty when `success: true`. */
  errors: string[];
}

/**
 * The contract every backend implements. ALL methods are required.
 * `build` is pure (no repo side effects); `deploy` mutates remote state;
 * `healthCheck` is idempotent and read-only; `rollback` is idempotent
 * and best-effort.
 */
export interface DeploymentBackend {
  readonly metadata: BackendMetadata;
  build(ctx: BuildContext): Promise<BuildArtifact>;
  deploy(
    artifact: BuildArtifact,
    environment: string,
    params: DeployParameters,
  ): Promise<DeploymentRecord>;
  healthCheck(record: DeploymentRecord): Promise<HealthStatus>;
  rollback(record: DeploymentRecord): Promise<RollbackResult>;
}
