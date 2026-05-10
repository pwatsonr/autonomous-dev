# SPEC-035-1-02: RailNav Component

## Metadata
- **Parent Plan**: PLAN-035-1-layout-shell-and-brand
- **Parent TDD**: TDD-035-portal-redesign-shell-primitives (SS 6.2)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-05)
- **Tasks Covered**: PLAN-035-1 Task 2 + Task 7 (rail-nav CSS subset)
- **Estimated effort**: 0.75 day (0.5d component + 0.25d CSS)
- **Dependencies**: SPEC-035-1-01 (consumed by ShellLayout)
- **Priority**: P0
- **Status**: Draft
- **Date**: 2026-05-09

## Objective

Implement `RailNav` at `server/components/rail-nav.tsx` as the section navigation rendered inside the left rail. The seven NAV_ITEMS (Dashboard, Approvals, Costs, Operations, Settings, Audit, Design system) split into "Operate" and "System" groups, with active-route detection via `activePath` and a `gateCount` count badge on the Approvals item when non-zero. Add corresponding CSS to `portal.css`.

## Acceptance Criteria

- **AC-01**: `server/components/rail-nav.tsx` exports `RailNav: FC<{ activePath: string; gateCount?: number }>` and a `const NAV_ITEMS: readonly NavItem[]` matching TDD-035 SS 6.2 verbatim — seven items in the documented order: `/`, `/approvals`, `/costs`, `/ops`, `/settings`, `/audit`, `/design-system`. Items 1–4 are `group: "operate"`; items 5–7 are `group: "system"`.
- **AC-02**: Output is `<nav class="rail-nav" aria-label="Primary">` containing two `<div class="group">` sections in order — `Operate` group first, `System` group second. Each group's items render as `<a href={item.href} class={...}>` with an icon span (`.ic`), label text, and (for Approvals only) a count span (`.count`).
- **AC-03**: For the item where `activePath === item.href`, the anchor receives class `active` AND attribute `aria-current="page"`. Exactly one item is active per render (verified by tests with each of the seven `activePath` values).
- **AC-04**: When `gateCount` is provided and `> 0`, the Approvals item renders `<span class="count">{gateCount}</span>` after the label. When `gateCount` is `0`, `undefined`, or omitted, no `.count` span renders.
- **AC-05**: `portal.css` gains: `.rail-nav` (`display: flex; flex-direction: column; padding: 8px; flex: 1; gap: 1px`), `.rail-nav .group` (with leading group label spacing), `.rail-nav a` (`padding: 7px 10px; border-radius: 3px; font-size: 13px; color: var(--fg-1); text-decoration: none`), `.rail-nav a.active` (`background: var(--bg-2); color: var(--fg-0); box-shadow: inset 2px 0 0 var(--brand)` — note R-15a permits `inset` shadow as a brand-bar accent and is documented in TDD-035 SS 15), `.rail-nav a .count` (small numeric badge), `.rail-nav a .ic` (icon slot, 14px square).

## Implementation

**Files created/modified:**

1. `plugins/autonomous-dev-portal/server/components/rail-nav.tsx` (NEW)
2. `plugins/autonomous-dev-portal/server/static/portal.css` (MODIFIED) — append rail-nav block

**Steps:**

1. Define the `NavItem` interface and `NAV_ITEMS` constant from TDD-035 SS 6.2 (literal seven entries).
2. Implement `RailNav` FC: filter NAV_ITEMS by group, render an `<a>` per item; include `aria-current="page"` only on the active item.
3. For Approvals, conditionally render the count badge when `gateCount && gateCount > 0`.
4. Append `/* === RailNav (TDD-035 SS 6.2) === */` block to `portal.css`.
5. Verify the anchor `box-shadow` literal usage is the inset brand bar only — no drop shadows.

## Tests

`tests/unit/components/rail-nav.test.tsx`:

| ID | Assertion |
|----|-----------|
| N-01 | Renders seven anchors with hrefs `/`, `/approvals`, `/costs`, `/ops`, `/settings`, `/audit`, `/design-system` in order |
| N-02 | With `activePath="/approvals"`, only the Approvals anchor has class `active` and `aria-current="page"` |
| N-03 | Other six anchors lack `aria-current` |
| N-04 | With `gateCount={3}`, Approvals anchor contains `<span class="count">3</span>` |
| N-05 | With `gateCount={0}`, no `.count` span renders |
| N-06 | With `gateCount` omitted, no `.count` span renders |
| N-07 | NAV_ITEMS exposes two groups; first four items are `operate`, last three are `system` |

## Verification

```bash
cd plugins/autonomous-dev-portal
npm test -- tests/unit/components/rail-nav.test.tsx
grep -c "href=\"/" server/components/rail-nav.tsx   # expect >= 7
grep -n "aria-current" server/components/rail-nav.tsx
```
