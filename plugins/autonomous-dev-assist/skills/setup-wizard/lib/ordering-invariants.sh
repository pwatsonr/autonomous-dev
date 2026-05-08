#!/usr/bin/env bash
# ordering-invariants.sh — enforces inter-phase ordering invariants per
# SPEC-033-4-03 FR-17.
#
# Contract:
#   wizard_check_phase_ordering <phase_nn>
#     reads ${WIZARD_STATE_FILE:-$HOME/.autonomous-dev/wizard-state.json}
#     - phase 12 requires phase 7 complete (exit 2 if not)
#     - phase 15 emits a warning if phase 14 is not complete (exit 0)
#     - phase 16 requires phases 1..7 complete (exit 2 if any missing)
#     exit 0 = ok to proceed
#     exit 2 = ordering violation; stderr names the missing prereq
#
# Gated by the `wizard.ordering_invariants_enforced` config flag (default
# true). Caller passes `--ignore-flag` to bypass the gate (used by
# unit tests of the helper itself).
#
# References: SPEC-033-4-03 §FR-17, §C-401..C-403.

set -uo pipefail

_phase_status() {
  local nn="$1" state_file="$2"
  jq -r ".phases.\"$nn\".status // \"not-run\"" "$state_file" 2>/dev/null
}

wizard_check_phase_ordering() {
  local phase_nn="${1:-}"
  if [[ -z "$phase_nn" ]]; then
    echo "[ordering-invariants] usage: wizard_check_phase_ordering <NN>" >&2
    return 2
  fi

  local state_file="${WIZARD_STATE_FILE:-${HOME}/.autonomous-dev/wizard-state.json}"
  if [[ ! -f "$state_file" ]]; then
    # No state yet → nothing to enforce; the phase itself will fail on its
    # own required_inputs.phases_complete check.
    return 0
  fi

  case "$phase_nn" in
    12)
      local s7
      s7="$(_phase_status "07" "$state_file")"
      if [[ "$s7" != "complete" ]]; then
        echo "[ordering-invariants] phase 12 requires phase 7 complete; current status: ${s7}" >&2
        return 2
      fi
      ;;
    15)
      local s14
      s14="$(_phase_status "14" "$state_file")"
      if [[ "$s14" != "complete" ]]; then
        echo "[ordering-invariants] warning: Specialist chains may require standards.yaml; you may want to run phase 14 first (current status: ${s14})" >&2
        # Warning only — do not block.
        return 0
      fi
      ;;
    16)
      local nn s
      for nn in 01 02 03 04 05 06 07; do
        s="$(_phase_status "$nn" "$state_file")"
        if [[ "$s" != "complete" ]]; then
          echo "[ordering-invariants] phase 16 requires phase ${nn} complete; current status: ${s}" >&2
          return 2
        fi
      done
      ;;
    *)
      # No invariant defined for other phases.
      return 0
      ;;
  esac
  return 0
}

# CLI dispatch when sourced or called directly.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  wizard_check_phase_ordering "$@"
fi
