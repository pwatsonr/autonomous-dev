#!/usr/bin/env bats
#
# Phase-agent coverage integrity check (FR-020-02)
# Verifies that every phase in LEGACY_PHASES (except intake) has a resolve_agent mapping.

setup() {
    # Source the phase-legacy file and supervisor-loop functions
    source "${BATS_TEST_DIRNAME}/../../bin/lib/phase-legacy.sh"
    source "${BATS_TEST_DIRNAME}/../../bin/supervisor-loop.sh"
}

@test "resolve_agent covers all LEGACY_PHASES except intake" {
    # For every phase in LEGACY_PHASES except 'intake', resolve_agent must return 0 with a non-empty agent
    for phase in "${LEGACY_PHASES[@]}"; do
        if [[ "${phase}" == "intake" ]]; then
            # intake is expected to return 1 (no agent)
            run resolve_agent "${phase}"
            [[ $status -eq 1 ]]
            [[ -z "$output" ]]
        else
            # All other phases must return 0 with a non-empty agent name
            run resolve_agent "${phase}"
            [[ $status -eq 0 ]] || {
                echo "resolve_agent failed for phase: ${phase}" >&2
                return 1
            }
            [[ -n "$output" ]] || {
                echo "resolve_agent returned empty output for phase: ${phase}" >&2
                return 1
            }
        fi
    done
}

@test "no orphaned phases - all phases covered" {
    # Ensure we have exactly 14 phases in LEGACY_PHASES (the canonical count)
    [[ ${#LEGACY_PHASES[@]} -eq 14 ]]

    # Spot-check that the expected phases are present
    local found_intake=0 found_monitor=0 found_integration=0
    for phase in "${LEGACY_PHASES[@]}"; do
        [[ "${phase}" == "intake" ]] && found_intake=1
        [[ "${phase}" == "monitor" ]] && found_monitor=1
        [[ "${phase}" == "integration" ]] && found_integration=1
    done

    [[ $found_intake -eq 1 ]]
    [[ $found_monitor -eq 1 ]]
    [[ $found_integration -eq 1 ]]
}