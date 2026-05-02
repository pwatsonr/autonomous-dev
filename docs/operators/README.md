# Operator Documentation

Reference runbooks for operating the autonomous-dev plugin and its CI
surface. Each document is the canonical source for a single operational
concern -- other docs link here rather than duplicating content.

## Cost controls

- [Budget Gate](./budget-gate.md) -- monthly Claude-spend gate, threshold
  semantics, override workflow, HMAC-key rotation procedure, failure-mode
  reference.

## Releases

- [Release smoke tests](./release-smoke-tests.md) -- post-tag verification
  steps for each published GitHub Release.
- [Release recovery](./release-recovery.md) -- recovery procedure when the
  `verify-evals` job blocks a tag push because the `_eval-baseline` branch
  is missing or corrupted.

## Evaluations

- [Assist evals](./assist-evals.md) -- nightly eval cron, threshold/regression
  gate, baseline-update procedure.
