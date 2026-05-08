---
phase: 11
case_type: error-recovery
expected_outcome: failed
sub_cases:
  - id: A
    description: portal binary missing from PATH
    fixture: tests/fixtures/setup-wizard/no-portal-binary
    expected_diagnostic: 'autonomous-dev portal binary missing'
    expected_exit_status: failed
  - id: B
    description: /healthz never responds within 10s
    fixture: tests/fixtures/setup-wizard/portal-503-forever
    expected_diagnostic: 'health check failed; last response'
  - id: C
    description: bind=0.0.0.0 without confirmation string
    operator_inputs:
      bind: 0.0.0.0
      confirmation: 'y'
    expected_diagnostic: 'requires literal "yes-confirm-public-bind"'
assertions:
  - id: A-1
    description: each sub-case exits with actionable diagnostic
    type: regex-match
    pattern: '/autonomous-dev-assist:troubleshoot'
    target: stderr
---

# Setup / Run / Expected
Three sub-cases (A: missing binary; B: never-200 healthz; C: public-bind
refusal). Each exits the phase with an actionable diagnostic referencing
`/autonomous-dev-assist:troubleshoot`. No partial config keys written.
