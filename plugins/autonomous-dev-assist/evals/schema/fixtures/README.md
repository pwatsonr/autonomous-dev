# Eval-Case-v1 Schema Fixtures

This directory contains canonical valid and invalid examples for the
`eval-case-v1.json` schema (SPEC-028-1-01). Fixture authoring and the
fixtures index in this README are owned by **SPEC-028-1-05**. The fixture
set is the regression corpus for `meta-lint.sh` (SPEC-028-1-02) and the
copy-and-edit starting point for sibling TDD-025 and TDD-026 case authors.

## Status

- 10 valid fixtures, one per `category` enum value (FR-6 of SPEC-028-1-05).
- 10 invalid fixtures, one per documented violation (FR-7 of SPEC-028-1-05).
- Validator outcomes match the table below: 10 PASS, 10 FAIL with the
  documented error path. Re-verify with `bash evals/meta-lint.sh` or with
  the standalone Python loop documented in SPEC-028-1-05 §Validation
  procedure.

## Valid fixtures (PASS)

| File | Rule exercised | Notes |
|------|----------------|-------|
| valid-01-what-is.yaml | category=what-is | Worked example for "what is X?" cases |
| valid-02-command-syntax.yaml | category=command-syntax | Worked example for chains/deploy/cred-proxy/firewall command questions |
| valid-03-concept-explanation.yaml | category=concept-explanation | Conceptual / framework questions |
| valid-04-comparison.yaml | category=comparison | "Difference between X and Y" cases |
| valid-05-edge-case.yaml | category=edge-case | Boundary or unusual scenarios |
| valid-06-troubleshoot-scenario.yaml | category=troubleshoot-scenario | Diagnostic prompts |
| valid-07-config-lookup.yaml | category=config-lookup | Configuration parameter lookups |
| valid-08-happy-path.yaml | category=happy-path | Standard expected workflows |
| valid-09-negative.yaml | category=negative | Worked example for negative/hallucination cases |
| valid-10-warning.yaml | category=warning | Operator-pressure or risky scenarios |

## Invalid fixtures (FAIL)

| File | Rule violated | Expected error path | Expected keyword |
|------|---------------|---------------------|------------------|
| invalid-01-bad-id-regex.yaml | id regex `^[a-z][a-z0-9_-]*-[a-z][a-z0-9_-]*-[0-9]{3}$` | /id | pattern |
| invalid-02-missing-category.yaml | required field `category` | / | required |
| invalid-03-out-of-enum-category.yaml | category enum | /category | enum |
| invalid-04-out-of-enum-difficulty.yaml | difficulty enum | /difficulty | enum |
| invalid-05-question-too-short.yaml | question minLength=5 | /question | minLength |
| invalid-06-question-too-long.yaml | question maxLength=500 | /question | maxLength |
| invalid-07-empty-expected-topics.yaml | expected_topics minItems=1 | /expected_topics | minItems |
| invalid-08-must-mention-not-array.yaml | must_mention type=array | /must_mention | type |
| invalid-09-must-not-mention-not-array.yaml | must_not_mention type=array | /must_not_mention | type |
| invalid-10-extra-property.yaml | additionalProperties=false at root | / | additionalProperties |

## How to use

To author a new eval case, copy the closest valid fixture and edit `id`,
`question`, `expected_topics`, `must_mention`, `must_not_mention`. Run
`bash evals/meta-lint.sh` after each batch to verify schema conformance.

## Cross-references

- Schema: `../eval-case-v1.json` (SPEC-028-1-01)
- Meta-lint: `../../meta-lint.sh` (SPEC-028-1-02)
- Retroactive validator: `../validate-existing.sh` (SPEC-028-1-06)
