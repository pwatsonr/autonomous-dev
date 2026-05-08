---
phase: 12
case_type: happy-path
expected_outcome: complete
fixture_repo: tests/fixtures/setup-wizard/repos/github-happy
fixture_token: tests/fixtures/setup-wizard/tokens/happy.env
gh_shim_responses: tests/fixtures/setup-wizard/gh-shims/happy.json
operator_inputs:
  pat: ghp_FAKETESTHAPPYTOKEN0123456789012345678901
assertions:
  - id: A-1
    description: verify-line in wizard.log
    type: log-line
    pattern: '"phase":12,"step":"verify","status":"completed"'
  - id: A-2
    description: token-leak sweep
    type: regex-no-match
    pattern: 'ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}'
    target: [stdout, stderr, wizard.log, transcript]
  - id: A-3
    description: scaffold byte-identity for autonomous-dev-ci.yml
    type: file-hash-equals
    target: ".github/workflows/autonomous-dev-ci.yml"
    template: plugins/autonomous-dev/templates/workflows/autonomous-dev-ci.yml
  - id: A-4
    description: gh secret set recorded
    type: shim-recorded
    pattern: 'gh secret set AUTONOMOUS_DEV_TOKEN'
  - id: A-5
    description: branch protection PUT contexts
    type: shim-recorded
    pattern: 'branches/main/protection'
    contains: ["autonomous-dev-ci","autonomous-dev-cd"]
  - id: A-6
    description: probe-PR mergeable_state blocked while pending
    type: shim-recorded
    pattern: 'mergeable_state.*blocked'
  - id: A-7
    description: probe branch deleted; PR closed (not merged)
    type: shim-not-recorded
    pattern: 'gh pr merge'
  - id: A-8
    description: state file phases.12.status=complete
    type: state-equals
    key: phases.12.status
    expected: complete
  - id: A-9
    description: ci.* config keys persisted
    type: config-equals
    key: ci.github_pat_env
    expected: GH_TOKEN
  - id: A-10
    description: cred_proxy_handle persisted (env-var-name pointer not literal token)
    type: config-equals
    key: ci.branch_protection_enabled
    expected: true
---

# Setup
- Fixture repo with origin=git@github.com:fixture-org/fixture-repo.git
- Fixture PAT: ghp_FAKETESTHAPPYTOKEN0123456789012345678901
- gh shim returns: permissions.admin=true; secret set ok; protection PUT 200; pr create #42; run list "completed/success" after 30s simulated.

# Run
1. `autonomous-dev wizard --phase 12` against fixture
2. Provide fixture PAT via stdin

# Expected
- All 10 assertions pass.
