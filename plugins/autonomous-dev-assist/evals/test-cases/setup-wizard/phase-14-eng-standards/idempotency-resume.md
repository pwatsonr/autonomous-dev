---
phase: 14
case_type: idempotency-resume
expected_outcome: mixed
sub_cases:
  - id: A
    description: existing standards.yaml + operator picks keep → no rewrite
    fixture_repo: tests/fixtures/setup-wizard/repos/ts-with-existing-standards
    operator_inputs:
      existing_decision: k
    assertions:
      - id: A-1
        type: hash-unchanged
        path: "{fixture_repo}/.autonomous-dev/standards.yaml"
      - id: A-2
        type: state-equals
        path: phases.14.status
        expected: complete
  - id: B
    description: existing + operator picks merge → editor opens → merged validates
    fixture_repo: tests/fixtures/setup-wizard/repos/ts-with-existing-standards
    operator_inputs:
      existing_decision: m
    mocks:
      EDITOR: "tests/fixtures/setup-wizard/mock-editor.sh"
    assertions:
      - id: B-1
        type: cli-exit
        command: autonomous-dev standards validate --repo {fixture_repo}
        expected: 0
      - id: B-2
        type: state-equals
        path: phases.14.status
        expected: complete
  - id: C
    description: existing + operator picks replace → overwrite + validate
    fixture_repo: tests/fixtures/setup-wizard/repos/ts-with-existing-standards
    operator_inputs:
      existing_decision: r
    assertions:
      - id: C-1
        type: state-equals
        path: phases.14.status
        expected: complete
  - id: D
    description: third re-run with no changes → probe emits already-complete
    fixture_repo: tests/fixtures/setup-wizard/repos/ts-with-existing-standards
    pre_state:
      "phases.14.status": complete
      "today_dry_run_present": true
    assertions:
      - id: D-1
        type: probe-emits
        probe: phase-14-probe
        expected: already-complete
      - id: D-2
        type: body-not-entered
---

# Phase 14 idempotency-resume eval

Four sub-cases (keep / merge / replace / already-complete) per FR-22.
