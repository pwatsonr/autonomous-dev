# SPEC-036-2-02: Costs Time-Series SVG Chart

## Metadata
- **Parent Plan**: PLAN-036-2-costs-and-ops
- **Parent TDD**: TDD-036-portal-redesign-surfaces (§6.3)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-18), PRD-009 (FR-928 server-rendered SVG)
- **Tasks Covered**: PLAN-036-2 Task 4
- **Dependencies**: PLAN-035-2 primitives (token surface only — no primitive consumed)
- **Estimated effort**: 0.5 day
- **Status**: Draft
- **Date**: 2026-05-09

## 1. Summary

Implement `fragments/cost-chart.tsx` — a server-rendered inline SVG line
chart for the 30-day cost time series. Pure function: takes
`points: CostPoint[]` and `budgetUsd`, returns a `<svg>` element.
Uses `<defs>`/`<linearGradient>` for the area fill. Per OI-002 resolution
in TDD-036, this server-authored SVG carries no user data and is safe by
construction: there is no script content, no user-controllable string
interpolation into attributes that admit JavaScript, and the renderer
escapes data values per Hono JSX defaults.

## 2. Functional Requirements

| ID   | Requirement                                                                                                                          | Task |
|------|--------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1 | The fragment MUST render a single `<svg>` with `viewBox="0 0 760 200"`, `preserveAspectRatio="none"`, and class `chart-svg`.         | T4   |
| FR-2 | The chart MUST render exactly 5 horizontal grid lines at 0%, 25%, 50%, 75%, 100% of the max cost in `points`. Stroke `var(--line-1)`, stroke-width 1. | T4   |
| FR-3 | The chart MUST render an area fill below the line as a `<path>` whose `fill="url(#cost-grad)"`. The `<defs>` block MUST declare `<linearGradient id="cost-grad" x1="0" y1="0" x2="0" y2="1">` with stop-0 `var(--brand)` opacity 0.32 and stop-1 `var(--brand)` opacity 0. | T4   |
| FR-4 | The chart MUST render the line as a `<path>` with `stroke="var(--brand)"`, `stroke-width="2"`, `fill="none"`.                         | T4   |
| FR-5 | When `points.length === 0`, the SVG MUST render a single `<text x="380" y="100" text-anchor="middle" fill="var(--fg-2)">No cost data yet</text>`. | T4   |
| FR-6 | When `points.length === 1`, the chart MUST render a single `<circle r="3" fill="var(--brand)">` at the data point with no line/area path. | T4   |
| FR-7 | Optional X-axis labels MUST render every 5th day at the bottom; optional Y-axis labels MUST render at grid-line intersections — both behind a fragment-level `showLabels: boolean` prop, default `true`. | T4   |
| FR-8 | The chart MUST escape numeric data via Hono's default JSX escaping; no `dangerouslySetInnerHTML` or string-built `d` attribute concatenation that admits non-numeric input. | T4   |

## 3. Acceptance Criteria

```
Given points = [30 CostPoint entries]
When the fragment renders
Then the SVG has viewBox "0 0 760 200"
And contains exactly 5 grid <line> elements
And contains <linearGradient id="cost-grad"> in <defs>
And contains exactly one area <path fill="url(#cost-grad)">
And contains exactly one line <path stroke="var(--brand)">
```

```
Given points = []
When the fragment renders
Then the SVG body is the single empty-state <text>
And no <path> or grid <line> elements are present
```

```
Given points = [single point at $4.20]
When the fragment renders
Then a single <circle> renders at the projected coordinates
And no line/area <path> renders
```

## 4. Implementation Notes

- File: `server/templates/fragments/cost-chart.tsx`. Pure function export `CostChart({ points, budgetUsd, showLabels = true })`.
- Project points to chart space with helper `toX(i, n) = (i / (n - 1)) * 760` and `toY(v, max) = 200 - (v / max) * 200`.
- The `d` attribute is built from numeric coordinates only — no string concatenation of user input.
- Document the OI-002 safe-by-construction rationale in a fragment header comment ("server-authored SVG, no user data, no script content; XSS surface = empty per TDD-036 OI-002 resolution").
- Keep the fragment self-contained (≤ 150 lines); if it grows, extract path math to a sibling helper.

## 5. Tests

- **Snapshot**: 30-point series, 1-point series, 0-point empty case — snapshot per case under `tests/snapshots/cost-chart.*.svg`.
- **Well-formedness**: parse output with `xmldom`; assert single root `<svg>`, viewBox `0 0 760 200`.
- **Token presence**: assert `var(--brand)` and `var(--line-1)` appear in stroke/fill attributes (no hex literals).

## 6. Verification

- `bun test plugins/autonomous-dev-portal/tests/unit/cost-chart.test.ts` passes all three edge cases.
- CI no-hex-literal lint passes against the fragment file.
- Visual regression on `/costs` (SPEC-036-2-01) confirms chart renders pixel-faithfully against the kit screenshot.
