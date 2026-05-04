# SPEC-028-1-05: Eval-Case-v1 Schema Fixtures (Valid + Invalid)

## Metadata
- **Parent Plan**: PLAN-028-1
- **Parent TDD**: TDD-028 §5.1, §15.1
- **Tasks Covered**: PLAN-028-1 task 6
- **Estimated effort**: 3 hours
- **Status**: Draft

## Summary
Author 10 valid and 10 invalid eval-case YAML fixtures under
`plugins/autonomous-dev-assist/evals/schema/fixtures/`, each exercising one
specific schema rule defined by `eval-case-v1.json` (SPEC-028-1-01). Provide a
`fixtures/README.md` index naming each fixture and the rule it covers. The
fixture set is the canonical worked example for sibling TDDs (TDD-025, TDD-026)
authoring case bodies, and is the regression corpus that meta-lint
(SPEC-028-1-02) is unit-tested against.

## Functional Requirements

| ID | Requirement | Task |
|----|-------------|------|
| FR-1 | A directory MUST exist at `plugins/autonomous-dev-assist/evals/schema/fixtures/`. | T6 |
| FR-2 | The directory MUST contain exactly 10 valid fixtures named `valid-<NN>-<rule>.yaml` (NN = 01..10). | T6 |
| FR-3 | The directory MUST contain exactly 10 invalid fixtures named `invalid-<NN>-<rule>.yaml` (NN = 01..10). | T6 |
| FR-4 | Each valid fixture MUST contain exactly one eval-case object (single-document YAML), MUST validate cleanly against `eval-case-v1.json`, and MUST be annotated with a header comment explaining the rule it exercises. | T6 |
| FR-5 | Each invalid fixture MUST violate exactly one schema rule, MUST fail validation against `eval-case-v1.json` with a deterministic error pointing at that rule, and MUST be annotated with a header comment naming the violated rule. | T6 |
| FR-6 | The 10 valid fixtures MUST cover all 10 `category` enum values: `command-syntax`, `concept-explanation`, `troubleshoot-scenario`, `happy-path`, `negative`, `warning`, `setup`, `recovery`, `audit`, `migration`. One fixture per category. | T6 |
| FR-7 | The 10 invalid fixtures MUST cover, in order: (01) bad `id` regex, (02) missing required field `category`, (03) out-of-enum `category`, (04) out-of-enum `difficulty`, (05) `question` length below 5, (06) `question` length above 500, (07) empty `expected_topics`, (08) `must_mention` not an array, (09) `must_not_mention` not an array, (10) extra unknown property at root. | T6 |
| FR-8 | A `fixtures/README.md` MUST exist that lists every fixture with: filename, rule covered, expected validator outcome (PASS/FAIL with reason). | T6 |
| FR-9 | All fixture ids MUST follow the schema's `id` regex `^[a-z][a-z0-9_-]*-[a-z][a-z0-9_-]*-[0-9]{3}$` (except `invalid-01` which intentionally violates it). | T6 |
| FR-10 | No fixture file MUST share an `id` value with another fixture or with any case in `evals/test-cases/*.yaml`. | T6 |

## Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| Validator latency | All 20 fixtures validate in under 2 s total | `time bash evals/meta-lint.sh --fixtures-only` |
| YAML validity | 20/20 fixtures parse with `yq .` (exit 0) | Shell loop over fixtures |
| Determinism | Each invalid fixture produces the SAME error path on three runs | `for i in 1 2 3; do meta-lint < $f; done` byte-identical |
| Index completeness | 20 entries in `fixtures/README.md` (one per fixture) | `grep -c '| valid-\|| invalid-' fixtures/README.md` |
| Pre-existing-file safety | No file under `plugins/autonomous-dev-assist/evals/test-cases/` modified | `git diff --name-only` excludes test-cases/ |

## Files to Create

- **Path**: `plugins/autonomous-dev-assist/evals/schema/fixtures/valid-01-command-syntax.yaml` through `valid-10-migration.yaml`
- **Path**: `plugins/autonomous-dev-assist/evals/schema/fixtures/invalid-01-bad-id-regex.yaml` through `invalid-10-extra-property.yaml`
- **Path**: `plugins/autonomous-dev-assist/evals/schema/fixtures/README.md`

## Technical Approach

### Directory layout

```
plugins/autonomous-dev-assist/evals/schema/fixtures/
  README.md
  valid-01-command-syntax.yaml
  valid-02-concept-explanation.yaml
  valid-03-troubleshoot-scenario.yaml
  valid-04-happy-path.yaml
  valid-05-negative.yaml
  valid-06-warning.yaml
  valid-07-setup.yaml
  valid-08-recovery.yaml
  valid-09-audit.yaml
  valid-10-migration.yaml
  invalid-01-bad-id-regex.yaml
  invalid-02-missing-category.yaml
  invalid-03-out-of-enum-category.yaml
  invalid-04-out-of-enum-difficulty.yaml
  invalid-05-question-too-short.yaml
  invalid-06-question-too-long.yaml
  invalid-07-empty-expected-topics.yaml
  invalid-08-must-mention-not-array.yaml
  invalid-09-must-not-mention-not-array.yaml
  invalid-10-extra-property.yaml
```

### Valid fixture template

```yaml
# valid-01-command-syntax.yaml
# Rule exercised: id-regex + category=command-syntax + happy-path schema shape.
# Expected validator outcome: PASS.
id: fixture-command-syntax-001
category: command-syntax
difficulty: easy
question: "How do I list active chains?"
expected_topics:
  - "chains list command"
must_mention:
  - "chains list"
must_not_mention:
  - "delete"
```

### Invalid fixture template (one example per category)

```yaml
# invalid-01-bad-id-regex.yaml
# Rule exercised: id MUST match ^[a-z][a-z0-9_-]*-[a-z][a-z0-9_-]*-[0-9]{3}$.
# Expected validator outcome: FAIL at /id (regex mismatch).
id: BadId
category: command-syntax
difficulty: easy
question: "How do I list active chains?"
expected_topics:
  - "chains list command"
must_mention: []
must_not_mention: []
```

```yaml
# invalid-05-question-too-short.yaml
# Rule exercised: question minLength = 5.
# Expected validator outcome: FAIL at /question (length below minimum).
id: fixture-command-syntax-005
category: command-syntax
difficulty: easy
question: "Hi"
expected_topics:
  - "irrelevant"
must_mention: []
must_not_mention: []
```

```yaml
# invalid-10-extra-property.yaml
# Rule exercised: schema is closed (additionalProperties: false at root).
# Expected validator outcome: FAIL at / (unknown property "tags").
id: fixture-command-syntax-010
category: command-syntax
difficulty: easy
question: "How do I list active chains?"
expected_topics:
  - "chains list command"
must_mention: []
must_not_mention: []
tags: ["unexpected"]
```

### `fixtures/README.md` shape

```markdown
# Eval-Case-v1 Schema Fixtures

This directory contains canonical valid and invalid examples for the
`eval-case-v1.json` schema authored under SPEC-028-1-01. The fixture set
is the regression corpus for `meta-lint.sh` (SPEC-028-1-02) and the
copy-and-edit starting point for sibling TDD-025 and TDD-026 case authors.

## Valid fixtures (PASS)

| File | Rule exercised | Notes |
|------|----------------|-------|
| valid-01-command-syntax.yaml | category=command-syntax | Worked example for chains/deploy/cred-proxy/firewall command questions |
| valid-02-concept-explanation.yaml | category=concept-explanation | |
| ... | ... | ... |

## Invalid fixtures (FAIL)

| File | Rule violated | Expected error path |
|------|---------------|---------------------|
| invalid-01-bad-id-regex.yaml | id regex | /id |
| invalid-02-missing-category.yaml | required field "category" | / (missing) |
| ... | ... | ... |

## How to use

To author a new eval case, copy the closest valid fixture and edit `id`,
`question`, `expected_topics`, `must_mention`, `must_not_mention`. Run
`bash evals/meta-lint.sh --fixtures-only` to verify your case validates.
```

### Validation procedure

1. Author all 21 files (20 fixtures + 1 README).
2. Run `for f in plugins/autonomous-dev-assist/evals/schema/fixtures/valid-*.yaml; do bash plugins/autonomous-dev-assist/evals/meta-lint.sh --validate-fixture "$f"; done` and confirm 10/10 exit 0.
3. Run the same loop over `invalid-*.yaml`; confirm 10/10 exit non-zero with the documented error path.
4. Capture the run output in the PR description.

## Acceptance Criteria

```
Given the fixtures directory at plugins/autonomous-dev-assist/evals/schema/fixtures/
When ls is executed
Then the directory contains exactly 21 files
And 10 match the pattern valid-*.yaml
And 10 match the pattern invalid-*.yaml
And README.md exists
```

```
Given each valid-NN fixture
When validated against eval-case-v1.json
Then the validator returns PASS (exit 0)
And the fixture's category equals one of the 10 enum values per FR-6
```

```
Given each invalid-NN fixture
When validated against eval-case-v1.json
Then the validator returns FAIL (non-zero exit)
And the error message names the schema path documented in FR-7 for that NN
```

```
Given invalid-01-bad-id-regex.yaml
When validated
Then the error path is /id
And the error reason mentions "pattern" or "regex"
```

```
Given invalid-05-question-too-short.yaml
When validated
Then the error path is /question
And the error reason mentions minLength or length
```

```
Given invalid-07-empty-expected-topics.yaml
When validated
Then the error path is /expected_topics
And the error reason mentions minItems
```

```
Given invalid-10-extra-property.yaml
When validated
Then the error path is /
And the error reason mentions "additionalProperties" or "unknown property"
```

```
Given fixtures/README.md
When parsed
Then it lists 10 valid fixtures and 10 invalid fixtures in two separate tables
And each row has columns: filename, rule covered, expected outcome
And every fixture file under fixtures/ has a row in README.md
```

```
Given the fixture id values
When listed
Then no two ids collide
And no fixture id collides with any case id under evals/test-cases/*.yaml
```

```
Given any sibling TDD-025 or TDD-026 author copies a valid fixture
When they edit id, question, expected_topics, must_mention, must_not_mention only
Then the resulting case validates against eval-case-v1.json
```

## Test Requirements

- **Schema validation loop**: 20 fixtures × 1 run each; 10 PASS, 10 FAIL with the expected error path. Captured as a deterministic table in PR description.
- **Determinism check**: Run the validator three times against the invalid set; the 10 error paths are byte-identical across runs.
- **README index completeness**: `grep -c` of fixture rows in README.md equals 20.
- **Sibling-author smoke**: Copy `valid-01-command-syntax.yaml` to `/tmp/test-case.yaml`, edit only the user-mutable fields, re-validate; PASS.

## Implementation Notes

- The `id` regex is the strictest single rule and the most likely place sibling authors will trip up. The valid fixtures intentionally use `fixture-<category>-<NNN>` so authors see the pattern; the invalid-01 fixture uses `BadId` (no hyphens, capital letter) so the violation is unambiguous.
- The `additionalProperties: false` rule (invalid-10) only fires if the schema is closed at the root level. SPEC-028-1-01 sets this; verify before authoring invalid-10 that the schema is indeed closed.
- For invalid-06 (question too long), generate the >500-char question with a Python heredoc or `python3 -c 'print("x"*501)'` to keep the fixture readable.
- `expected_topics` cannot be empty (FR-7 invalid-07). The schema sets `minItems: 1`. Confirm SPEC-028-1-01 enforces this; if not, escalate before authoring invalid-07.
- README.md uses kebab-case anchors and matches the prose tone of the existing `evals/README.md` if one exists; otherwise use terse declarative sentences (no exclamation points; no marketing prose) per FR-1539.

## Rollout Considerations

- Fixtures are pure documentation/test artefacts; no runtime behavior change.
- Rollback: `git revert` the commit; meta-lint's `--fixtures-only` mode degrades gracefully if the directory is missing (covered by SPEC-028-1-02).

## Dependencies

- **Blocked by**: SPEC-028-1-01 (schema must exist before fixtures can validate against it).
- **Exposes to**: SPEC-028-1-02 (meta-lint regression corpus); SPEC-028-1-06 (retroactive validation reuses fixture-loading helpers); sibling TDD-025/TDD-026 (copy-and-edit baseline).

## Out of Scope

- The schema itself (`eval-case-v1.json`) — owned by SPEC-028-1-01.
- The meta-lint script that consumes these fixtures — owned by SPEC-028-1-02.
- Retroactive validation of the existing 90 reviewer cases — owned by SPEC-028-1-06.
- Authoring sibling TDD-025/TDD-026 case bodies — owned by those TDDs.
