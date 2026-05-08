---
phase: 12
case_type: idempotency-resume
expected_outcome: complete
sub_cases:
  - id: workflows-pre-populated
    description: workflows already match template hash
    setup:
      - copy templates to fixture .github/workflows/ at matching hash
    assertions:
      - id: A-1
        description: scaffold step skipped
        type: regex-match
        target: stdout
        pattern: 'skip.*: already matches template'
      - id: A-2
        description: phases.12.status complete
        type: state-equals
        key: phases.12.status
        expected: complete
  - id: branch-protection-already-configured
    description: protection already configured with matching contexts
    gh_shim_responses: tests/fixtures/setup-wizard/gh-shims/protection-set.json
    assertions:
      - id: A-1
        description: configure-protection skipped (no PUT recorded)
        type: shim-not-recorded
        pattern: 'gh api -X PUT.*branches/main/protection'
  - id: stale-probe-branch-detected
    description: kill -9 left a stale probe branch on origin
    setup:
      - pre-create branch autonomous-dev-wizard-probe-1234567890 on origin
    operator_inputs:
      cleanup_stale: y
    assertions:
      - id: A-1
        description: stale branch detection prompt
        type: regex-match
        target: stdout
        pattern: 'Found stale probe branches'
      - id: A-2
        description: stale branch deleted before proceeding
        type: shim-recorded
        pattern: 'git push origin --delete autonomous-dev-wizard-probe-1234567890'
      - id: A-3
        description: new probe branch uses fresh timestamp
        type: regex-match
        target: stdout
        pattern: 'autonomous-dev-wizard-probe-[0-9]{10,}'
---

# Expected
- Sub-cases all pass independently; no state collision; fresh timestamp
  ensures no branch-name reuse.
