#!/usr/bin/env bats
# TC-001: Module loads under strict mode
# TC-002: Kill switch disables selfheal_is_enabled
# TC-003: Lookup table returns expected tuple for F1..F9

PLUGIN_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/../../.." && pwd)"
LIB_DIR="${PLUGIN_DIR}/bin/lib"

# Source helper stubs not available in test env
setup() {
    # Stub log_warn/log_error/log_info/emit_alert/escalate_to_paused
    log_warn() { true; }
    log_error() { true; }
    log_info() { true; }
    emit_alert() { true; }
    escalate_to_paused() { true; }
    working_tree_advanced() { return 1; }
    resolve_phase_timeout() { echo "3600"; }
    sync_intake_db_row() { return 0; }
    export -f log_warn log_error log_info emit_alert escalate_to_paused
    export -f working_tree_advanced resolve_phase_timeout sync_intake_db_row

    # Source the self-heal modules
    source "${LIB_DIR}/self-heal-state.sh"
    source "${LIB_DIR}/self-heal-events.sh"
    source "${LIB_DIR}/self-heal.sh"
}

@test "TC-001: self-heal.sh sources under set -euo pipefail without errors" {
    run bash -c "
        set -euo pipefail
        log_warn() { true; }; log_error() { true; }; log_info() { true; }
        emit_alert() { true; }; escalate_to_paused() { true; }
        working_tree_advanced() { return 1; }
        resolve_phase_timeout() { echo 3600; }
        sync_intake_db_row() { return 0; }
        export -f log_warn log_error log_info emit_alert escalate_to_paused
        source '${LIB_DIR}/self-heal-state.sh'
        source '${LIB_DIR}/self-heal-events.sh'
        source '${LIB_DIR}/self-heal.sh'
    "
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "TC-002: AUTONOMOUS_DEV_SELF_HEAL=0 → selfheal_is_enabled returns 1" {
    AUTONOMOUS_DEV_SELF_HEAL=0
    run bash -c "
        log_warn() { true; }; log_error() { true; }; log_info() { true; }
        emit_alert() { true; }; escalate_to_paused() { true; }
        working_tree_advanced() { return 1; }
        resolve_phase_timeout() { echo 3600; }
        sync_intake_db_row() { return 0; }
        source '${LIB_DIR}/self-heal-state.sh'
        source '${LIB_DIR}/self-heal-events.sh'
        export AUTONOMOUS_DEV_SELF_HEAL=0
        source '${LIB_DIR}/self-heal.sh'
        selfheal_is_enabled; echo \$?
    "
    [ "$status" -eq 0 ]
    [ "$output" = "1" ]
}

@test "TC-002: AUTONOMOUS_DEV_SELF_HEAL=1 → selfheal_is_enabled returns 0" {
    run bash -c "
        log_warn() { true; }; log_error() { true; }; log_info() { true; }
        emit_alert() { true; }; escalate_to_paused() { true; }
        working_tree_advanced() { return 1; }
        resolve_phase_timeout() { echo 3600; }
        sync_intake_db_row() { return 0; }
        source '${LIB_DIR}/self-heal-state.sh'
        source '${LIB_DIR}/self-heal-events.sh'
        export AUTONOMOUS_DEV_SELF_HEAL=1
        source '${LIB_DIR}/self-heal.sh'
        selfheal_is_enabled; echo \$?
    "
    [ "$status" -eq 0 ]
    [ "$output" = "0" ]
}

@test "TC-003: _selfheal_table_lookup F1..F9 each return non-empty tuples" {
    for m in F1 F2 F3 F4 F5 F6 F7 F8 F9; do
        row=$(_selfheal_table_lookup "$m")
        [ -n "$row" ]
        # Must contain exactly 3 pipe separators (4 fields)
        count=$(echo "$row" | awk -F'|' '{print NF}')
        [ "$count" -eq 4 ]
    done
}

@test "TC-003: _selfheal_table_lookup unknown mode returns rc=1 with no output" {
    run _selfheal_table_lookup "FX"
    [ "$status" -eq 1 ]
    [ -z "$output" ]
}

@test "TC-003: F1 lookup returns correct detector/event/remediator/policy" {
    row=$(_selfheal_table_lookup "F1")
    [ "$row" = "detect_review_gate_loop|review_gate_loop_detected|remediate_fall_back_to_single_reviewer|R_FALL_BACK_TO_SINGLE_REVIEWER" ]
}

@test "TC-003: F7 lookup returns correct tuple" {
    row=$(_selfheal_table_lookup "F7")
    [ "$row" = "detect_verification_false_negative|verification_false_negative_detected|remediate_self_verify|R_SELF_VERIFY" ]
}

@test "TC-003: F9 lookup returns correct tuple" {
    row=$(_selfheal_table_lookup "F9")
    [ "$row" = "detect_state_ledger_drift|state_ledger_drift_detected|remediate_reconcile_ledger|R_RECONCILE_LEDGER" ]
}
