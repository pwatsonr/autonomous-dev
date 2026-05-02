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
import type { HookManifest } from '../hooks/types';
import { satisfiesRange } from '../hooks/semver-compat';
import { PluginTimeoutError } from './errors';

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

export interface ChainExecutionResult {
  triggeringPluginId: string;
  /** Initial scan id of the triggering plugin's emitted artifact. */
  triggerScanId?: string;
  /** Steps in execution order (producers before consumers). */
  steps: ChainStep[];
  /** True iff every step is 'ok' or 'skipped' (skips are not errors). */
  ok: boolean;
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
  private readonly limits: ChainResourceLimits;
  private readonly chainId: string;
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
    const order = this.graph.topologicalSort();
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

    for (const pid of downstreamIds) {
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

      // Skip-cascade: if any upstream plugin (in graph.adj reachability)
      // already failed, skip this one.
      const upstreamFail = this.findUpstreamFailure(pid, failedSet);
      if (upstreamFail) {
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
      triggeringPluginId,
      triggerScanId: seedArtifact.scanId,
      steps,
      ok,
    };
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
