# SPEC-037-3-04: RailOps — 3-line metrics block (Daemon / Breaker / MTD)

## Metadata
- **Parent Plan**: PLAN-037-3-rail-and-nav-completeness
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Tasks Covered**: PLAN-037-3 Scope item 6
- **Estimated effort**: 0.5 day
- **Dependencies**: SPEC-035-1-01 (ShellLayout structure), PLAN-037-2 (daemon-status endpoint)
- **Priority**: P0
- **Status**: Draft
- **Date**: 2026-05-09

## Objective

Rewrite the `.rail-ops` block inside `shell.tsx` to render the kit-spec 3-line metrics layout — Daemon state, Breaker state, MTD spend — each with a colored status dot and a right-aligned mono value, followed by the kill-switch button and theme toggle. Replaces the current single-line daemon pill + minimal MTD div.

## Acceptance Criteria

- **AC-01**: `.rail-ops` renders three `<div class="line">` rows in order: (1) Daemon, (2) Breaker, (3) MTD spend. Each row has the shape `<div class="line"><span class="dot {tone}" /> {label} <span class="v">{value}</span></div>`.
- **AC-02**: Daemon row — `tone="live"` when `daemonStatus="running"`, `"warn"` when `"stale"`, `"err"` when `"down"`, `"muted"` when `"unknown"`. Label text: `Daemon running` / `Daemon stale` / `Daemon down` / `Daemon unknown`. Value: `{daemonAgeSeconds}s` (e.g. `2s`) when status is known; empty string otherwise.
- **AC-03**: Breaker row — `tone="ok"` when `breakerState="OK"`, `tone="err"` when `"TRIPPED"`, `tone="muted"` when `"unknown"`. Label `Breaker {STATE}`. Value `{count}/{threshold}` (e.g. `0/3`). When values are unavailable, value renders `--/--`.
- **AC-04**: MTD row — `tone="warn"` when `mtdPctOfCap >= 75`, `tone="err"` when `>= 100`, `tone="ok"` otherwise. Label `MTD spend`. Value `${mtdSpend.toFixed(2)} ({mtdPctOfCap}%)` (e.g. `$16.84 (4%)`). When `mtdSpend === undefined`, the entire row is omitted.
- **AC-05**: Below the 3 lines: existing kill-switch button (`.kbtn`, unchanged HTMX wiring), then a new theme-toggle button rendered as `<button class="theme-toggle" type="button" aria-label="Toggle theme">…</button>` matching the kit's `.tt-track`/`.tt-knob`/`.tt-l` structure. The toggle's click handler is supplied by the existing `/static/theme-toggle.js` module (already loaded by ShellLayout).
- **AC-06**: New `ShellProps` fields added: `daemonAgeSeconds?: number`, `breakerState?: "OK" | "TRIPPED" | "unknown"`, `breakerCount?: number`, `breakerThreshold?: number`, `mtdPctOfCap?: number`. Existing `daemonStatus`, `killSwitchEngaged`, `mtdSpend` retained.

## Implementation

Files modified:
1. `plugins/autonomous-dev-portal/server/components/shell.tsx` — replace the `.rail-ops` JSX block with the 3-line layout + theme toggle.
2. `plugins/autonomous-dev-portal/server/static/portal.css` — add/verify `.rail-ops .line`, `.rail-ops .v`, `.dot.live/.warn/.err/.ok/.muted`, and `.theme-toggle .tt-*` rules per kit.
3. `plugins/autonomous-dev-portal/server/static/theme-toggle.js` — ensure event delegation also catches `.theme-toggle` (in addition to whatever selector it currently uses).

Steps:
1. Extract a small internal `<RailOpsRow tone label value />` helper inside `shell.tsx` to remove repetition across the 3 rows.
2. Compute `mtdTone` from `mtdPctOfCap` via simple thresholds before render.
3. Preserve kill-switch HTMX attributes verbatim.
4. Verify `theme-toggle.js` toggles `data-theme` on `<html>` and persists to `localStorage` under the same key already used by the FOUC IIFE (`portal-theme`).

## Tests

Extend `plugins/autonomous-dev-portal/tests/unit/components/shell-layout.test.tsx`:

| ID | Assertion |
|----|-----------|
| SH-10 | `.rail-ops` contains exactly 3 `.line` children when `mtdSpend` is defined |
| SH-11 | `.rail-ops` contains 2 `.line` children when `mtdSpend` is undefined |
| SH-12 | `daemonStatus="stale"` → first dot has class `warn`; label includes `stale` |
| SH-13 | `breakerState="TRIPPED"` + `breakerCount=3` + `breakerThreshold=3` → value renders `3/3` and dot is `err` |
| SH-14 | `mtdPctOfCap=85` → MTD dot is `warn`; value contains `(85%)` |
| SH-15 | `.theme-toggle` button is present after `.kbtn` |

## Verification

```bash
cd plugins/autonomous-dev-portal
npm test -- tests/unit/components/shell-layout.test.tsx
curl -s http://127.0.0.1:19280/ | grep -c "rail-ops"        # expect >=1
curl -s http://127.0.0.1:19280/ | grep -oE '\$[0-9]+\.[0-9]{2} \([0-9]+%\)'
autonomous-dev daemon stop && curl -s http://127.0.0.1:19280/ | grep "Daemon down"
```
