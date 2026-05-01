#!/usr/bin/env bash
# tests/ci/helpers/trust_gate_harness.sh
#
# Reusable harness for tests/ci/test_claude_trust_gate.bats. Lets the
# bats suite exercise the trust-gate composite's logic without needing
# `nektos/act` or a real GitHub Actions runner. The case block here MUST
# stay in lockstep with `.github/actions/claude-trust-gate/action.yml`;
# reviewers verify the mirror, the bats suite verifies correctness.

set -euo pipefail

evaluate_trust() {
  local association="${1-}"
  local output_file
  output_file="$(mktemp)"
  GITHUB_OUTPUT="$output_file" bash -c '
    set -euo pipefail
    association="$1"
    case "$association" in
      OWNER|MEMBER|COLLABORATOR)
        echo "is-trusted=true" >> "$GITHUB_OUTPUT"
        ;;
      *)
        echo "is-trusted=false" >> "$GITHUB_OUTPUT"
        ;;
    esac
  ' _ "$association"
  grep -E '^is-trusted=' "$output_file" | cut -d= -f2
  rm -f "$output_file"
}
