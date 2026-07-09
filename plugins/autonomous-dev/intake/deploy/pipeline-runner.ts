/**
 * Target-aware staged deploy pipeline runner (issue #662).
 *
 * ## Stage graph
 *
 * ```
 * policy-check → build → push → deploy → health-verify → (on failure) rollback
 * ```
 *
 * - **policy-check**: `evaluatePolicy(request, ruleSet)` is called BEFORE any
 *   stage that mutates the target.  A `deny` decision or outstanding
 *   `requiredApprovals` halts the run immediately with `PipelineStatus.denied`.
 * - **build**: delegate to `backend.build(ctx)`.  Optional — if the backend
 *   omits `build`, the stage is marked `skipped`.
 * - **push**: delegate to `backend.push(ctx)`.  Conditional: executed only
 *   when `backend.requiresPush === true` OR the resolved target carries the
 *   `'registry-push'` capability.
 * - **deploy**: delegate to `backend.deploy(ctx)`.  Required.  A failure
 *   triggers auto-rollback.
 * - **health-verify**: delegate to `backend.verifyHealth(ctx)`.  Optional —
 *   a failed health check triggers auto-rollback.
 * - **rollback**: delegate to `backend.rollback(ctx)`.  Invoked automatically
 *   on deploy or health-verify failure.  Optional on the backend; when absent
 *   the stage is recorded as `skipped`.
 *
 * ## Backend dispatch
 *
 * The runner calls `findPipelineBackend(target)` to locate the backend for the
 * resolved target.  Dispatch is by target attributes (kind/provider/capability/
 * tags), never by hard-coded id (invariant #674).
 *
 * ## Stage events
 *
 * Each stage emits a `StageEvent` via the optional `onStageEvent` callback.
 * Consumers (CLI, portal) attach a listener to receive structured per-stage
 * status, timing, and log lines.
 *
 * ## Dry-run
 *
 * When `dryRun: true` the runner emits `planned` stage events for each stage
 * that WOULD execute and returns immediately with `PipelineStatus.dryRun`.
 * No backend method is called; no mutation occurs.
 *
 * Cross-reference: issues #662, #668, #669, #674.
 *
 * @module intake/deploy/pipeline-runner
 */

import { generateUlid } from './id';
import { evaluatePolicy } from './policy-engine';
import { findPipelineBackend } from './backend-types';
import type {
  PipelineBackend,
  PipelineContext,
  DeployResult,
  HealthResult,
  RollbackResult,
} from './backend-types';
import type { DeployTarget } from './target-types';
import type { PolicyDocument, PolicyDecision } from './policy-types';
import { EMPTY_POLICY } from './policy-types';

// ---------------------------------------------------------------------------
// Stage names + statuses
// ---------------------------------------------------------------------------

/**
 * Names of the pipeline stages in execution order.
 */
export type StageName =
  | 'policy-check'
  | 'build'
  | 'push'
  | 'deploy'
  | 'health-verify'
  | 'rollback';

/**
 * Per-stage lifecycle status.
 *
 * - `pending`  — Stage has not started yet.
 * - `running`  — Stage is in progress.
 * - `success`  — Stage completed successfully.
 * - `failed`   — Stage encountered an error.
 * - `skipped`  — Stage was intentionally not executed (backend omits it,
 *                push not required, etc.).
 * - `planned`  — Dry-run mode: the stage would execute but did not.
 */
export type StageStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'planned';

// ---------------------------------------------------------------------------
// Stage events
// ---------------------------------------------------------------------------

/**
 * Structured event emitted at the start and completion of each stage.
 *
 * Consumers (CLI, portal) receive these via the `onStageEvent` callback.
 */
export interface StageEvent {
  /** Run identifier (ULID). */
  runId: string;
  /** Stage name. */
  stage: StageName;
  /** Stage lifecycle status at the time of emission. */
  status: StageStatus;
  /** Wall-clock timestamp (ISO-8601). */
  ts: string;
  /** Elapsed time for this stage in milliseconds.  Present on completion. */
  durationMs?: number;
  /** Human-readable message for CLI / portal display. */
  message?: string;
  /** Open details for portal consumers. */
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Pipeline-level outcome
// ---------------------------------------------------------------------------

/**
 * Top-level status of a pipeline run.
 */
export type PipelineStatus =
  | 'success'
  | 'denied'
  | 'approval-required'
  | 'build-failed'
  | 'push-failed'
  | 'deploy-failed'
  | 'health-failed'
  | 'rollback-failed'
  | 'no-backend'
  | 'dry-run';

/**
 * Per-stage record in the final `PipelineRunResult`.
 */
export interface StageRecord {
  stage: StageName;
  status: StageStatus;
  durationMs: number;
  message?: string;
  details?: Record<string, unknown>;
}

/**
 * Final result of a `runPipeline()` invocation.
 */
export interface PipelineRunResult {
  /** Run identifier (ULID). */
  runId: string;
  /** Overall pipeline outcome. */
  status: PipelineStatus;
  /** Ordered per-stage records. */
  stages: StageRecord[];
  /** Policy decision (always present; `allowed: true` when no policy supplied). */
  policyDecision: PolicyDecision;
  /** The deploy outcome (present when the deploy stage ran). */
  deployResult?: DeployResult;
  /** The health-verify outcome (present when the stage ran). */
  healthResult?: HealthResult;
  /** The rollback outcome (present when rollback ran). */
  rollbackResult?: RollbackResult;
  /** ISO-8601 timestamp the run started. */
  startedAt: string;
  /** Total elapsed ms from start to finish. */
  totalDurationMs: number;
}

// ---------------------------------------------------------------------------
// Runner options
// ---------------------------------------------------------------------------

/**
 * Options for `runPipeline()`.
 */
export interface PipelineRunOptions {
  /**
   * The fully-resolved deploy target.
   * Resolution (resolveTarget()) is the caller's responsibility.
   */
  target: DeployTarget;

  /** Service name being deployed. */
  service: string;

  /**
   * Artifact specification passed to build/push/deploy.
   */
  artifact: {
    name: string;
    sourceDir?: string;
    tag?: string;
    meta?: Record<string, unknown>;
  };

  /**
   * Policy document to evaluate before running stages.
   * Defaults to `EMPTY_POLICY` (allow-all) when absent.
   */
  policy?: PolicyDocument;

  /**
   * Optional evaluation context injected into the policy engine.
   * Callers supply `now`, `currentCounts`, etc. for pure evaluation.
   */
  policyContext?: {
    now?: number;
    currentCounts?: Record<string, number>;
    affectedTargets?: number;
    colocatedServices?: string[];
    [key: string]: unknown;
  };

  /**
   * When `true`, no backend method is called; stage events are emitted
   * with status `'planned'` and the result has status `'dry-run'`.
   */
  dryRun?: boolean;

  /**
   * Optional callback receiving structured stage events.
   * Called at stage start (status `'running'`) and completion.
   */
  onStageEvent?: (event: StageEvent) => void;

  /**
   * TEST ONLY — override the backend lookup.  When supplied, `findPipelineBackend`
   * is NOT called; this backend is used directly.
   */
  _backendOverride?: PipelineBackend;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether the push stage should execute for a given target/backend.
 *
 * Push is required when:
 * - `backend.requiresPush === true`, OR
 * - `target.capabilities` includes `'registry-push'`.
 *
 * @param backend - The selected pipeline backend.
 * @param target  - The resolved deploy target.
 */
function pushRequired(backend: PipelineBackend, target: DeployTarget): boolean {
  if (backend.requiresPush === true) return true;
  return target.capabilities.includes('registry-push');
}

/**
 * Emit a stage event via the optional callback.
 *
 * @param onEvent  - Optional callback.
 * @param event    - The event to emit.
 */
function emit(
  onEvent: ((event: StageEvent) => void) | undefined,
  event: StageEvent,
): void {
  if (onEvent) {
    try {
      onEvent(event);
    } catch {
      // Event listeners must not break the pipeline.
    }
  }
}

// ---------------------------------------------------------------------------
// runPipeline
// ---------------------------------------------------------------------------

/**
 * Run the target-aware staged deploy pipeline.
 *
 * Stages execute in order: policy-check → build → push → deploy →
 * health-verify → (on failure) rollback.
 *
 * Policy is evaluated FIRST (before any mutation).  A `deny` or outstanding
 * `requiredApprovals` returns immediately with `PipelineStatus.denied` or
 * `PipelineStatus.approval-required`.
 *
 * A failing deploy or health-verify stage triggers auto-rollback via
 * `backend.rollback()`.  The runner does NOT re-throw backend errors; all
 * failures are captured in the returned `PipelineRunResult`.
 *
 * @param opts - Pipeline options.
 * @returns A `PipelineRunResult` describing the full run outcome.
 */
export async function runPipeline(opts: PipelineRunOptions): Promise<PipelineRunResult> {
  const runId = generateUlid();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const stages: StageRecord[] = [];

  const policy = opts.policy ?? EMPTY_POLICY;
  const dryRun = opts.dryRun === true;
  const onEvent = opts.onStageEvent;

  const ctx: PipelineContext = {
    runId,
    service: opts.service,
    target: opts.target,
    artifact: {
      name: opts.artifact.name,
      sourceDir: opts.artifact.sourceDir,
      tag: opts.artifact.tag,
      meta: opts.artifact.meta ?? {},
    },
    meta: {},
  };

  // ---------------------------------------------------------------------------
  // Helper: run one stage and record its outcome.
  // ---------------------------------------------------------------------------
  async function runStage(
    name: StageName,
    fn: () => Promise<{ status: StageStatus; message?: string; details?: Record<string, unknown> }>,
  ): Promise<StageRecord> {
    const stageT0 = Date.now();
    emit(onEvent, {
      runId,
      stage: name,
      status: 'running',
      ts: new Date().toISOString(),
    });
    const outcome = await fn();
    const durationMs = Date.now() - stageT0;
    const record: StageRecord = {
      stage: name,
      status: outcome.status,
      durationMs,
      message: outcome.message,
      details: outcome.details,
    };
    emit(onEvent, {
      runId,
      stage: name,
      status: outcome.status,
      ts: new Date().toISOString(),
      durationMs,
      message: outcome.message,
      details: outcome.details,
    });
    stages.push(record);
    return record;
  }

  // ---------------------------------------------------------------------------
  // 1. Policy check (always runs — even in dry-run, policy is evaluated).
  // ---------------------------------------------------------------------------
  const policyDecision = evaluatePolicy(
    { service: opts.service, target: opts.target, context: opts.policyContext },
    policy,
  );

  if (dryRun) {
    // In dry-run, just record which stages WOULD execute.
    const allStages: StageName[] = ['policy-check', 'build', 'push', 'deploy', 'health-verify'];
    for (const name of allStages) {
      const stageT0 = Date.now();
      const plannedRecord: StageRecord = {
        stage: name,
        status: 'planned',
        durationMs: Date.now() - stageT0,
        message: `[dry-run] stage would execute`,
      };
      stages.push(plannedRecord);
      emit(onEvent, {
        runId,
        stage: name,
        status: 'planned',
        ts: new Date().toISOString(),
        durationMs: 0,
        message: `[dry-run] stage would execute`,
      });
    }
    return {
      runId,
      status: 'dry-run',
      stages,
      policyDecision,
      startedAt,
      totalDurationMs: Date.now() - t0,
    };
  }

  // Policy-check stage record (real run).
  await runStage('policy-check', async () => {
    if (!policyDecision.allowed) {
      if (policyDecision.violations.length > 0) {
        const msgs = policyDecision.violations.map((v) => v.message).join('; ');
        return { status: 'failed', message: `Policy denied: ${msgs}` };
      }
      if (policyDecision.requiredApprovals.length > 0) {
        const groups = policyDecision.requiredApprovals.join(', ');
        return { status: 'failed', message: `Approval required from: ${groups}` };
      }
    }
    return { status: 'success', message: 'Policy check passed' };
  });

  // Check policy outcome AFTER recording the stage.
  if (!policyDecision.allowed) {
    const hasViolations = policyDecision.violations.length > 0;
    const pipelineStatus: PipelineStatus = hasViolations ? 'denied' : 'approval-required';
    return {
      runId,
      status: pipelineStatus,
      stages,
      policyDecision,
      startedAt,
      totalDurationMs: Date.now() - t0,
    };
  }

  // ---------------------------------------------------------------------------
  // 2. Find backend (dispatch by target attributes, never by id).
  // ---------------------------------------------------------------------------
  const backend = opts._backendOverride ?? findPipelineBackend(opts.target);
  if (!backend) {
    const record: StageRecord = {
      stage: 'deploy',
      status: 'failed',
      durationMs: 0,
      message: `No registered PipelineBackend supports target '${opts.target.id}' (kind='${opts.target.kind}', provider='${opts.target.provider}').`,
    };
    stages.push(record);
    emit(onEvent, {
      runId,
      stage: 'deploy',
      status: 'failed',
      ts: new Date().toISOString(),
      durationMs: 0,
      message: record.message,
    });
    return {
      runId,
      status: 'no-backend',
      stages,
      policyDecision,
      startedAt,
      totalDurationMs: Date.now() - t0,
    };
  }

  // ---------------------------------------------------------------------------
  // 3. Build stage.
  // ---------------------------------------------------------------------------
  let buildFailed = false;
  const buildRecord = await runStage('build', async () => {
    if (!backend.build) {
      return { status: 'skipped', message: 'Backend does not implement build()' };
    }
    try {
      await backend.build(ctx);
      return { status: 'success', message: 'Build completed' };
    } catch (err) {
      buildFailed = true;
      return { status: 'failed', message: (err as Error).message };
    }
  });

  if (buildFailed) {
    return {
      runId,
      status: 'build-failed',
      stages,
      policyDecision,
      startedAt,
      totalDurationMs: Date.now() - t0,
    };
  }
  void buildRecord; // explicitly consumed above

  // ---------------------------------------------------------------------------
  // 4. Push stage (conditional).
  // ---------------------------------------------------------------------------
  let pushFailed = false;
  await runStage('push', async () => {
    if (!pushRequired(backend, opts.target)) {
      return { status: 'skipped', message: 'Registry push not required for this target' };
    }
    if (!backend.push) {
      return {
        status: 'skipped',
        message: 'Push required but backend does not implement push()',
      };
    }
    try {
      await backend.push(ctx);
      return { status: 'success', message: 'Push completed' };
    } catch (err) {
      pushFailed = true;
      return { status: 'failed', message: (err as Error).message };
    }
  });

  if (pushFailed) {
    return {
      runId,
      status: 'push-failed',
      stages,
      policyDecision,
      startedAt,
      totalDurationMs: Date.now() - t0,
    };
  }

  // ---------------------------------------------------------------------------
  // 5. Deploy stage.
  // ---------------------------------------------------------------------------
  let deployResult: DeployResult | undefined;
  let deployFailed = false;

  await runStage('deploy', async () => {
    try {
      deployResult = await backend.deploy(ctx);
      if (!deployResult.success) {
        deployFailed = true;
        return {
          status: 'failed',
          message: deployResult.message ?? 'Deploy returned success=false',
          details: deployResult.details,
        };
      }
      return {
        status: 'success',
        message: deployResult.message ?? 'Deploy completed',
        details: deployResult.details,
      };
    } catch (err) {
      deployFailed = true;
      deployResult = {
        success: false,
        message: (err as Error).message,
        details: {},
      };
      return { status: 'failed', message: deployResult.message };
    }
  });

  if (deployFailed) {
    // Auto-rollback on deploy failure.
    let rollbackResult: RollbackResult | undefined;
    await runStage('rollback', async () => {
      if (!backend.rollback) {
        return { status: 'skipped', message: 'Backend does not implement rollback()' };
      }
      try {
        rollbackResult = await backend.rollback(ctx, deployResult);
        return {
          status: rollbackResult.success ? 'success' : 'failed',
          message: rollbackResult.success
            ? `Rolled back${rollbackResult.restoredVersion ? ` to ${rollbackResult.restoredVersion}` : ''}`
            : `Rollback failed: ${rollbackResult.errors.join(', ')}`,
          details: { errors: rollbackResult.errors },
        };
      } catch (err) {
        rollbackResult = { success: false, errors: [(err as Error).message] };
        return { status: 'failed', message: `Rollback threw: ${(err as Error).message}` };
      }
    });
    return {
      runId,
      status: 'deploy-failed',
      stages,
      policyDecision,
      deployResult,
      rollbackResult,
      startedAt,
      totalDurationMs: Date.now() - t0,
    };
  }

  // ---------------------------------------------------------------------------
  // 6. Health-verify stage.
  // ---------------------------------------------------------------------------
  let healthResult: HealthResult | undefined;
  let healthFailed = false;

  await runStage('health-verify', async () => {
    if (!backend.verifyHealth) {
      return { status: 'skipped', message: 'Backend does not implement verifyHealth()' };
    }
    try {
      healthResult = await backend.verifyHealth(ctx);
      if (!healthResult.healthy) {
        healthFailed = true;
        return {
          status: 'failed',
          message: healthResult.reason ?? 'Health check failed',
          details: { checks: healthResult.checks },
        };
      }
      return {
        status: 'success',
        message: 'Health check passed',
        details: { checks: healthResult.checks },
      };
    } catch (err) {
      healthFailed = true;
      healthResult = { healthy: false, reason: (err as Error).message, checks: [] };
      return { status: 'failed', message: healthResult.reason };
    }
  });

  if (healthFailed) {
    // Auto-rollback on health-verify failure.
    let rollbackResult: RollbackResult | undefined;
    await runStage('rollback', async () => {
      if (!backend.rollback) {
        return { status: 'skipped', message: 'Backend does not implement rollback()' };
      }
      try {
        rollbackResult = await backend.rollback(ctx);
        return {
          status: rollbackResult.success ? 'success' : 'failed',
          message: rollbackResult.success
            ? `Rolled back${rollbackResult.restoredVersion ? ` to ${rollbackResult.restoredVersion}` : ''}`
            : `Rollback failed: ${rollbackResult.errors.join(', ')}`,
          details: { errors: rollbackResult.errors },
        };
      } catch (err) {
        rollbackResult = { success: false, errors: [(err as Error).message] };
        return { status: 'failed', message: `Rollback threw: ${(err as Error).message}` };
      }
    });
    return {
      runId,
      status: 'health-failed',
      stages,
      policyDecision,
      deployResult,
      healthResult,
      rollbackResult,
      startedAt,
      totalDurationMs: Date.now() - t0,
    };
  }

  // ---------------------------------------------------------------------------
  // 7. All stages passed.
  // ---------------------------------------------------------------------------
  return {
    runId,
    status: 'success',
    stages,
    policyDecision,
    deployResult,
    healthResult,
    startedAt,
    totalDurationMs: Date.now() - t0,
  };
}
