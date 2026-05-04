# SPEC-028-1-01: eval-case-v1 JSON Schema and Fixture Set

## Metadata
- **Parent Plan**: PLAN-028-1
- **Parent TDD**: TDD-028 §5.1
- **Tasks Covered**: Task 1 (schema authoring), Task 2 (retroactive validation), Task 6 (fixture set)
- **Estimated effort**: 8 hours (3 schema + 2 retroactive + 3 fixtures)
- **Status**: Draft

## Summary
Author the foundational JSON Schema (Draft 2020-12) at `plugins/autonomous-dev-assist/evals/schema/eval-case-v1.json` that locks the eval-case shape across all eight assist eval suites. Ship a 20-fixture validation set (10 valid + 10 invalid, one per enforcement rule) under `evals/schema/fixtures/`. Run a one-off retroactive validation against the existing 90 reviewer-eval cases plus the four existing assist suites, capturing any legacy violations as follow-up tickets without blocking this spec.

## Functional Requirements

| ID | Requirement | Task |
|----|-------------|------|
| FR-1 | The schema MUST validate as a well-formed JSON Schema Draft 2020-12 (loadable by `ajv` v8 and Python `jsonschema` v4). | T1 |
| FR-2 | The schema MUST require all seven fields: `id`, `category`, `difficulty`, `question`, `expected_topics`, `must_mention`, `must_not_mention`. | T1 |
| FR-3 | `id` MUST match regex `^[a-z][a-z0-9_-]*-[a-z][a-z0-9_-]*-[0-9]{3}$`. | T1 |
| FR-4 | `category` MUST be one of: `what-is`, `command-syntax`, `concept-explanation`, `comparison`, `edge-case`, `troubleshoot-scenario`, `config-lookup`, `happy-path`, `negative`, `warning`. | T1 |
| FR-5 | `difficulty` MUST be one of: `easy`, `medium`, `hard`. | T1 |
| FR-6 | `question` MUST be a string with `minLength: 5` and `maxLength: 500`. | T1 |
| FR-7 | `expected_topics` MUST be an array with `minItems: 1` of strings. | T1 |
| FR-8 | `must_mention` and `must_not_mention` MUST each be arrays of strings (may be empty). | T1 |
| FR-9 | The schema MUST include human-readable `description` per property explaining the constraint. | T1 |
| FR-10 | The schema's `$id` MUST be `https://autonomous-dev/schemas/eval-case-v1.json`. | T1 |
| FR-11 | A retroactive validation script MUST validate every existing `evals/test-cases/*.yaml` case against the schema and emit a violations report. | T2 |
| FR-12 | A 10-fixture set of valid cases (one per category enum value) MUST exist under `evals/schema/fixtures/valid-*.yaml`. | T6 |
| FR-13 | A 10-fixture set of invalid cases (each violating exactly one schema rule) MUST exist under `evals/schema/fixtures/invalid-*.yaml`. | T6 |
| FR-14 | A `fixtures/README.md` index MUST list each fixture and the rule it covers. | T6 |

## Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| Schema load time | < 100 ms | Time `ajv compile` on a developer laptop |
| Fixture validation runtime (20 fixtures) | < 2 s | Wall-clock under `bash` invocation |
| Schema file size | ≤ 4 KB | `wc -c eval-case-v1.json` |
| Retroactive script runtime against ~94 cases | < 10 s | Wall-clock |
| Fixture coverage | 100% of enforced rules (id pattern, category enum, difficulty enum, question length, required fields, expected_topics minItems, must_not_mention array type) | Manual mapping in fixtures/README.md |

## Files to Create

- **Path**: `plugins/autonomous-dev-assist/evals/schema/eval-case-v1.json`
  - **Action**: Create
  - **Description**: JSON Schema Draft 2020-12 per FR-1 through FR-10. Verbatim shape from TDD-028 §5.1.
- **Path**: `plugins/autonomous-dev-assist/evals/schema/validate-existing.sh`
  - **Action**: Create (one-off; retainable as documentation)
  - **Description**: Bash script that walks `evals/test-cases/*.yaml`, transforms each case to JSON via `yq`, validates against `eval-case-v1.json` via `ajv` (Node) or `python -m jsonschema` (Python fallback), and prints a Markdown violations table.
- **Path**: `plugins/autonomous-dev-assist/evals/schema/fixtures/valid-{what-is,command-syntax,concept-explanation,comparison,edge-case,troubleshoot-scenario,config-lookup,happy-path,negative,warning}.yaml`
  - **Action**: Create (10 files)
  - **Description**: One valid case per category enum value. Each fixture is a single YAML mapping (not a list) so it's directly schema-validatable after JSON conversion. Header comment names the rule the fixture exercises (the `category` value).
- **Path**: `plugins/autonomous-dev-assist/evals/schema/fixtures/invalid-{bad-id-pattern,missing-required-field,unknown-category,question-too-short,question-too-long,bad-difficulty,empty-expected-topics,missing-must-not-mention,non-array-must-mention,non-string-id}.yaml`
  - **Action**: Create (10 files)
  - **Description**: One invalid case per enforcement rule. Header comment names the rule violated and the expected error keyword (`pattern`, `required`, `enum`, `minLength`, `maxLength`, `enum`, `minItems`, `required`, `type`, `type`).
- **Path**: `plugins/autonomous-dev-assist/evals/schema/fixtures/README.md`
  - **Action**: Create
  - **Description**: 20-row index. Columns: fixture filename | rule covered | expected validation result (PASS/FAIL) | expected JSON Schema error keyword (for invalid).

## Technical Approach

### Schema authoring (T1)
1. Author the JSON Schema verbatim from TDD-028 §5.1. Add `$schema: "https://json-schema.org/draft/2020-12/schema"` and `$id` per FR-10.
2. Each property MUST have a `description` field paraphrasing the constraint (e.g., for `id`: `"Format: <suite>-<category>-<NNN>. Example: chains-list-001."`).
3. Validate the schema is well-formed by running `ajv compile -s eval-case-v1.json` and `python -c "import json,jsonschema; jsonschema.Draft202012Validator.check_schema(json.load(open('eval-case-v1.json')))"`. Both MUST succeed.

### Fixture authoring (T6)
1. Each fixture is a YAML mapping (single case, not a list). The retroactive script and meta-lint (SPEC-028-1-02) extract the case payload.
2. Valid fixtures share a baseline shape (`id`, `category`, `difficulty: medium`, `question: "What is the purpose of <category> cases?"`, `expected_topics: ["topic-a"]`, `must_mention: []`, `must_not_mention: []`). Only the `category` field differs per fixture.
3. Invalid fixtures each mutate exactly ONE field from the baseline so the failing rule is unambiguous:
   - `invalid-bad-id-pattern.yaml`: `id: "BadIdPattern"` (no hyphens) → FAIL on `pattern`.
   - `invalid-missing-required-field.yaml`: omit `must_not_mention` → FAIL on `required`.
   - `invalid-unknown-category.yaml`: `category: "philosophy"` → FAIL on `enum`.
   - `invalid-question-too-short.yaml`: `question: "Hi?"` → FAIL on `minLength`.
   - `invalid-question-too-long.yaml`: `question:` 501 chars → FAIL on `maxLength`.
   - `invalid-bad-difficulty.yaml`: `difficulty: "expert"` → FAIL on `enum`.
   - `invalid-empty-expected-topics.yaml`: `expected_topics: []` → FAIL on `minItems`.
   - `invalid-missing-must-not-mention.yaml`: omit field → FAIL on `required`.
   - `invalid-non-array-must-mention.yaml`: `must_mention: "should be an array"` → FAIL on `type`.
   - `invalid-non-string-id.yaml`: `id: 12345` → FAIL on `type`.

### Retroactive validation (T2)
1. Script: `validate-existing.sh`. Inputs: none. Output: Markdown table to stdout, JSON exit code 0/1.
2. Walk `evals/test-cases/*.yaml`. For each file, extract `cases:` array via `yq '.cases[]' -o=json`. For each case, validate against the schema.
3. Emit per-case PASS/FAIL with the schema keyword that failed.
4. Per TDD-028 OQ-5: legacy violations DO NOT block this spec. Capture violations list as a follow-up ticket linked in the PR.

## Acceptance Criteria

```
Given the schema file exists at evals/schema/eval-case-v1.json
When ajv compile is invoked on it
Then exit code is 0
And no schema-validity warnings are emitted
```

```
Given each of the 10 valid fixtures
When validated against eval-case-v1.json via ajv
Then all 10 PASS validation
And exit code is 0 per fixture
```

```
Given each of the 10 invalid fixtures
When validated against eval-case-v1.json via ajv
Then all 10 FAIL validation
And the failing JSON Schema keyword matches the expected keyword documented in fixtures/README.md
```

```
Given a case with id "Chains-List-001" (uppercase)
When validated
Then validation FAILS with keyword "pattern"
And the error message references the id regex
```

```
Given a case with category "philosophy"
When validated
Then validation FAILS with keyword "enum"
```

```
Given a case missing the must_not_mention field entirely
When validated
Then validation FAILS with keyword "required"
And the error message names "must_not_mention"
```

```
Given a case with question = "Hi?" (3 chars)
When validated
Then validation FAILS with keyword "minLength"
```

```
Given a case with expected_topics = []
When validated
Then validation FAILS with keyword "minItems"
```

```
Given the validate-existing.sh script is run against the existing 90 reviewer-eval cases plus the 4 existing assist suite cases
When the script completes
Then exit code is either 0 (clean) or 1 (with violations listed)
And any non-zero exit produces a Markdown violations table on stdout
And the violations table is captured in the PR description
And legacy violations are filed as a follow-up ticket but DO NOT block this spec's merge
```

```
Given fixtures/README.md exists
When a developer opens it
Then they see a 20-row table mapping fixture → rule → expected result → expected keyword
And every fixture file under fixtures/ appears exactly once in the table
```

## Test Requirements

- **Schema-validity tests**: `ajv compile` and Python `Draft202012Validator.check_schema` both succeed.
- **Fixture-PASS tests**: 10 valid fixtures all validate successfully (exit 0 per fixture under `ajv validate`).
- **Fixture-FAIL tests**: 10 invalid fixtures all fail validation (exit 1 per fixture) with the documented keyword.
- **Retroactive validation**: script run captured to PR; result is either zero violations OR a documented list filed as follow-up.
- **Cross-tool compatibility**: fixtures pass under both `ajv` (Node) and `jsonschema` (Python) — both used by downstream meta-lint depending on which is available in CI.

## Implementation Notes

- The schema is a versioned interface. Future additions (`v2`) require a migration plan. Do NOT add fields in-place under the v1 `$id`.
- Existing 90 cases use ids of the form `<suite>-<category>-<NNN>` already; the regex is permissive enough to match them. If a legacy id has uppercase or other deviation, that's a legacy finding (OQ-5).
- Use `yq v4` (mikefarah/yq) for YAML→JSON conversion — already a common GitHub Action and present in most CI runners.
- The fixtures are the canonical worked example for sibling TDD authors (TDD-025, TDD-026). They will copy a valid fixture and edit it.

## Rollout Considerations

- No feature flag needed; schema is a new file. Until SPEC-028-1-02 (meta-lint) lands, the schema is unenforced — but the fixture set proves the schema works.
- Rollback: revert the commit. No runtime dependency.

## Dependencies

- **Consumes**: existing `evals/test-cases/*.yaml` for retroactive validation (read-only).
- **Exposes**: `eval-case-v1.json` schema consumed by SPEC-028-1-02 (meta-lint), SPEC-028-2-*, SPEC-028-3-*.

## Out of Scope

- Authoring `meta-lint.sh` — owned by SPEC-028-1-02.
- Authoring eval-config registration — owned by SPEC-028-1-03.
- Modifying any existing eval-case file — regression-stable per TDD-028 NG-07.
- Bumping schema to v2 — not needed for v1.
