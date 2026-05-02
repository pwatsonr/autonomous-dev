/**
 * Shared types for built-in standards evaluators (SPEC-021-2-01).
 *
 * Every evaluator (built-in or custom) returns an `EvaluatorResult` shaped
 * `{passed, findings[]}`. Findings carry a severity + 1-based line number;
 * `rule_id` is injected by the orchestrator (`runEvaluator` in
 * SPEC-021-2-04), not by individual evaluators.
 *
 * Built-in evaluators conform to `BuiltinEvaluator`: an async function
 * taking `(filePaths, args, ctx)` and returning a Promise<EvaluatorResult>.
 * The `async` shape is uniform even when the evaluator performs no I/O so
 * the registry/runner can dispatch built-ins and custom subprocess
 * evaluators behind the same Promise-returning interface.
 *
 * @module intake/standards/evaluators/types
 */

/** Severity matches PLAN-021-2 evaluator finding contract (TDD-021 §7). */
export type FindingSeverity = 'critical' | 'major' | 'minor' | 'info';

/**
 * A single finding emitted by an evaluator.
 *
 * `line: 0` is reserved for "no specific line" (e.g., missing manifest); all
 * other findings use 1-based line numbers.
 *
 * `rule_id` is OPTIONAL on the evaluator side — the orchestrator injects it
 * before returning the result to its caller.
 */
export interface Finding {
  file: string;
  line: number;
  severity: FindingSeverity;
  message: string;
  rule_id?: string;
}

/**
 * Aggregate evaluator result.
 *
 * `duration_ms` is populated by the orchestrator (`runEvaluator`), not the
 * evaluator itself.
 */
export interface EvaluatorResult {
  passed: boolean;
  findings: Finding[];
  duration_ms?: number;
}

/**
 * Read-only context handed to every evaluator.
 *
 * `workspaceRoot` is the absolute path the evaluator MUST resolve relative
 * file references against (manifests, fixture inputs, etc.).
 */
export interface EvaluatorContext {
  workspaceRoot: string;
}

/**
 * Built-in evaluator function signature.
 *
 * - `filePaths` are repository-relative or absolute (caller decides). Absolute
 *   paths are used as-is; relative paths are resolved against
 *   `ctx.workspaceRoot`.
 * - `args` are the per-rule arguments (e.g. `{framework_match: "fastapi"}`).
 *   The evaluator interprets only the keys it understands; unknown keys are
 *   ignored without warning.
 * - `ctx` carries workspace-scoped context.
 */
export type BuiltinEvaluator = (
  filePaths: string[],
  args: Record<string, unknown>,
  ctx: EvaluatorContext,
) => Promise<EvaluatorResult>;
