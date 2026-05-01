#!/usr/bin/env bash
# parse-verdict.sh -- SPEC-017-2-02 (numeric mode), SPEC-017-2-05 (checklist mode)
#
# Usage: parse-verdict.sh <response-file> <mode>
#   mode = numeric | checklist
#
# Numeric mode (this spec):
#   - Requires exactly one `VERDICT: APPROVE|CONCERNS|REQUEST_CHANGES` line
#     (case-insensitive). First match wins.
#   - Optional `SCORE: <int>` line.
#   - Sets `has-critical=true` iff the body contains `**[CRITICAL]**`
#     (case-insensitive).
#
# Checklist mode (SPEC-017-2-05) is implemented in this same script as a
# branch; this file holds the placeholder error until that spec lands.
#
# Writes verdict=, score=, has-critical= to $GITHUB_OUTPUT (or stdout when
# unset, for local debugging).
# Exits 1 with `::error::...` on any parse failure.

set -euo pipefail

response_file="${1:?response file required}"
mode="${2:-numeric}"

if [[ ! -r "$response_file" ]]; then
  echo "::error::Response file not readable: $response_file" >&2
  exit 1
fi

body="$(cat "$response_file")"

emit() {
  # Append a key=value line to GITHUB_OUTPUT if set, else stdout.
  local line="$1"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s\n' "$line" >> "$GITHUB_OUTPUT"
  else
    printf '%s\n' "$line"
  fi
}

if [[ "$mode" == "numeric" ]]; then
  verdict="$(printf '%s\n' "$body" \
    | grep -iE '^VERDICT:[[:space:]]*(APPROVE|CONCERNS|REQUEST_CHANGES)' \
    | head -n1 \
    | sed -E 's/^[Vv][Ee][Rr][Dd][Ii][Cc][Tt]:[[:space:]]*([A-Za-z_]+).*/\1/' \
    | tr '[:lower:]' '[:upper:]' || true)"
  if [[ -z "$verdict" ]]; then
    echo "::error::Could not parse verdict from Claude response" >&2
    exit 1
  fi
  score="$(printf '%s\n' "$body" \
    | grep -iE '^SCORE:[[:space:]]*[0-9]+' \
    | head -n1 \
    | sed -E 's/^[Ss][Cc][Oo][Rr][Ee]:[[:space:]]*([0-9]+).*/\1/' || true)"
  if printf '%s' "$body" | grep -qiE '\*\*\[CRITICAL\]\*\*'; then
    has_critical="true"
  else
    has_critical="false"
  fi
  emit "verdict=${verdict}"
  emit "score=${score}"
  emit "has-critical=${has_critical}"
  exit 0
fi

if [[ "$mode" == "checklist" ]]; then
  echo "::error::checklist mode not implemented in SPEC-017-2-02; see SPEC-017-2-05" >&2
  exit 1
fi

echo "::error::Unknown mode '$mode'; expected 'numeric' or 'checklist'" >&2
exit 1
