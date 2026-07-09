#!/usr/bin/env bash
# provenance.sh -- classify repository refs by provenance (#694)
#
# WHY: one global daemon serves several repos, and interactive/agent Claude
# sessions ALSO push directly to those same repos. A supervisor watching a
# shared repo must not mistake legitimate concurrent work (a human's branch, a
# parallel session's PR) for the daemon "going rogue". This library gives a
# single reliable answer to "did the daemon create this ref, or is it external
# concurrent work?" so monitoring/reporting never misattributes again.
#
# RELIABLE SIGNAL: the daemon commits with the AMBIENT git identity (same as the
# operator), so committer email is NOT a provenance signal. What IS reliable:
#   1. branch namespace: the daemon only ever works on `autonomous/REQ-<n>`
#   2. a matching request record under <project>/.autonomous-dev/requests/<REQ>/
# A ref in the namespace WITH a tracked request => daemon. A ref in the namespace
# with NO request record => `daemon-untracked` (the one real anomaly — a stray
# branch impersonating the namespace, worth a human look). Anything else =>
# `external`: normal concurrent work, explicitly NOT a red flag.
#
# Pure functions only (string + filesystem) — no network, no git calls — so the
# classifier is deterministic and unit-testable.

set -uo pipefail
# NOTE: `-e` is deliberately NOT set at file scope (sourced into other scripts).

# ---------------------------------------------------------------------------
# prov_request_id_from_ref <ref> -> stdout: REQ-<n> or empty
#
# Extracts the request id from any ref spelling:
#   autonomous/REQ-000042, origin/autonomous/REQ-000042,
#   refs/heads/autonomous/REQ-000042, refs/remotes/origin/autonomous/REQ-000042
# Non-namespace refs (main, feature/foo) yield empty output.
# ---------------------------------------------------------------------------
prov_request_id_from_ref() {
    local ref="${1:-}"
    if [[ "${ref}" =~ (^|/)autonomous/(REQ-[0-9]+) ]]; then
        printf '%s\n' "${BASH_REMATCH[2]}"
        return 0
    fi
    return 0
}

# ---------------------------------------------------------------------------
# prov_is_daemon_ref <ref> -> rc (0 = in the daemon branch namespace)
# Namespace membership only; does NOT check for a request record.
# ---------------------------------------------------------------------------
prov_is_daemon_ref() {
    local ref="${1:-}"
    [[ "${ref}" =~ (^|/)autonomous/REQ-[0-9]+ ]]
}

# ---------------------------------------------------------------------------
# prov_request_is_tracked <request_id> <project> -> rc (0 = record exists)
# True when the daemon actually tracks this request for the project, i.e.
# <project>/.autonomous-dev/requests/<REQ>/ exists.
# ---------------------------------------------------------------------------
prov_request_is_tracked() {
    local request_id="${1:-}" project="${2:-}"
    [[ -n "${request_id}" && -n "${project}" ]] || return 1
    [[ -d "${project}/.autonomous-dev/requests/${request_id}" ]]
}

# ---------------------------------------------------------------------------
# prov_classify_ref <ref> <project> -> stdout: daemon | daemon-untracked | external
#
#   daemon           namespace ref + a tracked request record  -> the daemon's own work
#   daemon-untracked namespace ref + NO request record         -> anomaly, look at it
#   external         not in the namespace                      -> concurrent work, expected
# Always exits 0 (classification never fails).
# ---------------------------------------------------------------------------
prov_classify_ref() {
    local ref="${1:-}" project="${2:-}"
    local rid
    rid="$(prov_request_id_from_ref "${ref}")"
    if [[ -z "${rid}" ]]; then
        printf 'external\n'
        return 0
    fi
    if prov_request_is_tracked "${rid}" "${project}"; then
        printf 'daemon\n'
    else
        printf 'daemon-untracked\n'
    fi
    return 0
}

# ---------------------------------------------------------------------------
# prov_classify_label <classification> -> stdout: human-readable meaning
# Central place for the message so reporting stays consistent.
# ---------------------------------------------------------------------------
prov_classify_label() {
    case "${1:-}" in
        daemon)           printf 'daemon-owned (autonomous/REQ-*, tracked)\n' ;;
        daemon-untracked) printf 'ANOMALY: namespace ref with no request record\n' ;;
        external)         printf 'external concurrent work (expected — not a red flag)\n' ;;
        *)                printf 'unknown\n' ;;
    esac
}
