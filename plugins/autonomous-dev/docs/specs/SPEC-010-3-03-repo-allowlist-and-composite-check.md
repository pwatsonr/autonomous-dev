# SPEC-010-3-03: Repository Allowlist, Per-Repo Overrides, and Composite Resource Check

## Metadata
- **Parent Plan**: PLAN-010-3
- **Tasks Covered**: Task 7, Task 8, Task 9, Task 10
- **Estimated effort**: 10 hours

## Description

Implement repository allowlist validation with symlink resolution and `.git` checks, per-repository configuration overrides merged at the correct precedence level, the composite `check_resources()` orchestration function, and error handling for all resource monitor failures.

## Files to Create/Modify

| Action | Path | Purpose |
|--------|------|---------|
| Create | `lib/repo_allowlist.sh` | Allowlist validation and per-repo override resolution |
| Modify | `lib/config_loader.sh` | Add repo-override merge layer (from PLAN-010-1) |
| Modify | `lib/resource_monitor.sh` | Add composite `check_resources()` and error handling |

## Implementation Details

### Repository Allowlist Validation (lib/repo_allowlist.sh)

**`validate_repository()`** -- Validates a repository path against the allowlist:

```bash
validate_repository() {
  local repo_path="$1"
  local effective_config="$2"
  
  # Step 1: Resolve symlinks
  local resolved
  resolved=$(realpath "$repo_path" 2>/dev/null) || {
    echo "ERROR: Path does not exist: $repo_path" >&2
    return 1
  }
  
  # Step 2: Check .git directory exists
  if [[ ! -d "$resolved/.git" ]]; then
    echo "ERROR: Not a git repository (no .git directory): $resolved" >&2
    return 1
  fi
  
  # Step 3: Compare against allowlist (after resolving both sides)
  local allowed=false
  while IFS= read -r allowed_path; do
    [[ -z "$allowed_path" ]] && continue
    local resolved_allowed
    resolved_allowed=$(realpath "$allowed_path" 2>/dev/null) || {
      log_warning "repo_allowlist" "Allowlist path could not be resolved: $allowed_path"
      continue
    }
    if [[ "$resolved" == "$resolved_allowed" ]]; then
      allowed=true
      break
    fi
  done < <(echo "$effective_config" | jq -r '.repositories.allowlist[]?')
  
  if [[ "$allowed" != "true" ]]; then
    echo "ERROR: Repository not on allowlist: $resolved" >&2
    return 1
  fi
  
  return 0
}
```

**Validation rules** (from TDD-010 Section 3.5.2):
1. Path must be an exact match after `realpath` resolution (no glob, no prefix matching).
2. Symlinks are resolved on both sides (the input path and each allowlist entry).
3. The resolved path must exist on disk (`realpath` fails for non-existent paths).
4. The resolved path must contain a `.git/` directory.
5. Empty allowlist rejects everything.

### Per-Repository Config Overrides

**`get_repo_override()`** -- Retrieve the override config for a specific repo:

```bash
get_repo_override() {
  local repo_path="$1"
  local effective_config="$2"
  
  local resolved
  resolved=$(realpath "$repo_path" 2>/dev/null) || {
    echo "{}"
    return 0
  }
  
  # Check if overrides exist for this repo
  local override
  override=$(echo "$effective_config" | jq --arg repo "$resolved" '.repositories.overrides[$repo] // {}')
  
  # Also check with the original (unresolved) path
  if [[ "$override" == "{}" ]] || [[ "$override" == "null" ]]; then
    override=$(echo "$effective_config" | jq --arg repo "$repo_path" '.repositories.overrides[$repo] // {}')
  fi
  
  echo "${override:-{}}"
}
```

**Precedence chain with repo overrides** (modification to `config_loader.sh`):

```bash
# In load_config(), after the standard 4-layer merge:
# CLI > repo_override > project > global > defaults
load_config_for_request() {
  local repo_path="$1"
  shift
  
  # Standard 4-layer merge
  local base_config
  base_config=$(load_config "$@")
  
  # Get repo override
  local repo_override
  repo_override=$(get_repo_override "$repo_path" "$base_config")
  
  if [[ "$repo_override" != "{}" ]] && [[ "$repo_override" != "null" ]]; then
    # Re-merge: insert repo_override between project and CLI
    # Since CLI is already highest, we need to:
    # 1. Merge repo_override into the base (which is defaults*global*project)
    # 2. Then re-apply CLI overrides on top
    local cli_overrides
    cli_overrides=$(parse_cli_overrides "$@")
    
    # base_without_cli = defaults * global * project
    local base_without_cli
    base_without_cli=$(load_config_no_cli)
    
    # Final: base_without_cli * repo_override * cli_overrides
    local merged
    merged=$(merge_configs "$base_without_cli" "$repo_override")
    merged=$(merge_configs "$merged" "$cli_overrides")
    echo "$merged"
  else
    echo "$base_config"
  fi
}
```

**Override example** (from TDD-010 Section 3.5.3):

```json
{
  "repositories": {
    "allowlist": [
      "/Users/pwatson/codebase/dashboard-app",
      "/Users/pwatson/codebase/api-service"
    ],
    "overrides": {
      "/Users/pwatson/codebase/api-service": {
        "trust": { "system_default_level": 2 },
        "governance": { "per_request_cost_cap_usd": 75 }
      }
    }
  }
}
```

When processing a request targeting `/Users/pwatson/codebase/api-service`, the effective config will have `trust.system_default_level=2` and `governance.per_request_cost_cap_usd=75`, overriding the global/project values but not any CLI flags.

### Composite check_resources()

**`check_resources()`** -- Orchestrates all resource checks in sequence:

```bash
check_resources() {
  local effective_config="$1"
  
  local overall_status="pass"
  local checks="[]"
  
  # 1. Disk usage
  local disk_result
  disk_result=$(check_disk_usage "$effective_config") || overall_status="fail"
  checks=$(echo "$checks" | jq --argjson disk "$disk_result" '. + [$disk]')
  
  # 2. Worktree count
  local worktree_result
  worktree_result=$(check_worktree_count "$effective_config") || overall_status="fail"
  checks=$(echo "$checks" | jq --argjson wt "$worktree_result" '. + [$wt]')
  
  # 3. Active sessions
  local session_result
  session_result=$(check_active_sessions "$effective_config") || overall_status="fail"
  checks=$(echo "$checks" | jq --argjson sess "$session_result" '. + [$sess]')
  
  # 4. Rate limit state
  local rate_status="pass"
  if ! check_rate_limit_state; then
    rate_status="fail"
    overall_status="fail"
  fi
  checks=$(echo "$checks" | jq --arg s "$rate_status" '. + [{"type":"rate_limit","status":$s}]')
  
  # Build composite result
  jq -nc \
    --arg status "$overall_status" \
    --argjson checks "$checks" \
    '{status: $status, checks: $checks}'
  
  if [[ "$overall_status" == "fail" ]]; then
    return 1
  fi
  return 0
}
```

**Return format**:

```json
{
  "status": "fail",
  "checks": [
    {"type": "system_disk", "status": "ok", "usage_gb": 5.23, "limit_gb": 10.0},
    {"type": "worktree_disk", "status": "ok", "usage_gb": 1.5},
    {"type": "worktree_count", "status": "pass", "count": 3, "max": 5},
    {"type": "active_sessions", "status": "fail", "count": 3, "max": 3},
    {"type": "rate_limit", "status": "pass"}
  ]
}
```

### Error Handling

All error handling follows TDD-010 Section 5.3:

| Error | Detection | Response |
|-------|-----------|----------|
| `du` fails | Non-zero exit | Log warning. Skip disk check. Do NOT block work. |
| Rate-limit state file missing | `[[ ! -f ]]` | Treat as no active rate limit. Create on next event. |
| Rate-limit state corrupted | `jq` parse failure | Delete file, create fresh. Log warning. |
| `git worktree list` fails | Non-zero exit | Log warning. Assume count at max (conservative). |
| Allowlist path cannot be resolved | `realpath` fails | Log warning, skip that entry. |
| State file missing/malformed | `jq` parse failure | Skip request, log warning. |

These are implemented inline in the check functions (shown in SPEC-010-3-01 and SPEC-010-3-02).

## Acceptance Criteria

1. Allowlist validates exact match after `realpath` resolution on both sides.
2. Symlinks are resolved before comparison.
3. Path must exist on disk and contain `.git/` directory.
4. Non-allowlisted paths are rejected with a clear error message.
5. Empty allowlist rejects everything.
6. Per-repo overrides are applied only when the request targets a matching repo.
7. Override precedence: CLI > repo override > project > global > defaults.
8. Non-matching repos get no override (standard config).
9. Overrides are deep-merged (not shallow).
10. Composite `check_resources()` runs all four checks in sequence.
11. Each check's result is reported individually in the output JSON.
12. Any single check failure causes the composite to return non-zero.
13. Each error scenario from Section 5.3 is handled as specified.
14. No error case causes the system to crash or hang.
15. Conservative assumptions are used when measurement data is unavailable.

## Test Cases

1. **Allowlist exact match**: Repo `/Users/dev/project` is in allowlist. Returns 0.
2. **Allowlist symlink match**: Repo `/tmp/link` is a symlink to `/Users/dev/project` which is in allowlist. Returns 0.
3. **Allowlist not found**: Repo `/Users/dev/other` is not in allowlist. Returns 1.
4. **Allowlist non-existent path**: Repo path does not exist on disk. Returns 1.
5. **Allowlist no .git**: Path exists but has no `.git/` directory. Returns 1.
6. **Empty allowlist**: Allowlist is `[]`. Any repo returns 1.
7. **Repo override applied**: Request targets `/Users/dev/api-service` which has overrides. Config has overridden values.
8. **Repo override not applied**: Request targets `/Users/dev/dashboard-app` which has no overrides. Config is standard.
9. **Repo override deep merge**: Override sets `governance.per_request_cost_cap_usd`. Other `governance.*` fields retain base values.
10. **CLI overrides repo override**: CLI sets `--config.governance.per_request_cost_cap_usd=25`. Repo override has 75. Result is 25 (CLI wins).
11. **Composite all pass**: All four checks pass. Returns 0, `status: "pass"`.
12. **Composite one fails**: Disk OK, worktrees OK, sessions at max, rate OK. Returns 1, `status: "fail"`, only sessions check shows "fail".
13. **Composite multiple fail**: Disk and rate both fail. Returns 1, both shown as "fail".
14. **Error: du failure**: Disk check encounters `du` error. Skipped, does not block.
15. **Error: corrupted rate state**: Rate state file has invalid JSON. Deleted and recreated.
16. **Error: git worktree list fails**: Assumed at max, returns fail.
