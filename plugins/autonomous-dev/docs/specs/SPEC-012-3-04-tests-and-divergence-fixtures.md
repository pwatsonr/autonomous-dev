# SPEC-012-3-04: Reconciliation Test Suite & Controlled-Divergence Fixtures

## Metadata
- **Parent Plan**: PLAN-012-3
- **Tasks Covered**: Task 7 (integration test suite); also covers unit test gating from acceptance criterion "Unit tests >90% coverage on reconciliation logic"
- **Estimated effort**: 6 hours

## Description
Implement the unit and integration test suite for the reconciliation tooling. The test fixtures construct controlled-divergence scenarios for each of the four divergence categories from SPEC-012-3-01, verify repair correctness for SPEC-012-3-02 strategies, exercise the CLI surface from SPEC-012-3-03, and assert escalation triggers (manual_required outcomes). Performance assertions cover the 100-request scale target.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `intake/__tests__/integration/reconciliation.test.ts` | Create | End-to-end CLI + manager flows against tmp repos |
| `intake/__tests__/unit/reconciliation_manager.test.ts` | Create | Unit tests for `detectDivergence`, `repair`, `cleanupOrphanedTemps` with mocked deps |
| `intake/__tests__/unit/reconcile_command.test.ts` | Create | Unit tests for the CLI adapter argv parser, exit codes, JSON output |
| `intake/__tests__/fixtures/divergence-fixtures.ts` | Create | Fixture builders that produce each divergence category on demand |
| `intake/__tests__/helpers/tmp-repo.ts` | Create | Helper that scaffolds a temp repo with SQLite + `.autonomous-dev/requests/` |

## Implementation Details

### Fixture Helpers (`intake/__tests__/helpers/tmp-repo.ts`)

```typescript
export interface TmpRepoHandle {
  repoPath: string;       // absolute
  dbPath: string;
  db: Repository;
  cleanup: () => Promise<void>;
}

export async function makeTmpRepo(opts?: {
  preSeed?: RequestEntity[];        // SQLite rows to insert
  preSeedStateFiles?: { request_id: string; data: StateFile }[]; // state.json files
}): Promise<TmpRepoHandle>;
```

- Creates a `tmp.dirSync()` directory with `.autonomous-dev/requests/` and a fresh SQLite DB.
- Writes any `preSeedStateFiles` via `writeStateFileAtomic` so file mtimes are realistic.
- Returns a handle with cleanup that recursively removes the temp dir.

### Divergence Fixture Builders (`intake/__tests__/fixtures/divergence-fixtures.ts`)

```typescript
export async function makeMissingFile(
  handle: TmpRepoHandle,
  request_id?: string,
): Promise<RequestEntity>;
// Inserts SQLite row with no state.json on disk.

export async function makeStaleFile(
  handle: TmpRepoHandle,
  request_id?: string,
  staleByMs?: number,    // default 5_000
): Promise<{ request: RequestEntity; statePath: string }>;
// Inserts SQLite row, writes state.json, then bumps SQLite updated_at by staleByMs
// while leaving file mtime untouched.

export async function makeContentMismatch(
  handle: TmpRepoHandle,
  request_id?: string,
  fieldsDiffering?: { sqlite: Partial<RequestEntity>; fs: Partial<StateFile> },
): Promise<{ request: RequestEntity; statePath: string }>;
// Default: SQLite priority='high', state.json priority='normal'; identical mtimes.

export async function makeOrphanedFile(
  handle: TmpRepoHandle,
  request_id?: string,
  invalid?: boolean,
): Promise<string>;
// Writes state.json with no SQLite row. invalid=true writes garbage JSON.

export async function makeOrphanedTemp(
  handle: TmpRepoHandle,
  opts: {
    request_id: string;
    pid: number;            // use process.pid for live, or a known-dead PID
    ageMs: number;           // mtime offset from now
    needsPromotion?: boolean;
    schemaValid?: boolean;
  },
): Promise<string>;
// Creates state.json.tmp.<pid>.<random> (optionally with .needs_promotion suffix).
```

Each fixture returns enough metadata for tests to assert before/after state directly.

### Unit Tests — `reconciliation_manager.test.ts`

**`detectDivergence` cases:**
1. Clean repo → returns `[]`.
2. Single `missing_file` → exactly one report with correct fields populated.
3. Single `stale_file` (staleByMs=5000) → one `stale_file` report; file mtime <100ms tolerant.
4. Single `content_mismatch` on `priority` → `fields_differing === ['priority']`.
5. Multi-field `content_mismatch` (priority + description) → `fields_differing` contains both, in stable order.
6. `stale_file` ALSO has differing fields → emits `stale_file` only (stale check wins by precedence).
7. Single `orphaned_file` (valid JSON) → `filesystem_state` is the parsed object.
8. Single `orphaned_file` (invalid JSON) → `filesystem_state === null`.
9. Mixed scenario: 1 of each category → 4 reports, deduplicated by request_id.
10. Same `request_id` would emit from both phases (impossible by construction, but test the dedupe path with a hand-crafted scenario): only Phase A's report is returned.
11. Directory entries not matching `^REQ-[0-9]{6}$` are ignored.
12. Files matching `state.json.tmp.*` and `*.needs_promotion` are NOT classified as orphans.
13. Concurrent `detectDivergence` on the same repo → second call throws `ReconcileBusyError`.

**`repair` cases (one per category x dry-run on/off, force on/off):**
1. `missing_file` + `force=true` + `dryRun=false`: state.json created, hash matches expected canonical serialization.
2. `missing_file` + `dryRun=true`: no file created, returns `action: 'skipped'`.
3. `stale_file` + `force=true`: state.json overwritten; before_hash ≠ after_hash; SQLite untouched.
4. `content_mismatch` (sqlite_updated_at > fs_mtime) + `force=true`: state.json overwritten with SQLite values.
5. `content_mismatch` (fs_mtime > sqlite_updated_at) + `force=true`: SQLite columns updated; state.json mtime unchanged; SQLite `updated_at` bumped.
6. `orphaned_file` (valid) + `force=true`: SQLite row inserted; state.json untouched; action `auto_repaired`.
7. `orphaned_file` (valid) + `force=false`, confirm returns `false`: action `skipped`; no mutations.
8. `orphaned_file` (invalid JSON) + `force=true`: file moved to `archive/orphans/`; action `manual_required`; `archived_path` populated.
9. `orphaned_file` schema-invalid (parses but fails schema) + `force=true`: archived; `error_message` populated.
10. Mock `writeStateFileAtomic` to throw on `missing_file` repair: action `manual_required`; `error_message` propagates.

**`cleanupOrphanedTemps` cases:**
1. Empty `requests/` → `{ scanned: 0, removed: [], promoted: [], preserved: [], errors: [] }`.
2. Temp file <10min old → in `preserved`, not removed.
3. Temp file >10min old, PID alive (use `process.pid`) → in `preserved`.
4. Temp file >10min old, PID dead (use `99999` or another known-dead PID) → in `removed`; file unlinked.
5. `.needs_promotion` >10min old, dead PID, schema-valid → in `promoted`; original temp removed; `state.json` mtime updated; new content matches the temp content.
6. `.needs_promotion` >10min old, dead PID, schema-invalid → in `errors`; file moved to `archive/orphans/`; not promoted.
7. `dryRun=true`: `removed`/`promoted` arrays populated with intended actions but disk unchanged.
8. `force=false` + non-TTY: cleanup actions skipped per SPEC-012-3-03 confirm-fn semantics (or, if cleanup is invoked directly without CLI, the manager's behavior matches SPEC-012-3-02).

### Unit Tests — `reconcile_command.test.ts`

1. Argv parser: each flag and short form parsed; unknown flag → exit 1 with documented error.
2. `--detect` default: when no phase flag set, only detect runs; no `repair`/`cleanupOrphanedTemps` calls.
3. `--repair`: detect runs first; every divergence from detect is passed to `manager.repair`.
4. `--cleanup-temp` after `--repair`: cleanup invocation timestamp > all repair invocation timestamps (verified via spy call order).
5. Exit codes: `0` on clean, `1` on inconsistencies, `2` on at least one repair `manual_required` or thrown error.
6. `--output-json /tmp/foo.json`: file written with mode `0o600`; contents parse as JSON; top-level keys match TDD-012 §12.2 schema.
7. `--output-json` parent dir not writable: bash validator rejects (covered via integration test); for the unit test, simulate by passing an invalid path and asserting the manager-level error path.
8. Non-TTY without `--force`: `makeConfirmFn` returns a function that always resolves `false`; warning logged.
9. `--force` makes `makeConfirmFn` always resolve `true` regardless of TTY state.
10. Audit log emission: at least one `reconcile.run` entry per invocation; one `reconcile.repair` per `RepairResult`.

### Integration Tests — `reconciliation.test.ts`

1. **End-to-end detect**: scaffold repo with 1 of each divergence category (using fixtures), invoke CLI via `child_process.spawn('autonomous-dev', ['request', 'reconcile', '--repo', repoPath])`, assert exit code 1 and stdout contains the documented summary lines.
2. **End-to-end repair (force)**: scaffold same repo, invoke with `--repair --force`, assert all 4 fixtures resolved (state.json present and correct, SQLite consistent, orphans imported or archived as appropriate).
3. **Dry-run repair**: same repo, `--repair --dry-run --force`, assert no on-disk or SQLite changes (snapshot hashes equal pre/post).
4. **Cleanup temp end-to-end**: scaffold orphan temps with mixed liveness, invoke `--cleanup-temp --force`, assert `removed`/`promoted` lists in JSON output match expected.
5. **Combined `--repair --cleanup-temp`**: both phases run; cleanup runs after repair; final repo state has zero divergences when re-running `--detect`.
6. **JSON output schema**: `--output-json /tmp/r.json`, parse the file, validate against TDD-012 §12.2 `ReconcileReport` shape (every documented top-level key present; `details` contains all four arrays).
7. **Performance**: scaffold a 100-request repo with mixed divergence (10 of each category, 60 clean), run `--detect` and assert wall-clock <30s (per PLAN-012-3 acceptance). Run `--repair --force` and assert wall-clock <30s.
8. **Bash validator rejection (no Node spawned)**: invoke with `--repo /definitely/does/not/exist`, assert exit 1 and that no Node process was spawned (verify by checking `ps` snapshot timing or by stubbing `exec_node_cli` in a test wrapper).
9. **Repair failure escalation**: scaffold a `missing_file` then `chmod -w` the request directory before invoking `--repair --force`; assert exit code 2 and `manual_intervention_needed` lists the request.
10. **Concurrent invocation**: run two `--detect` invocations against the same repo in parallel; assert one exits 0/1 and the second exits 2 with a `ReconcileBusyError`-derived message.

### Coverage and CI Wiring

- All new files MUST be covered by jest config under `"testMatch"`. Verify by running `npm test -- intake/__tests__/.*reconcile.*` before merging.
- Coverage gate: `intake/core/reconciliation_manager.ts` and `intake/cli/reconcile_command.ts` must reach >=90% line and >=85% branch coverage. CI fails below these thresholds.

## Acceptance Criteria

- [ ] `npm test -- intake/__tests__/unit/reconciliation_manager.test.ts` passes all listed unit cases.
- [ ] `npm test -- intake/__tests__/unit/reconcile_command.test.ts` passes all CLI adapter unit cases.
- [ ] `npm test -- intake/__tests__/integration/reconciliation.test.ts` passes all 10 integration scenarios.
- [ ] Coverage report shows ≥90% lines and ≥85% branches for `reconciliation_manager.ts` and `reconcile_command.ts`.
- [ ] Performance assertion #7 completes in <30s on the CI runner spec (Linux x64, 4 vCPU, 8GB RAM).
- [ ] Concurrent invocation test (#10) reliably triggers `ReconcileBusyError` on the second invocation (10 consecutive runs without flake).
- [ ] Each fixture builder is invoked at least once across the unit tests (no dead fixture code).
- [ ] No test mutates a real (non-tmp) repo or the shared developer SQLite DB. All tests use `makeTmpRepo`.
- [ ] Bash dispatcher rejection test (#8) verifies exit happens before any Node process spawns (asserted via spy or process accounting).
- [ ] All `RepairResult` enumerations (`auto_repaired`, `manual_required`, `skipped`) are exercised by at least one test.
- [ ] All four `DivergenceCategory` values are exercised in at least one detect test AND one repair test.

## Dependencies

- SPEC-012-3-01: `ReconciliationManager.detectDivergence`, types.
- SPEC-012-3-02: `ReconciliationManager.repair`, `ReconciliationManager.cleanupOrphanedTemps`.
- SPEC-012-3-03: CLI adapter and bash dispatcher behavior.
- PLAN-012-1: `writeStateFileAtomic` (used in fixture preseeding).
- PLAN-012-2: schema validator (used to assert schema-failure paths).
- `jest`, `tmp` (devDependencies; verify in `package.json`).

## Notes

- Fixtures are deliberately deterministic. Time-dependent setup (e.g., `staleByMs`, temp file age) uses an explicit `setMtime(path, ms)` helper that calls `fs.utimes` — never relies on `setTimeout`-based waiting.
- Dead-PID selection: rather than spawning and killing a process, use a PID known to be unallocated (e.g., a randomly chosen PID that fails `kill -0` at fixture creation time, retry up to 5 times if collision). Avoid hardcoded `99999` since that PID can theoretically be in use on long-lived hosts.
- Performance test #7 uses a single-threaded scan to match production behavior; do not parallelize the fixture creation loop unless production code parallelizes the detection loop.
- The bash validator test (#8) is the only test that invokes the actual `bin/autonomous-dev.sh` via `child_process`; all others use the TypeScript adapter directly to keep the integration test runtime under 60s total.
- When asserting JSON output against the TDD-012 §12.2 schema, validate the full shape (every documented field present, no unexpected top-level keys) — additive `details.temp_cleanup` is allowed but must remain optional.
