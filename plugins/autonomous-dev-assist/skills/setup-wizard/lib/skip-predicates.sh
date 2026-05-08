#!/usr/bin/env bash
# skip-predicates.sh — read-only helpers for phase skip-condition evaluation.
#
# Contract:
#   exit 0 = skip (predicate true; phase should be skipped)
#   exit 1 = run  (predicate false; phase should run)
#   exit 2 = predicate-evaluation error (e.g. missing dep)
#
# All helpers are pure: no fs writes, only file reads of
# ${AUTONOMOUS_DEV_CONFIG:-$HOME/.autonomous-dev/config.json}
# and detection-only commands (uname, git remote).
#
# Errors during evaluation go to stderr with prefix `[skip-predicates]`.
# stdout is reserved for the (optional) boolean answer; helpers in this
# file emit nothing on stdout (exit code is the API).
#
# Dispatch shim at end of file: `bash skip-predicates.sh <fn> [args]`.
#
# References: TDD-033 §5.1, §6.1-§6.7; SPEC-033-1-01.

set -uo pipefail

# Resolve config path. Tests can override via AUTONOMOUS_DEV_CONFIG.
_skip_config_path() {
  echo "${AUTONOMOUS_DEV_CONFIG:-$HOME/.autonomous-dev/config.json}"
}

# Internal: fail with a [skip-predicates] message on stderr; exit 2.
_skip_err() {
  echo "[skip-predicates] $*" >&2
  exit 2
}

# Internal: assert jq is available.
_skip_require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    _skip_err "jq not on PATH"
  fi
}

# is_github_origin
# usage: is_github_origin
# returns: 0 if `git remote -v` (or origin url) shows a github-flavored host,
#          1 otherwise (including non-repo dir or no remote)
is_github_origin() {
  if ! command -v git >/dev/null 2>&1; then
    _skip_err "git not on PATH"
  fi
  local remotes
  remotes="$(git remote -v 2>/dev/null)" || return 1
  if [[ -z "$remotes" ]]; then
    return 1
  fi
  # Match github.com OR *.github.* (covers GHES like github.example-corp.com)
  if echo "$remotes" | grep -qE '(github\.com|[a-zA-Z0-9.-]+\.github\.[a-zA-Z0-9.-]+|github\.[a-zA-Z0-9.-]+)'; then
    return 0
  fi
  return 1
}

# has_config_key <jq-path>
# usage: has_config_key intake.discord.enabled
# returns: 0 if the jq path resolves in the config file, 1 otherwise.
has_config_key() {
  local key="${1:-}"
  if [[ -z "$key" ]]; then
    _skip_err "has_config_key: missing key argument"
  fi
  _skip_require_jq
  local cfg
  cfg="$(_skip_config_path)"
  if [[ ! -f "$cfg" ]]; then
    return 1
  fi
  if jq -e ".${key}" "$cfg" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# config_key_equals <jq-path> <expected>
# usage: config_key_equals wizard.cli_only true
# returns: 0 if the JSON value at the path equals the expected (string compare),
#          1 otherwise.
config_key_equals() {
  local key="${1:-}" want="${2:-}"
  if [[ -z "$key" ]]; then
    _skip_err "config_key_equals: missing key argument"
  fi
  _skip_require_jq
  local cfg
  cfg="$(_skip_config_path)"
  if [[ ! -f "$cfg" ]]; then
    return 1
  fi
  local actual
  actual="$(jq -r ".${key} // empty" "$cfg" 2>/dev/null)" || return 1
  if [[ "$actual" == "$want" ]]; then
    return 0
  fi
  return 1
}

# is_cli_only_mode
# returns: 0 if config has wizard.cli_only=true, 1 otherwise.
is_cli_only_mode() {
  config_key_equals 'wizard.cli_only' 'true'
}

# is_macos / is_linux: detection helpers used by phase modules whose
# operator-flow differs by platform.
is_macos() {
  [[ "$(uname -s 2>/dev/null)" == "Darwin" ]]
}

is_linux() {
  [[ "$(uname -s 2>/dev/null)" == "Linux" ]]
}

# portal_install_default_skip (phase 11): skip unless wizard.portal_install_opt_in=true.
portal_install_default_skip() {
  if config_key_equals 'wizard.portal_install_opt_in' 'true'; then
    return 1   # opt-in present → run
  fi
  return 0     # default → skip
}

# phase_12_skip_predicate: skip when origin is NOT a GitHub flavor.
phase_12_skip_predicate() {
  if is_github_origin; then
    return 1   # github → run
  fi
  return 0     # not github → skip
}

# phase_13_skip_predicate / phase_14_skip_predicate / phase_15_skip_predicate /
# phase_16_skip_predicate: skip when wizard.skip_phase_NN=true.
phase_13_skip_predicate() {
  if config_key_equals 'wizard.skip_phase_13' 'true'; then
    return 0
  fi
  return 1
}

phase_14_skip_predicate() {
  if config_key_equals 'wizard.skip_phase_14' 'true'; then
    return 0
  fi
  return 1
}

phase_15_skip_predicate() {
  if config_key_equals 'wizard.skip_phase_15' 'true'; then
    return 0
  fi
  return 1
}

phase_16_skip_predicate() {
  if config_key_equals 'wizard.skip_phase_16' 'true'; then
    return 0
  fi
  return 1
}

# gh_token_has_admin_scope <env-var-name> <repo-slug>
# returns: 0 if gh api repos/<slug> reports permissions.admin == true
#          1 if false; 2 if gh CLI or token env var missing
# The token is exported for the duration of the gh call only (no argv leak).
gh_token_has_admin_scope() {
  local env_var="${1:-}" slug="${2:-}"
  if [[ -z "$env_var" || -z "$slug" ]]; then
    _skip_err "gh_token_has_admin_scope: usage <env-var-name> <repo-slug>"
  fi
  if ! command -v gh >/dev/null 2>&1; then
    echo "gh-cli-or-token-missing" >&2
    return 2
  fi
  if [[ -z "${!env_var:-}" ]]; then
    echo "gh-cli-or-token-missing" >&2
    return 2
  fi
  _skip_require_jq
  local resp
  resp="$(GH_TOKEN="${!env_var}" gh api "repos/${slug}" 2>/dev/null)" || return 1
  local admin
  admin="$(echo "$resp" | jq -r '.permissions.admin // false' 2>/dev/null)"
  if [[ "$admin" == "true" ]]; then
    return 0
  fi
  return 1
}

# Dispatch shim: `bash skip-predicates.sh <fn> [args...]`.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  fn="${1:-}"
  if [[ -z "$fn" ]]; then
    _skip_err "no function name supplied"
  fi
  shift || true
  if ! declare -F "$fn" >/dev/null; then
    _skip_err "unknown function: $fn"
  fi
  "$fn" "$@"
fi
