---
phase: 13
case_type: skip-with-consequence
expected_outcome: skipped
operator_config:
  wizard.skip_phase_13: true
assertions:
  - id: A-1
    description: verbatim consequence text emitted (FR-4 of SPEC-033-2-04)
    type: regex-match
    target: stdout
    pattern: 'Only the default request type is active; hotfix/exploration/refactor are unavailable until you run `wizard --phase 13`\.'
  - id: A-2
    description: status=skipped
    type: state-equals
    key: phases.13.status
    expected: skipped
  - id: A-3
    description: no request_types.* keys written
    type: config-key-absent
    key: request_types.hotfix.enabled
  - id: A-4
    description: no hooks.* keys written
    type: config-key-absent
    key: hooks.code-pre-write
  - id: A-5
    description: SIGHUP delta 0
    type: counter-delta
    target: daemon-hup-counter
    expected: 0
---

# Setup
- Operator sets `wizard.skip_phase_13=true` in config.
- No fixture handler required; phase exits before any prompts.

# Run
- `autonomous-dev wizard --phase 13`.

# Expected
- Skip predicate exits 0 (skip).
- Verbatim consequence text from SPEC-033-2-04 FR-4 emitted.
- `phases.13.status="skipped"` in wizard-state.json.
- Zero `request_types.*` and zero `hooks.*` keys written.
- Daemon receives 0 SIGHUPs from this phase.
