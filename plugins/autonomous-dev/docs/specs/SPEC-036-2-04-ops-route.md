# SPEC-036-2-04: Ops Route — `GET /ops`

## Metadata
- **Parent Plan**: PLAN-036-2-costs-and-ops
- **Parent TDD**: TDD-036-portal-redesign-surfaces (§6.4)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-19)
- **Tasks Covered**: PLAN-036-2 Tasks 1, 3, 7, 9, 10
- **Dependencies**: PLAN-035-2 primitives (`Btn`, `Chip`, `Dot`, `Card`), PLAN-035-3 `KillSwitch` primitive (SPEC-035-3-01..05), PLAN-036-1 (`fragments/kpi-strip.tsx`, `fragments/empty-state.tsx`), SPEC-036-2-05 (heartbeat history), SPEC-036-2-06 (recent logs)
- **Estimated effort**: 1 day
- **Status**: Draft
- **Date**: 2026-05-09

## 1. Summary

Implement the Ops surface route handler and view template at
`server/routes/ops.tsx` and `server/templates/views/ops.tsx`. The route
renders the page-head with the `KillSwitch` primitive, a 4-card health
KPI strip, the plugin-chain visualization, the live log tail (dark
container per TDD-036 §6.4), the deploy events table, the MCP servers
table, and the recent standards changes list. Ops ships after Costs in
the rollout sequence (TDD-036 §9 order #3) because it consumes the
KillSwitch primitive and introduces the theme-defying log container.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                          | Task |
|-------|--------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | Route `GET /ops` MUST be registered in the portal router and respond with `200 text/html`.                                            | T9   |
| FR-2  | The view MUST render a `page-head` with `<h1>Operations</h1>`, a `Btn` (Refresh), and the `KillSwitch` primitive in the `head-actions` group. The KillSwitch MUST receive `engaged`/`armed` props from `health.killSwitch.*`. | T9   |
| FR-3  | A 4-card health KPI strip MUST render: daemon status (with `Dot live={true}` indicator), MCP servers count, plugin-chain summary, standards count. | T9   |
| FR-4  | The view MUST render the plugin-chain visualization via `fragments/plugin-chain.tsx` (5 columns: CORE, REVIEWERS, VARIANTS, DEPLOY, ORG; arrow `›` separators).                                                                                           | T9   |
| FR-5  | The first ops-grid row (1.4fr 1fr) MUST render the live log on the left (via `fragments/live-log.tsx` per SPEC-036-2-06) and the deploy events table on the right. | T9   |
| FR-6  | The second ops-grid row (1fr 1fr) MUST render the MCP servers table on the left and recent standards changes event list on the right.                                                                                                                     | T9   |
| FR-7  | The view MUST emit SSE OOB target `id` attributes for the channels `ops:health`, `ops:log`, `ops:deploys`, `ops:mcp` per TDD-036 §5.2.                                                                                                                    | T9   |
| FR-8  | When `health.daemon.status !== 'running'`, the daemon-status KPI MUST render `● STOPPED` in `--err`, the live log MUST display the muted "Daemon offline" line, and the heartbeat sparkline (SPEC-036-2-05) MUST render its empty state.                  | T10  |
| FR-9  | `types/render.ts` MUST be extended with the 6 new `OpsHealth` optional fields per TDD-036 §5.3: `mcpServers`, `pluginChain`, `recentLog`, `deployEvents`, `standardsChanges`, `standardsCount`, `immutableCount`.                                          | T1   |
| FR-10 | `stubs/ops.ts` MUST be populated with: 3 MCP entries, 5 plugin-chain categories (2–4 packages each, including `core` and `org` highlights), 10–15 recentLog entries (mixed levels + ≥2 agent-dispatch lines), 5 deploy events, 3 standards changes.       | T3   |

## 3. Acceptance Criteria

```
Given an authenticated operator and daemon status running
When GET /ops is requested
Then the response status is 200
And contains <h1>Operations</h1>
And contains class names .plugin-chain, .log, .kill-switch, .tbl
And contains data-sse attributes for ops:health, ops:log, ops:deploys, ops:mcp
And the legacy <dl> markup is absent
```

```
Given health.daemon.status = 'stopped'
When GET /ops is requested
Then the daemon-status KPI renders "● STOPPED" with class containing --err token
And the live log contains the muted "Daemon offline" entry
And the heartbeat sparkline renders its empty-state placeholder
And the page returns 200 with no JS errors
```

```
Given health.killSwitch = { engaged: false, armed: false }
When the page renders
Then the KillSwitch primitive emits its "armed-to-engage" treatment per SPEC-035-3-01
And the Refresh Btn renders to its left
```

## 4. Implementation Notes

- New file: `server/routes/ops.tsx`; rewrite `server/templates/views/ops.tsx`.
- The KillSwitch primitive prop surface is binding per PRD-018 R-08, R-13; pin to PLAN-035-3 merge commit (KillSwitch must land before Ops view PR opens).
- The plugin-chain fragment (`fragments/plugin-chain.tsx`) renders the column header even when `packages: []` to avoid layout collapse.
- SSE OOB swaps trim `<div id="log-tail">` server-side to last 200 entries before each emit (mitigates DOM-growth risk in PLAN-036-2 Risks).
- Daemon-down handling lives in the route handler — branch on `health.daemon.status` and pass an `offline: true` flag down to fragments where empty-state varies.

## 5. Tests

- **Integration**: `tests/integration/ops.test.ts` — assert `.plugin-chain`, `.log`, `.kill-switch`, `.tbl` classes; legacy `<dl>` markup absent; SSE id attributes present.
- **Empty/daemon-down variant**: feed `daemon: { status: 'stopped' }`; assert the three behaviors in FR-8.
- **KillSwitch states**: feed `engaged: true` and `armed: true` variants; assert the primitive renders the correct treatment per SPEC-035-3-01.
- **Visual regression**: `tests/visual/ops.visual.test.ts` light + dark, 0.1% pixel-diff.

## 6. Verification

- `bun test plugins/autonomous-dev-portal/tests/integration/ops.test.ts` passes (running, stopped, killswitch-engaged variants).
- `bun playwright test plugins/autonomous-dev-portal/tests/visual/ops.visual.test.ts` passes light + dark.
- Manual: `bun run dev`, visit `/ops`, exercise stub toggles, eye-compare against `autonomous-dev-design-system/project/screenshots/Ops*.png`.
- M-04 deliverable: 2 screenshots committed (`ops-after-{light,dark}.png`).
