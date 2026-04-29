# SPEC-012-3-01: Reconciliation Algorithm & Divergence Classification

## Metadata
- **Parent Plan**: PLAN-012-3
- **Tasks Covered**: Task 2 (ReconciliationManager core)
- **Estimated effort**: 6 hours

## Description
Implement the read-only divergence detection engine that compares the intake-router SQLite store against per-request `state.json` files in `{repo}/.autonomous-dev/requests/<REQ-id>/`. The algorithm performs a two-phase scan (SQLite → filesystem, then filesystem → SQLite) and emits a structured `DivergenceReport[]` classifying each inconsistency into exactly one of four categories. This spec covers detection only; repair logic is in SPEC-012-3-02 and CLI surface is in SPEC-012-3-03.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `intake/core/reconciliation_manager.ts` | Create | Class skeleton + `detectDivergence()` method + helpers |
| `intake/core/types/reconciliation.ts` | Create | `DivergenceReport`, `DivergenceCategory`, `ReconcileOptions` types |

## Implementation Details

### Type Definitions (`intake/core/types/reconciliation.ts`)

```typescript
export type DivergenceCategory =
  | 'missing_file'      // SQLite has request, no state.json on disk
  | 'stale_file'        // state.json mtime older than SQLite updated_at
  | 'content_mismatch'  // both exist; one or more fields differ
  | 'orphaned_file';    // state.json exists; no SQLite row

export interface DivergenceReport {
  request_id: string;
  repository: string;            // absolute repo path
  category: DivergenceCategory;
  description: string;           // human-readable summary
  sqlite_state?: Partial<RequestEntity>;
  filesystem_state?: unknown;    // parsed JSON or null if unparseable
  sqlite_updated_at?: number;    // epoch ms
  filesystem_mtime_ms?: number;
  fields_differing?: string[];   // populated for content_mismatch only
  detected_at: string;           // ISO-8601
}

export interface ReconcileOptions {
  repo?: string;          // when omitted, scan all configured repos
  dryRun?: boolean;       // ignored by detect; used by repair (SPEC-012-3-02)
  force?: boolean;        // ignored by detect
  outputJson?: string;    // ignored by detect
}
```

### `ReconciliationManager` Class

```typescript
export class ReconciliationManager {
  constructor(
    private db: Repository,
    private logger: Logger,
    private clock: () => number = Date.now,
  ) {}

  async detectDivergence(repoPath: string): Promise<DivergenceReport[]>;

  // Helpers (private)
  private async scanSqliteSide(repoPath: string): Promise<DivergenceReport[]>;
  private async scanFilesystemSide(repoPath: string): Promise<DivergenceReport[]>;
  private async classifyExisting(
    request: RequestEntity,
    statePath: string,
  ): Promise<DivergenceReport | null>;
  private async listStateFiles(requestsDir: string): Promise<string[]>;
  private extractRequestIdFromPath(statePath: string): string | null;
}
```

### Algorithm

`detectDivergence(repoPath)`:
1. Resolve `requestsDir = path.join(repoPath, '.autonomous-dev', 'requests')`. If absent, return `[]`.
2. Acquire an advisory shared lock on `{repoPath}/.autonomous-dev/.reconcile.lock` (use `proper-lockfile` with `realpath: false, retries: 0`). If the lock is busy, throw `ReconcileBusyError`.
3. Run **Phase A** (`scanSqliteSide`) and **Phase B** (`scanFilesystemSide`) in sequence.
4. Concatenate results, deduplicate by `request_id` (Phase A wins when both phases would emit a row for the same id).
5. Release the advisory lock and return the array.

**Phase A — SQLite → Filesystem (`scanSqliteSide`)**:
1. `requests = await db.getAllRequestsForRepo(repoPath)`.
2. For each `request`:
   - `statePath = path.join(requestsDir, request.request_id, 'state.json')`.
   - If `!fs.existsSync(statePath)` → emit `{ category: 'missing_file', sqlite_state: request, sqlite_updated_at: request.updated_at }`.
   - Else delegate to `classifyExisting(request, statePath)`.

**Phase B — Filesystem → SQLite (`scanFilesystemSide`)**:
1. `stateFiles = await listStateFiles(requestsDir)` (recursive, returns absolute paths matching `**/<REQ-NNNNNN>/state.json`).
2. For each `statePath`:
   - `requestId = extractRequestIdFromPath(statePath)`. Skip if null.
   - `row = await db.getRequest(requestId)`. If row exists, skip (handled in Phase A).
   - Read + JSON.parse `state.json`. On parse error, emit `{ category: 'orphaned_file', filesystem_state: null, description: 'unparseable orphaned state.json' }`.
   - Else emit `{ category: 'orphaned_file', filesystem_state: parsed }`.

**`classifyExisting(request, statePath)`**:
1. `stat = await fs.stat(statePath)`. Capture `filesystem_mtime_ms = stat.mtimeMs`.
2. Read + parse `state.json` → `fsData`. On parse failure, emit `{ category: 'content_mismatch', description: 'state.json unparseable', fields_differing: ['<parse>'] }` and return.
3. **Stale check**: if `request.updated_at - stat.mtimeMs > 1000` (SQLite newer by >1s), emit `{ category: 'stale_file', sqlite_updated_at: request.updated_at, filesystem_mtime_ms: stat.mtimeMs }` and return.
4. **Field comparison**: compare the canonical field set across SQLite ↔ state.json:

   | SQLite field | state.json key | Equality |
   |--------------|---------------|----------|
   | `request_id` | `request_id` | strict |
   | `source` | `source` | strict |
   | `priority` | `priority` | strict |
   | `state` | `state` | strict |
   | `target_repo` | `target_repo` | strict |
   | `created_at` | `created_at` | strict (epoch ms) |
   | `description` | `description` | strict |

   Collect names of fields that differ into `fields_differing`. If non-empty → emit `{ category: 'content_mismatch', fields_differing, sqlite_state: request, filesystem_state: fsData, sqlite_updated_at: request.updated_at, filesystem_mtime_ms: stat.mtimeMs }`.
5. Return `null` if all checks pass.

### `listStateFiles` Implementation Notes
- Walk `requestsDir` non-recursively at the top level (each entry is a `<REQ-id>` directory), then look for `state.json` in each. Skip files matching `state.json.tmp.*` and `*.needs_promotion` — those are handled in SPEC-012-3-02 Task 4 (orphaned temp cleanup).
- Use `fs.promises.readdir(requestsDir, { withFileTypes: true })` then filter `dirent.isDirectory()`.
- Validate directory name with `^REQ-[0-9]{6}$`; skip non-conforming entries (log at debug level).

### `extractRequestIdFromPath`
- Match the path against `/(REQ-[0-9]{6})\/state\.json$/`. Return capture group 1 or `null`.

### Error Handling
- `ReconcileBusyError` (advisory lock contention): caller should retry or fail; do not partial-scan.
- All FS read errors during Phase A/B classification are absorbed into a `DivergenceReport` (do not throw mid-scan).
- DB errors propagate (the caller will surface via CLI exit code 2 — see SPEC-012-3-03).

## Acceptance Criteria

- [ ] `detectDivergence(repoPath)` returns `[]` for a clean repo (every SQLite row has matching state.json with identical fields and recent mtime).
- [ ] When SQLite has a request whose `state.json` does not exist on disk, exactly one report with `category === 'missing_file'` is emitted, populating `sqlite_state` and `sqlite_updated_at`.
- [ ] When `state.json` exists but `mtime < sqlite.updated_at - 1000ms`, exactly one report with `category === 'stale_file'` is emitted with both timestamps populated.
- [ ] When SQLite priority is `high` and state.json priority is `normal` (with mtime within tolerance), exactly one report with `category === 'content_mismatch'` is emitted and `fields_differing` includes `'priority'`.
- [ ] When `state.json` exists at `requests/REQ-000123/state.json` with no SQLite row for `REQ-000123`, exactly one report with `category === 'orphaned_file'` is emitted and `filesystem_state` is the parsed object.
- [ ] Unparseable orphaned state.json yields `{ category: 'orphaned_file', filesystem_state: null }` (does not throw).
- [ ] When both Phase A and Phase B would produce a row for the same request_id, only the Phase A report is returned (deduplication verified).
- [ ] Concurrent invocations on the same repo: the second invocation throws `ReconcileBusyError` while the first holds `.reconcile.lock`.
- [ ] Directory entries not matching `^REQ-[0-9]{6}$` are silently skipped (no false orphans).
- [ ] Files matching `state.json.tmp.*` or `*.needs_promotion` are NOT classified as orphans (handed off to SPEC-012-3-02).
- [ ] Performance: detecting divergence on a 100-request repo completes in <2s (excluded I/O-bound test environments).

## Dependencies

- `Repository` from `intake/db/repository.ts`: requires `getAllRequestsForRepo(repoPath: string): Promise<RequestEntity[]>` and `getRequest(id: string): Promise<RequestEntity | null>`. If either is missing, add the method as part of this spec (single-line query wrappers; tests in SPEC-012-3-04).
- `Logger` from `intake/core/logger.ts`.
- `proper-lockfile` (already a transitive dep via PLAN-012-1; verify in `package.json`).
- Node `fs`, `path` builtins.

## Notes

- This spec is intentionally read-only. Phase B does NOT mutate SQLite even when an orphan is found — repair is SPEC-012-3-02's job.
- The 1-second tolerance on stale_file detection avoids false positives from clock skew between the two-phase commit's SQLite timestamp and the post-rename mtime.
- `fields_differing` is the contract used by SPEC-012-3-02 to choose merge strategy (per-field newer-wins).
- The algorithm is idempotent: two consecutive `detectDivergence` calls on an unchanged repo return identical (modulo `detected_at`) reports.
