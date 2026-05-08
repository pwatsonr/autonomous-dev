---
phase: 13
case_type: happy-path
expected_outcome: complete
fixture_repo: tests/fixtures/setup-wizard/repos/local-only
fixture_catalog: plugins/autonomous-dev/config/request-types.json
fixture_handler: tests/fixtures/setup-wizard/handlers/policy-check.sh
governance_per_request_cost_cap_usd: 8
operator_inputs:
  hotfix: { enable: y, cost_cap: 10 }
  exploration: { enable: y, cost_cap: 10 }
  refactor: { enable: N }
  custom_hook:
    point: code-pre-write
    handler_path: tests/fixtures/setup-wizard/handlers/policy-check.sh
    handler_id: policy-check
    confirmation: "yes"
assertions:
  - id: A-1
    description: hotfix enabled with cost cap 10
    type: config-equals
    key: request_types.hotfix.cost_cap_usd
    expected: 10
  - id: A-2
    description: exploration enabled with cost cap 10
    type: config-equals
    key: request_types.exploration.cost_cap_usd
    expected: 10
  - id: A-3
    description: hook registered
    type: config-key-exists
    key: hooks.code-pre-write.policy-check
  - id: A-4
    description: dry-run first transition observed
    type: regex-match
    target: stdout
    pattern: '"first_state_transition"\s*:\s*\{[^}]*"request_type"\s*:\s*"hotfix"'
  - id: A-5
    description: store-writes 0 (independent fs-snapshot diff)
    type: scanner-count
    target: daemon-store-snapshot-diff
    expected: 0
  - id: A-6
    description: chat-mock messages 0
    type: scanner-count
    target: chat-mock-counter
    expected: 0
  - id: A-7
    description: chain dispatches 0
    type: scanner-count
    target: chain-mock-counter
    expected: 0
  - id: A-8
    description: SIGHUP delta 1
    type: counter-delta
    target: daemon-hup-counter
    expected: 1
  - id: A-9
    description: state file complete
    type: state-equals
    key: phases.13.status
    expected: complete
---

# Setup
- Operator config: `governance.per_request_cost_cap_usd=8`.
- `request-types.json` catalog includes hotfix/exploration/refactor.
- Fixture handler `tests/fixtures/setup-wizard/handlers/policy-check.sh`
  is executable (mode 0755).
- Mocks: chat-channel mock + reviewer-chain mock from SPEC-033-1-04
  infrastructure; daemon stub returning canned `--observe-first-transition`
  JSON for hotfix.

# Run
1. `autonomous-dev wizard --phase 13` against the fixture.
2. Operator inputs:
   - hotfix=y, cost_cap=10, accept defaults for trust_threshold + reviewers.
   - exploration=y, cost_cap=10, accept defaults.
   - refactor=N.
   - custom-hook=y, point=code-pre-write, path=`<fixture-handler>`,
     id=policy-check, confirmation="yes".

# Expected
- All 9 assertions pass.
- Defense-in-depth: independent fs-snapshot diff (A-5) confirms 0
  daemon-store writes regardless of the daemon's self-reported counts.
