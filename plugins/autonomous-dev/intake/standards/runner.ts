/**
 * runEvaluator orchestrator (SPEC-021-2-04, Task 9).
 *
 * Single entry point any consumer (rule-set-enforcement-reviewer, future
 * plans) calls to evaluate a rule. Looks up the rule's `evaluator` name in
 * the EvaluatorRegistry, dispatches to the in-process built-in handler OR
 * the custom-evaluator subprocess sandbox, wraps any thrown error as
 * `EvaluatorRunError(rule.id, cause)` so callers can attribute regressions
 * back to the offending rule, injects `rule_id` into every finding, and
 * stamps `duration_ms`.
 *
 * The orchestrator does NOT swallow errors — `EvaluatorNotFoundError`,
 * `SecurityError`, `SandboxTimeoutError`, `SandboxMemoryError` all become
 * `EvaluatorRunError` with the original error preserved as `.cause`.
 *
 * @module intake/standards/runner
 */

import type { Rule } from './types';
import type { EvaluatorRegistry } from './evaluator-registry';
import { runCustomEvaluator } from './sandbox';
import { EvaluatorRunError } from './errors';
import type {
  EvaluatorContext,
  EvaluatorResult,
  Finding,
} from './evaluators/types';

export interface EvaluatorRunOptions {
  registry: EvaluatorRegistry;
  /** Absolute paths the operator allows for custom evaluator dispatch. */
  allowlist: string[];
  ctx: EvaluatorContext;
}

export async function runEvaluator(
  rule: Rule,
  filePaths: string[],
  opts: EvaluatorRunOptions,
): Promise<EvaluatorResult> {
  const start = Date.now();
  // Use the rule's `requires` block as the args envelope when present, since
  // PLAN-021-1's Rule type carries assertion args under `requires` rather
  // than a free-form `args` field. Custom evaluators receive the same
  // envelope so plugin authors don't have to learn a separate shape.
  const args: Record<string, unknown> = (rule.requires ?? {}) as unknown as Record<
    string,
    unknown
  >;

  let result: EvaluatorResult;
  try {
    const entry = opts.registry.get(rule.evaluator);
    if (entry.kind === 'builtin') {
      result = await entry.handler(filePaths, args, opts.ctx);
    } else {
      result = await runCustomEvaluator(entry.absolutePath, filePaths, args, {
        allowlist: opts.allowlist,
      });
    }
  } catch (err) {
    throw new EvaluatorRunError(rule.id, err as Error);
  }

  const findings: Finding[] = result.findings.map((f) => ({
    ...f,
    rule_id: rule.id,
  }));
  return {
    passed: result.passed,
    findings,
    duration_ms: Date.now() - start,
  };
}
