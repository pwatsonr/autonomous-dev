#!/usr/bin/env bash
# doctor.sh — health check that fails LOUDLY when the installed system is broken.
#
# Motivation: today a routine `claude plugin update` shipped a version whose
# better-sqlite3 native binding was never rebuilt, so `request submit` (and the
# whole self-improve loop + Discord intake) crashed — but the daemon kept running
# (it uses the sqlite3 CLI), so nothing surfaced the break for a long time. Silent
# breakage of a load-bearing path is the core failure mode. This command turns
# that class of problem loud: it verifies the things that must be true for the
# system to actually work, and EXITS NON-ZERO on any critical failure.
#
# Checks (critical unless noted):
#   1. native-binding  — better-sqlite3 compiled binding present for the running version
#   2. db-submit-path   — `request list` actually loads the DB via better-sqlite3 (exit 0)
#   3. version-align    — wrapper, launchd plist, and newest cache agree on one version
#   4. daemon-running   — supervisor process is alive (WARN only; may be intentionally stopped)
#
# Usage: autonomous-dev doctor [--json]
# Exit:  0 = all critical checks pass; 1 = a critical check failed; 2 = bad args.
set -uo pipefail

CACHE_DIR="${AUTONOMOUS_DEV_CACHE_DIR:-${HOME}/.claude/plugins/cache/autonomous-dev/autonomous-dev}"
WRAPPER="${AUTONOMOUS_DEV_WRAPPER:-${HOME}/.local/bin/autonomous-dev}"
PLIST="${AUTONOMOUS_DEV_DAEMON_PLIST:-${HOME}/Library/LaunchAgents/com.autonomous-dev.daemon.plist}"

# --- helpers (pure — unit-testable) ------------------------------------------

# doctor_newest_cached <cache_dir> -> newest version dir with a CLI entrypoint
doctor_newest_cached() {
    local cache="${1:?}" newest="" v
    [[ -d "${cache}" ]] || return 0
    while IFS= read -r v; do
        [[ -x "${cache}/${v}/bin/autonomous-dev.sh" ]] && newest="${v}"
    done < <(ls -1 "${cache}" 2>/dev/null | sort -V)
    printf '%s' "${newest}"
}

# doctor_version_in_file <file> -> first 0.x.y version string in the file
doctor_version_in_file() {
    grep -oE '[0-9]+\.[0-9]+\.[0-9]+' "${1:-/dev/null}" 2>/dev/null | head -1
}

# doctor_binding_path <cache_dir> <version> -> path to the native binding
doctor_binding_path() {
    printf '%s/%s/node_modules/better-sqlite3/build/Release/better_sqlite3.node' "${1:?}" "${2:?}"
}

# --- check runners (emit "name<TAB>status<TAB>detail") ------------------------

_emit() { printf '%s\t%s\t%s\n' "$1" "$2" "$3"; }

doctor_run_checks() {
    local newest wrapper_v plist_v binding
    newest="$(doctor_newest_cached "${CACHE_DIR}")"

    # 1. native binding for the newest cached version
    if [[ -z "${newest}" ]]; then
        _emit native-binding FAIL "no complete version in cache ${CACHE_DIR}"
    else
        binding="$(doctor_binding_path "${CACHE_DIR}" "${newest}")"
        if [[ -f "${binding}" ]]; then
            _emit native-binding PASS "better-sqlite3 binding present for ${newest}"
        else
            _emit native-binding FAIL "better-sqlite3 binding MISSING for ${newest} — request submit will crash (run: autonomous-dev self-update)"
        fi
    fi

    # 2. DB/submit path actually loads (this is what silently broke)
    if command -v "${WRAPPER}" >/dev/null 2>&1 || [[ -x "${WRAPPER}" ]]; then
        if timeout 45 "${WRAPPER}" request list >/dev/null 2>&1; then
            _emit db-submit-path PASS "request list loaded the intake DB (better-sqlite3 OK)"
        else
            _emit db-submit-path FAIL "request list failed — the Node/DB layer is broken (likely native binding); self-improve + intake cannot submit"
        fi
    else
        _emit db-submit-path FAIL "wrapper not executable at ${WRAPPER}"
    fi

    # 3. version alignment: wrapper vs plist vs newest cache
    wrapper_v="$(doctor_version_in_file "${WRAPPER}")"
    plist_v="$(doctor_version_in_file "${PLIST}")"
    if [[ -n "${newest}" && "${wrapper_v}" == "${newest}" && "${plist_v}" == "${newest}" ]]; then
        _emit version-align PASS "wrapper=plist=cache=${newest}"
    else
        _emit version-align FAIL "drift: wrapper=${wrapper_v:-?} plist=${plist_v:-?} newest-cache=${newest:-?} (run: install-daemon --force + self-update)"
    fi

    # 4. daemon running (WARN — may be intentionally stopped/kill-switched)
    if pgrep -f 'supervisor-loop.sh' >/dev/null 2>&1; then
        _emit daemon-running PASS "supervisor process alive"
    else
        _emit daemon-running WARN "supervisor process not running (kill-switch or stopped)"
    fi
}

# --- main --------------------------------------------------------------------

doctor_main() {
    local json=0
    case "${1:-}" in
        --json) json=1 ;;
        -h|--help) echo "Usage: autonomous-dev doctor [--json]"; return 0 ;;
        "") ;;
        *) echo "doctor: unknown arg: $1" >&2; return 2 ;;
    esac

    local results crit_fail=0 line name status detail
    results="$(doctor_run_checks)"

    if [[ "${json}" -eq 1 ]]; then
        printf '%s\n' "${results}" | while IFS=$'\t' read -r name status detail; do
            [[ -n "${name}" ]] || continue
            jq -cn --arg n "$name" --arg s "$status" --arg d "$detail" '{check:$n, status:$s, detail:$d}'
        done | jq -s '{checks: ., ok: (all(.status != "FAIL"))}'
    else
        printf '%-18s %-6s %s\n' "CHECK" "STATUS" "DETAIL"
        while IFS=$'\t' read -r name status detail; do
            [[ -n "${name}" ]] || continue
            printf '%-18s %-6s %s\n' "${name}" "${status}" "${detail}"
        done <<< "${results}"
    fi

    while IFS=$'\t' read -r name status detail; do
        [[ "${status}" == "FAIL" ]] && crit_fail=1
    done <<< "${results}"

    [[ "${crit_fail}" -eq 0 ]] || return 1
    return 0
}

# Run when executed directly (not when sourced for tests).
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    doctor_main "$@"
fi
