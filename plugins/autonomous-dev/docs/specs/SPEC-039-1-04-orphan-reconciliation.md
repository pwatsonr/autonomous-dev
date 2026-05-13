# SPEC-039-1-04: Orphan reconciliation

## Metadata
- **Parent Plan**: PLAN-039
- **Parent TDD**: TDD-038
- **Parent PRD**: PRD-019
- **Tasks Covered**: PLAN-039 TASK-028
- **Dependencies**: SPEC-039-1-02, SPEC-039-2-02
- **Estimated effort**: 3 hours
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-11

## Objective

Resolve OQ-039-5 (SQLite/filesystem drift, flagged CRITICAL by the Architecture review). Implement a daemon reconciliation pass that runs at startup and every `RECONCILE_EVERY_N_POLLS` (default 60) polls:

1. SQLite row with `status='queued'` AND `created_at > 24h ago` AND no matching `state.json` → mark `status='cancelled'`, `cancelled_reason='state-file-lost'`, emit event.
2. state.json on disk with no matching SQLite row → log WARN once per id; do NOT delete (operator decides).

## Acceptance Criteria

1. Resolves OQ-039-5.
2. Reconciliation runs at daemon startup AND every N polls (default 60; configurable via `RECONCILE_EVERY_N_POLLS` env var).
3. Orphan SQLite rows older than 24h get marked `cancelled` with reason `state-file-lost`.
4. Orphan state.json files emit WARN log once per id; no auto-delete.
5. No false positives — a matched pair is never flagged.
6. Reconciliation pass is idempotent across daemon restarts (does not re-mark already-cancelled rows).

## Implementation

**Files modified**
- `plugins/autonomous-dev/bin/supervisor-loop.sh` — add `reconcile_orphans()` function + main-loop trigger.
- `plugins/autonomous-dev/intake/db/repository.ts` — add `findOrphanRows()` and `markRequestCancelled(id, reason)` methods.

**Files created**
- `plugins/autonomous-dev/scripts/find-orphan-sqlite-rows.ts` — emits `request_id|target_repo|created_at` pipe-delimited per row for shell loop consumption.
- `plugins/autonomous-dev/scripts/mark-request-cancelled.ts` — args: `<request_id> <reason>`; sets row's `status='cancelled'`, `cancelled_reason=<reason>`, `updated_at=now`.
- `plugins/autonomous-dev/scripts/check-sqlite-row.ts` — args: `<request_id>`; emits `true|false`.

**`reconcile_orphans()` shell function**
- Reads `RECONCILE_EVERY_N_POLLS` from env (default 60).
- Maintains `POLL_COUNT` counter; runs when `POLL_COUNT % N == 1` (so first poll runs).
- Reads orphan SQLite rows via helper script.
- For each, checks state.json existence; if missing → marks cancelled + emits event.
- Walks every state.json under known target_repos; for each, calls helper to check SQLite presence; logs WARN if missing.

**Atomicity** — `markRequestCancelled` is a single SQLite UPDATE; no race with daemon dispatch since daemon never picks `cancelled` rows.

## Tests

**Files created**
- `plugins/autonomous-dev/tests/bats/reconcile_orphans.bats`

**Test cases**
1. `orphan_sqlite_row_marked_cancelled` — seed SQLite with row, no state.json, age > 24h; run reconcile_orphans; assert status=cancelled, reason=state-file-lost.
2. `orphan_state_json_logged` — create state.json on disk with no SQLite row; run; assert WARN log entry; file not deleted.
3. `no_false_positives` — matched pair; run reconcile; both untouched.
4. `reconcile_every_n_polls` — POLL_COUNT advances; assert reconcile runs on poll 1, 61, 121.
5. `startup_reconciliation` — daemon `--once` boot triggers reconcile before main poll loop.
6. `recent_orphan_not_flagged` — SQLite row created 1 hour ago without state.json is NOT marked cancelled (within grace window).
7. `idempotent_reruns` — running reconcile twice in a row produces no additional events.

## Verification

- `bash -n bin/supervisor-loop.sh`
- `bun run typecheck`
- `bats tests/bats/reconcile_orphans.bats`
- Manual: artificially delete a state.json after submit, wait >24h (or set grace=0 via env), run daemon `--once`, observe row marked cancelled.
