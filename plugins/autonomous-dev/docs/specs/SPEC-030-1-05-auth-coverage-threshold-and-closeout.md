# SPEC-030-1-05: Auth Coverage Threshold Enforcement and Closeout

## Metadata
- **Parent Plan**: PLAN-030-1 (TDD-014 auth security test backfill)
- **Parent TDD**: TDD-030 §5.3, §11.1; PRD-016 G-02
- **Tasks Covered**: TASK-010 (enforce coverage threshold and finalize)
- **Estimated effort**: 0.5 day
- **Depends on**: SPEC-030-1-01, 1-02, 1-03, 1-04 merged (all 9 auth test files exist)
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-030-1-05-auth-coverage-threshold-and-closeout.md`

## Description

Promote PLAN-030-1's auth-coverage from "measured" to "enforced". Once the nine auth test files (cidr-utils, pkce-utils, localhost-auth, network-binding, tailscale-client, tailscale-auth, oauth-flow, session-security, csrf-protection) have landed and CI reports their line-coverage numbers, enable Jest's `coverageThreshold` config so CI fails on regression. Document any `/* istanbul ignore next */` exclusions and record the final per-module coverage numbers in the auth `__tests__/README.md`.

This spec ships **no production code** and **no new tests**. It is a configuration/documentation closeout. The auth surface itself remains unmodified (per PLAN-030-1 NG / TDD-030 NG-3001).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-portal/jest.config.cjs` | Modify | Add `coverageThreshold` block scoped to `server/auth/**/*.ts` at ≥ 90% lines |
| `plugins/autonomous-dev-portal/server/auth/__tests__/README.md` | Modify | Append "Final coverage" section with per-module numbers + any istanbul-ignore rationale |
| `plugins/autonomous-dev/jest.config.cjs` | Verify only | No change expected — the `projects` entry from SPEC-030-1-01 already covers root-level invocation |

## Implementation Details

### `coverageThreshold` block

Add to the portal-local `jest.config.cjs` (created in SPEC-030-1-01). The block is **scoped** to the auth glob — it MUST NOT apply globally because the rest of the portal is out of scope for this PRD:

```js
// plugins/autonomous-dev-portal/jest.config.cjs
module.exports = {
  // ... existing config from SPEC-030-1-01 ...
  collectCoverageFrom: [
    'server/auth/**/*.ts',
    '!server/auth/**/*.d.ts',
    '!server/auth/**/__tests__/**',
    '!server/auth/**/__mocks__/**',
  ],
  coverageThreshold: {
    'server/auth/**/*.ts': {
      lines: 90,
      // statements, branches, and functions are NOT enforced in this PRD.
      // PRD-016 R-04 / TDD-030 §11.1 only commits to lines ≥ 90%.
      // Branches in particular are deferred to a follow-up; defensive
      // /* istanbul ignore next */ branches would skew an enforced number.
    },
  },
};
```

Rationale for lines-only:
- TDD-030 §11.1 / PRD-016 R-04 commits to **line coverage ≥ 90%** as the gate; branches are not part of the contract.
- Some auth modules (notably oauth-flow per TASK-007 risk note in PLAN-030-1) include defensive branches that either cannot be exercised without invented infrastructure or are already marked `/* istanbul ignore next */`.

### Coverage README delta

Append to `plugins/autonomous-dev-portal/server/auth/__tests__/README.md`:

```md
## Final Coverage Numbers

These numbers were captured from the last green CI run on the merge commit.
The threshold below is what the gate enforces — the actual number is the
floor we shipped at.

| Module | Lines | Threshold | Notes |
|--------|-------|-----------|-------|
| `cidr-utils.ts` | <NN.N>% | 90% | Pure functions; expected ≥ 95% |
| `pkce-utils.ts` | <NN.N>% | 90% | Pure crypto; expected ≥ 95% |
| `localhost-auth.ts` | <NN.N>% | 90% | |
| `network-binding.ts` | <NN.N>% | 90% | |
| `security/binding-enforcer.ts` | <NN.N>% | 90% | Combined with network-binding |
| `tailscale-client.ts` | <NN.N>% | 90% | Mocked at boundary |
| `tailscale-auth.ts` | <NN.N>% | 90% | |
| `oauth/oauth-auth.ts` | <NN.N>% | 90% | |
| `oauth/oauth-bootstrap.ts` | <NN.N>% | 90% | |
| `oauth/oauth-state.ts` | <NN.N>% | 90% | |
| `oauth/token-exchange.ts` | <NN.N>% | 90% | |
| `session/session-manager.ts` | <NN.N>% | 90% | |
| `session/session-cookie.ts` | <NN.N>% | 90% | |
| `session/file-session-store.ts` | <NN.N>% | 90% | |
| CSRF middleware | <NN.N>% | 90% | |

## Istanbul-ignore Rationale

If any `/* istanbul ignore next */` comments are added to the production
auth code (per TDD-030 §5.3), record each one here with a one-line
justification. Empty section is a valid result if no ignores were needed.

| File | Line | Rationale |
|------|------|-----------|
| _(none)_ | — | — |
```

The author of the closeout PR replaces `<NN.N>` with actual numbers from the final CI run before merge.

### Vulnerability disclosure section (conditional)

If any of the nine test files surfaced a real auth vulnerability during authoring (per TDD-030 §8.1 / PRD-016 R-03), the README also gains:

```md
## Vulnerabilities Discovered

The following findings emerged from this backfill. Each is tracked in a
separate hotfix PR per TDD-030 §8.1; merging this closeout is NOT blocked
on those fixes (this plan is tests-only).

| Finding | Severity | Hotfix PR |
|---------|----------|-----------|
| _(none / or list)_ | — | — |
```

If no findings, the section is omitted entirely (do not commit an empty stub).

## Acceptance Criteria

- AC-1: `plugins/autonomous-dev-portal/jest.config.cjs` declares a `coverageThreshold` block scoped to `server/auth/**/*.ts` requiring `lines: 90`.
- AC-2: The threshold is **scoped** — invoking jest against only `server/auth/` enforces the gate; invoking against unrelated portal paths does not surface this threshold.
- AC-3: `npx jest --coverage --runInBand` from `plugins/autonomous-dev/` exits 0 with the threshold active.
- AC-4: Artificially deleting one happy-path test in any auth file (in a local experiment, not committed) drops a covered module below 90% and causes `--coverage` to exit non-zero. Documented in the PR description as the proof-of-gate.
- AC-5: `plugins/autonomous-dev-portal/server/auth/__tests__/README.md` lists every covered module with its final percentage; the "Istanbul-ignore Rationale" table is present (may be empty).
- AC-6: Total combined line coverage of `server/auth/**/*.ts` is ≥ 90% per the CI report linked from the PR.
- AC-7: The portal's existing `bun test` continues to pass (no regression).
- AC-8: `tsc --noEmit` from the portal passes.
- AC-9: No production auth code is modified by this spec. `git diff main -- 'plugins/autonomous-dev-portal/server/auth/**/*.ts'` is empty (excluding `__tests__/` and `__mocks__/`).
- AC-10: If any vulnerability was discovered during PLAN-030-1 implementation, the PR description links a separate hotfix PR per TDD-030 §8.1.
- AC-11: 3 consecutive green CI runs on the PR branch (flake check) — TDD-030 §8.4.

### Given/When/Then

```
Given the portal-local jest.config.cjs declares coverageThreshold for server/auth/**/*.ts at lines: 90
When npx jest --coverage --runInBand runs from the autonomous-dev plugin root
Then the run exits 0
And the per-module line coverage report shows every auth module at ≥ 90%

Given the threshold is active
When a contributor introduces a new auth module without tests (or removes a happy-path test)
Then npx jest --coverage --runInBand exits non-zero
And the failure message names the module that fell below threshold

Given the coverage report shows oauth/token-exchange.ts at 91.2%
When the auth __tests__/README.md is reviewed
Then the "Final Coverage Numbers" table records 91.2% for token-exchange.ts
And any /* istanbul ignore next */ comments are listed with rationale
```

## Test Requirements

This spec does not introduce new test files. Verification is:
1. `npx jest --coverage --runInBand` from autonomous-dev plugin exits 0 with threshold active.
2. A local experiment (not committed) deletes one happy-path test per module and confirms the gate fails — captured in PR description as "proof of gate".
3. Portal's `bun test` continues to pass.
4. CI 3-green flake check before merge.

## Implementation Notes

- The `coverageThreshold` block uses **glob keys**, not absolute paths. Jest's docs are explicit: glob keys are matched against the project root. If the glob is wrong, the threshold silently no-ops and the gate passes — an obvious failure mode. The PR author MUST verify by running the proof-of-gate experiment.
- `collectCoverageFrom` ensures jest tracks the auth files **even when no test directly imports them**. Without this, modules with zero tests would report as "not in coverage" rather than "below threshold" — a different and less helpful failure.
- The four PLAN-030-1 batch-1 specs (1-01 through 1-04) all assumed `coverageThreshold` would be enabled here. If any of them inadvertently shipped with the threshold already active, this spec becomes a no-op verification — and the README is the only delta.
- TDD-030 §5.3 explicitly prefers dead-code removal over `/* istanbul ignore next */`. Any istanbul-ignore comment added during PLAN-030-1 should be questioned in review; this spec's README captures the rationale so reviewers can audit.
- This is the **last** spec in PLAN-030-1. Merging it closes TDD-014's audit gap.

## Rollout Considerations

- **Forward**: After merge, all subsequent auth changes must keep coverage ≥ 90%. The gate fails the PR; no override path is provided in this spec (intentional — overrides erode the gate).
- **Rollback**: If the threshold proves too brittle in week 1 post-merge, the rollback is to drop `coverageThreshold` to `lines: 80` as a temporary floor while the team investigates. Do NOT remove the block entirely; the gate is the deliverable.

## Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| `coverageThreshold` glob doesn't match — gate silently passes | Medium | High (false-green) | Proof-of-gate experiment in PR description; reviewer must reproduce |
| Newly enforced threshold breaks a flaky branch | Low | Medium | Lines-only enforcement (not branches); 3-green CI flake check before merge |
| README's `<NN.N>` placeholders shipped unfilled | Low | Low | PR template / reviewer checklist catches; pre-merge sanity grep for `<NN.N>` in README |
| A vulnerability is discovered late and the hotfix PR is not yet open | Low | Medium | Per TDD-030 §8.1 / PRD-016 R-03: document in PR; do not block this closeout on the hotfix; track in TDD-031 if needed |
| `collectCoverageFrom` accidentally includes test files (skews numbers) | Low | Medium | The exclusion globs `__tests__/`, `__mocks__/`, `*.d.ts` are explicit; reviewer verifies |
