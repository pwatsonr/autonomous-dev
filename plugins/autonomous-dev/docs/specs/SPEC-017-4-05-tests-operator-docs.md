# SPEC-017-4-05: Vitest Unit Tests + Operator Documentation

## Metadata
- **Parent Plan**: PLAN-017-4
- **Tasks Covered**: Task 12 (vitest unit tests for aggregation, HMAC verification, two-admin override), Task 13 (`docs/operators/budget-gate.md` operator documentation)
- **Estimated effort**: 6 hours
- **Future location**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-017-4-05-tests-operator-docs.md`

## Description
Lock in correctness with vitest unit tests for the three CI scripts produced by SPEC-017-4-01/02/03 (`verify-spend-artifact.js`, `aggregate-spend.js`, `verify-two-admin-override.js`) and the canonical-JSON helper. Coverage target ≥90% on the four script files. Provide fixture artifacts that exercise every important branch: valid signed, tampered, unsigned, previous-month, >32-day-old, multi-admin distinct/same/same-email/non-admin scenarios. Tests run in CI on every PR and block merge on regression.

In parallel, deliver `docs/operators/budget-gate.md`: the single document an operator reads to understand what the gate does, how to apply overrides, how to rotate the HMAC key, and how to read the workflow summary. ≤200 lines, worked examples for every threshold, linked from `docs/operators/README.md`.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `tests/ci/budget-gate.test.ts` | Create | Tests for `canonical-json`, `verify-spend-artifact`, `aggregate-spend`. |
| `tests/ci/two-admin-override.test.ts` | Create | Tests for `verify-two-admin-override` (mocks GitHub HTTP layer). |
| `tests/ci/fixtures/spend-artifacts/valid-current-month.json` | Create | Signed; current month; cost_usd: 12.50. |
| `tests/ci/fixtures/spend-artifacts/valid-current-month-2.json` | Create | Signed; current month; cost_usd: 30.00. |
| `tests/ci/fixtures/spend-artifacts/tampered.json` | Create | Body mutated after signing; HMAC must fail. |
| `tests/ci/fixtures/spend-artifacts/unsigned.json` | Create | No `hmac` field. |
| `tests/ci/fixtures/spend-artifacts/previous-month.json` | Create | Signed; timestamp in previous ISO-8601 month. |
| `tests/ci/fixtures/spend-artifacts/older-than-32-days.json` | Create | Signed; current month label but timestamp >32 days old (boundary). |
| `tests/ci/fixtures/admin-responses/two-distinct-admins.json` | Create | Mock org admin list with two distinct logins + emails. |
| `tests/ci/fixtures/admin-responses/same-email.json` | Create | Two admins sharing the same verified email. |
| `tests/ci/fixtures/admin-responses/non-admin-labeler.json` | Create | One labeler is not in the admin list. |
| `tests/ci/fixtures/admin-responses/null-email.json` | Create | One admin's `users/{login}` returns `email: null`. |
| `docs/operators/budget-gate.md` | Create | Operator documentation; ≤200 lines. |
| `docs/operators/README.md` | Modify | Add link to `budget-gate.md` in the index. |
| `package.json` | Modify | Add `vitest` to devDependencies if not present; add `test:ci` script. |
| `vitest.config.ts` | Modify or Create | Include `tests/ci/**/*.test.ts` and configure coverage to track the four script files. |

## Implementation Details

### Test layout

```ts
// tests/ci/budget-gate.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { canonicalize } from '../../scripts/ci/canonical-json.js';
// ... imports for verify and aggregate as testable modules ...

describe('canonical-json', () => {
  it('produces identical output regardless of key order', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });
  it('throws on undefined values inside objects', () => {
    expect(() => canonicalize({ a: undefined })).toThrow(/Undefined/);
  });
  it('throws on NaN', () => {
    expect(() => canonicalize({ a: NaN })).toThrow(/Non-finite/);
  });
  it('throws on circular structures', () => {
    const obj: any = { a: 1 }; obj.self = obj;
    expect(() => canonicalize(obj)).toThrow();
  });
  it('serializes arrays preserving order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('verify-spend-artifact', () => {
  it('exits 0 for a valid signed artifact', () => { /* ... */ });
  it('exits 1 for a tampered artifact with structured warning', () => { /* ... */ });
  it('exits 1 for an unsigned artifact', () => { /* ... */ });
  it('exits 1 for malformed JSON', () => { /* ... */ });
  it('accepts BUDGET_HMAC_KEY_PREVIOUS as fallback', () => { /* ... */ });
  it('uses constant-time comparison', () => { /* spy on timingSafeEqual */ });
});

describe('aggregate-spend', () => {
  it('sums valid current-month artifacts', () => { /* expect total_spend=42, percentage=8.4 */ });
  it('excludes tampered artifacts and warns', () => { /* ... */ });
  it('excludes previous-month artifacts', () => { /* ... */ });
  it('excludes >32-day-old artifacts', () => { /* boundary: exactly 32 days old → excluded */ });
  it('handles zero artifacts (total_spend=0, percentage=0)', () => { /* ... */ });
  it('exits 2 when CLAUDE_MONTHLY_BUDGET_USD is unset', () => { /* ... */ });
  it('parallelizes downloads in batches of 8', () => { /* spy and assert at most 8 in-flight */ });
  it('completes 500 synthetic artifacts in <60s (perf)', () => { /* slow test, gated */ });
});
```

```ts
// tests/ci/two-admin-override.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('verify-two-admin-override', () => {
  it('exits 0 with two distinct admins and distinct emails', () => { /* fixture: two-distinct-admins.json */ });
  it('exits 1 with one admin labeling twice', () => { /* ... */ });
  it('exits 1 when two admins share the same verified email', () => { /* ... */ });
  it('exits 1 when a labeler is not in the admin list', () => { /* ... */ });
  it('exits 1 when an admin has email: null', () => { /* ... */ });
  it('retries admin list 3x with backoff on 5xx', () => { /* mock https.request; assert 3 calls */ });
  it('compares emails case-insensitively', () => { /* Alice@Example.com vs alice@example.com → same */ });
});
```

### Mocking strategy

- `verify-spend-artifact` and `aggregate-spend` should be importable as modules (export their core logic). The thin CLI wrapper (`process.argv` parsing, `process.exit`) can be untested or smoke-tested via `child_process.spawnSync`.
- `aggregate-spend`'s `gh api` calls should go through a thin `httpClient` interface that tests can mock with vitest's `vi.fn()`. Alternatively, intercept via `vi.spyOn(global, 'fetch')` if the implementation uses `fetch`.
- `verify-two-admin-override` mocks via `vi.mock('node:https')` or by injecting an `httpClient`. Prefer dependency injection for cleaner tests.
- Time-dependent tests (32-day age cap, current month) use `vi.useFakeTimers()` with `vi.setSystemTime(new Date('2026-04-29T00:00:00Z'))` so fixtures can be authored with stable absolute timestamps.

### Coverage configuration

In `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: [
        'scripts/ci/canonical-json.js',
        'scripts/ci/verify-spend-artifact.js',
        'scripts/ci/aggregate-spend.js',
        'scripts/ci/verify-two-admin-override.js',
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
```

CI must invoke `npx vitest run --coverage` and fail if thresholds are not met.

### `docs/operators/budget-gate.md` outline

```markdown
# Budget Gate — Operator Guide

## What this gate does
Brief: HMAC-signed spend artifacts, monthly aggregation, three thresholds.

## Threshold semantics
| Percentage | Behavior | Override |
|------------|----------|----------|
| < 80%       | Silent  | None     |
| 80–99.9%    | Sticky PR comment (advisory) | None |
| 100–109.9%  | Workflow fails | `cost:override` label (any write-access user) |
| ≥ 110%      | Workflow fails | `cost:override-critical` label + two distinct org admins with distinct verified emails |

## Worked examples
1. **70% spend.** Open PR, gate runs, no comment, downstream Claude jobs proceed.
2. **85% spend.** Open PR, gate posts a sticky comment that updates on each re-run, downstream Claude jobs proceed.
3. **102% spend.** Apply `cost:override` label, re-run the gate, jobs proceed. Label is removed after the run.
4. **115% spend.** Apply `cost:override-critical`, have a second org admin (with a distinct verified email) also apply or confirm the label, re-run the gate, jobs proceed. Label is removed after the run.

## Reading the workflow summary
What each section means; how to identify which workflow contributed which spend; where to find override-consumption audit lines.

## Override workflow
Step-by-step: who can apply, how labels are detected, why labels are auto-removed, how to handle false-positive 100% breaches (estimation drift).

## HMAC-key rotation procedure (manual, quarterly)
1. Generate new key (`openssl rand -hex 32`).
2. Set `BUDGET_HMAC_KEY_PREVIOUS` to the current key.
3. Set `BUDGET_HMAC_KEY` to the new key.
4. Wait 32 days (the artifact age cap).
5. Unset `BUDGET_HMAC_KEY_PREVIOUS`.

Why 32 days: matches the aggregator's age cap so the rotation overlap window matches artifact retention window exactly. No artifact is signed by a key that has already been retired by the time it would be evaluated.

## When the gate fails
- "Monthly budget exceeded (X%). Apply 'cost:override' label to proceed." → see Override workflow.
- "Critical override requires two distinct org admin approvals" → 110% threshold: need a second admin.
- "Same-email accounts not permitted" → 110% threshold: the two admins share an email; cannot proceed (use a third admin).
- "HMAC verification failed for artifact <name>" → tamper detected; investigate via the run logs and the artifact's source workflow run.
- "BUDGET_HMAC_KEY not set" → secret missing; configure per the rotation procedure.

## Known edge cases
- 30-day advisory mode: during the first 30 days post-launch the 100% threshold may emit a warning instead of failing (set via `BUDGET_GATE_ADVISORY_MODE` repo variable). The 110% threshold always enforces.
- Eventual-consistency in the GitHub admin API can occasionally false-fail a critical override; the script retries 3× with 10-second backoff. Re-trigger if hit.
- Rotation overlap: do not skip the 32-day overlap; doing so will fail the gate for any artifact signed under the old key still within the aggregation window.
```

Update `docs/operators/README.md` to add a link to `budget-gate.md` in the operator-docs index (e.g., under a "Cost Controls" or "Operations" section).

## Acceptance Criteria

### Tests (Task 12)
- [ ] `tests/ci/budget-gate.test.ts` and `tests/ci/two-admin-override.test.ts` exist and `npx vitest run` exits 0.
- [ ] Coverage report (text and lcov) shows ≥90% lines, branches, functions, statements on each of the four script files.
- [ ] Fixtures cover at minimum: 1 valid signed current-month artifact, 1 tampered artifact, 1 unsigned artifact, 1 previous-month artifact, 1 >32-day-old artifact (boundary: exactly 32 days old → excluded; 31 days old → included).
- [ ] Two-admin override fixtures cover: 2 distinct admins distinct emails (pass), 1 admin labeling twice (fail), 2 admins same verified email (fail), labeler not in admin set (fail), admin with `email: null` (fail), 5xx retry (3 attempts then succeed).
- [ ] Time-dependent tests use `vi.useFakeTimers()` with a fixed `vi.setSystemTime()` so they pass deterministically regardless of when CI runs.
- [ ] Aggregator perf test asserts 500 synthetic artifacts complete in <60s on the CI runner. May be marked `it.concurrent` or gated behind an env flag if it slows local development.
- [ ] HMAC tests verify `crypto.timingSafeEqual` is used (assert via `vi.spyOn(crypto, 'timingSafeEqual')`).
- [ ] Test execution is wired into CI: `package.json` contains a `test:ci` script (or equivalent) that runs `vitest run --coverage` and the CI workflow invokes it on every PR.

### Documentation (Task 13)
- [ ] `docs/operators/budget-gate.md` exists at the documented path.
- [ ] Document is ≤200 lines.
- [ ] Document contains the four worked examples (70%, 85%, 102%, 115%).
- [ ] Document includes the HMAC-key rotation procedure with a 32-day overlap and explains *why* the overlap matches the artifact age cap.
- [ ] Document explains how to read the workflow summary (per-workflow contribution table, override-consumption audit lines).
- [ ] Document explains every error message a gate failure can produce (the "When the gate fails" section).
- [ ] `docs/operators/README.md` links to `docs/operators/budget-gate.md` in its index.
- [ ] No marketing language; reference-style operator documentation.

## Dependencies

- Depends on SPEC-017-4-01 (canonical-json, verify-spend-artifact), SPEC-017-4-02 (aggregate-spend), SPEC-017-4-03 (verify-two-admin-override). Tests cannot exist without their subjects.
- `vitest` and `@vitest/coverage-v8` packages added to devDependencies (or already present from another plugin spec — check before duplicating).
- Node 20+ for the `node:` protocol imports.
- `docs/operators/README.md` exists (created by an earlier PLAN-017 spec or the plugin's baseline). If it does not, this spec creates a minimal version with the new link.

## Notes

- The `aggregate-spend.js` perf test is the most fragile assertion in this spec; CI runner variance can push a 60-second budget to 65s on bad days. Recommend running it 3× and asserting median rather than worst-case if flake becomes an issue. Initial implementation can be simple (`expect(elapsed).toBeLessThan(60_000)`); harden if needed.
- Coverage thresholds are enforced at the per-file level (configured under `coverage.include`). A future change that adds an unrelated script to `scripts/ci/` does not pollute the coverage signal because the four files are listed explicitly.
- The fixtures directory is intentionally small (one or two artifacts per scenario). The aggregator perf test generates synthetic artifacts in-memory rather than on disk; the disk-based fixtures are for verifier and end-to-end aggregation tests.
- `docs/operators/budget-gate.md` is the canonical reference for "what the gate does"; do not duplicate threshold or override semantics into other docs. Other docs link here.
- The 30-day advisory-mode toggle is documented in the operator guide AND set via `BUDGET_GATE_ADVISORY_MODE` repo variable per SPEC-017-4-03. Operators promote to required by setting the variable to `false` (or unsetting); this is intentionally an explicit, auditable action.
- If a future change retires one of the four scripts, this spec's coverage configuration must be updated. A CHANGELOG entry should accompany any such change.
- The two-admin override tests do NOT exercise live GitHub API calls; CI is fully hermetic via mocked HTTP. Live-API smoke testing is part of PLAN-017-4's Testing Strategy ("Two-admin attack tests" via a draft PR), out of scope for this spec.
