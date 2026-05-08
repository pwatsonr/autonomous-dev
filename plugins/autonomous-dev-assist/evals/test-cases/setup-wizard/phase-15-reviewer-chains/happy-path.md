---
phase: 15
case_type: happy-path
expected_outcome: complete
fixture_repo: tests/fixtures/setup-wizard/repos/ts-greenfield
operator_inputs:
  enable_security: y
  weight_security: 1
  threshold_security: high
  enable_performance: y
  weight_performance: 2
  threshold_performance: medium
  enable_accessibility: n
assertions:
  - id: A-1
    description: chain.yaml exists
    type: file-exists
    path: "{fixture_repo}/.autonomous-dev/reviewer-chains.yaml"
  - id: A-2
    description: chain.yaml lists security before performance
    type: regex-match
    target: "{fixture_repo}/.autonomous-dev/reviewer-chains.yaml"
    pattern: 'id: security[\s\S]+id: performance'
  - id: A-3
    description: dry-run dispatches both specialists
    type: json-contains
    target: stdout-dry-run
    path: dispatched_specialists[*].id
    expected: ["security", "performance"]
  - id: A-4
    description: cost-counter delta is 0 (TDD-020 dry-run no-LLM contract)
    type: counter-delta
    target: tdd-020-cost-counter
    expected: 0
  - id: A-5
    description: forward-reference banner emitted exactly once
    type: regex-match-count
    target: transcript
    pattern: 'NOTE: This phase configures specialist reviewer chains for DRY-RUN'
    expected_count: 1
  - id: A-6
    description: SIGHUP delta 1
    type: counter-delta
    target: daemon-hup-counter
    expected: 1
  - id: A-7
    description: dry-run isolation (fs-snapshot diff allow-list only)
    type: fs-snapshot-diff
    allowlist:
      - "{fixture_repo}/.autonomous-dev/reviewer-chains.yaml"
      - "~/.autonomous-dev/wizard-state.json"
      - "~/.autonomous-dev/wizard-checkpoint.json"
      - "~/.autonomous-dev/logs/wizard.log"
---

# Phase 15 happy-path eval

Enable security (weight=1) and performance (weight=2); skip others.
Verify chain.yaml has deterministic order, dry-run dispatches both,
cost-counter==0, forward-reference banner emitted exactly once.
