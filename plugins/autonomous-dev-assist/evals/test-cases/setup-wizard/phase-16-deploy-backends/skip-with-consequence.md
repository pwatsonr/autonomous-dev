---
phase: 16
case_type: skip-with-consequence
expected_outcome: skipped
fixture_repo: tests/fixtures/setup-wizard/repos/ts-greenfield
config_overrides:
  wizard.skip_phase_16: true
operator_inputs: {}
assertions:
  - id: A-1
    description: FR-4 verbatim consequence text emitted
    type: regex-match
    target: transcript
    pattern: 'Only `local` backend configured; daemon cannot deploy to dev/staging/prod\.'
  - id: A-2
    description: phases.16.status == skipped
    type: state-key-equals
    key: phases.16.status
    expected: skipped
  - id: A-3
    description: no plugin install invoked
    type: counter-equals
    target: plugin-install
    expected: 0
  - id: A-4
    description: no cred-proxy invocation
    type: counter-equals
    target: cred-proxy-provision
    expected: 0
  - id: A-5
    description: no firewall apply invocation
    type: counter-equals
    target: firewall-apply
    expected: 0
  - id: A-6
    description: SIGHUP delta == 0
    type: counter-delta
    target: daemon-hup-counter
    expected: 0
  - id: A-7
    description: deploy.envs.* keys not written (only backend default may be local)
    type: config-key-absent
    key: deploy.envs.dev.cred_proxy_handle
---

# Phase 16 skip-with-consequence eval (FR-20)

`wizard.skip_phase_16=true`. Skip predicate exits 0; FR-4 verbatim
consequence emitted; no plugin/cred-proxy/firewall calls; SIGHUP delta=0;
status=skipped.
