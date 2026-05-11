# `kit-parity` fixture state directory

Canonical state fixtures pinned to the kit-screenshot values. CI screenshot
regression runs the production server with
`AUTONOMOUS_DEV_STATE_DIR=server/fixtures/kit-parity` so the real reader
code path executes against committed JSON — no demo-mode flag, no stub
bypass (PLAN-038 TASK-016 / TDD-037 §5.8).

## Files

| Path | Schema source | Notes |
|------|---------------|-------|
| `agent-states.json` | `plugins/autonomous-dev/bin/agent-cli.ts` | `{v, frozen[], shadowed[], updatedAt}`. The full 14-agent count comes from manifest scan (`plugins/autonomous-dev/agents/*.md`) overlaid with this file's frozen/shadowed sets. |
| `approvals-queue.json` | `server/wiring/approvals-store.tsx:QueueFile` | 3 pending items matching kit "Approvals 3" badge. |
| `cost-ledger.json` | `server/wiring/daemon-readers.ts:CostLedgerFile` | 10 daily totals summing to ~$153.60 (kit screenshot `MTD SPEND $153.60`). |
| `portal-settings.json` | `server/wiring/settings-store.tsx:UserConfigFile` | 6-repo allowlist + per-repo trust overrides matching the kit Repos grid. |
| `request-actions/REQ-1*.json` | `server/wiring/state-paths.ts:requestActionPath()` | 9 active requests across 6 repos (kit `Active 9 across 6 repos`). |
| `gate-decisions/` | `server/wiring/state-paths.ts:gateDecisionPath()` | Empty by default; in-gate state is signalled via `status` on the request-actions entries. |

## Provenance

Derived from `/tmp/portal-design-v2/autonomous-dev-design-system/project/screenshots/dashboard.png` (kit reference image). Values pinned to match the kit's visible KPIs and table rows.

## Verification

```bash
AUTONOMOUS_DEV_STATE_DIR=$PWD/server/fixtures/kit-parity bun run server/server.ts
# Open http://127.0.0.1:19280/ — KPI strip should show:
#   Active 9 across 6 repos · Awaiting 3 · MTD $153.60
```

## Drift contract

These fixtures must remain valid against the schemas the real readers parse. Each composition reader has a unit test that loads the fixture and asserts the output type, so schema drift is caught at build time.
