#!/usr/bin/env bash
###############################################################################
# daemon-run-tests.sh — REQ-000058: Canonical test re-execution producer
#
# Provides daemon_run_tests <req_dir> <project_root> <phase>
#
# Called by supervisor-loop.sh::dispatch_phase after the belt-and-suspenders
# synthesis block, before H4 self-heal. Independently re-runs the project's
# test suite and writes <req_dir>/test-results.json (schema v1, mode 0600),
# so the verifier's rescue path and F7's detector both have proof of pass/fail
# that is INDEPENDENT of whether the executor's test command was captured in
# command-audit.jsonl.
#
# Kill-switch:  export VERIFICATION_DAEMON_RERUN=0   (disables entirely)
# Timeout override: export VERIFICATION_DAEMON_RERUN_TIMEOUT_S=<seconds>
# Runner override:  export VERIFICATION_DAEMON_RERUN_RUNNER=vitest|jest|npm_script|auto
#
# Return codes:
#   0  artefact written (.status = "pass" or "fail")
#   1  no detectable runner; NO artefact written
#   2  infrastructure error, timeout, or write failure; artefact written
#      with .status in { "timeout" | "infrastructure_error" }
###############################################################################

# Guard against double-source.
[[ -n "${_DAEMON_RUN_TESTS_LOADED:-}" ]] && return 0
readonly _DAEMON_RUN_TESTS_LOADED=1

###############################################################################
# _daemon_emit_event <req_dir> <event_name> <json_payload>
#
# Appends one JSON line to <req_dir>/events.jsonl (mode 0600).
# Never aborts the caller (failures suppressed via || true at call sites).
###############################################################################
_daemon_emit_event() {
    local req_dir="$1" event_name="$2"
    local payload="${3}"
    [[ -z "${payload}" ]] && payload="{}"
    local events_file="${req_dir}/events.jsonl"
    local ts
    ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "1970-01-01T00:00:00Z")"
    local line
    line="$(jq -nc \
        --arg ts "${ts}" \
        --arg ev "${event_name}" \
        --arg rd "${req_dir}" \
        --argjson pay "${payload}" \
        '{ts:$ts, event:$ev, req_dir:$rd, payload:$pay}' 2>/dev/null || true)"
    if [[ -n "${line}" ]]; then
        printf '%s\n' "${line}" >> "${events_file}" 2>/dev/null || true
        chmod 0600 "${events_file}" 2>/dev/null || true
    fi
}

###############################################################################
# _daemon_detect_runner <project_root>
#
# Writes a one-line JSON object to stdout:
#   {"runner":"vitest","cmd_prefix":"npx vitest run","raw":"..."}
# Runner: vitest | jest | npm_script | none
# Always returns 0.
###############################################################################
_daemon_detect_runner() {
    local project_root="$1"

    # Priority 1: env override.
    local env_runner="${VERIFICATION_DAEMON_RERUN_RUNNER:-auto}"
    if [[ "${env_runner}" == "vitest" || "${env_runner}" == "jest" || "${env_runner}" == "npm_script" ]]; then
        jq -nc --arg r "${env_runner}" \
            '{runner:$r, cmd_prefix:"(env_override)", raw:"(env_override)"}' 2>/dev/null \
            || printf '{"runner":"%s","cmd_prefix":"(env_override)","raw":"(env_override)"}\n' "${env_runner}"
        return 0
    fi

    # Priority 2: no package.json.
    if [[ ! -f "${project_root}/package.json" ]]; then
        jq -nc '{runner:"none", reason:"no_package_json", cmd_prefix:"", raw:""}' 2>/dev/null \
            || printf '{"runner":"none","reason":"no_package_json","cmd_prefix":"","raw":""}\n'
        return 0
    fi

    # Priority 3: scripts.test in package.json.
    local scripts_test=""
    scripts_test="$(jq -r '.scripts.test // empty' "${project_root}/package.json" 2>/dev/null || true)"
    if [[ -n "${scripts_test}" ]]; then
        # Sub-classify the script text (case-insensitive substring, no eval).
        local sub_runner="unknown"
        local lower_script
        lower_script="$(printf '%s' "${scripts_test}" | tr '[:upper:]' '[:lower:]')"
        if printf '%s' "${lower_script}" | grep -qwE 'vitest'; then
            sub_runner="vitest"
        elif printf '%s' "${lower_script}" | grep -qwE 'jest'; then
            sub_runner="jest"
        fi
        jq -nc \
            --arg r "npm_script" \
            --arg sr "${sub_runner}" \
            --arg raw "${scripts_test}" \
            '{runner:$r, sub_runner:$sr, cmd_prefix:"npm test", raw:$raw}' 2>/dev/null \
            || printf '{"runner":"npm_script","sub_runner":"%s","cmd_prefix":"npm test","raw":"%s"}\n' "${sub_runner}" "${scripts_test}"
        return 0
    fi

    # Priority 4: node_modules/.bin/vitest.
    if [[ -x "${project_root}/node_modules/.bin/vitest" ]]; then
        jq -nc '{runner:"vitest", cmd_prefix:"npx vitest run", raw:"node_modules/.bin/vitest"}' 2>/dev/null \
            || printf '{"runner":"vitest","cmd_prefix":"npx vitest run","raw":"node_modules/.bin/vitest"}\n'
        return 0
    fi

    # Priority 5: node_modules/.bin/jest.
    if [[ -x "${project_root}/node_modules/.bin/jest" ]]; then
        jq -nc '{runner:"jest", cmd_prefix:"npx jest --ci", raw:"node_modules/.bin/jest"}' 2>/dev/null \
            || printf '{"runner":"jest","cmd_prefix":"npx jest --ci","raw":"node_modules/.bin/jest"}\n'
        return 0
    fi

    # Priority 6: nothing found.
    jq -nc '{runner:"none", reason:"no_runner_detected", cmd_prefix:"", raw:""}' 2>/dev/null \
        || printf '{"runner":"none","reason":"no_runner_detected","cmd_prefix":"","raw":""}\n'
    return 0
}

###############################################################################
# _daemon_parse_vitest_json PATH -> stdout: "tests=N passed=N failures=N errors=N skipped=N"
# Returns 0 on success, 1 on parse error.
###############################################################################
_daemon_parse_vitest_json() {
    local path="$1"
    [[ -f "${path}" ]] || return 1
    local total passed failed pending
    total="$(jq -r '.numTotalTests // empty' "${path}" 2>/dev/null || true)"
    passed="$(jq -r '.numPassedTests // empty' "${path}" 2>/dev/null || true)"
    failed="$(jq -r '.numFailedTests // empty' "${path}" 2>/dev/null || true)"
    pending="$(jq -r '.numPendingTests // empty' "${path}" 2>/dev/null || true)"
    [[ -n "${total}" && -n "${passed}" && -n "${failed}" ]] || return 1
    printf 'tests=%s passed=%s failures=%s errors=0 skipped=%s\n' \
        "${total}" "${passed}" "${failed}" "${pending:-0}"
    return 0
}

###############################################################################
# _daemon_parse_jest_json PATH -> stdout: "tests=N passed=N failures=N errors=N skipped=N"
# Jest --json uses same shape as vitest --reporter=json at the top level.
###############################################################################
_daemon_parse_jest_json() {
    _daemon_parse_vitest_json "$@"
}

###############################################################################
# _daemon_tail_parse TAIL_CONTENT -> stdout: "tests=N passed=N failures=N errors=N skipped=N"
# Returns 0 on match, 1 on no match (vacuous).
#
# Regex family literal-copied from artifact-proof.sh:_check_artifact_executor_tail.
###############################################################################
_daemon_tail_parse() {
    local tail_content="$1"

    # ET-1: Jest/Vitest — "Tests:  N passed, M failed"
    if printf '%s' "${tail_content}" | grep -qE 'Tests:[[:space:]]+[0-9]+[[:space:]]+passed'; then
        local passed_val=0 failed_val=0 total_val=0
        local et1_line
        et1_line="$(printf '%s' "${tail_content}" | grep -E 'Tests:[[:space:]]+[0-9]+[[:space:]]+passed' | tail -1)"
        passed_val="$(printf '%s' "${et1_line}" | grep -oE '[0-9]+[[:space:]]+passed' | grep -oE '^[0-9]+')" || passed_val=0
        failed_val="$(printf '%s' "${et1_line}" | grep -oE '[0-9]+[[:space:]]+failed' | grep -oE '^[0-9]+')" || failed_val=0
        [[ -z "${failed_val}" ]] && failed_val=0
        total_val=$(( passed_val + failed_val ))
        printf 'tests=%s passed=%s failures=%s errors=0 skipped=0\n' "${total_val}" "${passed_val}" "${failed_val}"
        return 0
    fi

    # ET-3: pytest — "N passed, M failed" or "N passed"
    if printf '%s' "${tail_content}" | grep -qE '[0-9]+[[:space:]]+passed,[[:space:]]*[0-9]+[[:space:]]+failed'; then
        local et3_line passed_val=0 failed_val=0
        et3_line="$(printf '%s' "${tail_content}" | grep -E '[0-9]+[[:space:]]+passed,[[:space:]]*[0-9]+[[:space:]]+failed' | tail -1)"
        passed_val="$(printf '%s' "${et3_line}" | grep -oE '[0-9]+[[:space:]]+passed' | grep -oE '^[0-9]+')" || passed_val=0
        failed_val="$(printf '%s' "${et3_line}" | grep -oE '[0-9]+[[:space:]]+failed' | grep -oE '^[0-9]+')" || failed_val=0
        [[ -z "${failed_val}" ]] && failed_val=0
        local total_val=$(( passed_val + failed_val ))
        printf 'tests=%s passed=%s failures=%s errors=0 skipped=0\n' "${total_val}" "${passed_val}" "${failed_val}"
        return 0
    fi
    if printf '%s' "${tail_content}" | grep -qE '[0-9]+[[:space:]]+passed(,|[[:space:]])'; then
        local et3b_line passed_val=0
        et3b_line="$(printf '%s' "${tail_content}" | grep -E '[0-9]+[[:space:]]+passed(,|[[:space:]])' | tail -1)"
        passed_val="$(printf '%s' "${et3b_line}" | grep -oE '^[[:space:]]*[0-9]+[[:space:]]+passed' | grep -oE '[0-9]+')" || passed_val=0
        printf 'tests=%s passed=%s failures=0 errors=0 skipped=0\n' "${passed_val}" "${passed_val}"
        return 0
    fi

    # ET-4: cargo test — "test result: ok. N passed"
    if printf '%s' "${tail_content}" | grep -qE 'test result: ok\.[[:space:]]+[0-9]+[[:space:]]+passed'; then
        local et4_line passed_val=0
        et4_line="$(printf '%s' "${tail_content}" | grep -E 'test result: ok\.' | tail -1)"
        passed_val="$(printf '%s' "${et4_line}" | grep -oE '[0-9]+[[:space:]]+passed' | grep -oE '^[0-9]+')" || passed_val=0
        printf 'tests=%s passed=%s failures=0 errors=0 skipped=0\n' "${passed_val}" "${passed_val}"
        return 0
    fi

    # ET-2: Mocha — "N passing"
    if printf '%s' "${tail_content}" | grep -qE '[0-9]+[[:space:]]+passing\b'; then
        local et2_line passed_val=0
        et2_line="$(printf '%s' "${tail_content}" | grep -E '[0-9]+[[:space:]]+passing' | tail -1)"
        passed_val="$(printf '%s' "${et2_line}" | grep -oE '[0-9]+[[:space:]]+passing' | grep -oE '^[0-9]+')" || passed_val=0
        printf 'tests=%s passed=%s failures=0 errors=0 skipped=0\n' "${passed_val}" "${passed_val}"
        return 0
    fi

    # No pattern matched → vacuous.
    return 1
}

###############################################################################
# _daemon_write_artifact REQ_DIR PROJECT_ROOT PHASE RUNNER DETECTED_CMD
#                         INVOKED_CMD EXIT_CODE DURATION_MS
#                         TESTS PASSED FAILURES ERRORS SKIPPED
#                         SOURCE STATUS OUTPUT_TAIL_PATH
#
# Writes <req_dir>/test-results.json (mode 0600).
# Returns 0 on success, 1 on write failure.
###############################################################################
_daemon_write_artifact() {
    local req_dir="$1" project_root="$2" phase="$3"
    local runner="$4" detected_cmd="$5" invoked_cmd="$6"
    local exit_code="$7" duration_ms="$8"
    local tests="$9" passed="${10}" failures="${11}" errors="${12}" skipped="${13}"
    local source_type="${14}" status="${15}" output_tail_path="${16}"

    local produced_at
    produced_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "1970-01-01T00:00:00Z")"

    local artifact_path="${req_dir}/test-results.json"
    local tmp_path="${artifact_path}.tmp.$$"

    jq -n \
        --argjson sv 1 \
        --arg phase "${phase}" \
        --arg pb "daemon_run_tests" \
        --arg pa "${produced_at}" \
        --arg runner "${runner}" \
        --arg detected_cmd "${detected_cmd}" \
        --arg invoked_cmd "${invoked_cmd}" \
        --arg cwd "${project_root}" \
        --argjson exit_code "${exit_code}" \
        --argjson duration_ms "${duration_ms}" \
        --arg source_type "${source_type}" \
        --argjson tests "${tests}" \
        --argjson passed "${passed}" \
        --argjson failures "${failures}" \
        --argjson errors "${errors}" \
        --argjson skipped "${skipped}" \
        --arg status "${status}" \
        --arg output_tail_path "${output_tail_path}" \
        '{
            schema_version: $sv,
            phase: $phase,
            produced_by: $pb,
            produced_at: $pa,
            phase_started_at: null,
            runner: $runner,
            detected_command: $detected_cmd,
            invoked_command: $invoked_cmd,
            cwd: $cwd,
            exit_code: $exit_code,
            duration_ms: $duration_ms,
            source: $source_type,
            tests: $tests,
            passed: $passed,
            failures: $failures,
            errors: $errors,
            skipped: $skipped,
            status: $status,
            output_tail_path: $output_tail_path
        }' 2>/dev/null > "${tmp_path}" || return 1

    mv "${tmp_path}" "${artifact_path}" 2>/dev/null || return 1
    chmod 0600 "${artifact_path}" 2>/dev/null || true
    return 0
}

###############################################################################
# daemon_run_tests <req_dir> <project_root> <phase>
#
# Public API. See file header for full contract.
###############################################################################
daemon_run_tests() {
    local req_dir="$1"
    local project_root="$2"
    local phase="${3:-integration}"

    # ── Kill-switch ────────────────────────────────────────────────────────────
    if [[ "${VERIFICATION_DAEMON_RERUN:-1}" != "1" ]]; then
        _daemon_emit_event "${req_dir}" "daemon_test_rerun_skipped_kill_switch" \
            "$(jq -nc --arg p "${phase}" '{phase:$p, reason:"kill_switch"}' 2>/dev/null || echo '{"reason":"kill_switch"}')" || true
        return 1
    fi

    # ── Precondition: req_dir must be a directory ──────────────────────────────
    [[ -d "${req_dir}" ]] || return 2
    [[ -d "${project_root}" ]] || return 2

    # ── Create output log dir ──────────────────────────────────────────────────
    local log_dir="${req_dir}/test-output"
    mkdir -p "${log_dir}" 2>/dev/null || true
    local tail_log="${log_dir}/daemon-rerun.raw"
    local artifact_path="${req_dir}/test-results.json"
    local output_tail_path="${tail_log}"

    # ── Detect runner ──────────────────────────────────────────────────────────
    local runner_info
    runner_info="$(_daemon_detect_runner "${project_root}")" || runner_info='{}'
    local runner sub_runner raw_cmd
    runner="$(printf '%s' "${runner_info}" | jq -r '.runner // "none"' 2>/dev/null || echo "none")"
    sub_runner="$(printf '%s' "${runner_info}" | jq -r '.sub_runner // ""' 2>/dev/null || echo "")"
    raw_cmd="$(printf '%s' "${runner_info}" | jq -r '.raw // ""' 2>/dev/null || echo "")"

    if [[ "${runner}" == "none" ]]; then
        local reason_field
        reason_field="$(printf '%s' "${runner_info}" | jq -r '.reason // "no_runner_detected"' 2>/dev/null || echo "no_runner_detected")"
        _daemon_emit_event "${req_dir}" "daemon_test_rerun_skipped_no_runner" \
            "$(jq -nc --arg p "${phase}" --arg r "${reason_field}" '{phase:$p, reason:$r}' 2>/dev/null || echo '{}')" || true
        return 1
    fi

    # ── Build invocation argv ──────────────────────────────────────────────────
    # argv-array form; never bash -c "$cmd".
    local -a inv=()
    local use_json_reporter=1
    local detected_cmd_display=""

    case "${runner}" in
        vitest)
            detected_cmd_display="${raw_cmd}"
            inv=( "npx" "vitest" "run" "--reporter=json" "--outputFile=${artifact_path}" )
            ;;
        jest)
            detected_cmd_display="${raw_cmd}"
            inv=( "npx" "jest" "--ci" "--json" "--outputFile=${artifact_path}" )
            ;;
        npm_script)
            detected_cmd_display="${raw_cmd}"
            case "${sub_runner}" in
                vitest)
                    inv=( "npm" "test" "--" "--reporter=json" "--outputFile=${artifact_path}" )
                    ;;
                jest)
                    inv=( "npm" "test" "--" "--json" "--outputFile=${artifact_path}" )
                    ;;
                *)
                    inv=( "npm" "test" )
                    use_json_reporter=0
                    ;;
            esac
            ;;
        *)
            # Unknown runner (from env override but not matched above)
            detected_cmd_display="${raw_cmd}"
            inv=( "npm" "test" )
            use_json_reporter=0
            ;;
    esac

    local invoked_cmd_display="${inv[*]}"

    # ── Resolve timeout ────────────────────────────────────────────────────────
    local timeout_s="${VERIFICATION_DAEMON_RERUN_TIMEOUT_S:-${VERIFICATION_REEXEC_TIMEOUT_S:-300}}"
    local timeout_bin=""
    if declare -F resolve_timeout_bin >/dev/null 2>&1; then
        timeout_bin="$(resolve_timeout_bin 2>/dev/null || true)"
    else
        timeout_bin="$(command -v gtimeout 2>/dev/null || command -v timeout 2>/dev/null || true)"
    fi

    if [[ -z "${timeout_bin}" ]]; then
        _daemon_emit_event "${req_dir}" "daemon_test_rerun_no_timeout_bin" \
            "$(jq -nc --arg p "${phase}" '{phase:$p}' 2>/dev/null || echo '{}')" || true
    fi

    # ── Emit started event ─────────────────────────────────────────────────────
    _daemon_emit_event "${req_dir}" "daemon_test_rerun_started" \
        "$(jq -nc \
            --arg p "${phase}" \
            --arg r "${runner}" \
            --arg ic "${invoked_cmd_display}" \
            '{phase:$p, runner:$r, invoked_command:$ic}' 2>/dev/null || echo '{}')" || true

    # ── Invoke test runner ─────────────────────────────────────────────────────
    local start_s end_s duration_ms rc=0

    # Strip node options that might inject debuggers.
    unset NODE_OPTIONS 2>/dev/null || true

    start_s="$(date +%s 2>/dev/null || echo 0)"

    # Remove stale artifact before run (so we can tell if reporter wrote it).
    rm -f "${artifact_path}" 2>/dev/null || true

    if [[ -n "${timeout_bin}" ]]; then
        ( cd "${project_root}" \
            && unset NODE_OPTIONS 2>/dev/null || true \
            && "${timeout_bin}" "${timeout_s}s" "${inv[@]}" ) \
            >> "${tail_log}" 2>&1 || rc=$?
    else
        ( cd "${project_root}" \
            && unset NODE_OPTIONS 2>/dev/null || true \
            && "${inv[@]}" ) \
            >> "${tail_log}" 2>&1 || rc=$?
    fi

    end_s="$(date +%s 2>/dev/null || echo 0)"
    duration_ms=$(( (end_s - start_s) * 1000 ))

    # ── Truncate tail log to 256 KiB ──────────────────────────────────────────
    if [[ -f "${tail_log}" ]]; then
        local fsize
        fsize="$(stat -f %z "${tail_log}" 2>/dev/null || stat -c %s "${tail_log}" 2>/dev/null || echo 0)"
        if [[ "${fsize}" -gt 262144 ]]; then
            local tmp_trunc
            tmp_trunc="$(mktemp 2>/dev/null || echo "${tail_log}.trunc.$$")"
            tail -c 262144 "${tail_log}" > "${tmp_trunc}" 2>/dev/null && mv "${tmp_trunc}" "${tail_log}" 2>/dev/null || true
        fi
        chmod 0600 "${tail_log}" 2>/dev/null || true
    fi

    # ── Handle timeout ─────────────────────────────────────────────────────────
    if [[ "${rc}" -eq 124 ]]; then
        _daemon_emit_event "${req_dir}" "daemon_test_rerun_timeout" \
            "$(jq -nc \
                --arg p "${phase}" \
                --argjson ts "${timeout_s}" \
                --argjson dm "${duration_ms}" \
                '{phase:$p, timeout_s:$ts, duration_ms:$dm}' 2>/dev/null || echo '{}')" || true

        _daemon_write_artifact \
            "${req_dir}" "${project_root}" "${phase}" \
            "${runner}" "${detected_cmd_display}" "${invoked_cmd_display}" \
            "124" "${duration_ms}" \
            "0" "0" "0" "0" "0" \
            "infrastructure_error" "timeout" "${output_tail_path}" || true

        _daemon_emit_event "${req_dir}" "daemon_test_rerun_completed" \
            "$(jq -nc \
                --arg p "${phase}" \
                --arg r "${runner}" \
                --arg s "timeout" \
                --argjson f 0 \
                --argjson dm "${duration_ms}" \
                '{phase:$p, runner:$r, status:$s, failures:$f, duration_ms:$dm}' 2>/dev/null || echo '{}')" || true
        return 2
    fi

    # ── Parse results ──────────────────────────────────────────────────────────
    local tests=0 passed=0 failures=0 errors=0 skipped=0
    local source_type="tail_parsed"
    local status=""

    # Try native JSON reporter output first.
    if [[ "${use_json_reporter}" -eq 1 && -f "${artifact_path}" ]]; then
        local parsed_counts=""
        case "${runner}${sub_runner}" in
            vitest*|npm_scriptvitest|jest*|npm_scriptjest)
                parsed_counts="$(_daemon_parse_vitest_json "${artifact_path}" 2>/dev/null || true)"
                ;;
        esac

        if [[ -n "${parsed_counts}" ]]; then
            source_type="native_json"
            # shellcheck disable=SC2034
            eval "${parsed_counts}" 2>/dev/null || true
            # Variables tests, passed, failures, errors, skipped are set by eval.
            # Determine status per spec §2.1.1.
            if [[ "${rc}" -eq 124 ]]; then
                status="timeout"
            elif [[ "${failures}" -gt 0 ]]; then
                status="fail"
            elif [[ "${rc}" -ne 0 && "${source_type}" == "native_json" ]]; then
                # Trust the reporter when source=native_json and failures=0 (TDD §6).
                status="pass"
            else
                status="pass"
            fi
        fi
    fi

    # Fall back to tail-parse if JSON parse failed or reporter not used.
    if [[ "${source_type}" == "tail_parsed" ]]; then
        local tail_content=""
        if [[ -f "${tail_log}" ]]; then
            tail_content="$(tail -n 200 "${tail_log}" 2>/dev/null || true)"
        fi

        local parsed_counts=""
        parsed_counts="$(_daemon_tail_parse "${tail_content}" 2>/dev/null || true)"

        if [[ -n "${parsed_counts}" ]]; then
            eval "${parsed_counts}" 2>/dev/null || true
        else
            # Vacuous pass — no pattern matched.
            tests=0; passed=0; failures=0; errors=0; skipped=0
            _daemon_emit_event "${req_dir}" "daemon_test_rerun_no_tests_collected" \
                "$(jq -nc \
                    --arg p "${phase}" \
                    --arg r "${runner}" \
                    --arg raw "${raw_cmd:0:200}" \
                    '{phase:$p, runner:$r, raw:$raw}' 2>/dev/null || echo '{}')" || true
        fi

        # Status derivation for tail_parsed per spec §2.1.1.
        if [[ "${rc}" -eq 124 ]]; then
            status="timeout"
        elif [[ "${failures}" -gt 0 ]]; then
            status="fail"
        elif [[ "${rc}" -ne 0 ]]; then
            # tail_parsed + nonzero exit + failures=0 → fail (spec §2.1.1)
            status="fail"
            failures=1
        else
            status="pass"
        fi
    fi

    # ── Write normalised artifact ──────────────────────────────────────────────
    if ! _daemon_write_artifact \
        "${req_dir}" "${project_root}" "${phase}" \
        "${runner}" "${detected_cmd_display}" "${invoked_cmd_display}" \
        "${rc}" "${duration_ms}" \
        "${tests}" "${passed}" "${failures}" "${errors}" "${skipped}" \
        "${source_type}" "${status}" "${output_tail_path}"; then

        _daemon_emit_event "${req_dir}" "daemon_test_rerun_write_failed" \
            "$(jq -nc \
                --arg p "${phase}" \
                --arg ap "${artifact_path}" \
                '{phase:$p, artefact_path:$ap}' 2>/dev/null || echo '{}')" || true
        return 2
    fi

    # ── Emit completed event ───────────────────────────────────────────────────
    _daemon_emit_event "${req_dir}" "daemon_test_rerun_completed" \
        "$(jq -nc \
            --arg p "${phase}" \
            --arg r "${runner}" \
            --arg s "${status}" \
            --argjson f "${failures}" \
            --argjson dm "${duration_ms}" \
            '{phase:$p, runner:$r, status:$s, failures:$f, duration_ms:$dm}' 2>/dev/null || echo '{}')" || true

    return 0
}
