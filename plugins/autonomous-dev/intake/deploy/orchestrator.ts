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

import { CostCapExceededError } from './errors';
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

async function loadCostCapConfig(
  _requestDir: string,
): Promise<{ cost_cap_usd_per_day: number }> {
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
export function __getOrCreateCostCapEnforcerForTest(
  requestDir: string,
): CostCapEnforcer {
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
 * Run one deploy through the full pipeline. Returns a status and
 * optional `DeploymentRecord` on success.
 *
 * Status semantics:
 *   - completed: backend succeeded
 *   - paused:    waiting on approval; orchestrator emitted an escalation
 *   - rejected:  approval state has decision === 'rejected'
 *   - failed:    backend threw or returned status !== 'deployed'
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

  // --- Backend invocation ---------------------------------------------
  try {
    const record = await invokeBackend(args, selection.backendName, resolved);
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
): Promise<DeploymentRecord> {
  const backend = BackendRegistry.get(backendName);
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
    };
  }
  const artifact = await backend.build(args.buildContext);
  return backend.deploy(artifact, resolved.envName, args.buildContext.params);
}
