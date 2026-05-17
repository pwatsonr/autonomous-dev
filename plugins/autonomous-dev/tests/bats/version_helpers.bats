#!/usr/bin/env bats
###############################################################################
# version_helpers.bats — unit tests for bin/lib/version-helpers.sh
#
# The version helpers are pure (no state writes, no side effects beyond
# reading the filesystem under their cache_dir argument), so we just
# fixture a temp cache layout and exercise the three exposed functions.
###############################################################################

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    # shellcheck source=../../bin/lib/version-helpers.sh
    source "${PLUGIN_DIR}/bin/lib/version-helpers.sh"
    TMP_CACHE="$(mktemp -d -t advhelpers)"
}

teardown() {
    rm -rf "${TMP_CACHE}"
}

# Helper: scaffold a fake cached plugin version with a runnable
# supervisor-loop.sh under <TMP_CACHE>/<version>/bin/.
make_cached_version() {
    local version="${1}"
    mkdir -p "${TMP_CACHE}/${version}/bin"
    : > "${TMP_CACHE}/${version}/bin/supervisor-loop.sh"
}

# --- current_version ---------------------------------------------------------

@test "current_version extracts X.Y.Z from a cache-style path" {
    fake="${TMP_CACHE}/0.3.1/bin/supervisor-loop.sh"
    mkdir -p "$(dirname "${fake}")"
    : > "${fake}"
    result=$(current_version "${fake}")
    [[ "${result}" == "0.3.1" ]]
}

@test "current_version returns unknown for a non-cache path" {
    result=$(current_version "/tmp/somewhere/random/bin/supervisor-loop.sh")
    [[ "${result}" == "unknown" ]]
}

@test "current_version returns unknown when the dir name isn't a semver" {
    fake="${TMP_CACHE}/not-a-version/bin/supervisor-loop.sh"
    mkdir -p "$(dirname "${fake}")"
    : > "${fake}"
    result=$(current_version "${fake}")
    [[ "${result}" == "unknown" ]]
}

# --- latest_cached_version ---------------------------------------------------

@test "latest_cached_version picks the highest semver" {
    make_cached_version "0.1.0"
    make_cached_version "0.2.0"
    make_cached_version "0.1.5"
    result=$(latest_cached_version "${TMP_CACHE}")
    [[ "${result}" == "0.2.0" ]]
}

@test "latest_cached_version handles 0.10.0 > 0.9.0 correctly" {
    make_cached_version "0.9.0"
    make_cached_version "0.10.0"
    result=$(latest_cached_version "${TMP_CACHE}")
    [[ "${result}" == "0.10.0" ]]
}

@test "latest_cached_version ignores entries without bin/supervisor-loop.sh" {
    mkdir -p "${TMP_CACHE}/0.5.0"          # incomplete extraction
    make_cached_version "0.4.0"
    result=$(latest_cached_version "${TMP_CACHE}")
    [[ "${result}" == "0.4.0" ]]
}

@test "latest_cached_version returns empty for an empty cache" {
    result=$(latest_cached_version "${TMP_CACHE}")
    [[ -z "${result}" ]]
}

@test "latest_cached_version filters non-semver subdirs" {
    make_cached_version "0.1.0"
    mkdir -p "${TMP_CACHE}/README/bin"
    : > "${TMP_CACHE}/README/bin/supervisor-loop.sh"
    result=$(latest_cached_version "${TMP_CACHE}")
    [[ "${result}" == "0.1.0" ]]
}

# --- compare_semver ----------------------------------------------------------

@test "compare_semver equal" {
    result=$(compare_semver "0.2.0" "0.2.0")
    [[ "${result}" == "0" ]]
}

@test "compare_semver less than" {
    result=$(compare_semver "0.1.0" "0.2.0")
    [[ "${result}" == "-1" ]]
}

@test "compare_semver greater than" {
    result=$(compare_semver "1.0.0" "0.9.9")
    [[ "${result}" == "1" ]]
}

@test "compare_semver handles 0.10 vs 0.9" {
    result=$(compare_semver "0.10.0" "0.9.0")
    [[ "${result}" == "1" ]]
}
