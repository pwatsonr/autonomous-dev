# SPEC-012-1-02: Producer Side — Intake Router Request Artifact Write

## Metadata
- **Parent Plan**: PLAN-012-1
- **Tasks Covered**: Task 5 (Rollback & cleanup), Task 7 (State transition functions)
- **Estimated effort**: 5 hours

## Description
Implement the producer side of the two-phase commit handoff: the intake-router's responsibility to construct, validate, and submit the request artifact. This spec defines how `submitRequest()` is invoked, the exact JSON payload written to `state.json.tmp`, the rollback handlers for F1–F3 failures, and the four state-transition functions (`pauseRequest`, `resumeRequest`, `cancelRequest`, `setPriority`) that reuse the same two-phase pattern. Protocol primitives are defined in SPEC-012-1-01 — this spec describes how the producer USES them.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `intake/core/handoff_manager.ts` | Modify | Add `pauseRequest`, `resumeRequest`, `cancelRequest`, `setPriority` |
| `intake/core/state_artifact.ts` | Create | `buildInitialState()`, `applyTransition()` |
| `intake/router/request_submitter.ts` | Create | Bridge from intake-router into `submitRequest` |
| `intake/router/rollback_handler.ts` | Create | F1/F2/F3 cleanup logic |

## Implementation Details

### State Artifact Construction (`intake/core/state_artifact.ts`)

```typescript
export interface InitialState {
  schema_version: 1;
  request_id: string;
  status: 'queued';
  priority: 'high' | 'normal' | 'low';
  description: string;
  repository: string;
  source: RequestSource;
  adapter_metadata: AdapterMetadata;
  created_at: string;       // ISO 8601 UTC
  updated_at: string;       // == created_at on first write
  paused_from?: never;      // Forbidden on initial state
  phase_history: [];        // Empty on submit
  current_phase_metadata: {};
  cost_accrued_usd: 0;
  turn_count: 0;
  escalation_count: 0;
  blocked_by: [];
  error: null;
  last_checkpoint: null;
}

export function buildInitialState(req: SubmitRequest): InitialState;
```

`buildInitialState`:
- Set `created_at` and `updated_at` to `new Date().toISOString()` (must be identical).
- `phase_history` MUST be empty `[]` (not undefined).
- `adapter_metadata` is taken from `req.adapterMetadata` after a `JSON.parse(JSON.stringify(...))` round-trip to strip non-serializable values.
- The result MUST pass JSON-stringify with no errors before being passed to `submitRequest`.

### Request Submission (`intake/router/request_submitter.ts`)

```typescript
export async function submitFromRouter(
  req: SubmitRequest,
  opts?: HandoffOptions
): Promise<HandoffResult>;
```

Behavior:
1. Build the initial state via `buildInitialState(req)`.
2. Pass to `submitRequest()` from SPEC-012-1-01.
3. On `ok: false` with `recoverable: true`: log a structured error, return the result unchanged. The router does NOT retry — retry policy is the caller's decision.
4. On `ok: false` with `recoverable: false`: log at ERROR level and return.
5. On `ok: true`: emit a `request.submitted` event on the internal event bus (existing infrastructure) with `{ requestId, source, committedAt }`.

### Rollback Handlers (`intake/router/rollback_handler.ts`)

The rollback handler runs WITHIN `submitRequest` (passed as a callback) to keep cleanup transactional with detection. Each F-mode has distinct semantics:

```typescript
export async function rollbackF1(ctx: RollbackContext): Promise<void>;
export async function rollbackF2(ctx: RollbackContext): Promise<void>;
export async function rollbackF3(ctx: RollbackContext): Promise<void>;
// F4 is NOT a rollback — it's a forward-recovery handled in SPEC-012-1-04
```

| Handler | Action |
|---------|--------|
| `rollbackF1` | No-op for FS/SQLite. Log validation error. |
| `rollbackF2` | If `tmpPath` exists, `unlink(tmpPath)` (idempotent — `ENOENT` is success). No SQLite work needed (txn never opened). |
| `rollbackF3` | `db.rollback()` (idempotent if already rolled back). Then `unlink(tmpPath)` (idempotent). |

**Idempotency requirement:** every handler MUST be safe to call multiple times. If `unlink` fails with `ENOENT`, treat as success. If SQLite reports "no transaction in progress", treat as success.

**Path sanitization:** all error log messages produced by rollback handlers MUST pass through the same path-sanitization utility used by `HandoffError` (see SPEC-012-1-01) when the source is `discord`, `slack`, or `github`.

### State Transition Functions

All four transitions reuse the two-phase pattern: read current state.json, mutate, write via `submitRequest`-style two-phase commit (without re-inserting the SQLite request row — only updating it).

```typescript
export async function pauseRequest(requestId: string, reason?: string): Promise<HandoffResult>;
export async function resumeRequest(requestId: string): Promise<HandoffResult>;
export async function cancelRequest(requestId: string, reason?: string): Promise<HandoffResult>;
export async function setPriority(requestId: string, priority: 'high'|'normal'|'low'): Promise<HandoffResult>;
```

**Common protocol** (each transition):
1. Acquire per-request lock (same as SPEC-012-1-01 Task 3).
2. Read current `state.json` via `fs.readFile` + `JSON.parse`. If missing or corrupt: return `{ ok: false, failureMode: 'F1', recoverable: false }`.
3. Apply the transition mutation in memory (see table below).
4. Update `updated_at` to current ISO 8601.
5. Append a `phase_history` entry with the transition type (`paused`, `resumed`, `cancelled`, `priority_changed`).
6. Write to a fresh temp file, fsync.
7. Update SQLite request row (`UPDATE requests SET status=?, priority=?, updated_at=? WHERE request_id=?`) inside `BEGIN IMMEDIATE` txn.
8. Atomic rename.
9. Release lock, return result.

**Per-transition mutations:**

| Function | Pre-condition | Mutation |
|----------|---------------|----------|
| `pauseRequest` | `status NOT IN ('paused','cancelled','completed')` | Set `paused_from = status`; `status = 'paused'` |
| `resumeRequest` | `status === 'paused' && paused_from != null` | Set `status = paused_from`; delete `paused_from` |
| `cancelRequest` | `status NOT IN ('cancelled','completed')` | Set `status = 'cancelled'`; emit `request.cancelled` event for downstream worktree/branch cleanup |
| `setPriority` | `status NOT IN ('cancelled','completed')` | Set `priority = newPriority` |

Pre-condition violations return `{ ok: false, failureMode: 'F1', error: 'INVALID_TRANSITION', recoverable: false }`.

**Cancel post-action:** `cancelRequest` emits `request.cancelled` AFTER the rename succeeds (not before). This event triggers worktree/branch cleanup in a separate subsystem; cleanup is best-effort and out of scope for this spec.

### Phase History Entry Shape

```typescript
{
  type: 'submitted' | 'paused' | 'resumed' | 'cancelled' | 'priority_changed',
  at: string,        // ISO 8601 UTC
  from?: string,     // Previous status (paused/resumed)
  to?: string,       // New status
  reason?: string,   // Caller-provided
  metadata?: Record<string, unknown>
}
```

## Acceptance Criteria

- [ ] `buildInitialState` returns an object where `created_at === updated_at` and `phase_history.length === 0`
- [ ] `buildInitialState` strips non-serializable values from `adapterMetadata` (tested with `{fn: () => 1}`)
- [ ] `submitFromRouter` emits `request.submitted` event exactly once on success, never on failure
- [ ] `submitFromRouter` does NOT emit any event on failure
- [ ] `rollbackF2` is idempotent — calling twice returns success both times
- [ ] `rollbackF3` calls `db.rollback()` AND `unlink(tmpPath)` even if rollback throws
- [ ] All rollback handler error messages with source `discord`/`slack`/`github` contain no `/`-prefixed paths
- [ ] `pauseRequest` rejects when `status === 'paused'` (idempotency check) with `INVALID_TRANSITION`
- [ ] `pauseRequest` stores `paused_from = <previous status>` in state.json
- [ ] `resumeRequest` rejects when `paused_from` is not set
- [ ] `resumeRequest` removes the `paused_from` field after restoring
- [ ] `cancelRequest` emits `request.cancelled` event AFTER successful rename, not before
- [ ] `setPriority` rejects priorities not in `{high, normal, low}` at the API boundary
- [ ] Each transition appends exactly one `phase_history` entry with the correct `type`
- [ ] Each transition updates `updated_at` to a value `>=` `created_at`

## Test Cases

1. **Submit happy path** — `submitFromRouter` with valid input. Assert state.json exists, SQLite row exists, `request.submitted` event fired with correct payload.
2. **Submit F2 disk full** — Mock `fs.write` to throw `ENOSPC`. Assert no SQLite row, no state.json, no event fired, no orphan temp.
3. **Submit F3 SQLite failure** — Mock SQLite commit to throw. Assert temp file removed, no state.json, no event fired.
4. **buildInitialState non-serializable** — Pass `adapterMetadata: { fn: () => 1, ok: 'yes' }`. Assert result has `adapter_metadata: { ok: 'yes' }` only.
5. **Pause from queued** — Pause `REQ-000001` with `status: queued`. Assert state.json `status === 'paused'`, `paused_from === 'queued'`, history entry type `paused`.
6. **Pause idempotent rejection** — Pause an already-paused request. Assert `INVALID_TRANSITION`, state.json unchanged.
7. **Resume restores status** — After pause-from-running, resume. Assert `status === 'running'`, `paused_from` absent.
8. **Resume without paused_from** — Resume a queued request. Assert `INVALID_TRANSITION`.
9. **Cancel emits event** — Cancel a running request. Assert `request.cancelled` event fired AFTER rename completed (use a hook to verify ordering).
10. **Cancel completed request** — Cancel `status === 'completed'`. Assert `INVALID_TRANSITION`, no event.
11. **setPriority happy path** — Change priority `normal → high`. Assert SQLite row priority updated, state.json updated, `phase_history` has `priority_changed` entry.
12. **setPriority invalid value** — Pass `priority: 'urgent'`. Assert TypeScript compile error or runtime `INVALID_TRANSITION`.
13. **Concurrent transitions** — Two `setPriority` calls on the same request. Assert serialized via lock; both succeed; final state reflects whichever ran last; `phase_history` has both entries in order.
14. **Path-sanitized error from Discord adapter** — Trigger F2 with `source: 'discord'`. Assert error message has no `/var/...` substrings.

## Dependencies

- SPEC-012-1-01 — `submitRequest`, `validateRequestId`, `FileLock`, `HandoffError` types
- Existing event bus (current internal infrastructure) for `request.submitted` and `request.cancelled` events
- `better-sqlite3` for SQLite UPDATE statements

## Notes

- The transition functions intentionally re-read state.json from disk rather than caching. This keeps the protocol simple and avoids cache-coherence bugs across processes. The lock guarantees no other writer races us.
- `paused_from` is intentionally OPTIONAL in the schema — it exists only while paused. Resume removes it. The schema validator (existing) MUST allow its absence.
- `request.cancelled` event ordering matters: emitting BEFORE rename means downstream cleanup sees an inconsistent state if rename fails. Emit AFTER rename only.
- We do NOT support transitioning to `paused` while another transition is mid-flight (the lock handles this), but we DO allow rapid pause→resume→pause sequences as long as each completes the full protocol.
- Worktree/branch cleanup on cancel is intentionally async and best-effort. If it fails, the request is still cancelled — operators reconcile via the recovery CLI (PLAN-012-3).
