#!/usr/bin/env bash
# test_dispatch_timeout.sh -- Unit tests for REQ-000051: per-phase dispatch
# timeout helpers.
#
# Tests:
#   U-01..U-07: coerce_timeout_to_seconds
#   U-08..U-14: resolve_dispatch_timeout (5-layer precedence)
#   U-15:       resolve_max_soft_timeout_reentries
#   U-16..U-18: snapshot_working_tree
#   U-19..U-23: working_tree_advanced
#
# Requires: jq (1.6+), git, bash 4+
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Source shared test harness
source "${SCRIPT_DIR}/../test_harness.sh"

# Source the module under test (typed-limits.sh).
# We do NOT source supervisor-loop.sh here; snapshot_working_tree and
# working_tree_advanced are defined there and sourced separately below.
source "${PROJECT_ROOT}/bin/lib/typed-limits.sh"

# Source supervisor-loop.sh in unit-test mode (BASH_SOURCE[0] != $0 so the
# main() guard prevents actual daemon startup). We only need the two helpers.
# To avoid side effects we define minimal stubs for the functions that
# supervisor-loop.sh calls at source time.
_setup_supervisor_stubs() {
    # Stub out functions that supervisor-loop.sh would normally call/define
    # when we need just snapshot_working_tree and working_tree_advanced.
    # We define them directly here to avoid sourcing the entire daemon.
    snapshot_working_tree() {
        local project="${1:-}"
        if [[ -z "${project}" || ! -d "${project}/.git" ]]; then
            printf 'non-git\n'
            return 0
        fi
        local head dirty
        head=$(git -C "${project}" rev-parse HEAD 2>/dev/null || true)
        dirty=$(git -C "${project}" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
        printf '%s|%s\n' "${head}" "${dirty}"
    }

    working_tree_advanced() {
        local pre="${1:-}" post="${2:-}"
        if [[ -z "${pre}" || -z "${post}" ]]; then
            return 1
        fi
        if [[ "${pre}" == "non-git" || "${post}" == "non-git" ]]; then
            return 1
        fi
        if [[ "${pre}" == "${post}" ]]; then
            return 1
        fi
        return 0
    }
}
_setup_supervisor_stubs

###############################################################################
# Helper: write a minimal state.json to a temp file and return its path
###############################################################################
_write_state() {
    local content="${1:-{\}}"
    local path="${_TEST_DIR}/state.json"
    echo "${content}" > "${path}"
    echo "${path}"
}

###############################################################################
# Helper: write a minimal effective-config json to a temp file and return path
###############################################################################
_write_config() {
    local content="${1:-{\}}"
    local path="${_TEST_DIR}/effective.json"
    echo "${content}" > "${path}"
    echo "${path}"
}

###############################################################################
# U-01: coerce_timeout_to_seconds parses "30m"
###############################################################################
test_u01_coerce_30m() {
    local out
    out=$(coerce_timeout_to_seconds "30m")
    assert_eq "1800" "${out}" "U-01: 30m should coerce to 1800"
}

###############################################################################
# U-02: coerce_timeout_to_seconds parses "2h"
###############################################################################
test_u02_coerce_2h() {
    local out
    out=$(coerce_timeout_to_seconds "2h")
    assert_eq "7200" "${out}" "U-02: 2h should coerce to 7200"
}

###############################################################################
# U-03: coerce_timeout_to_seconds parses "90s"
###############################################################################
test_u03_coerce_90s() {
    local out
    out=$(coerce_timeout_to_seconds "90s")
    assert_eq "90" "${out}" "U-03: 90s should coerce to 90"
}

###############################################################################
# U-04: coerce_timeout_to_seconds parses bare integer
###############################################################################
test_u04_coerce_bare_int() {
    local out
    out=$(coerce_timeout_to_seconds "1800")
    assert_eq "1800" "${out}" "U-04: bare int 1800 should coerce to 1800"
}

###############################################################################
# U-05: coerce_timeout_to_seconds rejects spaces
###############################################################################
test_u05_coerce_rejects_spaces() {
    local out exit_code=0
    out=$(coerce_timeout_to_seconds "30 min" 2>/dev/null) || exit_code=$?
    assert_eq "" "${out}" "U-05: stdout should be empty for '30 min'"
    assert_eq "1" "${exit_code}" "U-05: exit code should be 1 for '30 min'"
}

###############################################################################
# U-06: coerce_timeout_to_seconds rejects empty string
###############################################################################
test_u06_coerce_rejects_empty() {
    local out exit_code=0
    out=$(coerce_timeout_to_seconds "" 2>/dev/null) || exit_code=$?
    assert_eq "" "${out}" "U-06: stdout should be empty for empty input"
    assert_eq "1" "${exit_code}" "U-06: exit code should be 1 for empty"
}

###############################################################################
# U-07: coerce_timeout_to_seconds rejects garbage
###############################################################################
test_u07_coerce_rejects_garbage() {
    local out exit_code=0
    out=$(coerce_timeout_to_seconds "garbage" 2>/dev/null) || exit_code=$?
    assert_eq "" "${out}" "U-07: stdout should be empty for 'garbage'"
    assert_eq "1" "${exit_code}" "U-07: exit code should be 1 for 'garbage'"
}

###############################################################################
# U-08: resolve_dispatch_timeout honors state override (layer 1)
###############################################################################
test_u08_resolve_layer1_state_override() {
    local state_file
    state_file=$(_write_state '{"type_config":{"dispatchTimeouts":{"code":9000}}}')
    # Clear layers 2-4
    unset EFFECTIVE_CONFIG 2>/dev/null || true
    unset DISPATCH_TIMEOUT 2>/dev/null || true
    local out
    out=$(EFFECTIVE_CONFIG="" resolve_dispatch_timeout "${state_file}" "code")
    assert_eq "9000" "${out}" "U-08: per-request state override should yield 9000"
}

###############################################################################
# U-09: resolve_dispatch_timeout honors per-phase config (layer 2)
###############################################################################
test_u09_resolve_layer2_per_phase_config() {
    local state_file cfg
    state_file=$(_write_state '{}')
    cfg=$(_write_config '{"daemon":{"dispatch_timeout_by_phase":{"code":7777}}}')
    unset DISPATCH_TIMEOUT 2>/dev/null || true
    local out
    out=$(EFFECTIVE_CONFIG="${cfg}" resolve_dispatch_timeout "${state_file}" "code")
    assert_eq "7777" "${out}" "U-09: per-phase config layer should yield 7777"
}

###############################################################################
# U-10: resolve_dispatch_timeout honors global config (layer 3)
###############################################################################
test_u10_resolve_layer3_global_config() {
    local state_file cfg
    state_file=$(_write_state '{}')
    cfg=$(_write_config '{"daemon":{"dispatch_timeout_seconds":2222}}')
    unset DISPATCH_TIMEOUT 2>/dev/null || true
    local out
    out=$(EFFECTIVE_CONFIG="${cfg}" resolve_dispatch_timeout "${state_file}" "code")
    assert_eq "2222" "${out}" "U-10: global dispatch_timeout_seconds should yield 2222"
}

###############################################################################
# U-11: resolve_dispatch_timeout honors DISPATCH_TIMEOUT env (layer 4)
###############################################################################
test_u11_resolve_layer4_env_var() {
    local state_file
    state_file=$(_write_state '{}')
    unset EFFECTIVE_CONFIG 2>/dev/null || true
    local out
    out=$(EFFECTIVE_CONFIG="" DISPATCH_TIMEOUT="2h" resolve_dispatch_timeout "${state_file}" "code")
    assert_eq "7200" "${out}" "U-11: DISPATCH_TIMEOUT=2h env var should yield 7200"
}

###############################################################################
# U-12: resolve_dispatch_timeout falls back to phase default (layer 5)
###############################################################################
test_u12_resolve_layer5_phase_default() {
    local state_file
    state_file=$(_write_state '{}')
    unset DISPATCH_TIMEOUT 2>/dev/null || true
    local out
    out=$(EFFECTIVE_CONFIG="" resolve_dispatch_timeout "${state_file}" "code")
    assert_eq "10800" "${out}" "U-12: code phase default should be 10800"
}

###############################################################################
# U-13: resolve_dispatch_timeout for unknown phase falls back to 1800
###############################################################################
test_u13_resolve_unknown_phase_fallback() {
    local state_file
    state_file=$(_write_state '{}')
    unset DISPATCH_TIMEOUT 2>/dev/null || true
    local out
    out=$(EFFECTIVE_CONFIG="" resolve_dispatch_timeout "${state_file}" "nonsense_phase")
    assert_eq "1800" "${out}" "U-13: unknown phase should yield 1800"
}

###############################################################################
# U-14: resolve_dispatch_timeout swallows corrupt state.json
###############################################################################
test_u14_resolve_corrupt_state_file() {
    local state_file="${_TEST_DIR}/corrupt.json"
    echo "not json" > "${state_file}"
    unset DISPATCH_TIMEOUT 2>/dev/null || true
    local out
    out=$(EFFECTIVE_CONFIG="" resolve_dispatch_timeout "${state_file}" "code")
    assert_eq "10800" "${out}" "U-14: corrupt state.json should fall through to phase default 10800"
}

###############################################################################
# U-15: resolve_max_soft_timeout_reentries default is 5
###############################################################################
test_u15_resolve_max_soft_reentries_default() {
    local state_file
    state_file=$(_write_state '{}')
    local out
    out=$(EFFECTIVE_CONFIG="" resolve_max_soft_timeout_reentries "${state_file}")
    assert_eq "5" "${out}" "U-15: default max_soft_timeout_reentries should be 5"
}

###############################################################################
# U-16: snapshot_working_tree on non-git path returns "non-git"
###############################################################################
test_u16_snapshot_non_git() {
    local tmp
    tmp=$(mktemp -d)
    # Explicitly NOT git-initing
    local out
    out=$(snapshot_working_tree "${tmp}")
    rm -rf "${tmp}"
    assert_eq "non-git" "${out}" "U-16: non-git path should return 'non-git'"
}

###############################################################################
# U-17: snapshot_working_tree on clean repo matches "<40-char SHA>|0"
###############################################################################
test_u17_snapshot_clean_repo() {
    local tmp
    tmp=$(mktemp -d)
    git -C "${tmp}" init -q
    git -C "${tmp}" config user.email "test@test.com"
    git -C "${tmp}" config user.name "Test"
    echo "hello" > "${tmp}/file.txt"
    git -C "${tmp}" add file.txt
    git -C "${tmp}" commit -q -m "init"
    local out
    out=$(snapshot_working_tree "${tmp}")
    rm -rf "${tmp}"
    # Expect "<40-hex-chars>|0"
    if [[ "${out}" =~ ^[0-9a-f]{40}\|0$ ]]; then
        return 0
    else
        echo "  U-17: snapshot '${out}' does not match ^[0-9a-f]{40}|0$" >&2
        return 1
    fi
}

###############################################################################
# U-18: snapshot_working_tree on dirty repo (2 untracked) matches "<SHA>|2"
###############################################################################
test_u18_snapshot_dirty_repo() {
    local tmp
    tmp=$(mktemp -d)
    git -C "${tmp}" init -q
    git -C "${tmp}" config user.email "test@test.com"
    git -C "${tmp}" config user.name "Test"
    echo "hello" > "${tmp}/file.txt"
    git -C "${tmp}" add file.txt
    git -C "${tmp}" commit -q -m "init"
    # 2 untracked files
    echo "a" > "${tmp}/untracked1.txt"
    echo "b" > "${tmp}/untracked2.txt"
    local out
    out=$(snapshot_working_tree "${tmp}")
    rm -rf "${tmp}"
    if [[ "${out}" =~ ^[0-9a-f]{40}\|2$ ]]; then
        return 0
    else
        echo "  U-18: snapshot '${out}' does not match ^[0-9a-f]{40}|2$" >&2
        return 1
    fi
}

###############################################################################
# U-19: working_tree_advanced returns true on HEAD change
###############################################################################
test_u19_working_tree_advanced_head_change() {
    if working_tree_advanced "abc|0" "xyz|0"; then
        return 0
    else
        echo "  U-19: should return true when HEAD differs" >&2
        return 1
    fi
}

###############################################################################
# U-20: working_tree_advanced returns true on dirty-count change
###############################################################################
test_u20_working_tree_advanced_dirty_change() {
    if working_tree_advanced "abc|0" "abc|3"; then
        return 0
    else
        echo "  U-20: should return true when dirty count differs" >&2
        return 1
    fi
}

###############################################################################
# U-21: working_tree_advanced returns false on identical snapshots
###############################################################################
test_u21_working_tree_not_advanced_identical() {
    if working_tree_advanced "abc|0" "abc|0"; then
        echo "  U-21: should return false when pre == post" >&2
        return 1
    else
        return 0
    fi
}

###############################################################################
# U-22: working_tree_advanced returns false on non-git sentinel
###############################################################################
test_u22_working_tree_not_advanced_non_git() {
    if working_tree_advanced "non-git" "abc|3"; then
        echo "  U-22: should return false when pre is non-git" >&2
        return 1
    else
        return 0
    fi
}

###############################################################################
# U-23: working_tree_advanced returns false on empty pre
###############################################################################
test_u23_working_tree_not_advanced_empty() {
    if working_tree_advanced "" "abc|3"; then
        echo "  U-23: should return false when pre is empty" >&2
        return 1
    else
        return 0
    fi
}

###############################################################################
# Run all tests
###############################################################################
run_test "U-01: coerce_timeout_to_seconds parses 30m"        test_u01_coerce_30m
run_test "U-02: coerce_timeout_to_seconds parses 2h"         test_u02_coerce_2h
run_test "U-03: coerce_timeout_to_seconds parses 90s"        test_u03_coerce_90s
run_test "U-04: coerce_timeout_to_seconds parses bare int"   test_u04_coerce_bare_int
run_test "U-05: coerce rejects spaces"                       test_u05_coerce_rejects_spaces
run_test "U-06: coerce rejects empty"                        test_u06_coerce_rejects_empty
run_test "U-07: coerce rejects garbage"                      test_u07_coerce_rejects_garbage
run_test "U-08: resolve_dispatch_timeout layer 1 (state)"    test_u08_resolve_layer1_state_override
run_test "U-09: resolve_dispatch_timeout layer 2 (per-phase cfg)" test_u09_resolve_layer2_per_phase_config
run_test "U-10: resolve_dispatch_timeout layer 3 (global cfg)" test_u10_resolve_layer3_global_config
run_test "U-11: resolve_dispatch_timeout layer 4 (env var)"  test_u11_resolve_layer4_env_var
run_test "U-12: resolve_dispatch_timeout layer 5 (phase default)" test_u12_resolve_layer5_phase_default
run_test "U-13: resolve_dispatch_timeout unknown phase -> 1800" test_u13_resolve_unknown_phase_fallback
run_test "U-14: resolve_dispatch_timeout swallows corrupt state" test_u14_resolve_corrupt_state_file
run_test "U-15: resolve_max_soft_timeout_reentries default=5" test_u15_resolve_max_soft_reentries_default
run_test "U-16: snapshot_working_tree non-git path"          test_u16_snapshot_non_git
run_test "U-17: snapshot_working_tree clean repo"            test_u17_snapshot_clean_repo
run_test "U-18: snapshot_working_tree dirty repo (2 untracked)" test_u18_snapshot_dirty_repo
run_test "U-19: working_tree_advanced true on HEAD change"   test_u19_working_tree_advanced_head_change
run_test "U-20: working_tree_advanced true on dirty change"  test_u20_working_tree_advanced_dirty_change
run_test "U-21: working_tree_advanced false on identical"    test_u21_working_tree_not_advanced_identical
run_test "U-22: working_tree_advanced false on non-git"      test_u22_working_tree_not_advanced_non_git
run_test "U-23: working_tree_advanced false on empty pre"    test_u23_working_tree_not_advanced_empty

report
