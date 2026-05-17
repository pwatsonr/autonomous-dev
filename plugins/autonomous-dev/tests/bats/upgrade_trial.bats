#!/usr/bin/env bats
###############################################################################
# upgrade_trial.bats — Phase 3 marketplace auto-update tests.
#
# Phase 3 adds the trial-flag mechanism that lets a freshly-upgraded
# daemon prove itself before the upgrade is committed. The three
# behaviors under test:
#
#   • Startup with no flag → no-op
#   • Startup with active trial (deadline in future) → probation
#     (UPGRADE_TRIAL_PENDING=true)
#   • Probation clear: after N healthy iterations, the flag is removed
#     and UPGRADE_TRIAL_PENDING flips to false
#
# Rollback (deadline passed → spawn old-version installer + exit) is
# exercised end-to-end manually; here we just confirm the bookkeeping
# under the happy path and the no-op path.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    TMP_HOME="$(mktemp -d -t advtrial)"
    export HOME="${TMP_HOME}"
    export DAEMON_HOME="${TMP_HOME}/.autonomous-dev"
    mkdir -p "${DAEMON_HOME}/logs"
    UPGRADE_TRIAL_FLAG="${DAEMON_HOME}/.upgrade-trial-pending"
    LAST_GOOD_VERSION_FILE="${DAEMON_HOME}/.last-good-version"
    LOG_DIR="${DAEMON_HOME}/logs"
    UPGRADE_TRIAL_PROBATION_ITERATIONS=5
    UPGRADE_TRIAL_PENDING=false
    SHUTDOWN_REQUESTED=false
    ITERATION_COUNT=0
    LIB_DIR="${PLUGIN_DIR}/bin/lib"
    log_info() { :; }
    log_warn() { :; }
    extract_fn() {
        local fn_name="$1"
        local src="${PLUGIN_DIR}/bin/supervisor-loop.sh"
        awk -v fn="${fn_name}" '
            $0 ~ "^"fn"\\(\\) \\{" { in_fn = 1; print; next }
            in_fn { print }
            in_fn && $0 ~ "^\\}$" { in_fn = 0 }
        ' "${src}"
    }
    eval "$(extract_fn check_upgrade_trial)"
    eval "$(extract_fn clear_upgrade_trial_if_probation_passed)"
    # Stub current_version so the trial check doesn't depend on the
    # actual BASH_SOURCE path. The supervisor-loop functions source
    # version-helpers.sh internally, but we'll override after that
    # source completes by redefining current_version per test.
    SOURCED_VERSION_HELPERS=""
}

teardown() {
    rm -rf "${TMP_HOME}"
}

write_trial_flag() {
    local target="$1"
    local deadline="$2"
    jq -n --arg target "${target}" --arg from "0.1.0" \
        --argjson started 100 --argjson deadline "${deadline}" \
        '{target: $target, from: $from, started: $started, deadline: $deadline}' \
        > "${UPGRADE_TRIAL_FLAG}"
}

# Stub current_version so the trial check evaluates `target == my_version`
# without poking BASH_SOURCE. Sourced version-helpers.sh from inside
# check_upgrade_trial will define current_version; we shadow it after.
call_check_with_my_version() {
    local my_version="$1"
    # Make the function think this is the running version by sourcing
    # the helpers first then overriding current_version, then calling.
    # shellcheck disable=SC1091
    source "${LIB_DIR}/version-helpers.sh"
    eval "current_version() { echo '${my_version}'; }"
    # Now invoke. check_upgrade_trial re-sources version-helpers.sh —
    # which would clobber our override. Inline the relevant bits by
    # calling the function but suppressing the source line via stub.
    source() { :; }
    check_upgrade_trial
    unset -f source
}

# --- check_upgrade_trial -----------------------------------------------------

@test "check_upgrade_trial: no flag -> no-op" {
    run check_upgrade_trial
    [[ "${status}" -eq 0 ]]
    [[ "${UPGRADE_TRIAL_PENDING}" == "false" ]]
}

@test "check_upgrade_trial: future deadline -> probation" {
    write_trial_flag "0.2.0" "$(( $(date +%s) + 300 ))"
    call_check_with_my_version "0.2.0"
    [[ "${UPGRADE_TRIAL_PENDING}" == "true" ]]
    [[ -f "${UPGRADE_TRIAL_FLAG}" ]]
}

@test "check_upgrade_trial: flag for different version -> no probation, leaves flag" {
    write_trial_flag "0.99.0" "$(( $(date +%s) + 300 ))"
    call_check_with_my_version "0.2.0"
    [[ "${UPGRADE_TRIAL_PENDING}" == "false" ]]
}

# --- clear_upgrade_trial_if_probation_passed ---------------------------------

@test "clear_upgrade_trial: no probation -> no-op" {
    UPGRADE_TRIAL_PENDING=false
    write_trial_flag "0.2.0" "$(( $(date +%s) + 300 ))"
    run clear_upgrade_trial_if_probation_passed
    [[ -f "${UPGRADE_TRIAL_FLAG}" ]]
}

@test "clear_upgrade_trial: in probation but below threshold -> keep flag" {
    UPGRADE_TRIAL_PENDING=true
    ITERATION_COUNT=2
    write_trial_flag "0.2.0" "$(( $(date +%s) + 300 ))"
    clear_upgrade_trial_if_probation_passed
    [[ "${UPGRADE_TRIAL_PENDING}" == "true" ]]
    [[ -f "${UPGRADE_TRIAL_FLAG}" ]]
}

@test "clear_upgrade_trial: in probation, threshold met -> clears flag" {
    UPGRADE_TRIAL_PENDING=true
    ITERATION_COUNT=5
    write_trial_flag "0.2.0" "$(( $(date +%s) + 300 ))"
    clear_upgrade_trial_if_probation_passed
    [[ "${UPGRADE_TRIAL_PENDING}" == "false" ]]
    [[ ! -f "${UPGRADE_TRIAL_FLAG}" ]]
}

@test "clear_upgrade_trial: in probation, well past threshold -> still clears" {
    UPGRADE_TRIAL_PENDING=true
    ITERATION_COUNT=42
    write_trial_flag "0.2.0" "$(( $(date +%s) + 300 ))"
    clear_upgrade_trial_if_probation_passed
    [[ "${UPGRADE_TRIAL_PENDING}" == "false" ]]
    [[ ! -f "${UPGRADE_TRIAL_FLAG}" ]]
}
