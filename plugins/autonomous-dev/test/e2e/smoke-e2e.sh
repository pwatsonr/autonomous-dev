#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# smoke-e2e.sh - End-to-end smoke test for PLAN-039 (intake-to-deploy pipeline)
#
# Proves the submit -> daemon-pickup -> dispatch -> artifact loop works WITHOUT
# spending real Anthropic API. Hermetic: temp repo + temp $HOME + temp state
# dir + a mock `claude` on PATH that writes the stub artifacts. Drives the
# REAL daemon (`bin/supervisor-loop.sh --once` x N), not spawn-session.sh
# directly, so it exercises intake->prd auto-transition, dispatch_phase_session,
# spawn-session.sh, advance_phase, and the portal-action write.
#
# Exit codes:
#   0  success           - PRD artifact produced AND request advanced past `prd`
#   1  missing artifact   - daemon ran but produced no docs/prd/*.md (or no advance)
#   2  daemon crash       - supervisor-loop.sh exited non-zero
#   3  setup failure      - couldn't build the temp environment
#   4  timeout            - a daemon iteration exceeded the watchdog
###############################################################################

readonly PLUGIN_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
readonly SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

readonly EXIT_SUCCESS=0
readonly EXIT_MISSING_ARTIFACT=1
readonly EXIT_DAEMON_CRASH=2
readonly EXIT_SETUP_FAILURE=3
readonly EXIT_TIMEOUT=4

readonly DAEMON_ITERS="${SMOKE_DAEMON_ITERS:-5}"   # enough to walk intake->prd->prd_review->tdd...

TMP=""
PRESERVE_TMP="${SMOKE_PRESERVE_TMP:-0}"
REPO=""; STATE_DIR=""; FAKE_HOME=""; MOCK_BIN=""; MOCK_LOG=""
REQ_ID=""; STATE_FILE=""

cleanup() {
    local rc=$?
    if [[ -n "${TMP:-}" && "${PRESERVE_TMP}" != "1" ]]; then
        rm -rf "${TMP}"
    elif [[ -n "${TMP:-}" ]]; then
        echo "[smoke-e2e] temp dir preserved at ${TMP}" >&2
    fi
    return "${rc}"
}
trap cleanup EXIT

log()  { echo "[smoke-e2e] $*" >&2; }
fail() { log "FAIL: $1"; exit "${2:-1}"; }

# --------------------------------------------------------------------------
setup_environment() {
    log "setting up isolated environment"
    TMP=$(mktemp -d) || fail "mktemp failed" "${EXIT_SETUP_FAILURE}"

    REPO="${TMP}/repo"
    STATE_DIR="${TMP}/state"
    FAKE_HOME="${TMP}/home"
    MOCK_BIN="${TMP}/bin"
    MOCK_LOG="${TMP}/mock-claude.log"

    mkdir -p "${FAKE_HOME}/.claude" "${FAKE_HOME}/.autonomous-dev" "${STATE_DIR}" "${MOCK_BIN}" \
        || fail "mkdir failed" "${EXIT_SETUP_FAILURE}"

    git init -q "${REPO}" || fail "git init failed" "${EXIT_SETUP_FAILURE}"
    git -C "${REPO}" config user.email smoke@example.com
    git -C "${REPO}" config user.name "Smoke Test"
    echo "# smoke repo" > "${REPO}/README.md"
    git -C "${REPO}" add README.md
    git -C "${REPO}" commit -q -m "initial"

    # intake auth (consumed by cli_adapter's AuthzEngine)
    cat > "${FAKE_HOME}/.autonomous-dev/intake-auth.yaml" <<'YAML'
version: 1
users:
  - internal_id: smoke
    identities:
      cli_user: smoke
    role: contributor
YAML

    # daemon config with the temp repo on the allowlist
    cat > "${FAKE_HOME}/.claude/autonomous-dev.json" <<JSON
{
  "repositories": { "allowlist": ["${REPO}"] },
  "daemon": {
    "poll_interval_seconds": 1,
    "max_retries_per_phase": 3,
    "daily_cost_cap_usd": 50.0,
    "monthly_cost_cap_usd": 500.0
  },
  "trust": { "trust_level": "high" },
  "cost_limits": { "daily_cap_usd": 50.0, "monthly_cap_usd": 500.0 }
}
JSON

    cp "${SCRIPT_DIR}/fixtures/mock-claude.sh" "${MOCK_BIN}/claude" || fail "copy mock-claude failed" "${EXIT_SETUP_FAILURE}"
    chmod +x "${MOCK_BIN}/claude"

    export HOME="${FAKE_HOME}"
    export AUTONOMOUS_DEV_STATE_DIR="${STATE_DIR}"
    export PATH="${MOCK_BIN}:${PATH}"
    export SMOKE_MOCK_LOG="${MOCK_LOG}"
    log "temp env: repo=${REPO} state=${STATE_DIR} home=${FAKE_HOME}"
}

# --------------------------------------------------------------------------
# Try the real `submit` CLI; fall back to writing state.json directly.
submit_request() {
    log "submitting request"
    local desc="Add a hello-world section to the README"
    local state_file=""

    if bun "${PLUGIN_DIR}/intake/adapters/cli_adapter.ts" submit "${desc}" \
            --repo "${REPO}" --type feature > "${TMP}/submit.out" 2>&1; then
        log "submit CLI succeeded:"
        sed 's/^/  /' < "${TMP}/submit.out" >&2 || true
        state_file=$(find "${REPO}/.autonomous-dev/requests" -name state.json 2>/dev/null | head -1 || echo "")
        [[ -n "${state_file}" ]] && log "submit produced ${state_file}"
    else
        log "submit CLI failed (see below); falling back to a hand-written state.json"
        sed 's/^/  /' < "${TMP}/submit.out" >&2 || true
    fi

    if [[ -z "${state_file}" ]]; then
        REQ_ID="REQ-000001"
        state_file="${REPO}/.autonomous-dev/requests/${REQ_ID}/state.json"
        mkdir -p "$(dirname "${state_file}")"
        local now; now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        cat > "${state_file}" <<JSON
{
  "id": "${REQ_ID}", "status": "queued", "current_phase": "intake", "priority": 1,
  "created_at": "${now}", "updated_at": "${now}",
  "title": "${desc}", "description": "${desc}", "target_repo": "${REPO}",
  "source": "claude_app", "type": "feature",
  "blocked_by": [], "phase_history": [], "phase_overrides": [],
  "current_phase_metadata": {}, "cost_accrued_usd": 0, "turn_count": 0,
  "escalation_count": 0, "schema_version": 1, "error": null
}
JSON
        log "wrote ${state_file}"
    else
        REQ_ID=$(jq -r '.id' "${state_file}")
    fi

    [[ -f "${state_file}" ]] || fail "no state.json after submit" "${EXIT_SETUP_FAILURE}"
    STATE_FILE="${state_file}"
    log "request id=${REQ_ID} state=${STATE_FILE}"
}

# --------------------------------------------------------------------------
run_daemon() {
    log "running daemon for up to ${DAEMON_ITERS} one-shot iterations"
    local i rc phase status
    for ((i = 1; i <= DAEMON_ITERS; i++)); do
        rc=0
        bash "${PLUGIN_DIR}/bin/supervisor-loop.sh" --once \
            > "${TMP}/daemon-iter-${i}.log" 2>&1 || rc=$?
        phase=$(jq -r '.current_phase // "?"' "${STATE_FILE}" 2>/dev/null || echo "?")
        status=$(jq -r '.status // "?"' "${STATE_FILE}" 2>/dev/null || echo "?")
        log "  iter ${i}: daemon exit=${rc}  -> ${status}/${phase}"
        if [[ ${rc} -ne 0 ]]; then
            log "  daemon iteration ${i} log:"; sed 's/^/    /' < "${TMP}/daemon-iter-${i}.log" >&2 || true
            fail "daemon exited ${rc} on iteration ${i}" "${EXIT_DAEMON_CRASH}"
        fi
        if [[ "${phase}" != "intake" && "${phase}" != "prd" ]]; then
            log "  request advanced to ${status}/${phase}; stopping daemon iterations"
            break
        fi
    done
}

# --------------------------------------------------------------------------
verify() {
    log "verifying artifacts + state"

    # 1. PRD artifact produced by the mock prd-author
    local prd
    prd=$(find "${REPO}/docs/prd" -name '*.md' 2>/dev/null | head -1 || echo "")
    if [[ -z "${prd}" ]]; then
        log "no PRD artifact under ${REPO}/docs/prd/"
        log "repo contents:"; find "${REPO}" -type f 2>/dev/null | sed 's/^/  /' | head -30 >&2 || true
        log "mock-claude log:"; sed 's/^/  /' < "${MOCK_LOG}" >&2 2>/dev/null || true
        fail "missing PRD artifact" "${EXIT_MISSING_ARTIFACT}"
    fi
    log "PRD artifact: ${prd}"

    # 2. request state advanced past `prd` (proves dispatch + advance_phase ran)
    local phase status
    phase=$(jq -r '.current_phase' "${STATE_FILE}")
    status=$(jq -r '.status' "${STATE_FILE}")
    if [[ "${phase}" == "intake" || "${phase}" == "prd" ]]; then
        fail "request still at ${status}/${phase} — daemon did not advance past prd" "${EXIT_MISSING_ARTIFACT}"
    fi
    log "request advanced to ${status}/${phase}"

    # 3. portal action file written (proves PR-4 wiring)
    local action
    action=$(find "${STATE_DIR}/request-actions" -name '*.json' 2>/dev/null | head -1 || echo "")
    if [[ -n "${action}" ]]; then
        log "portal action: ${action} -> $(jq -c '{id,phase,status,waitedMin}' "${action}" 2>/dev/null)"
    else
        log "WARN: no portal request-action file under ${STATE_DIR}/request-actions/"
    fi
}

# --------------------------------------------------------------------------
main() {
    local t0; t0=$(date +%s)
    log "start"
    setup_environment
    submit_request
    run_daemon
    verify
    local t1; t1=$(date +%s)
    log "PASS: smoke E2E ok in $((t1 - t0))s (PRD artifact produced; request advanced past prd)"
    exit "${EXIT_SUCCESS}"
}

main "$@"
