---
phase: 14
case_type: error-recovery
expected_outcome: mixed
sub_cases:
  - id: A
    description: detection unknown → operator manually picks
    fixture_repo: tests/fixtures/setup-wizard/repos/polyglot-unknown
    operator_inputs:
      detection_confirm: ts
      pack_choice: typescript-strict
    assertions:
      - id: A-1
        type: state-equals
        path: phases.14.status
        expected: complete
  - id: B
    description: wrong pack (TS repo + python-pep8) → validate fails → re-pick
    fixture_repo: tests/fixtures/setup-wizard/repos/ts-greenfield
    operator_inputs:
      pack_choice_initial: python-pep8
      pack_choice_repick: typescript-strict
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
    description: pack template missing → phase exits with troubleshoot pointer
    fixture_pack: nonexistent-pack
    assertions:
      - id: C-1
        type: shell-exit-nonzero
      - id: C-2
        type: transcript-contains
        text: "/autonomous-dev-assist:troubleshoot"
---

# Phase 14 error-recovery eval

Three sub-cases:
- A: detect-language returns "unknown"; operator manually picks ts.
- B: wrong pack chosen; validate fails; operator re-picks; phase completes.
- C: pack template file absent on disk; phase exits with troubleshoot pointer.
