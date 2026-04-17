# SPEC-001-2-02: Request Selection and Phase-Aware Max-Turns Resolution

## Metadata
- **Parent Plan**: PLAN-001-2
- **Tasks Covered**: Task 3 (Request selection), Task 4 (Phase-aware max-turns resolution)
- **Estimated effort**: 5.5 hours

## Description
Replace the Plan 1 stub `select_request()` with a real implementation that scans repository allowlists, finds actionable requests, and returns the highest-priority one. Implement `resolve_max_turns()` to determine the turn budget for each phase from config with built-in defaults.

## Files to Create/Modify

- **Path**: `bin/supervisor-loop.sh`
  - **Action**: Modify
  - **Description**: Replace the `select_request()` stub. Add `resolve_max_turns()` function.

- **Path**: `config/defaults.json`
  - **Action**: Modify
  - **Description**: Ensure `repositories.allowlist` array exists (should already be present from SPEC-001-1-04).

## Implementation Details

### Task 3: Request Selection

#### `select_request() -> string`

- **Returns**: `"{request_id}|{project_path}"` if work found, or empty string if no work.
- **Algorithm**:
  1. Read the repository allowlist from effective config:
     ```bash
     local repos
     repos=$(jq -r '.repositories.allowlist[]' "${EFFECTIVE_CONFIG}" 2>/dev/null)
     ```
     If `repos` is empty (no allowlisted repos), return empty immediately.
  2. Initialize tracking variables:
     ```bash
     local best_id="" best_project="" best_priority=999999 best_created=""
     ```
  3. Iterate over each repository:
     ```bash
     while IFS= read -r repo; do
         [[ -z "${repo}" ]] && continue
         local req_dir="${repo}/.autonomous-dev/requests"
         [[ -d "${req_dir}" ]] || continue
         ...
     done <<< "${repos}"
     ```
  4. For each repository, iterate `state.json` files:
     ```bash
     for state_file in "${req_dir}"/*/state.json; do
         [[ -f "${state_file}" ]] || continue
         ...
     done
     ```
  5. For each `state.json`, extract fields with `jq`:
     ```bash
     local status priority created_at blocked_by_count req_id next_retry_after

     # Parse all fields in a single jq call for performance
     local parsed
     parsed=$(jq -r '[.id, .status, (.priority // 999 | tostring), .created_at, (.blocked_by // [] | length | tostring), (.current_phase_metadata.next_retry_after // "")] | join("|")' "${state_file}" 2>/dev/null)

     if [[ -z "${parsed}" ]]; then
         log_warn "Failed to parse state file: ${state_file}"
         continue
     fi

     IFS='|' read -r req_id status priority created_at blocked_by_count next_retry_after <<< "${parsed}"
     ```
  6. Filter non-actionable states:
     ```bash
     case "${status}" in
         paused|failed|cancelled|monitor) continue ;;
     esac
     ```
  7. Filter blocked requests:
     ```bash
     [[ "${blocked_by_count}" -gt 0 ]] && continue
     ```
  8. Filter requests in error backoff (Plan 3 writes `next_retry_after`; if present, skip if in the future):
     ```bash
     if [[ -n "${next_retry_after}" ]]; then
         local now_epoch retry_epoch
         now_epoch=$(date -u +%s)
         retry_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "${next_retry_after}" +%s 2>/dev/null \
                       || date -u -d "${next_retry_after}" +%s 2>/dev/null \
                       || echo "0")
         if [[ ${retry_epoch} -gt ${now_epoch} ]]; then
             continue  # Still in backoff period
         fi
     fi
     ```
  9. Compare to find the best (highest priority, then oldest):
     ```bash
     if [[ ${priority} -lt ${best_priority} ]] || \
        { [[ ${priority} -eq ${best_priority} ]] && [[ "${created_at}" < "${best_created}" ]]; }; then
         best_id="${req_id}"
         best_project="${repo}"
         best_priority=${priority}
         best_created="${created_at}"
     fi
     ```
  10. After scanning all repos, output the best match:
      ```bash
      if [[ -n "${best_id}" ]]; then
          echo "${best_id}|${best_project}"
      fi
      ```

- **Actionable states**: Any status NOT in `{paused, failed, cancelled, monitor}`. This includes: `intake`, `prd`, `tdd`, `plan`, `spec`, `code`, `integration`, `deploy`, and any other status that represents active work.

- **Performance note**: For large numbers of requests, the per-file `jq` calls dominate. The single-call optimization (parsing all fields in one `jq` invocation) helps. For 50+ requests, this should still complete in under 5 seconds. If profiling shows issues, consider a `find | xargs jq` batch approach.

### Task 4: Phase-Aware Max-Turns Resolution

#### `resolve_max_turns(phase: string) -> int`

- **Parameters**: `phase` -- the current status/phase name of the request (e.g., "code", "intake", "prd_review").
- **Returns**: Integer turn count to stdout.
- **Algorithm**:
  1. Check the effective config for a phase-specific override:
     ```bash
     local turns
     turns=$(jq -r ".daemon.max_turns_by_phase.\"${phase}\" // null" "${EFFECTIVE_CONFIG}")
     ```
  2. If not null, use the config value.
  3. If null (no config override), use built-in defaults by phase category:

     | Phase | Default Max Turns | Category |
     |-------|-------------------|----------|
     | `intake` | 10 | Intake |
     | `prd`, `tdd`, `plan`, `spec` | 50 | Documentation generation |
     | `prd_review`, `tdd_review`, `plan_review`, `spec_review`, `code_review` | 30 | Review |
     | `code` | 200 | Code generation |
     | `integration` | 100 | Integration testing |
     | `deploy` | 30 | Deployment |
     | anything else | 50 | Default fallback |

  4. Implementation:
     ```bash
     if [[ "${turns}" == "null" || -z "${turns}" ]]; then
         case "${phase}" in
             intake)                     turns=10  ;;
             prd|tdd|plan|spec)          turns=50  ;;
             prd_review|tdd_review|plan_review|spec_review|code_review) turns=30 ;;
             code)                       turns=200 ;;
             integration)                turns=100 ;;
             deploy)                     turns=30  ;;
             *)                          turns=50  ;;
         esac
     fi
     echo "${turns}"
     ```

### Edge Cases
- Repository path in allowlist does not exist: `[[ -d "${req_dir}" ]] || continue` skips it silently. No error logged (repo may be on an unmounted volume).
- Repository path in allowlist has no `.autonomous-dev/requests/` directory: Skipped silently.
- `state.json` is corrupt/unparseable: `jq` returns empty, caught by the `[[ -z "${parsed}" ]]` check. Logged as a warning, request skipped.
- All requests are non-actionable: Returns empty string (no work).
- Two requests at identical priority and identical `created_at`: The first one scanned wins (deterministic by filesystem iteration order, but effectively arbitrary). This is acceptable.
- `blocked_by` field missing from state.json: Defaults to empty array (`// []`), so `blocked_by_count` is 0 (not blocked).
- `priority` field missing from state.json: Defaults to 999 (lowest priority).
- `resolve_max_turns` with empty string phase: Falls through to default case, returns 50.

## Acceptance Criteria
1. [ ] With two requests at priorities 1 and 2, `select_request()` returns the priority 1 request
2. [ ] With two requests at equal priority, returns the one with the earlier `created_at`
3. [ ] Requests with `status: paused` are skipped
4. [ ] Requests with `status: failed` are skipped
5. [ ] Requests with `status: cancelled` are skipped
6. [ ] Requests with `status: monitor` are skipped
7. [ ] Requests with non-empty `blocked_by` arrays are skipped
8. [ ] Empty allowlist returns empty string (no work)
9. [ ] Non-existent repository directories are skipped without error
10. [ ] Corrupt state.json files are skipped with a warning log
11. [ ] Output format is `"{request_id}|{project_path}"`
12. [ ] `resolve_max_turns "intake"` returns 10
13. [ ] `resolve_max_turns "code"` returns 200
14. [ ] `resolve_max_turns "prd_review"` returns 30
15. [ ] `resolve_max_turns "unknown_phase"` returns 50
16. [ ] Config override of `max_turns_by_phase.code: 300` causes `resolve_max_turns "code"` to return 300
17. [ ] No shellcheck warnings at `--severity=warning` level

## Test Cases
1. **test_select_priority_ordering** -- Create two requests: REQ-A at priority 1 and REQ-B at priority 2. Call `select_request`. Assert output starts with "REQ-A".
2. **test_select_tiebreak_by_created_at** -- Create two requests at priority 1: REQ-A created "2026-04-07", REQ-B created "2026-04-08". Call `select_request`. Assert output starts with "REQ-A" (older wins).
3. **test_select_skips_paused** -- Create one request with `status: "paused"`. Call `select_request`. Assert output is empty.
4. **test_select_skips_failed** -- Create one request with `status: "failed"`. Assert output is empty.
5. **test_select_skips_cancelled** -- Create one request with `status: "cancelled"`. Assert output is empty.
6. **test_select_skips_monitor** -- Create one request with `status: "monitor"`. Assert output is empty.
7. **test_select_skips_blocked** -- Create a request with `blocked_by: ["REQ-other"]`. Assert output is empty.
8. **test_select_empty_allowlist** -- Set allowlist to empty array. Call `select_request`. Assert output is empty.
9. **test_select_nonexistent_repo** -- Set allowlist to `["/nonexistent/path"]`. Call `select_request`. Assert output is empty, no error in log.
10. **test_select_corrupt_state_file** -- Create a state file with invalid JSON. Call `select_request`. Assert it is skipped. Assert log contains "Failed to parse state file".
11. **test_select_multiple_repos** -- Create requests across two repos. The highest-priority request from any repo is selected.
12. **test_select_missing_priority_defaults_999** -- Create a request without a `priority` field. Assert it is treated as priority 999.
13. **test_resolve_max_turns_intake** -- Assert `resolve_max_turns "intake"` outputs "10".
14. **test_resolve_max_turns_code** -- Assert `resolve_max_turns "code"` outputs "200".
15. **test_resolve_max_turns_review** -- Assert `resolve_max_turns "prd_review"` outputs "30".
16. **test_resolve_max_turns_deploy** -- Assert `resolve_max_turns "deploy"` outputs "30".
17. **test_resolve_max_turns_integration** -- Assert `resolve_max_turns "integration"` outputs "100".
18. **test_resolve_max_turns_unknown** -- Assert `resolve_max_turns "some_new_phase"` outputs "50".
19. **test_resolve_max_turns_config_override** -- Set effective config with `max_turns_by_phase.code: 300`. Assert `resolve_max_turns "code"` outputs "300".
20. **test_select_skips_backoff** -- Create a request with `next_retry_after` 5 minutes in the future. Assert it is skipped.
