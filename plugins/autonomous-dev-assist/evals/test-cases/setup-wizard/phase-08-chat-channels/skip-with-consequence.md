---
phase: 8
case_type: skip-with-consequence
expected_outcome: skipped
operator_inputs:
  wizard.cli_only: "true"
assertions:
  - id: A-1
    description: verbatim consequence text emitted
    type: regex-match
    pattern: 'You will only be able to submit requests via the CLI'
    target: stdout
  - id: A-2
    description: phases.08.status == skipped
    type: state-equals
    key: phases.08.status
    expected: skipped
  - id: A-3
    description: no chat tokens in secrets.env
    type: regex-no-match
    pattern: 'DISCORD_BOT_TOKEN|SLACK_BOT_TOKEN'
    target: secrets.env
---

# Setup
- Operator sets `wizard.cli_only=true` in config (forces is_cli_only_mode skip).

# Run
- `autonomous-dev wizard --phase 8`.

# Expected
- Skip predicate exits 0; orchestrator emits the verbatim consequence text;
  phase status set to "skipped"; no chat-token entries in secrets.env.
