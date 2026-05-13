# SPEC-039-3-01: Portal request-action file writer

## Metadata
- **Parent Plan**: PLAN-039
- **Parent TDD**: TDD-038
- **Parent PRD**: PRD-019
- **Tasks Covered**: PLAN-039 TASK-018, TASK-024
- **Dependencies**: SPEC-039-2-05
- **Estimated effort**: 2.5 hours
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-11

## Objective

Implement `write_portal_request_action()` — a shell function that writes (atomically) the per-request portal-facing JSON file at `~/.autonomous-dev/portal/request-actions/<REQ-id>.json` on every state transition. Per TDD §6.3 layout: the **per-phase phase-result** files live in `~/.autonomous-dev/portal/request-actions/<REQ-id>/phase-result-<phase>.json` (subdirectory) while this spec's flat `.json` file lives at `~/.autonomous-dev/portal/request-actions/<REQ-id>.json` — verified non-colliding. Also covers TASK-024: ensure the parent directory exists at daemon startup.

## Acceptance Criteria

1. (AC-038-16) Every state transition (advance_phase, intake_to_prd, reconcile orphan) writes/updates the portal-action file for that request.
2. Atomic write pattern `${file}.tmp.$$` + rename.
3. No filesystem-node collision: flat `<REQ-id>.json` AND subdir `<REQ-id>/` coexist (verified by a bats test).
4. Schema covers: id, status, current_phase, target_repo, title, created_at, updated_at, waitedMin (computed by SPEC-039-3-02), error.
5. Portal directory `~/.autonomous-dev/portal/request-actions/` is created at daemon startup (TASK-024).
6. Writes survive concurrent updates (latest-writer-wins; no partial files visible).

## Implementation

**Files modified**
- `plugins/autonomous-dev/bin/supervisor-loop.sh` — add `write_portal_request_action()` + startup `mkdir -p`.

**Function contract**
```bash
write_portal_request_action() {
  local request_id="$1"
  local state_file="$(state_file_for "$request_id")"
  local out_dir="${HOME}/.autonomous-dev/portal/request-actions"
  local out_file="${out_dir}/${request_id}.json"
  local tmp="${out_file}.tmp.$$"

  mkdir -p "$out_dir"
  jq '{
    id: .id,
    status: .status,
    current_phase: .current_phase,
    target_repo: .target_repo,
    title: .title,
    created_at: .created_at,
    updated_at: .updated_at,
    waitedMin: 0,
    error: .error
  }' "$state_file" > "$tmp"
  mv "$tmp" "$out_file"
}
```

(The `waitedMin: 0` placeholder is overwritten by SPEC-039-3-02's logic before the rename.)

**Startup hook** — in `main_loop()` setup phase, before the while loop:
```bash
mkdir -p "${HOME}/.autonomous-dev/portal/request-actions"
```

**Call sites** — `advance_phase`, `intake_to_prd_if_needed`, `reconcile_orphans` (cancelled rows), `handle_phase_failure` (failed rows).

## Tests

**Files created**
- `plugins/autonomous-dev/tests/bats/portal_request_action_write.bats`

**Test cases**
1. (AC-038-16) `every_transition_writes_portal_file` — drive advance_phase; assert `<REQ-id>.json` written with new status.
2. `atomic_pattern_no_partial` — concurrent reader during write never observes truncated JSON.
3. `flat_file_and_subdir_coexist` — both `<REQ-id>.json` (flat) AND `<REQ-id>/phase-result-prd.json` (subdir) exist; no error.
4. `directory_created_at_startup` — daemon `--once` on empty queue still creates the directory.
5. `cancelled_row_writes_portal` — reconcile_orphans marking a row cancelled triggers a portal write reflecting the new status.
6. `failed_row_writes_portal` — handle_phase_failure path also writes.

## Verification

- `bash -n bin/supervisor-loop.sh`
- `bats tests/bats/portal_request_action_write.bats`
- Manual: drive a state transition, `cat ~/.autonomous-dev/portal/request-actions/REQ-*.json` shows the latest status.

## Amendment (PRD-020)

The daemon writes to `${AUTONOMOUS_DEV_STATE_DIR:-$HOME/.autonomous-dev}/request-actions/<id>.json` (no `portal/` segment — matches `state-paths.ts`), and also `gate-decisions/<repo>__<id>.json` on entering a gate (FR-020-03).
