#!/usr/bin/env bash
# !!! STUB — DO NOT USE FOR CLOUD CREDENTIALS !!!
# !!! credentials NEVER appear on stdout from this script !!!
#
# This is the PLAN-033-1 stub of the cred-proxy bridge. Functional path:
#   cred_proxy_write_env <env-var-name> <secret>
#       writes to ${AUTONOMOUS_DEV_SECRETS_FILE:-$HOME/.autonomous-dev/secrets.env}
#       at mode 0600 (upsert).
#
# Stubbed cloud handles (cloud handles unimplemented; see PLAN-033-4 / SPEC-033-4-01):
#   cred_proxy_read_handle      → exit 99 (sentinel)
#
# Full TDD-024 integration (provision/validate/revoke) lands in SPEC-033-4-01,
# which REPLACES this file in its entirety.
#
# References: SPEC-033-1-02, SPEC-033-4-01.

set -uo pipefail

# cred_proxy_write_env <env-var-name> <secret>
# Appends/upserts <env-var-name>=<secret> in secrets.env at mode 0600.
# MUST never echo $secret to stdout/stderr/log.
cred_proxy_write_env() {
  local name="${1:-}" secret="${2:-}"
  if [[ -z "$name" ]]; then
    echo "[cred-proxy-bridge] cred_proxy_write_env: missing env-var-name" >&2
    return 1
  fi
  local file="${AUTONOMOUS_DEV_SECRETS_FILE:-$HOME/.autonomous-dev/secrets.env}"
  local dir
  dir="$(dirname "$file")"
  mkdir -p "$dir"
  if [[ ! -e "$file" ]]; then
    : > "$file"
  fi
  chmod 0600 "$file"
  # Upsert: drop existing line for this var, append new (temp file rename).
  local tmp="${file}.new"
  if grep -v "^${name}=" "$file" > "$tmp" 2>/dev/null; then
    :
  else
    : > "$tmp"
  fi
  printf '%s=%s\n' "$name" "$secret" >> "$tmp"
  mv "$tmp" "$file"
  chmod 0600 "$file"
  unset secret
}

# cred_proxy_read_handle <env> <backend>
# STUB: cloud handles unimplemented; exit 99 sentinel per SPEC-033-1-02 FR-10.
cred_proxy_read_handle() {
  echo "[cred-proxy-bridge] cloud handles unimplemented; see PLAN-033-4" >&2
  exit 99
}

# Dispatch shim
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  fn="${1:-}"
  if [[ -z "$fn" ]]; then
    echo "[cred-proxy-bridge] no function name supplied" >&2
    exit 2
  fi
  shift || true
  if ! declare -F "$fn" >/dev/null; then
    echo "[cred-proxy-bridge] unknown function: $fn" >&2
    exit 2
  fi
  "$fn" "$@"
fi
