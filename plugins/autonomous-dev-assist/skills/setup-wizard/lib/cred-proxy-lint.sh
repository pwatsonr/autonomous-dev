#!/usr/bin/env bash
# cred-proxy-lint.sh
#
# CI lint per SPEC-033-4-01 FR-6: only `phase-16-deploy-backends.md` may
# call cred_proxy_provision / cred_proxy_validate_handle / cred_proxy_revoke.
# Any other phase module that references these functions fails the build.
#
# Usage: cred-proxy-lint.sh [<phases-dir>]
#   default phases-dir: dirname(this script)/../phases

set -uo pipefail

PHASES_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/phases}"

if [[ ! -d "$PHASES_DIR" ]]; then
  echo "[cred-proxy-lint] phases directory not found: $PHASES_DIR" >&2
  exit 2
fi

shopt -s nullglob
violators=()
for f in "$PHASES_DIR"/phase-*.md; do
  base="$(basename "$f")"
  if [[ "$base" == "phase-16-deploy-backends.md" ]]; then
    continue
  fi
  if grep -qE 'cred_proxy_(provision|validate_handle|revoke)' "$f"; then
    violators+=("$f")
  fi
done

if (( ${#violators[@]} > 0 )); then
  echo "[cred-proxy-lint] non-phase-16 caller(s) of cred_proxy_*:" >&2
  for f in "${violators[@]}"; do
    echo "  - $f" >&2
  done
  exit 1
fi

exit 0
