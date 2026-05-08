# Deploy Framework Runbook

The operator deep-dive for the autonomous-dev deploy framework. Use this
runbook when:

- A deploy stalled and you need to inspect the state machine.
- A cost-cap trip needs recovery (see §3 — never edit the ledger by hand).
- The HealthMonitor reports a degraded SLA.

For the quick reference, see
[`help/SKILL.md` Deploy Framework](../skills/help/SKILL.md#deploy-framework).
For chain-aware plugin operation, see
[`chains-runbook.md`](./chains-runbook.md).

## Table of contents

1. [Bootstrap](#1-bootstrap)
2. [The approval state machine](#2-the-approval-state-machine)
3. [Cost-cap trip recovery](#3-cost-cap-trip-recovery)
4. [Ledger inspection](#4-ledger-inspection)
5. [HealthMonitor + SLA tracker](#5-healthmonitor--sla-tracker)
6. [Rollback](#6-rollback)
7. [Common errors](#7-common-errors)
8. [See also](#8-see-also)

## 1. Bootstrap

Before your first deploy, author a `deploy.yaml` at the repo root. The schema
is defined in TDD-023 §9 (`deploy-config-v1`). Reuse the canonical example
from `config-guide/SKILL.md` Section 20:

```yaml
# deploy.yaml — minimal staging + prod
default_backend: gcp

environments:
  staging:
    backend: gcp
    cost_cap_usd: 50.00
    auto_approve_at_trust: L2

  prod:
    backend: gcp
    is_prod: true            # forces approval regardless of trust level
    cost_cap_usd: 500.00
```

Run a dry-run estimate (no ledger write, no approval flow):

```bash
deploy estimate --env staging --backend gcp
```

The estimate prints the projected cost, validates the config against
`deploy-config-v1` (TDD-023 §9), and exits without creating a request.
Use it to verify the manifest before running
`deploy plan REQ-NNNNNN --env staging`, which DOES write a ledger entry
and enters the state machine described in §2.

A first deploy walkthrough: (1) write `deploy.yaml`, (2) run
`deploy estimate --env staging --backend gcp`, (3) run
`deploy plan REQ-NNNNNN --env staging`, (4) approve with
`deploy approve REQ-NNNNNN`, (5) watch with
`deploy logs REQ-NNNNNN`. Sample REQ-IDs in this runbook are always the
literal placeholder `REQ-NNNNNN` — substitute the real ID emitted by
`deploy plan`.

## 2. The approval state machine

> **Prod-override rule.** Any environment with `is_prod: true` always
> passes through `awaiting-approval` regardless of trust level. There is
> no path that skips human approval for a prod environment — see
> TDD-023 §11 Trust Integration.

The state graph (reused verbatim from
[`help/SKILL.md` Deploy Framework](../skills/help/SKILL.md#deploy-framework)):

```text
   pending ──> awaiting-approval ──> approved ──> executing ──> completed
                       │                                          └─> failed
                       └─────────────> rejected
```

The five states and their transitions:

- `pending` → `awaiting-approval` on `deploy plan`.
- `awaiting-approval` → `approved` on `deploy approve` (or → `rejected`
  on `deploy reject`).
- `approved` → `executing` automatically once approval lands.
- `executing` → `completed` on success, → `failed` on error.

Both `rejected` and `failed` are terminal sinks — no further automatic
transition. To re-attempt after either, file a new request (a fresh
`REQ-NNNNNN`) via `deploy plan` against the same env.

### Worked prod example

```bash
$ deploy plan REQ-NNNNNN --env prod
state: awaiting-approval

# the request still requires `deploy approve` regardless of trust level
$ deploy approve REQ-NNNNNN --comment "rollout per RFC-XYZ"
state: approved -> executing -> completed
```

The intermediate `approved` state is observable via `deploy logs
REQ-NNNNNN` even though the transition to `executing` is automatic. If
the deploy hangs in `approved`, the executor lock or backend dispatcher
is the likely cause — see §7 Common errors.

For trust-level semantics (which gates auto-approve at staging vs. which
always require human action) see TDD-023 §11 Trust Integration. The
prod-override holds at every trust level: L0, L1, L2, and L3 all enter
`awaiting-approval` for `is_prod: true` environments.

To inspect the live state of any request, run
`deploy logs REQ-NNNNNN` — the event stream prints each transition with
its timestamp. To list all in-flight requests for one env, run
`deploy logs --env <env> --status awaiting-approval`. These are
read-only commands and do not advance the state machine.
