# SPEC-012-3-03: Manual Reconciliation CLI & Audit Log Entries

## Metadata
- **Parent Plan**: PLAN-012-3
- **Tasks Covered**: Task 1 (CLI subcommand infrastructure), Task 6 (CLI integration + report output)
- **Estimated effort**: 6 hours

## Description
Wire the `ReconciliationManager` (SPEC-012-3-01, SPEC-012-3-02) into the operator-facing CLI as `autonomous-dev request reconcile`. Implement bash-layer validation of all flags following the SPEC-011-1-01 dispatcher pattern, the TypeScript adapter that orchestrates detect → repair → cleanup phases, JSON output that conforms to the TDD-012 §12.2 `ReconcileReport` schema, structured audit log entries written to the daemon log, and well-defined exit codes (0/1/2).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `bin/autonomous-dev.sh` | Modify | Add `reconcile` subcommand routing and flag validators |
| `intake/cli/reconcile_command.ts` | Create | TypeScript orchestrator: parses argv, drives ReconciliationManager, emits report |
| `intake/core/reconciliation_manager.ts` | Modify | Add `runFullReconciliation(options)` convenience method that composes detect+repair+cleanup |
| `intake/core/audit_log.ts` | Consume (do not modify) | Reuse audit-log helper from existing intake module |

## Implementation Details

### Bash Dispatcher (`bin/autonomous-dev.sh`)

Extend the `cmd_request_delegate` allowlist (SPEC-011-1-01) to include `reconcile`. No request-ID validation applies (`reconcile` operates at repo scope). Add a new validator for repo paths and one for the JSON output path.

```bash
# Within cmd_request_delegate, after the existing allowlist switch:
case "$subcmd" in
  reconcile)
    cmd_request_reconcile "$@"
    ;;
  ...
esac
```

Implement `cmd_request_reconcile(args: string[])`:

```
cmd_request_reconcile(args: string[]) -> void
```

Parse the following flags. Unknown flags exit 1 with `"ERROR: unknown flag '$flag'. Run 'autonomous-dev request reconcile --help'"`.

| Flag | Type | Default | Validator |
|------|------|---------|-----------|
| `--detect` | boolean | true (when no other phase flag set) | none |
| `--repair` | boolean | false | none |
| `--cleanup-temp` | boolean | false | none |
| `--dry-run` | boolean | false | none |
| `--force` | boolean | false | none |
| `--verbose` | boolean | false | none |
| `--repo <path>` | string | (config allowlist) | `validate_repo_path` |
| `--output-json <path>` | string | none | `validate_output_path` |
| `--help` / `-h` | boolean | — | prints help, exits 0 |

`validate_repo_path(path)`:
- Empty → exit 1, `"ERROR: --repo requires a path"`.
- `! [[ -d "$path" ]]` → exit 1, `"ERROR: repo path '$path' does not exist or is not a directory"`.
- Resolve via `realpath -- "$path"` and pass the canonical absolute path to the Node adapter.

`validate_output_path(path)`:
- Empty → exit 1.
- Parent directory must exist and be writable: `[[ -d "$(dirname "$path")" && -w "$(dirname "$path")" ]]`. Else exit 1, `"ERROR: --output-json parent dir not writable: $(dirname "$path")"`.

When neither `--repair` nor `--cleanup-temp` is set, default to detect-only behavior. When `--repair` is set without explicit `--detect`, detection still runs first (it is a precondition). When `--cleanup-temp` is set alongside `--repair`, run cleanup AFTER repair to handle any new temps left by repair failures.

After validation, route to the Node adapter via `exec_node_cli "reconcile" "$@"` (helper from SPEC-011-1-02).

### TypeScript Adapter (`intake/cli/reconcile_command.ts`)

```typescript
export interface ReconcileCliFlags {
  detect: boolean;
  repair: boolean;
  cleanupTemp: boolean;
  dryRun: boolean;
  force: boolean;
  verbose: boolean;
  repo?: string;
  outputJson?: string;
}

export async function runReconcileCommand(
  argv: string[],
  deps: { manager: ReconciliationManager; logger: Logger; stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream }
): Promise<number>;
```

Behavior:
1. Parse `argv` into `ReconcileCliFlags` using a minimal arg parser (no `commander`/`yargs` — match the lightweight style of SPEC-011-1-03).
2. Resolve target repos: `flags.repo ? [flags.repo] : config.repositories.allowlist` (loaded via existing `loadConfig()`).
3. Initialize the `ReconcileReport` per TDD-012 §12.2 (zeroed counters, empty arrays).
4. **Detect phase**: for each repo, call `manager.detectDivergence(repo)`. Aggregate into report's category buckets:
   - `missing_file` → `details.missing_state_files`
   - `stale_file` and `content_mismatch` → `details.metadata_mismatches`
   - `orphaned_file` (with parsed state) → `details.orphaned_state_files`
   - `orphaned_file` (unparseable) → `details.schema_validation_failures`
5. **Repair phase** (when `flags.repair`): for each `DivergenceReport` from detect, call `manager.repair(report, { force: flags.force, dryRun: flags.dryRun, confirm: makeConfirmFn(flags) })`. Update `report.repairs_attempted/_successful` and `report.manual_intervention_needed` based on `RepairResult.action`.
6. **Cleanup phase** (when `flags.cleanupTemp`): for each repo, call `manager.cleanupOrphanedTemps(repo, { force, dryRun })`. Append cleanup metrics to a new `details.temp_cleanup` field (extend the schema additively):

   ```typescript
   details.temp_cleanup?: {
     scanned: number;
     removed: string[];
     promoted: string[];
     preserved: string[];
     errors: { path: string; message: string }[];
   };
   ```

7. **Report emission**:
   - When `flags.outputJson` is set: write `JSON.stringify(report, null, 2)` to that path with mode `0o600` (atomic write via temp file + rename).
   - Always print a human-readable summary to stdout (see Output Format below).
   - When `flags.verbose`, also print per-divergence detail lines.

8. **Exit code**:
   - `0` — no inconsistencies found AND no cleanup actions performed (or only `--detect`).
   - `1` — inconsistencies found (with or without successful repair). This is the "drift detected" signal for cron monitoring.
   - `2` — at least one repair attempted and failed (`manual_intervention_needed.length > 0`), OR an unrecoverable error during reconciliation (DB error, advisory-lock contention, repo not found).

### `makeConfirmFn(flags)`
- If `flags.force` is true: returns `async () => true`.
- Else if stdin is a TTY: returns a prompt function that writes the message to stderr and reads `y/Y` from stdin.
- Else (non-TTY without `--force`): returns `async () => false` and logs warning `"reconcile: stdin is not a TTY and --force not set; treating as non-destructive (skipping repairs requiring confirmation)"`.

### Audit Log Entries

Every reconcile invocation emits a structured entry to the daemon audit log via the existing audit-log helper. Required fields:

```json
{
  "event": "reconcile.run",
  "timestamp": "2026-04-28T12:34:56.789Z",
  "actor": "<euid username>",
  "flags": { "detect": true, "repair": false, "cleanupTemp": false, "dryRun": false, "force": false },
  "repos_scanned": 1,
  "inconsistencies_found": 3,
  "repairs_attempted": 0,
  "repairs_successful": 0,
  "manual_intervention_needed": 0,
  "exit_code": 1,
  "duration_ms": 412
}
```

Per-repair audit entries (one per `RepairResult`):

```json
{
  "event": "reconcile.repair",
  "timestamp": "...",
  "request_id": "REQ-000123",
  "repository": "/abs/path",
  "category": "missing_file",
  "action": "auto_repaired",
  "before_hash": null,
  "after_hash": "sha256:...",
  "dry_run": false
}
```

Per-cleanup-action audit entries: emit one entry per file in `removed`/`promoted` arrays (use existing `reconcile.temp_cleanup.*` events from SPEC-012-3-02).

### Human-Readable Output Format (verbatim, ≤80 columns)

```
Reconciliation report — 2026-04-28T12:34:56Z
Repositories scanned: 1
  /abs/path/to/repo

Total requests checked: 47
Inconsistencies found: 3
  missing_state_files:        2
  orphaned_state_files:       0
  metadata_mismatches:        1
  schema_validation_failures: 0

Repairs:
  Attempted:                  0  (use --repair to apply)
  Successful:                 0
  Manual intervention needed: 0

Performance: scan=412ms repair=0ms

Exit: 1 (inconsistencies detected)
```

When `--verbose` is set, append a divergence detail block:

```
Divergence detail:
  REQ-000123  missing_file   description...
  REQ-000124  stale_file     sqlite_updated_at=... fs_mtime=...
  REQ-000125  content_mismatch  fields=[priority]
```

### Help Text (`print_reconcile_help`)

```
Usage: autonomous-dev request reconcile [options]

Detect and repair drift between intake-router SQLite store and per-request
state.json files. Defaults to detect-only (no mutations).

Phases:
  --detect              Scan and report (default when no phase flag set)
  --repair              Apply auto-repair strategies for resolvable drift
  --cleanup-temp        Remove orphaned state.json.tmp.* and promote
                        .needs_promotion files from crashed two-phase commits

Modes:
  --dry-run             Report what would be repaired without mutating state
  --force               Auto-approve destructive actions (non-interactive)
  --verbose             Print per-divergence detail lines

Targets:
  --repo <path>         Reconcile a single repo (default: all configured)
  --output-json <path>  Emit machine-readable report to <path>

Exit codes:
  0  no inconsistencies (or detect-only with clean state)
  1  inconsistencies detected
  2  repair failures or unrecoverable error

Examples:
  autonomous-dev request reconcile
  autonomous-dev request reconcile --repair --force
  autonomous-dev request reconcile --cleanup-temp --dry-run --verbose
  autonomous-dev request reconcile --output-json /tmp/r.json
```

## Acceptance Criteria

- [ ] `autonomous-dev request reconcile --help` prints the documented help text and exits 0.
- [ ] `autonomous-dev request reconcile` (no flags) runs detect-only on every repo in the configured allowlist and exits 0 if clean, 1 if any divergence found.
- [ ] `autonomous-dev request reconcile --repo /nonexistent` exits 1 with the documented error from `validate_repo_path` BEFORE any Node process spawns.
- [ ] `autonomous-dev request reconcile --output-json /no/such/dir/r.json` exits 1 from the bash validator, no Node process spawned.
- [ ] `--repair` invokes detect first; only divergences from detect are passed to `manager.repair`.
- [ ] When `--repair --dry-run` is set, no SQLite or filesystem mutations occur (verified by hash equality of state files and DB snapshot before/after).
- [ ] In non-TTY environments without `--force`, repairs requiring confirmation are skipped and a warning is logged.
- [ ] `--output-json <path>` writes a JSON file at `<path>` whose top-level keys exactly match TDD-012 §12.2 `ReconcileReport`. File mode is `0o600`.
- [ ] Exit code is 0 when detect finds nothing AND cleanup performed nothing; 1 when inconsistencies detected (regardless of repair success); 2 when any repair fails OR an unrecoverable error occurs.
- [ ] Every invocation produces an audit log entry with `event: 'reconcile.run'` and the documented fields, including correct `exit_code` and `duration_ms`.
- [ ] Each repair produces an audit entry with `event: 'reconcile.repair'` containing `before_hash`, `after_hash`, `dry_run`, and `action`.
- [ ] When `--cleanup-temp` is combined with `--repair`, cleanup runs AFTER repair (verified by audit log timestamp ordering).
- [ ] `--verbose` appends the per-divergence detail block; without `--verbose` the summary alone is printed.
- [ ] Shellcheck passes at `--severity=warning` on the modified `bin/autonomous-dev.sh`.

## Dependencies

- SPEC-012-3-01: `ReconciliationManager.detectDivergence`, `DivergenceReport`, `ReconcileBusyError`.
- SPEC-012-3-02: `ReconciliationManager.repair`, `ReconciliationManager.cleanupOrphanedTemps`, `RepairOptions`.
- SPEC-011-1-01: dispatcher patterns and `cmd_request_delegate` integration.
- SPEC-011-1-02: `exec_node_cli` helper.
- Existing audit-log helper in `intake/core/audit_log.ts`.
- Existing config loader (`config.repositories.allowlist`).

## Notes

- The CLI deliberately defaults to read-only behavior. Operators must opt into mutations via `--repair` or `--cleanup-temp`. This mirrors the safe-by-default posture of `git fsck` and `pg_amcheck`.
- Exit code `1` for "inconsistencies detected" (rather than `0`) lets cron jobs and CI gates trigger alerts directly on exit code without needing to parse JSON.
- `--output-json` uses an atomic write (temp file + rename) to prevent partial reads by external monitoring tools.
- The `details.temp_cleanup` extension to TDD-012 §12.2 is additive and backward-compatible; existing JSON consumers continue to work.
