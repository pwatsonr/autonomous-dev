# SPEC-035-1-03: RailOpsBar Component

## Metadata
- **Parent Plan**: PLAN-035-1-layout-shell-and-brand
- **Parent TDD**: TDD-035-portal-redesign-shell-primitives (SS 6.3)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-05, R-13)
- **Tasks Covered**: PLAN-035-1 Task 3 + Task 7 (rail-ops CSS subset)
- **Estimated effort**: 0.75 day (0.5d component + 0.25d CSS)
- **Dependencies**: SPEC-035-1-01 (consumed by ShellLayout); existing `StateReader`/`HeartbeatReader`/`CostReader` (no new readers)
- **Priority**: P0
- **Status**: Draft
- **Date**: 2026-05-09

## Objective

Implement `RailOpsBar` at `server/components/rail-ops-bar.tsx` as the fixed-bottom region of the left rail rendering daemon status, breaker state, MTD spend, the kill-switch HTMX trigger button, and the theme-toggle button. Dot tones map deterministically from input props per TDD-035 SS 6.3. Add `.rail-ops`, `.line`, `.kbtn`, `.theme-toggle`, `.tt-*` CSS to `portal.css`. SSE-driven re-renders are not in scope here (existing fragments handle that); this spec only covers the SSR-time markup and CSS.

## Acceptance Criteria

- **AC-01**: `server/components/rail-ops-bar.tsx` exports `RailOpsBar: FC<{ daemonStatus: "running"|"stale"|"dead"|"unknown"; killSwitchEngaged: boolean; breakerTripped: boolean; mtdSpend?: number }>`.
- **AC-02**: Output is `<div class="rail-ops">` containing four children in order — daemon line, breaker line, MTD-spend line, `<button class="kbtn">` and `<button class="theme-toggle" id="theme-toggle">` (matching the markup in TDD-035 SS 6.3).
- **AC-03**: Daemon line dot class mapping: `running` → `dot live`, `stale` → `dot warn`, `dead` → `dot err`, `unknown` → `dot muted`. Label text is `Daemon running` / `Daemon stale` / `Daemon dead` / `Daemon unknown` respectively.
- **AC-04**: Breaker line dot class mapping: `breakerTripped=false` → `dot ok` (label `Breaker OK`), `true` → `dot err` (label `Breaker TRIPPED`).
- **AC-05**: MTD-spend line dot class mapping: when `mtdSpend` is undefined, render `dot muted` and label `MTD spend —`; otherwise render `dot ok` (label e.g. `MTD spend $1,843.00`). Note: the 80%-of-cap warn threshold per TDD-035 SS 6.3 requires a daemon-side cap reading not in scope for this spec — document the TODO inline; default to `ok` until cap data is wired (deferred to TDD-018-C).
- **AC-06**: Kill-switch button `<button class="kbtn" hx-get="/ops/kill-switch-modal?step=arm" hx-target="#modal-slot">` renders text `Engage kill switch` when `killSwitchEngaged=false`, and `Kill switch ENGAGED` (with `aria-disabled="true"`) when `true`. (The route handler for `/ops/kill-switch-modal` is provided by PLAN-035-3, not this spec.)
- **AC-07**: Theme-toggle button has `id="theme-toggle"`, `aria-label="Toggle theme"`, and contains `<span class="tt-track light"><span class="tt-knob"></span><span class="tt-l tt-light">LIGHT</span><span class="tt-l tt-dark">DARK</span></span>`. (Note: this spec ships the `tt-track light` default; SPEC-035-1-05's IIFE rewrites the class on mount based on the persisted theme.)
- **AC-08**: `portal.css` gains `.rail-ops` (border-top hairline, `padding: 12px`), `.rail-ops .line` (flex with dot + label + value), `.rail-ops .line .v` (right-aligned monospace value), `.kbtn` (`border: 1px solid var(--err-line); color: var(--err); background: transparent`), engaged-state `.kbtn[aria-disabled="true"]` adds `background: var(--err-tint)`, and `.theme-toggle` + `.tt-track` + `.tt-knob` per TDD-035 SS 15.

## Implementation

**Files created/modified:**

1. `plugins/autonomous-dev-portal/server/components/rail-ops-bar.tsx` (NEW)
2. `plugins/autonomous-dev-portal/server/static/portal.css` (MODIFIED)

**Steps:**

1. Define the `RailOpsBarProps` interface and a small `dotClassFor*` helper per status enum.
2. Render the four-line block + two buttons per TDD-035 SS 6.3 markup.
3. Inline-comment the 80%-of-cap TODO referencing TDD-018-C.
4. Append CSS block under `/* === RailOpsBar (TDD-035 SS 6.3) === */`.
5. Re-grep for stray `box-shadow:` literals (R-15a).

## Tests

`tests/unit/components/rail-ops-bar.test.tsx`:

| ID | Assertion |
|----|-----------|
| O-01 | `daemonStatus="running"` produces `<span class="dot live">` |
| O-02 | `daemonStatus="stale"` produces `<span class="dot warn">` |
| O-03 | `daemonStatus="dead"` produces `<span class="dot err">` |
| O-04 | `daemonStatus="unknown"` produces `<span class="dot muted">` |
| O-05 | `breakerTripped=true` produces breaker line with `dot err` |
| O-06 | `mtdSpend` undefined renders muted dot and `MTD spend —` |
| O-07 | `killSwitchEngaged=false` button text is `Engage kill switch`; HTMX attrs present |
| O-08 | `killSwitchEngaged=true` button text is `Kill switch ENGAGED` and `aria-disabled="true"` |
| O-09 | Theme-toggle button has `id="theme-toggle"` and contains `.tt-track.light` |

## Verification

```bash
cd plugins/autonomous-dev-portal
npm test -- tests/unit/components/rail-ops-bar.test.tsx
grep -n "hx-target=\"#modal-slot\"" server/components/rail-ops-bar.tsx
grep -n "aria-label=\"Toggle theme\"" server/components/rail-ops-bar.tsx
```
