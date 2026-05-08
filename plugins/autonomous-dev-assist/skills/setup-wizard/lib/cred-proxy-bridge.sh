#!/usr/bin/env bash
# !!! credentials NEVER appear on stdout from this script !!!
#
# This script wraps TDD-024's cred-proxy CLI. The credential is entered
# by the operator into the cred-proxy's own TTY (the wizard process
# never has the credential bytes in any file descriptor). The script
# emits only an opaque handle (cph_*).
#
# Functions:
#   cred_proxy_provision <backend> <env>  -> opaque handle on stdout
#       wraps `autonomous-dev cred-proxy provision --backend <b> --env <e>`
#   cred_proxy_validate_handle <handle>   -> ok|expired|unknown
#       wraps `autonomous-dev cred-proxy validate --handle <h>`
#   cred_proxy_revoke <handle>            -> idempotent
#       wraps `autonomous-dev cred-proxy revoke   --handle <h>`
#   cred_proxy_write_env <name> <secret>  -> upsert secrets.env (legacy phase-8 path)
#
# CI lint enforced: only phase-16-deploy-backends.md may call the
# provision/validate/revoke functions; any other phase module triggers a
# build failure (see SPEC-033-4-01 FR-6).
#
# References: SPEC-033-4-01, TDD-024, TDD-033 §6.7, §12.

set -uo pipefail

# cred_proxy_provision <backend> <env>
# Subprocess attaches to controlling tty; wizard never sees credential.
# `setsid` ensures cred-proxy gets its own session so its TTY allocation is
# independent of the wizard's pipes.
# On success: stdout is exactly the handle (cph_<32 alnum>) + newline. exit 0.
# On failure: stderr diagnostic; stdout empty; exit 1.
cred_proxy_provision() {
  local backend="${1:-}" env="${2:-}"
  if [[ -z "$backend" || -z "$env" ]]; then
    echo "[cred-proxy-bridge] cred_proxy_provision: usage <backend> <env>" >&2
    return 1
  fi

  # Determine an isolation wrapper. `setsid` is a Linux convention; on macOS
  # we fall back to a no-op invocation. The mock cred-proxy used in tests
  # works under either path.
  local isolator=()
  if command -v setsid >/dev/null 2>&1; then
    isolator=(setsid)
  fi

  # Capture only the LAST line of stdout. Any operator-interaction text the
  # cred-proxy writes to /dev/tty does not flow into our pipe; only the
  # final "<handle>" line (per TDD-024 contract) is captured.
  # Detect a usable controlling terminal: /dev/tty must exist AND we must
  # be able to open it for reading. In CI/headless contexts we fall through
  # to the no-tty path (mocks satisfy this branch).
  local handle rc
  if [[ -e /dev/tty ]] && (exec </dev/tty) 2>/dev/null; then
    handle="$("${isolator[@]}" autonomous-dev cred-proxy provision \
                  --backend "$backend" --env "$env" \
                  </dev/tty 2>/dev/null | tail -1)"
    rc=$?
  else
    handle="$("${isolator[@]}" autonomous-dev cred-proxy provision \
                  --backend "$backend" --env "$env" 2>/dev/null | tail -1)"
    rc=$?
  fi

  if (( rc != 0 )) || [[ -z "$handle" ]]; then
    echo "[cred-proxy-bridge] provision failed for $backend/$env" >&2
    return 1
  fi

  # Validate handle shape; reject anything else (defense in depth).
  if [[ ! "$handle" =~ ^cph_[A-Za-z0-9]{32}$ ]]; then
    echo "[cred-proxy-bridge] invalid handle shape returned" >&2
    return 1
  fi

  printf '%s\n' "$handle"
  return 0
}

# cred_proxy_validate_handle <handle>
# Stdout: ok | expired | unknown (lowercase, single line).
# Exit:    0 ok | 2 expired | 3 unknown | 1 unexpected.
cred_proxy_validate_handle() {
  local handle="${1:-}"
  if [[ -z "$handle" ]]; then
    echo "[cred-proxy-bridge] cred_proxy_validate_handle: missing handle" >&2
    return 1
  fi

  autonomous-dev cred-proxy validate --handle "$handle" >/dev/null 2>&1
  local rc=$?
  case "$rc" in
    0) echo ok;       return 0 ;;
    2) echo expired;  return 2 ;;
    3) echo unknown;  return 3 ;;
    *)
      echo "[cred-proxy-bridge] validate unexpected rc=$rc" >&2
      return 1
      ;;
  esac
}

# cred_proxy_revoke <handle>
# Idempotent: already-revoked → exit 0.
# Exit:    0 success/idempotent | 3 unknown handle | 1 unexpected.
cred_proxy_revoke() {
  local handle="${1:-}"
  if [[ -z "$handle" ]]; then
    echo "[cred-proxy-bridge] cred_proxy_revoke: missing handle" >&2
    return 1
  fi
  autonomous-dev cred-proxy revoke --handle "$handle" >/dev/null 2>&1
  local rc=$?
  case "$rc" in
    0|2) return 0 ;;
    3)   return 3 ;;
    *)
      echo "[cred-proxy-bridge] revoke unexpected rc=$rc" >&2
      return 1
      ;;
  esac
}

# cred_proxy_write_env <env-var-name> <secret>
# Legacy phase-8 helper retained from SPEC-033-1-02. Upserts <name>=<secret>
# into ${AUTONOMOUS_DEV_SECRETS_FILE:-$HOME/.autonomous-dev/secrets.env} at
# mode 0600 without echoing the secret.
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

# Dispatch shim: `bash cred-proxy-bridge.sh <fn> [args...]`
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
