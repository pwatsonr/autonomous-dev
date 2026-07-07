#!/usr/bin/env bash
# observability_events.sh -- Typed event emitters (REQ-000060 / issue #635)
# Part of TDD: docs/tdd/REQ-000060-req-000060.md §7
#
# Dependencies: jq (1.6+), event_logger.sh
# Sources: session_transcript.sh (for shared helpers)

set -uo pipefail
# NOTE: `-e` is deliberately NOT set at file scope. Observability MUST NOT
# wedge the supervisor on partial failure (TDD §7.2).

# Source shared helpers if not already loaded
if ! declare -F atomic_write_json >/dev/null 2>&1; then
    _OBS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    # shellcheck source=session_transcript.sh
    source "${_OBS_DIR}/session_transcript.sh"
fi

# Source event_logger for event_append
if ! declare -F event_append >/dev/null 2>&1; then
    _EL_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib/state" && pwd)/event_logger.sh"
    if [[ -f "$_EL_PATH" ]]; then
        # shellcheck source=../../lib/state/event_logger.sh
        source "$_EL_PATH"
    fi
fi

# ---------------------------------------------------------------------------
# _oe_timestamp() -> stdout: ISO-8601 UTC timestamp (seconds precision)
#   Matches the rest of events.jsonl (no millisecond precision).
# ---------------------------------------------------------------------------
_oe_timestamp() {
    date -u +%Y-%m-%dT%H:%M:%SZ
}

# ---------------------------------------------------------------------------
# emit_session_hung_suspected(events_file, request_id, session_id,
#                             phase, reason, evidence_json, snapshot_path)
#   -> 0|non-zero
#
# Builds JSON conforming to session_hung_suspected.schema.json.
# Delegates to event_append. Returns 1 on failure; callers should `|| true`.
# ---------------------------------------------------------------------------
emit_session_hung_suspected() {
    local events_file="$1" request_id="$2" session_id="$3"
    local phase="$4" reason="$5"
    local evidence_json="${6:-}"
    [[ -z "$evidence_json" ]] && evidence_json="{}"
    local snapshot_path="${7:-}"

    local ts
    ts="$(_oe_timestamp)"

    # Build payload
    local payload
    payload="$(jq -cn \
        --argjson sv 1 \
        --arg event_type "session_hung_suspected" \
        --arg ts "$ts" \
        --arg req_id "$request_id" \
        --arg sess_id "$session_id" \
        --arg phase "$phase" \
        --arg reason "$reason" \
        --argjson evidence "$evidence_json" \
        --arg snap_path "$snapshot_path" \
        '{
          schema_version: $sv,
          event_type: $event_type,
          timestamp: $ts,
          request_id: $req_id,
          session_id: $sess_id,
          phase: $phase,
          reason: $reason,
          evidence: $evidence,
          snapshot_path: (if $snap_path == "" then null else $snap_path end)
        }' 2>/dev/null)" || {
        echo "emit_session_hung_suspected: failed to build payload" >&2
        return 1
    }

    if ! declare -F event_append >/dev/null 2>&1; then
        echo "emit_session_hung_suspected: event_append not available" >&2
        return 1
    fi

    event_append "$events_file" "$payload" || {
        echo "emit_session_hung_suspected: event_append failed (request_id=${request_id})" >&2
        return 1
    }
    return 0
}

# ---------------------------------------------------------------------------
# emit_session_stuck(events_file, request_id, session_id, phase,
#                    reason, snapshot_path, elapsed_ms) -> 0|non-zero
# ---------------------------------------------------------------------------
emit_session_stuck() {
    local events_file="$1" request_id="$2" session_id="$3"
    local phase="$4" reason="$5" snapshot_path="${6:-}" elapsed_ms="${7:-0}"

    local ts
    ts="$(_oe_timestamp)"

    local payload
    payload="$(jq -cn \
        --argjson sv 1 \
        --arg event_type "session_stuck" \
        --arg ts "$ts" \
        --arg req_id "$request_id" \
        --arg sess_id "$session_id" \
        --arg phase "$phase" \
        --arg reason "$reason" \
        --arg snap_path "$snapshot_path" \
        --argjson elapsed "$elapsed_ms" \
        '{
          schema_version: $sv,
          event_type: $event_type,
          timestamp: $ts,
          request_id: $req_id,
          session_id: $sess_id,
          phase: $phase,
          reason: $reason,
          snapshot_path: (if $snap_path == "" then null else $snap_path end),
          elapsed_ms: $elapsed
        }' 2>/dev/null)" || {
        echo "emit_session_stuck: failed to build payload" >&2
        return 1
    }

    if ! declare -F event_append >/dev/null 2>&1; then
        echo "emit_session_stuck: event_append not available" >&2
        return 1
    fi

    event_append "$events_file" "$payload" || {
        echo "emit_session_stuck: event_append failed (request_id=${request_id})" >&2
        return 1
    }
    return 0
}

# ---------------------------------------------------------------------------
# emit_session_recovered_after_stall(events_file, request_id, session_id,
#                                    phase, suspected_count) -> 0|non-zero
# ---------------------------------------------------------------------------
emit_session_recovered_after_stall() {
    local events_file="$1" request_id="$2" session_id="$3"
    local phase="$4" suspected_count="${5:-0}"

    local ts
    ts="$(_oe_timestamp)"

    local payload
    payload="$(jq -cn \
        --argjson sv 1 \
        --arg event_type "session_recovered_after_stall" \
        --arg ts "$ts" \
        --arg req_id "$request_id" \
        --arg sess_id "$session_id" \
        --arg phase "$phase" \
        --argjson sc "$suspected_count" \
        '{
          schema_version: $sv,
          event_type: $event_type,
          timestamp: $ts,
          request_id: $req_id,
          session_id: $sess_id,
          phase: $phase,
          suspected_count: $sc
        }' 2>/dev/null)" || {
        echo "emit_session_recovered_after_stall: failed to build payload" >&2
        return 1
    }

    if ! declare -F event_append >/dev/null 2>&1; then
        echo "emit_session_recovered_after_stall: event_append not available" >&2
        return 1
    fi

    event_append "$events_file" "$payload" || {
        echo "emit_session_recovered_after_stall: event_append failed (request_id=${request_id})" >&2
        return 1
    }
    return 0
}
