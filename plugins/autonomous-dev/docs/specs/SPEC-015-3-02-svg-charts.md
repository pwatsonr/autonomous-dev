# SPEC-015-3-02: Hand-Rolled SVG Charts (Line, Stacked Bar, Sparkline)

## Metadata
- **Parent Plan**: PLAN-015-3
- **Tasks Covered**: TASK-002 (SVGLineChart), TASK-003 (SVGBarChart), TASK-007 (Accessibility + ColorPalette); sparkline component for live SSE updates
- **Estimated effort**: 7 hours

## Description
Implement three pure-function SVG chart generators with zero client-side JavaScript and zero charting-library dependencies. Each function takes typed input data and returns a complete SVG markup string suitable for embedding directly into HTMX fragments or full pages. The line chart visualizes daily spend trends, the stacked bar chart visualizes per-agent (or per-phase) cost breakdown by day, and the sparkline is a compact inline chart used in cost-cap status cards and the SSE live-update fragment. All charts ship with WCAG 2.1 AA accessibility metadata, a color-blind-safe palette, and pattern overlays for differentiation independent of color. Aggregation is in SPEC-015-3-01; route wiring is downstream.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `portal/charts/types.ts` | Create | `ChartDataPoint`, `StackedSeries`, `ChartDimensions`, `AccessibilityMeta` |
| `portal/charts/palette.ts` | Create | `COLOR_PALETTE` (Wong 8-color color-blind-safe), `PATTERN_DEFS` constant SVG pattern markup |
| `portal/charts/scales.ts` | Create | Pure scale helpers: `linearScaleY`, `bandScaleX`, `dateScaleX`, `formatCurrency`, `formatDate` |
| `portal/charts/line_chart.ts` | Create | `renderLineChart(data, opts): string` — exports SVG markup |
| `portal/charts/stacked_bar_chart.ts` | Create | `renderStackedBarChart(series, opts): string` |
| `portal/charts/sparkline.ts` | Create | `renderSparkline(values, opts): string` |
| `portal/charts/accessibility.ts` | Create | `renderA11yMeta`, `renderTabularFallback` — emits `<title>`, `<desc>`, ARIA, and visually-hidden `<table>` |

## Implementation Details

### Type Definitions (`portal/charts/types.ts`)

```typescript
export interface ChartDataPoint {
  date: string;        // YYYY-MM-DD
  value: number;       // USD
  label?: string;      // optional tooltip override
}

export interface StackedSeries {
  date: string;        // YYYY-MM-DD (or YYYY-MM for monthly)
  segments: { name: string; value: number }[];   // one per phase or agent
}

export interface ChartDimensions {
  width: number;
  height: number;
  margins: { top: number; right: number; bottom: number; left: number };
}

export interface AccessibilityMeta {
  title: string;       // short, becomes <title>
  description: string; // longer, becomes <desc>
  data_summary: string; // sentence describing the data ("Daily spend for last 30 days, total $42.50")
}

export interface ChartOptions {
  dimensions?: Partial<ChartDimensions>;
  a11y: AccessibilityMeta;
  yAxisLabel?: string;
  showGridlines?: boolean;     // default true
  showDataLabels?: boolean;    // default false on line, true on stacked bar
}
```

Defaults: `dimensions = { width: 800, height: 360, margins: { top: 24, right: 32, bottom: 48, left: 64 } }`. Sparkline default: `{ width: 120, height: 24, margins: { top: 2, right: 2, bottom: 2, left: 2 } }`.

### Color Palette (`portal/charts/palette.ts`)

Use the **Wong 8-color color-blind-safe palette** (Wong 2011, Nature Methods):
- `#000000`, `#E69F00`, `#56B4E9`, `#009E73`, `#F0E442`, `#0072B2`, `#D55E00`, `#CC79A7`

Plus 8 SVG `<pattern>` definitions (diagonal stripes, dots, crosshatch, vertical lines, etc.) keyed by index. Stacked-bar segments use both color AND pattern at the same index for redundancy.

```typescript
export const COLOR_PALETTE: readonly string[] = ['#000000', '#E69F00', '#56B4E9', '#009E73', '#F0E442', '#0072B2', '#D55E00', '#CC79A7'];
export const PATTERN_DEFS: string = `<defs>
  <pattern id="pat-0" .../>
  <pattern id="pat-1" .../>
  ...
</defs>`;
export function colorFor(index: number): string;   // wraps modulo PALETTE length
export function patternFor(index: number): string; // returns "url(#pat-N)"
```

All foreground/background pairs MUST satisfy a 4.5:1 contrast ratio against `#FFFFFF` background and `#1a1a1a` dark mode background. Black text on yellow (`#F0E442`) is the only combination requiring care; verify in unit tests.

### Scale Helpers (`portal/charts/scales.ts`)

```typescript
export function linearScaleY(domain: [number, number], range: [number, number]): (v: number) => number;
export function bandScaleX(domain: string[], range: [number, number], padding?: number): { scale: (key: string) => number; bandWidth: number };
export function dateScaleX(dates: string[], range: [number, number]): (date: string) => number;

export function formatCurrency(usd: number): string;       // "$1.23", "$1,234.56"
export function formatDate(iso: string, style: 'short' | 'long' | 'monthYear'): string;
                                                            // "Apr 17", "Apr 17, 2026", "Apr 2026"
export function niceTicks(min: number, max: number, count: number): number[];
                                                            // returns "round" tick values for the y-axis
```

All scales are pure functions; no DOM, no globals, no dates parsed beyond `Date.parse`.

### Line Chart (`portal/charts/line_chart.ts`)

```typescript
export function renderLineChart(data: ChartDataPoint[], opts: ChartOptions): string;
```

Algorithm:
1. Compute dimensions (merge user-supplied with defaults).
2. Compute y-domain `[0, max(data.value) * 1.1]`. Use `niceTicks` to pick 5–7 y-axis tick values.
3. Compute x-domain (sorted unique dates from `data`). Use `dateScaleX`.
4. Emit SVG root: `<svg width=... height=... viewBox="0 0 W H" role="img" aria-labelledby="chart-title chart-desc" xmlns="http://www.w3.org/2000/svg">`.
5. Emit `<title id="chart-title">`, `<desc id="chart-desc">`, and the visually-hidden tabular fallback (see §Accessibility).
6. Emit `PATTERN_DEFS` once (only when needed; line chart can omit).
7. If `showGridlines !== false`, emit horizontal gridlines at each y-tick (`stroke="#e5e7eb"`).
8. Emit y-axis: vertical line at `margins.left`, tick marks, tick labels via `formatCurrency`, axis label rotated 90° (`yAxisLabel`).
9. Emit x-axis: horizontal line at `height - margins.bottom`, tick marks every `Math.ceil(data.length / 8)` data points, labels via `formatDate(_, 'short')` rotated -45° if `data.length > 14`.
10. Emit the data line: `<polyline fill="none" stroke="${colorFor(0)}" stroke-width="2" points="..."/>`.
11. Emit data points as small circles (`r=3`) at each datum; each circle wrapped in a `<g>` with a `<title>` child containing `formatDate(_, 'long') + ': ' + formatCurrency(_)` for browser-native tooltips.
12. Close `</svg>`. Return string.

### Stacked Bar Chart (`portal/charts/stacked_bar_chart.ts`)

```typescript
export function renderStackedBarChart(series: StackedSeries[], opts: ChartOptions): string;
```

Algorithm:
1. Determine the segment-name superset across all `series` items (preserve first-seen order). Each segment gets a stable color/pattern index.
2. Compute per-bar total: `total = sum(segments.value)`. Y-domain `[0, max(total) * 1.1]`.
3. Compute `bandScaleX(dates, ...)` for bar positions.
4. Emit SVG header, `PATTERN_DEFS`, axes, gridlines (same as line chart).
5. For each bar, render segments bottom-up: each segment is a `<rect>` with `fill="${colorFor(i)}"` overlaid by a second `<rect>` with `fill="${patternFor(i)}" fill-opacity="0.35"` for color-blind safety.
6. Each segment `<rect>` is wrapped in `<g>` with `<title>` of `${segment.name}: ${formatCurrency(value)}`.
7. Emit a legend below the x-axis: one swatch per segment name with both color square and pattern preview.
8. If `showDataLabels !== false`, emit segment value as small text inside each segment when segment height >= 14px (otherwise skip to avoid overlap).

### Sparkline (`portal/charts/sparkline.ts`)

```typescript
export function renderSparkline(values: number[], opts?: { width?: number; height?: number; color?: string; a11yLabel?: string }): string;
```

Algorithm:
1. Default size 120×24. No axes, no gridlines, no labels.
2. Compute y-scale to fit `[min(values), max(values)]` into `[height - 2, 2]`.
3. Compute x-scale to fit `[0, values.length - 1]` into `[2, width - 2]`.
4. Emit SVG with `role="img"` and `aria-label="${a11yLabel || 'sparkline'}"`.
5. Emit a single `<polyline>` with `stroke-width="1.5"` and the chosen color (default `colorFor(0)`).
6. Emit a `<circle r="2">` at the last data point (the "current value" indicator).
7. Return string.

Sparklines are designed for inline embedding inside cost-cap status cards and SSE live update fragments. They MUST be byte-stable for identical inputs (used in snapshot tests).

### Accessibility (`portal/charts/accessibility.ts`)

```typescript
export function renderA11yMeta(meta: AccessibilityMeta): { title: string; desc: string };
export function renderTabularFallback(rows: { label: string; value: string }[]): string;
```

`renderTabularFallback` returns a `<g>` that contains a `<foreignObject>` wrapping a visually-hidden `<table>` (or, for environments that don't support `foreignObject`, a SVG `<text>` block). The table provides a complete data summary to screen readers without requiring sighted users to see it. Use the CSS class `sr-only` (defined in the asset pipeline from PLAN-013-4) for hide styling.

ARIA contract:
- Every chart `<svg>` MUST set `role="img"`.
- Every chart `<svg>` MUST set `aria-labelledby="chart-title chart-desc"` (or `aria-label` for sparklines that omit `<title>` for compactness).
- Tooltips on data points use the SVG `<title>` element (browser-native, screen-reader compatible — no JavaScript needed).

### Snapshot-Stable Output

All three render functions MUST produce **byte-identical** output for identical inputs. This means:
- No timestamps, UUIDs, or random IDs in the markup.
- All numbers rounded to 2 decimals before string conversion.
- Element order is deterministic (no `Object.keys` iteration without a sort).
- Whitespace is normalized: single space between attributes, no trailing whitespace, single `\n` between top-level elements.

This is required so SPEC-015-3-04 can use snapshot testing for chart fixtures without flake.

## Acceptance Criteria

- [ ] `renderLineChart` with 30 daily data points produces valid SVG that passes `xmllint --noout` (or equivalent W3C validator).
- [ ] `renderLineChart` output contains exactly one `<polyline>` for the data series and exactly 30 `<circle>` data points.
- [ ] `renderLineChart` output contains `role="img"` and `aria-labelledby` referencing IDs that exist within the SVG.
- [ ] `renderLineChart` output contains a `<title>` element whose text equals `opts.a11y.title`.
- [ ] `renderLineChart` output contains a `<desc>` element whose text equals `opts.a11y.description`.
- [ ] `renderLineChart` is byte-identical across two consecutive calls with the same input (snapshot test).
- [ ] `renderStackedBarChart` with 7 days × 7 phases produces 49 rendered segment rectangles plus 49 pattern overlays.
- [ ] `renderStackedBarChart` legend lists every distinct segment name in first-seen order.
- [ ] `renderStackedBarChart` shows a data label inside each segment when the segment height is ≥14px and omits it when smaller.
- [ ] `renderSparkline` with `[1, 5, 3, 8, 2]` produces a `<polyline>` with exactly 5 `points` and a single `<circle>` at the last point.
- [ ] `renderSparkline` default size is 120×24; user-provided dimensions override defaults.
- [ ] All charts include `xmlns="http://www.w3.org/2000/svg"` so they render correctly when served as standalone SVG.
- [ ] `formatCurrency(1234.567)` returns `"$1,234.57"` (banker's rounding to 2 decimals); `formatCurrency(0)` returns `"$0.00"`.
- [ ] `formatDate('2026-04-17', 'short')` returns `"Apr 17"`; `formatDate('2026-04-17', 'monthYear')` returns `"Apr 2026"`.
- [ ] `niceTicks(0, 23.7, 5)` returns ticks with round values (e.g., `[0, 5, 10, 15, 20, 25]`).
- [ ] `COLOR_PALETTE` has 8 entries, all distinct, all valid 6-digit hex.
- [ ] Color contrast: every palette color paired with `#FFFFFF` background satisfies a contrast ratio ≥4.5:1 — verified in palette unit test.
- [ ] Empty input handling: `renderLineChart([], opts)` returns a valid SVG with the title/desc and a "No data" text element; does not throw.
- [ ] Empty input handling: `renderStackedBarChart([], opts)` and `renderSparkline([], opts)` similarly do not throw and emit a valid empty-state SVG.
- [ ] Tabular fallback (`renderTabularFallback`) is present in every chart's output and contains one row per data point with label and value.
- [ ] Charts work without JavaScript: rendering the SVG into a fresh document via `jsdom` and inspecting computed text/attribute values works without any script execution.
- [ ] Performance: rendering a 30-day line chart completes in <50ms; stacked bar with 30 days × 7 phases in <100ms; sparkline in <5ms (measured per-call, average over 1000 iterations).

## Dependencies

- No third-party libraries. All math, date, and string formatting is hand-rolled in `scales.ts`.
- SPEC-015-3-01: `DailySummary`, `MonthlySummary`, and related types are converted by route handlers (downstream) into `ChartDataPoint` and `StackedSeries` before calling these renderers — the chart layer is data-shape-agnostic.
- CSS class `sr-only` from PLAN-013-4 asset pipeline: required for visually-hidden tabular fallback. If not yet present, add a minimal definition to `portal/static/sr-only.css` as part of this spec and import it from the chart-host page.

## Notes

- Charts intentionally do not consume the aggregation types directly. Route handlers map `DailySummary[] → ChartDataPoint[]` because the chart layer should remain reusable for non-cost data later (e.g., latency charts, queue depth).
- The pattern overlay on stacked bars is at `fill-opacity="0.35"` — high enough to be visible to color-blind users but low enough to not obscure the underlying color for sighted users.
- The Wong palette is preferred over viridis or Tableau because it includes black, which provides maximum contrast for the primary line on light backgrounds and is easily distinguishable in print.
- Snapshot stability is a non-negotiable property. Any code path that uses `Math.random`, `Date.now`, `crypto.randomUUID`, or unsorted `Map` iteration MUST be eliminated before merge.
- Sparklines are deliberately minimal — they render in <5ms and are safe to embed inside SSE-streamed fragments that update many times per minute.
