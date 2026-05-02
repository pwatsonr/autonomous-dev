/**
 * HookExecutor — sequential happy-path executor for registered hooks
 * (SPEC-019-1-03, Task 5).
 *
 * Walks the registry snapshot for a given HookPoint and invokes each hook's
 * entry-point function. PLAN-019-1 is "fail open": every thrown / rejected
 * hook is caught and recorded, iteration continues. PLAN-019-4 introduces
 * failure-mode gating that turns `block`-mode failures into a halt.
 *
 * Module cache is honored — repeat invocations don't re-read disk.
 * `require.cache` is intentionally NOT invalidated on reload in this plan.
 *
 * @module intake/hooks/executor
 */

import { performance } from 'node:perf_hooks';
import type { HookPoint } from './types';
import type { RegisteredHook, RegistrySnapshot } from './registry';

/** Outcome of one hook invocation. */
export interface HookInvocationOutcome {
  pluginId: string;
  hookId: string;
  /** `'ok'` if the hook returned, `'error'` if it threw. */
  status: 'ok' | 'error';
  /** Hook return value (when status='ok'). */
  result?: unknown;
  /** Thrown error message (when status='error'). */
  error?: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
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

export class HookExecutor {
  constructor(private readonly snapshotProvider: SnapshotProvider) {}

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
      const outcome = await this.invokeOne(hook, context);
      invocations.push(outcome);
      // eslint-disable-next-line no-console
      console.info(
        `executor: ${point} ${hook.pluginId}/${hook.hook.id} -> ${outcome.status} (${outcome.durationMs.toFixed(2)}ms)`,
      );
      if (outcome.status === 'error') {
        // eslint-disable-next-line no-console
        console.warn(`executor: ${point} ${hook.pluginId}/${hook.hook.id} error: ${outcome.error}`);
      }
    }

    return { point, invocations };
  }

  /**
   * Invoke a single hook. Catches both sync throws and async rejections.
   * Accepts entry-points exporting a function directly, an object with
   * `.default`, or a CommonJS `module.exports` function.
   */
  private async invokeOne(hook: RegisteredHook, context: unknown): Promise<HookInvocationOutcome> {
    const start = performance.now();
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
      const mod = require(hook.resolvedEntryPoint);
      const fn = typeof mod === 'function' ? mod : (mod && mod.default) ?? mod;
      if (typeof fn !== 'function') {
        throw new Error(`entry-point is not a function: ${hook.resolvedEntryPoint}`);
      }
      const result = await Promise.resolve(fn(context));
      return {
        pluginId: hook.pluginId,
        hookId: hook.hook.id,
        status: 'ok',
        result,
        durationMs: performance.now() - start,
      };
    } catch (err) {
      return {
        pluginId: hook.pluginId,
        hookId: hook.hook.id,
        status: 'error',
        error: (err as Error).message,
        durationMs: performance.now() - start,
      };
    }
  }
}
