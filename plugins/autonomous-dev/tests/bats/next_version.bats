#!/usr/bin/env bats
# next_version.bats -- unit tests for scripts/ci/next-version.sh (#694 follow-up)

setup() {
    REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../../../.." && pwd)"
    NV="${REPO_ROOT}/scripts/ci/next-version.sh"
    [ -f "$NV" ] || NV="$(cd "${BATS_TEST_DIRNAME}/../../.." && pwd)/scripts/ci/next-version.sh"
}

@test "NV-01 patch bump" {
    run bash "$NV" 0.3.57
    [ "$status" -eq 0 ]; [ "$output" = "0.3.58" ]
}
@test "NV-02 rolls the patch, not minor/major" {
    run bash "$NV" 1.9.9
    [ "$output" = "1.9.10" ]
}
@test "NV-03 zero patch" {
    run bash "$NV" 2.0.0
    [ "$output" = "2.0.1" ]
}
@test "NV-04 rejects non-semver (two components)" {
    run bash "$NV" 0.3
    [ "$status" -eq 2 ]
}
@test "NV-05 rejects a leading-v tag string" {
    run bash "$NV" v0.3.57
    [ "$status" -eq 2 ]
}
@test "NV-06 rejects empty" {
    run bash "$NV" ""
    [ "$status" -ne 0 ]
}
