# SPEC-030-1-01: Portal-local Jest Config + Coverage Gate Skeleton

## Metadata
- **Parent Plan**: PLAN-030-1 (TDD-014 security test backfill)
- **Parent TDD**: TDD-030 §5.4 (Option A), §5.5
- **Tasks Covered**: TASK-001 (jest config + README), TASK-010 (coverage threshold)
- **Estimated effort**: 1 day (0.5 day stand-up + 0.5 day final threshold)
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-030-1-01-portal-jest-config-and-coverage-gate.md`

## Description

Stand up the portal-local Jest configuration that the next 8 specs (SPEC-030-1-02..04) target, and finalize it once those tests land by enforcing a coverage threshold on `server/auth/**/*.ts`.

This spec ships in **two phases** that share one config file: phase A (skeleton) is a prerequisite for SPEC-030-1-02..04; phase B (threshold) lands last, after every auth test file is green. The phases are split inside one spec because the file modified is identical and the second change is mechanical.

The autonomous-dev plugin's existing `jest.config.cjs` is extended with a Jest `projects` entry that points at the new portal-local config. The portal's existing `bun test` runner remains untouched (TDD-030 §5.4 Option A). No production auth code is modified.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-portal/jest.config.cjs` | Create | Portal-local Jest config; discovers only `server/auth/__tests__/**/*.test.ts` |
| `plugins/autonomous-dev-portal/server/auth/__tests__/README.md` | Create | ≤30 lines; links TDD-030 §5.4 + §5.5; records final per-file coverage in phase B |
| `plugins/autonomous-dev/jest.config.cjs` | Modify | Add the portal config under `projects` (do not use `roots` — see §5.5 risk in PLAN-030-1) |

No production code is modified. No portal `package.json` changes (the new config is consumed by the parent plugin's jest, not by `bun test`).

## Implementation Details

### `plugins/autonomous-dev-portal/jest.config.cjs`

Phase A (initial commit, before SPEC-030-1-02..04 begin):

```js
/** @type {import('jest').Config} */
module.exports = {
  displayName: 'autonomous-dev-portal:auth',
  rootDir: __dirname,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/server/auth/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  // No coverageThreshold in phase A — added in phase B by this same spec.
  collectCoverageFrom: ['server/auth/**/*.ts', '!server/auth/**/*.d.ts'],
};
```

Notes:
- `rootDir: __dirname` keeps Jest's relative paths inside the portal even when launched from the parent plugin.
- `testEnvironment: 'node'` because the auth surface uses `http.createServer`, `crypto.subtle`, and `node:net`. Do NOT use `jsdom`.
- `transform` uses `ts-jest`. If `ts-jest` is not currently in portal devDeps, add it under that exact name in phase A's commit and pin to the same major as the autonomous-dev plugin's `ts-jest` (read the existing `package.json` before pinning).
- `collectCoverageFrom` is set in phase A so that `--coverage` produces meaningful output during dev, but threshold enforcement is deferred to phase B.

Phase B (final commit, after SPEC-030-1-02..04 are merged) adds:

```js
  coverageThreshold: {
    'server/auth/**/*.ts': {
      lines: 90,
      // Branches/functions/statements intentionally unset:
      // line-coverage is the contract per TDD-030 §11.1 / OQ-30-06.
    },
  },
```

The threshold is scoped to the auth glob specifically — not the whole portal — because the rest of the portal is out of scope for this PRD-016 closeout.

### `plugins/autonomous-dev/jest.config.cjs` modification

Read the existing file first. The change is to extend the `projects` array (creating one if it does not exist) with a single entry that points at the portal-local config:

```js
projects: [
  // ...existing entries...
  '<rootDir>/../autonomous-dev-portal/jest.config.cjs',
],
```

Constraints:
- If the existing config uses `roots` instead of `projects`, **convert to `projects`** so the portal gets its own `transform`, `testEnvironment`, and `moduleFileExtensions` (see PLAN-030-1 TASK-001 risk note). The conversion is in scope of this spec.
- The existing autonomous-dev test discovery must continue to function unchanged; verify by running `npx jest --listTests` before and after — every previously listed test file MUST still appear.
- Do NOT move existing autonomous-dev tests into a new project subdirectory. The conversion creates an *additional* project for the portal; the existing root-level tests become the default project (or one named `'autonomous-dev'` — whichever pattern matches the project's existing convention).

### `plugins/autonomous-dev-portal/server/auth/__tests__/README.md`

Phase A version (≤30 lines):

```md
# server/auth/__tests__

Jest test suite for the portal's auth surface. Discovered by the
portal-local `jest.config.cjs` and run under the autonomous-dev plugin's
parent jest gate (PRD-016 G-02).

## Why both bun and jest

The portal ships `bun test` for everything else. These auth tests are
jest-only because PRD-016 G-02 requires `npx jest --runInBand` to be
the canonical CI gate. The two runners do not overlap on these files —
`bun test` ignores `__tests__/**/*.test.ts` here.

## Mocking strategy

See TDD-030 §5.5:
- Tailscale daemon → mock at the client interface boundary
- OAuth provider HTTP → `nock`
- Filesystem → real fs in `mkdtempSync`
- Network → real `http.createServer` bound to `127.0.0.1`
- Time → `jest.useFakeTimers({ doNotFake: ['nextTick'] })`

## Coverage

`server/auth/**/*.ts` ≥ 90 % line coverage, enforced via
`coverageThreshold` once SPEC-030-1-04 lands.
```

Phase B amends only the trailing "Coverage" section to record the actual per-module numbers from the last green CI run (one bullet per module, e.g., `- localhost-auth.ts — 96 %`). No other content changes.

## Acceptance Criteria

### Phase A (skeleton)

- AC-1: `npx jest --listTests` from `plugins/autonomous-dev/` includes `plugins/autonomous-dev-portal/server/auth/__tests__/` in its scan paths (initially zero matched files; non-zero once SPEC-030-1-02 lands).
- AC-2: A trivial `localhost-auth.test.ts` containing `it('smoke', () => expect(true).toBe(true))` is picked up and runs in the next spec without any further config change.
- AC-3: The portal's existing `bun test` continues to pass unchanged. Verify by running `bun test` from the portal directory before and after the change; the suite list and result count are identical.
- AC-4: `tsc --noEmit` from the portal directory continues to pass.
- AC-5: `npx jest --listTests` for the autonomous-dev plugin shows the same set of pre-existing tests it showed before the modification (no regression in autonomous-dev test discovery).
- AC-6: README references TDD-030 §5.4 Option A and §5.5; total length ≤ 30 lines.
- AC-7: No file under `plugins/autonomous-dev-portal/server/auth/*.ts` (production code) has been modified.

### Phase B (threshold)

- AC-8: `coverageThreshold` block is present in `plugins/autonomous-dev-portal/jest.config.cjs` and is scoped to the `server/auth/**/*.ts` glob — not global, not portal-wide.
- AC-9: The threshold is `lines: 90`. Branches / functions / statements thresholds are NOT set (per OQ-30-06: line coverage is the contract).
- AC-10: `npx jest --coverage --runInBand` from the autonomous-dev plugin root exits 0 with the threshold active.
- AC-11: The README's "Coverage" section lists each auth module with its measured line-coverage percentage; total is ≥ 90 %.
- AC-12: Removing one test file (e.g., temporarily renaming `cidr-utils.test.ts` to `.skip`) causes `npx jest --coverage --runInBand` to exit non-zero with a `coverageThreshold` violation message naming the auth glob — this proves the gate fails on regression.

### Negative path

- AC-13: A misconfigured CIDR (`["not-a-cidr"]`) inside the threshold block (e.g., a typo on the glob) is caught at config-parse time, not silently ignored: running `npx jest --listConfig` from the autonomous-dev plugin surfaces the threshold's actual glob.

## Test Requirements

This spec is configuration. The "test of the test" is:

1. Phase A: AC-1 through AC-7 verified by command-line invocation, no automated test file authored.
2. Phase B: AC-8 through AC-13 verified by command-line invocation; AC-12 in particular is a manual one-shot regression-check captured in the PR description.

No new automated tests are introduced by this spec. SPEC-030-1-02 ships the first automated test that exercises this config.

## Implementation Notes

- The autonomous-dev plugin already runs ts-jest. Reuse the same major version; do not introduce a second TypeScript transformer.
- If `projects` conversion is non-trivial (the existing config has its own `transform` / `testMatch`), encode the existing block as the first project (named to match the plugin) and append the portal entry as the second. Do not alter the autonomous-dev project's settings.
- The portal's `tsconfig.json` may produce ESM (`"module": "es2022"` or similar). `ts-jest` handles this via the `useESM` flag if needed — read the portal `tsconfig.json` before authoring; if `module` is ESM, set `extensionsToTreatAsEsm: ['.ts']` and `transform`'s ts-jest options to `{ useESM: true }`.

## Rollout Considerations

- Phase A is a no-op for runtime (zero new tests). It is safe to merge ahead of any auth test code.
- Phase B is gated by the merge of SPEC-030-1-02..04. Do **not** add `coverageThreshold` before all 9 test files exist — the gate will fail and block merges.
- Rollback: revert phase B's diff to remove the threshold; revert phase A's diff to remove the portal-local config entirely. Neither rollback affects production auth code.

## Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Bun-vs-jest module resolution surprise | Medium | Medium | Use `projects` (per-project transform/env); fall back to TDD-030 §5.4 Option B by re-scoping to a separate plan |
| `ts-jest` not installed in portal | Low | Low | Add to portal devDeps in phase A's commit |
| Threshold lands before tests land | Low | High | Sequencing rule: phase B is the LAST commit in PLAN-030-1's PR series; reviewer enforces |
