# SPEC-031-4-01: `verify-spec-reconciliation.sh` Script + Local Self-Tests

## Metadata
- **Parent Plan**: PLAN-031-4 (verification script + CI guard)
- **Parent TDD**: TDD-031-spec-reconciliation-path-vitest-bats (§5.4, §6.4, §9.1)
- **Parent PRD**: PRD-016-test-suite-stabilization (G-08, FR-1654)
- **Tasks Covered**: PLAN-031-4 task 1 (author script), task 2 (local self-tests)
- **SPECs amended by this spec**: 0 (this spec authors a new script and runs five paired self-tests on a clean tree)
- **Estimated effort**: 60 minutes (~30 min script authoring + ~30 min self-tests + Verification log entry)
- **Status**: Draft
- **Depends on**: SPEC-031-3-03 (clean post-bats-reconciliation tree; the script's checks must PASS on this baseline)

## Summary
Author the `scripts/verify-spec-reconciliation.sh` bash script implementing
the four checks from TDD §5.4 (no `src/portal/`, no `vitest`, no `.bats` /
`tests/unit/test_*.sh`, every cited `plugins/autonomous-dev/...` path
resolves), then exercise the script with five paired self-tests (four
negative, one positive) on the working tree to confirm each check fires
correctly and the positive baseline passes cleanly.

## Functional Requirements

- **FR-1**: A new script MUST exist at `scripts/verify-spec-reconciliation.sh`
  with mode `0755` (executable). It MUST start with the shebang
  `#!/usr/bin/env bash` and `set -euo pipefail`. Task: PLAN-031-4 task 1.
- **FR-2**: The script MUST implement four checks in this order:
  1. **Check (1) — path drift**:
     `grep -rln "src/portal/" plugins/autonomous-dev/docs/specs/`. If non-empty,
     fail with `FAIL: src/portal/ references remain` plus the offending
     SPEC paths.
  2. **Check (2) — vitest**:
     `grep -rliEn "\bvitest\b" plugins/autonomous-dev/docs/specs/`. If
     non-empty, fail with `FAIL: vitest references remain` plus the
     offending SPEC paths. Case-insensitive, word-boundary anchored.
  3. **Check (3) — bats**:
     `grep -rlEn "\.bats|tests/unit/test_.*\.sh" plugins/autonomous-dev/docs/specs/`.
     If non-empty, fail with `FAIL: bats references remain` plus the
     offending SPEC paths.
  4. **Check (4) — path-existence**: For every cited
     `plugins/autonomous-dev[^[:space:]\`]+\.(ts|js|md|json|yml|yaml)` path
     under any SPEC in `docs/specs/`, run `test -e <path>`. Failures
     accumulate and are reported as `MISSING: <path>` lines, then a final
     `FAIL: N cited paths do not exist` summary.
- **FR-3**: On success, the script MUST exit 0 with final stdout line `PASS`.
- **FR-4**: On any check failure, the script MUST exit non-zero with the
  failing check's `FAIL: ...` message as the final stderr (or stdout) line.
  The script MUST NOT short-circuit silently: a failure in check (1) does
  not skip checks (2)–(4); failures are accumulated and the final exit
  code is non-zero if any check failed.
  - Implementation note: the simplest correct implementation runs each
    check, captures its outcome to a per-check status variable, prints
    failures as it goes, then exits non-zero if any status is non-zero.
- **FR-5**: The script MUST run successfully on macOS (BSD grep) and
  Linux (GNU grep). Where BSD/GNU `grep` flags differ, the script MUST
  use the POSIX-portable subset (`-E`, `-l`, `-n`, `-r`, `-i` are all
  POSIX-portable). Avoid `-P` (Perl regex), `--include`/`--exclude` long
  flags, and other GNU-only options.
- **FR-6**: The script MUST include a usage banner printed when invoked
  with `-h` or `--help`, naming the four checks and the local invocation
  hint.
- **FR-7**: Five local self-tests MUST be executed and documented in the
  matrix preamble's "Verification log" subsection:
  - **Negative test 1 (path drift)**: Add a temporary `src/portal/foo.ts`
    cite to a SPEC; run script; confirm it fails with check (1)'s
    message; revert the SPEC.
  - **Negative test 2 (vitest)**: Add a temporary `vitest` mention; run;
    confirm check (2) fails; revert.
  - **Negative test 3 (bats)**: Add a temporary `.bats` reference; run;
    confirm check (3) fails; revert.
  - **Negative test 4 (path-existence)**: Add a fictional
    `plugins/autonomous-dev/never-existed.ts` cite; run; confirm check (4)
    fails naming the missing path; revert.
  - **Positive test**: Run on the clean tree; confirm `PASS`.
  Task: PLAN-031-4 task 2.
- **FR-8**: After the five self-tests, the working tree MUST be clean
  (`git status` reports no SPEC modifications). Any failure to revert a
  scratch edit is a hard failure of this spec.

## Non-Functional Requirements

| Requirement | Target | Measurement Method |
|-------------|--------|---------------------|
| Script execution latency | < 500 ms on a clean tree | `time bash scripts/verify-spec-reconciliation.sh` |
| Cross-platform parity | PASS/FAIL parity across macOS BSD-grep and Linux GNU-grep | Self-test on both platforms; both produce identical exit codes for identical inputs |
| Failure-message actionability | Every FAIL line names the offending file/path | Self-test outputs reviewed for SPEC paths and missing-path strings |
| Idempotence | Re-running the script on a clean tree yields identical output | `bash scripts/verify-spec-reconciliation.sh > a; bash ... > b; diff a b` is empty |
| Script size | < 100 lines (excluding comments) | `wc -l` |

## Patterns to Find/Replace

This spec performs no SPEC content substitutions. It authors a new
infrastructure file.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `scripts/verify-spec-reconciliation.sh` | Create | New executable bash script implementing the four TDD §5.4 checks |
| `plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md` | Modify | Append "Verification log" subsection with the five self-test results |

## Verification Commands

```bash
# 1. Script exists, is executable, has correct shebang
test -x scripts/verify-spec-reconciliation.sh
head -1 scripts/verify-spec-reconciliation.sh | grep -q "^#!/usr/bin/env bash$"
grep -q "set -euo pipefail" scripts/verify-spec-reconciliation.sh

# 2. Help banner works
bash scripts/verify-spec-reconciliation.sh --help | grep -qi "verify"

# 3. Positive run on clean tree
bash scripts/verify-spec-reconciliation.sh
test "$?" = "0"

# 4. Negative test 1: path drift
cp plugins/autonomous-dev/docs/specs/SPEC-031-1-01-*.md /tmp/scratch-spec.md.bak
echo "scratch: src/portal/foo.ts" >> plugins/autonomous-dev/docs/specs/SPEC-031-1-01-*.md
! bash scripts/verify-spec-reconciliation.sh > /tmp/out 2>&1
grep -q "FAIL: src/portal/" /tmp/out
git checkout -- plugins/autonomous-dev/docs/specs/SPEC-031-1-01-*.md

# 5. Negative test 2: vitest
echo "scratch: vitest" >> plugins/autonomous-dev/docs/specs/SPEC-031-1-01-*.md
! bash scripts/verify-spec-reconciliation.sh > /tmp/out 2>&1
grep -qi "vitest" /tmp/out
git checkout -- plugins/autonomous-dev/docs/specs/SPEC-031-1-01-*.md

# 6. Negative test 3: bats
echo "scratch: tests/unit/test_foo.sh" >> plugins/autonomous-dev/docs/specs/SPEC-031-1-01-*.md
! bash scripts/verify-spec-reconciliation.sh > /tmp/out 2>&1
grep -q "bats" /tmp/out
git checkout -- plugins/autonomous-dev/docs/specs/SPEC-031-1-01-*.md

# 7. Negative test 4: path-existence
echo "scratch: plugins/autonomous-dev/never-existed.ts" >> plugins/autonomous-dev/docs/specs/SPEC-031-1-01-*.md
! bash scripts/verify-spec-reconciliation.sh > /tmp/out 2>&1
grep -q "MISSING: plugins/autonomous-dev/never-existed.ts" /tmp/out
git checkout -- plugins/autonomous-dev/docs/specs/SPEC-031-1-01-*.md

# 8. Working tree clean after self-tests
test -z "$(git status --porcelain plugins/autonomous-dev/docs/specs/)"

# 9. Verification log subsection exists in matrix
grep -A 12 "Verification log" \
  plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md \
  | grep -c "test"   # >= 5 lines (one per self-test)
```

## Acceptance Criteria

```
Given a clean post-PLAN-031-3 working tree
When `bash scripts/verify-spec-reconciliation.sh` runs
Then the script exits 0
And the final line of stdout is `PASS`
And total runtime is < 500 ms
```

```
Given a SPEC contains a `src/portal/` reference
When the script runs
Then check (1) fails with `FAIL: src/portal/ references remain`
And the offending SPEC path is named in the failure output
And the script exits non-zero
```

```
Given a SPEC contains a `vitest` token (case-insensitive, word-boundary)
When the script runs
Then check (2) fails with a vitest-references-remain message
And the script exits non-zero
```

```
Given a SPEC contains a `.bats` or `tests/unit/test_*.sh` reference
When the script runs
Then check (3) fails with a bats-references-remain message
And the script exits non-zero
```

```
Given a SPEC cites a `plugins/autonomous-dev/...` path that does not exist on disk
When the script runs
Then check (4) emits `MISSING: <path>` for that path
And the final summary line states `FAIL: N cited paths do not exist` with N >= 1
And the script exits non-zero
```

```
Given multiple checks fail simultaneously
When the script runs
Then all failing checks emit their FAIL lines (no short-circuit)
And the script exits non-zero
And the final exit code reflects "any check failed", not just the first one
```

```
Given the script is invoked with `--help` or `-h`
When the script runs
Then a usage banner is printed
And the four checks are named
And the script exits 0
```

```
Given the five paired self-tests are executed
When each test completes
Then the matrix preamble's "Verification log" subsection records the test name, expected outcome, and observed outcome
And after all five tests, `git status` over docs/specs/ reports zero modifications
```

## Rollback Plan

If the script has structural issues (e.g., shebang wrong, syntax error,
flag incompatibility), revert it:
```bash
git checkout -- scripts/verify-spec-reconciliation.sh
# OR
rm scripts/verify-spec-reconciliation.sh
```
Re-author from the TDD §5.4 reference implementation.

If a self-test scratch edit fails to revert (FR-8 violation):
```bash
git checkout -- plugins/autonomous-dev/docs/specs/
```
Re-run the affected self-test before proceeding.

If the matrix preamble's Verification log subsection has wrong content,
revert that subsection only:
```bash
git checkout -- plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md
```

## Implementation Notes

- The TDD §5.4 reference implementation is a starting point, not a
  drop-in copy. The reference uses `grep -rohE` for check (4); confirm
  this works on BSD grep (it should — `-o` and `-h` are POSIX) before
  shipping. If portability concerns arise, fall back to a per-file loop.
- Per OQ-31-07: the script's check (4) MAY surface pre-existing path
  drift in SPECs not part of the TDD-031 drift classes (e.g., a typo
  cite). When the check fails, the surfaced drift is reconciled in this
  PR by adding a row to the matrix and amending the SPEC. SPEC-031-4-03
  handles aggregation; this spec only authors the script and confirms it
  fires.
- Use `mktemp` for temporary file paths in self-tests; do not assume
  `/tmp/out` is writable on every runner. (CI runners are; macOS is;
  some hardened systems are not.)
- The path-existence regex
  (`plugins/autonomous-dev[^[:space:]\`]+\.(ts|js|md|json|yml|yaml)`)
  intentionally excludes paths inside backticks-followed-by-space
  (template literals) and stops at whitespace. If the regex over-matches
  on a SPEC's prose, the per-SPEC fix is to wrap the false positive in
  a placeholder syntax (e.g., `<example-path>`); do NOT loosen the regex.
- Five paired self-tests (four negative, one positive) are the minimum
  contractual coverage. Adding more tests is fine; removing any is a
  contract violation.

## Out of Scope

- Wiring the script into CI (handled by SPEC-031-4-02).
- The throwaway-branch CI self-test (handled by SPEC-031-4-02).
- Authoring the PR description's per-SPEC summary (handled by SPEC-031-4-03).
- Updating the matrix preamble's enforcement-mechanism note (handled by
  SPEC-031-4-03).
- Modifying SPECs to fix any drift surfaced by check (4) — surfaced drift
  is aggregated into the PR by SPEC-031-4-03's matrix rows (per OQ-31-07).
- Modifying the existing TDD-029 CI gate (sibling concern).
- Writing unit tests for the bash script (TDD §9.4: contractual coverage
  via the paired self-tests is sufficient).
