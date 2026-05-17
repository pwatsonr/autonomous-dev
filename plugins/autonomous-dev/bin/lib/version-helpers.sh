#!/usr/bin/env bash
# version-helpers.sh — primitives for the daemon's self-upgrade machinery.
#
# Three pure functions: detect the version this script is running as,
# scan the plugin cache for the newest version available, and compare
# two semver strings. The supervisor-loop's upgrade detector composes
# these to decide whether a newer version is sitting in the cache.
#
# All functions echo their result to stdout and return 0/1 in the usual
# bash idiom. None of them touch state, write files, or shell out beyond
# `ls`, `sort -V`, and string manipulation — safe to call on every poll.

# current_version(script_path) -> echoes the version segment of the cache
# path, or "unknown" if the path doesn't match the cache layout.
#
# The plugin lives at:
#   ~/.claude/plugins/cache/autonomous-dev/autonomous-dev/<X.Y.Z>/bin/<file>
# So the version is two directories up from the script's parent.
current_version() {
    local script_path="${1:-${BASH_SOURCE[0]}}"
    local resolved
    # Resolve symlinks one level — launchd may invoke us via a symlinked
    # plist path on some setups.
    if [[ -L "${script_path}" ]]; then
        resolved=$(readlink "${script_path}")
        # If the link was relative, anchor it to the link's directory.
        if [[ "${resolved}" != /* ]]; then
            resolved="$(dirname "${script_path}")/${resolved}"
        fi
    else
        resolved="${script_path}"
    fi
    # Walk: <file> → bin/ → <version>/
    local version_dir
    version_dir="$(cd "$(dirname "${resolved}")/.." 2>/dev/null && pwd)"
    if [[ -z "${version_dir}" ]]; then
        echo "unknown"
        return 0
    fi
    local version
    version="$(basename "${version_dir}")"
    # Sanity: must look like X.Y.Z (digits + dots only).
    if [[ ! "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "unknown"
        return 0
    fi
    echo "${version}"
}

# latest_cached_version(cache_dir) -> echoes the highest semver subdir of
# cache_dir, or "" when the cache dir is missing/empty.
#
# `sort -V` handles 0.10.0 > 0.9.0 correctly. We filter to entries that
# match the X.Y.Z pattern so stray files don't poison the result.
latest_cached_version() {
    local cache_dir="${1:-${HOME}/.claude/plugins/cache/autonomous-dev/autonomous-dev}"
    if [[ ! -d "${cache_dir}" ]]; then
        echo ""
        return 0
    fi
    # Walk newest → oldest and return the first version whose bin entry
    # point actually exists. A half-extracted version sitting at the top
    # of the sort order should not block discovery of a complete older
    # version.
    local candidates
    candidates=$(
        ls -1 "${cache_dir}" 2>/dev/null \
            | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' \
            | sort -Vr
    )
    local v
    while IFS= read -r v; do
        [[ -z "${v}" ]] && continue
        if [[ -f "${cache_dir}/${v}/bin/supervisor-loop.sh" ]]; then
            echo "${v}"
            return 0
        fi
    done <<< "${candidates}"
    echo ""
}

# compare_semver(a, b) -> echoes -1 if a < b, 0 if a == b, 1 if a > b.
# Uses `sort -V` so 0.10.0 > 0.9.0 ordering is correct.
compare_semver() {
    local a="${1:-}"
    local b="${2:-}"
    if [[ "${a}" == "${b}" ]]; then
        echo "0"
        return 0
    fi
    local first
    first=$(printf '%s\n%s\n' "${a}" "${b}" | sort -V | head -1)
    if [[ "${first}" == "${a}" ]]; then
        echo "-1"
    else
        echo "1"
    fi
}
