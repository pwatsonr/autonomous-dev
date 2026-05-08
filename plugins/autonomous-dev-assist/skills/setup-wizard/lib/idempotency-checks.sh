#!/usr/bin/env bash
# idempotency-checks.sh — read-only state probes for the wizard orchestrator.
#
# Contract:
#   stdout: one of `start-fresh` | `resume-from:<step>` | `already-complete`
#   exit:   0 on successful probe; 2 on probe-evaluation error
#
# All helpers are pure (no fs writes; bounded curl/gh calls per TDD-033 §10.3).
# Errors go to stderr with prefix `[idempotency-checks]`.
# Dispatch shim at end of file.
#
# References: SPEC-033-1-02, SPEC-033-2-01, SPEC-033-3-01.

set -uo pipefail

_idem_err() {
  echo "[idempotency-checks] $*" >&2
  exit 2
}

# Portable sha256: prefer sha256sum; fall back to shasum -a 256 (macOS).
_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$@"
  else
    _idem_err "neither sha256sum nor shasum available"
  fi
}

# config_key_equals <key> <value>
# returns: stdout already-complete (match) or start-fresh (no match); exit 0
config_key_equals() {
  local key="${1:-}" want="${2:-}"
  local cfg="${AUTONOMOUS_DEV_CONFIG:-$HOME/.autonomous-dev/config.json}"
  if [[ ! -f "$cfg" ]]; then
    echo "start-fresh"; return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    _idem_err "jq not on PATH"
  fi
  local actual
  actual="$(jq -r ".${key} // empty" "$cfg" 2>/dev/null)"
  if [[ "$actual" == "$want" ]]; then
    echo "already-complete"
  else
    echo "start-fresh"
  fi
  return 0
}

# file_exists_with_hash <path> <expected-sha256>
file_exists_with_hash() {
  local path="${1:-}" expected="${2:-}"
  if [[ -z "$path" || -z "$expected" ]]; then
    _idem_err "file_exists_with_hash: usage <path> <expected-sha256>"
  fi
  if [[ ! -f "$path" ]]; then
    echo "start-fresh"; return 0
  fi
  local actual
  actual="$(_sha256 "$path" | awk '{print $1}')"
  if [[ "$actual" == "$expected" ]]; then
    echo "already-complete"
  else
    echo "resume-from:rescaffold"
  fi
  return 0
}

# endpoint_responds_2xx <url> [poll-count] [interval-seconds]
# Polls up to N times; emits already-complete on first 2xx, else start-fresh.
endpoint_responds_2xx() {
  local url="${1:-}" max="${2:-5}" interval="${3:-2}"
  if [[ -z "$url" ]]; then
    _idem_err "endpoint_responds_2xx: missing url"
  fi
  if ! command -v curl >/dev/null 2>&1; then
    _idem_err "curl not on PATH"
  fi
  local i=0
  while (( i < max )); do
    if curl -fsS -m 2 "$url" >/dev/null 2>&1; then
      echo "already-complete"; return 0
    fi
    i=$(( i + 1 ))
    if (( i < max )); then
      sleep "$interval"
    fi
  done
  echo "start-fresh"
  return 0
}

# gh_api_returns_200 <api-path> [required-substring]
# Single gh api call (no retry; calling code uses _gh_with_backoff if needed).
# Returns:
#   already-complete on 200 (and required-substring present if given)
#   resume-from:configure-protection on 200 but missing substring
#   start-fresh on 404 / non-2xx
gh_api_returns_200() {
  local path="${1:-}" required_sub="${2:-required_status_checks}"
  if [[ -z "$path" ]]; then
    _idem_err "gh_api_returns_200: missing path"
  fi
  if ! command -v gh >/dev/null 2>&1; then
    _idem_err "gh CLI not on PATH"
  fi
  local out
  out="$(gh api "$path" 2>/dev/null)" || { echo "start-fresh"; return 0; }
  if [[ -n "$out" ]]; then
    if echo "$out" | grep -q "$required_sub"; then
      echo "already-complete"
    else
      echo "resume-from:configure-protection"
    fi
  else
    echo "start-fresh"
  fi
  return 0
}

# wizard_state_phase_complete <NN>
# Reads ~/.autonomous-dev/wizard-state.json (or $WIZARD_STATE_FILE override).
wizard_state_phase_complete() {
  local nn="${1:-}"
  if [[ -z "$nn" ]]; then
    _idem_err "wizard_state_phase_complete: missing phase number"
  fi
  local state="${WIZARD_STATE_FILE:-$HOME/.autonomous-dev/wizard-state.json}"
  if [[ ! -f "$state" ]]; then
    echo "start-fresh"; return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    _idem_err "jq not on PATH"
  fi
  local status
  status="$(jq -r ".phases.\"${nn}\".status // \"not-run\"" "$state" 2>/dev/null)"
  if [[ "$status" == "complete" ]]; then
    echo "already-complete"
  else
    echo "start-fresh"
  fi
  return 0
}

# Internal: bounded gh-api with exponential backoff. Used by phase-12 helpers.
# Max 5 attempts; delays 1, 2, 4, 8 (no 16 since 5th attempt with delay=16
# would still be the 5th attempt at 31s).
_gh_with_backoff() {
  local attempt=0 max=5 delay=1 out rc
  while (( attempt < max )); do
    if out="$(gh "$@" 2>/dev/null)"; then
      printf '%s' "$out"
      return 0
    fi
    rc=$?
    case "$rc" in
      4|22|3) return $rc ;;  # gh-cli 4xx-style → bail (not 5xx)
    esac
    attempt=$(( attempt + 1 ))
    if (( attempt < max )); then
      sleep "$delay"
      delay=$(( delay * 2 ))
    fi
  done
  return 1
}

# gh_branch_protection_configured <repo-slug> [required-contexts-csv]
# returns stdout: start-fresh | resume-from:partial | already-complete
gh_branch_protection_configured() {
  local slug="${1:-}" req_csv="${2:-}"
  if [[ -z "$slug" ]]; then
    _idem_err "gh_branch_protection_configured: missing repo slug"
  fi
  if ! command -v gh >/dev/null 2>&1; then
    _idem_err "gh CLI not on PATH"
  fi
  local resp
  if ! resp="$(_gh_with_backoff api "repos/${slug}/branches/main/protection")"; then
    echo "start-fresh"; return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    _idem_err "jq not on PATH"
  fi
  local rsc
  rsc="$(echo "$resp" | jq -r '.required_status_checks.contexts[]?' 2>/dev/null || true)"
  if [[ -z "$rsc" ]]; then
    echo "resume-from:partial"; return 0
  fi
  if [[ -z "$req_csv" ]]; then
    echo "already-complete"; return 0
  fi
  local missing=0 ctx
  IFS=',' read -ra needed <<< "$req_csv"
  for ctx in "${needed[@]}"; do
    if ! grep -qx "$ctx" <<< "$rsc"; then
      missing=1
      break
    fi
  done
  if (( missing == 0 )); then
    echo "already-complete"
  else
    echo "resume-from:partial"
  fi
  return 0
}

# workflow_template_hash_matches <path> <expected-sha256>
workflow_template_hash_matches() {
  file_exists_with_hash "$@"
}

# standards_yaml_exists_at <path>  (SPEC-033-3-01)
# returns: start-fresh | resume-with-diff | already-complete
# exit 2 if `autonomous-dev` CLI is missing (and file present).
standards_yaml_exists_at() {
  local path="${1:-}"
  if [[ -z "$path" ]]; then
    _idem_err "standards_yaml_exists_at: missing path"
  fi
  if [[ ! -f "$path" ]]; then
    echo "start-fresh"; return 0
  fi
  if ! command -v autonomous-dev >/dev/null 2>&1; then
    echo "autonomous-dev-cli-missing" >&2
    return 2
  fi
  local repo
  repo="$(dirname "$(dirname "$path")")"
  if autonomous-dev standards validate --repo "$repo" >/dev/null 2>&1; then
    echo "already-complete"
  else
    echo "resume-with-diff"
  fi
  return 0
}

# reviewer_chain_yaml_matches <path> <expected-sha256>  (SPEC-033-3-01)
reviewer_chain_yaml_matches() {
  local path="${1:-}" expected="${2:-}"
  if [[ -z "$path" || -z "$expected" ]]; then
    _idem_err "reviewer_chain_yaml_matches: usage <path> <expected-sha256>"
  fi
  if [[ ! -f "$path" ]]; then
    echo "start-fresh"; return 0
  fi
  local actual
  actual="$(_sha256 "$path" | awk '{print $1}')"
  if [[ "$actual" == "$expected" ]]; then
    echo "already-complete"
  else
    echo "resume-with-diff"
  fi
  return 0
}

# Per-phase wrapper probes (light; full per-phase logic lives in the orchestrator).
phase-08-probe() {
  # Phase 8: enabled-and-validated bookkeeping; in absence of a daemon to probe,
  # consult config flags only. Real validation happens during the phase.
  if config_key_equals 'intake.discord.enabled' 'true' >/dev/null \
     || config_key_equals 'intake.slack.enabled' 'true' >/dev/null; then
    wizard_state_phase_complete 08
  else
    echo "start-fresh"
  fi
  return 0
}

phase-11-probe() {
  wizard_state_phase_complete 11
}

phase-12-probe() {
  wizard_state_phase_complete 12
}

phase-13-probe() {
  wizard_state_phase_complete 13
}

phase-14-probe() {
  # Compose standards_yaml_exists_at + today's dry-run file presence.
  # Layout:
  #   start-fresh             → standards.yaml missing
  #   resume-from:offer-pack  → standards.yaml present but invalid (resume-with-diff)
  #   resume-from:meta-reviewer-dry-run → valid yaml but no today's dry-run file
  #   already-complete        → valid yaml + today's dry-run file present
  local repo="${WIZARD_REPO:-$PWD}"
  local target="$repo/.autonomous-dev/standards.yaml"
  local probe
  probe="$(standards_yaml_exists_at "$target")" || return $?
  case "$probe" in
    start-fresh)
      echo "start-fresh"; return 0 ;;
    resume-with-diff)
      echo "resume-from:offer-pack"; return 0 ;;
    already-complete)
      local today
      today="$(date -u +%Y-%m-%d)"
      if [[ -f "$repo/.autonomous-dev/standards-dry-run-${today}.json" ]]; then
        echo "already-complete"
      else
        echo "resume-from:meta-reviewer-dry-run"
      fi
      return 0 ;;
  esac
  echo "start-fresh"
  return 0
}

phase-15-probe() {
  wizard_state_phase_complete 15
}

phase-16-probe() {
  wizard_state_phase_complete 16
}

# Dispatch shim
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  fn="${1:-}"
  if [[ -z "$fn" ]]; then
    _idem_err "no function name supplied"
  fi
  shift || true
  if ! declare -F "$fn" >/dev/null; then
    _idem_err "unknown function: $fn"
  fi
  "$fn" "$@"
fi
