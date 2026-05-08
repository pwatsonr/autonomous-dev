---
phase: 15
case_type: idempotency-resume
expected_outcome: mixed
sub_cases:
  - id: A
    description: chain.yaml hash matches → already-complete
    pre_state:
      "phases.15.status": complete
      "reviewer_chains.last_dry_run_at": today
    assertions:
      - id: A-1
        type: probe-emits
        probe: phase-15-probe
        expected: already-complete
      - id: A-2
        type: body-not-entered
  - id: B
    description: existing different-hash + operator picks keep → no rewrite
    operator_inputs:
      existing_decision: k
    assertions:
      - id: B-1
        type: hash-unchanged
        path: "{fixture_repo}/.autonomous-dev/reviewer-chains.yaml"
      - id: B-2
        type: state-equals
        path: phases.15.status
        expected: complete
  - id: C
    description: existing different-hash + operator picks replace → overwrite
    operator_inputs:
      existing_decision: r
    assertions:
      - id: C-1
        type: state-equals
        path: phases.15.status
        expected: complete
  - id: D
    description: SIGTERM mid-enumerate; resume at next un-prompted specialist; no partial chain.yaml
    fixture_pre:
      sigterm_after_specialist: 2
    assertions:
      - id: D-1
        type: file-absent
        path: "{fixture_repo}/.autonomous-dev/reviewer-chains.yaml"
      - id: D-2
        description: next run resumes at specialist 3
        type: transcript-contains
        text: "Enable specialist 'accessibility'"
---

# Phase 15 idempotency-resume eval

Four sub-cases (already-complete / keep / replace / mid-enumerate
SIGTERM) per FR-22.
