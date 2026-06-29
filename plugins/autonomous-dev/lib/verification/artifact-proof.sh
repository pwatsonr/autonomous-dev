#!/usr/bin/env bash
###############################################################################
# artifact-proof.sh — Artifact-as-proof fallback for the Phase C verifier.
#
# REQ-000052 / Issue #617. See:
#   docs/tdd/REQ-000052-req-000052.md
#   docs/plans/REQ-000052-req-000052.md
#   docs/specs/REQ-000052-req-000052.md
#
# Public:
#   verification_artifact_proof_for REQ_DIR CLAIM_JSON PHASE -> stdout | exit 1
#
# Internal (exported for unit testing only):
#   _artifact_candidate_paths REQ_DIR PHASE
#   _artifact_kind_for_path PATH
#   _artifact_ecosystem_for_command COMMAND
#   _artifact_kind_matches_ecosystem KIND ECOSYSTEM
#   _artifact_is_fresh PATH REQ_DIR
#   _check_artifact_junit PATH
#   _check_artifact_lcov PATH
#   _check_artifact_istanbul_json PATH
#   _check_artifact_cobertura_xml PATH
#   _check_artifact_vitest_json PATH
#   _check_artifact_jest_json PATH
#   _check_artifact_executor_tail PATH
#   _artifact_stat_mtime PATH                # cross-platform helper
###############################################################################

if [[ -n "${__ARTIFACT_PROOF_SH_SOURCED__:-}" ]]; then
    return 0 2>/dev/null || exit 0
fi
__ARTIFACT_PROOF_SH_SOURCED__=1

: "${VERIFICATION_ARTIFACT_FALLBACK:=1}"
: "${VERIFICATION_ARTIFACT_MAX_DEPTH:=6}"
: "${VERIFICATION_ARTIFACT_MAX_FILES:=200}"
: "${VERIFICATION_ARTIFACT_MAX_SIZE_MB:=5}"
: "${VERIFICATION_ARTIFACT_FRESHNESS_REQUIRED:=1}"

###############################################################################
# _artifact_stat_mtime PATH
#
# Emit the mtime as decimal epoch seconds on stdout.
# Returns 0 on success, 1 on failure.
###############################################################################
_artifact_stat_mtime() {
    local path="$1"
    local mtime
    # Try GNU stat first.
    mtime="$(stat -c %Y "${path}" 2>/dev/null)" && {
        printf '%s\n' "${mtime}"
        return 0
    }
    # Fall back to BSD/macOS stat.
    mtime="$(stat -f %m "${path}" 2>/dev/null)" && {
        printf '%s\n' "${mtime}"
        return 0
    }
    return 1
}

###############################################################################
# _artifact_kind_for_path PATH
#
# Emit the internal kind string (or empty) for PATH based on filename heuristics.
###############################################################################
_artifact_kind_for_path() {
    local path="$1"
    local base
    base="$(basename "${path}")"

    # lcov
    if [[ "${base}" == "lcov.info" ]]; then
        printf 'lcov\n'; return 0
    fi
    # istanbul
    if [[ "${base}" == "coverage-final.json" ]]; then
        printf 'istanbul\n'; return 0
    fi
    # cobertura
    if [[ "${base}" == "coverage.xml" || "${base}" =~ ^cobertura.*\.xml$ ]]; then
        printf 'cobertura\n'; return 0
    fi
    # vitest
    if [[ "${base}" =~ ^vitest.*results.*\.json$ ]]; then
        printf 'vitest\n'; return 0
    fi
    # jest
    if [[ "${base}" =~ ^jest.*results.*\.json$ ]]; then
        printf 'jest\n'; return 0
    fi
    # junit — by name or by directory
    if [[ "${base}" =~ ^junit.*\.xml$ || "${base}" =~ ^TEST-.*\.xml$ ]]; then
        printf 'junit\n'; return 0
    fi
    if [[ "${path}" =~ /surefire-reports/ || "${path}" =~ /test-results/ ]]; then
        printf 'junit\n'; return 0
    fi
    # executor tail log
    if [[ "${base}" =~ \.log$ ]]; then
        printf 'executor_tail\n'; return 0
    fi
    printf ''; return 0
}

###############################################################################
# _artifact_ecosystem_for_command COMMAND
#
# Emit the ecosystem string (js|python|rust|go|jvm|generic|"").
###############################################################################
_artifact_ecosystem_for_command() {
    local cmd="$1"
    # Strip leading env-var prefixes and timing prefixes.
    local stripped="${cmd}"
    while [[ "${stripped}" =~ ^([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)(.*)$ ]]; do
        stripped="${BASH_REMATCH[2]}"
    done
    # Strip "time " / "env " leading tokens.
    while [[ "${stripped}" =~ ^(time|env)[[:space:]]+(.*)$ ]]; do
        stripped="${BASH_REMATCH[2]}"
    done
    local first_token
    first_token="$(printf '%s' "${stripped}" | awk '{print $1}')"

    case "${first_token}" in
        bun|npm|pnpm|yarn|npx|node|vitest|jest|mocha|cypress|playwright)
            printf 'js\n'; return 0 ;;
        pytest|python|python3)
            printf 'python\n'; return 0 ;;
        cargo)
            printf 'rust\n'; return 0 ;;
        go)
            printf 'go\n'; return 0 ;;
        gradle|gradlew|./gradlew|mvn|mvnw|./mvnw)
            printf 'jvm\n'; return 0 ;;
        make|bash|sh|./run|just)
            printf 'generic\n'; return 0 ;;
        "")
            printf ''; return 0 ;;
        *)
            printf ''; return 0 ;;
    esac
}

###############################################################################
# _artifact_kind_matches_ecosystem KIND ECOSYSTEM
#
# Returns 0 if the pair is in the allow-table, 1 otherwise.
###############################################################################
_artifact_kind_matches_ecosystem() {
    local kind="$1" ecosystem="$2"
    case "${ecosystem}" in
        js)
            case "${kind}" in
                junit|vitest|jest|istanbul|lcov|executor_tail) return 0 ;;
                *) return 1 ;;
            esac
            ;;
        python)
            case "${kind}" in
                junit|cobertura|executor_tail) return 0 ;;
                *) return 1 ;;
            esac
            ;;
        rust)
            case "${kind}" in
                junit|cobertura|executor_tail) return 0 ;;
                *) return 1 ;;
            esac
            ;;
        go)
            case "${kind}" in
                cobertura|executor_tail) return 0 ;;
                *) return 1 ;;
            esac
            ;;
        jvm)
            case "${kind}" in
                junit|cobertura|executor_tail) return 0 ;;
                *) return 1 ;;
            esac
            ;;
        generic)
            case "${kind}" in
                junit|vitest|jest|istanbul|lcov|cobertura|executor_tail) return 0 ;;
                *) return 1 ;;
            esac
            ;;
        "")
            return 1 ;;
        *)
            return 1 ;;
    esac
}

###############################################################################
# _artifact_is_fresh PATH REQ_DIR
#
# Returns 0 if the artifact's mtime >= dispatched_at epoch, 1 otherwise.
###############################################################################
_artifact_is_fresh() {
    local path="$1" req_dir="$2"

    # Freshness gate can be disabled.
    if [[ "${VERIFICATION_ARTIFACT_FRESHNESS_REQUIRED:-1}" == "0" ]]; then
        return 0
    fi

    # Read dispatched_at from state.json.
    local state_json="${req_dir}/state.json"
    local dispatched_at=""
    if [[ -r "${state_json}" ]]; then
        dispatched_at="$(jq -r '.current_phase_metadata.dispatched_at // .updated_at // empty' \
            "${state_json}" 2>/dev/null || true)"
    fi

    # If we can't read a timestamp, degrade permissively.
    if [[ -z "${dispatched_at}" ]]; then
        return 0
    fi

    # Convert dispatched_at to epoch seconds.
    # Use jq --arg to pass the string as a JSON string (not piped raw text).
    local dispatched_epoch=""
    dispatched_epoch="$(jq -rn --arg ts "${dispatched_at}" \
        '$ts | sub("\\.[0-9]+Z$";"Z") | fromdateiso8601 | floor' 2>/dev/null || true)"
    if [[ -z "${dispatched_epoch}" ]]; then
        # GNU date fallback.
        dispatched_epoch="$(date -u -d "${dispatched_at}" +%s 2>/dev/null || true)"
    fi
    if [[ -z "${dispatched_epoch}" ]]; then
        # BSD/macOS date fallback — must use -u for UTC, strip the trailing Z.
        local ts_clean="${dispatched_at%.*}"  # strip .mmm if present
        ts_clean="${ts_clean%Z}"             # strip trailing Z
        ts_clean="${ts_clean/T/ }"          # replace T with space
        dispatched_epoch="$(date -u -j -f "%Y-%m-%d %H:%M:%S" "${ts_clean}" +%s 2>/dev/null || true)"
    fi

    # If conversion failed, degrade permissively.
    if [[ -z "${dispatched_epoch}" ]]; then
        return 0
    fi

    # Read the artifact's mtime.
    local artifact_mtime
    artifact_mtime="$(_artifact_stat_mtime "${path}")" || return 1

    if [[ "${artifact_mtime}" -ge "${dispatched_epoch}" ]]; then
        return 0
    fi
    return 1
}

###############################################################################
# _artifact_candidate_paths REQ_DIR PHASE
#
# Emit zero or more absolute paths (one per line), deduplicated, in two groups:
#   1. Paths from phase-result-${PHASE}.json .artifacts[] with recognised kinds
#   2. Well-known on-disk paths under PROJECT_ROOT
###############################################################################
_artifact_candidate_paths() {
    local req_dir="$1" phase="$2"

    if [[ ! -d "${req_dir}" ]]; then
        return 1
    fi

    # Determine PROJECT_ROOT (three levels up from req_dir).
    local project_root=""
    project_root="$(cd "${req_dir}/../../.." 2>/dev/null && pwd -P 2>/dev/null)" || true
    if [[ -z "${project_root}" ]]; then
        # Try realpath alternative
        project_root="$(cd "${req_dir}" && cd ../../.. && pwd)" 2>/dev/null || true
    fi

    # Recognised kind map (phase-result artifacts[].kind -> internal kind).
    # We emit these first (priority 1).
    local phase_result="${req_dir}/phase-result-${phase}.json"
    local seen_paths=""
    if [[ -f "${phase_result}" ]]; then
        local art_count i art_kind art_path int_kind
        art_count="$(jq '(.artifacts // []) | length' "${phase_result}" 2>/dev/null || echo 0)"
        for ((i = 0; i < art_count; i++)); do
            art_kind="$(jq -r ".artifacts[${i}].kind // \"\"" "${phase_result}" 2>/dev/null || true)"
            art_path="$(jq -r ".artifacts[${i}].path // \"\"" "${phase_result}" 2>/dev/null || true)"
            # Map kind to internal kind
            case "${art_kind}" in
                test-results-junit)   int_kind="junit" ;;
                test-results-vitest)  int_kind="vitest" ;;
                test-results-jest)    int_kind="jest" ;;
                coverage-lcov)        int_kind="lcov" ;;
                coverage-istanbul)    int_kind="istanbul" ;;
                coverage-cobertura)   int_kind="cobertura" ;;
                executor-tail)        int_kind="executor_tail" ;;
                *)                    int_kind="" ;;
            esac
            if [[ -z "${int_kind}" || -z "${art_path}" ]]; then
                continue
            fi
            # Resolve to absolute path if needed.
            if [[ "${art_path}" != /* ]]; then
                art_path="${project_root}/${art_path}"
            fi
            # Verify it exists as a file.
            if [[ -f "${art_path}" ]]; then
                # Deduplicate.
                if [[ "${seen_paths}" != *"|${art_path}|"* ]]; then
                    seen_paths="${seen_paths}|${art_path}|"
                    printf '%s\n' "${art_path}"
                fi
            fi
        done
    fi

    # Well-known on-disk paths (priority 2).
    if [[ -n "${project_root}" && -d "${project_root}" ]]; then
        local max_depth="${VERIFICATION_ARTIFACT_MAX_DEPTH:-6}"
        local found_paths=""
        if command -v find >/dev/null 2>&1; then
            # Use find with well-known name patterns.
            found_paths="$(find "${project_root}" \
                -maxdepth "${max_depth}" \
                \( \
                    -name 'junit*.xml' -o \
                    -name 'TEST-*.xml' -o \
                    -name 'lcov.info' -o \
                    -name 'coverage-final.json' -o \
                    -name 'coverage.xml' -o \
                    -name 'cobertura.xml' -o \
                    -name 'cobertura-coverage.xml' -o \
                    -name '.vitest-results.json' -o \
                    -name 'vitest-results.json' -o \
                    -name 'jest-results.json' \
                \) -type f 2>/dev/null | head -n "${VERIFICATION_ARTIFACT_MAX_FILES:-200}" || true)"
        else
            # find not available — check fixed literal paths.
            local literal_paths=(
                "${project_root}/junit.xml"
                "${project_root}/coverage/lcov.info"
                "${project_root}/lcov.info"
                "${project_root}/coverage/coverage-final.json"
                "${project_root}/coverage.xml"
                "${project_root}/cobertura.xml"
                "${project_root}/vitest-results.json"
                "${project_root}/jest-results.json"
            )
            local lp
            for lp in "${literal_paths[@]}"; do
                [[ -f "${lp}" ]] && found_paths="${found_paths}"$'\n'"${lp}"
            done
        fi

        # Also check req_dir/test-output/*.log for executor_tail.
        local log_path
        for log_path in "${req_dir}/test-output/"*.log; do
            [[ -f "${log_path}" ]] && found_paths="${found_paths}"$'\n'"${log_path}"
        done

        # Emit found paths that are inside project_root (security check).
        local p
        while IFS= read -r p; do
            [[ -z "${p}" ]] && continue
            # Resolve to real absolute path.
            local rp
            rp="$(cd "$(dirname "${p}")" 2>/dev/null && pwd -P 2>/dev/null)/${p##*/}" || rp="${p}"
            # Must be under project_root.
            if [[ "${rp}" != "${project_root}/"* && "${rp}" != "${req_dir}/"* ]]; then
                continue
            fi
            if [[ ! -f "${rp}" ]]; then
                continue
            fi
            # Deduplicate.
            if [[ "${seen_paths}" != *"|${rp}|"* ]]; then
                seen_paths="${seen_paths}|${rp}|"
                printf '%s\n' "${rp}"
            fi
        done <<< "${found_paths}"
    fi

    return 0
}

###############################################################################
# _check_artifact_junit PATH
###############################################################################
_check_artifact_junit() {
    local path="$1"
    [[ -r "${path}" && -f "${path}" ]] || return 1

    # Size check.
    local max_bytes=$(( ${VERIFICATION_ARTIFACT_MAX_SIZE_MB:-5} * 1024 * 1024 ))
    local fsize
    fsize="$(stat -c %s "${path}" 2>/dev/null || stat -f %z "${path}" 2>/dev/null || echo 0)"
    if [[ "${fsize}" -gt "${max_bytes}" ]]; then
        return 1
    fi

    # Check root element within the first 4096 bytes.
    local head_content
    head_content="$(head -c 4096 "${path}" 2>/dev/null || true)"
    if ! printf '%s' "${head_content}" | grep -qE '<testsuite[s]?[[:space:]>]'; then
        return 1
    fi

    # Verify at least one testcase element (use timeout to prevent hangs).
    if ! timeout 5 grep -q -E '<testcase[[:space:]/>]' "${path}" 2>/dev/null; then
        return 1
    fi

    # Extract attributes.
    local tests_val failures_val errors_val
    tests_val="$(grep -oE 'tests="[0-9]+"' "${path}" 2>/dev/null | head -1 | grep -oE '[0-9]+' || true)"
    failures_val="$(grep -oE 'failures="[0-9]+"' "${path}" 2>/dev/null | head -1 | grep -oE '[0-9]+' || true)"
    errors_val="$(grep -oE 'errors="[0-9]+"' "${path}" 2>/dev/null | head -1 | grep -oE '[0-9]+' || true)"

    if [[ -n "${tests_val}" && "${tests_val}" -ge 1 ]]; then
        printf 'tests=%s\n' "${tests_val}"
    fi
    if [[ -n "${failures_val}" ]]; then
        printf 'failures=%s\n' "${failures_val}"
    fi
    if [[ -n "${errors_val}" ]]; then
        printf 'errors=%s\n' "${errors_val}"
    fi
    return 0
}

###############################################################################
# _check_artifact_lcov PATH
###############################################################################
_check_artifact_lcov() {
    local path="$1"
    [[ -r "${path}" && -f "${path}" ]] || return 1

    local max_bytes=$(( ${VERIFICATION_ARTIFACT_MAX_SIZE_MB:-5} * 1024 * 1024 ))
    local fsize
    fsize="$(stat -c %s "${path}" 2>/dev/null || stat -f %z "${path}" 2>/dev/null || echo 0)"
    if [[ "${fsize}" -gt "${max_bytes}" ]]; then
        return 1
    fi

    if ! timeout 5 grep -q '^SF:' "${path}" 2>/dev/null; then
        return 1
    fi
    if ! timeout 5 grep -q '^DA:' "${path}" 2>/dev/null; then
        return 1
    fi
    return 0
}

###############################################################################
# _check_artifact_istanbul_json PATH
###############################################################################
_check_artifact_istanbul_json() {
    local path="$1"
    [[ -r "${path}" && -f "${path}" ]] || return 1

    local max_bytes=$(( ${VERIFICATION_ARTIFACT_MAX_SIZE_MB:-5} * 1024 * 1024 ))
    local fsize
    fsize="$(stat -c %s "${path}" 2>/dev/null || stat -f %z "${path}" 2>/dev/null || echo 0)"
    if [[ "${fsize}" -gt "${max_bytes}" ]]; then
        return 1
    fi

    if ! timeout 5 jq -e 'type == "object" and (to_entries | map(.value | (has("path") and has("statementMap"))) | any)' \
            "${path}" >/dev/null 2>&1; then
        return 1
    fi
    return 0
}

###############################################################################
# _check_artifact_cobertura_xml PATH
###############################################################################
_check_artifact_cobertura_xml() {
    local path="$1"
    [[ -r "${path}" && -f "${path}" ]] || return 1

    local max_bytes=$(( ${VERIFICATION_ARTIFACT_MAX_SIZE_MB:-5} * 1024 * 1024 ))
    local fsize
    fsize="$(stat -c %s "${path}" 2>/dev/null || stat -f %z "${path}" 2>/dev/null || echo 0)"
    if [[ "${fsize}" -gt "${max_bytes}" ]]; then
        return 1
    fi

    local head_content
    head_content="$(head -c 4096 "${path}" 2>/dev/null || true)"
    if ! printf '%s' "${head_content}" | grep -qE '<coverage[[:space:]>]'; then
        return 1
    fi
    if ! timeout 5 grep -qE '<coverage [^>]*(lines-covered|line-rate)=' "${path}" 2>/dev/null; then
        return 1
    fi
    return 0
}

###############################################################################
# _check_artifact_vitest_json PATH
###############################################################################
_check_artifact_vitest_json() {
    local path="$1"
    [[ -r "${path}" && -f "${path}" ]] || return 1

    local max_bytes=$(( ${VERIFICATION_ARTIFACT_MAX_SIZE_MB:-5} * 1024 * 1024 ))
    local fsize
    fsize="$(stat -c %s "${path}" 2>/dev/null || stat -f %z "${path}" 2>/dev/null || echo 0)"
    if [[ "${fsize}" -gt "${max_bytes}" ]]; then
        return 1
    fi

    if ! timeout 5 jq -e '(.numTotalTests // 0) >= 1 and (.numTotalTestSuites // 0) >= 1' \
            "${path}" >/dev/null 2>&1; then
        return 1
    fi

    local tests_val failures_val
    tests_val="$(jq -r '.numTotalTests // empty' "${path}" 2>/dev/null || true)"
    failures_val="$(jq -r '.numFailedTests // empty' "${path}" 2>/dev/null || true)"
    [[ -n "${tests_val}" ]] && printf 'tests=%s\n' "${tests_val}"
    [[ -n "${failures_val}" ]] && printf 'failures=%s\n' "${failures_val}"
    return 0
}

###############################################################################
# _check_artifact_jest_json PATH
# Identical to vitest.
###############################################################################
_check_artifact_jest_json() {
    _check_artifact_vitest_json "$@"
}

###############################################################################
# _check_artifact_executor_tail PATH
#
# Validate an executor log tail against the ET regex set.
###############################################################################
_check_artifact_executor_tail() {
    local path="$1"
    [[ -r "${path}" && -f "${path}" ]] || return 1

    local max_bytes=$(( ${VERIFICATION_ARTIFACT_MAX_SIZE_MB:-5} * 1024 * 1024 ))
    local fsize
    fsize="$(stat -c %s "${path}" 2>/dev/null || stat -f %z "${path}" 2>/dev/null || echo 0)"
    if [[ "${fsize}" -gt "${max_bytes}" ]]; then
        return 1
    fi

    local tail_content
    tail_content="$(tail -n 200 "${path}" 2>/dev/null || true)"
    if [[ -z "${tail_content}" ]]; then
        return 1
    fi

    # ET-1: Jest/Vitest
    if printf '%s' "${tail_content}" | grep -qE 'Tests:[[:space:]]+[0-9]+[[:space:]]+passed'; then
        return 0
    fi
    # ET-2: Mocha
    if printf '%s' "${tail_content}" | grep -qE '[0-9]+[[:space:]]+passing\b'; then
        return 0
    fi
    # ET-3: pytest
    if printf '%s' "${tail_content}" | grep -qE '[0-9]+[[:space:]]+passed,[[:space:]]*[0-9]+[[:space:]]+failed'; then
        return 0
    fi
    # Also accept the common pytest format "N passed" without the "failed" part
    if printf '%s' "${tail_content}" | grep -qE '[0-9]+[[:space:]]+passed(,|[[:space:]])'; then
        return 0
    fi
    # ET-4: cargo test
    if printf '%s' "${tail_content}" | grep -qE 'test result: ok\.[[:space:]]+[0-9]+[[:space:]]+passed'; then
        return 0
    fi
    # ET-5: bats/TAP — requires BOTH the ok line AND a plan line
    if printf '%s' "${tail_content}" | grep -qE 'ok[[:space:]]+[0-9]+ - ' && \
       printf '%s' "${tail_content}" | grep -qE '1\.\.[0-9]+'; then
        return 0
    fi
    # ET-6: Go test — requires >= 3 "^PASS " lines
    local go_pass_count
    go_pass_count="$(printf '%s' "${tail_content}" | grep -cE '^PASS[[:space:]]' 2>/dev/null || echo 0)"
    if [[ "${go_pass_count}" -ge 3 ]]; then
        return 0
    fi
    # ET-7: Maven
    if printf '%s' "${tail_content}" | grep -qE '^BUILD SUCCESS\b'; then
        return 0
    fi
    # ET-8: Gradle
    if printf '%s' "${tail_content}" | grep -qE 'BUILD SUCCESSFUL in [0-9]+s'; then
        return 0
    fi
    # ET-9: generic
    if printf '%s' "${tail_content}" | grep -qE '[0-9]+[[:space:]]+tests?[[:space:]]+complete[d]?'; then
        return 0
    fi

    return 1
}

###############################################################################
# _dispatch_validator KIND PATH -> stdout extras | return 0|1
###############################################################################
_dispatch_validator() {
    local kind="$1" path="$2"
    case "${kind}" in
        junit)         _check_artifact_junit         "${path}" ;;
        lcov)          _check_artifact_lcov          "${path}" ;;
        istanbul)      _check_artifact_istanbul_json "${path}" ;;
        cobertura)     _check_artifact_cobertura_xml "${path}" ;;
        vitest)        _check_artifact_vitest_json   "${path}" ;;
        jest)          _check_artifact_jest_json     "${path}" ;;
        executor_tail) _check_artifact_executor_tail "${path}" ;;
        *)             return 1 ;;
    esac
}

###############################################################################
# verification_artifact_proof_for REQ_DIR CLAIM_JSON PHASE
#
# Main public function. Returns 0 and emits a proof descriptor on stdout
# when a valid artifact is found. Returns 1 with no output when not found.
###############################################################################
verification_artifact_proof_for() {
    local req_dir="$1" claim_json="$2" phase="$3"

    # Kill switch.
    if [[ "${VERIFICATION_ARTIFACT_FALLBACK:-1}" == "0" ]]; then
        return 1
    fi

    # Validate req_dir.
    if [[ ! -d "${req_dir}" ]]; then
        return 1
    fi

    # Extract the command from the claim JSON.
    local cmd
    cmd="$(printf '%s' "${claim_json}" | jq -r '.command // ""' 2>/dev/null || true)"

    # Determine ecosystem for the command.
    local ecosystem
    ecosystem="$(_artifact_ecosystem_for_command "${cmd}")"
    if [[ -z "${ecosystem}" ]]; then
        return 1
    fi

    # Collect candidate paths.
    local candidates
    candidates="$(_artifact_candidate_paths "${req_dir}" "${phase}")" || return 1

    # Set a deadline: we must finish within 5 seconds.
    local deadline=$(( $(date +%s 2>/dev/null || echo 0) + 5 ))

    # Iterate candidates.
    local cand_path cand_kind
    while IFS= read -r cand_path; do
        [[ -z "${cand_path}" ]] && continue

        # Check wall-clock deadline.
        local now
        now=$(date +%s 2>/dev/null || echo 0)
        if [[ "${now}" -gt "${deadline}" ]]; then
            return 1
        fi

        # Determine kind for this path.
        cand_kind="$(_artifact_kind_for_path "${cand_path}")"
        if [[ -z "${cand_kind}" ]]; then
            continue
        fi

        # Check ecosystem match.
        if ! _artifact_kind_matches_ecosystem "${cand_kind}" "${ecosystem}"; then
            continue
        fi

        # Freshness check.
        if ! _artifact_is_fresh "${cand_path}" "${req_dir}"; then
            continue
        fi

        # Validate content.
        local extras
        extras="$(_dispatch_validator "${cand_kind}" "${cand_path}")" || continue

        # All checks passed — emit proof descriptor.
        local abs_path
        abs_path="$(cd "$(dirname "${cand_path}")" 2>/dev/null && pwd -P)/${cand_path##*/}"
        local descriptor="${cand_kind}:${abs_path}"
        local extra_line
        while IFS= read -r extra_line; do
            [[ -z "${extra_line}" ]] && continue
            descriptor="${descriptor}|${extra_line}"
        done <<< "${extras}"

        # Add mtime to descriptor.
        local mtime_epoch
        mtime_epoch="$(_artifact_stat_mtime "${abs_path}")" || true
        if [[ -n "${mtime_epoch}" ]]; then
            descriptor="${descriptor}|mtime=${mtime_epoch}"
        fi

        printf '%s\n' "${descriptor}"
        return 0
    done <<< "${candidates}"

    return 1
}
