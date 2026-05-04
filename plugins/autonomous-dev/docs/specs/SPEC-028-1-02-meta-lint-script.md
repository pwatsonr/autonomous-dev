# SPEC-028-1-02: Meta-Lint Script for Eval Suite Validation

## Metadata
- **Parent Plan**: PLAN-028-1
- **Parent TDD**: TDD-028 §9
- **Tasks Covered**: Task 3 (meta-lint authoring), Task 9 (smoke tests)
- **Estimated effort**: 6 hours (4 authoring + 2 smoke tests)
- **Status**: Draft

## Summary
Author `plugins/autonomous-dev-assist/evals/meta-lint.sh`, a CI-time linter that walks every registered eval suite, validates frontmatter and per-case schema conformance against `eval-case-v1.json`, enforces `case_minimum` and `negative_minimum` floors, and emits both human-readable and JSON output. The script is the gate that prevents schema drift across the eight assist suites and is invoked from CI on any PR touching `plugins/autonomous-dev-assist/evals/**`.

## Functional Requirements

| ID | Requirement | Task |
|----|-------------|------|
| FR-1 | The script MUST be executable bash with `set -euo pipefail`. | T3 |
| FR-2 | The script MUST parse `evals/eval-config.yaml` and walk each entry under `suites:` whose `enabled: true`. | T3 |
| FR-3 | For each registered suite, the script MUST validate the suite YAML's top-level frontmatter: `suite` (string, matches registration key), `schema: eval-case-v1` (literal), `case_minimum` (integer ≥1), `negative_minimum` (integer ≥0). | T3 |
| FR-4 | For each case in a suite, the script MUST validate the case object against `evals/schema/eval-case-v1.json`. | T3 |
| FR-5 | The script MUST count cases per suite and FAIL the suite if `count < case_minimum`. | T3 |
| FR-6 | The script MUST count `must_not_mention` array entries summed across all cases in the suite and FAIL if `count < negative_minimum`. | T3 |
| FR-7 | The script MUST emit a per-suite human-readable line: `[OK] <suite> (<n> cases, <m> negative)` on PASS or `[FAIL] <suite>: <reason>` on FAIL. | T3 |
| FR-8 | The script MUST exit `0` if all suites pass, `1` if any suite fails, `2` on internal errors (missing config, missing schema, malformed YAML). | T3 |
| FR-9 | A `--json` flag MUST switch output to a JSON document with shape `{"pass": <bool>, "findings": [<finding>...], "suites": {<suite-name>: {"pass": <bool>, "case_count": <int>, "negative_count": <int>, "errors": [...]}}}`. | T3 |
| FR-10 | A `--allow-baseline-deficit` flag MUST downgrade `case_minimum` violations to warnings (still listed in findings, but exit 0) — used by SPEC-028-2-* and SPEC-028-3-* PRs that ship frontmatter before sibling case bodies. | T3 |
| FR-11 | The script MUST be idempotent (running twice produces identical output for unchanged inputs). | T3 |
| FR-12 | A smoke-test scaffold MUST exercise five enforcement rules (missing schema field, below case_minimum, below negative_minimum, malformed id, unknown category) by introducing each violation in a temporary suite YAML and confirming the matching meta-lint failure. | T9 |

## Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| Runtime against 8 suites (~200 cases) | < 5 s on a developer laptop | `time bash meta-lint.sh` |
| Shellcheck score | Zero warnings, zero errors | `shellcheck meta-lint.sh` |
| External dependencies | `bash` ≥4, `yq` v4 OR `python3` (both must be tried as fallback), `jq`, `ajv` (Node) OR `python3 -m jsonschema` (fallback) | Header doc-comment lists them |
| Memory footprint | < 100 MB peak | `time -v` resident set size |
| Output JSON validity (under `--json`) | 100% valid JSON parseable by `jq` | `bash meta-lint.sh --json | jq .` returns 0 |

## Files to Create

- **Path**: `plugins/autonomous-dev-assist/evals/meta-lint.sh`
  - **Action**: Create
  - **Description**: ~120-line bash script implementing all FR-1 through FR-11. Header includes shebang, strict mode, dependency-detection block (yq/python fallback, ajv/jsonschema fallback), CLI parser, suite walker, validator, output emitter.

## Technical Approach

### Script structure
1. **Header**: shebang `#!/usr/bin/env bash`, `set -euo pipefail`, doc-comment listing dependencies and exit codes.
2. **CLI parsing**: support `--json`, `--allow-baseline-deficit`, `--config <path>` (default `evals/eval-config.yaml`), `--schema <path>` (default `evals/schema/eval-case-v1.json`), `--help`.
3. **Dependency detection**: probe `yq` then `python3`; probe `ajv` then `python3 -m jsonschema`. Set `YAML_TO_JSON` and `VALIDATOR` function variables. Fail with exit 2 if neither tool is available.
4. **Config parse**: extract enabled suites from `eval-config.yaml` via `yq '.suites | to_entries | .[] | select(.value.enabled == true) | .key' -o=tsv` (yq) or python equivalent. Capture `case_minimum`, `negative_minimum`, `file` per suite.
5. **Per-suite walk**:
   - Load `<suite-file>.yaml`. Extract frontmatter mapping (top-level keys excluding `cases`).
   - Validate frontmatter: presence of `suite`, `schema`, `case_minimum`, `negative_minimum`. Type-check.
   - Extract `cases` array. For each case:
     - Convert to JSON.
     - Validate against schema. Capture errors.
   - Count cases. Compare to `case_minimum`.
   - Sum `len(case.must_not_mention)` across cases. Compare to `negative_minimum`.
6. **Findings aggregation**: maintain a findings array (per-suite, per-rule). Each finding has `suite`, `rule` (one of `frontmatter|schema|case_minimum|negative_minimum`), `message`, `severity` (`error|warning`).
7. **Output emit**:
   - Default mode: per-suite line as in FR-7, then a summary line (`Total: <n> suites, <p> pass, <f> fail`).
   - `--json` mode: structured document per FR-9.
8. **Exit code logic**: 0 if all suites pass OR (under `--allow-baseline-deficit`) all violations are `case_minimum` only. 1 otherwise. 2 on internal error.

### Smoke-test scaffold (T9)
1. Create a temp dir; copy `eval-config.yaml` and the schema; add a temp suite YAML matching schema (`_smoke.yaml`) with 5 cases (5 negatives).
2. Run `meta-lint.sh --config <tempconfig>`. Expect exit 0.
3. Mutate one rule at a time and re-run. Expected results:
   - Remove `schema:` line → exit 1, finding rule `frontmatter`.
   - Drop case count to 3 (below default `case_minimum: 5`) → exit 1, finding rule `case_minimum`.
   - Drop negative count to 3 (below 5) → exit 1, finding rule `negative_minimum`.
   - Mutate one case's id to `BadId123` → exit 1, finding rule `schema`.
   - Mutate one case's category to `philosophy` → exit 1, finding rule `schema`.
4. Capture the 5 outputs in the PR description as verification evidence.

## Acceptance Criteria

```
Given evals/meta-lint.sh exists and is +x
When invoked with no arguments against a clean fixture set
Then exit code is 0
And stdout includes "[OK] <suite-name>" for each enabled suite
```

```
Given a suite YAML missing the "schema: eval-case-v1" frontmatter line
When meta-lint.sh runs
Then exit code is 1
And findings include rule="frontmatter" for that suite
And the human-readable output line for that suite starts with "[FAIL]"
```

```
Given a suite YAML with case_count=3 but eval-config case_minimum=20
When meta-lint.sh runs WITHOUT --allow-baseline-deficit
Then exit code is 1
And findings include rule="case_minimum" with severity="error"
```

```
Given a suite YAML with case_count=3 but eval-config case_minimum=20
When meta-lint.sh runs WITH --allow-baseline-deficit
Then exit code is 0
And findings include rule="case_minimum" with severity="warning"
And the JSON output's pass field is true
```

```
Given a suite YAML where one case has id "BadId" (no suite-category-NNN format)
When meta-lint.sh runs
Then exit code is 1
And findings include rule="schema" naming that case's id
```

```
Given a suite YAML where total must_not_mention entries across all cases sum to 3, but negative_minimum=5
When meta-lint.sh runs
Then exit code is 1
And findings include rule="negative_minimum"
```

```
Given meta-lint.sh is invoked with --json
When the script completes
Then stdout is valid JSON parseable by `jq -e .`
And the document conforms to {pass: bool, findings: [...], suites: {...}}
```

```
Given a clean run against 8 suites with ~200 cases
When timed end-to-end
Then wall-clock duration is < 5 seconds
```

```
Given shellcheck is run on meta-lint.sh
When invoked with default settings
Then exit code is 0
And no warnings are emitted
```

```
Given the smoke-test scaffold (task 9) is executed
When all 5 mutations are run
Then 5/5 produce the expected exit code (1) and the expected finding rule
And the outputs are captured in the PR description
```

```
Given neither yq nor python3 is available on PATH
When meta-lint.sh starts
Then exit code is 2
And stderr contains a message naming the missing dependencies
```

## Test Requirements

- **Unit (smoke) tests**: 5 scenarios from FR-12 + 1 clean-pass scenario = 6 tests.
- **Performance test**: 1 timing test asserting <5 s on the 8-suite fixture.
- **Shellcheck**: clean exit on `shellcheck meta-lint.sh`.
- **JSON output validity test**: `meta-lint.sh --json | jq -e .pass` returns 0/1 cleanly.
- **Dependency-fallback test**: simulate yq absent (PATH manipulation); confirm python fallback works.

## Implementation Notes

- The `--allow-baseline-deficit` flag is the merge-with-baseline-failure path used by SPEC-028-2 and SPEC-028-3. Without it, those PRs cannot merge until siblings (TDD-025/026) author the bulk case bodies.
- Idempotence (FR-11) is critical because CI may re-invoke meta-lint after caching.
- Use `yq v4` syntax: `yq '.suites' file.yaml -o=json`. NOT `yq v3` syntax.
- Schema validation: prefer `ajv validate -s schema.json -d case.json` (fast). Python fallback: `python3 -c "import json,jsonschema,sys; jsonschema.validate(json.load(open(sys.argv[1])), json.load(open(sys.argv[2])))" case.json schema.json`.
- Output format consistency: TDD-028 §11.3 sample output is the canonical format. Match it byte-for-byte.

## Rollout Considerations

- This script is unwired until SPEC-028-1-04 lands the CI workflow.
- Local developers can invoke directly to validate before pushing.
- Rollback: revert commit. No runtime state.

## Dependencies

- **Blocked by**: SPEC-028-1-01 (schema must exist).
- **Exposes to**: SPEC-028-1-04 (CI wiring), SPEC-028-2-* and SPEC-028-3-* (their PR bodies invoke meta-lint to capture the baseline output).

## Out of Scope

- CI workflow YAML — owned by SPEC-028-1-04.
- Modifying `runner.sh` or `scorer.sh` — owned by SPEC-028-1-03.
- Authoring eval suites — owned by PLAN-028-2 and PLAN-028-3.
- Authoring schema — owned by SPEC-028-1-01.
