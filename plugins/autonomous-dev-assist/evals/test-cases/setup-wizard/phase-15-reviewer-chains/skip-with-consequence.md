---
phase: 15
case_type: skip-with-consequence
expected_outcome: skipped
config_overrides:
  wizard.skip_phase_15: true
assertions:
  - id: A-1
    type: shell-exit
    command: bash skip-predicates.sh phase_15_skip_predicate
    expected: 0
  - id: A-2
    type: transcript-contains
    text: |
      Only the generic reviewer will run; security/performance/accessibility findings will not be surfaced automatically.
  - id: A-3
    type: state-equals
    path: phases.15.status
    expected: skipped
  - id: A-4
    type: file-absent
    path: "{fixture_repo}/.autonomous-dev/reviewer-chains.yaml"
  - id: A-5
    type: counter-delta
    target: daemon-hup-counter
    expected: 0
---

# Phase 15 skip-with-consequence eval

`wizard.skip_phase_15=true`: verbatim consequence emitted; no
chain.yaml; SIGHUP delta=0.
