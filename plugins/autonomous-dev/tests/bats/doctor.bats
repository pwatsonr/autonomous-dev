#!/usr/bin/env bats
# doctor.bats — unit tests for the health-check helpers + check logic.

setup() {
    PLUGIN_DIR="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    # shellcheck source=/dev/null
    source "${PLUGIN_DIR}/bin/doctor.sh"

    WORK="$(mktemp -d)"
    CACHE_DIR="${WORK}/cache"
    WRAPPER="${WORK}/wrapper"
    PLIST="${WORK}/plist"
    # a complete cached version 0.3.60
    mkdir -p "${CACHE_DIR}/0.3.60/bin" "${CACHE_DIR}/0.3.60/node_modules/better-sqlite3/build/Release"
    printf '#!/usr/bin/env bash\n' > "${CACHE_DIR}/0.3.60/bin/autonomous-dev.sh"
    chmod +x "${CACHE_DIR}/0.3.60/bin/autonomous-dev.sh"
}
teardown() { rm -rf "${WORK}"; }

@test "DR-01 newest_cached picks the highest version with an entrypoint" {
    mkdir -p "${CACHE_DIR}/0.3.59/bin"; : > "${CACHE_DIR}/0.3.59/bin/autonomous-dev.sh"; chmod +x "${CACHE_DIR}/0.3.59/bin/autonomous-dev.sh"
    run doctor_newest_cached "${CACHE_DIR}"
    [ "$output" = "0.3.60" ]
}

@test "DR-02 newest_cached ignores a half-extracted version (no entrypoint)" {
    mkdir -p "${CACHE_DIR}/0.3.61"   # no bin/ — incomplete
    run doctor_newest_cached "${CACHE_DIR}"
    [ "$output" = "0.3.60" ]
}

@test "DR-03 version_in_file extracts the semver" {
    printf 'exec /x/0.3.60/bin/autonomous-dev.sh "$@"\n' > "${WRAPPER}"
    run doctor_version_in_file "${WRAPPER}"
    [ "$output" = "0.3.60" ]
}

@test "DR-04 binding present -> native-binding PASS" {
    : > "$(doctor_binding_path "${CACHE_DIR}" 0.3.60)"
    run doctor_run_checks
    echo "$output" | grep -q $'native-binding\tPASS'
}

@test "DR-05 binding MISSING -> native-binding FAIL (the silent-break case)" {
    # binding file intentionally absent
    run doctor_run_checks
    echo "$output" | grep -q $'native-binding\tFAIL'
}

@test "DR-06 version drift -> version-align FAIL" {
    : > "$(doctor_binding_path "${CACHE_DIR}" 0.3.60)"
    printf 'exec /x/0.3.58/bin/autonomous-dev.sh "$@"\n' > "${WRAPPER}"   # stale wrapper
    printf '0.3.60\n' > "${PLIST}"
    run doctor_run_checks
    echo "$output" | grep -q $'version-align\tFAIL'
}

@test "DR-07 aligned versions -> version-align PASS" {
    : > "$(doctor_binding_path "${CACHE_DIR}" 0.3.60)"
    printf 'exec /x/0.3.60/bin/autonomous-dev.sh "$@"\n' > "${WRAPPER}"
    printf '0.3.60\n' > "${PLIST}"
    run doctor_run_checks
    echo "$output" | grep -q $'version-align\tPASS'
}

@test "DR-08 doctor_main exits 1 when a critical check FAILs" {
    # missing binding => native-binding FAIL => exit 1
    run doctor_main
    [ "$status" -eq 1 ]
}
