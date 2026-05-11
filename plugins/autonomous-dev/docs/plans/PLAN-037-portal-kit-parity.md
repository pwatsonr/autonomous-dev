# PLAN-037: Portal Visual & Functional Parity with Design Kit (parent)

## Metadata
- **Parent TDD**: n/a — follow-up on PRD-018 ship-out, sourced from gap audit at `/tmp/PLAN-037-audit.md`
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Estimated effort**: ~14 days across 7 child plans
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P0 (the portal is shipped but the user reports "the styling still does not match")
- **Stage**: Post-rollout parity sweep

## Objective

After landing PRD-018 (60 specs, 28 PRs) the portal renders with the kit's tokens and primitives but **does not match the kit visually or behaviorally**:

- Theme defaults to light when the kit defaults to dark.
- Nav has 5 of 8 kit items; rail-ops bar has 1 of 3 metric lines; brand wordmark missing meta-line.
- Approvals surface is a flat `<article class="approval-item risk-high">` list instead of the kit's KPI + segmented filter + gate-row layout.
- Settings Variants / Backends / Agents tabs are flat tables instead of the kit's `.variant-grid` / `.backend-grid` / inspect-modal layouts.
- **10+ HTMX endpoints return HTTP 404** (approvals, settings notifications, agent actions, gate actions, daemon-status pill, /portal/events SSE bus, confirmation flow).
- CSS class names drift between templates and `static/app.css` (e.g. templates emit `.rc-name` while CSS defines `.repo-id` — result: unstyled).
- ShellLayout never receives `daemonStatus` / `mtdSpend` / `approvalsCount` — the rail looks identical on every page.

This parent plan decomposes the parity work into 7 child plans, each with a small, focused scope. Children ordered by dependency: 1, 2, 3 unblock the rest.

## Children

| Plan | Title | Effort | Priority | Depends on |
|---|---|---|---|---|
| [PLAN-037-1](PLAN-037-1-dark-theme-and-toggle.md) | Dark-default theme + theme-toggle pill | 1d | P0 | — |
| [PLAN-037-2](PLAN-037-2-mount-missing-routes.md) | Mount missing API + SSE routes | 2d | P0 | — |
| [PLAN-037-3](PLAN-037-3-rail-and-nav-completeness.md) | Rail-ops + nav completeness | 2d | P0 | 037-1 |
| [PLAN-037-4](PLAN-037-4-approvals-rebuild.md) | Approvals surface rebuild | 3d | P1 | 037-2 |
| [PLAN-037-5](PLAN-037-5-settings-tab-layouts.md) | Settings rich tab layouts | 3d | P1 | 037-2 |
| [PLAN-037-6](PLAN-037-6-css-class-drift-fix.md) | CSS class drift fix | 1d | P1 | — |
| [PLAN-037-7](PLAN-037-7-request-detail-completeness.md) | Request Detail completeness | 2d | P2 | 037-2 |

## Out-of-scope

- New features beyond the kit (live config edit modals beyond what the kit shows, etc.)
- Homelab surface — will land later as a contribution from the `autonomous-dev-homelab` plugin (separate plan; portal contribution mechanism TBD)
- Re-doing PRD-018 — this is a parity sweep, not a redesign

## Acceptance (rolled-up)

- Side-by-side screenshot of every portal surface matches the kit's reference screenshots within reasonable tolerance.
- No HTMX endpoint referenced by any rendered template returns HTTP 404.
- Rail-ops bar reflects current daemon state, MTD spend, and approval count on every page.
- Theme defaults to dark; toggle switches and persists.
