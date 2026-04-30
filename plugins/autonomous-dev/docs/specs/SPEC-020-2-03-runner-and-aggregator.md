# SPEC-020-2-03: Reviewer Invocation Runner + ScoreAggregator

## Metadata
- **Parent Plan**: PLAN-020-2
- **Tasks Covered**: Task 5 (reviewer invocation runner with concurrent execution + error handling), Task 6 (`ScoreAggregator` enforcing built-in-min rule + threshold semantics)
- **Estimated effort**: 6 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-020-2-03-runner-and-aggregator.md`

## Description
Implement the two execution components that turn a `ScheduledExecution` plan into a final gate verdict: (1) `runner.ts` consumes the scheduler's output and runs each group via `Promise.all`, capturing verdicts/durations/errors per reviewer without crashing on individual failures; (2) `aggregator.ts` consumes the runner's results and applies the TDD-019 §11.2 rules — at least one built-in reviewer must produce a non-error verdict, blocking reviewers below threshold fail the gate, advisory reviewers below threshold log warnings only.

The runner depends on a pluggable `invokeReviewer(entry, context)` function (injected for testability — production wires it to the real Claude Agent SDK invocation; tests inject mocks with deterministic delays/outcomes). The aggregator is pure logic with no I/O.

Telemetry emission is wired in SPEC-020-2-04 (Task 9 of the plan); this spec leaves the hook in place but does not implement the metrics-pipeline call.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/reviewers/runner.ts` | Create | Group executor with `Promise.all` and error capture |
| `plugins/autonomous-dev/src/reviewers/aggregator.ts` | Create | `ScoreAggregator` enforcing built-in-min + thresholds |
| `plugins/autonomous-dev/src/reviewers/types.ts` | Modify | Add `ReviewerResult`, `GateVerdict` types |

## Implementation Details

### Type Additions (`types.ts`)

```typescript
export type ReviewerVerdict = 'APPROVE' | 'REQUEST_CHANGES' | 'ERROR';

export interface ReviewerResult {
  reviewer_name: string;
  reviewer_type: ReviewerType;
  blocking: boolean;
  threshold: number;
  score: number | null;       // null when verdict === 'ERROR'
  verdict: ReviewerVerdict;
  duration_ms: number;
  error_message?: string;     // present when verdict === 'ERROR'
  findings?: object;          // raw reviewer-finding-v1 payload (PLAN-020-1)
}

export type GateOutcome = 'APPROVE' | 'REQUEST_CHANGES';

export interface GateVerdict {
  gate: string;
  request_id: string;
  outcome: GateOutcome;
  reason: string;             // human-readable explanation, especially for failures
  per_reviewer: ReviewerResult[];
  warnings: string[];         // advisory-below-threshold messages
  built_in_count_completed: number;
}
```

### Runner (`runner.ts`)

API surface:

```typescript
export type InvokeReviewerFn = (
  entry: ReviewerEntry,
  context: ChangeSetContext
) => Promise<{ score: number; verdict: 'APPROVE' | 'REQUEST_CHANGES'; findings?: object }>;

export class ReviewerRunner {
  constructor(private invoke: InvokeReviewerFn);

  async run(execution: ScheduledExecution): Promise<ReviewerResult[]>;
}
```

Execution algorithm:

1. Iterate `execution.groups` in order. For each group, run all invocations concurrently via `Promise.all(group.map(inv => this.runOne(inv)))`.
2. `runOne(invocation)` wraps the injected `invoke` call:
   - Records `start = performance.now()` before invocation.
   - Calls `invoke(invocation.entry, invocation.context)`.
   - On success: returns `ReviewerResult` with `verdict` from invoke result, `score`, `duration_ms = performance.now() - start`.
   - On thrown error: catches the error, returns `ReviewerResult` with `verdict: 'ERROR'`, `score: null`, `error_message: <error.message>`, `duration_ms` measured to the catch.
3. Errors in one reviewer do NOT prevent other reviewers in the same group from running (because `Promise.all` will only reject if ANY rejects — the runner catches per-invocation INSIDE `runOne` so `Promise.all` always resolves).
4. After all groups complete, return the flattened array of `ReviewerResult` in original chain order. The runner preserves order by iterating groups sequentially.

Concurrency contract: within a group, invocations run in parallel; across groups, execution is strictly sequential (group N+1 does not start until all of group N has resolved). This matches the TDD-020 contract that built-ins finish before specialists, and that rule-set runs last.

### ScoreAggregator (`aggregator.ts`)

API surface:

```typescript
export class ScoreAggregator {
  aggregate(
    results: ReviewerResult[],
    chain: ReviewerEntry[],
    metadata: { gate: string; request_id: string }
  ): GateVerdict;
}
```

Aggregation rules (apply in this exact order):

1. **Built-in-min rule (TDD-019 §11.2)**: Count results where `reviewer_type === 'built-in'` AND `verdict !== 'ERROR'`. If the count is zero AND the chain contains at least one built-in entry, return `outcome: 'REQUEST_CHANGES'` with `reason: "no built-in reviewer completed"`. Skip subsequent rules. (If the chain has zero built-ins by design — e.g., a custom operator chain — this rule is a no-op.)
2. **Blocking threshold rule**: For each result with `blocking: true`:
   - If `verdict === 'ERROR'`: gate fails with `reason: "blocking reviewer ${name} errored: ${error_message}"`.
   - If `verdict === 'REQUEST_CHANGES'` OR `score < threshold`: gate fails with `reason: "blocking reviewer ${name} below threshold (${score} < ${threshold})"`.
3. **Advisory warnings**: For each result with `blocking: false` AND (`verdict === 'REQUEST_CHANGES'` OR `score < threshold`): append a string to `warnings` describing the reviewer, score, and threshold. Do NOT change the gate outcome.
4. If no failure was triggered by rules 1-2, set `outcome: 'APPROVE'` with `reason: "all blocking reviewers passed (${count} built-ins completed)"`.
5. Always populate `per_reviewer` with the full results array (callers need it for the gate-output file in SPEC-020-2-04).

The aggregator does NOT throw exceptions. Even pathological inputs (empty results, mismatched chain) produce a `GateVerdict` (with a meaningful `reason` if the input is degenerate).

## Acceptance Criteria

- [ ] `runner.ts` exports `ReviewerRunner` with constructor accepting an `InvokeReviewerFn`.
- [ ] A group containing 2 invocations runs both in parallel: total wall time is approximately `max(t1, t2)`, NOT `t1 + t2`. Verified by a timing test with mock invocations sleeping 200ms each, asserting total runtime is < 350ms (allowing for scheduling overhead).
- [ ] An error thrown by one reviewer in a group does not prevent the other reviewer(s) in the same group from running. Both produce `ReviewerResult` entries.
- [ ] An error thrown by a reviewer is captured as `verdict: 'ERROR'` with `error_message` set; the runner continues to subsequent groups.
- [ ] After all groups complete, the returned array contains exactly one `ReviewerResult` per invocation, in the original (flattened) chain order.
- [ ] `aggregator.ts` exports `ScoreAggregator` with an `aggregate(results, chain, metadata)` method returning `GateVerdict`.
- [ ] When all built-in results have `verdict: 'ERROR'`, the aggregator returns `outcome: 'REQUEST_CHANGES'` with `reason` containing `"no built-in reviewer completed"`.
- [ ] When the chain contains zero built-ins by design AND all blocking reviewers pass, the aggregator returns `outcome: 'APPROVE'` (built-in-min rule is skipped).
- [ ] When all built-ins pass but a blocking specialist scores below its threshold, the aggregator returns `outcome: 'REQUEST_CHANGES'` with `reason` referencing that specialist's name, score, and threshold.
- [ ] When all blocking reviewers pass but an advisory reviewer scores below its threshold, the aggregator returns `outcome: 'APPROVE'` AND `warnings` contains a string referencing the advisory reviewer, score, and threshold.
- [ ] When a blocking reviewer's `verdict === 'ERROR'`, the gate fails with `reason` containing `"errored"` and the error message.
- [ ] `per_reviewer` in `GateVerdict` always equals the input `results` array (full pass-through).
- [ ] `built_in_count_completed` in `GateVerdict` equals the number of built-in results with non-error verdicts.
- [ ] Aggregator never throws; degenerate inputs (empty results array, chain with no entries) produce a sensible `GateVerdict` with `reason` describing the issue.

## Dependencies

- **Consumes** SPEC-020-2-02: `ScheduledExecution`, `ReviewerInvocation`, `ChangeSetContext`, `ReviewerEntry` types.
- **Consumes from PLAN-020-1** (at runtime, via `InvokeReviewerFn` injection): the four specialist agent definitions and the `reviewer-finding-v1.json` payload shape returned in `findings`. This spec does not import them directly — production wiring happens in SPEC-020-2-04.
- **Used by** SPEC-020-2-04: the review-gate evaluator instantiates `ReviewerRunner` with the production `invokeReviewer` and feeds runner output into `ScoreAggregator.aggregate()`.

## Notes

- Catching errors INSIDE `runOne` (rather than letting `Promise.all` reject) is the correct pattern here because losing visibility into ANY reviewer's outcome would break the aggregator's built-in-min rule (which needs to count completed built-ins). A `Promise.allSettled`-style approach would also work but is less explicit; the inline catch keeps the result type uniform.
- The aggregator's reason strings are user-facing (they show up in the gate-output file and on the operator's terminal). They should reference the reviewer's `name` exactly as it appears in the chain config so operators can grep their config to find the failing entry.
- `score: null` for errored reviewers (rather than `0`) is deliberate: a score of zero would cause threshold checks to falsely register a "low score" instead of an error. Downstream consumers must check `verdict !== 'ERROR'` before trusting `score`.
- Telemetry hook: the runner has a designated extension point (a no-op callback in this spec) where SPEC-020-2-04 inserts the metrics-pipeline emission after each `runOne` resolves. Document this hook in code comments so the SPEC-020-2-04 implementer knows where to wire it.
- The aggregator does NOT mutate inputs. It produces a fresh `GateVerdict` object and a fresh `warnings` array on each call.
- `Promise.all` with an empty array resolves immediately to `[]`. The runner handles empty groups gracefully — though SPEC-020-2-02's scheduler is specified to omit empty groups entirely, defensive handling here costs nothing.
