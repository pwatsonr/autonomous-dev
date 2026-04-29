# SPEC-012-1-01: Two-Phase Commit Protocol & Ordering Guarantees

## Metadata
- **Parent Plan**: PLAN-012-1
- **Tasks Covered**: Task 1 (Core interfaces), Task 2 (Path validation), Task 3 (Advisory locking), Task 4 (Two-phase commit core)
- **Estimated effort**: 8.5 hours

## Description
Implement the foundational two-phase commit protocol that bridges SQLite-based intake to filesystem-based daemon consumption. This spec defines the canonical API surface for `intake/core/handoff_manager.ts`, the temp-file → SQLite-txn → atomic-rename ordering that guarantees no data loss under crash conditions, plus path security and per-request advisory locking. Producer and consumer behavior are specified separately (SPEC-012-1-02, SPEC-012-1-03); this spec focuses on the protocol primitives those two sides share.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `intake/core/handoff_manager.ts` | Create | Canonical API + protocol primitives |
| `intake/core/types.ts` | Create | Shared interfaces (RequestSource, AdapterMetadata, etc.) |
| `intake/core/path_security.ts` | Create | `validateRequestId()`, `buildRequestPath()` |
| `intake/core/file_lock.ts` | Create | flock-based advisory locking |

## Implementation Details

### Task 1: Core Interfaces (`intake/core/types.ts`)

Export the following interfaces verbatim per TDD-012 §19.1:

```typescript
export type RequestSource =
  | 'cli' | 'discord' | 'slack' | 'github' | 'jira' | 'cron';

export interface AdapterMetadata {
  source: RequestSource;
  channelId?: string;       // Discord/Slack channel
  userId?: string;          // Source-system user identifier
  externalRef?: string;     // GitHub PR URL, Jira key, etc.
  threadId?: string;        // Discord thread / Slack thread_ts
  raw?: Record<string, unknown>;
}

export interface SubmitRequest {
  requestId: string;        // Must match /^REQ-\d{6}$/
  description: string;
  priority: 'high' | 'normal' | 'low';
  repository: string;       // Absolute path, must be in allowlist
  source: RequestSource;
  adapterMetadata: AdapterMetadata;
}

export interface HandoffOptions {
  lockTimeoutMs?: number;   // Default 10000
  fsync?: boolean;          // Default true
  recoverOnConflict?: boolean; // Default true
}

export interface HandoffResult {
  ok: true;
  requestId: string;
  statePath: string;        // Final state.json path
  committedAt: string;      // ISO 8601 UTC
} | {
  ok: false;
  requestId: string;
  failureMode: 'F1' | 'F2' | 'F3' | 'F4';
  error: string;            // Path-sanitized
  recoverable: boolean;
};
```

The `RequestSource` enum MUST contain exactly the 6 channels listed. `AdapterMetadata` MUST be JSON-serializable (no functions, no circular refs).

### Task 2: Path Validation (`intake/core/path_security.ts`)

```typescript
export function validateRequestId(id: string): void;
export function buildRequestPath(repo: string, requestId: string): string;
```

`validateRequestId(id)`:
- Throws `InvalidRequestIdError` if `id` does not match `^REQ-\d{6}$`.
- Reject empty string, whitespace, or any character outside the regex.

`buildRequestPath(repo, requestId)`:
1. Call `validateRequestId(requestId)` first.
2. Resolve `repo` via `fs.realpathSync(repo)` — throw `SecurityError` if it fails.
3. Verify `repo` is in the configured repository allowlist (`config.allowedRepositories`); throw `SecurityError` otherwise.
4. Compute `candidate = path.join(repo, '.autonomous-dev', 'requests', requestId)`.
5. Resolve `candidate` via `realpath` (parent must exist; the request dir itself may not yet).
6. Verify resolved path is a descendant of resolved `repo`; throw `SecurityError` on escape (symlink or `..`).
7. Return the resolved candidate path.

Errors must extend a base `HandoffError` class with a `code` discriminator (`PATH_INVALID`, `PATH_ESCAPE`, `REPO_NOT_ALLOWED`). Error messages MUST NOT include filesystem paths when `error.untrusted === true` is set on the throwing call site (used by network adapters).

### Task 3: Advisory File Locking (`intake/core/file_lock.ts`)

```typescript
export class FileLock {
  static async acquire(dir: string, timeoutMs: number): Promise<FileLock>;
  release(): Promise<void>;
}
```

Implementation:
- Lock file path: `{dir}/.lock`.
- Open with `O_CREAT | O_RDWR`, mode `0600`.
- Use `fs-ext` (or native `flock(2)` via `node:fs.flock` when available) with `LOCK_EX | LOCK_NB`.
- On `EWOULDBLOCK`, retry with exponential backoff (10ms → 20ms → 40ms → ... capped 500ms) until `timeoutMs` elapses; throw `LockTimeoutError` on expiry.
- `release()` calls `flock(LOCK_UN)` then `close()`. Auto-release on FD close (process exit guarantees this on POSIX).
- Cross-platform: macOS, Linux, WSL2. Windows is out of scope.

### Task 4: Two-Phase Commit Core (`intake/core/handoff_manager.ts`)

Export `submitRequest(req: SubmitRequest, opts?: HandoffOptions): Promise<HandoffResult>`.

The protocol — IN THIS EXACT ORDER:

1. **Validate** `req.requestId` and resolve `requestPath` via `buildRequestPath(req.repository, req.requestId)`.
2. **Acquire lock** via `FileLock.acquire(requestPath, opts.lockTimeoutMs ?? 10000)`. Create `requestPath` recursively if missing (`mkdir -p`, mode `0700`).
3. **Phase A — Temp write**:
   a. Compute `tmpPath = ${requestPath}/state.json.tmp.${process.pid}.${randomBytes(8).toString('hex')}`.
   b. Open with flags `O_CREAT | O_EXCL | O_WRONLY`, mode `0600`. `O_EXCL` ensures no two writers ever target the same temp.
   c. Write the serialized state JSON. Validate JSON via `JSON.parse(JSON.stringify(state))` round-trip before write.
   d. If `opts.fsync !== false`: call `fsync(fd)` then `close(fd)`. fsync MUST occur before any SQLite write.
4. **Phase B — SQLite txn**:
   a. Open the intake DB in WAL mode (`PRAGMA journal_mode=WAL`) with `PRAGMA busy_timeout=5000`.
   b. `BEGIN IMMEDIATE` transaction.
   c. Insert the request row, source row, and adapter_metadata row.
   d. `COMMIT`. This is the **logical commit point** of the system — once committed, the request exists.
5. **Phase C — Atomic rename**:
   a. `fs.rename(tmpPath, ${requestPath}/state.json)`.
   b. POSIX guarantees rename atomicity within the same filesystem; daemon readers see either the old file or the new file, never partial.
6. **Release** the lock and return `{ ok: true, requestId, statePath, committedAt }`.

**Failure mode classification (used for error reporting; rollback semantics defined in SPEC-012-1-03 recovery):**

| Mode | Where | SQLite state | FS state |
|------|-------|--------------|----------|
| F1 | Validation/lock | unchanged | unchanged |
| F2 | Temp write | unchanged | temp may exist (cleanup) |
| F3 | SQLite commit | rolled back | temp must be unlinked |
| F4 | Rename after SQLite commit | committed | temp marked `.needs_promotion` |

Each failure path maps to a `HandoffResult` with `ok: false`, the `failureMode`, a sanitized `error` string, and `recoverable: true` for F2/F3/F4 (F1 is `false` because the input is malformed).

### Ordering Guarantees (the contract this spec exists to enforce)

1. **Durability before commit**: `fsync(temp)` MUST complete before `BEGIN IMMEDIATE` of the SQLite txn. A crash after SQLite commit but before rename leaves a recoverable state (F4); a crash before fsync leaves no SQLite changes.
2. **Atomicity at rename**: the daemon MUST NOT observe a partial state.json. POSIX `rename(2)` on the same filesystem is atomic. Cross-filesystem renames are forbidden — `requestPath` and `tmpPath` MUST share a filesystem (same dir).
3. **No double-commit**: `O_EXCL` on the temp file prevents two concurrent producers from racing on the same `tmpPath`. Per-request advisory lock prevents two operations on the same request from interleaving Phase A/B/C steps.
4. **Lock-free readers**: daemon consumers do NOT take the advisory lock for read; they rely on rename atomicity (see SPEC-012-1-03).

## Acceptance Criteria

- [ ] All interfaces in `intake/core/types.ts` match TDD-012 §19.1 verbatim
- [ ] `validateRequestId` rejects all 8 cases from SPEC-011-1-01's test matrix
- [ ] `buildRequestPath` throws `SecurityError` for symlink escape (test: symlink `repo/x` → `/tmp`, request `REQ-000001`)
- [ ] `buildRequestPath` throws `SecurityError` when `repo` not in allowlist
- [ ] `FileLock.acquire` blocks a second acquirer on the same dir; second call returns within 5ms of first release
- [ ] `FileLock.acquire` does NOT block acquirers on different dirs (concurrent acquires complete in parallel)
- [ ] `FileLock.acquire` throws `LockTimeoutError` after `timeoutMs` elapses
- [ ] Temp file path matches the regex `state\.json\.tmp\.\d+\.[0-9a-f]{16}$`
- [ ] Temp file opened with `O_EXCL`; second write to same path fails with `EEXIST`
- [ ] `fsync(temp)` is invoked before any SQLite write (verified via mocking + call-order assertion)
- [ ] SQLite opened with `PRAGMA journal_mode=WAL` and `PRAGMA busy_timeout=5000`
- [ ] On successful submit: `state.json` exists at `requestPath`, no `.tmp.*` files remain, SQLite has the row
- [ ] Returned `committedAt` is ISO 8601 UTC and within 1s of wall clock
- [ ] All `HandoffError` messages with `untrusted: true` contain no filesystem paths (regex `/\/[^\s]+/` does not match)

## Test Cases

1. **Happy path** — Submit a valid request; assert state.json exists, SQLite row exists, no temp files, `ok: true`.
2. **F1 — invalid request ID** — `requestId: "REQ-12"`. Assert `ok: false, failureMode: 'F1', recoverable: false`.
3. **F1 — repo not in allowlist** — Submit with `repository: '/tmp/evil'`. Assert `SecurityError` → F1.
4. **F2 — disk full during temp write** — Mock `fs.write` to throw `ENOSPC`. Assert no SQLite changes, no state.json, no orphan temp.
5. **F3 — SQLite commit fails** — Mock `db.commit` to throw. Assert temp file removed, SQLite rolled back.
6. **F4 — rename fails after SQLite commit** — Mock `fs.rename` to throw `EACCES`. Assert SQLite has the row, temp file is renamed to `*.needs_promotion`, result is `recoverable: true`.
7. **Lock contention same request** — Two concurrent `submitRequest` calls with the same `requestId`. Assert one wins, the other blocks then either succeeds (after first finishes) or times out per `lockTimeoutMs`.
8. **Lock independence different requests** — 50 concurrent submissions with distinct IDs complete with no serialization (total time < 2× single-submit time).
9. **Path traversal via request ID** — `requestId: 'REQ-000001/../../etc'` — caught by regex in Task 2.
10. **Symlink escape** — `mkdir -p repo/.autonomous-dev/requests; ln -s /tmp repo/.autonomous-dev/requests/REQ-999999`. Submit `REQ-999999`. Assert `SecurityError`.

## Dependencies

- Node.js `fs/promises`, `crypto.randomBytes`, `path.resolve`.
- `better-sqlite3` (or equivalent synchronous SQLite binding) for WAL + `BEGIN IMMEDIATE`.
- `fs-ext` package for `flock(2)` bindings on platforms where `node:fs.flock` is unavailable.
- Repository allowlist from `config.allowedRepositories` — surface this via the existing config loader (do not introduce a new one).

## Notes

- This spec defines the **protocol** only. Producer-side state-object construction is in SPEC-012-1-02. Consumer-side reading and acknowledgment is in SPEC-012-1-03. Recovery (orphaned temps, `.needs_promotion` replay) is in SPEC-012-1-04.
- `BEGIN IMMEDIATE` is required (not `BEGIN`) so SQLite acquires the reserved lock at txn start, not at first write — eliminates `SQLITE_BUSY` mid-transaction surprises.
- Do NOT use `BEGIN EXCLUSIVE` — it serializes all readers, and we want the daemon to read SQLite metadata concurrently.
- The temp-file random suffix (8 bytes hex = 16 chars) is for collision-avoidance under high concurrency, NOT for security. The `O_EXCL` flag is the actual safety mechanism.
