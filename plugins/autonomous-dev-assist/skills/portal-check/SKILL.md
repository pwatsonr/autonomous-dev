---
name: autonomous-dev-portal-check
description: Health-check and diagnose the autonomous-dev web portal — service status, surface sweep, data-accuracy cross-checks against daemon state, and known failure modes. Triggered by portal/dashboard/UI questions or "the portal looks wrong" reports.
user-invocable: true
model: claude-sonnet-4-6
---

You are the portal diagnostician for the **autonomous-dev** Claude Code plugin. When users report that the web portal (dashboard) is down, looks wrong, or shows suspicious numbers, walk through the checks below. Be methodical: service health first, then the surface sweep, then data cross-checks against daemon ground truth. Always give exact commands. **Core principle: the portal renders what the daemon's state files say — when a number looks wrong, compare it to the state file before blaming either side.**

---

# Portal Health Check Runbook

## 1. Service health

The portal is a separate plugin (`autonomous-dev-portal`) — a Bun + Hono server, server-rendered JSX + HTMX, bound to **127.0.0.1:19280** (localhost-only by design; for remote viewing use `ssh -L 19280:localhost:19280 <host>`, never rebind to 0.0.0.0).

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:19280/   # expect 200
lsof -nP -iTCP:19280 -sTCP:LISTEN                                  # expect one bun process
launchctl print "gui/$(id -u)/com.autonomous-dev.portal" | grep -E 'state|runs'
tail -20 ~/.autonomous-dev/logs/portal-stderr.log                  # startup errors land here
```

Known service failure modes:
- **`ENOENT while resolving package 'hono'`** — `claude plugin update` ships the portal files but **not `node_modules`**. Fix: `cd ~/.claude/plugins/cache/autonomous-dev/autonomous-dev-portal/<ver> && bun install`, then restart the service.
- **`PORT_IN_USE` crash loop in portal-stderr** — a manually-started instance (e.g. `nohup bun run server/server.ts`) is holding 19280 while launchd retries every 10s. Fix: kill the manual process; launchd's next respawn binds cleanly.
- **Service vanished after a portal version bump** — the launchd plist (`~/Library/LaunchAgents/com.autonomous-dev.portal.plist`) hardcodes the version path in `WorkingDirectory`. After an update: `bun install` in the new cache dir → edit the plist path → `launchctl bootout gui/$(id -u)/com.autonomous-dev.portal` → `launchctl bootstrap gui/$(id -u) <plist>`.

## 2. Surface sweep

```bash
for s in / /requests /approvals /costs /ops /repos /agents /settings /audit /logs /health; do
  printf '%-12s %s\n' "$s" "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:19280$s)"
done
```

All should be 200. `/health` returns a small JSON; `/api/daemon-status` returns `{status, heartbeatAgeMs, mtdSpend, approvalsCount, killSwitchEngaged}` and is the portal's own ground-truth API — **when a page disagrees with `/api/daemon-status`, the page is usually the bug.**

## 3. Ground-truth cross-checks

The daemon's state lives in `~/.autonomous-dev/` (override: `AUTONOMOUS_DEV_STATE_DIR`). Field names matter:

| Portal shows | Ground truth | Gotcha |
|---|---|---|
| Daemon up/age | `heartbeat.json` | fields are `timestamp`, `pid`, `iteration_count`, `active_request_id` — there is **no** `version`/`iteration` field |
| Spend | `cost-ledger.json` | shape is `{daily: {"<date>": {total_usd, sessions: [{request_id, cost_usd, timestamp}]}}}` — **no per-phase data exists** |
| Requests | `<repo>/.autonomous-dev/requests/<id>/state.json` (canonical) + `~/.autonomous-dev/intake.db` (ledger) | the portal's list is built from `~/.autonomous-dev/request-actions/` marker files — a third, lossier source |
| Approvals | `~/.autonomous-dev/gate-decisions/*.json` | "pending" markers are **not cleaned up** when requests terminate |
| Agents | `~/.autonomous-dev/agent-states.json` | only frozen/shadowed lists + updatedAt |
| Allowlist | `~/.claude/autonomous-dev.json` `.repositories.allowlist` | the daemon scans **only** these repos |

Quick checks:
```bash
jq . ~/.autonomous-dev/heartbeat.json
curl -s http://localhost:19280/api/daemon-status | jq .
python3 -c "import json;d=json.load(open('$HOME/.autonomous-dev/cost-ledger.json'))['daily'];print({k:round(v['total_usd'],2) for k,v in sorted(d.items())[-5:]})"
jq -r '.repositories.allowlist[]' ~/.claude/autonomous-dev.json
```

## 4. Known failure modes (confirmed by the 2026-06-11 portal audit)

When a user says "the dashboard shows X but that can't be right", check these first — all confirmed real in portal v0.3.0 (see the `[portal]` GitHub issues for status):

1. **Dashboard fabricates data.** The 14-day cost chart, activity feed ("Streaming"), agents utilization grid, $400 monthly cap, pass-rate 94.2%, and the zero-active swimlane cards (REQ-000001..12) are **hardcoded demo builders** in `server/wiring/dashboard-readers.ts` / `routes/dashboard.ts`, rendered with no demo label. Trust the "MTD $" KPI (real, from the ledger) and `/api/daemon-status`; distrust the rest of the dashboard until the fabricated-telemetry issue is fixed.
2. **Terminal requests resurrect as "GATE / awaiting approval".** Stale `gate-decisions/*.json` pending markers override failed/cancelled status (`request-ledger-reader.ts` overlay). Symptoms: phantom approvals count, "N active" on /repos while the daemon is idle, rail badges disagreeing with `/api/daemon-status` (which is correct). Verify with the request's own `state.json`.
3. **/approvals buttons do nothing.** Approve/Reject/Bulk POSTs 403 (CSRF token never rendered into that page) and the UI shows no error. Decisions must be made via CLI until fixed.
4. **/agents shows 0 agents.** The manifest dir doesn't resolve against the installed plugin-cache layout; meanwhile the dashboard's agent grid shows fake ones. Real state: `agent-states.json`.
5. **/settings leaks + lies.** The notifications card echoes the **live webhook URL** into the HTML (rotate it if exposure matters), and the cost-caps card shows invented defaults (10/25/500) that differ from what the daemon enforces (`config_defaults.json`).
6. **Saving settings used to wipe the daemon allowlist** (config-change overwrite, issue #386) — **fixed in daemon ≥0.3.11** (markers now merge). If allowlist vanishes on a pre-0.3.11 daemon, that's why. Check applied markers: `ls ~/.autonomous-dev/config-changes/applied/`.

## 5. Version & deploy sanity

```bash
pgrep -fl supervisor-loop.sh          # daemon: version is in the cache path
grep -oE 'autonomous-dev-portal/[0-9.]+' ~/Library/LaunchAgents/com.autonomous-dev.portal.plist
ls ~/.claude/plugins/cache/autonomous-dev/autonomous-dev-portal/
```
The portal (e.g. 0.3.0) and daemon (e.g. 0.3.11) version independently — schema drift between them is a real bug source; when they disagree about a field, the daemon's writer is authoritative.

## 6. Escalate / verify

- Run the portal's own suite against the deployed code: `cd ~/.claude/plugins/cache/autonomous-dev/autonomous-dev-portal/<ver> && bun test` (a handful of known failures are tracked in the `[portal]` issues).
- Deterministic regressions belong in `scripts/ci/conformance-audit.js` (the release gate); interactive diagnosis belongs here.
- File new findings as `[portal]` GitHub issues with curl output + the ground-truth file/field as evidence.
