# SPEC-018-1-03: state-v1.1.json JSON Schema + migrate-state-files.sh

## Metadata
- **Parent Plan**: PLAN-018-1-request-type-enum-state-schema
- **Tasks Covered**: Task 5 (JSON schema), Task 6 (operator migration shell script)
- **Estimated effort**: 4 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-018-1-03-state-v1-1-json-schema-migration-script.md`

## Description
Produce two operator-facing artefacts that together form the runtime contract for v1.1 state files: a JSON Schema 2020-12 document at `schemas/state-v1.1.json` (consumed by the loader's AJV validator in SPEC-018-1-04 and by any future audit tooling), and a Bash operator script at `bin/migrate-state-files.sh` (one-shot migration of existing v1.0 files under `~/.autonomous-dev`). The schema must validate the canonical example from TDD-018 §7.2 and reject malformed states with field-pointing errors. The script must be shellcheck-clean, idempotent, daemon-aware, and use `jq` for JSON manipulation.

The schema is intentionally permissive on `additionalProperties` (set to `true`) to honor the migration-window risk in PLAN-018-1: existing requests may carry unanticipated fields, and the schema's job is to validate the v1.1 contract, not to police every property. `bug_context` is `type: object` only; PLAN-018-3 supplies the full sub-schema and this schema imports it via `$ref` once available.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/schemas/state-v1.1.json` | Create | JSON Schema 2020-12, AJV-compatible |
| `plugins/autonomous-dev/bin/migrate-state-files.sh` | Create | Bash, executable, shellcheck-clean |

## Implementation Details

### `schemas/state-v1.1.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://autonomous-dev/schemas/state-v1.1.json",
  "title": "RequestState v1.1",
  "description": "Persisted state for an autonomous-dev request. Schema v1.1 adds request typing.",
  "type": "object",
  "additionalProperties": true,
  "required": [
    "schema_version", "id", "status",
    "phase_overrides", "type_config"
  ],
  "properties": {
    "schema_version": { "const": 1.1 },
    "id": { "type": "string", "minLength": 1 },
    "status": { "type": "string", "minLength": 1 },
    "request_type": {
      "type": "string",
      "enum": ["feature", "bug", "infra", "refactor", "hotfix"]
    },
    "bug_context": {
      "type": "object",
      "description": "Validated by bug-report sub-schema in PLAN-018-3."
    },
    "phase_overrides": {
      "type": "array",
      "items": { "type": "string" }
    },
    "type_config": {
      "type": "object",
      "required": [
        "skippedPhases", "enhancedPhases", "expeditedReviews",
        "additionalGates", "maxRetries", "phaseTimeouts"
      ],
      "properties": {
        "skippedPhases":  { "type": "array", "items": { "type": "string" } },
        "enhancedPhases": { "type": "array", "items": { "type": "string" } },
        "expeditedReviews": { "type": "boolean" },
        "additionalGates": { "type": "array", "items": { "type": "string" } },
        "maxRetries": { "type": "integer", "minimum": 0 },
        "phaseTimeouts": {
          "type": "object",
          "additionalProperties": { "type": "number", "minimum": 0 }
        }
      },
      "additionalProperties": false
    },
    "priority":          { "type": "integer" },
    "title":             { "type": "string" },
    "description":       { "type": "string" },
    "repository":        { "type": "string" },
    "branch":            { "type": "string" },
    "worktree_path":     { "type": "string" },
    "created_at":        { "type": "string", "format": "date-time" },
    "updated_at":        { "type": "string", "format": "date-time" },
    "cost_accrued_usd":  { "type": "number", "minimum": 0 },
    "turn_count":        { "type": "integer", "minimum": 0 },
    "escalation_count":  { "type": "integer", "minimum": 0 },
    "blocked_by":        { "type": "array", "items": { "type": "string" } },
    "phase_history":     { "type": "array" },
    "current_phase_metadata": { "type": "object" },
    "error":             { "type": ["string", "null"] },
    "last_checkpoint":   { "type": "string", "format": "date-time" }
  }
}
```

### `bin/migrate-state-files.sh`

```bash
#!/usr/bin/env bash
# migrate-state-files.sh - Migrates v1.0 autonomous-dev state files to v1.1.
#
# IMPORTANT: Stop the autonomous-dev daemon before running. The script will
# refuse to run if it detects a live daemon via ~/.autonomous-dev/daemon.lock.
#
# Usage: bin/migrate-state-files.sh [STATE_ROOT]
#   STATE_ROOT defaults to ~/.autonomous-dev
#
# Behavior:
#   - Finds all `state.json` files under STATE_ROOT.
#   - For each file:
#       schema_version == 1.1  -> log "Already v1.1" and skip
#       schema_version == 1.0  -> back up to .v1.0.backup, rewrite as v1.1
#       anything else          -> log warning and skip
#   - Idempotent: re-running on a migrated tree is a no-op.

set -euo pipefail

STATE_ROOT="${1:-${HOME}/.autonomous-dev}"
LOCK_FILE="${HOME}/.autonomous-dev/daemon.lock"

log() { printf '[migrate-state-files] %s\n' "$*"; }
warn() { printf '[migrate-state-files] WARN: %s\n' "$*" >&2; }
die() { printf '[migrate-state-files] ERROR: %s\n' "$*" >&2; exit 1; }

check_daemon_not_running() {
    [[ -f "$LOCK_FILE" ]] || return 0
    local pid
    pid="$(cat "$LOCK_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        die "Daemon appears to be running (PID $pid). Stop it before migrating."
    fi
    warn "Stale lock file at $LOCK_FILE (PID $pid not alive); proceeding."
}

migrate_state_file() {
    local state_file="$1"
    local version
    version="$(jq -r '.schema_version' "$state_file" 2>/dev/null || echo 'unknown')"

    case "$version" in
        1.1)
            log "Already v1.1: $state_file"
            return 0
            ;;
        1.0)
            ;;
        *)
            warn "Unrecognized schema_version '$version' in $state_file; skipping."
            return 0
            ;;
    esac

    cp -p "$state_file" "${state_file}.v1.0.backup"

    jq '. + {
        "schema_version": 1.1,
        "request_type": "feature",
        "phase_overrides": [
            "intake", "prd", "prd_review", "tdd", "tdd_review",
            "plan", "plan_review", "spec", "spec_review",
            "code", "code_review", "integration", "deploy", "monitor"
        ],
        "type_config": {
            "skippedPhases": [],
            "enhancedPhases": [],
            "expeditedReviews": false,
            "additionalGates": [],
            "maxRetries": 3,
            "phaseTimeouts": {}
        }
    }' "$state_file" > "${state_file}.tmp"

    mv "${state_file}.tmp" "$state_file"
    log "Migrated: $state_file (backup at ${state_file}.v1.0.backup)"
}

main() {
    command -v jq >/dev/null 2>&1 || die "jq is required but not installed."
    [[ -d "$STATE_ROOT" ]] || die "STATE_ROOT does not exist: $STATE_ROOT"
    check_daemon_not_running

    local count=0
    while IFS= read -r -d '' file; do
        migrate_state_file "$file"
        count=$((count + 1))
    done < <(find "$STATE_ROOT" -name 'state.json' -type f -print0)

    log "Processed $count state file(s) under $STATE_ROOT."
}

main "$@"
```

### Constraints

- The script's first line is `#!/usr/bin/env bash` and the file is committed with mode `0755`.
- `set -euo pipefail` is mandatory.
- `find … -print0` + `read -d ''` is mandatory (handles paths with spaces/newlines).
- All `jq` invocations use single quotes and explicit field literals (no shell interpolation into the filter).
- Backup file convention: append `.v1.0.backup` to the original filename.

## Acceptance Criteria

### JSON Schema

- [ ] `schemas/state-v1.1.json` parses with `jq -e .` exit 0.
- [ ] AJV `compile()` succeeds with `strict: true` and the 2020-12 metaschema loaded.
- [ ] The v1.1 example from TDD-018 §7.2 validates clean (no errors).
- [ ] A state with `schema_version: 1.0` fails validation; the AJV error path includes `/schema_version`.
- [ ] A state with `request_type: "invalid"` fails validation with an `enum` error on `/request_type`.
- [ ] A state missing `phase_overrides` fails validation with a `required` error.
- [ ] A state missing `type_config.maxRetries` fails validation with a `required` error on `/type_config`.
- [ ] A state with an unknown extra field at the top level (e.g., `"future_field": 1`) validates clean (`additionalProperties: true`).
- [ ] A state with `type_config.unknown_field: 1` fails validation (`additionalProperties: false` inside `type_config`).

### Migration Script

- [ ] `shellcheck bin/migrate-state-files.sh` exits 0 with no warnings.
- [ ] File is executable (`-rwxr-xr-x`).
- [ ] Running against a temp directory with three v1.0 `state.json` files migrates all three; three `.v1.0.backup` files exist; original paths now contain `schema_version: 1.1`.
- [ ] Re-running against the same directory produces three "Already v1.1" log lines and zero further changes (file mtimes unchanged for `.json` files; no new `.backup` files).
- [ ] A v1.1 file with user-set `request_type: "bug"` is left unchanged on a re-run (idempotency preserves user values).
- [ ] An unrecognized `schema_version` value (e.g., `"2.0"` or `null`) emits a WARN line and skips the file (no backup, no overwrite).
- [ ] If `~/.autonomous-dev/daemon.lock` exists and references a live PID, the script exits non-zero with a clear "Daemon appears to be running" message and modifies nothing.
- [ ] If the lock file references a dead PID, the script logs a stale-lock WARN and proceeds.
- [ ] Exits non-zero with a clear error if `jq` is not on `PATH` or `STATE_ROOT` does not exist.

## Dependencies

- `jq` ≥ 1.6 must be installed on the operator machine (script aborts with a clear error otherwise).
- `shellcheck` (development-time only) for static analysis in CI.
- AJV (development-time only, used by the loader in SPEC-018-1-04 and the schema test).
- The schema's `bug_context` field will be tightened to a `$ref` against the bug-report sub-schema once PLAN-018-3 lands; until then it is a permissive `type: object`.

## Notes

- The schema sets `additionalProperties: true` on the root object intentionally (per the PLAN-018-1 risk register) so unknown fields on existing requests do not cause the loader to throw during the migration window. This relaxation is *not* applied inside `type_config`, where structure is fully known.
- The migration script's defaults (the literal v1.1 fields injected via `jq`) must mirror the FEATURE entry of `PHASE_OVERRIDE_MATRIX` (SPEC-018-1-01). If the matrix changes, this script must be updated in lockstep — the snapshot test in SPEC-018-1-04 should fail in that case to alert reviewers.
- The script does not import or shell out to TypeScript; it is a pure Bash + `jq` operator tool intended for one-shot upgrades and disaster recovery. The loader (SPEC-018-1-04) handles in-process migration and is the primary mechanism in normal operation.
- Document in the script header that running it on a tree containing only v1.1 files is safe (no-op).
