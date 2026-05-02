/**
 * ChainExecutor — sequential downstream walker over a topological order
 * (SPEC-022-1-04, Task 8).
 *
 * Consumes the three chain primitives:
 *   - DependencyGraph (SPEC-022-1-03) for topological ordering + reachability.
 *   - ArtifactRegistry (SPEC-022-1-02) for validate / persist / load.
 *   - HookManifest list + a `chainHookInvoker` callback for the actual
 *     plugin invocation (intentionally injected so this layer doesn't bind
 *     itself to PLAN-019-1's HookExecutor — PLAN-022-2 will formalize the
 *     selector / multi-hook routing).
 *
 * Behavior summary (full contract in the spec):
 *   1. Validate the seed artifact against its declared schema. On failure,
 *      return ok:false with a single step recording the validation error.
 *   2. Persist the seed artifact.
 *   3. Walk every plugin AFTER the trigger in `graph.topologicalSort()`.
 *      For each, find which `consumes[]` declarations are satisfied by
 *      artifacts produced earlier in this run. If none, skip with
 *      `'no upstream producer in this chain run'`. If any, load each input
 *      and invoke the plugin via `chainHookInvoker`.
 *   4. Validate every produced artifact against its declared schema; on
 *      failure mark the step `error`.
 *   5. Skip-cascade: any plugin reachable in `graph.adj` from a failed step
 *      is recorded as `skipped` with `'upstream error in <P>'`.
 *
 * Logging: one INFO line per step (`chain: <P> (<status>, <ms>ms)`).
 *
 * @module intake/chains/executor
 */

import { performance } from 'node:perf_hooks';
import type { DependencyGraph } from './dependency-graph';
import type { ArtifactRegistry } from './artifact-registry';
import type { HookManifest, ChainFailureMode } from '../hooks/types';
import { satisfiesRange } from '../hooks/semver-compat';
import {
  PluginTimeoutError,
  ChainTooLongError,
  ConcurrentChainLimitError,
  ChainNotApprovedError,
  ChainStateMissingError,
} from './errors';
import { StateStore } from './state-store';
import type {
  ArtifactRef,
  ChainPausedState,
  EscalationRouter,
} from './types';

/**
 * Resource-limit configuration consumed by ChainExecutor (SPEC-022-2-01,
 * SPEC-022-2-02). Mirrors the `chains` block in the global config schema.
 */
export interface ChainResourceLimits {
  max_length: number;
  per_plugin_timeout_seconds: number;
  per_chain_timeout_seconds: number;
  max_artifact_size_mb: number;
  max_concurrent_chains: number;
}

/**
 * SPEC-022-2-02: pick the strictest of a set of ChainFailureMode values.
 * Strictness order: `block` > `warn` > `ignore`. Empty array returns 'warn'
 * (the spec default).
 */
export function strictestFailureMode(
  modes: ReadonlyArray<ChainFailureMode>,
): ChainFailureMode {
  if (modes.includes('block')) return 'block';
  if (modes.includes('warn')) return 'warn';
  if (modes.includes('ignore')) return 'ignore';
  return 'warn';
}

/** Default limits matching `config_defaults.json`. SPEC-022-2-01. */
export const DEFAULT_CHAIN_LIMITS: ChainResourceLimits = Object.freeze({
  max_length: 10,
  per_plugin_timeout_seconds: 120,
  per_chain_timeout_seconds: 600,
  max_artifact_size_mb: 10,
  max_concurrent_chains: 3,
});

/**
 * Optional ChainExecutor dependencies bolted on across PLAN-022-2.
 *
 * Kept on a single options bag (rather than positional constructor args)
 * so future specs can extend without breaking call sites. PLAN-022-1
 * `buildExecutor` test helper still works because every field is optional.
 */
export interface ChainExecutorOptions {
  /** SPEC-022-2-01: chain-resource limits. Defaults to DEFAULT_CHAIN_LIMITS. */
  limits?: ChainResourceLimits;
  /** Stable chain-id assigned by caller; used in timeout error messages and telemetry. */
  chainId?: string;
  /** Logger. Defaults to console. */
  logger?: { info: (s: string) => void; warn?: (s: string) => void };
  /**
   * SPEC-022-2-03: optional state store for paused-chain persistence. When
   * absent, the approval gate is disabled (artifacts with
   * `requires_approval: true` are treated as ordinary outputs and the chain
   * proceeds). Provided by the daemon at construction time.
   */
  stateStore?: StateStore;
  /**
   * SPEC-022-2-03: optional escalation router. Notified with
   * `chain-approval-pending` events when a chain pauses. When absent the
   * pause is silent (state file written but no notification fires).
   */
  escalationRouter?: EscalationRouter;
}

export interface ChainStep {
  pluginId: string;
  /** Artifact types this plugin consumed (loaded from disk). */
  consumed: Array<{ artifactType: string; scanId: string }>;
  /** Artifact types this plugin produced (persisted to disk). */
  produced: Array<{ artifactType: string; scanId: string; filePath: string }>;
  status: 'ok' | 'error' | 'skipped';
  /** Populated when status='error' or status='skipped'. */
  error?: string;
  durationMs: number;
}

/**
 * Coarse-grained chain disposition. SPEC-022-2-03 introduces the `paused`
 * outcome; SPEC-022-2-04 will add `blocked` / `rejected` for trust + reject
 * paths. PLAN-022-1 callers only checked `ok`; that field is preserved so
 * existing tests keep passing.
 */
export type ChainOutcome = 'success' | 'failed' | 'paused';

export interface ChainExecutionResult {
  triggeringPluginId: string;
  /** Initial scan id of the triggering plugin's emitted artifact. */
  triggerScanId?: string;
  /** Steps in execution order (producers before consumers). */
  steps: ChainStep[];
  /** True iff every step is 'ok' or 'skipped' (skips are not errors). */
  ok: boolean;
  /**
   * SPEC-022-2-03: coarse-grained chain disposition. `success` and `failed`
   * mirror `ok=true|false`. `paused` indicates a `requires_approval`
   * artifact halted execution and a state file was written.
   */
  outcome: ChainOutcome;
  /**
   * SPEC-022-2-03: populated iff `outcome === 'paused'`. Snapshot of the
   * persisted state, mirroring the on-disk JSON exactly so the caller can
   * route an escalation without a second read.
   */
  pausedState?: ChainPausedState;
}

export interface RequestState {
  /** Absolute path to the request's working directory. Artifacts persist
   *  under <root>/.autonomous-dev/artifacts/. */
  requestRoot: string;
  /** Stable id used as the default scanId when a plugin omits one. */
  requestId: string;
}

/**
 * Per-plugin produced output as returned by the chain hook callback.
 *
 * The callback returns ALL artifacts the plugin produced this run (in
 * declared `produces[]` order). The executor validates and persists each.
 */
export interface ChainHookOutput {
  artifactType: string;
  /** Stable scan id; conventionally `${requestId}-<plugin>-<n>`. */
  scanId: string;
  payload: unknown;
}

export interface ChainHookInvocationContext {
  requestState: RequestState;
  /** Map from artifact_type → loaded payload, for every input the plugin
   *  declared it consumes. */
  inputs: Record<string, unknown>;
}

/** Callback shape for invoking a chain consumer plugin. */
export type ChainHookInvoker = (
  pluginId: string,
  ctx: ChainHookInvocationContext,
) => Promise<ChainHookOutput[]>;

/**
 * Resolves a plugin id to its parsed manifest. The executor needs the
 * manifest's `produces`/`consumes` declarations to know which artifacts to
 * validate, load, and persist.
 */
export type ManifestLookup = (pluginId: string) => HookManifest | undefined;

export class ChainExecutor {
  /**
   * SPEC-022-2-02: Daemon-scoped active-chain counter. Static so multiple
   * `ChainExecutor` instances in the same process share the same cap; this
   * matches production semantics (one daemon per host).
   */
  private static activeChains = 0;

  /** Visible for tests + telemetry. */
  static getActiveChainCount(): number {
    return ChainExecutor.activeChains;
  }

  /** Test-only: reset the counter (e.g. between tests). Never call in prod. */
  static __resetActiveChainsForTest(): void {
    ChainExecutor.activeChains = 0;
  }

  private readonly limits: ChainResourceLimits;
  private readonly chainId: string;
  private readonly stateStore?: StateStore;
  private readonly escalationRouter?: EscalationRouter;
  constructor(
    private readonly graph: DependencyGraph,
    private readonly artifacts: ArtifactRegistry,
    private readonly manifestLookup: ManifestLookup,
    private readonly chainHookInvoker: ChainHookInvoker,
    private readonly logger: { info: (s: string) => void; warn?: (s: string) => void } = console,
    options: ChainExecutorOptions = {},
  ) {
    this.limits = options.limits ?? DEFAULT_CHAIN_LIMITS;
    this.chainId = options.chainId ?? `chain-${process.pid}-${Date.now()}`;
    if (options.logger) {
      this.logger = options.logger;
    }
    this.stateStore = options.stateStore;
    this.escalationRouter = options.escalationRouter;
  }

  /** Effective resource limits in use. Visible for tests + telemetry. */
  getLimits(): ChainResourceLimits {
    return this.limits;
  }

  /** Stable chain id assigned at construction. */
  getChainId(): string {
    return this.chainId;
  }

  /**
   * Wrap a plugin invocation in a deadline timer (SPEC-022-2-01). Resolves
   * with the plugin output if it completes first, rejects with
   * `PluginTimeoutError` if the deadline fires first. The timer is
   * always cleared so no `setTimeout` handles leak.
   *
   * Timeout precedence: `produces[i].timeout_seconds` (per-declaration)
   * > `limits.per_plugin_timeout_seconds` (global). When a plugin produces
   * multiple artifacts with mixed overrides, the MINIMUM override wins
   * (strictest deadline).
   */
  protected async invokeWithTimeout(
    pid: string,
    manifest: HookManifest,
    ctx: ChainHookInvocationContext,
  ): Promise<ChainHookOutput[]> {
    const overrides = (manifest.produces ?? [])
      .map((p) => p.timeout_seconds)
      .filter((v): v is number => typeof v === 'number' && v > 0);
    const timeoutSeconds = overrides.length > 0
      ? Math.min(...overrides)
      : this.limits.per_plugin_timeout_seconds;
    const timeoutMs = timeoutSeconds * 1000;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new PluginTimeoutError(pid, timeoutMs, this.chainId)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([
        this.chainHookInvoker(pid, ctx),
        timeoutPromise,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Execute the chain rooted at `triggeringPluginId`. The triggering plugin
   * is assumed to have ALREADY produced its artifact (passed in as
   * `seedArtifact`). The executor validates + persists the seed, then
   * walks downstream consumers in topological order.
   */
  async executeChain(
    triggeringPluginId: string,
    state: RequestState,
    seedArtifact: { artifactType: string; scanId: string; payload: unknown },
  ): Promise<ChainExecutionResult> {
    // SPEC-022-2-02: chain-length pre-flight. The topological order is
    // computed once here; if it exceeds max_length, refuse before any plugin
    // is invoked. (When the trigger isn't in the graph the order is empty
    // and the check is a no-op.)
    let topoOrder: string[] = [];
    try {
      topoOrder = this.graph.topologicalSort();
    } catch {
      // CycleError or similar: defer to existing per-step handling. The
      // length check only fires on a successful topo sort.
      topoOrder = [];
    }
    if (topoOrder.length > this.limits.max_length) {
      throw new ChainTooLongError(topoOrder, this.limits.max_length);
    }

    // SPEC-022-2-02: concurrent-chain semaphore.
    if (ChainExecutor.activeChains >= this.limits.max_concurrent_chains) {
      throw new ConcurrentChainLimitError(
        ChainExecutor.activeChains,
        this.limits.max_concurrent_chains,
      );
    }
    ChainExecutor.activeChains += 1;
    try {
      return await this.runChainBody(triggeringPluginId, state, seedArtifact, topoOrder);
    } finally {
      ChainExecutor.activeChains -= 1;
    }
  }

  /** Original walk extracted into a private method so the semaphore wraps it. */
  private async runChainBody(
    triggeringPluginId: string,
    state: RequestState,
    seedArtifact: { artifactType: string; scanId: string; payload: unknown },
    precomputedOrder: string[],
  ): Promise<ChainExecutionResult> {
    const steps: ChainStep[] = [];
    const triggerManifest = this.manifestLookup(triggeringPluginId);
    const seedSchemaVersion = this.findProducerVersion(
      triggerManifest,
      seedArtifact.artifactType,
    );

    // Step 1: validate the seed.
    const validateStart = performance.now();
    const validation = this.artifacts.validate(
      seedArtifact.artifactType,
      seedSchemaVersion ?? '?',
      seedArtifact.payload,
    );
    if (!validation.isValid) {
      const seedStep: ChainStep = {
        pluginId: triggeringPluginId,
        consumed: [],
        produced: [],
        status: 'error',
        error: `seed artifact validation failed: ${validation.errors.map((e) => e.message).join('; ')}`,
        durationMs: performance.now() - validateStart,
      };
      steps.push(seedStep);
      this.logStep(triggeringPluginId, 'error', seedStep.durationMs, seedStep.error);
      return {
        triggeringPluginId,
        triggerScanId: seedArtifact.scanId,
        steps,
        ok: false,
        outcome: 'failed',
      };
    }

    // Step 2: persist the seed.
    let seedFilePath: string;
    try {
      const rec = await this.artifacts.persist(
        state.requestRoot,
        seedArtifact.artifactType,
        seedArtifact.scanId,
        seedArtifact.payload,
      );
      seedFilePath = rec.filePath;
    } catch (err) {
      const seedStep: ChainStep = {
        pluginId: triggeringPluginId,
        consumed: [],
        produced: [],
        status: 'error',
        error: `seed persist failed: ${(err as Error).message}`,
        durationMs: performance.now() - validateStart,
      };
      steps.push(seedStep);
      this.logStep(triggeringPluginId, 'error', seedStep.durationMs, seedStep.error);
      return {
        triggeringPluginId,
        triggerScanId: seedArtifact.scanId,
        steps,
        ok: false,
        outcome: 'failed',
      };
    }

    const seedStep: ChainStep = {
      pluginId: triggeringPluginId,
      consumed: [],
      produced: [
        {
          artifactType: seedArtifact.artifactType,
          scanId: seedArtifact.scanId,
          filePath: seedFilePath,
        },
      ],
      status: 'ok',
      durationMs: performance.now() - validateStart,
    };
    steps.push(seedStep);
    this.logStep(triggeringPluginId, 'ok', seedStep.durationMs);

    // Step 3: walk downstream in topological order.
    const order = precomputedOrder.length > 0
      ? precomputedOrder
      : this.graph.topologicalSort();
    const triggerIdx = order.indexOf(triggeringPluginId);
    const downstreamIds = triggerIdx === -1 ? [] : order.slice(triggerIdx + 1);

    /**
     * `producedIndex` maps artifact_type → most-recent { scanId, payload,
     * pluginId, schemaVersion } produced earlier in this run. The seed is
     * the first entry.
     */
    const producedIndex = new Map<
      string,
      { scanId: string; payload: unknown; pluginId: string; schemaVersion: string }
    >();
    producedIndex.set(seedArtifact.artifactType, {
      scanId: seedArtifact.scanId,
      payload: seedArtifact.payload,
      pluginId: triggeringPluginId,
      schemaVersion: seedSchemaVersion ?? '?',
    });

    /** Plugins whose own step failed; their downstream is skip-cascaded. */
    const failedSet = new Set<string>();
    /**
     * SPEC-022-2-02: track the resolved on_failure mode per failed producer
     * so the loop can short-circuit on `block` and ignore `ignore`-mode
     * failures from the skip-cascade.
     */
    const failureModes = new Map<string, ChainFailureMode>();
    /** Set true when any failed producer's mode is `block`; halts the loop. */
    let chainBlocked = false;
    let blockingProducer: string | null = null;

    for (const pid of downstreamIds) {
      // SPEC-022-2-02: if a prior failure had `block` mode, halt the
      // remaining downstream walk entirely (no further `skipped` steps).
      if (chainBlocked) {
        const step: ChainStep = {
          pluginId: pid,
          consumed: [],
          produced: [],
          status: 'skipped',
          error: `chain blocked by ${blockingProducer}`,
          durationMs: 0,
        };
        steps.push(step);
        this.logStep(pid, 'skipped', step.durationMs, step.error);
        continue;
      }

      const stepStart = performance.now();
      const manifest = this.manifestLookup(pid);
      if (!manifest) {
        const step: ChainStep = {
          pluginId: pid,
          consumed: [],
          produced: [],
          status: 'skipped',
          error: 'manifest not found',
          durationMs: performance.now() - stepStart,
        };
        steps.push(step);
        this.logStep(pid, 'skipped', step.durationMs, step.error);
        continue;
      }

      // Skip-cascade (SPEC-022-2-02): if any upstream plugin already failed
      // AND the resolved on_failure mode is `warn` (default), skip this
      // one. `ignore` continues to invoke; `block` was already handled.
      const upstreamFail = this.findUpstreamFailure(pid, failedSet);
      if (upstreamFail) {
        const mode = failureModes.get(upstreamFail) ?? 'warn';
        if (mode === 'warn') {
          const step: ChainStep = {
            pluginId: pid,
            consumed: [],
            produced: [],
            status: 'skipped',
            error: `upstream error in ${upstreamFail}`,
            durationMs: performance.now() - stepStart,
          };
          steps.push(step);
          this.logStep(pid, 'skipped', step.durationMs, step.error);
          continue;
        }
        // mode === 'ignore': fall through, attempt to satisfy consumes
        // from whatever IS available. If the missing artifact is required
        // the consumes-validation below records a separate skip.
      }

      // Resolve consumed artifacts. A plugin's consume is satisfied iff
      // some upstream producer in THIS run emitted a compatible version.
      const inputs: Record<string, unknown> = {};
      const consumed: Array<{ artifactType: string; scanId: string }> = [];
      const consumesList = manifest.consumes ?? [];
      let satisfied = consumesList.length === 0;
      let unsatisfiedType: string | null = null;
      for (const c of consumesList) {
        if (c.optional === true) {
          // Optional dep — pass through whatever is available, no error.
          const entry = producedIndex.get(c.artifact_type);
          if (entry && satisfiesRange(entry.schemaVersion, c.schema_version)) {
            inputs[c.artifact_type] = entry.payload;
            consumed.push({ artifactType: c.artifact_type, scanId: entry.scanId });
          }
          continue;
        }
        const entry = producedIndex.get(c.artifact_type);
        if (!entry || !satisfiesRange(entry.schemaVersion, c.schema_version)) {
          unsatisfiedType = c.artifact_type;
          break;
        }
        // Load the persisted artifact (round-trip through disk to catch
        // serialization regressions).
        let loadedPayload: unknown;
        try {
          loadedPayload = await this.artifacts.load(
            state.requestRoot,
            c.artifact_type,
            entry.scanId,
          );
        } catch (err) {
          unsatisfiedType = `${c.artifact_type} (load failed: ${(err as Error).message})`;
          break;
        }
        inputs[c.artifact_type] = loadedPayload;
        consumed.push({ artifactType: c.artifact_type, scanId: entry.scanId });
        satisfied = true;
      }

      if (!satisfied) {
        const step: ChainStep = {
          pluginId: pid,
          consumed: [],
          produced: [],
          status: 'skipped',
          error: `no upstream producer in this chain run for artifact_type ${unsatisfiedType}`,
          durationMs: performance.now() - stepStart,
        };
        steps.push(step);
        this.logStep(pid, 'skipped', step.durationMs, step.error);
        continue;
      }

      // Invoke the plugin's chain hook (SPEC-022-2-01: enforced timeout).
      let outputs: ChainHookOutput[];
      try {
        outputs = await this.invokeWithTimeout(pid, manifest, {
          requestState: state,
          inputs,
        });
      } catch (err) {
        failedSet.add(pid);
        const mode = this.resolveFailureMode(pid, manifest);
        failureModes.set(pid, mode);
        const step: ChainStep = {
          pluginId: pid,
          consumed,
          produced: [],
          status: 'error',
          error: `invocation threw: ${(err as Error).message}`,
          durationMs: performance.now() - stepStart,
        };
        steps.push(step);
        this.logStep(pid, 'error', step.durationMs, step.error);
        if (mode === 'block') {
          chainBlocked = true;
          blockingProducer = pid;
        }
        continue;
      }

      // Validate + persist each produced artifact.
      const produced: Array<{ artifactType: string; scanId: string; filePath: string }> = [];
      let producedError: string | null = null;
      for (const out of outputs) {
        const declared = (manifest.produces ?? []).find(
          (p) => p.artifact_type === out.artifactType,
        );
        if (!declared) {
          producedError = `plugin produced unexpected artifact_type '${out.artifactType}' (not declared in produces[])`;
          break;
        }
        const v = this.artifacts.validate(
          declared.artifact_type,
          declared.schema_version,
          out.payload,
        );
        if (!v.isValid) {
          producedError = `produced ${declared.artifact_type} failed validation: ${v.errors.map((e) => e.message).join('; ')}`;
          break;
        }
        let rec;
        try {
          rec = await this.artifacts.persist(
            state.requestRoot,
            declared.artifact_type,
            out.scanId,
            out.payload,
          );
        } catch (err) {
          producedError = `persist failed for ${declared.artifact_type}: ${(err as Error).message}`;
          break;
        }
        produced.push({
          artifactType: declared.artifact_type,
          scanId: out.scanId,
          filePath: rec.filePath,
        });
        producedIndex.set(declared.artifact_type, {
          scanId: out.scanId,
          payload: out.payload,
          pluginId: pid,
          schemaVersion: declared.schema_version,
        });
      }

      if (producedError) {
        failedSet.add(pid);
        const mode = this.resolveFailureMode(pid, manifest);
        failureModes.set(pid, mode);
        const step: ChainStep = {
          pluginId: pid,
          consumed,
          produced,
          status: 'error',
          error: producedError,
          durationMs: performance.now() - stepStart,
        };
        steps.push(step);
        this.logStep(pid, 'error', step.durationMs, step.error);
        if (mode === 'block') {
          chainBlocked = true;
          blockingProducer = pid;
        }
        continue;
      }

      const step: ChainStep = {
        pluginId: pid,
        consumed,
        produced,
        status: 'ok',
        durationMs: performance.now() - stepStart,
      };
      steps.push(step);
      this.logStep(pid, 'ok', step.durationMs);

      // SPEC-022-2-03: pause the chain when this plugin produced any
      // `requires_approval: true` artifact. The state file + escalation are
      // gated on `stateStore` being injected; without it the gate is a
      // no-op (back-compat with PLAN-022-1 callers + existing tests).
      const approvalArtifact = this.findApprovalGate(manifest, produced);
      if (approvalArtifact && this.stateStore) {
        const remainingOrder = downstreamIds.slice(
          downstreamIds.indexOf(pid) + 1,
        );
        const artifactsSoFar: ArtifactRef[] = steps
          .filter((s) => s.status === 'ok' || s.status === 'error')
          .flatMap((s) =>
            s.produced.map((p) => ({
              artifact_type: p.artifactType,
              scan_id: p.scanId,
            })),
          );
        const pausedState: ChainPausedState = {
          chain_id: this.chainId,
          paused_at_plugin: pid,
          paused_at_artifact: approvalArtifact.scanId,
          paused_at_artifact_type: approvalArtifact.artifactType,
          triggering_plugin: triggeringPluginId,
          remaining_order: remainingOrder,
          artifacts_so_far: artifactsSoFar,
          request_id: state.requestId,
          request_root: state.requestRoot,
          paused_timestamp_iso: new Date().toISOString(),
        };
        const statePath = StateStore.statePathFor(state.requestRoot, this.chainId);
        await this.stateStore.writeState(statePath, pausedState);
        if (this.escalationRouter) {
          try {
            await this.escalationRouter.notify({
              kind: 'chain-approval-pending',
              chain_id: pausedState.chain_id,
              artifact_id: pausedState.paused_at_artifact,
              artifact_type: pausedState.paused_at_artifact_type,
              paused_since: pausedState.paused_timestamp_iso,
              request_id: pausedState.request_id,
            });
          } catch (err) {
            this.logger.warn?.(
              `chain ${this.chainId}: escalation notify failed: ${(err as Error).message}`,
            );
          }
        }
        return {
          triggeringPluginId,
          triggerScanId: seedArtifact.scanId,
          steps,
          ok: true,
          outcome: 'paused',
          pausedState,
        };
      }
    }

    const ok = !steps.some((s) => s.status === 'error');
    return {
      triggeringPluginId,
      triggerScanId: seedArtifact.scanId,
      steps,
      ok,
      outcome: ok ? 'success' : 'failed',
    };
  }

  /**
   * SPEC-022-2-03: locate any artifact this plugin just produced that the
   * manifest declares `requires_approval: true`. Returns the first such
   * artifact (the executor pauses on the first approval gate it sees).
   */
  private findApprovalGate(
    manifest: HookManifest,
    produced: ReadonlyArray<{ artifactType: string; scanId: string; filePath: string }>,
  ): { artifactType: string; scanId: string } | null {
    if (!manifest.produces || produced.length === 0) return null;
    for (const out of produced) {
      const declared = manifest.produces.find(
        (p) => p.artifact_type === out.artifactType,
      );
      if (declared?.requires_approval === true) {
        return { artifactType: out.artifactType, scanId: out.scanId };
      }
    }
    return null;
  }

  /**
   * SPEC-022-2-03: stable accessor exposing the underlying StateStore so
   * the daemon-startup recovery routine and the `chains approve` CLI can
   * route state-file reads through the same instance the executor uses.
   */
  getStateStore(): StateStore | undefined {
    return this.stateStore;
  }

  /**
   * Resume a paused chain. Reads the persisted state, verifies an approval
   * marker exists for the paused-at artifact, walks the remaining
   * topological order, then deletes the state file on success.
   *
   * Throws:
   *   - `ChainStateMissingError` when no state file exists for `chainId`.
   *   - `ChainNotApprovedError` when the `.approved.json` marker is absent.
   *
   * The state file is left intact on `ChainNotApprovedError` so an operator
   * can subsequently approve and retry.
   */
  async resume(
    chainId: string,
    requestRoot: string,
  ): Promise<ChainExecutionResult> {
    if (!this.stateStore) {
      throw new ChainStateMissingError(chainId);
    }
    const statePath = StateStore.statePathFor(requestRoot, chainId);
    const persisted = await this.stateStore.readState(statePath);
    if (!persisted) {
      throw new ChainStateMissingError(chainId);
    }
    const approvedPath = StateStore.approvalMarkerPathFor(
      persisted.request_root,
      persisted.paused_at_artifact_type,
      persisted.paused_at_artifact,
    );
    const approved = await this.stateStore.fileExists(approvedPath);
    if (!approved) {
      throw new ChainNotApprovedError(chainId, persisted.paused_at_artifact);
    }
    const result = await this.runRemaining(persisted);
    // Cleanup on successful resume (ok or otherwise — the chain has had its
    // chance to complete; leftover state would be misleading).
    await this.stateStore.deleteState(statePath);
    return result;
  }

  /**
   * Walk the remaining topological order recorded on a paused-state
   * snapshot, loading every artifact-so-far from disk and re-using the
   * same per-step machinery as `runChainBody`. The walk does NOT re-invoke
   * the plugin that produced the approval-gate artifact — that work is
   * already persisted.
   */
  private async runRemaining(
    persisted: ChainPausedState,
  ): Promise<ChainExecutionResult> {
    const steps: ChainStep[] = [];
    // Rebuild producedIndex by reading every prior artifact off disk so
    // downstream consumers can be satisfied identically.
    const producedIndex = new Map<
      string,
      { scanId: string; payload: unknown; pluginId: string; schemaVersion: string }
    >();
    for (const ref of persisted.artifacts_so_far) {
      let payload: unknown;
      try {
        payload = await this.artifacts.load(
          persisted.request_root,
          ref.artifact_type,
          ref.scan_id,
        );
      } catch (err) {
        // If a prior artifact has been removed we can't safely resume.
        const failedStep: ChainStep = {
          pluginId: persisted.paused_at_plugin,
          consumed: [],
          produced: [],
          status: 'error',
          error: `resume failed: prior artifact ${ref.artifact_type}/${ref.scan_id} unreadable: ${(err as Error).message}`,
          durationMs: 0,
        };
        steps.push(failedStep);
        return {
          triggeringPluginId: persisted.triggering_plugin,
          steps,
          ok: false,
          outcome: 'failed',
        };
      }
      // Schema version is informational on resume; use '?' if the producer
      // declaration is no longer accessible. Range checks below tolerate it.
      const producerManifest = this.manifestLookup(persisted.paused_at_plugin);
      const declaredVersion = this.findProducerVersion(
        producerManifest,
        ref.artifact_type,
      );
      producedIndex.set(ref.artifact_type, {
        scanId: ref.scan_id,
        payload,
        pluginId: persisted.paused_at_plugin,
        schemaVersion: declaredVersion ?? '?',
      });
    }

    const state: RequestState = {
      requestRoot: persisted.request_root,
      requestId: persisted.request_id,
    };

    for (const pid of persisted.remaining_order) {
      const stepStart = performance.now();
      const manifest = this.manifestLookup(pid);
      if (!manifest) {
        const step: ChainStep = {
          pluginId: pid,
          consumed: [],
          produced: [],
          status: 'skipped',
          error: 'manifest not found',
          durationMs: performance.now() - stepStart,
        };
        steps.push(step);
        this.logStep(pid, 'skipped', step.durationMs, step.error);
        continue;
      }

      const inputs: Record<string, unknown> = {};
      const consumed: Array<{ artifactType: string; scanId: string }> = [];
      const consumesList = manifest.consumes ?? [];
      let satisfied = consumesList.length === 0;
      let unsatisfiedType: string | null = null;
      for (const c of consumesList) {
        const entry = producedIndex.get(c.artifact_type);
        if (c.optional === true) {
          if (entry && satisfiesRange(entry.schemaVersion, c.schema_version)) {
            inputs[c.artifact_type] = entry.payload;
            consumed.push({ artifactType: c.artifact_type, scanId: entry.scanId });
          }
          continue;
        }
        if (!entry || !satisfiesRange(entry.schemaVersion, c.schema_version)) {
          unsatisfiedType = c.artifact_type;
          break;
        }
        inputs[c.artifact_type] = entry.payload;
        consumed.push({ artifactType: c.artifact_type, scanId: entry.scanId });
        satisfied = true;
      }
      if (!satisfied) {
        const step: ChainStep = {
          pluginId: pid,
          consumed: [],
          produced: [],
          status: 'skipped',
          error: `no upstream producer in this chain run for artifact_type ${unsatisfiedType}`,
          durationMs: performance.now() - stepStart,
        };
        steps.push(step);
        this.logStep(pid, 'skipped', step.durationMs, step.error);
        continue;
      }

      let outputs: ChainHookOutput[];
      try {
        outputs = await this.invokeWithTimeout(pid, manifest, {
          requestState: state,
          inputs,
        });
      } catch (err) {
        const step: ChainStep = {
          pluginId: pid,
          consumed,
          produced: [],
          status: 'error',
          error: `invocation threw: ${(err as Error).message}`,
          durationMs: performance.now() - stepStart,
        };
        steps.push(step);
        this.logStep(pid, 'error', step.durationMs, step.error);
        continue;
      }

      const produced: Array<{ artifactType: string; scanId: string; filePath: string }> = [];
      let producedError: string | null = null;
      for (const out of outputs) {
        const declared = (manifest.produces ?? []).find(
          (p) => p.artifact_type === out.artifactType,
        );
        if (!declared) {
          producedError = `plugin produced unexpected artifact_type '${out.artifactType}' (not declared in produces[])`;
          break;
        }
        const v = this.artifacts.validate(
          declared.artifact_type,
          declared.schema_version,
          out.payload,
        );
        if (!v.isValid) {
          producedError = `produced ${declared.artifact_type} failed validation: ${v.errors.map((e) => e.message).join('; ')}`;
          break;
        }
        let rec;
        try {
          rec = await this.artifacts.persist(
            state.requestRoot,
            declared.artifact_type,
            out.scanId,
            out.payload,
          );
        } catch (err) {
          producedError = `persist failed for ${declared.artifact_type}: ${(err as Error).message}`;
          break;
        }
        produced.push({
          artifactType: declared.artifact_type,
          scanId: out.scanId,
          filePath: rec.filePath,
        });
        producedIndex.set(declared.artifact_type, {
          scanId: out.scanId,
          payload: out.payload,
          pluginId: pid,
          schemaVersion: declared.schema_version,
        });
      }
      if (producedError) {
        const step: ChainStep = {
          pluginId: pid,
          consumed,
          produced,
          status: 'error',
          error: producedError,
          durationMs: performance.now() - stepStart,
        };
        steps.push(step);
        this.logStep(pid, 'error', step.durationMs, step.error);
        continue;
      }
      const step: ChainStep = {
        pluginId: pid,
        consumed,
        produced,
        status: 'ok',
        durationMs: performance.now() - stepStart,
      };
      steps.push(step);
      this.logStep(pid, 'ok', step.durationMs);
    }

    const ok = !steps.some((s) => s.status === 'error');
    return {
      triggeringPluginId: persisted.triggering_plugin,
      steps,
      ok,
      outcome: ok ? 'success' : 'failed',
    };
  }

  /**
   * SPEC-022-2-02: resolve a failed producer's effective on_failure mode.
   *
   * Precedence (first non-empty wins):
   *   1. Any `produces[].on_failure` declared on the failed producer's manifest.
   *      If multiple `produces[]` entries declare different modes, the strictest
   *      wins (`block` > `warn` > `ignore`) — operators expect a single producer
   *      to honor its tightest declared contract.
   *   2. Any downstream consumer's `consumes[].on_failure` for an artifact this
   *      producer produced. Same strictness ordering across multiple consumers.
   *   3. Default `warn` (PLAN-022-1 behavior).
   */
  private resolveFailureMode(
    producerId: string,
    manifest: HookManifest,
  ): ChainFailureMode {
    const producesModes = (manifest.produces ?? [])
      .map((p) => p.on_failure)
      .filter((m): m is ChainFailureMode => m === 'block' || m === 'warn' || m === 'ignore');
    if (producesModes.length > 0) {
      return strictestFailureMode(producesModes);
    }
    // Fallback: scan downstream consumers in topological order.
    const producedTypes = new Set((manifest.produces ?? []).map((p) => p.artifact_type));
    if (producedTypes.size === 0) {
      return 'warn';
    }
    const order = (() => {
      try {
        return this.graph.topologicalSort();
      } catch {
        return [] as string[];
      }
    })();
    const producerIdx = order.indexOf(producerId);
    const downstream = producerIdx === -1 ? [] : order.slice(producerIdx + 1);
    const consumerModes: ChainFailureMode[] = [];
    for (const consumerId of downstream) {
      const m = this.manifestLookup(consumerId);
      if (!m || !m.consumes) continue;
      for (const c of m.consumes) {
        if (
          producedTypes.has(c.artifact_type) &&
          (c.on_failure === 'block' || c.on_failure === 'warn' || c.on_failure === 'ignore')
        ) {
          consumerModes.push(c.on_failure);
        }
      }
    }
    if (consumerModes.length > 0) {
      return strictestFailureMode(consumerModes);
    }
    return 'warn';
  }

  private findProducerVersion(
    manifest: HookManifest | undefined,
    artifactType: string,
  ): string | undefined {
    if (!manifest || !manifest.produces) return undefined;
    return manifest.produces.find((p) => p.artifact_type === artifactType)?.schema_version;
  }

  /**
   * Returns the id of the FIRST already-failed plugin upstream of `pid`
   * (BFS over the graph adjacency in reverse), or null if none.
   *
   * "Reachable from a failed plugin" is computed by running a forward BFS
   * from each failed plugin; we cache positive hits per call by simply
   * iterating failedSet in declaration order.
   */
  private findUpstreamFailure(
    pid: string,
    failedSet: ReadonlySet<string>,
  ): string | null {
    if (failedSet.size === 0) return null;
    // For each failed plugin, BFS forward; if we reach pid, return that
    // failed plugin's id. Cheap at expected scale.
    for (const f of failedSet) {
      if (this.isReachable(f, pid)) return f;
    }
    return null;
  }

  private isReachable(from: string, target: string): boolean {
    if (from === target) return false;
    const seen = new Set<string>();
    const queue: string[] = [from];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const succ = this.graphSuccessors(cur);
      for (const s of succ) {
        if (s === target) return true;
        if (!seen.has(s)) queue.push(s);
      }
    }
    return false;
  }

  private graphSuccessors(pluginId: string): string[] {
    // The graph exposes edges via getEdges(); pre-grouping per call is fine
    // for expected scale.
    return this.graph
      .getEdges()
      .filter((e) => e.from === pluginId)
      .map((e) => e.to);
  }

  private logStep(
    pid: string,
    status: 'ok' | 'error' | 'skipped',
    durationMs: number,
    reason?: string,
  ): void {
    const tail = reason ? `: ${reason}` : '';
    this.logger.info(
      `chain: ${pid} (${status}, ${durationMs.toFixed(2)}ms)${tail}`,
    );
  }
}
