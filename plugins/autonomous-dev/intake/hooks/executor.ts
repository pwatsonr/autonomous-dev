/**
 * HookExecutor — sequential hook executor with validation gating
 * (SPEC-019-1-03 + SPEC-019-2-04).
 *
 * Walks the registry snapshot for a given HookPoint and invokes each hook's
 * entry-point function. Each invocation is wrapped by ValidationPipeline:
 *
 *   1. Input is validated; failure SKIPS the hook (status:'skipped-invalid-input').
 *   2. Hook receives the sanitized input (defaults applied, extras stripped).
 *   3. Output is validated; failure returns the sanitized payload with a warning
 *      (status:'success-with-warnings'). Caller never sees the raw hook output.
 *   4. A throw becomes status:'invocation-error' — categorically distinct from
 *      validation failures.
 *
 * Skipped or invocation-errored hooks NEVER prevent later hooks at the same
 * point from running.
 *
 * Per PLAN-019-2 risk register, the failure-mode policy here ("skip on
 * input-fail, sanitize on output-fail") is provisional; PLAN-019-4 replaces
 * it with the configurable block/warn/ignore matrix from the manifest.
 *
 * @module intake/hooks/executor
 */

import { performance } from 'node:perf_hooks';
import type {
  HookPoint,
  ExecutorWarning,
  ValidationError,
  HookContext,
  HookResult,
  ChainedHookExecutionResult,
  FailureModeStr,
} from './types';
import { FailureMode } from './types';
import type { RegisteredHook, RegistrySnapshot } from './registry';
import type { ValidationPipeline } from './validation-pipeline';
import { SchemaNotFoundError } from './validation-pipeline';
import type { TrustValidator } from './trust-validator';
import type { TrustAuditEmitter } from './audit-emitter';
import { HookBlockedError } from './errors';

/** Per-invocation status. SPEC-019-2-04 §"HookExecutionResult Shape". */
export type HookInvocationStatus =
  | 'ok'                       // back-compat alias for 'success'
  | 'success'                  // ran cleanly, output validated
  | 'success-with-warnings'    // ran, output had to be sanitized
  | 'skipped-invalid-input'    // input failed validation, hook never ran
  | 'skipped-trust-revoked'    // SPEC-019-3-04: trust revoked since last reload
  | 'invocation-error'         // hook threw at runtime
  | 'error';                   // back-compat alias for 'invocation-error'

/** Outcome of one hook invocation. */
export interface HookInvocationOutcome {
  pluginId: string;
  hookId: string;
  /** Lifecycle status; see HookInvocationStatus. */
  status: HookInvocationStatus;
  /** Hook return value (sanitized when validation ran). */
  result?: unknown;
  /** Thrown error message (when status is 'invocation-error'). */
  error?: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Validation errors (input or output) if any. */
  validationErrors?: ValidationError[];
  /** Non-fatal warnings (e.g. fallback version). */
  warnings?: ExecutorWarning[];
}

/** Aggregate result of executing every hook for one HookPoint. */
export interface HookExecutionResult {
  point: HookPoint;
  invocations: HookInvocationOutcome[];
}

/**
 * Provider returning the active registry snapshot. Indirection so
 * SPEC-019-1-04's reload swap is invisible to long-lived executor instances.
 */
export type SnapshotProvider = () => RegistrySnapshot;

/** Default schema version used when a hook entry doesn't pin its own. */
const DEFAULT_SCHEMA_VERSION = '1.0.0';

export class HookExecutor {
  /**
   * Construct an executor.
   *
   * @param snapshotProvider supplies the active registry snapshot per call.
   * @param pipeline optional ValidationPipeline. When omitted, hooks run
   *   with no input/output validation (SPEC-019-1 back-compat). When
   *   provided, every invocation is gated per SPEC-019-2-04.
   * @param trustValidator optional TrustValidator. When provided, every
   *   invocation calls `isTrusted(pluginId)` (SPEC-019-3-04). A `false`
   *   result skips the hook with status `skipped-trust-revoked` and emits
   *   a `runtime-revoked` audit entry (when an emitter is wired). When
   *   omitted, no runtime trust check is performed (SPEC-019-1/2 back-compat).
   * @param auditEmitter optional TrustAuditEmitter for `runtime-revoked`
   *   entries. Only used when `trustValidator` is also provided.
   */
  constructor(
    private readonly snapshotProvider: SnapshotProvider,
    private readonly pipeline?: ValidationPipeline,
    private readonly trustValidator?: TrustValidator,
    private readonly auditEmitter?: TrustAuditEmitter,
  ) {}

  /**
   * Execute every hook registered for `point`, in priority order.
   *
   * Snapshot is captured once at the START of the call. A reload mid-execution
   * does not affect the in-flight call. Hooks run sequentially (no Promise.all).
   * Failures are caught and recorded; iteration always continues.
   */
  async executeHooks(point: HookPoint, context: unknown): Promise<HookExecutionResult> {
    const snapshot = this.snapshotProvider();
    const hooks = snapshot.get(point) ?? [];
    const invocations: HookInvocationOutcome[] = [];

    if (hooks.length === 0) {
      // eslint-disable-next-line no-console
      console.debug(`executor: ${point} -> no hooks registered`);
      return { point, invocations };
    }

    for (const hook of hooks) {
      const outcome = await this.invokeOne(hook, point, context);
      invocations.push(outcome);
      // eslint-disable-next-line no-console
      console.info(
        `executor: ${point} ${hook.pluginId}/${hook.hook.id} -> ${outcome.status} (${outcome.durationMs.toFixed(2)}ms)`,
      );
      if (outcome.status === 'error' || outcome.status === 'invocation-error') {
        // eslint-disable-next-line no-console
        console.warn(`executor: ${point} ${hook.pluginId}/${hook.hook.id} error: ${outcome.error}`);
      } else if (outcome.status === 'skipped-invalid-input') {
        // eslint-disable-next-line no-console
        console.warn(
          `executor: ${point} ${hook.pluginId}/${hook.hook.id} skipped — input validation failed: ${JSON.stringify(outcome.validationErrors)}`,
        );
      } else if (outcome.status === 'skipped-trust-revoked') {
        // eslint-disable-next-line no-console
        console.warn(
          `executor: ${point} ${hook.pluginId}/${hook.hook.id} skipped — trust revoked since last reload`,
        );
      } else if (outcome.status === 'success-with-warnings') {
        // eslint-disable-next-line no-console
        console.warn(
          `executor: ${point} ${hook.pluginId}/${hook.hook.id} produced invalid output. Returning sanitized payload. Errors: ${JSON.stringify(outcome.validationErrors)}`,
        );
      }
    }

    return { point, invocations };
  }

  /**
   * Invoke a single hook. Catches both sync throws and async rejections.
   * Accepts entry-points exporting a function directly, an object with
   * `.default`, or a CommonJS `module.exports` function.
   */
  private async invokeOne(
    hook: RegisteredHook,
    point: HookPoint,
    context: unknown,
  ): Promise<HookInvocationOutcome> {
    const start = performance.now();
    const warnings: ExecutorWarning[] = [];
    const schemaVersion = this.resolveSchemaVersion(hook);

    // --- 0. Runtime trust check (SPEC-019-3-04) ---
    // O(1) set lookup; runs before any validation or invocation. Catches
    // operator revocations between SIGUSR1 reloads. The audit emission
    // happens here (not in TrustValidator) because the executor is the
    // only layer that knows the hook point.
    if (this.trustValidator && !this.trustValidator.isTrusted(hook.pluginId)) {
      if (this.auditEmitter) {
        this.auditEmitter.emit({
          decision: 'runtime-revoked',
          pluginId: hook.pluginId,
          pluginVersion: hook.pluginVersion,
          hookPoint: point,
          reason: 'trust revoked since last reload',
          timestamp: new Date().toISOString(),
        });
      }
      return {
        pluginId: hook.pluginId,
        hookId: hook.hook.id,
        status: 'skipped-trust-revoked',
        warnings,
        durationMs: performance.now() - start,
      };
    }

    // --- 1. Input validation (gates execution) ---
    let invokeInput: unknown = context;
    if (this.pipeline) {
      try {
        const inputResult = await this.pipeline.validateHookInput(point, schemaVersion, context);
        for (const w of inputResult.warnings) {
          warnings.push({
            pluginId: hook.pluginId,
            hookId: hook.hook.id,
            point,
            direction: 'input',
            message: w,
          });
        }
        if (!inputResult.isValid) {
          return {
            pluginId: hook.pluginId,
            hookId: hook.hook.id,
            status: 'skipped-invalid-input',
            validationErrors: inputResult.errors,
            warnings,
            durationMs: performance.now() - start,
          };
        }
        invokeInput = inputResult.sanitizedOutput;
      } catch (err) {
        // SchemaNotFoundError or other unexpected validation failure: surface
        // as invocation-error so operators can spot misconfiguration. Do not
        // skip silently.
        if (err instanceof SchemaNotFoundError) {
          return {
            pluginId: hook.pluginId,
            hookId: hook.hook.id,
            status: 'invocation-error',
            error: err.message,
            warnings,
            durationMs: performance.now() - start,
          };
        }
        throw err;
      }
    }

    // --- 2. Invoke hook ---
    let rawOutput: unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
      const mod = require(hook.resolvedEntryPoint);
      const fn = typeof mod === 'function' ? mod : (mod && mod.default) ?? mod;
      if (typeof fn !== 'function') {
        throw new Error(`entry-point is not a function: ${hook.resolvedEntryPoint}`);
      }
      rawOutput = await Promise.resolve(fn(invokeInput));
    } catch (err) {
      return {
        pluginId: hook.pluginId,
        hookId: hook.hook.id,
        status: 'invocation-error',
        error: (err as Error).message,
        warnings,
        durationMs: performance.now() - start,
      };
    }

    // --- 3. Output validation (sanitizes; does not block) ---
    if (this.pipeline) {
      try {
        const outputResult = await this.pipeline.validateHookOutput(point, schemaVersion, rawOutput);
        for (const w of outputResult.warnings) {
          warnings.push({
            pluginId: hook.pluginId,
            hookId: hook.hook.id,
            point,
            direction: 'output',
            message: w,
          });
        }
        return {
          pluginId: hook.pluginId,
          hookId: hook.hook.id,
          status: outputResult.isValid ? 'success' : 'success-with-warnings',
          result: outputResult.sanitizedOutput,
          validationErrors: outputResult.errors,
          warnings,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        if (err instanceof SchemaNotFoundError) {
          return {
            pluginId: hook.pluginId,
            hookId: hook.hook.id,
            status: 'invocation-error',
            error: err.message,
            warnings,
            durationMs: performance.now() - start,
          };
        }
        throw err;
      }
    }

    // No pipeline: pass raw output through with the legacy 'ok' status.
    return {
      pluginId: hook.pluginId,
      hookId: hook.hook.id,
      status: 'ok',
      result: rawOutput,
      durationMs: performance.now() - start,
    };
  }

  /**
   * Pick the schema version to validate against. PLAN-019-1's HookEntry
   * does not yet declare a schema version — we default to `'1.0.0'` and
   * defer per-hook version pinning to a later plan.
   */
  private resolveSchemaVersion(_hook: RegisteredHook): string {
    return DEFAULT_SCHEMA_VERSION;
  }

  // ---------------------------------------------------------------------------
  // SPEC-019-4-03: Sequential execution with chained context + failure modes
  // ---------------------------------------------------------------------------

  /**
   * Execute every hook for `point` in priority order, threading the
   * cumulative `previousResults` through each invocation as a `HookContext`.
   *
   * Differences vs. `executeHooks`:
   *
   *   - Hooks receive a SECOND argument of shape `{originalContext,
   *     previousResults}`. The first argument is still the raw input for
   *     PLAN-019-1 hook author back-compat.
   *   - The hook entry's `failure_mode` selects the failure policy:
   *       `block`  — throws `HookBlockedError`; subsequent hooks are NOT run.
   *       `warn`   — logs at WARN level via `log`; iteration continues.
   *       `ignore` — silently skipped; iteration continues.
   *   - The aggregated return shape is `{hook_point, results, failures,
   *     aborted}` with `failures = results.filter(r => r.error !== undefined)`.
   *
   * The `block` branch is the ONLY branch that throws. Callers (the daemon)
   * MUST wrap this method in try/catch and translate `HookBlockedError` into
   * a request-level escalation per TDD-009. The executor never catches its
   * own throws once raised — propagation is the daemon's contract.
   *
   * Cross-reference: SPEC-019-4-03 algorithm; TDD-019 §12.1.
   */
  async executeHooksChained<O = unknown, I = unknown>(
    point: HookPoint,
    originalContext: I,
    log?: (
      level: 'warn' | 'info',
      msg: string,
      meta: Record<string, unknown>,
    ) => void,
  ): Promise<ChainedHookExecutionResult<O>> {
    const snapshot = this.snapshotProvider();
    // The registry already keeps lists sorted descending by priority with
    // stable insertion-order tiebreaks; respect that ordering verbatim.
    const hooks = snapshot.get(point) ?? [];

    if (hooks.length === 0) {
      return { hook_point: point, results: [], failures: [], aborted: false };
    }

    const results: HookResult<O>[] = [];
    const failures: HookResult<O>[] = [];

    for (const hook of hooks) {
      // Defensive copy on EACH iteration so a hook's attempt to mutate the
      // array (e.g. `(ctx.previousResults as any[]).push(...)`) cannot leak
      // into the next iteration's view.
      const context: HookContext<I> = {
        originalContext,
        previousResults: [...results] as ReadonlyArray<HookResult>,
      };

      const failureMode = this.resolveFailureMode(hook);
      const start = performance.now();
      let output: O | undefined;
      let caught: unknown;

      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
        const mod = require(hook.resolvedEntryPoint);
        const fn = typeof mod === 'function' ? mod : (mod && mod.default) ?? mod;
        if (typeof fn !== 'function') {
          throw new Error(`entry-point is not a function: ${hook.resolvedEntryPoint}`);
        }
        // First arg: raw originalContext for back-compat with PLAN-019-1
        // hooks (they expect the bare input). Second arg: HookContext for
        // chained-aware hook authors (PLAN-019-4+).
        output = (await Promise.resolve(fn(originalContext, context))) as O;
      } catch (err) {
        caught = err;
      }

      const duration_ms = performance.now() - start;

      if (caught === undefined) {
        results.push({
          plugin_id: hook.pluginId,
          plugin_version: hook.pluginVersion,
          hook_id: hook.hook.id,
          priority: hook.hook.priority,
          output,
          duration_ms,
        });
        continue;
      }

      const err = caught as Error;
      const failingResult: HookResult<O> = {
        plugin_id: hook.pluginId,
        plugin_version: hook.pluginVersion,
        hook_id: hook.hook.id,
        priority: hook.hook.priority,
        error: {
          message: err.message ?? String(err),
          stack: err.stack,
          failure_mode: failureMode,
        },
        duration_ms,
      };

      if (failureMode === 'block') {
        // Record the failing result so callers tracing logs see it, then
        // throw. Subsequent hooks are NOT invoked.
        results.push(failingResult);
        throw new HookBlockedError(failingResult);
      }

      // warn / ignore: continue iteration; record in both results and failures.
      results.push(failingResult);
      failures.push(failingResult);

      if (failureMode === 'warn' && log) {
        log('warn', 'hook-failure', {
          plugin_id: hook.pluginId,
          hook_id: hook.hook.id,
          error: failingResult.error,
        });
      }
      // 'ignore' is intentionally silent — no log emission.
    }

    return { hook_point: point, results, failures, aborted: false };
  }

  /**
   * Coerce the manifest `failure_mode` (which may be the `FailureMode` enum
   * value or its bare string form) into the canonical string-literal type
   * used by `HookResult.error.failure_mode`.
   */
  private resolveFailureMode(hook: RegisteredHook): FailureModeStr {
    const mode = hook.hook.failure_mode as FailureMode | FailureModeStr | undefined;
    if (mode === FailureMode.Block || mode === 'block') return 'block';
    if (mode === FailureMode.Warn || mode === 'warn') return 'warn';
    if (mode === FailureMode.Ignore || mode === 'ignore') return 'ignore';
    // PLAN-019-4 manifests are required to declare failure_mode; if missing
    // we default to 'warn' (the safest non-aborting choice) rather than
    // silently 'ignore' which would suppress operator-visible failures.
    return 'warn';
  }
}
