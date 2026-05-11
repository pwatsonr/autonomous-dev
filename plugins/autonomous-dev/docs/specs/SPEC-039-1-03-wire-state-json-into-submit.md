# SPEC-039-1-03: Wire state.json into SubmitHandler

## Metadata
- **Parent Plan**: PLAN-039
- **Parent TDD**: TDD-038
- **Parent PRD**: PRD-019
- **Tasks Covered**: PLAN-039 TASK-003, TASK-004, TASK-007
- **Dependencies**: SPEC-039-1-02
- **Estimated effort**: 4.5 hours
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-11

## Objective

Wire `writeStateJson()` into `SubmitHandler.execute()` so that every successful submit produces both a SQLite row AND a `state.json` file. Propagate the `--type` flag (`feature|bug|infra|refactor|hotfix`) end-to-end into both stores. Per TDD §6.2 MINOR-1, preserve **SQLite-first** ordering: the row is inserted first; if state.json writing fails the operator gets a hard error but the SQLite row remains (which the orphan reconciliation pass in SPEC-039-1-04 will later resolve).

## Acceptance Criteria

1. (AC-038-08) After a successful `submit`, both the SQLite row AND the state.json exist with matching fields (id, title, description, target_repo, type, status, priority, created_at).
2. SQLite-first ordering preserved per TDD MINOR-1 (insert → write).
3. `--type` flag value appears in SQLite `type` column and `state.json.type`.
4. If `writeStateJson()` throws, the operator sees the typed error and the request is logged at WARN with id (orphan-recoverable).
5. Integration test confirms daemon's `select_request()` discovers the resulting state file.

## Implementation

**Files modified**
- `plugins/autonomous-dev/intake/handlers/submit_handler.ts`

**Insertion point** — between `insertRequest()` (current line ~227) and the queue-position query (~line 229).

**Wiring**
```ts
import { writeStateJson, StateJsonError } from '../lib/state_json_writer';

const request = await this.deps.db.insertRequest({ /* existing args */ });

try {
  writeStateJson(request, flags.repo as string);
} catch (err) {
  if (err instanceof StateJsonError) {
    this.logger?.warn('state_json_write_failed', { request_id: request.request_id, code: err.code });
    throw err;
  }
  throw err;
}
```

**Type propagation** — ensure the `type` flag (defaulted to `feature`) is included in the `RequestEntity` passed to both `insertRequest()` and `writeStateJson()`.

## Tests

**Files created**
- `plugins/autonomous-dev/intake/__tests__/integration/submit_to_state.test.ts`

**Test cases**
1. `submit_creates_both_sqlite_and_state_json` — assert both exist with matching id + type after submit (AC-038-08).
2. `type_propagation` — `--type bug` ends up in `state.json.type === "bug"` AND SQLite row's type column.
3. `daemon_select_request_compatibility` — after submit, the daemon's `select_request()` returns the row.
4. `sqlite_first_ordering` — when `writeStateJson()` throws (force chmod 000 on target dir), SQLite row exists (recoverable via reconciliation).
5. `error_propagation` — operator receives a typed error message containing the request id and a remediation hint.

## Verification

- `bun run typecheck`
- `bun test intake/__tests__/integration/submit_to_state.test.ts`
- Manual: `autonomous-dev request submit "test" --repo /tmp/test-repo --type feature` then `sqlite3 ~/.autonomous-dev/intake.db` and `cat /tmp/test-repo/.autonomous-dev/requests/REQ-*/state.json` both show matching rows.
