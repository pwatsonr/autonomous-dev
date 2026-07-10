/**
 * Deploy orchestrator (SPEC-023-2-03 skeleton; SPEC-023-2-04 extends with
 * cost-cap pre-check and telemetry).
 *
 * Wires together:
 *   - environment.ts   resolver (SPEC-023-2-01)
 *   - selector.ts      backend selection + parameter merging (SPEC-023-2-02)
 *   - approval.ts      approval state machine (SPEC-023-2-03)
 *   - cost-cap.ts      per-env cap pre-check (SPEC-023-2-04)
 *   - telemetry.ts     init + completion events (SPEC-023-2-04)
 *
 * `runDeploy()` returns a structured outcome rather than mutating
 * external state directly. Backend invocation is delegated to the
 * registry's `DeploymentBackend.deploy()` method.
 *
 * @module intake/deploy/orchestrator
 */

import {
  CostCapExceededError,
  DailyCostCapExceededError,
  AdminOverrideRequiredError,
  StatefulPreconditionError,
} from './errors';
import { checkCostCap, recordCost } from './cost-cap';
import { CostCapEnforcer } from './cost-cap-enforcer';
import { CostLedger } from './cost-ledger';
import { loadConfig, resolveEnvironment, configPathFor } from './environment';
import { requestApproval } from './approval';
import { selectBackend, type SelectorBackendRegistry } from './selector';
import { productionSelectorRegistry } from './selector-registry-adapter';
import { BackendRegistry } from './registry';
import { emitDeployInit, emitDeployCompletion } from './telemetry';
import type { ApprovalState } from './approval-types';
import type { ResolvedEnvironment } from './types-config';
import type { BuildContext, DeploymentRecord } from './types';
import type { ResolvedTarget } from './target-resolver';
import type { BackupClass } from './stateful-contract';
import { evaluateStatefulPrecondition } from './stateful-contract';
import type { SecretBinding, ResolvedSecretBinding, RecordSafeBinding } from './secret-binding';
import { resolveSecretBindings, toRecordSafeBindings } from './secret-binding';
import type { CredentialProxy } from './credential-proxy-types';

/** Hook for tests to recording escalations without booting PLAN-009. */
export interface EscalationSink {
  raise(event: {
    deployId: string;
    envName: string;
    requirement: ApprovalState['requirement'];
    backendName: string;
    selectionSource: string;
  }): Promise<void> | void;
}

let escalationSink: EscalationSink = {
  raise: () => undefined,
};
export function setEscalationSink(sink: EscalationSink): void {
  escalationSink = sink;
}
export function resetEscalationSink(): void {
  escalationSink = { raise: () => undefined };
}

/** Outcome surfaced to the supervisor. */
export interface RunDeployResult {
  status: 'completed' | 'paused' | 'rejected' | 'failed';
  reason?: string;
  record?: DeploymentRecord;
}

/**
 * Context forwarded to the homelab dispatch handler (issue #665).
 *
 * Core delegates homelab deploys entirely to the plugin's approval/safety
 * gate. The context carries all information the plugin needs without
 * requiring a round-trip back to the orchestrator.
 */
export interface HomelabDispatchContext {
  /** The deploy identifier. */
  deployId: string;
  /** Logical environment name. */
  envName: string;
  /** Resolved target, including id, kind, capabilities, and tags. */
  resolvedTarget: ResolvedTarget;
  /** Backup class resolved from the target (issue #666). */
  backupClass: BackupClass;
  /** Verified backup manifest ref, if supplied by the caller (issue #666). */
  verifiedBackupRef?: string;
  /** True when `backupOverride` was set on the request (issue #666). */
  overrideApplied: boolean;
  /** Record-safe secret bindings (refHash only — no material) (issue #667). */
  secretBindings: RecordSafeBinding[];
  /** Original request args for any additional context the plugin needs. */
  args: RunDeployArgs;
}

/**
 * Homelab dispatch function injected into `runDeploy()` (issue #665).
 *
 * Core calls this for targets with `location: 'homelab'`. The function
 * is implemented by the homelab plugin and handles the full plugin gate
 * (typed-CONFIRM, 24h delay, mutation barrier, actual backup verification).
 * Core does NOT reimplement any of those steps.
 *
 * @param ctx - Homelab dispatch context.
 * @returns A partial `DeploymentRecord` with at minimum `status`, `artifactId`,
 *   `deployedAt`, and `details` set. Core fills in `deployId`, `backend`,
 *   `environment`, `targetId`, `location`, and `node`.
 */
export type HomelabDispatchFn = (ctx: HomelabDispatchContext) => Promise<Partial<DeploymentRecord>>;

/**
 * Inputs to runDeploy().
 *
 * `actor` (SPEC-032-1-01) is the principal initiating the deploy
 * (per-request). It is consumed by `CostCapEnforcer.maybeStickyWarn`
 * to attribute the 80% sticky soft-warning per actor/day. Sourced
 * from approval state by the supervisor caller.
 */
export interface RunDeployArgs {
  deployId: string;
  envName: string;
  /** Repo / request worktree path. Holds `.autonomous-dev/deploy.yaml`. */
  requestDir: string;
  /**
   * Principal initiating the deploy (per-request). Used by
   * `CostCapEnforcer.maybeStickyWarn` to attribute the 80% sticky
   * soft-warning per actor/day. Sourced from approval state.
   */
  actor: string;
  /** Optional CLI `--backend` override. */
  cliBackendOverride?: string;
  /** Optional injected registry (tests). Defaults to production adapter. */
  selectorRegistry?: SelectorBackendRegistry;
  /** Build context handed to backend.build() / .deploy(). */
  buildContext?: BuildContext;

  // --- Issue #665: daemon handoff ---
  /**
   * Resolved deploy target. When supplied, the orchestrator branches on
   * `resolvedTarget.target.tags['location']` ('cloud' | 'homelab').
   * Homelab deploys are delegated to `homelandDispatch`; cloud deploys
   * take the existing backend path (unchanged).
   *
   * When absent, the orchestrator takes the existing backend path (backward
   * compatibility with callers that do not yet supply a resolved target).
   */
  resolvedTarget?: ResolvedTarget;
  /**
   * Homelab dispatch function (issue #665). Required when `resolvedTarget`
   * has `location: 'homelab'`. Implemented by the homelab plugin.
   *
   * When absent for a homelab target, the orchestrator returns
   * `{ status: 'failed', reason: 'no homelandDispatch for homelab target' }`.
   */
  homelandDispatch?: HomelabDispatchFn;

  // --- Issue #666: stateful contract ---
  /**
   * When `true`, the deploy is blocked unless a `verifiedBackupRef` is
   * supplied or `backupOverride` is `true`. Only checked when the resolved
   * target has the `'stateful'` capability. Defaults to `false`.
   */
  requiresVerifiedBackup?: boolean;
  /**
   * A backup manifest id verified by a prior backup operation.
   * Satisfies `requiresVerifiedBackup` without an override.
   */
  verifiedBackupRef?: string;
  /**
   * Admin-level explicit override for the stateful backup precondition.
   * Bypasses the block; recorded in the homelab dispatch context so the
   * plugin can add it to the audit trail.
   */
  backupOverride?: boolean;

  // --- Issue #667: secret bindings ---
  /**
   * Secret bindings to resolve JIT before dispatch. Each binding
   * names a credential ref, injection mode, and target name/path.
   * Resolved via the `credentialProxy`. Only `refHash` is persisted to
   * the `DeploymentRecord`.
   */
  secretBindings?: SecretBinding[];
  /**
   * `CredentialProxy` for JIT secret resolution (issue #667).
   * Required when `secretBindings` is non-empty. When absent and
   * `secretBindings` is non-empty, the orchestrator returns
   * `{ status: 'failed', reason: 'secretBindings require a credentialProxy' }`.
   */
  credentialProxy?: CredentialProxy;
}

// --- Cost-cap enforcer + ledger plumbing (SPEC-032-1-01) ----------------
//
// The legacy code path lives in `./cost-cap`. This module now also wires
// the new `CostCapEnforcer` (SPEC-023-3-03) per `requestDir`, behind a
// memoized helper. The enforcer is constructed lazily but NOT invoked
// here — SPEC-032-1-02 performs the actual `enforcer.check()` cutover.
//
// Implementation note (SPEC-032-1-01 §Implementation Notes): the names
// `getLedger`, `loadCostCapConfig`, and `orchestratorEscalationSink`
// referenced by the spec do not exist in the as-built code. We provide
// in-module equivalents:
//   - `getOrCreateLedger(requestDir)` constructs a per-requestDir
//     `CostLedger` rooted at `<requestDir>/.autonomous-dev`.
//   - `loadCostCapConfig(requestDir)` reads `cost_cap_usd` from the
//     resolved deploy config (currently a no-op default at the
//     orchestrator level — the per-env cap lives on the resolved env).
//   - The escalation sink delegates to the existing module-level
//     `escalationSink` via a thin adapter that maps the enforcer's
//     `EscalationMessage` shape onto the orchestrator's existing
//     `EscalationSink.raise` shape. The adapter currently no-ops because
//     the enforcer's escalations carry richer structure than the
//     orchestrator's `EscalationSink` accepts; SPEC-032-1-02 will
//     either widen the sink or carry the message through telemetry.
//
// The cache is module-scoped so jest's per-worker isolation gives each
// worker a fresh map. Do NOT use globalThis.

const ledgerCache = new Map<string, CostLedger>();
const enforcerCache = new Map<string, CostCapEnforcer>();

function getOrCreateLedger(requestDir: string): CostLedger {
  const cached = ledgerCache.get(requestDir);
  if (cached) return cached;
  const ledger = new CostLedger({
    dir: `${requestDir}/.autonomous-dev`,
  });
  ledgerCache.set(requestDir, ledger);
  return ledger;
}

async function loadCostCapConfig(_requestDir: string): Promise<{ cost_cap_usd_per_day: number }> {
  // The per-env cap from `deploy.yaml` is resolved per-call via
  // `ResolvedEnvironment.costCapUsd`. The enforcer-level config is the
  // operator-wide daily cap; we currently surface 0 (== "use enforcer
  // default") because deploy.yaml does not yet model a per-day cap.
  // Operators with a daily-cap requirement set
  // `process.env.AUTONOMOUS_DEV_COST_CAP_USD_PER_DAY`. Documented in
  // SPEC-032-1-02's Implementation Notes.
  const env = process.env.AUTONOMOUS_DEV_COST_CAP_USD_PER_DAY;
  const parsed = env ? Number(env) : 0;
  return {
    cost_cap_usd_per_day: Number.isFinite(parsed) && parsed > 0 ? parsed : 0,
  };
}

/**
 * Memoized per-requestDir `CostCapEnforcer` factory (SPEC-032-1-01 FR-5).
 * Module-private; consumed by SPEC-032-1-02's cutover.
 */
function getOrCreateCostCapEnforcer(requestDir: string): CostCapEnforcer {
  const cached = enforcerCache.get(requestDir);
  if (cached) return cached;
  const enforcer = new CostCapEnforcer({
    ledger: getOrCreateLedger(requestDir),
    config: () => loadCostCapConfig(requestDir),
    escalate: async (msg) => {
      // The enforcer's escalations are richer than the orchestrator's
      // `EscalationSink.raise` shape. Forward only the deployId so
      // existing test sinks observe the call. SPEC-032-1-02 will
      // carry the full payload via telemetry.
      try {
        await escalationSink.raise({
          deployId: msg.deployId,
          envName: '',
          requirement: 'none',
          backendName: '',
          selectionSource: '',
        });
      } catch {
        /* enforcer escalations must never poison deploy decisions */
      }
    },
  });
  enforcerCache.set(requestDir, enforcer);
  return enforcer;
}

/**
 * Test-only escape hatch for SPEC-032-1-01's memoization tests. Not
 * exported from the public surface.
 */
export function __getOrCreateCostCapEnforcerForTest(requestDir: string): CostCapEnforcer {
  return getOrCreateCostCapEnforcer(requestDir);
}

/**
 * Test-only cache reset for SPEC-032-1-01's tests. Not exported from
 * the public surface.
 */
export function __resetCostCapEnforcerCacheForTest(): void {
  enforcerCache.clear();
  ledgerCache.clear();
}

/**
 * Returns true when the operator has opted into the legacy cost-cap
 * code path (SPEC-032-1-02 FR-1/FR-2). Default OFF — the new path
 * (legacy per-env pre-check PLUS `CostCapEnforcer.check()` for the
 * operator-wide daily cap) is active. Setting
 * `AUTONOMOUS_DEV_COST_CAP_LEGACY=1` skips the enforcer call and
 * routes only through the legacy `checkCostCap` / `recordCost` pair
 * (the deprecation shim shipped in SPEC-032-1-03).
 */
function useLegacyCostCapPath(): boolean {
  return process.env.AUTONOMOUS_DEV_COST_CAP_LEGACY === '1';
}

/**
 * Run one deploy through the full pipeline. Returns a status and
 * optional `DeploymentRecord` on success.
 *
 * Status semantics:
 *   - completed: backend succeeded
 *   - paused:    waiting on approval; orchestrator emitted an escalation
 *   - rejected:  approval state has decision === 'rejected'
 *   - failed:    backend threw or returned status !== 'deployed'
 *
 * Cost-cap routing (SPEC-032-1-02):
 *   - Default (`AUTONOMOUS_DEV_COST_CAP_LEGACY` unset or != '1'): the
 *     legacy per-env `checkCostCap` pre-check still runs (SPEC-023-2-04
 *     contract); on success, `CostCapEnforcer.check()` then enforces the
 *     operator-wide daily cap. On `DailyCostCapExceededError` /
 *     `AdminOverrideRequiredError` the orchestrator emits a
 *     `deploy.completion` telemetry event with `outcome:'cost-cap-exceeded'`
 *     and `reason: '${ErrorClassName}: ${message}'`, then re-throws
 *     `CostCapExceededError(reason)`. Any other error from the enforcer
 *     re-throws verbatim.
 *   - Legacy (`AUTONOMOUS_DEV_COST_CAP_LEGACY=1`): the enforcer is NOT
 *     invoked; only the legacy `checkCostCap` / `recordCost` pair runs.
 *     Cross-references the deprecation shim in SPEC-032-1-03.
 */
export async function runDeploy(args: RunDeployArgs): Promise<RunDeployResult> {
  const startedAt = Date.now();
  const config = await loadConfig(args.requestDir);
  const resolved: ResolvedEnvironment = resolveEnvironment(config, args.envName, {
    configPath: config ? configPathFor(args.requestDir) : null,
  });
  const registry = args.selectorRegistry ?? productionSelectorRegistry;

  const selection = selectBackend({
    resolved,
    registry,
    override: args.cliBackendOverride ? { backend: args.cliBackendOverride } : undefined,
    repoDefaultBackend: config?.default_backend,
  });

  // --- Approval gate ---------------------------------------------------
  if (resolved.approval !== 'none') {
    const state = await requestApproval({
      deployId: args.deployId,
      envName: resolved.envName,
      requirement: resolved.approval,
      requestDir: args.requestDir,
    });
    if (state.decision === 'rejected') {
      emitDeployCompletion({
        type: 'deploy.completion',
        requestId: args.deployId,
        envName: resolved.envName,
        selectedBackend: selection.backendName,
        outcome: 'rejected',
        durationMs: Date.now() - startedAt,
        actualCostUsd: 0,
        ts: new Date().toISOString(),
      });
      return { status: 'rejected', reason: 'approval rejected' };
    }
    if (state.decision === 'pending') {
      emitDeployInit({
        type: 'deploy.init',
        requestId: args.deployId,
        envName: resolved.envName,
        selectedBackend: selection.backendName,
        source: selection.source,
        approvalRequirement: resolved.approval,
        costEstimate: 0,
        ts: new Date().toISOString(),
      });
      try {
        await escalationSink.raise({
          deployId: args.deployId,
          envName: resolved.envName,
          requirement: resolved.approval,
          backendName: selection.backendName,
          selectionSource: selection.source,
        });
      } catch {
        // Escalation failures must not crash the orchestrator; the
        // supervisor will retry on the next tick.
      }
      return { status: 'paused', reason: 'awaiting approval' };
    }
  }

  // --- Issue #666: stateful precondition check -------------------------
  // Evaluate BEFORE cost-cap (fail fast on config errors before incurring
  // cost-estimation I/O). Runs only when a resolvedTarget is supplied.
  if (args.resolvedTarget) {
    const target = args.resolvedTarget.target;
    const backupClass = target.backup_class ?? 'none';
    const precondition = evaluateStatefulPrecondition({
      targetCapabilities: target.capabilities,
      backupClass,
      requiresVerifiedBackup: args.requiresVerifiedBackup ?? false,
      verifiedBackupRef: args.verifiedBackupRef,
      backupOverride: args.backupOverride,
    });
    if (precondition.blocked) {
      throw new StatefulPreconditionError(backupClass);
    }
  }

  // --- Issue #667: JIT secret binding resolution -----------------------
  // Resolve before dispatch. Persists only refHash; material is in-process.
  let resolvedBindings: ResolvedSecretBinding[] = [];
  let safeBindings: RecordSafeBinding[] = [];
  if (args.secretBindings && args.secretBindings.length > 0) {
    if (!args.credentialProxy) {
      return { status: 'failed', reason: 'secretBindings require a credentialProxy' };
    }
    // resolveSecretBindings throws on permission-denied; let it propagate.
    resolvedBindings = await resolveSecretBindings(args.secretBindings, args.credentialProxy);
    safeBindings = toRecordSafeBindings(resolvedBindings);
  }
  // resolvedBindings carries live material for in-process injection;
  // safeBindings (refHash only) is persisted to DeploymentRecord.
  void resolvedBindings; // available for injection middleware; not used in core

  // --- Issue #665: location branching ----------------------------------
  // When a resolvedTarget is supplied and its 'location' tag is 'homelab',
  // delegate entirely to the homelab plugin's dispatch function. Cloud and
  // no-target paths continue with the existing backend invocation below.
  if (args.resolvedTarget) {
    const target = args.resolvedTarget.target;
    const location = (target.tags['location'] ?? 'cloud') as 'cloud' | 'homelab';
    if (location === 'homelab') {
      if (!args.homelandDispatch) {
        return { status: 'failed', reason: 'no homelandDispatch for homelab target' };
      }
      const backupClass = target.backup_class ?? 'none';
      const ctx: HomelabDispatchContext = {
        deployId: args.deployId,
        envName: args.envName,
        resolvedTarget: args.resolvedTarget,
        backupClass,
        verifiedBackupRef: args.verifiedBackupRef,
        overrideApplied: args.backupOverride ?? false,
        secretBindings: safeBindings,
        args,
      };
      const partial = await args.homelandDispatch(ctx);
      const record: DeploymentRecord = {
        deployId: args.deployId,
        backend: selection.backendName,
        environment: resolved.envName,
        artifactId: partial.artifactId ?? 'unknown',
        deployedAt: partial.deployedAt ?? new Date().toISOString(),
        status: partial.status ?? 'deployed',
        details: partial.details ?? {},
        targetId: target.id,
        location: 'homelab',
        node: target.tags['node'],
        hmac: '',
        ...(safeBindings.length > 0 ? { secretBindings: safeBindings } : {}),
      };
      return record.status === 'deployed'
        ? { status: 'completed', record }
        : { status: 'failed', reason: record.status, record };
    }
    // Cloud path: fall through to existing backend invocation with target metadata.
  }

  // --- Cost-cap pre-check + telemetry init ----------------------------
  const estimatedCost = await safeEstimate(selection.backendName, selection.parameters);
  emitDeployInit({
    type: 'deploy.init',
    requestId: args.deployId,
    envName: resolved.envName,
    selectedBackend: selection.backendName,
    source: selection.source,
    approvalRequirement: resolved.approval,
    costEstimate: estimatedCost,
    ts: new Date().toISOString(),
  });

  const capCheck = await checkCostCap({
    requestDir: args.requestDir,
    envName: resolved.envName,
    capUsd: resolved.costCapUsd,
    estimatedUsd: estimatedCost,
  });
  if (!capCheck.allowed) {
    emitDeployCompletion({
      type: 'deploy.completion',
      requestId: args.deployId,
      envName: resolved.envName,
      selectedBackend: selection.backendName,
      outcome: 'cost-cap-exceeded',
      durationMs: Date.now() - startedAt,
      actualCostUsd: 0,
      reason: capCheck.reason,
      ts: new Date().toISOString(),
    });
    throw new CostCapExceededError(capCheck.reason);
  }

  // --- Operator-wide daily cap via CostCapEnforcer (SPEC-032-1-02) ----
  // The legacy `checkCostCap` above enforces the per-env cap from
  // `deploy.yaml` (SPEC-023-2-04). The enforcer below adds the
  // operator-wide daily cap layer (SPEC-023-3-03). Both gates must
  // permit the deploy. The legacy flag (`AUTONOMOUS_DEV_COST_CAP_LEGACY=1`)
  // skips the enforcer entirely and routes through the legacy path only.
  if (!useLegacyCostCapPath()) {
    const enforcer = getOrCreateCostCapEnforcer(args.requestDir);
    try {
      await enforcer.check({
        actor: args.actor,
        estimated_cost_usd: estimatedCost,
        deployId: args.deployId,
        env: resolved.envName,
        backend: selection.backendName,
      });
    } catch (err) {
      if (err instanceof DailyCostCapExceededError || err instanceof AdminOverrideRequiredError) {
        const reason = `${err.constructor.name}: ${err.message}`;
        emitDeployCompletion({
          type: 'deploy.completion',
          requestId: args.deployId,
          envName: resolved.envName,
          selectedBackend: selection.backendName,
          outcome: 'cost-cap-exceeded',
          durationMs: Date.now() - startedAt,
          actualCostUsd: 0,
          reason,
          ts: new Date().toISOString(),
        });
        throw new CostCapExceededError(reason);
      }
      throw err;
    }
  }

  // --- Backend invocation (cloud path) --------------------------------
  try {
    const record = await invokeBackend(args, selection.backendName, resolved, safeBindings);
    await recordCost({
      requestDir: args.requestDir,
      envName: resolved.envName,
      deployId: args.deployId,
      usd: estimatedCost,
    });
    emitDeployCompletion({
      type: 'deploy.completion',
      requestId: args.deployId,
      envName: resolved.envName,
      selectedBackend: selection.backendName,
      outcome: record.status === 'deployed' ? 'success' : 'failure',
      durationMs: Date.now() - startedAt,
      actualCostUsd: estimatedCost,
      ...(record.status === 'deployed' ? {} : { reason: record.status }),
      ts: new Date().toISOString(),
    });
    return record.status === 'deployed'
      ? { status: 'completed', record }
      : { status: 'failed', reason: record.status, record };
  } catch (err) {
    const reason = (err as Error).message;
    emitDeployCompletion({
      type: 'deploy.completion',
      requestId: args.deployId,
      envName: resolved.envName,
      selectedBackend: selection.backendName,
      outcome: 'failure',
      durationMs: Date.now() - startedAt,
      actualCostUsd: 0,
      reason,
      ts: new Date().toISOString(),
    });
    return { status: 'failed', reason };
  }
}

/**
 * Best-effort cost estimate. Returns 0 when the backend does not
 * implement `estimateDeployCost` or when the call throws.
 */
async function safeEstimate(
  backendName: string,
  params: Record<string, string | number | boolean>,
): Promise<number> {
  try {
    const backend = BackendRegistry.get(backendName) as unknown as {
      estimateDeployCost?: (p: Record<string, unknown>) => Promise<number> | number;
    };
    if (typeof backend.estimateDeployCost === 'function') {
      const value = await backend.estimateDeployCost(params);
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
    }
    return 0;
  } catch {
    return 0;
  }
}

async function invokeBackend(
  args: RunDeployArgs,
  backendName: string,
  resolved: ResolvedEnvironment,
  safeBindings: RecordSafeBinding[],
): Promise<DeploymentRecord> {
  const backend = BackendRegistry.get(backendName);

  // Stamp target-aware fields onto every record produced by this path.
  // (#665) targetId/location/node are sourced from the resolved target when
  // supplied; cloud deploys use location:'cloud'. These are added after the
  // backend's own record is built so backends remain unaware of the new fields.
  const targetOverrides: Partial<DeploymentRecord> = {};
  if (args.resolvedTarget) {
    const tgt = args.resolvedTarget.target;
    targetOverrides.targetId = tgt.id;
    targetOverrides.location = 'cloud';
    targetOverrides.node = tgt.tags['node'];
  }
  const bindingOverrides: Partial<DeploymentRecord> =
    safeBindings.length > 0 ? { secretBindings: safeBindings } : {};

  if (!args.buildContext) {
    // Without a buildContext, the orchestrator cannot legitimately
    // invoke build/deploy. Return a synthesized failed record so the
    // caller still observes a record-shaped result.
    return {
      deployId: args.deployId,
      backend: backendName,
      environment: resolved.envName,
      artifactId: 'unknown',
      deployedAt: new Date().toISOString(),
      status: 'failed',
      details: { reason: 'no buildContext supplied' },
      hmac: '',
      ...targetOverrides,
      ...bindingOverrides,
    };
  }
  const artifact = await backend.build(args.buildContext);
  const record = await backend.deploy(artifact, resolved.envName, args.buildContext.params);
  return { ...record, ...targetOverrides, ...bindingOverrides };
}
