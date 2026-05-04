# SPEC-028-1-06: Retroactive Schema Validation and Meta-Lint Smoke Test

## Metadata
- **Parent Plan**: PLAN-028-1
- **Parent TDD**: TDD-028 §15.1, OQ-5
- **Tasks Covered**: PLAN-028-1 task 2 (retroactive validation), task 9 (smoke test)
- **Estimated effort**: 4 hours
- **Status**: Draft

## Summary
Author the one-off retroactive validation script that runs `eval-case-v1.json`
against every existing eval-case YAML (4 reviewer suites = 90 cases + 4 existing
assist suites), capturing any legacy violations. Then perform the meta-lint
smoke test that exercises the five enforcement rules (frontmatter, schema,
case_minimum, negative_minimum, malformed YAML) by introducing one violation at
a time into a temporary suite and confirming meta-lint produces the expected
FAIL output. Captures both results as PR-description artefacts. No legacy
violation blocks this PR (per OQ-5).

## Functional Requirements

| ID | Requirement | Task |
|----|-------------|------|
| FR-1 | A script MUST exist at `plugins/autonomous-dev-assist/evals/schema/validate-existing.sh` that walks `evals/test-cases/*.yaml`, transforms each case to JSON, and validates against `eval-case-v1.json`. | T2 |
| FR-2 | The script MUST emit, per file, a Markdown summary line: `[OK] <file>: N cases pass` or `[VIOLATIONS] <file>: <count> issues — <comma-separated rule names>`. | T2 |
| FR-3 | The script MUST exit 0 unconditionally (legacy violations are informational, not blocking — per OQ-5). | T2 |
| FR-4 | The script MUST emit a JSON artefact at `evals/schema/.retroactive-results.json` with shape `{ "files": [{ "path": "...", "case_count": N, "violations": [...] }], "totals": { "files": F, "cases": C, "violations": V } }`. | T2 |
| FR-5 | The script's output MUST be captured in the PR description as a fenced code block; any non-zero violation count is filed as a separate follow-up ticket linked from the PR. | T2 |
| FR-6 | A smoke-test driver MUST exist at `plugins/autonomous-dev-assist/evals/schema/smoke-test-meta-lint.sh` that exercises five named scenarios (S1..S5) against meta-lint and asserts pass/fail. | T9 |
| FR-7 | Smoke scenario S1 (clean pass) MUST: register a temporary suite `_smoke.yaml` conforming to the schema with 5 cases including 5 negatives; run meta-lint; assert exit 0. | T9 |
| FR-8 | Smoke scenario S2 (missing schema field) MUST: omit `schema:` from the temporary suite frontmatter; assert meta-lint exits 1 with finding rule=`frontmatter`. | T9 |
| FR-9 | Smoke scenario S3 (below case_minimum) MUST: declare `case_minimum: 10` in frontmatter but include 3 cases; assert meta-lint exits 1 with finding rule=`case_minimum`. | T9 |
| FR-10 | Smoke scenario S4 (below negative_minimum) MUST: declare `negative_minimum: 5` in frontmatter but include 0 negative cases; assert meta-lint exits 1 with finding rule=`negative_minimum`. | T9 |
| FR-11 | Smoke scenario S5 (malformed id) MUST: include one case with id `BadId`; assert meta-lint exits 1 with finding rule=`schema` referencing path `/id`. | T9 |
| FR-12 | The smoke-test driver MUST automatically register the temporary suite in `eval-config.yaml` before each scenario, run meta-lint, parse the JSON output, and revert the registration afterwards (idempotent / no permanent edit). | T9 |
| FR-13 | All 5 smoke scenarios MUST be captured in the PR description as a 5-row table: scenario | rule violated | actual exit | actual finding rule | PASS/FAIL. | T9 |

## Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| Retroactive script runtime | <10 s for ≤200 cases across 8 files | `time bash validate-existing.sh` |
| Smoke-test runtime | <15 s for all 5 scenarios end-to-end | `time bash smoke-test-meta-lint.sh` |
| Idempotency | After `smoke-test-meta-lint.sh` runs, `eval-config.yaml` and `evals/test-cases/` are bit-identical to pre-run state | `git status --porcelain` is empty |
| Shellcheck cleanliness | 0 warnings on both scripts | `shellcheck validate-existing.sh smoke-test-meta-lint.sh` |
| Determinism | Three back-to-back runs of each script produce byte-identical JSON output | Diff of three runs |
| No regression | Existing 90 reviewer cases remain unmodified | `git diff` shows no change to `*-reviewer-eval.yaml` |

## Files to Create

- **Path**: `plugins/autonomous-dev-assist/evals/schema/validate-existing.sh`
- **Path**: `plugins/autonomous-dev-assist/evals/schema/smoke-test-meta-lint.sh`

## Technical Approach

### `validate-existing.sh` shape

```bash
#!/usr/bin/env bash
# validate-existing.sh — retroactive schema validation per SPEC-028-1-06.
# Walks all eval-case YAMLs, validates against eval-case-v1.json, emits
# Markdown summary + JSON artefact. Exits 0 unconditionally per OQ-5.
set -euo pipefail

SCHEMA="plugins/autonomous-dev-assist/evals/schema/eval-case-v1.json"
TEST_CASES_DIR="plugins/autonomous-dev-assist/evals/test-cases"
RESULTS_JSON="plugins/autonomous-dev-assist/evals/schema/.retroactive-results.json"

# Iterate test-cases/*.yaml; for each, parse, transform each case to JSON,
# validate via ajv (or python3 -c 'import jsonschema; ...'), accumulate results.
# Emit Markdown summary to stdout; write JSON to $RESULTS_JSON.
# Exit 0 unconditionally (informational mode).
```

The script MAY use `yq` (preferred) or `python3` with `pyyaml` + `jsonschema` as
a fallback. Document the dependency in the script header. The implementer
chooses the lower-friction tool that the PRD-010 CI runner already provides.

### `smoke-test-meta-lint.sh` shape

```bash
#!/usr/bin/env bash
# smoke-test-meta-lint.sh — exercises the 5 meta-lint enforcement rules.
# For each scenario:
#   1. Write a temporary suite YAML to evals/test-cases/_smoke.yaml.
#   2. Add a temporary suite registration to eval-config.yaml.
#   3. Run `bash evals/meta-lint.sh --json` and capture exit code + JSON.
#   4. Assert expected exit code and finding rule.
#   5. Revert eval-config.yaml and delete _smoke.yaml.
# Trap EXIT to ensure cleanup even on failure.
set -euo pipefail

SUITE_FILE="plugins/autonomous-dev-assist/evals/test-cases/_smoke.yaml"
CONFIG_FILE="plugins/autonomous-dev-assist/evals/eval-config.yaml"
CONFIG_BACKUP="$(mktemp)"

cleanup() {
  cp "$CONFIG_BACKUP" "$CONFIG_FILE" || true
  rm -f "$SUITE_FILE" "$CONFIG_BACKUP"
}
trap cleanup EXIT

cp "$CONFIG_FILE" "$CONFIG_BACKUP"

# Scenario S1..S5 implemented as functions returning pass/fail.
# Final summary table emitted to stdout; exit 0 if all 5 PASS, 1 otherwise.
```

### Smoke-test scenario fixtures (inline in the script)

Each scenario writes a fresh `_smoke.yaml`. The base template (S1, clean):

```yaml
suite: _smoke
skill: assist
description: "Smoke test"
schema: eval-case-v1
case_minimum: 5
negative_minimum: 5
cases:
  - id: smoke-negative-001
    category: negative
    difficulty: medium
    question: "Bogus question one?"
    expected_topics: ["fake"]
    must_mention: []
    must_not_mention: ["forbidden-pattern-1"]
  # ... 4 more negative cases
```

S2-S5 are mutations of this template with one rule violated per scenario.

### Retroactive validation procedure

1. After SPEC-028-1-01 (schema) and SPEC-028-1-05 (fixtures) land, run `bash plugins/autonomous-dev-assist/evals/schema/validate-existing.sh`.
2. Capture stdout (Markdown summary) and `.retroactive-results.json`.
3. Paste both into PR description.
4. For any file with `[VIOLATIONS]`, file a follow-up ticket linked from the PR. Do NOT modify the legacy file in this PR.

### Smoke-test procedure

1. Run `bash plugins/autonomous-dev-assist/evals/schema/smoke-test-meta-lint.sh`.
2. Confirm 5/5 scenarios PASS (i.e., meta-lint produced the expected exit code and finding rule for each).
3. Paste the 5-row summary table into PR description.

## Acceptance Criteria

```
Given validate-existing.sh exists and is executable
When run from the repo root
Then exit code is 0 unconditionally
And stdout contains one summary line per file under evals/test-cases/
And evals/schema/.retroactive-results.json is created with totals.files >= 4
```

```
Given .retroactive-results.json after a run
When parsed
Then it has top-level keys "files" and "totals"
And totals.files equals the number of test-cases YAMLs
And totals.cases equals the sum of per-file case_count
And totals.violations equals the sum of per-file violation count
```

```
Given a legacy file passes the schema cleanly
When validate-existing.sh processes it
Then the summary line is "[OK] <file>: N cases pass"
And no entry for that file appears in the violations list
```

```
Given a legacy file has one or more schema violations
When validate-existing.sh processes it
Then the summary line is "[VIOLATIONS] <file>: <count> issues — <rule names>"
And the script still exits 0
And the violations are listed in the JSON artefact for that file
And a follow-up ticket is filed linked from the PR
```

```
Given smoke-test-meta-lint.sh exists and is executable
When run from the repo root
Then exit code is 0 if all 5 scenarios PASS, 1 otherwise
And stdout contains a 5-row table (S1..S5) with columns: scenario, rule, exit, finding, PASS/FAIL
And eval-config.yaml is bit-identical to its pre-run state
And evals/test-cases/_smoke.yaml does not exist after the run
```

```
Given scenario S1 (clean pass)
When the temporary suite has 5 cases and all schema requirements met
Then meta-lint exits 0
And no findings are emitted for the _smoke suite
```

```
Given scenario S2 (missing schema field)
When the frontmatter omits "schema:"
Then meta-lint exits 1
And findings include rule="frontmatter" for the _smoke suite
And the finding's message names the missing field "schema"
```

```
Given scenario S3 (below case_minimum)
When frontmatter declares case_minimum=10 but only 3 cases are present
Then meta-lint exits 1
And findings include rule="case_minimum" for the _smoke suite
And the finding's actual=3 expected=10
```

```
Given scenario S4 (below negative_minimum)
When frontmatter declares negative_minimum=5 but no case has must_not_mention non-empty
Then meta-lint exits 1
And findings include rule="negative_minimum" for the _smoke suite
And the finding's actual=0 expected=5
```

```
Given scenario S5 (malformed id)
When one case has id="BadId"
Then meta-lint exits 1
And findings include rule="schema" for that case
And the error path is /id
```

```
Given an unexpected interruption mid-run (kill -INT)
When the trap fires
Then eval-config.yaml is restored from the backup
And _smoke.yaml is deleted
And no artefact persists in the working tree
```

## Test Requirements

- **Retroactive script unit test**: Run against the existing 8 suite files; assert script exits 0 and produces the JSON artefact.
- **Smoke-test scenario coverage**: 5 scenarios, each producing the expected exit code and finding rule. Captured as a table.
- **Idempotency test**: Run `smoke-test-meta-lint.sh` twice in succession; second run produces identical output and `git status` is clean both times.
- **Trap-cleanup test**: Run `smoke-test-meta-lint.sh` with `--inject-fail-S3` (a debug flag that aborts S3 mid-execution); assert cleanup still restores eval-config.yaml.
- **Shellcheck**: Both scripts pass `shellcheck -e SC1090,SC2086` (or with documented exception comments only).

## Implementation Notes

- The retroactive script is intentionally informational, not blocking. The TDD-028 OQ-5 explicitly states that legacy violations are NOT a merge gate for this PR.
- The smoke test rebuilds `_smoke.yaml` from scratch for each scenario rather than mutating in place; cleaner and easier to audit.
- Cleanup uses `cp` of a backup rather than `git checkout` because the script must work in environments without a git working tree (e.g., CI building from a tarball, theoretical).
- The script names "_smoke" with a leading underscore so any sort/glob in `eval-config.yaml` keeps it lexically last and obvious if accidentally committed.
- The smoke test must run AFTER SPEC-028-1-02 (meta-lint) and SPEC-028-1-03 (eval-config registration) have landed; otherwise meta-lint and config don't exist for it to drive.
- If `meta-lint --json` does not yet support a `--allow-baseline-deficit` flag, S3 (case_minimum) will produce the documented FAIL exit and finding — that's the desired behavior. The flag is for production CI; the smoke test wants the raw FAIL.

## Rollout Considerations

- Both scripts are idempotent and self-contained; no rollout coordination needed.
- The retroactive results JSON (`.retroactive-results.json`) is added to `.gitignore` at the schema/ level since it's a generated artefact (or kept committed as a snapshot reviewer aid — implementer chooses; document choice in PR).
- Rollback: revert the commit; meta-lint and the schema continue to function (these scripts are observability + verification, not on the runtime path).

## Dependencies

- **Blocked by**: SPEC-028-1-01 (schema), SPEC-028-1-02 (meta-lint), SPEC-028-1-03 (eval-config), SPEC-028-1-05 (fixtures used as a reference).
- **Exposes to**: PR description artefacts; any follow-up tickets for legacy violations.

## Out of Scope

- Modifying any existing `*-reviewer-eval.yaml` or assist suite YAMLs (regression-stable per NG-07).
- Authoring meta-lint itself (SPEC-028-1-02).
- Authoring the schema (SPEC-028-1-01).
- Authoring fixtures (SPEC-028-1-05).
- CI integration of the smoke test (SPEC-028-1-04 covers the meta-lint CI gate; smoke test is a one-time author-side verification, not a recurring CI job).
