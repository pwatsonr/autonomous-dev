#!/usr/bin/env bash
# plugin-self-update.sh — refresh the installed plugin from the marketplace.
#
# The OTHER half of the auto-update pipeline (repo side is auto-release.yml).
# The daemon's built-in upgrader (check_upgrade_available / stage_upgrade) only
# ever UPGRADES to the newest version already present in the plugin cache — it
# never fetches. Something has to pull new versions into the cache, or the
# installed daemon drifts behind main forever (which is exactly what happened —
# main/marketplace/cache all sat at 0.3.56 for many merges).
#
# This script is that fetch. Run it on a timer (see the plugin-updater launchd
# job) so a headless daemon Mac tracks published releases automatically:
#   1. refresh the marketplace clone   (claude plugin marketplace update)
#   2. pull the newest plugin version  (claude plugin update <plugin>@<market>)
#   3. repoint the CLI wrapper shim to the newest cached version
# The daemon's own upgrader then repoints the launchd service on its next tick.
# Independent of the kill-switch: updating installed CODE is not running WORK,
# so the installed system stays current even while the loop is halted.
#
# Idempotent + safe to run every N minutes: all three steps are no-ops when
# already current. Never touches the kill-switch, never starts/stops the loop.
set -uo pipefail

PLUGIN="${AUTONOMOUS_DEV_PLUGIN_NAME:-autonomous-dev}"
MARKET="${AUTONOMOUS_DEV_MARKETPLACE:-autonomous-dev}"
CACHE_DIR="${HOME}/.claude/plugins/cache/${MARKET}/${PLUGIN}"
WRAPPER="${AUTONOMOUS_DEV_WRAPPER:-${HOME}/.local/bin/autonomous-dev}"

log() { printf '%s plugin-self-update: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

if ! command -v claude >/dev/null 2>&1; then
    log "ERROR: 'claude' CLI not on PATH; cannot self-update"
    exit 127
fi

log "refreshing marketplace '${MARKET}'"
claude plugin marketplace update "${MARKET}" >/dev/null 2>&1 \
    || log "WARN: marketplace update returned non-zero (continuing)"

log "updating plugin '${PLUGIN}@${MARKET}'"
claude plugin update "${PLUGIN}@${MARKET}" >/dev/null 2>&1 \
    || log "WARN: plugin update returned non-zero (continuing)"

# Repoint the CLI wrapper shim to the newest complete cached version, so
# `autonomous-dev ...` CLI calls match what the marketplace just installed.
# (The launchd SERVICE is repointed separately by the daemon's own upgrader.)
if [[ -d "${CACHE_DIR}" ]]; then
    newest=""
    while IFS= read -r v; do
        [[ -x "${CACHE_DIR}/${v}/bin/autonomous-dev.sh" ]] && newest="${v}"
    done < <(ls -1 "${CACHE_DIR}" 2>/dev/null | sort -V)
    if [[ -n "${newest}" && -f "${WRAPPER}" ]]; then
        target="${CACHE_DIR}/${newest}/bin/autonomous-dev.sh"
        if ! grep -qF "${target}" "${WRAPPER}" 2>/dev/null; then
            printf '#!/usr/bin/env bash\nexec %s "$@"\n' "${target}" > "${WRAPPER}"
            chmod +x "${WRAPPER}"
            log "repointed wrapper -> ${newest}"
        else
            log "wrapper already at ${newest}"
        fi
    fi
fi

log "done"
exit 0
