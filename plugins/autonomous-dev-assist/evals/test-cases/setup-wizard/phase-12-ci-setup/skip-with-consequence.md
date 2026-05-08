---
phase: 12
case_type: skip-with-consequence
expected_outcome: skipped
fixture_repo: tests/fixtures/setup-wizard/repos/gitlab-skip
assertions:
  - id: A-1
    description: verbatim consequence text
    type: regex-match
    pattern: 'GitHub-only support; daemon will run but workflow validation must be done manually\.'
    target: stdout
  - id: A-2
    description: phases.12.status==skipped
    type: state-equals
    key: phases.12.status
    expected: skipped
  - id: A-3
    description: no .github/workflows files written
    type: file-absent
    paths:
      - ".github/workflows/autonomous-dev-ci.yml"
      - ".github/workflows/autonomous-dev-cd.yml"
      - ".github/workflows/observe.yml.example"
  - id: A-4
    description: gh shim recorded zero invocations
    type: shim-call-count
    expected: 0
---

# Setup
- Fixture repo origin = https://gitlab.com/x/y.git

# Run
- `autonomous-dev wizard --phase 12`

# Expected
- skip predicate exits 0; consequence emitted; no side effects.
