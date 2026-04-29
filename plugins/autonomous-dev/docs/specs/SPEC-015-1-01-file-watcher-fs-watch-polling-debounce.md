# SPEC-015-1-01: FileWatcher — Bun fs.watch + Polling Fallback + 200ms Debounce

## Metadata
- **Parent Plan**: PLAN-015-1
- **Tasks Covered**: TASK-001 (FileWatcher core)
- **Estimated effort**: 6 hours

## Description

Implement the foundational `FileWatcher` class that monitors daemon state files with two execution modes: native `fs.watch` (preferred) and polling fallback (when fd-limit is hit or native watching errors). All file change events are debounced through a 200ms quiet window to coalesce rapid bursts (atomic writes via temp+rename, batched updates, log rotations) into single emissions per path. The class watches the four daemon-managed file groups documented in TDD-015: `<repo>/.autonomous-dev/requests/*/state.json`, `<repo>/.autonomous-dev/cost-ledger.json`, `<repo>/.autonomous-dev/heartbeat.json`, and `<repo>/.autonomous-dev/daemon.log`.

The watcher is a pure infrastructure primitive: it emits typed change events to listeners but does not parse files, invalidate caches, or drive SSE delivery. Cache invalidation, SSE fan-out, and accessor refreshes wire onto `FileWatcher`'s event bus in subsequent specs (SPEC-015-1-02, SPEC-015-1-03, SPEC-015-1-04).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `src/portal/watchers/FileWatcher.ts` | Create | Core class with native + polling backends, debounce, lifecycle |
| `src/portal/watchers/types.ts` | Create | `FileChangeEvent`, `FileWatcherOptions`, `WatchMode` enum |
| `src/portal/watchers/glob-resolver.ts` | Create | Pattern resolution helper (wraps `Bun.glob` / `glob` library) |
| `src/portal/watchers/index.ts` | Create | Barrel export of `FileWatcher`, types |
| `package.json` | Modify | Add `glob` dep if not already present from PLAN-013-2 |

## Implementation Details

### Public API (`src/portal/watchers/types.ts`)

```typescript
export type WatchMode = 'native' | 'polling';

export type FileEventType = 'change' | 'create' | 'delete' | 'error';

export interface FileChangeEvent {
  type: FileEventType;
  filePath: string;        // absolute, canonical (via fs.realpath)
  timestamp: Date;          // event emit time (post-debounce)
  mode: WatchMode;          // which backend produced this
  error?: Error;            // populated only when type === 'error'
}

export interface FileWatcherOptions {
  /** Force polling mode regardless of native availability. Default: false. */
  polling?: boolean;
  /** Polling interval in ms. Default: 1000. Must be >= 100. */
  pollingInterval?: number;
  /** Debounce window in ms. Default: 200. Set to 0 to disable. */
  debounceDelay?: number;
  /** Max native watchers before forcing polling mode. Default: 100. */
  maxFileDescriptors?: number;
  /** Optional logger for diagnostic output (defaults to console.warn). */
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
}

export interface FileWatcher {
  start(): Promise<void>;
  dispose(): void;
  isWatching(): boolean;
  getWatchedFiles(): string[];
  getMode(): WatchMode | 'mixed';
  on(event: 'fileChange', listener: (e: FileChangeEvent) => void): this;
  on(event: 'error', listener: (e: Error) => void): this;
  off(event: string, listener: Function): this;
}
```

### `FileWatcher` class (`src/portal/watchers/FileWatcher.ts`)

Extends `EventEmitter`. Constructor signature: `new FileWatcher(patterns: string[], options?: FileWatcherOptions)`.

**Patterns** are absolute glob strings. The watcher resolves them on `start()` and again whenever a `create` event fires for a directory that could match. (Re-resolution on every event is too expensive; instead, the watcher attaches a directory watcher on each pattern's parent and re-globs only when the parent changes.)

**Backend selection (in `start()`)**:

1. If `options.polling === true`, skip native and go to polling for ALL files.
2. Else, resolve patterns to a concrete file list. For each file, attempt `fs.watch(filePath, { persistent: false }, listener)`.
3. Track an `nativeCount` counter. If `nativeCount >= maxFileDescriptors`, the next file (and all remaining) go to polling. Log a warning at the boundary.
4. If `fs.watch` throws (EMFILE, ENFILE, ENOSPC, EACCES on individual files), fall back to polling FOR THAT FILE ONLY — do not abort other native watchers. Log the error via `options.logger`.

**Mixed mode**: it is valid for the watcher to have some files on native and others on polling simultaneously. `getMode()` returns `'mixed'` when both backends are active; otherwise the active backend.

### Polling backend

Polling uses `Bun.file(filePath).stat()` (or `fs.promises.stat` if `Bun.file().stat` is unavailable) on a `setInterval` per file at `pollingInterval` ms. Compare `mtime` against the cached value:

- If the file existed previously and `mtime > lastMtime` → emit `change`.
- If the file existed previously and stat throws ENOENT → emit `delete`, drop the cached mtime.
- If the file did not exist previously and stat now succeeds → emit `create`, cache the mtime.
- Other stat errors → emit `error` with the underlying error; do not stop polling.

**First-poll suppression**: the very first stat per file establishes the baseline mtime and MUST NOT emit a `create` or `change` event. This prevents a synthetic burst on `start()` from files that already exist.

### Debouncing

The `_handleRawEvent(filePath, type, error?)` method is the single funnel for both backends. It:

1. Looks up an existing debounce timer for `filePath`. If present, clears it.
2. Stores `{ type, error, firstSeenAt }` in a per-path "pending event" map. If a pending event already exists, the new type wins UNLESS the existing pending type is `error` (errors take precedence and are never overwritten).
3. Sets a `setTimeout(() => emit, options.debounceDelay)`.
4. When the timer fires: deletes the pending entry, deletes the timer, builds a `FileChangeEvent` with `timestamp = new Date()`, and emits `'fileChange'`.

When `debounceDelay === 0`, the funnel emits synchronously without timer scheduling.

**Coalescing semantics**: a burst of N raw events on the same path within the debounce window produces exactly ONE emission whose `type` reflects the LAST raw type observed (with the error-precedence exception above). This satisfies PLAN-015-1 acceptance "100 file events within 200ms result in ≤5 SSE dispatches" — a single watcher path produces 1 dispatch per debounce window.

### Lifecycle

- `start()` MUST be called exactly once. Subsequent calls reject with `Error('FileWatcher already started')`.
- `dispose()` MUST be idempotent. It:
  1. Marks `disposed = true` (further events are dropped).
  2. Closes every native `FSWatcher` via `.close()`.
  3. `clearInterval` on every polling timer.
  4. `clearTimeout` on every debounce timer.
  5. Clears all internal maps.
  6. `removeAllListeners()`.
- `start()` after `dispose()` rejects with `Error('FileWatcher has been disposed')`.

### File-descriptor accounting

The constant `maxFileDescriptors` (default 100) intentionally lives BELOW typical OS soft limits (256 on macOS, 1024 on Linux) to leave headroom for other components (SSE connections, log writers, intake DB). The watcher does NOT introspect the actual OS rlimit; it uses the configured budget as a hard ceiling. Operators can raise it via `FileWatcherOptions.maxFileDescriptors` once they have profiled memory and concurrency.

### Helper: `glob-resolver.ts`

```typescript
export async function resolvePatterns(patterns: string[]): Promise<string[]>;
```

Iterates patterns, calls `glob(pattern, { absolute: true, dot: false })`, deduplicates, and returns canonical paths via `fs.realpath`. Errors per-pattern are logged and skipped (an unreadable pattern must not abort the whole resolution).

## Acceptance Criteria

- [ ] `new FileWatcher(patterns, opts)` constructs without I/O; no file system access until `start()`.
- [ ] `start()` resolves patterns, attaches native watchers up to `maxFileDescriptors`, and fails over remaining files to polling — verified by `getMode() === 'mixed'` when patterns produce more files than the budget.
- [ ] When `options.polling === true`, ALL files use polling; `getMode() === 'polling'` and zero `FSWatcher` instances are created.
- [ ] When `fs.watch` throws EMFILE on a specific file, that file is re-attached via polling without aborting other native watchers; an error is logged but not emitted to listeners.
- [ ] First `stat()` per polled file establishes the baseline mtime and emits NOTHING; subsequent `mtime` increases emit `change`.
- [ ] A burst of 50 raw events on the same path within 200ms produces exactly 1 `fileChange` emission whose `timestamp` is at least `firstSeenAt + 200ms`.
- [ ] When raw events on the same path are mixed (`change` then `change`), the emitted event's `type` is `change`. When mixed (`change` then `error`), the emitted `type` is `error` (error precedence).
- [ ] `delete` then `create` within the debounce window emits a single `create` event (last-type-wins; create supersedes delete on file replacement).
- [ ] `dispose()` is idempotent: calling it twice does not throw, and no events fire after the first call.
- [ ] `start()` after `dispose()` rejects with `Error('FileWatcher has been disposed')`.
- [ ] `getWatchedFiles()` returns the deduplicated absolute paths of every file currently observed (native + polling combined).
- [ ] Native watch on a file that is later deleted while watching emits exactly one `delete` event (debounced); subsequent stat calls do not re-emit until the file reappears.
- [ ] Patterns that resolve to zero files do NOT throw; `start()` succeeds with `getWatchedFiles().length === 0`. The watcher remains live and can pick up matching files only via subsequent `start()` calls (no auto-rescan in this spec; rescan is out of scope).
- [ ] All emitted `FileChangeEvent.filePath` values are absolute and canonical (passed through `fs.realpath`).

## Dependencies

- **Blocks**: SPEC-015-1-02 (SSE bus consumes `fileChange` events), SPEC-015-1-05 (test suite).
- **Consumes**: PLAN-013-2 Bun runtime + Hono (FileWatcher itself is runtime-agnostic but lives inside the portal process). `glob` library already pinned by PLAN-013-2 (verify in `package.json`).
- **External**: Node `fs.watch` (via Bun's `node:fs` shim), `EventEmitter` (Node stdlib).

## Notes

- **Why 200ms debounce?** Atomic writes (temp + rename) on macOS HFS+ and Linux ext4 produce two `fs.watch` events ~10–50ms apart. Daemon log rotation produces 3–5 events within ~80ms. 200ms covers both with a comfortable margin while staying well below the ~1s p95 latency budget from PLAN-015-1's Definition of Done.
- **Why `maxFileDescriptors=100` default?** Conservative ceiling that leaves headroom for SSE connections (PLAN-015-1 caps at 10), intake DB, log writers, and Bun's own internal fds. Operators monitoring fd usage can raise it.
- **Why suppress first-poll emissions?** Polling reads `mtime` on `start()` to baseline; without suppression, every existing file would emit a synthetic `create` event, flooding listeners on startup.
- **Cross-platform note**: `fs.watch` semantics differ between macOS (FSEvents — coalesced events, no rename detection) and Linux (inotify — finer-grained events). The debounce + `change` normalization (treating `rename` as `change`) absorbs these differences. SPEC-015-1-05 covers cross-platform tests.
- **No directory watching in this spec.** New files matching a glob (e.g., a new `requests/REQ-XXX/state.json`) will not be auto-discovered until the next `start()` call. Auto-discovery via parent-directory watching is deferred to a future iteration; PLAN-015-1's request lifecycle does not require it because daemons announce new requests via existing event channels.
- **Error events do NOT include `error` type errors from listener callbacks.** If a listener throws during `fileChange` emission, the error is logged but not re-emitted as a `FileChangeEvent`. This prevents listener bugs from cascading into infinite error loops.
