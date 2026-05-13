# SPEC-039-2-01: Research — `claude --state` semantics

## Metadata
- **Parent Plan**: PLAN-039
- **Parent TDD**: TDD-038
- **Parent PRD**: PRD-019
- **Tasks Covered**: PLAN-039 TASK-015
- **Dependencies**: none
- **Estimated effort**: 1 hour
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-11

## Objective

Resolve OQ-039-1: validate whether `claude --state <file>` accepts arbitrary JSON metadata (the TDD-038 §6.2 design assumption) or only conversation-state JSONL produced by an earlier `claude` run. This research blocks TASK-009 (dispatch_phase_session) and TASK-014 (phase-result synthesis). Deliverable is a research artifact that either confirms the TDD design OR specifies a fallback path.

## Acceptance Criteria

1. `claude --help` output captured verbatim for the `--state` parameter.
2. A minimal reproducer state.json is tested against `claude --agent prd-author --state ... --print --max-turns 1`.
3. Findings classified as Scenario A (works with arbitrary JSON), Scenario B (JSONL-only), or Scenario C (other constraint).
4. Recommendation for TASK-009 implementation documented (use `--state` OR use `--prompt`).
5. If Scenario B/C: TDD-038 §6.2 amendment drafted as a follow-up.
6. Research artifact lives at `docs/research/RESEARCH-039-claude-state-semantics.md`.

## Implementation

**Files created**
- `plugins/autonomous-dev/docs/research/RESEARCH-039-claude-state-semantics.md` (the research artifact).

**Research artifact template**
```markdown
# RESEARCH-039: claude --state semantics

## Method
- `claude --help` (full)
- Reproducer state.json (minimal — see below)
- `claude --agent prd-author --state repro.state.json --print --max-turns 1`

## Reproducer
[full minimal state.json]

## Result
[verbatim stdout/stderr]

## Conclusion
- Scenario: [A/B/C]
- Recommended approach for TASK-009: [--state | --prompt | hybrid]

## Impact on TDD-038
[either "no change" or a drafted amendment paragraph]
```

**Reproducer state.json** — minimal 5-field doc carrying `current_phase_metadata.phase_prompt: "Print exactly OK"` plus the 19 required schema fields.

## Tests

N/A — this is a research artifact, not code. The deliverable IS the documentation.

## Verification

- `claude --help` exits 0.
- The reproducer command exits 0 OR produces a clearly captured error message.
- Findings included in research artifact with no hand-waving.
- Either: TDD-038 unchanged (Scenario A) — close OQ-039-1 in PLAN-039 notes, OR a follow-up doc-PR amends TDD-038 §6.2 (Scenario B/C).
