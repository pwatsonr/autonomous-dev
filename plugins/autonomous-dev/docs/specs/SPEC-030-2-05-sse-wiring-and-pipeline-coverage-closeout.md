# SPEC-030-2-05: SSE Wiring + Pipeline Coverage Threshold + Closeout

## Metadata
- **Parent Plan**: PLAN-030-2 (TDD-015 portal pipeline closeout)
- **Parent TDD**: TDD-030 §6.4, §10.3, §10.4, §11.1
- **Tasks Covered**: TASK-005 (SSE wiring + smoke + coverage threshold)
- **Estimated effort**: 0.5 day
- **Depends on**: SPEC-030-2-02, 2-03, 2-04 merged (heartbeat, cost, log pipelines exist)
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-030-2-05-sse-wiring-and-pipeline-coverage-closeout.md`

## Description

Final closeout for PLAN-030-2: confirm/finalize SSE bus wiring for the three new topics (`heartbeat`, `cost-update`, `log-line`), promote the pipelines into the enforced `coverageThreshold` block, capture the manual smoke evidence required by TDD-030 §10.4, and record the per-pipeline coverage numbers in an `__tests__/README.md`.

This spec ships:
- A short README under `server/integration/__tests__/` (TDD-030 §6.4 reference + bun-vs-jest split note).
- An extension to the portal-local `jest.config.cjs` `coverageThreshold` block (added in SPEC-030-1-05) that adds the three pipeline files at ≥ 80 % lines.
- Optional final touch-ups to `server/sse/index.ts` if any of SPEC-030-2-02 / 2-03 / 2-04 deferred SSE registration to closeout.
- The PR description carries the manual-smoke evidence required by TDD-030 §10.4.

This spec ships **no production code beyond final SSE wiring touch-ups** and **no new tests** beyond what the pipeline specs already created.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-portal/jest.config.cjs` | Modify | Extend `coverageThreshold` (set up in SPEC-030-1-05) with pipeline files at lines ≥ 80% |
| `plugins/autonomous-dev-portal/server/integration/__tests__/README.md` | Create | ≤25 lines; links TDD-030 §6 and notes the bun-vs-jest split |
| `plugins/autonomous-dev-portal/server/sse/index.ts` | Modify (only if needed) | Final verification; only changes if any of SPEC-030-2-02..04 deferred SSE registration |

The SSE-wiring change is **conditional**: each pipeline spec has its own SSE-wiring acceptance criterion, and ideally those land in their respective specs. If the implementer of those specs deferred wiring to this closeout (e.g., because the bus required a single registration site), this spec finishes that work.

## Implementation Details

### `coverageThreshold` extension

The portal-local `jest.config.cjs` already declares `coverageThreshold` for `server/auth/**/*.ts` (per SPEC-030-1-05). Extend it:

```js
// plugins/autonomous-dev-portal/jest.config.cjs
module.exports = {
  // ... existing config ...
  collectCoverageFrom: [
    'server/auth/**/*.ts',
    '!server/auth/**/*.d.ts',
    '!server/auth/**/__tests__/**',
    '!server/auth/**/__mocks__/**',
    'server/integration/cost-pipeline.ts',
    'server/integration/heartbeat-pipeline.ts',
    'server/integration/log-pipeline.ts',
    'server/integration/pipeline-types.ts',
    'server/integration/redact-url.ts', // ONLY if SPEC-030-2-03 created this file
  ],
  coverageThreshold: {
    'server/auth/**/*.ts': { lines: 90 },
    'server/integration/cost-pipeline.ts':      { lines: 80 },
    'server/integration/heartbeat-pipeline.ts': { lines: 80 },
    'server/integration/log-pipeline.ts':       { lines: 80 },
    // pipeline-types.ts is a pure type module; jest reports 100% by default.
    // No threshold added (zero runtime; threshold would be a no-op).
  },
};
```

Notes:
- Pipeline thresholds are **per-file** (not glob), unlike the auth glob, so adding a new file to `server/integration/` does not silently lower the bar.
- `state-pipeline.ts` is **not** included — it predates this PRD and is owned by TDD-015 (NG-3004).
- `redact-url.ts` is conditional on SPEC-030-2-03's outcome; the PR author removes the line if that file was not created.

### `__tests__/README.md`

```md
# Portal Integration Pipeline Tests

These tests use **Jest** (not the portal's default `bun test`) per
[TDD-030](../../../../autonomous-dev/docs/tdd/TDD-030-closeout-backfill-014-015-019.md) §5.4.
They live under `server/integration/__tests__/` and are discovered by the
portal-local `jest.config.cjs` (a sibling of this README's package.json).

The portal's `bun test` continues to own the rest of the portal's tests; this
directory is the carve-out for the new live-data pipelines (cost, heartbeat,
log) that ship with TDD-030.

## Layout

| File | Pipeline | Source artifact |
|------|----------|-----------------|
| `cost-pipeline.test.ts`      | `cost-pipeline.ts`      | `<request>/.autonomous-dev/cost.json` (rewritable JSON) |
| `heartbeat-pipeline.test.ts` | `heartbeat-pipeline.ts` | `<request>/.autonomous-dev/heartbeat.jsonl` (append-only) |
| `log-pipeline.test.ts`       | `log-pipeline.ts`       | `<request>/log.jsonl` (append-only + PII redaction) |

## Mocking strategy

Per TDD-030 §6.4: tests use real `fs` operations against `mkdtempSync` temp
directories (no `fs` mocks). Watcher events are observed via the existing
`FileWatcher` class — the watcher is real, not stubbed. The pipelines
themselves are exercised end-to-end at the public-API surface (`start`,
`stop`, `on`).
```

### SSE wiring final-pass

Read `server/sse/index.ts`. Verify each of `cost-update`, `heartbeat`, `log-line` is registered (or that the bus auto-registers on first publish). If any topic is missing and the bus requires explicit registration, add the registration here in this spec — but only as a deferred-from-pipeline-specs touch-up. The preferred path is for each pipeline spec to own its own wiring.

## Acceptance Criteria

- AC-1: `plugins/autonomous-dev-portal/jest.config.cjs` declares per-file `coverageThreshold` entries for `cost-pipeline.ts`, `heartbeat-pipeline.ts`, `log-pipeline.ts` at `lines: 80`.
- AC-2: `collectCoverageFrom` includes the three pipeline files (and `pipeline-types.ts`, and `redact-url.ts` if created in SPEC-030-2-03).
- AC-3: `npx jest --coverage --runInBand` from `plugins/autonomous-dev/` exits 0 with the new threshold active.
- AC-4: Artificially deleting one happy-path test in any pipeline test file (in a local experiment, NOT committed) drops the corresponding pipeline below 80% and causes `--coverage` to exit non-zero. Documented in PR description as the proof-of-gate.
- AC-5: `plugins/autonomous-dev-portal/server/integration/__tests__/README.md` exists, is ≤25 lines, and links TDD-030 §6.
- AC-6: SSE bus accepts `cost-update`, `heartbeat`, `log-line` topics. If `server/sse/index.ts` was modified by this spec, the diff is minimal (one or two `register('topic-name')` calls); the rest of the SSE module is unchanged.
- AC-7: Manual smoke per TDD-030 §10.4: PR description includes the exact `wscat` (or `curl` SSE) command used and the observed payload for each of the three topics.
- AC-8: `state-pipeline.ts`, `redaction.ts`, `schemas/*`, `server/readers/**`, and `FileWatcher.ts` are unmodified.
- AC-9: Portal's `bun test` continues to pass (no regression).
- AC-10: `tsc --noEmit` from the portal passes.
- AC-11: 3 consecutive green CI runs on the PR branch (flake check, TDD-030 §8.4) — pipeline tests are file-watcher-bound and the most flake-prone in this PRD.
- AC-12: Pipelines remain off-by-default at the config level (TDD-030 §10.3) — no auto-enable in this spec.

### Given/When/Then

```
Given the portal-local jest.config.cjs declares per-file thresholds for the three pipelines at lines: 80
When npx jest --coverage --runInBand runs from the autonomous-dev plugin root
Then the run exits 0
And the coverage report shows each pipeline file at >= 80%

Given the threshold is active and a contributor adds a new untested code path to log-pipeline.ts
When CI runs on the PR
Then the coverage gate fails the PR
And the failure message names log-pipeline.ts as below threshold

Given a developer runs the portal locally with the three pipelines enabled
When each watched file (cost.json, heartbeat.jsonl, log.jsonl) is touched
Then a connected SSE client receives a message on the matching topic
   (cost-update, heartbeat, log-line respectively)
And the manual-smoke evidence is captured in the PR description per TDD-030 §10.4
```

## Test Requirements

This spec adds no new test files. Verification is:
1. `npx jest --coverage --runInBand` exits 0 with the new thresholds active.
2. Proof-of-gate experiment (delete one happy-path test locally; confirm gate fails) — captured in PR description.
3. Manual smoke per TDD-030 §10.4 — captured in PR description.
4. Portal's `bun test` continues to pass.
5. CI 3-green flake check before merge.

## Implementation Notes

- The per-file threshold pattern (vs the glob pattern used for `server/auth/`) is intentional. Pipeline files are countable (3); the auth surface is a directory tree (15+). Per-file is preferred where countable because new files become explicit additions, not silent threshold dilutions.
- If SPEC-030-2-03 did not create `redact-url.ts` (because `redaction.ts` already covers URL params), remove that line from `collectCoverageFrom`. Leaving it would cause jest to warn about an uncovered file with no source.
- Manual smoke is the only place this PRD touches a running portal. If the local-portal-bringup is non-trivial during the work window, fall back to TDD-030 §10.4's "deferred to canary checklist" — but document the gap in the PR description, do not silently skip.
- The `__tests__/README.md` mirrors the auth `__tests__/README.md` structure introduced in SPEC-030-1-01. Reviewer should compare formats for consistency.
- This is the **last** spec in PLAN-030-2. Merging it closes TDD-015's audit gap.

## Rollout Considerations

- **Forward**: pipelines remain off-by-default; operators flip them on via the live-data settings UI.
- **Rollback**: drop the `coverageThreshold` per-pipeline lines back to a soft floor (e.g., 70%) if the threshold proves brittle in week 1; do NOT remove the entries entirely.

## Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| `coverageThreshold` per-file glob does not match — gate silently passes | Low | High (false-green) | Proof-of-gate experiment in PR description |
| Manual-smoke evidence not captured (developer can't run portal locally) | Medium | Medium | TDD-030 §10.4 fallback: defer to canary checklist; document gap in PR |
| SSE topic name conflicts with an existing TDD-015 topic | Low | Medium | Read `server/sse/index.ts` first; if conflict, the pipeline emits to the existing topic and this spec is a no-op for that file |
| `redact-url.ts` line in `collectCoverageFrom` is stale (SPEC-030-2-03 did not create the file) | Medium | Low | PR-author checklist: verify the file exists before merge; remove the line if not |
| Pipelines flake on CI (file-watcher timing) | Medium | Medium | 3-green CI check before merge; per-pipeline specs already use the explicit-wait pattern |
| The 80% threshold proves unreachable on log-pipeline.ts (rotation/truncation branches hard to hit) | Low | Low | Per TDD-030 §11.1 the target is 80% (not 90%); if a branch is unreachable, document and add `/* istanbul ignore next */` with rationale |
