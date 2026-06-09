# state.json writer audit (REQ-000014)

## Purpose

This file enumerates every `mv "${tmp}" "${state_file}"` site in
`plugins/autonomous-dev/bin/supervisor-loop.sh` and classifies its
ledger-mirror obligation relative to `intake.db`.

## Legend

- **MIRROR** — Writer mutates `.status` and/or `.current_phase`; MUST call
  `sync_intake_db_row` after the `mv` so the intake ledger stays in sync.
- **EXEMPT** — Writer mutates only session/cost/retry bookkeeping fields;
  MUST NOT call `sync_intake_db_row` (avoiding spurious ledger churn that
  would confuse dashboards and orphan monitors).
- **OUT_OF_SCOPE** — Writer lives in a non-daemon code path (e.g. orphan
  reconciler) that manages its own ledger writes; not subject to this audit.

## Add-a-writer workflow

Any pull request introducing a **new** state.json writer that touches
`.status` or `.current_phase` MUST (a) call `sync_intake_db_row` after the
`mv`, and (b) add a MIRROR row to this table. Writers that do not touch those
fields MUST be added as EXEMPT with a one-line rationale. Failure to update
this table is a CI gate violation.

## Canonical mirror function

`sync_intake_db_row` is defined at
`plugins/autonomous-dev/bin/supervisor-loop.sh` (~line 2271). It is the sole
authoritative path for mirroring a state.json transition into
`~/.autonomous-dev/intake.db`. See the AUDIT REFERENCE comment block
immediately above the function definition.

---

## Writer Audit Table (HEAD as of REQ-000014)

Line numbers were re-verified against HEAD with:

```bash
grep -n 'mv .*state_file' plugins/autonomous-dev/bin/supervisor-loop.sh
grep -n 'sync_intake_db_row ' plugins/autonomous-dev/bin/supervisor-loop.sh
```

| Line | Function | Fields mutated | Classification | Notes |
|------|----------|----------------|----------------|-------|
| 485  | `restore_interrupted_session` | `current_phase_metadata.session_active` | EXEMPT | Session bookkeeping only |
| 1158 | `dispatch_phase_session` (set active) | `current_phase_metadata.*` | EXEMPT | Session bookkeeping only |
| 1278 | `spawn_session` (set active) | `current_phase_metadata.session_active` | EXEMPT | Session bookkeeping only |
| 1316 | `spawn_session` (clear active) | `current_phase_metadata.session_active` | EXEMPT | Session bookkeeping only |
| 1678 | `escalate_to_paused` | `.status = "paused"` | MIRROR (NEW, REQ-000014) | Helper call inserted at ~1711 |
| 1921 | `update_request_state` (success) | `current_phase_metadata.*`, `cost_accrued_usd` | EXEMPT | No status/phase change |
| 1958 | `update_request_state` (error) | retry/error fields | EXEMPT | No status/phase change |
| 1970 | `update_request_state` (next_retry_after) | `current_phase_metadata.next_retry_after` | EXEMPT | No status/phase change |
| 2228 | `update_state_cost` | `cost_accrued_usd` | EXEMPT | No status/phase change |
| 2403 | `advance_phase` (restore current_phase) | `.current_phase = $phase` | MIRROR | Defensive restore before next-phase determination; downstream syncs at ~2434/2492 follow immediately |
| 2417 | `advance_phase` (terminal done) | `.status = "done"` | MIRROR | Helper at ~2434 (REQ-000013) |
| 2473 | `advance_phase` (next phase, gate) | `.status`, `.current_phase` | MIRROR | Helper at ~2492 (REQ-000013) |
| 2518 | `advance_phase` (escalation_count) | escalation count only | EXEMPT | No status/phase change |
| 2547 | `advance_phase` (review-fail reset) | `.current_phase = author_phase` | MIRROR | Helper at ~2550 (REQ-000013) |
| 2609 | `intake_to_prd_if_needed` | `.current_phase = "prd"`, `.status = "running"` | MIRROR | Helper at ~2626 (REQ-000013) |
| 2831 | orphan reconciliation (state.json) | varies | OUT_OF_SCOPE | Orphan path writes ledger directly at ~2904 |

**Row counts:** 6 MIRROR, 9 EXEMPT, 1 OUT_OF_SCOPE (16 data rows total).

> **Note on line drift:** Line numbers shift whenever unrelated code is
> added or removed. The *classification* of each writer is the durable
> artifact; update line numbers whenever a significant refactor lands.
