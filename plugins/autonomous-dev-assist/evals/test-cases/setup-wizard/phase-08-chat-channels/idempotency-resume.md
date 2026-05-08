---
phase: 8
case_type: idempotency-resume
expected_outcome: complete
test_steps:
  - run wizard, kill SIGTERM after collect-discord step
  - re-run wizard
assertions:
  - id: A-1
    description: WIZARD_RESUME_STEP set on re-run
    type: env-equals
    var: WIZARD_RESUME_STEP
    expected: validate
  - id: A-2
    description: no duplicate token write to secrets.env
    type: count-equals
    pattern: '^DISCORD_BOT_TOKEN='
    target: secrets.env
    expected: 1
  - id: A-3
    description: phase ultimately completes
    type: state-equals
    key: phases.08.status
    expected: complete
---

# Setup
- Phase 8 starts. Operator enables Discord, enters a token, then SIGTERM
  fires before `validate` step runs.

# Run
- Re-run `autonomous-dev wizard --phase 8`.

# Expected
- Orchestrator sets `WIZARD_RESUME_STEP=validate`.
- Token in secrets.env is reused (single line); no duplicate.
- Phase eventually completes (validate → probe → write-config → sighup).
