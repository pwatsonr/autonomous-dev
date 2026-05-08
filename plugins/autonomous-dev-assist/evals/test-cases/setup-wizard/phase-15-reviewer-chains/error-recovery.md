---
phase: 15
case_type: error-recovery
expected_outcome: mixed
sub_cases:
  - id: A
    description: catalog file missing → diagnostic + abort
    fixture_pre:
      remove_file: plugins/autonomous-dev/config/specialist-reviewers.json
    assertions:
      - id: A-1
        type: shell-exit-nonzero
      - id: A-2
        type: transcript-contains
        text: "specialist-reviewers catalog missing"
  - id: B
    description: non-numeric weight → re-prompt up to 3 times
    operator_inputs:
      weight_security: "abc"
      weight_security_retry1: "def"
      weight_security_retry2: "ghi"
    assertions:
      - id: B-1
        type: shell-exit-nonzero
      - id: B-2
        type: transcript-contains
        text: "non-numeric weight after 3 attempts"
  - id: C
    description: existing chain.yaml malformed → operator picks replace
    fixture_pre:
      file_content:
        path: "{fixture_repo}/.autonomous-dev/reviewer-chains.yaml"
        content: "{not valid yaml ::::"
    operator_inputs:
      existing_decision: r
    assertions:
      - id: C-1
        type: state-equals
        path: phases.15.status
        expected: complete
---

# Phase 15 error-recovery eval

Three sub-cases (catalog-missing, non-numeric weight, malformed
chain.yaml) per FR-21.
