#!/usr/bin/env bash
###############################################################################
# phase-legacy.sh - Source of truth for the v1.0 legacy phase sequence
#
# SPEC-018-2-01 Task 1
#
# Defines the LEGACY_PHASES array used as the fallback in select_request()
# when a state file lacks a v1.1 phase_overrides[] array. Sourced by
# supervisor-loop.sh and by the bats tests in tests/bats/.
#
# DO NOT extend this list — new pipeline variants live in phase_overrides[]
# and are computed from PHASE_OVERRIDE_MATRIX (see TS source of truth at
# plugins/autonomous-dev/intake/types/phase-override.ts). The two definitions
# (this bash array and the TS matrix) MUST stay aligned; future plans that
# alter either side should review both files in lockstep. The TS side is the
# canonical reference.
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
    test test_review
    validate
)
export LEGACY_PHASES
