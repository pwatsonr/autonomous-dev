# SPEC-039-1-02: state.json writer helper

## Metadata
- **Parent Plan**: PLAN-039
- **Parent TDD**: TDD-038
- **Parent PRD**: PRD-019
- **Tasks Covered**: PLAN-039 TASK-002, TASK-006, TASK-023
- **Dependencies**: none
- **Estimated effort**: 5.5 hours
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-11

## Objective

Implement `writeStateJson()` — the helper that atomically writes a request's `state.json` file to `<target_repo>/.autonomous-dev/requests/<id>/state.json` per TDD §6.1 schema and TDD §6.2 ordering. The helper enforces a path-traversal guard, validates request id format, creates parent directories, and uses the `${file}.tmp.$$` + atomic rename pattern. It always sets `phase_overrides: []` and `current_phase: "intake"` per the TDD-review SUGGESTION-1.

## Acceptance Criteria

1. (AC-038-05) Atomic temp+rename write — partial writes are never visible to readers.
2. (AC-038-06) Generated state.json contains all 19 fields enumerated in TDD §6.1 (id, status, current_phase, priority, created_at, updated_at, title, description, target_repo, source, type, blocked_by, phase_history, phase_overrides, current_phase_metadata, cost_accrued_usd, turn_count, escalation_count, schema_version, error).
3. (AC-038-07) Path-traversal guard rejects `..` segments, symlinks escaping target_repo, and absolute paths outside the repo allowlist.
4. `phase_overrides: []` is always present per SUGGESTION-1.
5. Request id must match `^REQ-\d{6}$` — otherwise typed error returned.
6. Parent directory created with `mkdir -p` equivalent; permission errors surface as typed errors, not stack traces.
7. Generated file passes the daemon's `validate_state_file()` predicate.

## Implementation

**Files created**
- `plugins/autonomous-dev/intake/lib/state_json_writer.ts`

**Public API**
```ts
export interface RequestEntity {
  request_id: string;
  status: string;
  current_phase: string;
  priority: 'high' | 'normal' | 'low' | string;
  created_at: string;
  updated_at: string;
  title: string;
  description: string;
  target_repo: string;
  source_channel: string;
  type: 'feature' | 'bug' | 'infra' | 'refactor' | 'hotfix' | string;
}

export class StateJsonError extends Error {
  constructor(public code: 'VALIDATION_ERROR' | 'PATH_ESCAPE' | 'PERMISSION_DENIED' | 'IO_ERROR', message: string);
}

export function writeStateJson(request: RequestEntity, targetRepo: string): string; // returns absolute path to state.json
```

**Schema** — exactly TDD §6.1 19 fields. Priority normalises to integer (`high=0`, `normal=1`, `low=2`).

**Path-traversal guard** — `path.resolve(reqDir)` must start with `path.resolve(targetRepo) + path.sep`. Reject symlink-escapes by `fs.realpathSync.native()` comparison on the parent dir if it exists.

**Atomic write** — write to `${file}.tmp.${process.pid}`, then `fs.renameSync()`. Never leave partial file on error path; unlink temp on catch.

## Tests

**Files created**
- `plugins/autonomous-dev/intake/__tests__/unit/state_json_writer.test.ts`

**Test cases**
1. `atomic_pattern` — concurrent read during write never observes partial JSON.
2. `path_traversal_guard` — rejects request id directing the path outside target_repo.
3. `schema_compliance` — output contains all 19 TDD §6.1 fields with correct types.
4. `phase_overrides_present` — `phase_overrides` is always `[]` on initial write (SUGGESTION-1).
5. `request_id_validation` — non-`REQ-\d{6}` ids throw `StateJsonError` code `VALIDATION_ERROR`.
6. `directory_creation` — creates `.autonomous-dev/requests/<id>/` recursively; permission denied surfaces as typed error.
7. `priority_mapping` — `high→0`, `normal→1`, `low→2`; unknown strings default to `1`.
8. `symlink_escape_rejected` — directory configured as symlink outside repo rejected.

## Verification

- `bun run typecheck`
- `bun test intake/__tests__/unit/state_json_writer.test.ts`
- Manual: write a state.json then run the daemon's `validate_state_file` against it and confirm acceptance.
