# SPEC-036-2-05: Ops Heartbeat History Sparkline

## Metadata
- **Parent Plan**: PLAN-036-2-costs-and-ops
- **Parent TDD**: TDD-036-portal-redesign-surfaces (§6.4)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-19, R-15 live-dot supersedes spinners)
- **Tasks Covered**: PLAN-036-2 Task 9 (heartbeat sub-region of Ops health KPI)
- **Dependencies**: PLAN-035-2 primitive `Dot`, SPEC-036-2-04 (Ops route composition)
- **Estimated effort**: 0.5 day
- **Status**: Draft
- **Date**: 2026-05-09

## 1. Summary

Implement the 24-hour heartbeat history sparkline that renders inside
the daemon-status KPI card on the Ops surface. The sparkline is a
server-rendered inline SVG showing the last 24 hours of daemon
heartbeat samples. A `Dot` primitive with `live={true}` (PRD-018 R-15)
sits adjacent to the sparkline as the canonical "live state"
indicator, replacing any spinner / skeleton that may have shipped
under PRD-009.

## 2. Functional Requirements

| ID   | Requirement                                                                                                                          | Task |
|------|--------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1 | A new fragment `server/templates/fragments/heartbeat-sparkline.tsx` MUST render an inline `<svg viewBox="0 0 200 32">` for `samples: HeartbeatSample[]` (one per 5-minute bucket, last 24h = 288 max). | T9   |
| FR-2 | Each sample MUST render as a 1px-wide vertical bar. Bar height encodes `latencyMs / 500` clamped to [2, 32]; bar fill is `var(--brand)` for healthy samples (`status === 'ok'`), `var(--warn)` for slow (`status === 'slow'`), `var(--err)` for missed (`status === 'miss'`). | T9   |
| FR-3 | The sparkline MUST render a `Dot({ tone: <derived>, live: true })` to its left where tone is `ok` if last sample is ok, `warn` if slow, `err` if miss. | T9   |
| FR-4 | When `samples.length === 0` (daemon never started or just installed), the fragment MUST render `<text x="100" y="20" text-anchor="middle" fill="var(--fg-2)">No heartbeat yet</text>` and `Dot({ tone: 'muted', live: false })`. | T9   |
| FR-5 | The fragment MUST emit a target `id="heartbeat-sparkline"` for SSE OOB swaps on the `ops:health` channel; SSE updates replace the SVG body without remounting the dot.                | T9   |
| FR-6 | The `.dot.live` indicator MUST animate via the existing CSS keyframe in `design-tokens.css` (no new CSS); the SVG itself is static between SSE updates.            | T9   |
| FR-7 | When `health.daemon.status === 'stopped'`, the fragment MUST render the empty state regardless of `samples` (consistent with FR-8 in SPEC-036-2-04). | T9   |
| FR-8 | All token references MUST resolve via `var(--*)`; no hex literals. The fragment passes the no-hex CI lint.                                                          | T9   |

## 3. Acceptance Criteria

```
Given samples = [288 ok entries with latencyMs ~80ms]
When the fragment renders
Then 288 <rect> bars render
And each rect fill resolves to var(--brand)
And the leading Dot has tone="ok" and class "live"
```

```
Given samples ending with [..., ok, ok, slow, miss]
When the fragment renders
Then the trailing dot tone is "err" (last sample is miss)
And the last 2 bars are var(--err) / var(--warn)
```

```
Given samples = [] OR daemon.status === 'stopped'
When the fragment renders
Then a single empty-state <text> renders
And the Dot has tone="muted" and live=false (no pulsing)
```

## 4. Implementation Notes

- File: `server/templates/fragments/heartbeat-sparkline.tsx`. Pure function.
- Bar `x` position: `i * (200 / samples.length)`; width: `Math.max(1, 200 / samples.length - 0.5)`.
- The fragment is composed inside the daemon-status KPI card by `views/ops.tsx`; the KPI card title still renders "Daemon", the value row swaps to host the sparkline + dot.
- Per PRD-018 R-15 and R-15a, no spinner / skeleton / shadow elevation; a 1px-rule above and below the sparkline only.
- Health-derived tone for the dot is computed once in the fragment, not in the route — keeps the route handler free of presentation concerns.

## 5. Tests

- **Unit**: `tests/unit/heartbeat-sparkline.test.ts` — table-driven over (288 ok, mixed, all miss, empty, daemon-stopped); assert bar count, fill colors, dot tone.
- **Integration**: included in `tests/integration/ops.test.ts` — assert `#heartbeat-sparkline` SVG present and dot has `class="dot live"`.
- **Visual regression**: covered by Ops surface test (SPEC-036-2-04).

## 6. Verification

- `bun test plugins/autonomous-dev-portal/tests/unit/heartbeat-sparkline.test.ts` passes.
- CI no-hex-literal lint passes against the fragment.
- Manual: `bun run dev`, visit `/ops`, observe sparkline updates as SSE feeds new samples; toggle daemon stub state and confirm empty-state path.
