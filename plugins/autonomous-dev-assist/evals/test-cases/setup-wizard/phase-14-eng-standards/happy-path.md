---
phase: 14
case_type: happy-path
expected_outcome: complete
fixture_repo: tests/fixtures/setup-wizard/repos/ts-greenfield
fixture_pack: typescript-strict
operator_inputs:
  detection_confirm: y
  pack_choice: typescript-strict
  two_person_approval: y
assertions:
  - id: A-1
    description: standards.yaml validates
    type: cli-exit
    command: autonomous-dev standards validate --repo {fixture_repo}
    expected: 0
  - id: A-2
    description: prompt renderer non-empty STANDARDS_SECTION
    type: regex-match
    target: stdout-render-prompt
    pattern: 'STANDARDS_SECTION:[^\n]+\n'
  - id: A-3
    description: prompt renderer SPEC-021-3-01 schema
    type: schema-validate
    target: stdout-render-prompt
    schema: tests/fixtures/setup-wizard/schemas/standards-section.json
  - id: A-4
    description: meta-reviewer dry-run produced JSON
    type: file-exists
    path: "{fixture_repo}/.autonomous-dev/standards-dry-run-{TODAY}.json"
  - id: A-5
    description: meta-reviewer dry-run JSON parses
    type: json-valid
    target: file-A-4
  - id: A-6
    description: two_person_approval flag persisted
    type: config-equals
    key: standards.two_person_approval_enabled
    expected: true
  - id: A-7
    description: SIGHUP delta 1
    type: counter-delta
    target: daemon-hup-counter
    expected: 1
  - id: A-8
    description: dry-run isolation (fs-snapshot diff allow-list only)
    type: fs-snapshot-diff
    allowlist:
      - "{fixture_repo}/.autonomous-dev/standards.yaml"
      - "{fixture_repo}/.autonomous-dev/standards-dry-run-{TODAY}.json"
      - "~/.autonomous-dev/wizard-state.json"
      - "~/.autonomous-dev/wizard-checkpoint.json"
      - "~/.autonomous-dev/logs/wizard.log"
---

# Phase 14 happy-path eval

Confirm TS detection, pick `typescript-strict`, validate exits 0,
prompt renderer returns non-empty STANDARDS_SECTION, meta-reviewer
dry-run produces a parseable JSON file at the dated path, two-person
approval flag persists, daemon SIGHUP delta=1, fs-snapshot diff
matches the allow-list.
