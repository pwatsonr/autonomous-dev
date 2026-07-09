/**
 * Desired-state / GitOps reconciliation for deploy targets (issue #664).
 *
 * ## Model
 *
 * A `DesiredState` record declares what artifact/version a service SHOULD be
 * running on a given target.  An `ObservedState` record describes what is
 * ACTUALLY deployed (produced by platform probes — not this module).
 *
 * ## Pure diff
 *
 * `computeReconcilePlan(desired, observed)` is a PURE function: no I/O, no
 * clock calls, no side effects.  It takes both lists as input and produces an
 * ordered array of `ReconcileAction` items.  Tests can call it with arbitrary
 * inputs and get deterministic results.
 *
 * ## Applying actions
 *
 * `applyReconcileAction()` executes a single `ReconcileAction` via the
 * pipeline runner + policy.  Apply is GATED:
 *   - `dryRun: true` (the default) emits planned stage events and returns
 *     without mutating anything.
 *   - A real apply requires an explicit `confirm: true` flag.
 *   - Every action is evaluated through `evaluatePolicy()` inside
 *     `runPipeline()` — no bypass.
 *
 * ## Invariant #674
 *
 * DesiredState and ObservedState keys are `(service, targetId)` where
 * `targetId` is obtained from the live `DeployTarget` model — never a
 * hard-coded instance name.  Rules and placement match on attributes
 * (kind, env, tags, capabilities), never on bare ids.
 *
 * Cross-reference: issues #664, #662, #668, #674.
 *
 * @module intake/deploy/reconcile
 */

import { runPipeline } from './pipeline-runner';
import type { PipelineRunResult, StageEvent } from './pipeline-runner';
import type { PipelineBackend } from './backend-types';
import type { DeployTarget } from './target-types';
import type { PolicyDocument } from './policy-types';

// ---------------------------------------------------------------------------
// Desired-state model
// ---------------------------------------------------------------------------

/**
 * Desired state for one `(service, target)` pair.
 *
 * Loaded from config (e.g., `desired-state.yaml`) or provided programmatically.
 * Represents operator INTENT — what should be deployed — not what is currently
 * running.
 *
 * Keyed by `(service, targetId)` so multiple services on the same target and
 * the same service on multiple targets are both representable.
 */
export interface DesiredState {
  /** Target id (from `DeployTarget.id` — obtained from the live registry). */
  targetId: string;

  /** Service name (e.g., `'api-gateway'`, `'metrics-collector'`). */
  service: string;

  /**
   * Artifact reference that should be running.
   * Examples: `'my-api:1.2.3'`, `'sha256:abc…'`, a ULID artifact id.
   */
  artifactRef: string;

  /**
   * Optional version label for human display and comparison.
   * Not used for equality checking when `artifactRef` is present.
   */
  version?: string;

  /**
   * Open metadata for backend-specific desired-state fields.
   * Examples: chart values, environment overrides, replica counts.
   */
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Observed state
// ---------------------------------------------------------------------------

/**
 * Currently observed state for one `(service, target)` pair.
 *
 * Produced by platform probes (Docker inspect, Kubernetes get deployment,
 * Portainer API, …).  This module does NOT perform live queries; callers
 * supply the observed list as input to `computeReconcilePlan()`.
 */
export interface ObservedState {
  /** Target id. */
  targetId: string;

  /** Service name. */
  service: string;

  /**
   * Artifact reference that is CURRENTLY running.
   * `undefined` when the service is not deployed at all on this target.
   */
  artifactRef?: string;

  /**
   * Platform-specific details for debugging / portal display.
   */
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Reconcile actions
// ---------------------------------------------------------------------------

/**
 * Action type produced by `computeReconcilePlan()`.
 *
 * - `'deploy'`  — Service is in desired state but not observed: needs initial deploy.
 * - `'update'`  — Service is observed but artifact differs from desired: update.
 * - `'remove'`  — Service is observed but NOT in desired state: remove.
 * - `'none'`    — Desired equals observed: no action needed.
 */
export type ReconcileActionKind = 'deploy' | 'update' | 'remove' | 'none';

/**
 * A single reconcile action produced by `computeReconcilePlan()`.
 *
 * Each action targets one `(service, targetId)` pair.
 */
export interface ReconcileAction {
  /** Action kind. */
  kind: ReconcileActionKind;

  /** Target id this action applies to. */
  targetId: string;

  /** Service name this action applies to. */
  service: string;

  /**
   * Desired artifact ref for `'deploy'` and `'update'` actions.
   * `undefined` for `'none'` and `'remove'` actions.
   */
  desiredArtifactRef?: string;

  /**
   * Currently-running artifact ref (present for `'update'` and `'remove'`).
   * `undefined` for `'deploy'` and `'none'` actions.
   */
  observedArtifactRef?: string;

  /**
   * Human-readable description of why this action is needed.
   */
  reason: string;

  /**
   * Desired-state entry (present for `'deploy'`, `'update'`, `'none'`).
   */
  desiredState?: DesiredState;

  /**
   * Observed-state entry (present for `'update'`, `'remove'`, `'none'`).
   */
  observedState?: ObservedState;
}

// ---------------------------------------------------------------------------
// Pure diff: computeReconcilePlan
// ---------------------------------------------------------------------------

/**
 * Compute the reconcile plan by diffing desired vs. observed state.
 *
 * **PURE**: no I/O, no `Date.now()`, no mutations.  Returns a new array every
 * call.  The same inputs always produce the same outputs in the same order.
 *
 * ## Algorithm
 *
 * Keys are `'<targetId>/<service>'`.
 *
 * 1. For each desired entry:
 *    - No matching observed → `'deploy'`
 *    - Observed but different artifact → `'update'`
 *    - Observed with same artifact → `'none'`
 * 2. For each observed entry with NO matching desired entry → `'remove'`
 *
 * Result ordering: `'deploy'` then `'update'` then `'remove'` then `'none'`,
 * each sub-group in the order the entries appear in the input arrays.  This
 * gives a deterministic, human-readable plan where mutations come before
 * no-ops.
 *
 * @param desired  - The declared desired state (from config / operator intent).
 * @param observed - The currently observed state (from platform probes).
 * @returns Ordered array of `ReconcileAction` items.
 */
export function computeReconcilePlan(
  desired: DesiredState[],
  observed: ObservedState[],
): ReconcileAction[] {
  // Build a fast lookup map keyed by `<targetId>/<service>`.
  const observedMap = new Map<string, ObservedState>();
  for (const o of observed) {
    observedMap.set(`${o.targetId}/${o.service}`, o);
  }

  const desiredMap = new Map<string, DesiredState>();
  for (const d of desired) {
    desiredMap.set(`${d.targetId}/${d.service}`, d);
  }

  const deploys: ReconcileAction[] = [];
  const updates: ReconcileAction[] = [];
  const nones: ReconcileAction[] = [];
  const removes: ReconcileAction[] = [];

  // Pass 1: iterate desired, classify against observed.
  for (const d of desired) {
    const key = `${d.targetId}/${d.service}`;
    const obs = observedMap.get(key);

    if (obs === undefined || obs.artifactRef === undefined) {
      // Not deployed at all → need to deploy.
      deploys.push({
        kind: 'deploy',
        targetId: d.targetId,
        service: d.service,
        desiredArtifactRef: d.artifactRef,
        observedArtifactRef: obs?.artifactRef,
        reason: `Service '${d.service}' is desired on target '${d.targetId}' but not currently deployed.`,
        desiredState: d,
        observedState: obs,
      });
    } else if (obs.artifactRef !== d.artifactRef) {
      // Deployed but wrong artifact → need to update.
      updates.push({
        kind: 'update',
        targetId: d.targetId,
        service: d.service,
        desiredArtifactRef: d.artifactRef,
        observedArtifactRef: obs.artifactRef,
        reason:
          `Service '${d.service}' on target '${d.targetId}' is running ` +
          `'${obs.artifactRef}' but desired '${d.artifactRef}'.`,
        desiredState: d,
        observedState: obs,
      });
    } else {
      // Artifact matches → no action needed.
      nones.push({
        kind: 'none',
        targetId: d.targetId,
        service: d.service,
        desiredArtifactRef: d.artifactRef,
        observedArtifactRef: obs.artifactRef,
        reason: `Service '${d.service}' on target '${d.targetId}' is already at desired artifact '${d.artifactRef}'.`,
        desiredState: d,
        observedState: obs,
      });
    }
  }

  // Pass 2: observed entries with no corresponding desired entry → remove.
  for (const o of observed) {
    const key = `${o.targetId}/${o.service}`;
    if (!desiredMap.has(key)) {
      removes.push({
        kind: 'remove',
        targetId: o.targetId,
        service: o.service,
        observedArtifactRef: o.artifactRef,
        reason:
          `Service '${o.service}' is observed on target '${o.targetId}' ` +
          `but is not in the desired state — drift detected.`,
        observedState: o,
      });
    }
  }

  // Return in deterministic order: deploy → update → remove → none.
  return [...deploys, ...updates, ...removes, ...nones];
}

// ---------------------------------------------------------------------------
// Apply options + result
// ---------------------------------------------------------------------------

/**
 * Options for `applyReconcileAction()`.
 */
export interface ApplyReconcileActionOptions {
  /**
   * The reconcile action to apply.
   *
   * `'none'` actions are no-ops: `applyReconcileAction()` returns immediately
   * with the pipeline result indicating no work was done.
   *
   * `'remove'` actions are not yet implemented by the pipeline runner (the
   * pipeline only deploys / health-checks / rolls back); an explicit
   * `'remove'` action returns a `not-implemented` pipeline status.  Callers
   * that need remove should route to a backend-specific removal path.
   */
  action: ReconcileAction;

  /**
   * Fully-resolved `DeployTarget` for `action.targetId`.
   * The caller is responsible for resolving this from the live registry.
   */
  target: DeployTarget;

  /**
   * Policy document for the target.  Defaults to `EMPTY_POLICY` (allow-all).
   */
  policy?: PolicyDocument;

  /**
   * Optional policy evaluation context.
   */
  policyContext?: {
    now?: number;
    currentCounts?: Record<string, number>;
    affectedTargets?: number;
    colocatedServices?: string[];
    [key: string]: unknown;
  };

  /**
   * When `true`, emits planned stage events without executing any backend
   * method or mutating any state.  This is the DEFAULT for safety.
   */
  dryRun?: boolean;

  /**
   * Required to perform a real apply.  Without `confirm: true` (and
   * `dryRun !== true`), the call throws `ReconcileApplyConfirmRequiredError`.
   */
  confirm?: boolean;

  /**
   * Optional callback receiving structured stage events from the pipeline.
   */
  onStageEvent?: (event: StageEvent) => void;

  /**
   * TEST ONLY — override the backend dispatched by `runPipeline`.
   */
  _backendOverride?: PipelineBackend;
}

/**
 * Result of `applyReconcileAction()`.
 */
export interface ApplyReconcileActionResult {
  /** The action that was applied (or would have been applied in dry-run). */
  action: ReconcileAction;

  /**
   * Full pipeline run result.  Present for `'deploy'` and `'update'` actions.
   * `null` for `'none'` actions (no pipeline ran).
   */
  pipelineResult: PipelineRunResult | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when `applyReconcileAction()` is called without `confirm: true`
 * and `dryRun` is not `true`.
 */
export class ReconcileApplyConfirmRequiredError extends Error {
  constructor() {
    super(
      `applyReconcileAction(): refusing to execute a real apply without { confirm: true }. ` +
        `Pass { dryRun: true } to preview the reconcile plan, or { confirm: true } to apply it. ` +
        `All applies route through the policy engine and pipeline runner.`,
    );
    this.name = 'ReconcileApplyConfirmRequiredError';
  }
}

// ---------------------------------------------------------------------------
// applyReconcileAction
// ---------------------------------------------------------------------------

/**
 * Apply a single `ReconcileAction` via the pipeline runner + policy.
 *
 * ## Gate
 *
 * All applies are gated:
 * - `dryRun: true` → emits planned stage events, no backend calls.
 * - `confirm: true` (with `dryRun: false`) → real apply.
 * - Neither → throws `ReconcileApplyConfirmRequiredError`.
 *
 * ## Routing
 *
 * - `'deploy'` / `'update'` → `runPipeline()` with policy + rollback.
 * - `'none'` → returns immediately with `pipelineResult: null`.
 * - `'remove'` → currently not implemented by the pipeline runner; returns a
 *   synthetic error pipeline result.  Callers requiring removal should use a
 *   backend-specific path.
 *
 * @param opts - Apply options.
 * @returns `ApplyReconcileActionResult` with the action and pipeline result.
 * @throws `ReconcileApplyConfirmRequiredError` when apply is not confirmed.
 */
export async function applyReconcileAction(
  opts: ApplyReconcileActionOptions,
): Promise<ApplyReconcileActionResult> {
  const { action } = opts;
  const dryRun = opts.dryRun === true;

  // Gate: require confirm for a real apply.
  if (!dryRun && opts.confirm !== true) {
    throw new ReconcileApplyConfirmRequiredError();
  }

  // No-op action: return immediately without touching the pipeline.
  if (action.kind === 'none') {
    return { action, pipelineResult: null };
  }

  // 'remove' is not implemented by the pipeline runner.
  // Return a synthetic result rather than running unknown logic.
  if (action.kind === 'remove') {
    // When dry-run, just inform the caller what would happen.
    const syntheticResult: PipelineRunResult = {
      runId: 'remove-not-implemented',
      status: 'no-backend',
      stages: [],
      policyDecision: {
        allowed: false,
        requiredApprovals: [],
        violations: [
          {
            ruleId: 'remove-not-implemented',
            type: 'reconcile',
            message:
              `'remove' action for service '${action.service}' on target '${action.targetId}' ` +
              `is not implemented by the pipeline runner. ` +
              `Use a backend-specific removal path to decommission this service.`,
          },
        ],
        matchedRules: [],
      },
      startedAt: new Date().toISOString(),
      totalDurationMs: 0,
    };
    return { action, pipelineResult: syntheticResult };
  }

  // 'deploy' and 'update' both go through runPipeline().
  const artifactRef = action.desiredArtifactRef ?? '';
  const pipelineResult = await runPipeline({
    target: opts.target,
    service: action.service,
    artifact: {
      name: artifactRef,
      tag: artifactRef,
      meta: {
        reconcileAction: action.kind,
        fromReconcile: true,
      },
    },
    policy: opts.policy,
    policyContext: opts.policyContext,
    dryRun,
    onStageEvent: opts.onStageEvent,
    _backendOverride: opts._backendOverride,
  });

  return { action, pipelineResult };
}

// ---------------------------------------------------------------------------
// Batch apply (convenience)
// ---------------------------------------------------------------------------

/**
 * Apply all actions in a reconcile plan.
 *
 * Calls `applyReconcileAction()` for each action in the plan in order.
 * Skips `'none'` actions.  Errors on individual actions are captured in the
 * result rather than propagated (fail-partial semantics: continue with other
 * targets even when one fails).
 *
 * @param actions - The reconcile plan produced by `computeReconcilePlan()`.
 * @param getTarget - Async function to resolve a `DeployTarget` by id.
 *   Called once per unique `targetId` in the plan.
 * @param opts - Shared apply options applied to every action.
 * @returns Array of results in plan order (excluding `'none'` actions).
 */
export async function applyReconcilePlan(
  actions: ReconcileAction[],
  getTarget: (targetId: string) => Promise<DeployTarget | undefined>,
  opts: Omit<ApplyReconcileActionOptions, 'action' | 'target'>,
): Promise<Array<ApplyReconcileActionResult & { error?: Error }>> {
  const results: Array<ApplyReconcileActionResult & { error?: Error }> = [];

  for (const action of actions) {
    if (action.kind === 'none') continue;

    const target = await getTarget(action.targetId);
    if (target === undefined) {
      const syntheticResult: PipelineRunResult = {
        runId: 'unknown-target',
        status: 'no-backend',
        stages: [],
        policyDecision: {
          allowed: false,
          requiredApprovals: [],
          violations: [
            {
              ruleId: 'unknown-target',
              type: 'reconcile',
              message: `Cannot apply action: target '${action.targetId}' not found in registry.`,
            },
          ],
          matchedRules: [],
        },
        startedAt: new Date().toISOString(),
        totalDurationMs: 0,
      };
      results.push({ action, pipelineResult: syntheticResult });
      continue;
    }

    try {
      const result = await applyReconcileAction({ ...opts, action, target });
      results.push(result);
    } catch (err) {
      results.push({
        action,
        pipelineResult: null,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  return results;
}
