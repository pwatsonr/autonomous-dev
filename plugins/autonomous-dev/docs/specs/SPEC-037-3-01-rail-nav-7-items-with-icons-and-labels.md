# SPEC-037-3-01: RailNav — 7 items with icons and group labels

## Metadata
- **Parent Plan**: PLAN-037-3-rail-and-nav-completeness
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Tasks Covered**: PLAN-037-3 Scope items 1, 2, 3
- **Estimated effort**: 0.5 day
- **Dependencies**: SPEC-035-1-02 (existing 5-item RailNav), SPEC-034-1-03 (icon helper)
- **Priority**: P0
- **Status**: Draft
- **Date**: 2026-05-10

## Objective

Extend `server/components/rail-nav.tsx` from 5 to 7 portal-core nav entries, render a Lucide icon inside every item via the existing `icon()` helper, and add mono uppercase group labels (`OPERATE`, `SYSTEM`) so the rendered rail matches the kit's `Shell.jsx` reference. Adds 2 new entries: Requests, Agents. Vendors any missing icon SVG (`sliders`) in the same change.

**Homelab is intentionally omitted from portal core.** The kit's Homelab nav entry will be contributed by the `autonomous-dev-homelab` plugin via a future portal-plugin-contribution mechanism (separate plan). Do NOT hardcode a Homelab entry here.

## Acceptance Criteria

- **AC-01**: `NAV_ITEMS` exports exactly 7 entries in this order with hrefs and groups: `/` Dashboard (operate), `/approvals` Approvals (operate), `/requests` Requests (operate), `/costs` Costs (operate), `/settings#agents` Agents (system), `/settings` Settings (system), `/ops` Ops (system). Each entry includes a new `iconName: string` field.
- **AC-02**: Icon names per item — Dashboard→`activity`, Approvals→`shield-alert`, Requests→`git-pull-request`, Costs→`dollar-sign`, Agents→`bot`, Settings→`sliders`, Ops→`terminal`. Missing icon `sliders.svg` is vendored into `server/static/icons/sliders.svg` from Lucide.
- **AC-03**: Each `<a class="rail-nav-item">` contains a `<span class="ic" aria-hidden="true">` populated by `dangerouslySetInnerHTML={{ __html: icon(item.iconName, 14) }}` (size 14 to match kit's `.rail-nav .ic { width:14px }`).
- **AC-04**: Each `<div class="rail-nav-group">` opens with a `<div class="rail-nav-group-label">OPERATE</div>` or `<div class="rail-nav-group-label">SYSTEM</div>` heading. Labels are uppercase literal strings; CSS handles font-family (mono) and letter-spacing.
- **AC-05**: Existing AC contract from SPEC-035-1-02 still holds: exactly one active item per render, `aria-current="page"` only on active, `.count` rendering preserved (badge wiring is SPEC-037-3-02).
- **AC-06**: `RailNavProps` retains backwards-compatible `approvalsCount?` from SPEC-035-1-02. New badge props are added by SPEC-037-3-02 — this spec must not break callers that pass only `activePath` + `approvalsCount`.
- **AC-07**: No `/homelab` href appears in `NAV_ITEMS`; grep `homelab` in `rail-nav.tsx` returns zero matches. Future Homelab contribution must use the plugin-contribution API (out of scope here).

## Implementation

Files modified:
1. `plugins/autonomous-dev-portal/server/components/rail-nav.tsx` — extend NAV_ITEMS to 7, add `iconName`, render icon via `icon()`, add group label `<div>`s.
2. `plugins/autonomous-dev-portal/server/static/icons/sliders.svg` (NEW) — vendor Lucide `sliders.svg`.
3. `plugins/autonomous-dev-portal/server/static/portal.css` — add `.rail-nav-group-label` rule if missing (mono, `text-transform: uppercase`, `font-size: 11px`, `letter-spacing: 0.08em`, `color: var(--fg-2)`).

Steps:
1. Add `iconName: string` to the `NavItem` interface; update all 7 NAV_ITEMS entries.
2. Update `renderItem` to inject the inline SVG: `<span class="ic" dangerouslySetInnerHTML={{ __html: icon(item.iconName, 14) }} aria-hidden="true" />`.
3. Wrap each group's items with the label `<div>` before the items.
4. Copy `sliders.svg` from upstream Lucide (24x24, stroke `currentColor`).

## Tests

Extend `plugins/autonomous-dev-portal/tests/unit/components/rail-nav.test.tsx`:

| ID | Assertion |
|----|-----------|
| N-08 | Renders 7 anchors with hrefs in order: `/`, `/approvals`, `/requests`, `/costs`, `/settings#agents`, `/settings`, `/ops` |
| N-09 | Each anchor contains a `<span class="ic">` with a non-empty `<svg>` child |
| N-10 | "Operate" group contains 4 items (Dashboard, Approvals, Requests, Costs); "System" group contains 3 (Agents, Settings, Ops) |
| N-11 | First child of each `.rail-nav-group` is a `.rail-nav-group-label` with text `OPERATE` or `SYSTEM` |
| N-12 | `icon("sliders")` returns SVG markup (file exists check) |
| N-13 | `/homelab` is NOT in any rendered href (negative assertion — Homelab is plugin-contributed, not portal-core) |

## Verification

```bash
cd plugins/autonomous-dev-portal
npm test -- tests/unit/components/rail-nav.test.tsx
ls server/static/icons/sliders.svg
curl -s http://127.0.0.1:19280/ | grep -c "rail-nav-item"   # expect 7
curl -s http://127.0.0.1:19280/ | grep -c "rail-nav-group-label"  # expect 2
curl -s http://127.0.0.1:19280/ | grep -c "homelab"  # expect 0
```
