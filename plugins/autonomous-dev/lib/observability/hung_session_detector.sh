#!/usr/bin/env bash
# hung_session_detector.sh -- Pure hung-session detector (REQ-000060 / issue #635)
# Part of TDD: docs/tdd/REQ-000060-req-000060.md §5
#
# Dependencies: jq (1.6+)
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

# ---------------------------------------------------------------------------
# detect_hung(sample_json, baselines_json, cfg_json) -> stdout: verdict JSON
#
# Pure function of three JSON string arguments. Writes exactly ONE line
# of JSON to stdout. Reads NO files, writes NO files, spawns nothing
# other than `jq`.
#
# Argument JSON shapes:
#   sample_json    per session_progress schema (may omit `anomaly`)
#   baselines_json {p50_ms, p95_ms, mean_ms, sample_count} (may be {})
#   cfg_json       {silent_stall_s, anomaly_multiplier, min_baseline_samples}
#
# Output shape:
#   {"verdict": "ok"|"suspected",
#    "reason":  "silent_stall"|"elapsed_over_p95"|null,
#    "evidence": {
#      "silent_seconds":       <int>,
#      "elapsed_ms":           <int>,
#      "p95_ms":               <int|null>,
#      "elapsed_vs_p95_ratio": <number|null>,
#      "sample_count":         <int>
#    }}
#
# Precedence when both conditions fire: silent_stall wins.
# Return: 0 always (pure). Non-zero (2) only if inputs are invalid JSON.
# ---------------------------------------------------------------------------
detect_hung() {
    local sample_json="$1" baselines_json="$2" cfg_json="$3"

    # Validate inputs are valid JSON
    if ! echo "$sample_json" | jq empty 2>/dev/null; then
        echo '{"verdict":"ok","reason":null,"evidence":{}}'
        return 2
    fi
    if ! echo "$baselines_json" | jq empty 2>/dev/null; then
        echo '{"verdict":"ok","reason":null,"evidence":{}}'
        return 2
    fi
    if ! echo "$cfg_json" | jq empty 2>/dev/null; then
        echo '{"verdict":"ok","reason":null,"evidence":{}}'
        return 2
    fi

    # Merge all three JSON blobs and compute verdict with jq
    local verdict
    verdict="$(jq -cn \
        --argjson sample "$sample_json" \
        --argjson baselines "$baselines_json" \
        --argjson cfg "$cfg_json" \
        '
        # Extract config values with defaults
        ($cfg.silent_stall_s         // 300)   as $stall
        | ($cfg.anomaly_multiplier   // 3.0)   as $mult
        | ($cfg.min_baseline_samples // 5)     as $min
        # Extract sample values
        | ($sample.transcript.silent_seconds   // 0)    as $silent
        | ($sample.elapsed_ms                  // 0)    as $elapsed
        # Extract baseline values
        | ($baselines.p95_ms         // null)  as $p95
        | ($baselines.sample_count   // 0)     as $n
        # Compute ratio (null when p95 is null/zero)
        | (if $p95 != null and $p95 > 0
           then ($elapsed / $p95)
           else null
           end) as $ratio
        # Apply truth table
        | if $silent >= $stall then
            {
              verdict: "suspected",
              reason: "silent_stall",
              evidence: {
                silent_seconds: $silent,
                elapsed_ms: $elapsed,
                p95_ms: $p95,
                elapsed_vs_p95_ratio: $ratio,
                sample_count: $n
              }
            }
          elif ($p95 != null and $n >= $min and $ratio != null and $ratio >= $mult) then
            {
              verdict: "suspected",
              reason: "elapsed_over_p95",
              evidence: {
                silent_seconds: $silent,
                elapsed_ms: $elapsed,
                p95_ms: $p95,
                elapsed_vs_p95_ratio: $ratio,
                sample_count: $n
              }
            }
          else
            {
              verdict: "ok",
              reason: null,
              evidence: {
                silent_seconds: $silent,
                elapsed_ms: $elapsed,
                p95_ms: $p95,
                elapsed_vs_p95_ratio: $ratio,
                sample_count: $n
              }
            }
          end
        ' 2>/dev/null)" || {
        echo '{"verdict":"ok","reason":null,"evidence":{}}'
        return 2
    }

    echo "$verdict"
    return 0
}
