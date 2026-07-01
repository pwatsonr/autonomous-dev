/**
 * Shared type definitions for the reviewer-chain pipeline (SPEC-020-2-02
 * + SPEC-020-2-03). Consumed by:
 *   - chain-resolver.ts  (loads ChainConfig, returns ReviewerEntry[])
 *   - scheduler.ts       (turns ReviewerEntry[] into ScheduledExecution)
 *   - runner.ts          (executes ScheduledExecution, returns ReviewerResult[])
 *   - aggregator.ts      (rolls ReviewerResult[] into a GateVerdict)
 *   - index.ts           (orchestrator + barrel)
 *
 * Path-mapping note: SPEC-020-2-02 documents this module at
 * `src/reviewers/types.ts`. The autonomous-dev plugin uses
 * `intake/reviewers/...` as the canonical home for runtime helpers
 * sibling to `intake/reviewers/{aggregate,frontend-detection}.ts`.
 *
 * @module intake/reviewers/types
 */

/**
 * Provenance of a reviewer.
 *   - `built-in`: PRD-004 first-party reviewer (e.g., code-reviewer,
 *     security-reviewer). At least one must complete with a non-error
 *     verdict for the gate to pass (TDD-019 §11.2 built-in-min rule).
 *   - `specialist`: PLAN-020-1 agent reviewer (e.g., qa-edge-case,
 *     ux-ui, accessibility, rule-set-enforcement).
 */
export type ReviewerType = 'built-in' | 'specialist';

/**
 * Conditional trigger gating a reviewer's invocation. Currently only
 * `frontend` is supported; the schema reserves the enum so future
 * triggers (e.g., `database`, `api`) can be added without re-validating
 * existing configs.
 */
export type ReviewerTrigger = 'frontend';

/**
 * One reviewer entry as it appears in a chain config (after schema
 * validation). Field semantics:
 *   - `name`: identifier used by the production InvokeReviewerFn lookup.
 *   - `type`: see `ReviewerType` above.
 *   - `blocking`: if true, a below-threshold or errored verdict fails
 *     the gate. If false, the verdict is logged as an advisory warning.
 *   - `threshold`: minimum integer score (0-100) required to satisfy
 *     a passing verdict.
 *   - `trigger`: optional — the reviewer is skipped entirely when the
 *     trigger does not match the current change set.
 *   - `enabled`: optional — defaults to true. The chain resolver filters
 *     out entries with `enabled: false` before returning.
 *   - `timeout_ms`: optional in config; the chain resolver guarantees a
 *     populated, clamped value on every entry it returns. Resolution
 *     precedence (highest first):
 *       1. entry.timeout_ms in the chain config
 *       2. request_types[<type>].gate_defaults?.[<gate>].timeout_ms
 *       3. config.defaults?.timeout_ms
 *       4. process.env.REVIEWER_TIMEOUT_MS (integer)
 *       5. Built-in default: 900_000 (15 min)
 *     Clamped to [30_000, 3_600_000].
 */
export interface ReviewerEntry {
  name: string;
  type: ReviewerType;
  blocking: boolean;
  threshold: number;
  trigger?: ReviewerTrigger;
  enabled?: boolean;
  timeout_ms?: number;
}

/**
 * Top-level chain defaults applied to all reviewers unless overridden
 * at a finer-grained level. (SPEC-REQ-000050)
 */
export interface ChainDefaults {
  /** Default subprocess timeout for all reviewers (ms). */
  timeout_ms?: number;
}

/**
 * Per-gate defaults that override the top-level `ChainDefaults` for a
 * specific gate. (SPEC-REQ-000050)
 */
export interface GateDefaults {
  timeout_ms?: number;
}

/**
 * Top-level chain config file shape (matches `reviewer-chains-v1.json`).
 *   - `version`: literal `1`. Future revisions ship a new schema file.
 *   - `defaults`: optional top-level timeout defaults. (SPEC-REQ-000050)
 *   - `request_types`: keyed by canonical request type
 *     (`feature|bug|infra|refactor|hotfix`); each value is a per-gate
 *     map (`code_review`, `pre_merge`, `post_deploy`, ...) to a
 *     declaration-ordered ReviewerEntry list. The optional `gate_defaults`
 *     sibling key inside each request-type block is config-only — the
 *     resolver MUST exclude it from gate-chain iteration.
 */
export interface ChainConfig {
  version: 1;
  defaults?: ChainDefaults;
  request_types: Record<
    string,
    Record<string, ReviewerEntry[]> & {
      gate_defaults?: Record<string, GateDefaults>;
    }
  >;
}

/**
 * Change-set context handed to every reviewer invocation. Built once
 * per gate run by the orchestrator (`runReviewGate` in SPEC-020-2-04).
 * `isFrontendChange` is pre-computed by the caller via
 * `detectFrontendChanges()` so the scheduler does not need to repeat
 * the (potentially I/O-heavy) detection.
 */
export interface ChangeSetContext {
  repoPath: string;
  changedFiles: string[];
  requestId: string;
  gate: string;
  requestType: string;
  isFrontendChange: boolean;
}

/**
 * One scheduled invocation: a (reviewer, context) pair to be passed to
 * the runner. Multiple invocations sharing a group run via Promise.all.
 */
export interface ReviewerInvocation {
  entry: ReviewerEntry;
  context: ChangeSetContext;
}

/**
 * Output of `ReviewerScheduler.schedule`. `groups` is an ordered list
 * of concurrency buckets: each inner array is run in parallel; group
 * N+1 does not start until group N has fully resolved.
 */
export interface ScheduledExecution {
  groups: ReviewerInvocation[][];
}

/**
 * Per-reviewer outcome captured by the runner (SPEC-020-2-03).
 *
 *   - `score === null` iff `verdict === 'ERROR'` — never substitute 0,
 *     which would falsely trip threshold checks.
 *   - `error_message` is present iff `verdict === 'ERROR'`.
 *   - `findings` is the raw `reviewer-finding-v1` payload (PLAN-020-1)
 *     when available; absent on errors or if the reviewer omits it.
 *   - `duration_ms` is wall-clock invocation time, captured even on
 *     error paths.
 *   - `raw_output` is populated IFF `verdict === 'ERROR'` AND the
 *     underlying cause was a parse failure (i.e., the dispatcher threw a
 *     `ReviewerParseError`). Truncated to 8192 UTF-8 characters with the
 *     suffix " … [truncated]" when the input exceeded the cap.
 *     (SPEC-REQ-000050)
 */
export type ReviewerVerdict = 'APPROVE' | 'REQUEST_CHANGES' | 'ERROR';

export interface ReviewerResult {
  reviewer_name: string;
  reviewer_type: ReviewerType;
  blocking: boolean;
  threshold: number;
  score: number | null;
  verdict: ReviewerVerdict;
  duration_ms: number;
  error_message?: string;
  findings?: object;
  raw_output?: string;
  /**
   * Categorical error type when verdict === 'ERROR'. Populated by the runner
   * to differentiate timeout vs. parse vs. nonzero-exit failures.
   * Used by self-heal detectors F2 and F4. (REQ-000056 TASK-010)
   */
  error_kind?: ReviewerErrorKind;
}

/**
 * Categorical error type when verdict === 'ERROR'. Used by the self-heal
 * detectors (F2, F4) to differentiate timeout vs. parse vs. nonzero-exit
 * failures. Absent when verdict !== 'ERROR'.
 * (REQ-000056 TASK-010)
 */
export type ReviewerErrorKind = 'reviewer_timeout' | 'bad_json' | 'cli_nonzero';

/** Final outcome of a gate (no `ERROR` — that is captured per-reviewer). */
export type GateOutcome = 'APPROVE' | 'REQUEST_CHANGES';

/**
 * Output of the aggregator (SPEC-020-2-03). Written verbatim to the
 * gate-output file at `<stateDir>/gates/<gate>.json`.
 *
 *   - `outcome`: the gate decision (APPROVE | REQUEST_CHANGES).
 *   - `reason`: human-readable explanation, especially on failure.
 *   - `per_reviewer`: full pass-through of the runner's results, in
 *     flattened chain order.
 *   - `warnings`: advisory-below-threshold strings. Always an array
 *     (possibly empty). Does not affect `outcome`.
 *   - `built_in_count_completed`: count of built-in reviewers that
 *     produced a non-error verdict. Used to verify the built-in-min
 *     rule from TDD-019 §11.2.
 */
export interface GateVerdict {
  gate: string;
  request_id: string;
  outcome: GateOutcome;
  reason: string;
  per_reviewer: ReviewerResult[];
  warnings: string[];
  built_in_count_completed: number;
}
