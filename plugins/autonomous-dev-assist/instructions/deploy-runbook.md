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

## 3. Cost-cap trip recovery

> **Safety.** `~/.autonomous-dev/deploy/ledger.json` is the cost-tracking
> invariant. **do NOT edit by hand**. **do NOT rm the ledger**. The
> supported recovery is `deploy ledger reset` — see below.

### How the cost cap works

The deploy executor maintains a running per-environment tally in the
append-only `ledger.json`. Each completed deploy appends one entry. When
the NEXT planned deploy's estimated cost would push the tally past
`cost_cap_usd` (from `deploy.yaml`), the executor refuses to enter
`executing` and emits `cost-cap-tripped` instead. The request is held;
no money is spent.

The ledger is a Stripe-style append-only contract. Manual edits corrupt
the cost-tracking invariant — **do NOT edit by hand**. Use
`deploy ledger reset` for every recovery path described below.

### Recovery procedure

1. Read the most recent ledger entries:

   ```bash
   cat ~/.autonomous-dev/deploy/ledger.json | jq '.entries[-5:]'
   ```

2. Identify the offending entry — the most recent `cost-cap-tripped`
   request, or any duplicate / impossible entry.
3. Decide between `deploy ledger reset --request REQ-NNNNNN` (reconcile
   one entry), `deploy ledger reset --since <ISO-timestamp>` (truncate
   from a point), or waiting for the billing-period reset (the cap is
   per-period; check `deploy.yaml`).
4. Re-run `deploy plan REQ-NNNNNN --env <env>` and proceed through the
   §2 state machine.

### Common causes

#### (a) Crash mid-deploy

The executor crashed between writing the ledger entry and completing the
deploy, leaving the tally inconsistent. Use:

```bash
deploy ledger reset --request REQ-NNNNNN
```

#### (b) Clock skew across hosts

A duplicate entry appears with a near-identical timestamp. Truncate from
the earliest skewed entry:

```bash
deploy ledger reset --since 2026-05-02T14:00:00Z
```

#### (c) Genuine cost overrun

The deploys are landing as planned; the cap is too low. Edit
`deploy.yaml` to raise `cost_cap_usd`, commit the change, and re-plan.
Every change to `cost_cap_usd` is reviewable in version control — that
is the supported way to extend the cap.

### What NOT to do

- **do NOT edit by hand** any field in `ledger.json`. Signatures break,
  the tally diverges, and the audit trail loses integrity.
- **do NOT rm the ledger** — there is no recovery from a deleted ledger;
  the cost tally is irrecoverable.
- Do NOT use `vi`, `sed`, or any in-place editor on the file. The
  supported recovery is always `deploy ledger reset`.

## 4. Ledger inspection

The ledger schema (per TDD-023 §14 Ledger Reset) is a single
`entries[]` array of records:

```json
{
  "entries": [
    {
      "request_id": "REQ-NNNNNN",
      "env": "staging",
      "backend": "gcp",
      "cost_usd": 12.40,
      "timestamp": "2026-05-02T14:32:11Z",
      "signature": "<HMAC>"
    }
  ]
}
```

Three read-only inspection recipes follow. Each is safe to run against a
production ledger.

### Recipe 1 — last-7-days total cost

```bash
jq '[.entries[]
     | select((.timestamp | fromdateiso8601) > (now - 604800))
     | .cost_usd] | add' ~/.autonomous-dev/deploy/ledger.json
```

### Recipe 2 — per-environment breakdown

```bash
jq '.entries
    | group_by(.env)
    | map({env: .[0].env, total: (map(.cost_usd) | add)})' \
  ~/.autonomous-dev/deploy/ledger.json
```

### Recipe 3 — signature-violation finder

```bash
jq '.entries[] | select(.signature == null or .signature == "")' \
  ~/.autonomous-dev/deploy/ledger.json
```

If any signature-violation entry appears, file a TDD-023 issue —
the entry is read-only evidence of tampering or a runtime bug.

## 5. HealthMonitor + SLA tracker

After a deploy enters `completed`, HealthMonitor watches the post-deploy
SLA window for the configured duration (per TDD-023 §11). Inspect the
live state:

```bash
deploy logs REQ-NNNNNN --health
```

Output includes latency p50/p95, error-rate, and the SLA window
remaining. The `degraded` state activates when latency or error-rate
breaches the threshold from `deploy.yaml`; HealthMonitor reports
`degraded` and starts a duration timer.

### Rollback decision tree

When HealthMonitor reports `degraded`, decide based on duration:

1. **Degraded for < 5 minutes:** monitor; transient blips are common
   during warm-up. Do nothing yet — the timer may clear on its own.
2. **Degraded for 5–30 minutes:** prepare for rollback. Alert on-call.
   Capture metrics
   (`deploy logs REQ-NNNNNN --health > /tmp/health.txt`). Run a dry-run
   rollback (`deploy rollback REQ-NNNNNN --dry-run --to <prev>`) to
   validate the target before executing.
3. **Degraded for > 30 minutes:** execute rollback per §6.

The thresholds are advisory — if the failure mode is unambiguous
(for example, 5xx-rate at 100% from the first sample), skip directly to
step 3 and execute the rollback. The rollback procedure itself lives in
§6; do NOT duplicate it here.

### What HealthMonitor does NOT do

- HealthMonitor does NOT auto-rollback. The decision to roll back is
  always operator-driven; the rollback decision tree above is the
  authority.
- HealthMonitor does NOT mutate the ledger. Health-check results are
  written to a separate event stream (`deploy logs --health`); the cost
  ledger only gains entries from `deploy plan` and from rollback.
- HealthMonitor does NOT reach across environments. A `degraded` signal
  on staging never triggers any action against prod.

The `degraded → ok` transition is automatic once the SLA window closes
without further breach. The duration timer resets at that point.
