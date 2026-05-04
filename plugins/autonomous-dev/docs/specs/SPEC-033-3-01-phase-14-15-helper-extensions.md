# SPEC-033-3-01: Phase 14/15 Helper Extensions (idempotency-checks)

## Metadata
- **Parent Plan**: PLAN-033-3
- **Parent TDD**: TDD-033 §6.5, §6.6
- **Tasks Covered**: PLAN-033-3 Task 1
- **Estimated effort**: 0.25 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-02

## 1. Summary

Extend `lib/idempotency-checks.sh` with two read-only helpers used by
phase 14 (engineering standards) and phase 15 (specialist reviewer
chains): `standards_yaml_exists_at` and `reviewer_chain_yaml_matches`.
Both follow the same `start-fresh` / `resume-with-diff` /
`already-complete` return contract used elsewhere in the wizard.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                            | Task |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | `lib/idempotency-checks.sh` MUST gain function `standards_yaml_exists_at <path>` that emits one of the strings `start-fresh`, `resume-with-diff`, or `already-complete` to stdout. | T1   |
| FR-2  | `standards_yaml_exists_at` returns `start-fresh` if the file at `<path>` does not exist. | T1   |
| FR-3  | `standards_yaml_exists_at` returns `already-complete` if the file exists AND `autonomous-dev standards validate --repo <repo-of-path>` returns exit 0. | T1   |
| FR-4  | `standards_yaml_exists_at` returns `resume-with-diff` if the file exists but `standards validate` returns non-zero (file present but invalid OR present with a schema mismatch operator must reconcile). | T1   |
| FR-5  | `lib/idempotency-checks.sh` MUST gain function `reviewer_chain_yaml_matches <path> <expected-sha256>` that emits `start-fresh` / `resume-with-diff` / `already-complete`. | T1   |
| FR-6  | `reviewer_chain_yaml_matches` returns `start-fresh` if file missing, `already-complete` if `sha256` matches, `resume-with-diff` if file exists with a different hash. | T1   |
| FR-7  | Both helpers MUST be read-only: a fs-snapshot diff before/after invocation MUST show 0 changes inside `~/.autonomous-dev/`, the operator's repo, and any temp directory. | T1   |
| FR-8  | Both helpers MUST have docstrings (`# usage:`, `# returns:`, `# example:`) and bats truth-table tests covering missing / outdated / matching states. | T1   |
| FR-9  | The helpers MUST be portable across bash 4 (Linux) and bash 5 (macOS Homebrew). | T1   |
| FR-10 | If `autonomous-dev` CLI is missing (PATH lookup fails) when `standards_yaml_exists_at` is invoked, the helper MUST exit 2 (not stdout-emit) and write `autonomous-dev-cli-missing` to stderr. The orchestrator treats exit 2 as an abort condition (matching SPEC-033-2-01 FR-9 convention). | T1   |

## 3. Non-Functional Requirements

| Requirement                       | Target                                                                  | Measurement Method                                                |
|-----------------------------------|-------------------------------------------------------------------------|-------------------------------------------------------------------|
| Read-only invariant               | 0 fs writes during any helper call                                      | fs-snapshot diff bats test                                        |
| Probe latency                     | < 500 ms p95 for a present-and-valid file                                | bats wall-clock measurement                                       |
| bash compatibility                | Pass on bash 4 + bash 5                                                  | CI matrix                                                         |
| `autonomous-dev` invocation cap   | ≤ 1 invocation per probe                                                 | counter via shim                                                  |

## 4. Technical Approach

**File modified:** `plugins/autonomous-dev-assist/skills/setup-wizard/lib/idempotency-checks.sh`.

**Function shapes:**

```bash
# standards_yaml_exists_at <path>
# usage: standards_yaml_exists_at /repo/.autonomous-dev/standards.yaml
# returns stdout: start-fresh | resume-with-diff | already-complete
# returns exit:    0 (always for the three normal returns); 2 if autonomous-dev CLI missing
standards_yaml_exists_at() {
  local path="$1"
  [[ -f "$path" ]] || { echo "start-fresh"; return 0; }
  command -v autonomous-dev >/dev/null 2>&1 \
    || { echo "autonomous-dev-cli-missing" >&2; return 2; }
  local repo
  repo="$(dirname "$(dirname "$path")")"  # standards.yaml lives at <repo>/.autonomous-dev/standards.yaml
  if autonomous-dev standards validate --repo "$repo" >/dev/null 2>&1; then
    echo "already-complete"
  else
    echo "resume-with-diff"
  fi
}

# reviewer_chain_yaml_matches <path> <expected-sha256>
reviewer_chain_yaml_matches() {
  local path="$1" expected="$2"
  [[ -f "$path" ]] || { echo "start-fresh"; return 0; }
  local actual
  actual="$(_sha256 "$path" | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] && echo "already-complete" || echo "resume-with-diff"
}

# _sha256: defined in SPEC-033-2-01 (Linux sha256sum / macOS shasum -a 256 wrapper)
```

**Read-only proof:**
- `standards_yaml_exists_at` invokes `autonomous-dev standards validate --repo <r>` which is contracted (TDD-021) as a read-only operation. The bats test stubs the CLI with a tracer that asserts no fs writes during invocation.
- `reviewer_chain_yaml_matches` reads the file once via `sha256sum`/`shasum`; no writes.

## 5. Interfaces and Dependencies

**Consumed:**
- SPEC-033-1-02: existing `lib/idempotency-checks.sh` skeleton.
- SPEC-033-2-01: `_sha256` portable wrapper.
- TDD-021: `autonomous-dev standards validate --repo` CLI surface (contract: read-only, exit 0 on schema match, non-zero on mismatch / file invalid).

**Produced:**
- Two new helper functions appended to `idempotency-checks.sh`.
- Test groups appended to `tests/setup-wizard/idempotency-checks.bats`.

## 6. Acceptance Criteria

### `standards_yaml_exists_at` truth table (FR-1–FR-4, FR-10)

```
Given file path /tmp/repo/.autonomous-dev/standards.yaml does not exist
When standards_yaml_exists_at /tmp/repo/.autonomous-dev/standards.yaml runs
Then stdout is "start-fresh"
And exit code is 0

Given file exists AND `autonomous-dev standards validate --repo /tmp/repo` returns exit 0
Then stdout is "already-complete"

Given file exists AND validate returns exit 1
Then stdout is "resume-with-diff"

Given autonomous-dev CLI is not on PATH AND file exists
Then exit code is 2
And stderr contains "autonomous-dev-cli-missing"
And stdout is empty
```

### `reviewer_chain_yaml_matches` truth table (FR-5, FR-6)

```
Given file does not exist
Then stdout is "start-fresh"

Given file exists with sha256 == expected
Then stdout is "already-complete"

Given file exists with different sha256
Then stdout is "resume-with-diff"
```

### Read-only invariant (FR-7, NFR read-only)

```
Given a snapshot of ~/.autonomous-dev, the operator repo dir, and /tmp before invocation
When either helper runs
Then a post-invocation diff of all three locations shows 0 changed/created files
```

### Probe latency (NFR latency)

```
Given a valid standards.yaml + working autonomous-dev CLI
When standards_yaml_exists_at is invoked 10 times
Then the p95 wall-clock duration is < 500 ms
```

### bash 4/5 compatibility (FR-9, NFR bash compat)

```
Given the bats suite runs on a Linux runner with bash 4
Then all truth-table tests pass

Given the bats suite runs on a macOS runner with bash 5
Then all truth-table tests pass
```

## 7. Test Requirements

**bats — `tests/setup-wizard/idempotency-checks.bats` (extended):**

| Test ID  | Scenario                                       | Assert                                     |
|----------|------------------------------------------------|--------------------------------------------|
| IC-701   | standards: file missing                        | stdout "start-fresh"                       |
| IC-702   | standards: file exists + validate exit 0       | stdout "already-complete"                  |
| IC-703   | standards: file exists + validate exit 1       | stdout "resume-with-diff"                  |
| IC-704   | standards: CLI missing                         | exit 2; stderr "autonomous-dev-cli-missing"|
| IC-801   | chain: file missing                            | stdout "start-fresh"                       |
| IC-802   | chain: hash matches                            | stdout "already-complete"                  |
| IC-803   | chain: hash differs                            | stdout "resume-with-diff"                  |
| IC-901   | Read-only invariant (both helpers)             | fs-snapshot diff empty                     |
| IC-A01   | Latency p95 < 500ms                            | wall-clock measurement                     |

**Mocking:**
- `autonomous-dev` shim with controllable exit code.
- A test repo fixture under `tests/fixtures/setup-wizard/repos/standards-*` with valid + invalid `.autonomous-dev/standards.yaml` files.

## 8. Implementation Notes

- `standards_yaml_exists_at` derives the repo path by going up two levels from the file path (`<repo>/.autonomous-dev/standards.yaml`). If callers pass a non-standard path layout, document the contract: the helper assumes the canonical layout.
- The `autonomous-dev standards validate --repo` CLI may not exist if TDD-021 hasn't shipped that subcommand. Implementer MUST verify the surface exists at PR time; if missing, this SPEC is blocked on TDD-021's spec landing.
- The helpers do NOT diff the file's contents against an "expected" template — that's the caller's job. These probes only answer "does the file exist and is it currently valid?" / "does it match this hash?".
- The helpers MUST NOT be used to write or repair config — read-only only.

## 9. Rollout Considerations

- These helpers ship as infrastructure (no feature flag); inert until phase 14 / 15 invokes them.
- Helpers are independent — phase 14 uses only `standards_yaml_exists_at`; phase 15 uses only `reviewer_chain_yaml_matches`. They are co-located in `idempotency-checks.sh` for organizational simplicity.

## 10. Effort Estimate

| Activity                                      | Estimate |
|-----------------------------------------------|----------|
| Helper implementations                        | 0.1 day  |
| bats tests (9+ cases)                         | 0.15 day |
| **Total**                                     | **0.25 day** |
