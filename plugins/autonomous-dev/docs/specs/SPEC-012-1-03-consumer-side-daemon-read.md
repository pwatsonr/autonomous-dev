# SPEC-012-1-03: Consumer Side — Daemon Read & Acknowledgment

## Metadata
- **Parent Plan**: PLAN-012-1
- **Tasks Covered**: Task 5 (partial-failure handling on consumer side)
- **Estimated effort**: 4 hours

## Description
Implement the consumer side of the two-phase commit handoff: the daemon's read path. The daemon polls the filesystem for new request directories, reads `state.json` lock-free, validates against the schema, acknowledges receipt back to SQLite, and handles partial-failure scenarios where the producer's write was incomplete or in-flight. This spec defines the read protocol, ordering rules, and exactly how the daemon distinguishes "not yet committed" from "corrupt" from "needs promotion." Producer-side write protocol is in SPEC-012-1-02; recovery for orphaned temps is in SPEC-012-1-04.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `intake/daemon/state_reader.ts` | Create | `readState()`, `pollNewRequests()` |
| `intake/daemon/acknowledger.ts` | Create | `acknowledgeRequest()` — marks SQLite row consumed |
| `intake/daemon/partial_failure_classifier.ts` | Create | Classifies temp-file states |

## Implementation Details

### State Reader (`intake/daemon/state_reader.ts`)

```typescript
export type ReadResult =
  | { ok: true; state: ParsedState; statePath: string }
  | { ok: false; reason: 'NOT_FOUND' | 'PARSE_ERROR' | 'SCHEMA_INVALID'; details: string };

export async function readState(requestPath: string): Promise<ReadResult>;
export async function pollNewRequests(repo: string): Promise<string[]>; // Returns request IDs
```

`readState(requestPath)`:
1. Resolve `statePath = ${requestPath}/state.json`.
2. `fs.readFile(statePath, 'utf8')`. On `ENOENT` return `{ ok: false, reason: 'NOT_FOUND' }`.
3. **`ENOENT` is NOT necessarily an error**: a request directory may exist without a state.json if the producer is mid-write. Caller decides if this is a problem.
4. `JSON.parse` the contents. On `SyntaxError` return `{ ok: false, reason: 'PARSE_ERROR', details: <error.message> }`.
   - **Important**: a parse error on `state.json` SHOULD NEVER happen because rename atomicity guarantees the file is either complete-old or complete-new. If it occurs, this is a hard error and the daemon MUST NOT consume it; the file is escalated to recovery (SPEC-012-1-04).
5. Validate against the schema (use existing `validateState()` from intake/core). On failure return `{ ok: false, reason: 'SCHEMA_INVALID', details }`.
6. On success return `{ ok: true, state, statePath }`.

`pollNewRequests(repo)`:
1. List `${repo}/.autonomous-dev/requests/` directories.
2. For each subdirectory `dir`:
   - Skip if name does not match `^REQ-\d{6}$` (defensive — buildRequestPath should have prevented this).
   - Skip if `${dir}/state.json` does not exist (in-flight or recovery target).
   - Skip if SQLite has `acknowledged_at IS NOT NULL` for this request (already consumed).
3. Return the list of request IDs needing consumption, sorted by SQLite `created_at` ascending (FIFO for fairness within same priority).
4. Within the same `created_at` second, secondary sort by priority desc (`high` > `normal` > `low`).

The daemon does NOT take the `.lock` file when reading. Rename atomicity is the read-side guarantee. This means the daemon may observe a state.json that is being concurrently REPLACED by a transition (pause/resume/cancel). That's fine — the daemon will see either the pre-transition or post-transition snapshot, both valid.

### Acknowledger (`intake/daemon/acknowledger.ts`)

```typescript
export async function acknowledgeRequest(
  requestId: string,
  consumerId: string  // Daemon instance ID for multi-daemon scenarios
): Promise<{ ok: true } | { ok: false; reason: 'ALREADY_ACKED' | 'NOT_FOUND' | 'DB_ERROR' }>;
```

Behavior:
1. Open the intake DB (WAL mode, busy_timeout=5000).
2. `BEGIN IMMEDIATE` transaction.
3. `SELECT acknowledged_at FROM requests WHERE request_id = ?`.
   - If no row: rollback, return `NOT_FOUND`.
   - If `acknowledged_at IS NOT NULL`: rollback, return `ALREADY_ACKED`.
4. `UPDATE requests SET acknowledged_at = ?, acknowledged_by = ? WHERE request_id = ?` (timestamp = ISO 8601 UTC).
5. `COMMIT`.

Acknowledgment is idempotent at the **outcome** level: a second call returns `ALREADY_ACKED`, not an error. Callers SHOULD treat `ALREADY_ACKED` as success in most cases.

### Partial Failure Classifier (`intake/daemon/partial_failure_classifier.ts`)

```typescript
export type TempStatus =
  | 'IN_FLIGHT'       // Recent temp, producer likely still writing
  | 'NEEDS_PROMOTION' // Marked .needs_promotion by F4 handler
  | 'ORPHANED'        // Old temp, no producer alive (recovery target)
  | 'CORRUPT';        // Marked .corrupt by recovery

export function classifyTempFile(path: string): Promise<TempStatus>;
```

Classification rules:
1. If filename ends `.needs_promotion`: return `NEEDS_PROMOTION`.
2. If filename ends `.corrupt`: return `CORRUPT`.
3. Filename pattern is `state.json.tmp.<pid>.<random>`:
   - Extract `<pid>`. Check if process is alive (`process.kill(pid, 0)` — throws if dead).
   - If process is alive AND file mtime within last 60 seconds: return `IN_FLIGHT`.
   - Otherwise: return `ORPHANED`.

The daemon's read loop MUST:
- Skip `IN_FLIGHT` temps (producer is working — leave them alone).
- NOT promote `NEEDS_PROMOTION` temps (that's recovery's job — SPEC-012-1-04).
- Skip `ORPHANED` and `CORRUPT` (recovery handles them).

### Read Loop Integration

The daemon polling loop (existing infrastructure) wires these together:

```
loop:
  ids = pollNewRequests(repo)
  for id in ids:
    requestPath = buildRequestPath(repo, id)  // SPEC-012-1-01
    result = readState(requestPath)
    switch result:
      case { ok: true }:
        ack = acknowledgeRequest(id, daemonId)
        if ack.ok: enqueue(state)
        else if ack.reason === 'ALREADY_ACKED': continue  // Another daemon got it
        else log_error(ack)
      case { reason: 'NOT_FOUND' }:
        # Producer in-flight; skip and retry next poll
        continue
      case { reason: 'PARSE_ERROR' | 'SCHEMA_INVALID' }:
        log_error_with_paging  # Hard error, never expected
        mark_for_recovery(id)
  sleep(pollIntervalMs)
```

### Ordering Guarantees (consumer side)

1. **No torn reads**: rename atomicity guarantees the daemon never sees a half-written state.json.
2. **At-least-once delivery**: the daemon MAY read and acknowledge a request multiple times if it crashes between read and ack-commit. Downstream consumers MUST be idempotent on `requestId`.
3. **At-most-once acknowledgment**: SQLite UPDATE inside `BEGIN IMMEDIATE` ensures `acknowledged_at` is set exactly once, no matter how many daemons race.
4. **In-flight tolerance**: the daemon MUST tolerate `state.json` not existing yet — it is not an error, just a not-yet-readable state.

### Error Sanitization

All daemon error messages exposed via the daemon's external API (HTTP, IPC) MUST pass through path-sanitization. Internal logs MAY contain paths but only at DEBUG level.

## Acceptance Criteria

- [ ] `readState` returns `NOT_FOUND` (not error) when state.json doesn't exist
- [ ] `readState` returns `PARSE_ERROR` for malformed JSON with the parser error in `details`
- [ ] `readState` returns `SCHEMA_INVALID` for valid JSON that fails schema validation
- [ ] `pollNewRequests` skips already-acknowledged requests
- [ ] `pollNewRequests` skips directories without state.json (in-flight)
- [ ] `pollNewRequests` skips directories with names not matching `^REQ-\d{6}$`
- [ ] `pollNewRequests` returns FIFO order by SQLite `created_at`
- [ ] `pollNewRequests` ties broken by priority desc (`high` first)
- [ ] `acknowledgeRequest` returns `ALREADY_ACKED` (not error) on second call
- [ ] `acknowledgeRequest` runs inside `BEGIN IMMEDIATE` (verified via mock)
- [ ] `classifyTempFile` returns `IN_FLIGHT` for fresh temp from live PID
- [ ] `classifyTempFile` returns `ORPHANED` for temp from dead PID
- [ ] `classifyTempFile` returns `ORPHANED` for temp older than 60s even from live PID
- [ ] `classifyTempFile` returns `NEEDS_PROMOTION` for `.needs_promotion` suffix
- [ ] `classifyTempFile` returns `CORRUPT` for `.corrupt` suffix
- [ ] Daemon read loop does NOT acquire the per-request `.lock` file
- [ ] Daemon error messages exposed externally contain no FS paths

## Test Cases

1. **Read happy path** — Pre-create a valid state.json. Call `readState`. Assert `ok: true`, state matches.
2. **Read missing state.json** — Empty request dir. Assert `NOT_FOUND` (not exception).
3. **Read mid-rename concurrency** — Producer writes state.json; reader concurrently reads. Run 1000 iterations. Assert no `PARSE_ERROR` ever observed (POSIX rename atomicity test).
4. **Read corrupt JSON** — Manually write `{broken` to state.json. Assert `PARSE_ERROR`, error logged at ERROR level.
5. **Read schema invalid** — Write valid JSON missing `request_id`. Assert `SCHEMA_INVALID`.
6. **Poll skips acknowledged** — Submit 3 requests, ack 2, poll. Assert returns 1 (the unacked).
7. **Poll FIFO ordering** — Submit 5 requests with same priority spaced 1s apart. Poll. Assert order matches `created_at`.
8. **Poll priority tiebreak** — Submit two requests at same `created_at` with different priorities. Assert `high` returned first.
9. **Poll skips in-flight** — Create request dir without state.json (mid-write). Assert poll skips it.
10. **Acknowledge happy path** — Ack a request. SELECT row. Assert `acknowledged_at IS NOT NULL`.
11. **Acknowledge idempotent** — Ack same request twice. Assert second returns `ALREADY_ACKED`, no DB-level error.
12. **Acknowledge race condition** — Two daemons concurrently ack same request. Assert exactly one wins, the other gets `ALREADY_ACKED`.
13. **Classify in-flight** — Create temp file with current PID, fresh mtime. Assert `IN_FLIGHT`.
14. **Classify orphaned dead PID** — Create temp file with PID 999999 (dead). Assert `ORPHANED`.
15. **Classify orphaned by age** — Create temp with current PID, mtime 120s old. Assert `ORPHANED`.
16. **Classify needs promotion** — Touch `state.json.tmp.123.abcd.needs_promotion`. Assert `NEEDS_PROMOTION`.
17. **Daemon error has no path** — Trigger schema invalid; assert daemon's external error response has no `/`-prefixed paths.

## Dependencies

- SPEC-012-1-01 — `buildRequestPath`, schema validator, error types
- Existing daemon poll loop infrastructure (will call into these new functions)
- `better-sqlite3` for the acknowledgment transaction

## Notes

- We deliberately do NOT use inotify/fsevents for change notification. Polling at 250ms is simpler and avoids cross-platform fragility. The protocol's correctness does not depend on notification latency.
- The daemon SHOULD NOT consume requests faster than the producer can submit — backpressure is implicit via the poll interval. If queue depth grows, that's a capacity problem solved elsewhere.
- `acknowledged_by` (consumer ID) exists for forensics in multi-daemon scenarios. Not used by core protocol.
- The 60-second IN_FLIGHT threshold is calibrated to typical disk write latency (sub-second) plus a wide margin for slow CI machines. Operators may tune this in config but the default should not need changing.
- A `PARSE_ERROR` on state.json indicates either (a) filesystem corruption, (b) a bug in the producer, or (c) someone manually edited the file. All three are operator-pageable events. The daemon does NOT auto-recover; it surfaces the error.
- Schema validation reuses the existing `validateState()` function — do NOT reimplement.
