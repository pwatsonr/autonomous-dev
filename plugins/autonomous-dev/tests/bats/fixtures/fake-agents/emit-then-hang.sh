#!/usr/bin/env bash
# Fake agent used by REQ-000060 tests. Emits, sleeps, emits, sleeps, exits.
# Args: state_file phase agent prompt (positional, matches spawn-session)
#
# Env overrides (for test parameterization):
#   FAKE_LINE_1     default "line1 starting phase ${2:-unknown}"
#   FAKE_SLEEP_1    default 3
#   FAKE_LINE_2     default "line2 middle"
#   FAKE_SLEEP_2    default 0
#   FAKE_EXIT_CODE  default 0

set -uo pipefail
printf '%s\n' "${FAKE_LINE_1:-line1 starting phase ${2:-unknown}}"
sleep "${FAKE_SLEEP_1:-3}"
printf '%s\n' "${FAKE_LINE_2:-line2 middle}"
sleep "${FAKE_SLEEP_2:-0}"
exit "${FAKE_EXIT_CODE:-0}"
