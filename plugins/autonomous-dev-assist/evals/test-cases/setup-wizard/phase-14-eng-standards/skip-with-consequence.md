---
phase: 14
case_type: skip-with-consequence
expected_outcome: skipped
config_overrides:
  wizard.skip_phase_14: true
assertions:
  - id: A-1
    description: skip predicate exits 0
    type: shell-exit
    command: bash skip-predicates.sh phase_14_skip_predicate
    expected: 0
  - id: A-2
    description: verbatim consequence text emitted
    type: transcript-contains
    text: |
      Author agents will not be standards-aware; code may violate team conventions silently.
  - id: A-3
    description: phases.14.status == skipped
    type: state-equals
    path: phases.14.status
    expected: skipped
  - id: A-4
    description: standards.yaml not written
    type: file-absent
    path: "{fixture_repo}/.autonomous-dev/standards.yaml"
---

# Phase 14 skip-with-consequence eval

`wizard.skip_phase_14=true`; verifies the skip path emits the
verbatim consequence text and writes no standards.yaml.
