#!/usr/bin/env bats

# Tests for record_phase_metric() — the metrics SELF-FEED hook (phase-helpers.sh).
# A `<X>_review` completion records an InvocationMetric for the agent that
# produced phase `<X>`, with a derived score/outcome; non-review phases and the
# disable switches record nothing. Assertions read the JSONL primary store
# (written even when better-sqlite3 is unavailable).

setup() {
    PLUGIN_DIR_PATH="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    TEST_WORK_DIR="$(mktemp -d)"
    export HOME="$TEST_WORK_DIR"
    export AUTONOMOUS_DEV_AGENT_FACTORY_DATA_DIR="${TEST_WORK_DIR}/afdata"
    mkdir -p "${TEST_WORK_DIR}/.autonomous-dev/logs"

    set +e
    source "${PLUGIN_DIR_PATH}/bin/supervisor-loop.sh"
    set -e

    # The committed bin/lib/record-metric.js is the primary path; build if absent.
    if [[ ! -f "${PLUGIN_DIR_PATH}/bin/lib/record-metric.js" ]] && command -v bun >/dev/null 2>&1; then
        bun build "${PLUGIN_DIR_PATH}/bin/record-metric.ts" \
            --outfile="${PLUGIN_DIR_PATH}/bin/lib/record-metric.js" \
            --target=node --external better-sqlite3 >/dev/null 2>&1 || true
    fi

    PROJ="${TEST_WORK_DIR}/proj"
    mkdir -p "${PROJ}/.autonomous-dev/requests/REQ-T"
}

teardown() {
    [[ -n "${TEST_WORK_DIR:-}" ]] && rm -rf "${TEST_WORK_DIR}"
}

_jsonl() { echo "${AUTONOMOUS_DEV_AGENT_FACTORY_DATA_DIR}/agent-metrics.jsonl"; }

@test "code_review pass records an approved metric for code-executor" {
    command -v node >/dev/null 2>&1 || skip "node not available"
    echo '{"phase":"code_review","status":"pass","findings":[]}' \
        > "${PROJ}/.autonomous-dev/requests/REQ-T/phase-result-code_review.json"
    echo '{"phase_history":[{"state":"code","retry_count":0}]}' \
        > "${PROJ}/.autonomous-dev/requests/REQ-T/state.json"

    record_phase_metric REQ-T "${PROJ}" code_review pass

    [ -f "$(_jsonl)" ]
    run jq -r 'select(.agent_name=="code-executor") | .review_outcome' "$(_jsonl)"
    [ "$status" -eq 0 ]
    [[ "$output" == *"approved"* ]]
}

@test "spec_review fail records a revision_requested metric for spec-author" {
    command -v node >/dev/null 2>&1 || skip "node not available"
    echo '{"phase":"spec_review","status":"fail","findings":["a","b"]}' \
        > "${PROJ}/.autonomous-dev/requests/REQ-T/phase-result-spec_review.json"
    echo '{"phase_history":[{"state":"spec","retry_count":1}]}' \
        > "${PROJ}/.autonomous-dev/requests/REQ-T/state.json"

    record_phase_metric REQ-T "${PROJ}" spec_review fail

    run jq -r 'select(.agent_name=="spec-author") | .review_outcome' "$(_jsonl)"
    [[ "$output" == *"revision_requested"* ]]
}

@test "non-review phase records nothing" {
    record_phase_metric REQ-T "${PROJ}" code pass
    [ ! -f "$(_jsonl)" ]
}

@test "AUTONOMOUS_DEV_DISABLE_METRICS_RECORDING disables recording" {
    export AUTONOMOUS_DEV_DISABLE_METRICS_RECORDING=1
    echo '{"phase":"code_review","status":"pass","findings":[]}' \
        > "${PROJ}/.autonomous-dev/requests/REQ-T/phase-result-code_review.json"
    echo '{"phase_history":[]}' \
        > "${PROJ}/.autonomous-dev/requests/REQ-T/state.json"

    record_phase_metric REQ-T "${PROJ}" code_review pass
    [ ! -f "$(_jsonl)" ]
}
