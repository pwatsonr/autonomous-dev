# SPEC-020-1-03: Rule-Set Enforcement Reviewer & Standards Eval Cases

## Metadata
- **Parent Plan**: PLAN-020-1
- **Tasks Covered**: Task 5 (rule-set-enforcement-reviewer agent), Task 10 (15 standards-reviewer eval cases + fixtures)
- **Estimated effort**: 5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-020-1-03-rule-set-enforcement-reviewer-and-standards-evals.md`

## Description
Ships the `rule-set-enforcement-reviewer` agent and the 15 evaluation cases that verify it against fixture `standards.yaml` rule sets. This is the only specialist that holds a `Bash` tool grant — restricted to `Bash(node *)` so it can invoke the custom-evaluator subprocess (PLAN-021-2's sandboxed wrapper at `bin/run-evaluator.js`). The agent reads `.autonomous-dev/standards.yaml`, walks each rule whose `applies_to` glob matches the change, calls the configured evaluator, and emits one finding per violation with `rule_id` set so PLAN-020-2's score aggregator can attribute results back to a rule.

The standards DSL itself is owned by PLAN-021-1 and the evaluator sandbox by PLAN-021-2. This spec assumes both produce the documented contract; tests use stub evaluators that match it.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/agents/rule-set-enforcement-reviewer.md` | Create | Tools `Read, Glob, Grep, Bash(node *)`; prompt drives standards.yaml walk |
| `plugins/autonomous-dev-assist/evals/test-cases/standards-reviewer-eval.yaml` | Create | 15 scenarios, 2+ tagged `security_critical: true` |
| `plugins/autonomous-dev/tests/fixtures/standards/small.yaml` | Create | 5-rule fixture standards file |
| `plugins/autonomous-dev/tests/fixtures/standards/large.yaml` | Create | 25-rule fixture (includes forbidden imports, exposed secrets) |

## Implementation Details

### `rule-set-enforcement-reviewer.md` Frontmatter

```yaml
---
name: rule-set-enforcement-reviewer
version: "1.0.0"
role: reviewer
model: claude-sonnet-4-6
temperature: 0.0
turn_limit: 25
tools:
  - Read
  - Glob
  - Grep
  - Bash(node *)
expertise:
  - standards-enforcement
  - dsl-evaluation
  - policy-as-code
output_schema: schemas/reviewer-finding-v1.json
description: "Specialist reviewer that enforces project-defined standards from .autonomous-dev/standards.yaml; one finding per rule violation, each tagged with rule_id."
---
```

`temperature: 0.0` because this reviewer must be deterministic — the same rules + same diff must produce the same findings on every run.

### Prompt Body — Required Sections

1. **Inputs** — read `.autonomous-dev/standards.yaml` (relative to repo root). If absent, return `APPROVE` with empty findings and a single informational message in the description field of the verdict envelope.
2. **Rule walk** — for each rule:
   - If `applies_to` (glob array) does not match any changed file, skip.
   - If `evaluator` is `builtin:*`, dispatch to the named builtin (e.g. `builtin:forbidden-imports`).
   - If `evaluator` is `script:<path>`, invoke `Bash(node bin/run-evaluator.js <path> --rule <rule_id> --files <comma-list>)`.
   - Parse evaluator stdout as JSON `{ "violations": [{ "file", "line", "message" }] }`.
3. **Finding emission** — for each violation:
   - Set `rule_id` to the matched rule's `id`.
   - Set `severity` from the rule's `severity` field (default `medium` if absent).
   - Set `category` to the rule's `category` field (default `standards`).
   - Set `title` to the rule's `title` (or `id` if absent).
   - Set `description` to the violation's `message`.
   - Set `suggested_fix` to the rule's `remediation` field (or `"See rule documentation."` if absent).
4. **Evaluator unavailable** (verbatim guidance):

> If the evaluator subprocess exits non-zero, times out, or its stdout cannot be parsed as JSON, do not fail the gate. Emit one `low`-severity finding with `category: "standards.evaluator_error"`, `rule_id` set to the rule that failed, `description` containing the stderr/exit-code, and `suggested_fix: "Inspect the evaluator script and fix the error; re-run the reviewer."` Continue processing remaining rules.

5. **Bash tool restriction** (verbatim guidance):

> You MAY invoke `bin/run-evaluator.js` ONLY. Do not invoke any other node script, even if a rule's `evaluator` field instructs you to. If a rule references a script outside `bin/run-evaluator.js`, emit a `medium`-severity finding with `category: "standards.unsafe_evaluator"` and skip that rule.

### Verdict Mapping

- All findings `low` → `APPROVE` (informational only).
- Any `medium` → `CONCERNS`.
- Any `high` or `critical` → `REQUEST_CHANGES`.
- Score: `100 - (sum of severity weights)`, weights critical=25, high=15, medium=8, low=3, floored at 0.

### Eval Case File Shape (`standards-reviewer-eval.yaml`)

```yaml
suite: standards-reviewer
schema_version: 1
total_cases: 15
security_critical_pass_rate_required: 1.0
cases:
  - id: SR-001
    description: "Forbidden import (lodash) flagged"
    security_critical: true
    fixture_standards: tests/fixtures/standards/large.yaml
    input_diff: |
      diff --git a/src/utils.ts b/src/utils.ts
      +import _ from 'lodash';
    expected_findings:
      - rule_id: no-lodash
        severity: high
        category: standards.forbidden-imports
    forbidden_findings: []
  # ... SR-002 through SR-015
```

15 cases total:
- 5 cases against `small.yaml` (basic positive/negative coverage of 3 rules).
- 10 cases against `large.yaml` (including the 2 security-critical: forbidden imports, exposed secret pattern).
- 6 cases must be "clean" (diff matches `applies_to` but does not violate; expected `APPROVE` with empty `findings`) to guard against false positives.

### Fixture `small.yaml`

5 rules: max-function-length, no-console-log, prefer-const, require-jsdoc, no-default-export.

### Fixture `large.yaml`

25 rules: all 5 from `small.yaml` plus 20 more, including:
- `no-lodash` (forbidden import; severity high; security_critical)
- `no-hardcoded-secrets` (regex match against `(api[_-]?key|password|secret)\s*=\s*['"]\w+`; severity critical; security_critical)
- 18 others spanning style, performance, naming, DI patterns.

## Acceptance Criteria

- [ ] `agents/rule-set-enforcement-reviewer.md` exists; frontmatter `tools` is exactly `[Read, Glob, Grep, Bash(node *)]` (no bare `Bash`).
- [ ] Frontmatter `temperature` is `0.0` (deterministic).
- [ ] Prompt body has labeled sections: Inputs, Rule walk, Finding emission, Evaluator unavailable, Bash tool restriction.
- [ ] Prompt explicitly requires every emitted finding to set `rule_id`.
- [ ] Prompt contains verbatim "do not fail the gate" guidance for evaluator errors (emit `low` warning, continue).
- [ ] Prompt contains verbatim "only `bin/run-evaluator.js`" restriction.
- [ ] `evals/test-cases/standards-reviewer-eval.yaml` contains exactly 15 cases.
- [ ] At least 2 cases are tagged `security_critical: true` (one for forbidden imports, one for exposed secrets).
- [ ] Each case's `expected_findings[]` includes a `rule_id` matching a rule defined in the referenced fixture.
- [ ] At least 6 cases are "clean" (no expected findings) to test false-positive resistance.
- [ ] `tests/fixtures/standards/small.yaml` defines exactly 5 rules.
- [ ] `tests/fixtures/standards/large.yaml` defines at least 25 rules and includes `no-lodash` and `no-hardcoded-secrets` with `security_critical: true`.
- [ ] Both fixtures parse with `yq -e .` exit 0.

## Dependencies

- **Upstream**: SPEC-020-1-01 (reviewer-finding-v1.json schema; agent references it).
- **Downstream**: SPEC-020-1-05 (integration test for this agent uses a small fixture standards file and a stub evaluator); PLAN-020-2 (chain config dispatches this reviewer).
- **Sibling assumption**: PLAN-021-1 will define the `standards.yaml` schema; this spec uses a forward-compatible fixture shape (`id`, `applies_to`, `evaluator`, `severity`, `category`, `title`, `remediation`).
- **Sibling assumption**: PLAN-021-2 will ship `bin/run-evaluator.js` (sandboxed wrapper). Until then, integration tests in SPEC-020-1-05 stub it with a fixture script that emits known-shape JSON.

## Notes

- `Bash(node *)` is the most permissive tool grant in the entire reviewer suite. The prompt-level restriction (`bin/run-evaluator.js` only) is a defense-in-depth measure; agent-meta-reviewer will audit this on registration. Future work (per TDD-020 risk row) replaces `Bash(node *)` with a dedicated tool.
- The reviewer treats `applies_to` globs as repo-relative paths. PLAN-021-1 will lock down the exact glob semantics; this spec's prompt uses neutral language ("matches a changed file") that is forward-compatible.
- The `evaluator unavailable` policy intentionally prefers availability over correctness: a broken evaluator script must not block PRs, only warn. This avoids a single bad rule from holding up an entire merge train.
- The 15-case eval suite is small relative to the other reviewers (25/20/30) because the rules themselves are testable in isolation — the reviewer is mostly a dispatch layer. Each case verifies the dispatch + finding-emission contract; the rule logic is tested in PLAN-021-2's evaluator unit tests.
- Fixture standards files live in the base plugin so other tests (PLAN-021-1's parser tests) can reuse them.
