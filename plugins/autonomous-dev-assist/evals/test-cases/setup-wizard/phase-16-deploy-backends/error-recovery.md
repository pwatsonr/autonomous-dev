---
phase: 16
case_type: error-recovery
expected_outcome: failed
fixture_repo: tests/fixtures/setup-wizard/repos/ts-greenfield
sub_cases:
  - id: ER-A
    description: Plugin install network failure
    mocks:
      MOCK_PLUGIN_INSTALL_MODE: network-fail
    operator_inputs:
      env_dev_backend: aws
    assertions:
      - id: ER-A-1
        description: phase aborts with diagnostic
        type: regex-match
        target: stderr
        pattern: '\[phase-16\] aborting at env=dev'
      - id: ER-A-2
        description: deploy.envs.dev keys NOT written
        type: config-key-absent
        key: deploy.envs.dev.backend
      - id: ER-A-3
        description: phases.16.status == failed
        type: state-key-equals
        key: phases.16.status
        expected: failed
      - id: ER-A-4
        description: re-run resumes at plugin-install for dev (idempotency probe)
        type: probe-output-equals
        probe: phase-16-probe
        expected: start-fresh

  - id: ER-B
    description: Plugin version mismatch + operator declines upgrade
    mocks:
      MOCK_PLUGIN_INSTALL_MODE: version-mismatch
    operator_inputs:
      env_dev_backend: aws
      upgrade_choice: n
    assertions:
      - id: ER-B-1
        description: phase aborts cleanly
        type: state-key-equals
        key: phases.16.status
        expected: failed
      - id: ER-B-2
        description: prior envs untouched (no envs configured before dev)
        type: config-key-absent
        key: deploy.envs.dev.backend

  - id: ER-C
    description: Cred-proxy provision returns non-zero
    mocks:
      MOCK_CRED_PROXY_MODE: network-error
    operator_inputs:
      env_dev_backend: aws
    assertions:
      - id: ER-C-1
        description: cred_proxy_handle NOT written
        type: config-key-absent
        key: deploy.envs.dev.cred_proxy_handle
      - id: ER-C-2
        description: firewall step NOT invoked
        type: counter-equals
        target: firewall-apply
        expected: 0
      - id: ER-C-3
        description: deploy step NOT invoked
        type: counter-equals
        target: deploy
        expected: 0

  - id: ER-D
    description: Final deploy --dry-run returns non-zero (after dev success)
    mocks:
      MOCK_DEPLOY_MODE_FINAL: error
    operator_inputs:
      env_dev_backend: aws
      env_staging_backend: local
      env_prod_backend: local
    assertions:
      - id: ER-D-1
        description: phases.16.status == failed
        type: state-key-equals
        key: phases.16.status
        expected: failed
      - id: ER-D-2
        description: per-env atomicity — dev state remains intact
        type: config-key-equals
        key: deploy.envs.dev.backend
        expected: aws
      - id: ER-D-3
        description: per-env atomicity — dev cred_proxy_handle remains intact
        type: regex-match-config
        key: deploy.envs.dev.cred_proxy_handle
        pattern: '^cph_[A-Za-z0-9]{32}$'
---

# Phase 16 error-recovery eval (FR-21)

Four sub-cases verify graceful failure modes:

- **ER-A**: plugin install network failure aborts the phase before any
  state write; the idempotency probe reports `start-fresh` so re-run
  resumes correctly.
- **ER-B**: plugin version mismatch + operator declines upgrade →
  phase aborts cleanly; phases.16.status=failed.
- **ER-C**: cred-proxy provision exits non-zero → handle NOT written;
  firewall and deploy steps NOT invoked (per-env atomicity).
- **ER-D**: final dry-run fails AFTER dev was configured successfully →
  per-env atomicity: dev state remains intact (config keys present,
  handle valid). Cross-env rollback is a separate operator action via
  `wizard rollback --phase 16`.
