# SPEC-001-2-03: Phase Prompt Resolution and Session Spawning

## Metadata
- **Parent Plan**: PLAN-001-2
- **Tasks Covered**: Task 5 (Phase prompt resolution), Task 6 (Session spawning)
- **Estimated effort**: 6 hours

## Description
Implement phase prompt resolution that looks up phase-specific prompt files and performs variable substitution, and session spawning that checkpoints state, builds the `claude` CLI command, spawns it as a background process, waits for exit, and captures results.

## Files to Create/Modify

- **Path**: `bin/supervisor-loop.sh`
  - **Action**: Modify
  - **Description**: Add `resolve_phase_prompt()` and `spawn_session()` functions.

- **Path**: `phase-prompts/README.md`
  - **Action**: Create
  - **Description**: Placeholder documenting the phase prompt convention. Actual prompt files are out of scope for TDD-001.

## Implementation Details

### Task 5: Phase Prompt Resolution

#### `resolve_phase_prompt(status: string, request_id: string, project: string) -> string`

- **Parameters**:
  - `status`: Current phase/status of the request (e.g., "intake", "code", "prd_review").
  - `request_id`: The request ID (e.g., "REQ-20260408-abcd").
  - `project`: Absolute path to the project/repository root.
- **Returns**: The resolved prompt string to stdout.

- **Algorithm**:
  1. Compute the prompt file path:
     ```bash
     local prompt_file="${PLUGIN_DIR}/phase-prompts/${status}.md"
     ```
  2. Compute the state file path for substitution:
     ```bash
     local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"
     ```
  3. If the prompt file exists:
     a. Read its contents:
        ```bash
        local prompt_template
        prompt_template=$(cat "${prompt_file}")
        ```
     b. Perform variable substitution. Use bash parameter expansion or `sed` for safety:
        ```bash
        local resolved="${prompt_template}"
        resolved="${resolved//\{\{REQUEST_ID\}\}/${request_id}}"
        resolved="${resolved//\{\{PROJECT\}\}/${project}}"
        resolved="${resolved//\{\{STATE_FILE\}\}/${state_file}}"
        resolved="${resolved//\{\{PHASE\}\}/${status}}"
        ```
        Note: Bash `${var//pattern/replacement}` does not interpret regex special characters in the replacement, making it safer than `sed` for paths containing `/`.
     c. Output the resolved prompt.
  4. If the prompt file does NOT exist:
     - Generate a fallback prompt:
       ```bash
       local fallback
       fallback="You are an autonomous development agent working on request ${request_id}.

Your current phase is: ${status}

Read the request state file at: ${state_file}
Read the project context at: ${project}

Perform the work required for the '${status}' phase as described in the state file.
When complete, update the state file to reflect your progress.
If you encounter an error you cannot resolve, write the error details to the state file's current_phase_metadata.last_error field."
       ```
     - `log_info "No prompt file for phase '${status}'. Using fallback prompt."`
     - Output the fallback.

#### `phase-prompts/README.md` Content

```markdown
# Phase Prompts

This directory contains prompt templates for each pipeline phase.
The daemon's `resolve_phase_prompt()` function loads the template
matching the current request status and substitutes variables.

## Supported Variables

- `{{REQUEST_ID}}` -- The request ID (e.g., REQ-20260408-abcd)
- `{{PROJECT}}` -- Absolute path to the project repository
- `{{STATE_FILE}}` -- Absolute path to the request's state.json
- `{{PHASE}}` -- The current phase name

## File Naming Convention

`{phase-name}.md` -- e.g., `intake.md`, `code.md`, `prd_review.md`

## Fallback

If no prompt file exists for a phase, a minimal fallback prompt is
generated automatically. It instructs Claude to read the state file
and perform the named phase's work.
```

### Task 6: Session Spawning

#### `spawn_session(request_id: string, project: string) -> string`

- **Parameters**:
  - `request_id`: The request ID to process.
  - `project`: Absolute path to the project/repository root.
- **Returns**: `"{exit_code}|{session_cost}|{output_file}"` to stdout.

- **Algorithm**:
  1. Resolve the state file path:
     ```bash
     local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"
     local req_dir="${project}/.autonomous-dev/requests/${request_id}"
     ```

  2. Read current status:
     ```bash
     local status
     status=$(jq -r '.status' "${state_file}")
     ```

  3. Resolve max turns and phase prompt:
     ```bash
     local max_turns phase_prompt
     max_turns=$(resolve_max_turns "${status}")
     phase_prompt=$(resolve_phase_prompt "${status}" "${request_id}" "${project}")
     ```

  4. **Checkpoint** -- Copy current state as recovery point:
     ```bash
     cp "${state_file}" "${req_dir}/checkpoint.json"
     log_info "Checkpoint created for ${request_id}"
     ```

  5. Mark session as active in state metadata:
     ```bash
     local tmp="${state_file}.tmp"
     jq '.current_phase_metadata.session_active = true' "${state_file}" > "${tmp}"
     mv "${tmp}" "${state_file}"
     ```

  6. Update heartbeat with active request:
     ```bash
     write_heartbeat "${request_id}"
     ```

  7. Log the spawn:
     ```bash
     log_info "Spawning session: request=${request_id} phase=${status} max_turns=${max_turns}"
     ```

  8. Build output file path:
     ```bash
     local timestamp
     timestamp=$(date +%s)
     local output_file="${LOG_DIR}/session-${request_id}-${timestamp}.json"
     ```

  9. Spawn the claude process:
     ```bash
     claude \
         --print \
         --output-format json \
         --max-turns "${max_turns}" \
         --prompt "${phase_prompt}" \
         --project-directory "${project}" \
         > "${output_file}" 2>&1 &
     CURRENT_CHILD_PID=$!
     ```

  10. Wait for the child process:
      ```bash
      local exit_code=0
      wait "${CURRENT_CHILD_PID}" || exit_code=$?
      CURRENT_CHILD_PID=""
      ```

  11. Handle signal interruption during wait:
      ```bash
      # If shutdown was requested and wait was interrupted,
      # the child may still be running. Plan 3 handles escalation.
      # For now, record whatever exit code we got.
      if [[ "${SHUTDOWN_REQUESTED}" == "true" && ${exit_code} -eq 143 ]]; then
          log_info "Session wait interrupted by shutdown signal"
      fi
      ```

  12. Clear session active flag:
      ```bash
      if [[ -f "${state_file}" ]]; then
          local tmp="${state_file}.tmp"
          jq '.current_phase_metadata.session_active = false' "${state_file}" > "${tmp}"
          mv "${tmp}" "${state_file}"
      fi
      ```

  13. Log exit:
      ```bash
      log_info "Session exited: request=${request_id} exit_code=${exit_code}"
      ```

  14. Parse session cost from output:
      ```bash
      local session_cost="0"
      if [[ -f "${output_file}" ]]; then
          session_cost=$(jq -r '.cost_usd // .result.cost_usd // 0' "${output_file}" 2>/dev/null || echo "0")
      fi
      ```
      Note: The exact JSON path for cost depends on the `claude --output-format json` schema. The implementation tries multiple paths with fallback.

  15. Clear heartbeat active request:
      ```bash
      write_heartbeat
      ```

  16. Return result:
      ```bash
      echo "${exit_code}|${session_cost}|${output_file}"
      ```

### Edge Cases
- **Prompt contains special characters**: Bash parameter expansion (`${var//pattern/replacement}`) handles `/`, `$`, and other characters in the replacement string safely. However, the prompt itself may be very long. Passing via `--prompt` on the command line has OS-level argument length limits (~256KB on macOS, ~2MB on Linux). For extremely long prompts, consider writing to a temp file and using `--prompt "$(cat tempfile)"`. For now, assume prompts are under 100KB.
- **State file missing before spawn**: If `state.json` was deleted between selection and spawn, `jq` calls fail. Add a guard:
  ```bash
  if [[ ! -f "${state_file}" ]]; then
      log_error "State file disappeared: ${state_file}"
      echo "1|0|"
      return
  fi
  ```
- **Claude CLI not found at spawn time**: Unlikely if `validate_dependencies` passed, but `command -v claude` could be re-checked. Not required.
- **Output file parse failure**: If `claude` writes non-JSON output, `jq` parse fails. Fallback to `session_cost=0`.
- **Concurrent modification of state.json during session**: The claude session may modify state.json. The post-session `session_active = false` update reads the current state (which claude may have modified) and only adds/updates the one field. This is safe.

## Acceptance Criteria
1. [ ] With a `phase-prompts/intake.md` containing `{{REQUEST_ID}}` and `{{PROJECT}}`, the resolved prompt has actual values substituted
2. [ ] Without a prompt file for a phase, a fallback prompt is returned containing the phase name, request ID, and state file path
3. [ ] The fallback prompt instructs Claude to read the state file and perform the phase's work
4. [ ] Variable substitution handles paths with `/` characters correctly
5. [ ] `checkpoint.json` is created as a copy of `state.json` before spawning
6. [ ] `session_active` is set to `true` in state metadata before spawn and `false` after
7. [ ] The `claude` command is invoked with `--print --output-format json --max-turns N --prompt "..." --project-directory "..."`
8. [ ] Exit code is correctly captured even for non-zero exits
9. [ ] `CURRENT_CHILD_PID` is set during execution and cleared after
10. [ ] Session output is written to `logs/session-{request_id}-{timestamp}.json`
11. [ ] Session cost is parsed from the output file (with fallback to 0)
12. [ ] Return format is `"{exit_code}|{session_cost}|{output_file}"`
13. [ ] Heartbeat shows active request during session and null after
14. [ ] State file disappearing before spawn produces a clean error (not a bash crash)
15. [ ] No shellcheck warnings at `--severity=warning` level

## Test Cases
1. **test_resolve_prompt_with_file** -- Create `phase-prompts/test_phase.md` with content `"Processing {{REQUEST_ID}} in {{PROJECT}} at {{STATE_FILE}}"`. Call `resolve_phase_prompt "test_phase" "REQ-001" "/tmp/project"`. Assert output contains "REQ-001", "/tmp/project", and the state file path.
2. **test_resolve_prompt_fallback** -- Call `resolve_phase_prompt "nonexistent_phase" "REQ-001" "/tmp/project"`. Assert output contains "nonexistent_phase", "REQ-001", and the state file path. Assert log contains "No prompt file".
3. **test_resolve_prompt_special_chars_in_path** -- Call with `project="/tmp/my project/foo"`. Assert the substituted prompt contains the path with spaces intact.
4. **test_spawn_creates_checkpoint** -- Create a `state.json` fixture. Call `spawn_session` (with mock claude). Assert `checkpoint.json` exists and matches the original `state.json`.
5. **test_spawn_sets_session_active** -- After calling `spawn_session` with mock claude, read the state.json. Assert `.current_phase_metadata.session_active == false` (cleared after session).
6. **test_spawn_invokes_claude_correctly** -- Use `mock-claude.sh` that logs its arguments. Call `spawn_session`. Assert the mock received `--print`, `--output-format json`, `--max-turns`, `--prompt`, and `--project-directory` flags.
7. **test_spawn_captures_exit_code_zero** -- Mock claude exits 0. Assert the result starts with "0|".
8. **test_spawn_captures_exit_code_nonzero** -- Mock claude exits 1. Assert the result starts with "1|".
9. **test_spawn_parses_session_cost** -- Mock claude writes `{"cost_usd": 2.50}` to stdout. Assert the result contains "|2.50|".
10. **test_spawn_cost_parse_failure** -- Mock claude writes non-JSON output. Assert session_cost defaults to "0".
11. **test_spawn_output_file_created** -- Call `spawn_session`. Assert a file matching `session-REQ-*-*.json` exists in `$LOG_DIR`.
12. **test_spawn_current_child_pid_cleared** -- After `spawn_session` returns, assert `CURRENT_CHILD_PID` is empty.
13. **test_spawn_state_file_missing** -- Remove the state file before calling `spawn_session`. Assert it returns "1|0|" without crashing.
14. **test_spawn_heartbeat_active_during_session** -- Use a mock claude that reads the heartbeat during execution. Assert heartbeat shows the active request ID.
