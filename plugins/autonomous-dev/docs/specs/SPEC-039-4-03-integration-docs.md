# SPEC-039-4-03: Integration documentation

## Metadata
- **Parent Plan**: PLAN-039
- **Parent TDD**: TDD-038
- **Parent PRD**: PRD-019
- **Tasks Covered**: PLAN-039 TASK-027
- **Dependencies**: SPEC-039-4-02
- **Estimated effort**: 1.5 hours
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-11

## Objective

Author `plugins/autonomous-dev/docs/INTEGRATION.md` — operator-facing documentation covering the new end-to-end pipeline contract delivered by PLAN-039. Link the new doc from `plugins/autonomous-dev/README.md`. Includes: state.json schema, phase-to-agent table, portal sync behaviour, troubleshooting, and pointers to the smoke + manual verification runbooks.

## Acceptance Criteria

1. `docs/INTEGRATION.md` exists and covers all listed sections.
2. README.md has a "End-to-end pipeline" section linking to the new doc.
3. Schema documentation accurate against TDD-038 §6.1 (cross-reference enforced in review).
4. Phase-to-agent table identical to SPEC-039-2-02 (single source of truth).
5. Troubleshooting section covers: orphan reconciliation, retry-exhaustion `failed` state, portal not updating (waitedMin), and `claude --state` fallback path (if Scenario B/C applied).

## Implementation

**Files created**
- `plugins/autonomous-dev/docs/INTEGRATION.md`

**Files modified**
- `plugins/autonomous-dev/README.md` — add a top-level link to INTEGRATION.md.

**INTEGRATION.md outline**
1. **Overview** — what the pipeline does end-to-end; one paragraph.
2. **Submit flow** — CLI submit → SQLite + state.json → daemon pickup. Reference TDD §6.
3. **State.json schema** — table of all 19 fields with type, example, and source-of-truth comment. Reference TDD §6.1.
4. **Phase-to-agent mapping** — table from SPEC-039-2-02.
5. **State machine** — diagram or table of transitions (per TDD §7.1).
6. **Portal sync** — what gets written, when, and where (`~/.autonomous-dev/portal/request-actions/`).
7. **Failure modes**
   - Orphan SQLite row → reconciled to `cancelled/state-file-lost`.
   - Retry-exhausted → `failed`.
   - Phase-result missing → synthesized with `synthesized: true`.
   - Wall-clock timeout (30m default) → synthesized fail with `error=WALL_CLOCK_TIMEOUT`.
8. **Operator commands** — submit, list, gate-approve, gate-reject, cancel.
9. **Troubleshooting** — symptoms + checks + remediation, mapped to logs.
10. **Where to look** — paths to logs, state files, events.jsonl, portal files.
11. **See also** — link to smoke (SPEC-039-4-01), runbook (SPEC-039-4-02), TDD-038, PRD-019.

## Tests

- `lychee` (or `bun run lint:links` if configured) over INTEGRATION.md to verify internal links resolve.
- Manual: a new operator reads the doc and successfully submits a request.

## Verification

- Doc-PR review against template + cross-references.
- `lychee docs/INTEGRATION.md` exits 0.
- README has a working link to INTEGRATION.md.
