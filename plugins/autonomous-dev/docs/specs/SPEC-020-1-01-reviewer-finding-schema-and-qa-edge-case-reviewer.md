# SPEC-020-1-01: Reviewer Finding v1 Schema & QA Edge-Case Reviewer Agent

## Metadata
- **Parent Plan**: PLAN-020-1
- **Tasks Covered**: Task 1 (reviewer-finding-v1.json schema), Task 2 (qa-edge-case-reviewer agent)
- **Estimated effort**: 3.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-020-1-01-reviewer-finding-schema-and-qa-edge-case-reviewer.md`

## Description
Establishes the shared output contract for the entire specialist reviewer suite (TDD-020 §5.5) and ships the first specialist agent: `qa-edge-case-reviewer`. The schema is the single source of truth for every reviewer's emitted JSON; downstream consumers (PLAN-020-2 score aggregator, PLAN-017-3 eval runner) parse against it. The QA agent is the most general-purpose specialist and the simplest to author, so it ships first; later specs reuse the schema for the UX, accessibility, and rule-set reviewers without modification.

The schema is a stand-alone JSON Schema (Draft 2020-12). The agent file is a Markdown frontmatter document compatible with Claude Code's agent loader. Neither artifact wires into a chain or scheduler — that is PLAN-020-2's job.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/schemas/reviewer-finding-v1.json` | Create | JSON Schema Draft 2020-12; defines the reviewer output envelope and finding shape |
| `plugins/autonomous-dev/schemas/fixtures/reviewer-finding-clean.json` | Create | Valid fixture used by schema-validation lint step and downstream tests |
| `plugins/autonomous-dev/schemas/fixtures/reviewer-finding-missing-file.json` | Create | Negative fixture (missing required `file`) for validation tests |
| `plugins/autonomous-dev/schemas/fixtures/reviewer-finding-invalid-severity.json` | Create | Negative fixture (`severity: "urgent"` invalid enum) for validation tests |
| `plugins/autonomous-dev/agents/qa-edge-case-reviewer.md` | Create | Agent definition with frontmatter and system prompt covering six TDD-020 §5.1 categories |

## Implementation Details

### Schema Shape (`reviewer-finding-v1.json`)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://autonomous-dev.dev/schemas/reviewer-finding-v1.json",
  "title": "Reviewer Finding v1",
  "type": "object",
  "required": ["reviewer", "verdict", "score", "findings"],
  "properties": {
    "reviewer": { "type": "string", "minLength": 1 },
    "verdict": { "type": "string", "enum": ["APPROVE", "CONCERNS", "REQUEST_CHANGES"] },
    "score": { "type": "integer", "minimum": 0, "maximum": 100 },
    "findings": {
      "type": "array",
      "items": { "$ref": "#/$defs/finding" }
    }
  },
  "$defs": {
    "finding": {
      "type": "object",
      "required": ["file", "line", "severity", "category", "title", "description", "suggested_fix"],
      "properties": {
        "file": { "type": "string", "minLength": 1 },
        "line": { "type": "integer", "minimum": 0 },
        "severity": { "type": "string", "enum": ["low", "medium", "high", "critical"] },
        "category": { "type": "string", "minLength": 1 },
        "title": { "type": "string", "minLength": 1, "maxLength": 200 },
        "description": { "type": "string", "minLength": 1 },
        "suggested_fix": { "type": "string", "minLength": 1 },
        "rule_id": { "type": "string", "minLength": 1 }
      },
      "additionalProperties": false
    }
  }
}
```

Notes:
- `rule_id` is optional; only the rule-set-enforcement reviewer (SPEC-020-1-03) sets it.
- `additionalProperties: false` on the finding object prevents drift; reviewers that need extra fields must propose a v2 schema.
- `line: 0` is permitted for findings about a whole file (e.g. missing newline at EOF).

### QA Edge-Case Reviewer Agent (`qa-edge-case-reviewer.md`)

Frontmatter (must match TDD-020 §5.1 verbatim):

```yaml
---
name: qa-edge-case-reviewer
version: "1.0.0"
role: reviewer
model: claude-sonnet-4-6
temperature: 0.2
turn_limit: 20
tools:
  - Read
  - Glob
  - Grep
expertise:
  - edge-cases
  - boundary-analysis
  - error-handling
  - concurrency
output_schema: schemas/reviewer-finding-v1.json
description: "Specialist reviewer that hunts edge cases, boundary conditions, race conditions, error paths, null handling, and resource leaks."
---
```

System prompt MUST enumerate all six categories with at least one representative concern per category:

1. **Input validation** — unsanitized external inputs, missing length/format checks, untrusted deserialization.
2. **Boundary conditions** — off-by-one, empty collections, max-int overflow, zero-length string, single-element array.
3. **Race conditions** — TOCTOU, unsynchronized shared state, async ordering, double-callback.
4. **Error paths** — uncaught promise rejections, swallowed exceptions, partial state on failure, missing cleanup.
5. **Null handling** — implicit `undefined` propagation, optional-chaining gaps, default value collisions.
6. **Resource leaks** — file handles not closed, listeners not removed, timers not cleared, connections not pooled.

Output instruction (verbatim, last paragraph of prompt):

> Produce JSON that validates against `schemas/reviewer-finding-v1.json`. Set `reviewer` to `qa-edge-case-reviewer`. Choose `verdict`: `APPROVE` if no findings; `CONCERNS` if findings are all `low` or `medium`; `REQUEST_CHANGES` if any finding is `high` or `critical`. Compute `score` as `100 - (sum of severity weights)` where critical=25, high=15, medium=8, low=3, floored at 0.

## Acceptance Criteria

- [ ] `schemas/reviewer-finding-v1.json` exists, parses with `jq -e .` exit 0, and validates `fixtures/reviewer-finding-clean.json` clean.
- [ ] Schema rejects `fixtures/reviewer-finding-missing-file.json` with a "missing required property: file" error.
- [ ] Schema rejects `fixtures/reviewer-finding-invalid-severity.json` because `urgent` is not in the severity enum.
- [ ] `rule_id` field is absent from the clean fixture and the schema accepts it; the schema also accepts a finding with `rule_id` present.
- [ ] `agents/qa-edge-case-reviewer.md` frontmatter has `name: qa-edge-case-reviewer`, `model: claude-sonnet-4-6`, `tools: [Read, Glob, Grep]`, and references `schemas/reviewer-finding-v1.json`.
- [ ] Agent prompt body contains a labeled section for each of the six categories (input validation, boundary, race, error paths, null, resource leaks); each section has at least one concrete example concern.
- [ ] Agent prompt body ends with the verbatim output instruction (verdict mapping, score formula).
- [ ] `additionalProperties: false` is set on the finding object so unknown fields are rejected (verified by negative fixture or test).
- [ ] No `Bash`, `Edit`, `Write`, or other write/exec tool appears in the agent's tools list.

## Dependencies

- **None upstream.** This is the first spec in PLAN-020-1; downstream specs (-02, -03, -04, -05) reuse the schema.
- Future: PLAN-020-2's score aggregator parses reviewer outputs against this schema. PLAN-017-3's eval runner asserts validation as part of every test case.

## Notes

- The schema is versioned in its `$id` (`reviewer-finding-v1`). Any breaking change ships as `v2` and runs side-by-side; the score aggregator decides which version to consume per reviewer.
- `score` is included in the envelope for the aggregator's convenience even though it is derivable from `findings[].severity`. Reviewers compute it once; the aggregator does not need to recompute.
- The QA agent is the only specialist with no "non-frontend → APPROVE" guard. It runs against every diff because its categories (race, leaks, null) are language- and stack-agnostic.
- The `model: claude-sonnet-4-6` choice tracks TDD-020 §5.1 verbatim. Do not substitute a different sonnet snapshot without updating the TDD.
- `temperature: 0.2` is intentionally low to reduce variance in the reviewer's verdict between runs against identical inputs (operational stability matters more than creativity for a gating reviewer).
