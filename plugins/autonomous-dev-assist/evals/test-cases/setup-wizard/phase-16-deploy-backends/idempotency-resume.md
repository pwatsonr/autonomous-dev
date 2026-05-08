---
phase: 16
case_type: idempotency-resume
expected_outcome: complete
fixture_repo: tests/fixtures/setup-wizard/repos/ts-greenfield
sub_cases:
  - id: IR-A
    description: Plugin already installed at matching version → install skipped
    fixture_state:
      plugin_installed_version: "1.2.3"
    mocks:
      MOCK_PLUGIN_INFO_VERSION: "1.2.3"
      MOCK_PLUGIN_INSTALL_MODE: success
    operator_inputs:
      env_dev_backend: aws
    assertions:
      - id: IR-A-1
        description: plugin install counter is 0 (skipped because version matches)
        type: counter-equals
        target: plugin-install
        expected: 0

  - id: IR-B
    description: Cred-proxy handle valid + operator chooses keep
    fixture_state:
      deploy.envs.dev.cred_proxy_handle: "cph_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    mocks:
      MOCK_CRED_PROXY_VALIDATE: ok
    operator_inputs:
      env_dev_backend: aws
      handle_action: keep
    assertions:
      - id: IR-B-1
        description: no rotation — revoke counter == 0
        type: counter-equals
        target: cred-proxy-revoke
        expected: 0
      - id: IR-B-2
        description: no fresh provision — provision counter == 0
        type: counter-equals
        target: cred-proxy-provision
        expected: 0

  - id: IR-B2
    description: Cred-proxy handle valid + operator chooses rotate
    fixture_state:
      deploy.envs.dev.cred_proxy_handle: "cph_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    mocks:
      MOCK_CRED_PROXY_VALIDATE: ok
      MOCK_CRED_PROXY_REVOKE: ok
    operator_inputs:
      env_dev_backend: aws
      handle_action: rotate
    assertions:
      - id: IR-B2-1
        description: prior handle revoked exactly once
        type: counter-equals
        target: cred-proxy-revoke
        expected: 1
      - id: IR-B2-2
        description: fresh handle provisioned exactly once
        type: counter-equals
        target: cred-proxy-provision
        expected: 1
      - id: IR-B2-3
        description: new handle written to deploy.envs.dev.cred_proxy_handle
        type: regex-match-config
        key: deploy.envs.dev.cred_proxy_handle
        pattern: '^cph_[A-Za-z0-9]{32}$'

  - id: IR-C
    description: Firewall same-template re-apply → idempotent no-op
    mocks:
      MOCK_FIREWALL_MODE: idempotent
    operator_inputs:
      env_dev_backend: aws
    assertions:
      - id: IR-C-1
        description: firewall apply returns idempotent marker
        type: regex-match
        target: stdout-firewall
        pattern: '"status":\s*"idempotent"'
      - id: IR-C-2
        description: phase still proceeds to dry-run (no abort)
        type: state-key-equals
        key: phases.16.status
        expected: complete

  - id: IR-D
    description: Dry-run is always re-invoked (no skip caching)
    mocks: {}
    operator_inputs:
      env_dev_backend: aws
    assertions:
      - id: IR-D-1
        description: deploy mock invoked at least once per env (dev) plus final
        type: counter-gte
        target: deploy
        expected: 2
---

# Phase 16 idempotency-resume eval (FR-22)

Four sub-cases:

- **IR-A**: plugin already at matching version → install command not invoked.
- **IR-B**: handle valid + operator keeps → no rotation counters increment.
- **IR-B2**: handle valid + operator rotates → revoke=1, provision=1.
- **IR-C**: firewall same-template re-apply → idempotent CLI response, no churn.
- **IR-D**: dry-run is always re-run (no skip predicated on dry-run cache).
