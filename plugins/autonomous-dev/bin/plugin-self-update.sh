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

if [[ -d "${CACHE_DIR}" ]]; then
    # Newest cached version whose CLI entrypoint exists (a half-extracted dir at
    # the top of the sort order must not win).
    newest=""
    while IFS= read -r v; do
        [[ -x "${CACHE_DIR}/${v}/bin/autonomous-dev.sh" ]] && newest="${v}"
    done < <(ls -1 "${CACHE_DIR}" 2>/dev/null | sort -V)

    if [[ -n "${newest}" ]]; then
        vdir="${CACHE_DIR}/${newest}"

        # CRITICAL: `claude plugin update` ships fresh node_modules but never
        # rebuilds NATIVE bindings. Without this, better-sqlite3's compiled
        # binding is absent in every freshly-pulled version, so `request submit`
        # (and therefore the whole self-improve loop + Discord intake) crashes
        # with "Could not locate the bindings file" — while the daemon itself
        # keeps running (it uses the sqlite3 CLI), so the breakage is SILENT.
        # This is what made a routine auto-update kneecap request submission.
        # Rebuild is idempotent: skipped when the binding is already present.
        binding="${vdir}/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
        if [[ ! -f "${binding}" ]]; then
            if [[ -d "${vdir}/node_modules/better-sqlite3" ]] && command -v npm >/dev/null 2>&1; then
                log "native binding missing for ${newest}; rebuilding better-sqlite3"
                if (cd "${vdir}" && npm rebuild better-sqlite3 >/dev/null 2>&1); then
                    [[ -f "${binding}" ]] && log "rebuilt better-sqlite3 for ${newest}" \
                        || log "ERROR: rebuild ran but binding still absent for ${newest}"
                else
                    log "ERROR: 'npm rebuild better-sqlite3' failed for ${newest} — request submit will be broken until fixed"
                fi
            else
                log "WARN: cannot rebuild better-sqlite3 for ${newest} (no npm or no module dir)"
            fi
        else
            log "native binding present for ${newest}"
        fi

        # Repoint the CLI wrapper shim to the newest version, so `autonomous-dev`
        # CLI calls match what the marketplace just installed. (The launchd
        # SERVICE is repointed separately by the daemon's own upgrader.) Done
        # AFTER the rebuild so we never point at a version with a broken binding.
        if [[ -f "${WRAPPER}" ]]; then
            target="${vdir}/bin/autonomous-dev.sh"
            if ! grep -qF "${target}" "${WRAPPER}" 2>/dev/null; then
                printf '#!/usr/bin/env bash\nexec %s "$@"\n' "${target}" > "${WRAPPER}"
                chmod +x "${WRAPPER}"
                log "repointed wrapper -> ${newest}"
            else
                log "wrapper already at ${newest}"
            fi
        fi
    fi
fi

# Post-update health check — makes a broken update LOUD instead of silent. If an
# update leaves the system unhealthy (e.g. the native-binding rebuild above
# somehow failed), this surfaces it in the plugin-updater log rather than letting
# request submission die quietly.
if [[ -x "${WRAPPER}" ]]; then
    if "${WRAPPER}" doctor >/dev/null 2>&1; then
        log "post-update health check PASSED"
    else
        log "ERROR: post-update health check FAILED — run 'autonomous-dev doctor' for detail"
    fi
fi

log "done"
exit 0
