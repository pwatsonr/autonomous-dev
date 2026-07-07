#!/usr/bin/env bash
# session_transcript.sh -- Streaming transcript writer + atomic JSON helper (REQ-000060 / issue #635)
# Part of TDD: docs/tdd/REQ-000060-req-000060.md §2
#
# Dependencies: jq (1.6+), coreutils (stdbuf/gstdbuf, optional)
# Sources: (none — this is the first-loaded file; others source it)

set -uo pipefail
# NOTE: `-e` is deliberately NOT set at file scope. Individual functions
# document their exit-code semantics. Observability MUST NOT wedge the
# supervisor on partial failure (TDD §7.2).

# ---------------------------------------------------------------------------
# now_ms() -> stdout: integer milliseconds since epoch
#   Portability: gdate (Homebrew coreutils) > GNU date > BSD date fallback.
# ---------------------------------------------------------------------------
now_ms() {
    if command -v gdate >/dev/null 2>&1; then
        gdate +%s%3N
    elif date +%N 2>/dev/null | grep -q '^[0-9]'; then
        date +%s%3N
    else
        # macOS BSD date: no %N — pad seconds with 000
        echo "$(date +%s)000"
    fi
}

# ---------------------------------------------------------------------------
# iso_ms() -> stdout: ISO-8601 UTC timestamp with millisecond precision
#   Filename form uses '-' between H, M, S (filesystem-safe).
#   This function always emits the canonical form with ':'.
#   The caller that needs the filesystem-safe form substitutes ':' -> '-'.
# ---------------------------------------------------------------------------
iso_ms() {
    if command -v gdate >/dev/null 2>&1; then
        gdate -u +%Y-%m-%dT%H:%M:%S.%3NZ
    else
        # BSD date fallback: Python 3.7+ is already a plugin dep
        python3 -c "import datetime; print(datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3]+'Z')"
    fi
}

# ---------------------------------------------------------------------------
# iso_ms_filesafe() -> stdout: filesystem-safe ISO-8601 UTC timestamp
#   Uses '-' between hours, minutes, seconds.
# ---------------------------------------------------------------------------
iso_ms_filesafe() {
    if command -v gdate >/dev/null 2>&1; then
        gdate -u +%Y-%m-%dT%H-%M-%S.%3NZ
    else
        python3 -c "import datetime; print(datetime.datetime.utcnow().strftime('%Y-%m-%dT%H-%M-%S.%f')[:-3]+'Z')"
    fi
}

# ---------------------------------------------------------------------------
# atomic_write_json(path, content) -> 0|non-zero
#   Writes content to a temporary file in the same directory, then renames.
#   Never leaves a partial file at `path`.
#   Sets file permissions to 0600; parent dir to 0700.
# ---------------------------------------------------------------------------
atomic_write_json() {
    local path="$1" content="$2"
    local dir tmp
    dir="$(dirname "$path")"
    # Only set 0700 on newly-created directories; do NOT clobber permissions
    # on an existing directory (e.g. a read-only test dir must stay read-only).
    if [[ ! -d "$dir" ]]; then
        mkdir -p "$dir" 2>/dev/null || return 1
        chmod 0700 "$dir" 2>/dev/null || true
    fi
    tmp="${path}.tmp.$$.$(date +%s)"
    printf '%s\n' "$content" > "$tmp" || { rm -f "$tmp"; return 1; }
    chmod 0600 "$tmp" 2>/dev/null || true
    mv -f "$tmp" "$path" || { rm -f "$tmp"; return 1; }
    return 0
}

# ---------------------------------------------------------------------------
# run_streamed_session(timeout_bin, timeout_secs, spawn_script,
#                      state_file, phase, agent, prompt, output_file) -> int
#
# Arguments (all positional, all required — pass "" for empty):
#   $1 timeout_bin   Absolute path to `timeout`/`gtimeout`, or "" for no cap.
#   $2 timeout_secs  Integer seconds. Ignored when $1 is "".
#   $3 spawn_script  Absolute path to spawn-session.sh.
#   $4 state_file    Passed through as spawn-session $1.
#   $5 phase         Passed through as spawn-session $2.
#   $6 agent         Passed through as spawn-session $3.
#   $7 prompt        Passed through as spawn-session $4.
#   $8 output_file   Absolute path to the transcript. tee -a target.
#
# Returns:
#   The exit code of the spawn-script (PIPESTATUS[0]). tee's exit code
#   is ignored. A timeout propagates as 124 in the GNU way.
#
# Side effects:
#   - Appends to $output_file (never truncates).
#   - Writes nothing else. Never touches stdin.
# ---------------------------------------------------------------------------
run_streamed_session() {
    local timeout_bin="$1" timeout_secs="$2" spawn_script="$3"
    local state_file="$4" phase="$5" agent="$6" prompt="$7"
    local output_file="$8"

    local stdbuf_bin=""
    if command -v gstdbuf >/dev/null 2>&1; then
        stdbuf_bin="$(command -v gstdbuf)"
    elif command -v stdbuf >/dev/null 2>&1; then
        stdbuf_bin="$(command -v stdbuf)"
    fi

    local -a runner=()
    if [[ -n "$timeout_bin" ]]; then
        runner=("$timeout_bin" --kill-after=10s "$timeout_secs")
    fi
    if [[ -n "$stdbuf_bin" ]]; then
        runner+=("$stdbuf_bin" -oL -eL)
    fi
    runner+=(bash "$spawn_script" "$state_file" "$phase" "$agent" "$prompt")

    "${runner[@]}" 2>&1 | tee -a "$output_file" > /dev/null
    return "${PIPESTATUS[0]}"
}
