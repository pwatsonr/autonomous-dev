# SPEC-012-3-02: Auto-Repair Strategies & Orphaned Temp File Cleanup

## Metadata
- **Parent Plan**: PLAN-012-3
- **Tasks Covered**: Task 3 (repair strategies per category), Task 4 (orphaned temp file cleanup), Task 5 (force flag)
- **Estimated effort**: 14 hours

## Description
Implement repair logic that takes a `DivergenceReport` (produced by SPEC-012-3-01) and either auto-resolves it via the two-phase commit pattern or escalates it as `manual_required`. Also implement orphaned temp file cleanup for `state.json.tmp.*` artifacts left by crashed two-phase commits, including F4 recovery for `.needs_promotion` markers. All destructive operations are gated by a `force` flag (non-interactive auto-approve) or operator confirmation in interactive mode.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `intake/core/reconciliation_manager.ts` | Modify | Add `repair`, `cleanupOrphanedTemps`, repair-helper methods |
| `intake/core/types/reconciliation.ts` | Modify | Add `RepairResult`, `TempCleanupReport`, `RepairOptions` types |
| `intake/core/two_phase_commit.ts` | Consume (do not modify) | Reuse `writeStateFileAtomic` from PLAN-012-1 |

## Implementation Details

### Type Additions (`intake/core/types/reconciliation.ts`)

```typescript
export type RepairAction =
  | 'auto_repaired'
  | 'manual_required'
  | 'skipped';

export interface RepairOptions {
  force?: boolean;                            // skip prompts; auto-approve destructive actions
  confirm?: (msg: string) => Promise<boolean>; // interactive prompt fn (TTY)
  dryRun?: boolean;                           // log but do not mutate
}

export interface RepairResult {
  request_id: string;
  category: DivergenceCategory;
  action: RepairAction;
  before_hash?: string;       // SHA-256 of pre-repair state.json (when applicable)
  after_hash?: string;        // SHA-256 of post-repair state.json
  error_message?: string;
  archived_path?: string;     // populated when orphan archived rather than imported
}

export interface TempCleanupReport {
  scanned: number;
  removed: string[];          // absolute paths of removed temps
  promoted: string[];         // absolute paths of promoted .needs_promotion → state.json
  preserved: string[];        // temps with live PIDs (left alone)
  errors: { path: string; message: string }[];
}
```

### `ReconciliationManager` Method Additions

```typescript
async repair(
  report: DivergenceReport,
  options: RepairOptions,
): Promise<RepairResult>;

async cleanupOrphanedTemps(
  repoPath: string,
  options: RepairOptions,
): Promise<TempCleanupReport>;
```

### Repair Strategy by Category

All repairs hold the same `.reconcile.lock` advisory lock acquired in detection (the CLI in SPEC-012-3-03 holds it across both phases). Each repair uses `writeStateFileAtomic(requestDir, stateData)` from PLAN-012-1's two-phase commit module.

**`missing_file`** — SQLite is the source of truth:
1. `requestDir = {repo}/.autonomous-dev/requests/{request_id}`.
2. `mkdir -p` with mode `0o700`.
3. Build `stateData` from `report.sqlite_state` via `buildStateFromSqlite(request)` (helper). The helper produces the canonical state.json schema (PLAN-012-2).
4. Call `writeStateFileAtomic(requestDir, stateData)`.
5. Return `{ action: 'auto_repaired', after_hash: sha256(JSON.stringify(stateData)) }`.

**`stale_file`** — SQLite newer than disk:
1. Read the existing state.json; capture `before_hash`.
2. Build `stateData` from `report.sqlite_state` (same helper as `missing_file`).
3. `writeStateFileAtomic(requestDir, stateData)`.
4. Return `{ action: 'auto_repaired', before_hash, after_hash }`.

**`content_mismatch`** — newer-wins per-field merge:
1. If `report.sqlite_updated_at > report.filesystem_mtime_ms`: SQLite is canonical → behave like `stale_file` (overwrite state.json from SQLite).
2. Else: state.json is canonical → for each `field` in `report.fields_differing`, update SQLite via `db.updateRequestField(request_id, field, fsData[field])` inside a transaction. The transaction must also bump `updated_at` to `Date.now()`. After commit, leave state.json untouched.
3. In **interactive mode** (no `force`), call `options.confirm(\`Repair ${request_id}: ${fields_differing.join(', ')} → ${winner}?\`)`. If `false`, return `{ action: 'skipped' }`.
4. Return `{ action: 'auto_repaired', before_hash, after_hash }` (after_hash only populated for direction (1)).

**`orphaned_file`** — escalate by default; import or archive on confirmation:
1. If `report.filesystem_state === null` (unparseable): always **archive**, never import. Move the file to `{repo}/.autonomous-dev/archive/orphans/{timestamp}-{request_id}-state.json`. Return `{ action: 'manual_required', archived_path }`.
2. If parseable and `force === true`: validate against state.json schema (PLAN-012-2). On success, build `RequestEntity` via `buildSqliteFromState(fsData)` and `db.insertRequest(entity)`. Return `{ action: 'auto_repaired' }`.
3. If parseable and `force !== true`: prompt via `options.confirm`. On `true` → import; on `false` → archive. Return appropriate `action`.
4. Schema validation failure during import → archive instead. Set `error_message` to validation error summary.

### `dryRun` Behavior
- All file mutations (`writeStateFileAtomic`, `mkdir`, `rename`/`move-to-archive`) MUST short-circuit when `options.dryRun === true`.
- DB mutations (`updateRequestField`, `insertRequest`) MUST short-circuit on `dryRun`.
- `RepairResult.action` is set to `'skipped'` and a structured log entry is emitted: `{ event: 'reconcile.repair.dry_run', request_id, category, would_perform: 'auto_repaired'|'manual_required' }`.

### Orphaned Temp File Cleanup (`cleanupOrphanedTemps`)

The two-phase commit can leave three artifact types behind on crash:
- `state.json.tmp.<pid>.<random>` — pre-rename temps from interrupted commits.
- `state.json.tmp.<pid>.<random>.needs_promotion` — F4 recovery markers (SQLite committed, rename pending).
- Stray temps from orphaned PIDs.

Algorithm:
1. Walk every `<REQ-id>` directory under `{repo}/.autonomous-dev/requests/`.
2. For each entry matching `state.json.tmp.*`:
   - Capture `mtime` and parse `pid` from filename via `/state\.json\.tmp\.([0-9]+)\./`.
   - If `mtime` within last 10 minutes (`Date.now() - mtimeMs < 10 * 60 * 1000`) → preserve (active commit). Add to `preserved`.
   - Else if PID alive (`process.kill(pid, 0)` does not throw `ESRCH`) → preserve.
   - Else if filename ends with `.needs_promotion`:
     - Read + parse JSON. Validate schema (PLAN-012-2). On success: rename atomically to `state.json` (overwriting any stale state.json). Append to `promoted`.
     - On schema failure: move to `archive/orphans/{timestamp}-{request_id}-needs_promotion.json`. Append to `errors`.
   - Else: `unlink`. Append to `removed`.
3. Errors during any single-file step are caught, recorded in `errors[]`, and processing continues.

Permission and safety:
- `force` is required to remove or promote when running interactively. Without `force`, prompt: `"Remove N orphaned temps and promote M needs_promotion files? [y/N]"` (single confirm covers all candidates from the same repo).
- `dryRun` short-circuits filesystem mutations; the report still populates `removed`/`promoted` lists with intended actions.
- All actions logged at info level with `{ event: 'reconcile.temp_cleanup.<promote|remove|preserve>', path, pid, age_ms }`.

### Helper Functions (private)

- `buildStateFromSqlite(req: RequestEntity): StateFile` — canonical mapper, must produce schema-valid output.
- `buildSqliteFromState(state: StateFile): RequestEntity` — inverse mapper.
- `archiveFile(srcPath: string, repoPath: string): Promise<string>` — moves file under `archive/orphans/`, returns destination path. Creates archive dir with mode `0o700`.
- `sha256OfFile(path: string): Promise<string>` — for before/after hashing in `RepairResult`.
- `validateStateSchema(data: unknown): { valid: boolean; errors: string[] }` — wraps schema validator from PLAN-012-2.

## Acceptance Criteria

- [ ] `repair({ category: 'missing_file', sqlite_state: req })` creates `state.json` whose deserialized contents satisfy the canonical schema and field-equal `req`.
- [ ] `repair({ category: 'stale_file' })` overwrites the existing state.json so post-repair file mtime is newer than `report.sqlite_updated_at`.
- [ ] `repair({ category: 'content_mismatch', sqlite_updated_at > fs_mtime })` overwrites state.json from SQLite and leaves SQLite unchanged.
- [ ] `repair({ category: 'content_mismatch', fs_mtime > sqlite_updated_at })` updates only the differing SQLite columns and bumps `updated_at`; state.json untouched.
- [ ] `repair({ category: 'orphaned_file', filesystem_state: null })` archives the file under `archive/orphans/` and returns `manual_required` regardless of `force`.
- [ ] `repair({ category: 'orphaned_file', filesystem_state: <valid> }, { force: true })` inserts a new SQLite row matching the state.json data; returns `auto_repaired`.
- [ ] `repair({ category: 'orphaned_file', filesystem_state: <invalid schema> }, { force: true })` archives instead of importing and returns `manual_required` with `error_message`.
- [ ] In interactive mode (no `force`), all destructive repairs invoke `options.confirm`; returning `false` yields `action: 'skipped'` with no mutations.
- [ ] `dryRun: true` produces a `RepairResult` indicating intended action without touching disk or DB. Verified by `before_hash === after_hash` snapshot of state.json.
- [ ] All repairs go through `writeStateFileAtomic` (verified via spy/mock in tests; direct `fs.writeFile` calls are forbidden).
- [ ] `cleanupOrphanedTemps` preserves any temp file with mtime <10min old.
- [ ] `cleanupOrphanedTemps` preserves any temp file whose PID is alive (`kill -0` succeeds).
- [ ] `cleanupOrphanedTemps` promotes `*.needs_promotion` whose schema validates and removes the source temp.
- [ ] `cleanupOrphanedTemps` archives `*.needs_promotion` whose schema does NOT validate.
- [ ] `cleanupOrphanedTemps` removes plain `state.json.tmp.*` from dead PIDs >10min old via `unlink`.
- [ ] All cleanup actions logged with `{ event: 'reconcile.temp_cleanup.*', path, pid, age_ms }`.
- [ ] `force: true` suppresses all confirmation prompts; `force: false` prompts before each destructive class of action.

## Dependencies

- SPEC-012-3-01: consumes `DivergenceReport`, `DivergenceCategory`, `ReconcileOptions`.
- PLAN-012-1: `writeStateFileAtomic`, advisory lock helpers.
- PLAN-012-2: state.json schema validator and canonical schema definition.
- `Repository` extensions: `updateRequestField(id, field, value)`, `insertRequest(entity)`. Add to repository if missing (one-line query wrappers).
- Node `fs`, `path`, `crypto` builtins.

## Notes

- Newer-wins for `content_mismatch` is field-level: SQLite may overwrite some fields while state.json overwrites others is NOT supported in this spec. The whole record's direction is decided by which timestamp is newer. This avoids partial-merge complexity at the cost of occasionally overwriting one fresh field with a slightly older one.
- The 10-minute liveness window for temps assumes two-phase commit completes in well under 10 minutes; this is consistent with PLAN-012-1's <500ms target. Operators can override via env var `AUTONOMOUS_DEV_RECONCILE_TEMP_AGE_MS` if needed (read once at constructor time).
- Archive paths under `archive/orphans/` are intentionally human-browseable for post-mortem analysis. They are NOT auto-pruned by this spec; future tooling may add retention.
- Dry-run intentionally returns `action: 'skipped'` (not `'auto_repaired'`) to make automation safer — a CLI consumer can distinguish "was repaired" from "would be repaired" without inspecting `dryRun` separately.
