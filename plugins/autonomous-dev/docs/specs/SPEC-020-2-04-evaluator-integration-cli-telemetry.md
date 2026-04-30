# SPEC-020-2-04: Review-Gate Evaluator Integration + Chains CLI + Telemetry

## Metadata
- **Parent Plan**: PLAN-020-2
- **Tasks Covered**: Task 7 (wire scheduler + runner + aggregator into review-gate evaluator), Task 8 (`chains show` and `chains validate` CLI subcommands), Task 9 (telemetry integration)
- **Estimated effort**: 6.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-020-2-04-evaluator-integration-cli-telemetry.md`

## Description
Connect the components from SPEC-020-2-01/02/03 to the rest of the system. Three deliverables: (1) the existing review-gate evaluator now invokes `chain-resolver → scheduler → runner → aggregator` and writes the resulting `GateVerdict` to the standard gate-output path; (2) the `autonomous-dev` CLI gains two subcommands — `chains show` (resolves and prints a chain for a given context) and `chains validate` (schema-checks a config file before deployment); (3) the runner emits one telemetry log entry per reviewer invocation through the existing TDD-007 metrics pipeline, with the documented payload shape `{reviewer, request_id, gate, score, verdict, duration_ms}`.

The integration must preserve backward compatibility: the existing gate-output file format (consumed by PLAN-018-2's gate-presence check) is unchanged, and existing tests for built-in-only chains pass without modification.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/reviewers/index.ts` | Create | Public barrel export + `runReviewGate(context)` orchestrator |
| `plugins/autonomous-dev/src/reviewers/invoke-reviewer.ts` | Create | Production `InvokeReviewerFn` calling Claude Agent SDK |
| `plugins/autonomous-dev/src/reviewers/telemetry.ts` | Create | Wraps TDD-007 metrics emit; safe fire-and-forget |
| `plugins/autonomous-dev/src/reviewers/runner.ts` | Modify | Wire telemetry hook to emit after each `runOne` |
| `plugins/autonomous-dev/bin/score-evaluator.sh` | Modify | Shell entrypoint shells out to the new TS pipeline |
| `plugins/autonomous-dev/src/cli/commands/chains.ts` | Create | `chains show` and `chains validate` subcommands |
| `plugins/autonomous-dev/src/cli/index.ts` | Modify | Register `chains` command group |

## Implementation Details

### Orchestrator (`src/reviewers/index.ts`)

Single public entry point used by the evaluator:

```typescript
export async function runReviewGate(input: {
  repoPath: string;
  requestType: string;
  gate: string;
  requestId: string;
  changedFiles: string[];
  isFrontendChange: boolean;
  stateDir: string;
}): Promise<GateVerdict>;
```

Internally it: (a) calls `resolveChain(repoPath, requestType, gate)`; (b) constructs the `ChangeSetContext`; (c) invokes `new ReviewerScheduler().schedule(chain, context)`; (d) invokes `new ReviewerRunner(invokeReviewer).run(execution)` (production-wired); (e) calls `new ScoreAggregator().aggregate(results, chain, {gate, request_id})`; (f) writes the verdict JSON to `<stateDir>/gates/<gate>.json`; (g) returns the verdict.

Re-exports from this barrel: `ChainConfig`, `ReviewerEntry`, `ReviewerResult`, `GateVerdict`, `ReviewerScheduler`, `ScoreAggregator`, `ReviewerRunner`, `resolveChain`, `runReviewGate`.

### Production Reviewer Invocation (`invoke-reviewer.ts`)

Provides the `InvokeReviewerFn` consumed by `ReviewerRunner`. Logic:

1. Map `entry.name` to either a built-in reviewer module path or a specialist agent definition (path comes from PLAN-020-1's deliverables; this spec resolves it via a lookup table seeded from the agent registry).
2. Invoke via the Claude Agent SDK (existing pattern used by built-in reviewers).
3. Parse the agent's response as a `reviewer-finding-v1` payload (PLAN-020-1).
4. Return `{score, verdict, findings}`. Throw on parse failure or SDK error so the runner records `verdict: 'ERROR'`.

Implementation note: the lookup table is a single `const REVIEWER_REGISTRY: Record<string, ReviewerDispatcher>` so adding a new reviewer is one line. The MVP includes the 6 reviewers referenced in the default chain.

### Evaluator Wiring (`bin/score-evaluator.sh`)

The existing shell script gains a single new code path that invokes the TypeScript pipeline:

```bash
# new path (delegates to TS)
node "$PLUGIN_ROOT/dist/reviewers/cli-evaluator.js" \
  --repo "$REPO_PATH" \
  --request-type "$REQUEST_TYPE" \
  --gate "$GATE_NAME" \
  --request-id "$REQUEST_ID" \
  --state-dir "$STATE_DIR" \
  --changed-files "$CHANGED_FILES_FILE"
```

A small CLI wrapper (`src/reviewers/cli-evaluator.ts`) parses these flags, calls `detectFrontendChanges()` (from PLAN-020-1) using `--changed-files`, and invokes `runReviewGate()`. The wrapper writes the verdict file at `<state-dir>/gates/<gate>.json` exactly matching the format documented in PLAN-018-2 (which is already what `ScoreAggregator` produces — `GateVerdict` is the canonical shape).

Backward compatibility: the wrapper preserves all existing output-file fields. New fields (`per_reviewer`, `warnings`, `built_in_count_completed`) are additive.

### Telemetry (`src/reviewers/telemetry.ts`)

```typescript
export interface ReviewerInvocationLog {
  reviewer: string;
  request_id: string;
  gate: string;
  score: number | null;
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'ERROR';
  duration_ms: number;
}

export function emitReviewerInvocation(log: ReviewerInvocationLog): void;
```

Behavior:
- Calls into the existing TDD-007 metrics pipeline (`MetricsClient.emit('reviewer.invocation', log)` or equivalent — exact API surface documented by PLAN-007-X).
- **Fire-and-forget**: never blocks the caller. Implementation uses `queueMicrotask(() => metricsClient.emit(...).catch(swallow))` so even a metrics-pipeline failure does not affect the runner.
- Idempotent for a given `(reviewer, request_id, gate)` triple if called twice — the metrics pipeline is responsible for dedupe; this function does not.

Wire-up in `runner.ts`: after `runOne` resolves (regardless of outcome), call `emitReviewerInvocation({reviewer: entry.name, request_id, gate, score, verdict, duration_ms})`. The `request_id` and `gate` come from `invocation.context`.

### CLI Subcommands (`src/cli/commands/chains.ts`)

Two subcommands, both supporting `--json`:

`autonomous-dev chains show [--type <type>] [--gate <gate>] [--repo <path>] [--json]`
- Default: shows all gates for all request types.
- `--type feature`: shows only that request type.
- `--type feature --gate code_review`: shows that single chain.
- Resolves via `resolveChain()` (same code path as production), so the output reflects per-repo overrides.
- Tabular output by default: columns `Reviewer | Type | Blocking | Threshold | Trigger | Enabled`.
- `--json`: emits the resolved `ReviewerEntry[]` (or `Record<gate, ReviewerEntry[]>` if no `--gate` filter) as a JSON document to stdout.

`autonomous-dev chains validate <path> [--json]`
- Loads the file at `<path>`, parses as JSON, validates against `reviewer-chains-v1.json`.
- Exit 0 on valid; exit 1 on invalid.
- Default output on invalid: human-readable error pointing at the failing JSON path (e.g., `error at request_types.feature.code_review[2].threshold: must be <= 100`).
- `--json`: emits `{valid: bool, errors: [{path, message}]}`.

### Telemetry Schema for Tests

Tests assert the emit payload matches:

```json
{
  "reviewer": "code-reviewer",
  "request_id": "REQ-12345",
  "gate": "code_review",
  "score": 85,
  "verdict": "APPROVE",
  "duration_ms": 1234
}
```

## Acceptance Criteria

- [ ] `src/reviewers/index.ts` exports `runReviewGate(input)` returning `Promise<GateVerdict>`.
- [ ] A review gate triggered from the supervisor invokes `runReviewGate` and the resulting verdict is written to `<state-dir>/gates/<gate-name>.json`.
- [ ] The gate-output JSON file matches the existing format expected by PLAN-018-2's gate-presence check (no removed or renamed fields). New fields (`per_reviewer`, `warnings`, `built_in_count_completed`) are additive.
- [ ] Existing tests for built-in-only chains pass without modification (no regressions).
- [ ] `invoke-reviewer.ts` includes a `REVIEWER_REGISTRY` mapping all 6 reviewer names referenced in the default chain to dispatchers.
- [ ] `autonomous-dev chains show --type feature --gate code_review` prints all 6 reviewers in the canonical order with the correct columns.
- [ ] `autonomous-dev chains show --type bug` prints all gates configured for `bug` (currently `code_review`).
- [ ] `autonomous-dev chains show --json` emits valid JSON parseable by `jq -e .`.
- [ ] `autonomous-dev chains validate <path-to-valid-config>` exits 0 and prints `valid` (or empty in `--json` mode with `valid: true`).
- [ ] `autonomous-dev chains validate <path-to-invalid-config>` exits 1 and prints an error referencing the failing field path.
- [ ] `autonomous-dev chains validate <path>` in `--json` mode emits `{"valid": false, "errors": [...]}` with at least one error entry on invalid input.
- [ ] Each reviewer invocation produces exactly one telemetry log entry via `emitReviewerInvocation()`.
- [ ] The telemetry payload shape exactly matches `ReviewerInvocationLog` (six fields, no extras).
- [ ] Telemetry is emitted for both `APPROVE`/`REQUEST_CHANGES` (with `score: <number>`) and `ERROR` (with `score: null`) outcomes.
- [ ] Telemetry emission is fire-and-forget: a thrown error inside the metrics pipeline does NOT affect the runner's return value or cause `runReviewGate` to fail.
- [ ] `chains show` and `chains validate` are registered under the `chains` command group in `src/cli/index.ts` and visible in `autonomous-dev --help`.

## Dependencies

- **Consumes** SPEC-020-2-01: schema and default config (loaded by resolver and `chains validate`).
- **Consumes** SPEC-020-2-02: `resolveChain`, `ReviewerScheduler`.
- **Consumes** SPEC-020-2-03: `ReviewerRunner`, `ScoreAggregator`, `ReviewerResult`, `GateVerdict`.
- **Consumes from PLAN-020-1**: `detectFrontendChanges()` (called by the CLI evaluator wrapper before `runReviewGate`); the four specialist agent definitions (referenced by `REVIEWER_REGISTRY`).
- **Consumes from TDD-007 / PLAN-007-X**: the metrics pipeline `MetricsClient.emit(channel, payload)` API.
- **Modifies** PLAN-018-2's contract: gate-output file format is preserved; new fields are additive.

## Notes

- The decision to put orchestration logic (`runReviewGate`) in `index.ts` (not in the bash entrypoint) keeps the wiring testable and lets future callers (e.g., the daemon's in-process gate evaluation in TDD-024) skip the shell layer entirely.
- `REVIEWER_REGISTRY` is a static map for the MVP. Plugins or operator-supplied reviewers are out of scope for this plan (TDD-022 covers plugin chaining); the registry is extensible at a future date.
- The CLI's tabular output should be terminal-friendly: column widths computed from the longest entry, no ANSI colors by default (opt-in via `--color`). Operators run this in CI and SSH sessions where ANSI may render badly.
- `chains validate` deliberately accepts a path argument rather than always validating the in-tree config: operators stage their config changes in a temp file, validate, then move into place. The CI lint step in PLAN-016-2 invokes `chains validate` on each `<repo>/.autonomous-dev/reviewer-chains.json` plus the bundled defaults.
- The telemetry payload intentionally omits `error_message` even on error verdicts: errors are sensitive data (they may contain repo paths or token snippets in some pathological cases). Detailed error info goes to the per-reviewer `findings` object stored in the gate-output file, which is gated by repo permissions.
- The bash entrypoint's modification is minimal — a single new command-line invocation. The script's existing behavior (logging, environment-variable loading) is preserved so deployments that already use `score-evaluator.sh` as a hook continue to work.
- `cli-evaluator.ts` is a thin argv-parsing layer over `runReviewGate`; if it grows beyond ~50 lines it should be refactored, but for MVP scope a flat wrapper is appropriate.
