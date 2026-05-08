---
phase: 8
case_type: error-recovery
expected_outcome: complete
fixture:
  initial_discord_response: 401
  retry_discord_response: 200
operator_inputs:
  enable_discord: y
  discord_bot_token_initial: stale-token
  discord_bot_token_retry: fresh-token
  discord_webhook_url: https://discord.com/api/webhooks/00/test
assertions:
  - id: A-1
    description: re-entry prompt observed
    type: regex-match
    pattern: 'token failed validation; please re-enter'
    target: stdout
  - id: A-2
    description: no partial config write before successful validation
    type: state-equals
    key: phases.08.config_keys_written_before_validate
    expected: false
  - id: A-3
    description: phase ultimately completes
    type: state-equals
    key: phases.08.status
    expected: complete
---

# Setup
- Discord users.@me returns 401 on first attempt, 200 on second.

# Run
- Operator enters a stale token; on validation failure, the wizard re-prompts
  via FR-15; operator enters a fresh token; validation succeeds.

# Expected
- Re-entry prompt text matches FR-15.
- No `intake.discord.enabled=true` is written while the stale token is active.
- Final phase status == "complete".
