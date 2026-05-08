#!/usr/bin/env bash
# !!! credentials NEVER appear on stdout from this script !!!
#
# credential-scanner.sh — uniform credential-pattern scanner.
#
# Used inline by phase 16 against operator inputs (FR-9 of SPEC-033-4-02)
# AND as a post-run sweep over transcripts in the eval framework
# (AMENDMENT-002 AC-08 anchor).
#
# Six pattern families per TDD-033 §6.7 / SPEC-033-4-01 FR-9:
#   (a) AKIA[0-9A-Z]{16}                  AWS access key
#   (b) ya29\.[A-Za-z0-9_-]+              Google OAuth
#   (c) xoxb-[A-Za-z0-9-]+                Slack bot token
#   (d) -----BEGIN [A-Z ]+PRIVATE KEY---  PEM keys
#   (e) gh[pousr]_[A-Za-z0-9]{36,}        GitHub tokens
#   (f) keyword-proximity heuristic       password|secret|api[_-]?key|token
#
# Contract:
#   exit 0 : clean (no match)
#   exit 1 : match (stderr line: family=<a-f> reason=... value=<REDACTED>)
#
# The literal match value is REPLACED with `<REDACTED>` in the diagnostic;
# no credential bytes are echoed.
#
# References: SPEC-033-4-01 §FR-9..FR-15, AMENDMENT-002 AC-08.

set -uo pipefail

# Ordered families (a..e). Family (f) is the keyword-proximity heuristic
# applied separately below.
_CRED_PATTERNS=(
  'AKIA[0-9A-Z]{16}'
  'ya29\.[A-Za-z0-9_-]+'
  'xoxb-[A-Za-z0-9-]+'
  '-----BEGIN ([A-Z]+ )*PRIVATE[ -]?KEY-----'
  'gh[pousr]_[A-Za-z0-9]{36,}'
)

# scan_for_credential <input>
# Scans <input> against the six families. First match wins.
scan_for_credential() {
  local input="${1:-}"
  local i family
  for i in "${!_CRED_PATTERNS[@]}"; do
    if [[ "$input" =~ ${_CRED_PATTERNS[$i]} ]]; then
      # Map index 0..4 → letters a..e via printf %b escape sequence.
      family=$(printf '\\x%x' $((97 + i)))
      family=$(printf '%b' "$family")
      echo "[credential-scanner] match: family=$family reason=pattern-family-$family value=<REDACTED>" >&2
      return 1
    fi
  done

  # Family (f): keyword-proximity heuristic — a password/secret/api(-_)key/token
  # keyword followed within 32 chars by a 40+ char alnum/_/- run.
  if [[ "$input" =~ (password|secret|api[_-]?key|token).{0,32}[A-Za-z0-9_-]{40,} ]]; then
    echo "[credential-scanner] match: family=f reason=keyword-proximity value=<REDACTED>" >&2
    return 1
  fi

  return 0
}

# Allow standalone invocation: `credential-scanner.sh "$candidate"`.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  if [[ $# -lt 1 ]]; then
    echo "[credential-scanner] usage: credential-scanner.sh <candidate>" >&2
    exit 2
  fi
  scan_for_credential "$1"
fi
