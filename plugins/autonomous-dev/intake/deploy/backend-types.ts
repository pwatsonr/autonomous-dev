/**
 * Open deploy-backend contract for the target-aware pipeline runner (issue #662).
 *
 * ## Why a new contract alongside `types.ts`?
 *
 * `types.ts` defines the *existing* `DeploymentBackend` that backs the legacy
 * orchestrator (build/deploy/healthCheck/rollback called individually against
 * a named backend from `BackendRegistry`).  This module defines the *pipeline*
 * backend contract: backends register themselves under the target attributes
 * they support (kind, provider string, capability tokens) — not under a
 * hard-coded name — so the `PipelineRunner` can dispatch to the right backend
 * purely from a `DeployTarget` without any coupling to a fixed list.
 *
 * ## Open registry (invariant #674)
 *
 * New backends — cloud providers, homelab nodes — call
 * `PipelineBackendRegistry.register(backend)` from their activation hook.
 * Core never contains a closed list. The runner dispatches by calling
 * `backend.supports(target)` on each registered backend in registration order;
 * the first match wins.
 *
 * ## Stage context
 *
 * Each stage in the pipeline receives a `PipelineContext` carrying the
 * resolved target, service name, and artifact spec. Backends may extend the
 * context via the open `meta` record.
 *
 * Cross-reference: issues #662, #674.
 *
 * @module intake/deploy/backend-types
 */

import type { DeployTarget } from './target-types';

// ---------------------------------------------------------------------------
// Stage context
// ---------------------------------------------------------------------------

/**
 * Specification of the artifact to build/push/deploy.
 *
 * Kept minimal and open: backends that need additional fields should add
 * them to `meta`. The required fields are the common denominator across
 * every backend kind.
 */
export interface ArtifactSpec {
  /**
   * The service / image name to build.
   * Examples: `'my-api'`, `'homelab/automation'`.
   */
  name: string;

  /**
   * Optional source directory (absolute path).  Defaults to cwd when absent.
   */
  sourceDir?: string;

  /**
   * Optional tag / version label.  Backends choose a sensible default when
   * absent (e.g., a timestamp or commit sha).
   */
  tag?: string;

  /**
   * Open metadata for backend-specific fields (e.g., Dockerfile path,
   * registry URL, chart path).
   */
  meta: Record<string, unknown>;
}

/**
 * Mutable context passed through every stage of the pipeline.
 *
 * The runner creates one `PipelineContext` per run and passes it to each
 * stage.  Backends may write to `meta` to propagate intermediate results
 * (e.g., a built image tag produced in `build` that `push` and `deploy`
 * then read).
 */
export interface PipelineContext {
  /** Unique run identifier (ULID). */
  runId: string;

  /** Service being deployed. */
  service: string;

  /** Fully-resolved deploy target. */
  target: DeployTarget;

  /** Artifact specification. */
  artifact: ArtifactSpec;

  /**
   * Open map for backends to share intermediate results between stages.
   * Keys are backend-defined; consumers read defensively.
   */
  meta: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Stage results
// ---------------------------------------------------------------------------

/**
 * Result returned by `PipelineBackend.deploy()`.
 *
 * `deployedId` is whatever identifier the target platform assigns to the
 * deployment (container id, release name, job id, …).
 */
export interface DeployResult {
  /** True iff the deploy command succeeded. */
  success: boolean;
  /** Platform-assigned identifier for the running deployment. */
  deployedId?: string;
  /** Human-readable outcome message. */
  message?: string;
  /** Additional backend-specific details. */
  details: Record<string, unknown>;
}

/**
 * Result returned by `PipelineBackend.verifyHealth()`.
 */
export interface HealthResult {
  /** True iff the deployment is healthy. */
  healthy: boolean;
  /** Short reason string when unhealthy. */
  reason?: string;
  /** Per-probe breakdown. */
  checks: { name: string; passed: boolean; message?: string }[];
}

/**
 * Result returned by `PipelineBackend.rollback()`.
 */
export interface RollbackResult {
  /** True iff rollback completed without errors. */
  success: boolean;
  /** Artifact / version that was restored, if any. */
  restoredVersion?: string;
  /** Non-empty when rollback encountered errors. */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Pipeline backend contract
// ---------------------------------------------------------------------------

/**
 * Contract for a deploy backend in the target-aware pipeline.
 *
 * ## Registration and dispatch
 *
 * Backends register via `PipelineBackendRegistry.register()`.  The runner
 * calls `backend.supports(target)` to find the right backend for a given
 * deploy target.  The first registered backend whose `supports()` returns
 * `true` is selected.  This means backends with narrower match criteria
 * should be registered before broader ones.
 *
 * ## Stage methods
 *
 * All four stage methods receive the full `PipelineContext` so they can
 * share state via `ctx.meta`.  All are optional except `deploy`; a backend
 * that omits `build`, `push`, or `verifyHealth` causes those stages to be
 * skipped with a `skipped` status.
 *
 * - `build`        — Build the artifact (e.g., `docker build`).
 * - `push`         — Push the artifact to a registry.  Skipped by the
 *                    runner when `target.capabilities` does NOT include
 *                    `'registry-push'` AND the backend does not declare
 *                    `requiresPush: true`.
 * - `deploy`       — Deploy the artifact to the target (required).
 * - `verifyHealth` — Check that the deployment is healthy post-deploy.
 * - `rollback`     — Roll back a failed deploy (called on health-verify
 *                    failure or deploy failure).
 */
export interface PipelineBackend {
  /**
   * Unique stable identifier for this backend implementation.
   * Example: `'homelab-subprocess'`, `'docker-local-pipeline'`.
   */
  readonly id: string;

  /**
   * Return `true` when this backend can handle deploys to `target`.
   *
   * Match on `target.kind`, `target.provider`, `target.capabilities`, or
   * `target.tags` — NEVER on `target.id` (invariant #674).
   *
   * @param target - Candidate deploy target.
   */
  supports(target: DeployTarget): boolean;

  /**
   * Whether this backend requires a registry-push stage.
   *
   * When `true` the runner always executes the push stage regardless of
   * target capabilities.  Backends that push internally in `deploy()` should
   * return `false` here (or omit the method — defaults to `false`).
   */
  requiresPush?: boolean;

  /**
   * Build the artifact for `ctx.service`.
   *
   * When absent the runner marks the build stage as `skipped`.
   *
   * @param ctx - Pipeline context; may write intermediate results to `ctx.meta`.
   */
  build?(ctx: PipelineContext): Promise<void>;

  /**
   * Push the built artifact to a registry.
   *
   * When absent or when the stage is not required (see `requiresPush` and
   * target capability `'registry-push'`), the runner marks the stage as
   * `skipped`.
   *
   * @param ctx - Pipeline context.
   */
  push?(ctx: PipelineContext): Promise<void>;

  /**
   * Deploy the artifact to `ctx.target`.  Required — must be present.
   *
   * @param ctx - Pipeline context.
   * @returns `DeployResult` describing the outcome.
   */
  deploy(ctx: PipelineContext): Promise<DeployResult>;

  /**
   * Verify that the deployment is healthy.
   *
   * When absent the runner marks the health-verify stage as `skipped`.
   * A failed health-verify triggers auto-rollback.
   *
   * @param ctx - Pipeline context.
   * @returns `HealthResult`.
   */
  verifyHealth?(ctx: PipelineContext): Promise<HealthResult>;

  /**
   * Roll back a failed deployment.
   *
   * Called automatically by the runner when `deploy()` or `verifyHealth()`
   * fails.  When absent the runner records a `skipped` rollback stage.
   *
   * @param ctx          - Pipeline context.
   * @param deployResult - The failed deploy result (present when deploy
   *                       failed; absent when health-verify triggered
   *                       rollback).
   */
  rollback?(ctx: PipelineContext, deployResult?: DeployResult): Promise<RollbackResult>;
}

// ---------------------------------------------------------------------------
// Open pipeline backend registry
// ---------------------------------------------------------------------------

const pipelineBackends: PipelineBackend[] = [];

/**
 * Register a `PipelineBackend`.
 *
 * Backends are appended in registration order; dispatch tries them in that
 * order and picks the first whose `supports(target)` returns `true`.
 *
 * Re-registering a backend with the same `id` replaces the previous entry
 * (idempotent — safe to call from plugin `activate()` which may be re-run).
 *
 * @param backend - The backend implementation to register.
 */
export function registerPipelineBackend(backend: PipelineBackend): void {
  const idx = pipelineBackends.findIndex((b) => b.id === backend.id);
  if (idx >= 0) {
    pipelineBackends[idx] = backend;
  } else {
    pipelineBackends.push(backend);
  }
}

/**
 * Find the first registered backend that supports `target`.
 *
 * Dispatches by calling `backend.supports(target)` in registration order.
 * Returns `undefined` when no backend matches.
 *
 * @param target - The deploy target to find a backend for.
 * @returns The matching `PipelineBackend` or `undefined`.
 */
export function findPipelineBackend(target: DeployTarget): PipelineBackend | undefined {
  return pipelineBackends.find((b) => b.supports(target));
}

/**
 * Return all registered pipeline backends (in registration order).
 *
 * Primarily for introspection and tests.
 */
export function listPipelineBackends(): PipelineBackend[] {
  return [...pipelineBackends];
}

/**
 * TEST ONLY — clear all registered pipeline backends.
 *
 * Call in `afterEach` to isolate test registrations.
 */
export function resetPipelineBackendRegistry(): void {
  pipelineBackends.length = 0;
}
