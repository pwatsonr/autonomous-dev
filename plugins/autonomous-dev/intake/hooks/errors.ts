/**
 * Hook-engine error classes (SPEC-019-4-03, Task 6).
 *
 * `HookBlockedError` is thrown by the chained-context executor variant when
 * a `block`-mode hook fails. It carries the failing `HookResult` so the
 * daemon can serialize the failing hook's identity directly into an
 * escalation payload (per TDD-009) without re-deriving it from logs.
 *
 * The executor itself never catches `HookBlockedError` — propagation is
 * the daemon's responsibility. This keeps the executor's contract narrow
 * and unit-testable in isolation.
 *
 * @module intake/hooks/errors
 */

import type { HookResult } from './types';

/**
 * Thrown by `HookExecutor.executeHooksChained` when a `block`-mode hook
 * fails. The embedded `hookResult` describes the failing hook (identity,
 * priority, error, duration). All hooks ordered AFTER the failing one are
 * skipped — this is the contractual difference vs. `warn`/`ignore` modes.
 *
 * Cross-reference: SPEC-019-4-03 acceptance criteria; TDD-019 §12.1.
 */
export class HookBlockedError extends Error {
  readonly hookResult: HookResult;

  constructor(hookResult: HookResult) {
    super(
      `Hook ${hookResult.plugin_id}:${hookResult.hook_id} blocked execution: ${hookResult.error?.message ?? 'unknown error'}`,
    );
    this.name = 'HookBlockedError';
    this.hookResult = hookResult;
  }
}
