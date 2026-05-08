# PRD-016 SPEC Reconciliation Matrix

**Parent PRD**: [PRD-016 Test-Suite Stabilization](../prd/PRD-016-test-suite-stabilization.md)
**Parent TDD**: [TDD-031 SPEC Reconciliation](../tdd/TDD-031-spec-reconciliation-path-vitest-bats.md)
**Status**: In progress

## Preamble

This matrix records every SPEC amended by the TDD-031 reconciliation sweep,
grouped by drift class. One row per amended SPEC. Authoritative bookkeeping
for the PR; reviewers spot-check rows rather than every diff.

### Audit counts (frozen at PLAN-031-1 task 1)

| Class | Expected (TDD §3.1) | Observed | Notes |
|-------|---------------------|----------|-------|
| Path drift | ~17 | 17 | Within tolerance (±3 of 17). Audit excludes SPEC-025+ files which are new and accurate. |
| Vitest | ~26 | 26 | Within tolerance (±5 of 26). Audit excludes SPEC-025+ files. Carve-out list: empty (0 historical-context SPECs identified). |
| Bats | ~15 | TBD (PLAN-031-3) | |

### Spot-checks (3 per class; populated as plans land)

- Path drift (PLAN-031-1 task 5):
  - SPEC-014-2-01-csrf-protection — checked `plugins/autonomous-dev-portal/server/security/types.ts` → EXISTS
  - SPEC-015-1-04-cost-heartbeat-log-readers-with-redaction — checked `plugins/autonomous-dev-portal/server/readers/CostReader.ts` → EXISTS
  - SPEC-015-4-03-daemon-down-detection-banner-degradation — checked `plugins/autonomous-dev-portal/server/health/health-types.ts` → EXISTS
  - Selection method: alphabetic first / middle / last from the 17-row staged-diff list (deterministic, reproducible).
- Vitest (PLAN-031-2 task 6): TBD
- Bats (PLAN-031-3 task 5): TBD

### Verification log (PLAN-031-4 task 2)

Five paired self-tests for `scripts/verify-spec-reconciliation.sh`. Target SPEC
for negative tests: `SPEC-001-1-01-scaffold-args-logging.md` (chosen as a
stable, minimal canvas that contains none of the drift tokens at baseline).
Each negative test: append a single offending line, run script, observe
expected FAIL, `git checkout --` the SPEC, confirm hash matches the baseline
SHA. Synthetic positive: run script against a temporary clean fixture.

| # | Test | Expected | Observed | Tree clean after |
|---|------|----------|----------|------------------|
| 1 | NEGATIVE — path drift (`src/portal/foo.ts`) | exit 1; `FAIL: src/portal/ references remain` names target SPEC | exit 1; FAIL line emitted; target SPEC named | yes (git hash matches baseline) |
| 2 | NEGATIVE — vitest token | exit 1; FAIL: vitest references remain | exit 1; vitest failure emitted | yes |
| 3 | NEGATIVE — bats (`tests/unit/test_foo.sh`) | exit 1; FAIL: bats references remain | exit 1; bats failure emitted | yes |
| 4 | NEGATIVE — fictional path (`plugins/autonomous-dev/never-existed.ts`) | exit 1; `MISSING: plugins/autonomous-dev/never-existed.ts` and final summary `FAIL: N cited paths do not exist` | exit 1; MISSING line emitted; summary present | yes |
| 5 | POSITIVE — synthetic clean tree (mktemp fixture with one valid cite) | exit 0; final stdout `PASS`; runtime < 500 ms | exit 0; `PASS`; ~430 ms wall-clock | yes |

**Note on the production-tree positive test (OQ-31-07).** SPEC-031-4-01 FR-7's
positive test specifies running on the post-PLAN-031-3 working tree. The
production tree at the time of this PR retains residual drift in SPECs that
were OUT OF SCOPE for PRs #95 (PLAN-031-1/2; ~5 SPECs amended) and #97
(PLAN-031-3; 5 SPECs amended). The verification script therefore exits 1 on
the production tree by design — that is the gate firing, not a script defect.
The script's correctness is demonstrated by the four negative tests + the
synthetic positive (test #5). Production-tree PASS will follow once the
remaining SPEC amendments land in follow-up PRs (tracked separately; see
"Out of scope" below). The CI gate is intentionally enabled on `main` so the
drift cannot expand beyond the current set.

Runtime: 0.43 s wall-clock (target < 500 ms; PASS). Idempotence: re-running
on the same tree produced byte-identical stderr (`diff a b` empty).

### Enforcement mechanism

TBD — populated by PLAN-031-4 with the script path, CI step name, and the
local invocation command.

---

## Path drift (PLAN-031-1)

| SPEC | Class | Action | Approver | Notes |
|------|-------|--------|----------|-------|
| SPEC-014-2-01-csrf-protection | Path | s\|src/portal/\|plugins/autonomous-dev-portal/server/\| | @pwatson | Spot-checked: types.ts EXISTS |
| SPEC-014-2-02-typed-confirm-modal | Path | s\|src/portal/\|plugins/autonomous-dev-portal/server/\| | @pwatson | |
| SPEC-014-2-03-xss-defense | Path | s\|src/portal/\|plugins/autonomous-dev-portal/server/\| | @pwatson | |
| SPEC-014-2-04-content-security-policy | Path | s\|src/portal/\|plugins/autonomous-dev-portal/server/\| | @pwatson | |
| SPEC-014-2-05-security-tests | Path | s\|src/portal/\|plugins/autonomous-dev-portal/server/\| | @pwatson | |
| SPEC-015-1-01-file-watcher-fs-watch-polling-debounce | Path | s\|src/portal/\|plugins/autonomous-dev-portal/server/\| | @pwatson | |
| SPEC-015-1-02-sse-event-bus-broadcast-backpressure-heartbeat | Path | s\|src/portal/\|plugins/autonomous-dev-portal/server/\| | @pwatson | |
| SPEC-015-1-03-state-json-readers-request-status-phase-history | Path | s\|src/portal/\|plugins/autonomous-dev-portal/server/\| | @pwatson | |
| SPEC-015-1-04-cost-heartbeat-log-readers-with-redaction | Path | s\|src/portal/\|plugins/autonomous-dev-portal/server/\| | @pwatson | Spot-checked: CostReader.ts EXISTS |
| SPEC-015-1-05-tests-watcher-coalesce-sse-backpressure-redaction-cross-platform | Path | s\|src/portal/\|plugins/autonomous-dev-portal/server/\| | @pwatson | |
| SPEC-015-2-01-approval-gate-ui-flow | Path | s\|src/portal/\|plugins/autonomous-dev-portal/server/\| | @pwatson | |
| SPEC-015-2-02-settings-editor | Path | s\|src/portal/\|plugins/autonomous-dev-portal/server/\| | @pwatson | |
| SPEC-015-2-03-intake-router-http-client | Path | s\|src/portal/\|plugins/autonomous-dev-portal/server/\| | @pwatson | |
| SPEC-015-2-04-approval-state-persistence-and-confirm | Path | s\|src/portal/\|plugins/autonomous-dev-portal/server/\| | @pwatson | |
| SPEC-015-4-01-operations-endpoints | Path | s\|src/portal/\|plugins/autonomous-dev-portal/server/\| | @pwatson | |
| SPEC-015-4-02-audit-page | Path | s\|src/portal/\|plugins/autonomous-dev-portal/server/\| | @pwatson | |
| SPEC-015-4-03-daemon-down-detection-banner-degradation | Path | s\|src/portal/\|plugins/autonomous-dev-portal/server/\| | @pwatson | Spot-checked: health-types.ts EXISTS |

---

## Vitest (PLAN-031-2)

### OQ-31-05 whitelist (vi.* APIs without clean Jest equivalent)

- SPEC-023-3-04-unit-and-integration-tests: original text used `vi.stubEnv`.
  Jest has no direct equivalent; rewritten in-line to `process.env.X = …` with
  `afterEach` restoration. The original Vitest API name is preserved in the
  amended SPEC text for traceability (`vi.stubEnv` → "Jest has no direct
  stubEnv equivalent; see OQ-31-05").

### Carve-out (historical-context whitelist)

These SPECs are EXCLUDED from the SPEC-031-2-02 mechanical substitution. Empty
list — no SPEC contains a deliberate "alternative considered" / "rejected"
passage about Vitest vs Jest. False positives during scan:

- SPEC-017-4-05-tests-operator-docs: "Alternatively, intercept via `vi.spyOn`…"
  refers to an alternative API technique, not historical-runner selection. Not
  a carve-out.
- SPEC-022-2-05-unit-and-standards-to-fix-integration-tests: "Rejection test
  passes" refers to a rejection test scenario, not a rejected runner. Not a
  carve-out.

### Rows

| SPEC | Class | Action | Approver | Notes |
|------|-------|--------|----------|-------|

---

## Bats (PLAN-031-3)

| SPEC | Class | Action | Approver | Notes |
|------|-------|--------|----------|-------|
