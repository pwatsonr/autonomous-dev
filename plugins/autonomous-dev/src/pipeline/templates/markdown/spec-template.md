---
id: "{{ID}}"
title: "{{TITLE}}"
pipeline_id: "{{PIPELINE_ID}}"
type: SPEC
status: draft
version: "1.0"
created_at: "{{CREATED_AT}}"
updated_at: "{{UPDATED_AT}}"
author_agent: "{{AUTHOR_AGENT}}"
parent_id: "{{PARENT_ID}}"
traces_from: {{TRACES_FROM}}
traces_to: []
depth: 3
sibling_index: {{SIBLING_INDEX}}
sibling_count: {{SIBLING_COUNT}}
depends_on: []
dependency_type: []
execution_mode: sequential
priority: normal
---

# {{TITLE}}

<!-- Rigor scales to task complexity. For trivial / docs-only / low-LOC changes
     (e.g. a README append, a typo fix, a one-file prose or config edit with no
     new public API and no new data structure): do NOT invent byte-exact
     postconditions, byte/character counts, length deltas, pre-state byte
     schemas, or hex dumps — they are routinely miscomputed and turn a
     successful change into a spurious failure/rollback. Use behavioral,
     human-verifiable acceptance criteria instead (the exact text, "appears
     exactly once", a grep that must match). Mark sections that do not apply as
     "N/A — this change introduces no new API / data structure / error path".
     Full contracts/schemas/error taxonomy remain mandatory for tasks that
     actually introduce APIs, data structures, persisted state, or non-trivial
     logic. -->

## Description
<!-- Guidance: Detailed description of what this specification covers and its relationship to the parent plan task -->

<!-- Quality Rubric: completeness (weight: 0.20, min: 70) - All required sections are present and substantive -->
<!-- Minimum word count: 100 -->

## Files to Create/Modify
<!-- Guidance: Table of files that will be created or modified, with action type (create/modify) and purpose -->

<!-- Quality Rubric: precision (weight: 0.25, min: 75) - Specifications are precise enough for direct implementation -->
<!-- Minimum word count: 50 -->

| File | Action | Purpose |
|------|--------|---------|
| `{{FILE_PATH}}` | {{ACTION}} | {{PURPOSE}} |

## Implementation Details
<!-- Guidance: Step-by-step implementation instructions with code signatures, algorithms, and data flow -->

<!-- Quality Rubric: precision (weight: 0.25, min: 75) - Specifications are precise enough for direct implementation -->
<!-- Minimum word count: 300 -->

## Acceptance Criteria
<!-- Guidance: Verifiable criteria that must be met for this spec to be considered implemented -->

<!-- Quality Rubric: testability (weight: 0.20, min: 70) - Test cases and acceptance criteria are well-defined -->
<!-- Minimum word count: 100 -->

## Test Cases
<!-- Guidance: Unit tests, integration tests, and edge cases that validate the implementation -->

<!-- Quality Rubric: testability (weight: 0.20, min: 70) - Test cases and acceptance criteria are well-defined -->
<!-- Minimum word count: 150 -->

## Notes
<!-- Guidance: Additional context, trade-off decisions, or implementation considerations -->

<!-- This section is optional -->
