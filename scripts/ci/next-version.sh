#!/usr/bin/env bash
# next-version.sh <current-semver> -> stdout: patch-incremented semver
#
# Pure, deterministic patch bump used by .github/workflows/auto-release.yml.
# Kept as its own script so the bump logic is unit-testable (next_version.bats)
# rather than buried inline in YAML.
#
#   next-version.sh 0.3.57  -> 0.3.58
#   next-version.sh 1.9.0   -> 1.9.1
#
# Rejects non X.Y.Z input (exit 2) so a malformed manifest fails loudly rather
# than silently producing a garbage tag.
set -euo pipefail

cur="${1:?usage: next-version.sh <X.Y.Z>}"
if [[ ! "${cur}" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    echo "next-version: not a X.Y.Z semver: ${cur}" >&2
    exit 2
fi
printf '%s.%s.%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "$(( BASH_REMATCH[3] + 1 ))"
