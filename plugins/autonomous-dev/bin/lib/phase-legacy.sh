#!/usr/bin/env bash
###############################################################################
# phase-legacy.sh - Legacy phase sequence (mirrors ALL_PIPELINE_PHASES)
#
# SPEC-018-2-01 Task 1, updated for FR-020-02
#
# Defines the LEGACY_PHASES array used as the fallback in select_request()
# when a state file lacks a v1.1 phase_overrides[] array. Sourced by
# supervisor-loop.sh and by the bats tests in tests/bats/.
#
# This array is now kept in sync with ALL_PIPELINE_PHASES in
# plugins/autonomous-dev/intake/types/phase-override.ts. The TS side remains
# the canonical source of truth; this bash array mirrors it for use in the
# daemon when phase_overrides[] is empty or absent.
###############################################################################

# Defining LEGACY_PHASES as an exported indexed array. Bash does not export
# array contents across processes, but child shells that source this file
# get the same definition.
LEGACY_PHASES=(
    intake
    prd prd_review
    tdd tdd_review
    plan plan_review
    spec spec_review
    code code_review
    integration deploy monitor
)
export LEGACY_PHASES
