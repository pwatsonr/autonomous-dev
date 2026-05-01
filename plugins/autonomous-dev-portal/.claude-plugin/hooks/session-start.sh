#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# session-start.sh - SessionStart hook for autonomous-dev-portal (SPEC-013-1-02)
#
# Runs once per Claude Code session start. Responsibilities:
#   1. Verify the Bun runtime via bin/check-runtime.sh (SPEC-013-1-03).
#   2. Validate auth_mode conditional userConfig fields.
#   3. Hash ${CLAUDE_PLUGIN_ROOT}/package.json. If unchanged from the cached
#      hash in ${CLAUDE_PLUGIN_DATA}/.last-install-hash, skip `bun install`.
#   4. On hash mismatch (or no cache), run `bun install`. On success,
#      atomically update the hash cache. On failure, leave the cache
#      untouched so the next session retries.
#
# Exit codes:
#   0  success (install ran or skipped cleanly)
#   1  install failure or userConfig validation failure
#   2  required environment variable missing (CLAUDE_PLUGIN_ROOT/DATA)
#
# Required runtime utilities:
#   - bun         (verified by check-runtime.sh; this hook does not invoke
#                  it for the version check itself)
#   - jq          (used to parse the userConfig env var if Claude Code
#                  injects a single JSON blob; per-key env vars are also
#                  supported as a fallback shape)
#   - sha256sum (Linux) OR shasum (macOS) — auto-detected
###############################################################################

# ---------------------------------------------------------------------------
# log(message) -> void
#   Append a timestamped line to ${CLAUDE_PLUGIN_DATA}/install.log AND mirror
#   to stderr. Never truncates the log file.
# ---------------------------------------------------------------------------
log() {
    local ts
    ts="$(date -u +%FT%TZ)"
    local msg="[${ts}] $*"
    echo "${msg}" >&2
    if [[ -n "${CLAUDE_PLUGIN_DATA:-}" ]]; then
        # Best-effort: if the data dir is not writable yet, do not fail the
        # whole hook here — earlier require_env_or_die produced the diagnostic.
        echo "${msg}" >> "${CLAUDE_PLUGIN_DATA}/install.log" 2>/dev/null || true
    fi
}

# ---------------------------------------------------------------------------
# require_env_or_die() -> void | exit 2
#   Verify CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA are both set and
#   non-empty. Exits 2 with a clear stderr diagnostic if either is missing.
# ---------------------------------------------------------------------------
require_env_or_die() {
    if [[ -z "${CLAUDE_PLUGIN_ROOT:-}" ]]; then
        echo "ERROR: CLAUDE_PLUGIN_ROOT is not set; refusing to run session-start hook" >&2
        exit 2
    fi
    if [[ -z "${CLAUDE_PLUGIN_DATA:-}" ]]; then
        echo "ERROR: CLAUDE_PLUGIN_DATA is not set; refusing to run session-start hook" >&2
        exit 2
    fi
    mkdir -p "${CLAUDE_PLUGIN_DATA}"
}

# ---------------------------------------------------------------------------
# get_userconfig_value(key) -> string
#   Resolve a userConfig key to its current value. Tries two shapes Claude
#   Code may inject:
#     1. CLAUDE_PLUGIN_USERCONFIG (single JSON blob env var)
#     2. CLAUDE_PLUGIN_USERCONFIG_<KEY> (per-key env var, dots/dots
#        flattened to underscores and uppercased)
#   Prints empty string if absent. Never fails — caller decides.
# ---------------------------------------------------------------------------
get_userconfig_value() {
    local key="$1"
    if [[ -n "${CLAUDE_PLUGIN_USERCONFIG:-}" ]]; then
        # Use jq to extract; --raw-output prints scalar without quotes.
        # If jq not available or parse fails, fall through to per-key env.
        if command -v jq >/dev/null 2>&1; then
            local val
            val="$(printf '%s' "${CLAUDE_PLUGIN_USERCONFIG}" | jq -r --arg k "${key}" '.[$k] // empty' 2>/dev/null || echo "")"
            if [[ -n "${val}" ]]; then
                printf '%s' "${val}"
                return 0
            fi
        fi
    fi
    # Fallback: per-key env var. Replace any non-alnum char with _, uppercase.
    local env_key
    env_key="$(printf '%s' "${key}" | tr '[:lower:].' '[:upper:]_' | tr -c '[:alnum:]_' '_')"
    env_key="CLAUDE_PLUGIN_USERCONFIG_${env_key}"
    printf '%s' "${!env_key:-}"
}

# ---------------------------------------------------------------------------
# get_userconfig_array(key) -> newline-separated values
#   Same as get_userconfig_value but for array-typed keys. Prints one
#   element per line. Empty output for empty/missing arrays.
# ---------------------------------------------------------------------------
get_userconfig_array() {
    local key="$1"
    if [[ -n "${CLAUDE_PLUGIN_USERCONFIG:-}" ]] && command -v jq >/dev/null 2>&1; then
        printf '%s' "${CLAUDE_PLUGIN_USERCONFIG}" | jq -r --arg k "${key}" '.[$k] // [] | .[]' 2>/dev/null || true
        return 0
    fi
    # Per-key env: assume comma-separated. Empty => empty.
    local env_key
    env_key="$(printf '%s' "${key}" | tr '[:lower:].' '[:upper:]_' | tr -c '[:alnum:]_' '_')"
    env_key="CLAUDE_PLUGIN_USERCONFIG_${env_key}"
    local raw="${!env_key:-}"
    if [[ -n "${raw}" ]]; then
        printf '%s' "${raw}" | tr ',' '\n'
    fi
}

# ---------------------------------------------------------------------------
# validate_userconfig() -> void | exit 1
#   Apply conditional validation rules from SPEC-013-1-01:
#     - auth_mode=tailscale requires non-empty tailscale_tailnet
#     - auth_mode=oauth requires oauth_provider in [github, google]
#     - portal.path_policy.allowed_roots entries must start with /
#   Exits 1 with a clear stderr diagnostic on any violation.
# ---------------------------------------------------------------------------
validate_userconfig() {
    local auth_mode
    auth_mode="$(get_userconfig_value auth_mode)"
    # Default = localhost (per manifest); empty == default == OK.
    auth_mode="${auth_mode:-localhost}"

    case "${auth_mode}" in
        tailscale)
            local tailnet
            tailnet="$(get_userconfig_value tailscale_tailnet)"
            if [[ -z "${tailnet}" ]]; then
                log "ERROR: auth_mode=tailscale requires non-empty tailscale_tailnet"
                exit 1
            fi
            ;;
        oauth)
            local provider
            provider="$(get_userconfig_value oauth_provider)"
            if [[ "${provider}" != "github" && "${provider}" != "google" ]]; then
                log "ERROR: auth_mode=oauth requires oauth_provider in [github, google] (got '${provider}')"
                exit 1
            fi
            ;;
        localhost)
            : # default; nothing to validate
            ;;
        *)
            log "ERROR: invalid auth_mode '${auth_mode}'; expected localhost|tailscale|oauth"
            exit 1
            ;;
    esac

    # allowed_roots: each entry must be absolute. Empty array is valid.
    local roots root
    roots="$(get_userconfig_array 'portal.path_policy.allowed_roots')"
    if [[ -n "${roots}" ]]; then
        while IFS= read -r root; do
            [[ -z "${root}" ]] && continue
            if [[ "${root}" != /* ]]; then
                log "ERROR: portal.path_policy.allowed_roots entry must be absolute: '${root}'"
                exit 1
            fi
        done <<< "${roots}"
    fi
}

# ---------------------------------------------------------------------------
# compute_hash(file) -> sha256_hex
#   Print the SHA-256 hex digest of the file. Auto-detects sha256sum (Linux)
#   vs shasum (macOS). Exits 1 if neither tool is available.
# ---------------------------------------------------------------------------
compute_hash() {
    local file="$1"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "${file}" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "${file}" | awk '{print $1}'
    else
        echo "ERROR: neither sha256sum nor shasum available; cannot hash package.json" >&2
        exit 1
    fi
}

# ---------------------------------------------------------------------------
# write_hash_atomic(hash, target) -> void
#   Atomically write hash to target via tmp-file + mv. The mv is atomic
#   on POSIX filesystems, so a crash mid-write never leaves a partial file.
# ---------------------------------------------------------------------------
write_hash_atomic() {
    local hash="$1"
    local target="$2"
    local tmp="${target}.tmp.$$"
    printf '%s\n' "${hash}" > "${tmp}"
    mv "${tmp}" "${target}"
}

# ---------------------------------------------------------------------------
# session_start() -> exit_code
#   Main entrypoint. Per SPEC-013-1-02 §Task 4 pseudocode.
# ---------------------------------------------------------------------------
session_start() {
    require_env_or_die

    log "session-start invoked"

    # Step 3: invoke check-runtime.sh. If absent, fail with a pointer at
    # SPEC-013-1-03 (which lands the script).
    local runtime_check="${CLAUDE_PLUGIN_ROOT}/bin/check-runtime.sh"
    if [[ ! -x "${runtime_check}" ]]; then
        log "ERROR: ${runtime_check} not found or not executable; install SPEC-013-1-03"
        exit 1
    fi
    if ! "${runtime_check}" --quiet; then
        local rc=$?
        log "ERROR: bin/check-runtime.sh failed with exit ${rc}; aborting session-start"
        exit "${rc}"
    fi

    # userConfig conditional validation (declared in SPEC-013-1-01).
    validate_userconfig

    # Step 4-6: hash compare against cache.
    local pkg="${CLAUDE_PLUGIN_ROOT}/package.json"
    if [[ ! -f "${pkg}" ]]; then
        # No package.json yet (early bootstrap before PLAN-013-2 lands real
        # deps) — there is nothing to install. Skip cleanly.
        log "no package.json at ${pkg}; nothing to install; exiting 0"
        exit 0
    fi

    local current_hash cached_hash
    current_hash="$(compute_hash "${pkg}")"
    cached_hash=""
    if [[ -f "${CLAUDE_PLUGIN_DATA}/.last-install-hash" ]]; then
        cached_hash="$(cat "${CLAUDE_PLUGIN_DATA}/.last-install-hash" 2>/dev/null || echo "")"
    fi

    if [[ "${current_hash}" == "${cached_hash}" ]]; then
        log "package.json unchanged (hash ${current_hash}); skipping bun install"
        exit 0
    fi

    log "package.json hash changed: '${cached_hash}' -> '${current_hash}'; running bun install"

    # Step 8-9: cd into root and run bun install.
    cd "${CLAUDE_PLUGIN_ROOT}"
    if bun install >> "${CLAUDE_PLUGIN_DATA}/install.log" 2>&1; then
        write_hash_atomic "${current_hash}" "${CLAUDE_PLUGIN_DATA}/.last-install-hash"
        log "bun install succeeded"
        exit 0
    else
        log "bun install FAILED — preserving previous hash for retry"
        exit 1
    fi
}

session_start
