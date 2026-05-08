---
phase: 12
case_type: error-recovery
expected_outcome: failed
sub_cases:
  - id: scope-downgrade
    description: PAT lacks admin permission on repo
    fixture_token: tests/fixtures/setup-wizard/tokens/no-admin.env
    gh_shim_responses: tests/fixtures/setup-wizard/gh-shims/no-admin.json
    assertions:
      - id: A-1
        description: diagnostic about scopes / admin
        type: regex-match
        target: stderr
        pattern: 'your token needs.*repo.*workflow.*admin'
      - id: A-2
        description: zero workflow files written
        type: file-absent
        paths:
          - ".github/workflows/autonomous-dev-ci.yml"
      - id: A-3
        description: zero gh secret set OR protection PUT
        type: shim-not-recorded
        patterns: ["gh secret set", "branches/main/protection"]
      - id: A-4
        description: phases.12.status==failed
        type: state-equals
        key: phases.12.status
        expected: failed
      - id: A-5
        description: token-leak sweep
        type: regex-no-match
        pattern: 'ghp_[A-Za-z0-9]{36}'
        target: [stdout, stderr, wizard.log, transcript]
  - id: probe-pr-failure
    description: scaffold + secret + protection succeed but probe-PR run fails
    gh_shim_responses: tests/fixtures/setup-wizard/gh-shims/probe-failure.json
    assertions:
      - id: A-1
        description: poll exits early on first failure
        type: regex-match
        target: stdout
        pattern: 'probe-PR run failure detected'
      - id: A-2
        description: cleanup-trap fired
        type: shim-recorded
        pattern: 'gh pr close'
      - id: A-3
        description: phases.12.status==failed; diagnostic names autonomous-dev-ci
        type: state-equals
        key: phases.12.status
        expected: failed
---

# Setup
Sub-cases as above; gh shim parametrized per sub-case.

# Expected
Both sub-cases assert no partial state; cleanup runs unconditionally;
status=failed.
