#!/usr/bin/env bash
# Mock claude CLI for testing
# Behavior controlled by MOCK_CLAUDE_BEHAVIOR environment variable:
#   "success" (default): exit 0, write JSON output with cost
#   "failure": exit 1, write error output
#   "turns_exhausted": exit 2, write JSON with max_turns_reached
#   "hang": sleep indefinitely (for timeout tests)
#   "slow": sleep MOCK_CLAUDE_DELAY seconds then exit 0

set -euo pipefail

BEHAVIOR="${MOCK_CLAUDE_BEHAVIOR:-success}"
COST="${MOCK_CLAUDE_COST:-1.50}"
DELAY="${MOCK_CLAUDE_DELAY:-0}"

# Log invocation for test assertions
echo "$@" >> "${MOCK_CLAUDE_LOG:-/tmp/mock-claude-invocations.log}"

case "${BEHAVIOR}" in
    success)
        sleep "${DELAY}"
        jq -n --arg cost "${COST}" '{
            result: "success",
            cost_usd: ($cost | tonumber),
            turns_used: 5,
            reason: "completed"
        }'
        exit 0
        ;;
    failure)
        sleep "${DELAY}"
        echo '{"result": "error", "error": "Something went wrong"}'
        exit 1
        ;;
    turns_exhausted)
        sleep "${DELAY}"
        jq -n --arg cost "${COST}" '{
            result: "max_turns",
            cost_usd: ($cost | tonumber),
            turns_used: 200,
            reason: "max_turns_reached"
        }'
        exit 2
        ;;
    hang)
        sleep 86400
        ;;
    slow)
        sleep "${DELAY}"
        jq -n --arg cost "${COST}" '{
            result: "success",
            cost_usd: ($cost | tonumber),
            turns_used: 10,
            reason: "completed"
        }'
        exit 0
        ;;
esac
