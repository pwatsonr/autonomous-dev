#!/usr/bin/env bats
# provenance.bats -- unit + smoke tests for the provenance classifier (#694)

setup() {
    PLUGIN_DIR_PATH="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    # shellcheck source=/dev/null
    source "${PLUGIN_DIR_PATH}/lib/observability/provenance.sh"
    # shellcheck source=/dev/null
    source "${PLUGIN_DIR_PATH}/lib/observability/cli_provenance.sh"

    TEST_PROJECT="$(mktemp -d)/proj"
    mkdir -p "${TEST_PROJECT}/.git"
    mkdir -p "${TEST_PROJECT}/.autonomous-dev/requests/REQ-000042"
}

teardown() {
    [[ -n "${TEST_PROJECT:-}" ]] && rm -rf "$(dirname "${TEST_PROJECT}")"
}

# ---- prov_request_id_from_ref -------------------------------------------------

@test "PR-01 id from plain branch" {
    run prov_request_id_from_ref "autonomous/REQ-000042"
    [ "$status" -eq 0 ]; [ "$output" = "REQ-000042" ]
}
@test "PR-02 id from origin-prefixed ref" {
    run prov_request_id_from_ref "origin/autonomous/REQ-000042"
    [ "$output" = "REQ-000042" ]
}
@test "PR-03 id from full refs/remotes ref" {
    run prov_request_id_from_ref "refs/remotes/origin/autonomous/REQ-000042"
    [ "$output" = "REQ-000042" ]
}
@test "PR-04 non-namespace branch yields empty" {
    run prov_request_id_from_ref "feature/new-thing"
    [ "$output" = "" ]
}
@test "PR-05 main yields empty" {
    run prov_request_id_from_ref "main"
    [ "$output" = "" ]
}
@test "PR-06 a branch merely CONTAINING autonomous but not the namespace is not matched" {
    run prov_request_id_from_ref "my-autonomous-experiment"
    [ "$output" = "" ]
}

# ---- prov_is_daemon_ref -------------------------------------------------------

@test "PR-07 namespace ref is a daemon ref" {
    run prov_is_daemon_ref "autonomous/REQ-000001"; [ "$status" -eq 0 ]
}
@test "PR-08 external ref is not a daemon ref" {
    run prov_is_daemon_ref "hotfix/login"; [ "$status" -ne 0 ]
}

# ---- prov_request_is_tracked --------------------------------------------------

@test "PR-09 tracked request (record dir present)" {
    run prov_request_is_tracked "REQ-000042" "${TEST_PROJECT}"; [ "$status" -eq 0 ]
}
@test "PR-10 untracked request (no record dir)" {
    run prov_request_is_tracked "REQ-999999" "${TEST_PROJECT}"; [ "$status" -ne 0 ]
}

# ---- prov_classify_ref (the core guard) --------------------------------------

@test "PR-11 namespace ref + tracked record -> daemon" {
    run prov_classify_ref "autonomous/REQ-000042" "${TEST_PROJECT}"
    [ "$output" = "daemon" ]
}
@test "PR-12 namespace ref + NO record -> daemon-untracked (anomaly)" {
    run prov_classify_ref "autonomous/REQ-000777" "${TEST_PROJECT}"
    [ "$output" = "daemon-untracked" ]
}
@test "PR-13 external ref -> external (expected concurrent work)" {
    run prov_classify_ref "feature/parallel-session" "${TEST_PROJECT}"
    [ "$output" = "external" ]
}
@test "PR-14 main -> external" {
    run prov_classify_ref "main" "${TEST_PROJECT}"
    [ "$output" = "external" ]
}

# ---- CLI smoke (with gh + git stubs) -----------------------------------------

@test "PR-15 cli_provenance --json classifies a daemon PR and an external PR" {
    MOCK="$(mktemp -d)"
    # gh stub: two open PRs — one daemon namespace, one external.
    cat > "${MOCK}/gh" <<'GH'
#!/usr/bin/env bash
if [[ "$1" == "pr" && "$2" == "list" ]]; then
  cat <<'JSON'
[{"number":10,"headRefName":"autonomous/REQ-000042","title":"daemon work","author":{"login":"bot"}},
 {"number":11,"headRefName":"feature/human-thing","title":"human work","author":{"login":"pat"}}]
JSON
  exit 0
fi
exit 0
GH
    chmod +x "${MOCK}/gh"
    # git stub: for-each-ref returns one daemon branch.
    cat > "${MOCK}/git" <<'GIT'
#!/usr/bin/env bash
if [[ "$1" == "for-each-ref" ]]; then echo "autonomous/REQ-000042"; exit 0; fi
exit 0
GIT
    chmod +x "${MOCK}/git"
    export PATH="${MOCK}:${PATH}"

    source "${PLUGIN_DIR_PATH}/lib/observability/cli_provenance.sh"
    run cli_provenance --project "${TEST_PROJECT}" --json
    [ "$status" -eq 0 ]
    # daemon = 1 PR + 1 branch = 2; external = 1 PR.
    [ "$(echo "$output" | jq -r '.summary.daemon')" = "2" ]
    [ "$(echo "$output" | jq -r '.summary.external')" = "1" ]
    [ "$(echo "$output" | jq -r '.summary.daemon_untracked')" = "0" ]
    rm -rf "${MOCK}"
}

@test "PR-16 cli_provenance flags a daemon-untracked namespace PR as anomaly" {
    MOCK="$(mktemp -d)"
    cat > "${MOCK}/gh" <<'GH'
#!/usr/bin/env bash
if [[ "$1" == "pr" && "$2" == "list" ]]; then
  echo '[{"number":12,"headRefName":"autonomous/REQ-000777","title":"stray","author":{"login":"?"}}]'
  exit 0
fi
exit 0
GH
    chmod +x "${MOCK}/gh"
    cat > "${MOCK}/git" <<'GIT'
#!/usr/bin/env bash
[[ "$1" == "for-each-ref" ]] && exit 0
exit 0
GIT
    chmod +x "${MOCK}/git"
    export PATH="${MOCK}:${PATH}"

    source "${PLUGIN_DIR_PATH}/lib/observability/cli_provenance.sh"
    run cli_provenance --project "${TEST_PROJECT}" --json
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.summary.daemon_untracked')" = "1" ]
    rm -rf "${MOCK}"
}

@test "PR-17 cli_provenance rejects a non-git project" {
    run cli_provenance --project "$(mktemp -d)"
    [ "$status" -eq 2 ]
}

@test "PR-18 cli_provenance runs cleanly under 'set -e' (dispatcher parity)" {
    # The CLI is sourced into a dispatcher that runs with `set -euo pipefail`.
    # Guards against the ((n++))-returns-1-from-zero abort class of bug.
    MOCK="$(mktemp -d)"
    cat > "${MOCK}/gh" <<'GH'
#!/usr/bin/env bash
[[ "$1" == "pr" && "$2" == "list" ]] && { echo '[{"number":10,"headRefName":"autonomous/REQ-000042","title":"t","author":{"login":"b"}}]'; exit 0; }
exit 0
GH
    chmod +x "${MOCK}/gh"
    cat > "${MOCK}/git" <<'GIT'
#!/usr/bin/env bash
[[ "$1" == "for-each-ref" ]] && { echo "autonomous/REQ-000042"; exit 0; }
exit 0
GIT
    chmod +x "${MOCK}/git"

    run bash -euo pipefail -c '
      source "'"${PLUGIN_DIR_PATH}"'/lib/observability/provenance.sh"
      source "'"${PLUGIN_DIR_PATH}"'/lib/observability/cli_provenance.sh"
      export PATH="'"${MOCK}"':$PATH"
      cli_provenance --project "'"${TEST_PROJECT}"'"
    '
    [ "$status" -eq 0 ]
    [[ "$output" == *"daemon=2"* ]]
    rm -rf "${MOCK}"
}
