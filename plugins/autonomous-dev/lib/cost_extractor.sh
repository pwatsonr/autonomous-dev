#!/usr/bin/env bash
# cost_extractor.sh -- Parse session output for cost dollar amounts
# Part of TDD-010 / SPEC-010-2-01: Cost Extraction & Append-Only Cost Ledger
#
# Dependencies: grep, bash 4+
#
# Usage:
#   source cost_extractor.sh
#   cost=$(extract_session_cost "$session_output")

set -euo pipefail

# Source guard
if [[ -n "${_COST_EXTRACTOR_LOADED:-}" ]]; then return 0 2>/dev/null || true; fi
_COST_EXTRACTOR_LOADED=1

# ---------------------------------------------------------------------------
# Logging helpers (write to stderr so stdout stays clean for data output)
# ---------------------------------------------------------------------------
log_warning() {
  local tag="$1"; shift
  echo "[${tag}] WARNING: $*" >&2
}

log_error() {
  local tag="$1"; shift
  echo "[${tag}] ERROR: $*" >&2
}

# ---------------------------------------------------------------------------
# extract_session_cost -- Extract dollar cost from Claude Code session output
#
# Arguments:
#   $1 -- session_output: Full text output from a Claude Code session
#
# Stdout:
#   Decimal cost string (e.g., "1.85"), or "0.00" if no cost found
#
# Returns:
#   0 always (gracefully degrades to "0.00" with warning)
#
# Pattern variations handled:
#   "Total cost: $1.85"   -- standard format
#   "Session cost: $0.42" -- alternate label
#   "Cost: $3.17"         -- minimal label
#   "Total cost: $0.00"   -- zero cost
#   "Total cost: $123.45" -- three-digit dollar amounts
#   Multiple cost lines   -- takes the last one
#
# Not handled (returns 0.00 with warning):
#   Crashed sessions with no output
#   Sessions that printed only partial output before crash
#   Non-dollar cost formats
# ---------------------------------------------------------------------------
extract_session_cost() {
  local session_output="$1"
  local cost

  # Match patterns:
  #   "Total cost: $1.85"
  #   "Session cost: $1.85"
  #   "Cost: $1.85"
  #   "Total cost: $0.00"
  # Takes the LAST match (in case of multiple cost lines, the final one is authoritative)
  cost=$(echo "$session_output" | grep -oE '(Total |Session )?[Cc]ost:\s*\$[0-9]+\.[0-9]+' | tail -1 | grep -oE '[0-9]+\.[0-9]+' || true)

  if [[ -z "$cost" ]]; then
    log_warning "cost_extractor" "No cost found in session output. Recording 0.00."
    echo "0.00"
    return 0
  fi

  echo "$cost"
}
