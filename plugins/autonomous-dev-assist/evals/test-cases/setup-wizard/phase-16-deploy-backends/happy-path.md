---
phase: 16
case_type: happy-path
expected_outcome: complete
fixture_repo: tests/fixtures/setup-wizard/repos/ts-greenfield
mocks:
  - autonomous-dev plugin install (success at matching version)
  - autonomous-dev cred-proxy provision/validate/revoke (success)
  - autonomous-dev firewall apply (status=applied)
  - autonomous-dev deploy --dry-run (cost $12.34, plan present)
operator_inputs:
  env_dev_backend: aws
  env_staging_backend: local
  env_prod_backend: local
assertions:
  - id: A-1
    description: dev backend configured to aws
    type: config-key-equals
    key: deploy.envs.dev.backend
    expected: aws
  - id: A-2
    description: dev cred_proxy_handle matches handle shape ^cph_[A-Za-z0-9]{32}$
    type: regex-match-config
    key: deploy.envs.dev.cred_proxy_handle
    pattern: '^cph_[A-Za-z0-9]{32}$'
  - id: A-3
    description: dev firewall_template == aws-default
    type: config-key-equals
    key: deploy.envs.dev.firewall_template
    expected: aws-default
  - id: A-4
    description: dev last_dry_run_at present (ISO8601)
    type: config-key-present
    key: deploy.envs.dev.last_dry_run_at
  - id: A-5
    description: staging backend == local; no handle/template recorded
    type: config-key-equals
    key: deploy.envs.staging.backend
    expected: local
  - id: A-6
    description: prod backend == local
    type: config-key-equals
    key: deploy.envs.prod.backend
    expected: local
  - id: A-7
    description: cost-cap dry-run reports finite numeric below $50/mo ceiling
    type: regex-match
    target: stdout-cost-cap
    pattern: '"estimated_monthly_cost_usd":\s*[0-9]+(\.[0-9]+)?'
  - id: A-8
    description: cost is below $50 ceiling
    type: numeric-lt
    target: parsed-cost
    expected: 50
  - id: A-9
    description: final dry-run exits 0 with structured plan_steps array
    type: regex-match
    target: stdout-final-dry-run
    pattern: '"plan_steps":\s*\['
  - id: A-10
    description: PRD-cross-reference banner emitted exactly once
    type: regex-match-count
    target: transcript
    pattern: 'NOTE: This phase configures deployment backends'
    expected_count: 1
  - id: A-11
    description: SIGHUP delta == 1
    type: counter-delta
    target: daemon-hup-counter
    expected: 1
  - id: A-12
    description: phases.16.status == complete
    type: state-key-equals
    key: phases.16.status
    expected: complete
  - id: A-13
    description: post-run scanner sweep over combined transcript reports zero matches
    type: scanner-sweep
    target: transcript-combined
    expected_match_count: 0
  - id: A-14
    description: zero cloud API calls (mock cloud-API counter == 0)
    type: counter-equals
    target: mock-cloud-api-counter
    expected: 0
  - id: A-15
    description: plugin install invoked exactly once for aws
    type: counter-equals
    target: plugin-install
    expected: 1
  - id: A-16
    description: cred-proxy provision invoked exactly once
    type: counter-equals
    target: cred-proxy-provision
    expected: 1
---

# Phase 16 happy-path eval (FR-19)

Operator chooses `aws` for dev and `local` for staging/prod. The mocks
return: plugin install success, cred-proxy provision returns a well-shaped
opaque handle, firewall apply reports `applied`, deploy dry-run reports
`{"estimated_monthly_cost_usd": 12.34, "plan_steps":[...]}`. The phase
writes the four config keys per env, emits SIGHUP, and the post-run
scanner sweep over the combined transcript (including cred-proxy bridge
stdout, plugin install logs, firewall response, dry-run JSON) reports
zero credential-pattern matches across all six families.
