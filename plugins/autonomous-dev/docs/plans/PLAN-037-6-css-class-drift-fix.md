# PLAN-037-6: CSS class drift fix

## Metadata
- **Parent**: PLAN-037-portal-kit-parity
- **Effort**: 1 day
- **Dependencies**: []
- **Priority**: P1 (low effort, high visual impact — fixes "looks unstyled" reports)

## Objective

Multiple templates emit CSS classes that don't match what `static/app.css` actually defines. Result: portions of the page render with no styling because the selectors don't hit. Reconcile templates to use the kit's canonical class names, OR add the missing rules.

## Scope

### In Scope

Catalog from gap audit:

| Template class | Kit/CSS class | Fix |
|---|---|---|
| `.kpi-value` | `.kpi-num` | Rename in `templates/fragments/kpi-strip.tsx` |
| `.rc-top, .rc-name, .rc-trust, .rc-path, .rc-meta, .rc-footer` | `.repo-top, .repo-id, .repo-trust, .repo-path, .repo-meta-row, .repo-foot` | Rename in `templates/fragments/repo-card.tsx` |
| `.lvl, .lvl-info, .lvl-warn, .lvl-err, .ts, .msg` | `.l-time, .l-info, .l-warn, .l-err, .l-mark` (inline spans) | Rebuild log-line markup in `templates/fragments/live-log.tsx` |
| Repo card double-wrapper `<Card><div class="repo-card">` | `<button class="repo-card">` | Refactor to single button element |
| `.chip info` (reviewer roles, deploy backends) | `.chip role-specialist, .chip role-generic, .chip backend sm` | Update emitters in `templates/views/costs.tsx` |
| Inline `style="border-left: ..."` on Card | `<Card leftBar="code">` (the `Card` primitive's existing prop) | Refactor `repo-card.tsx`, `design-system.tsx` |

Also remove the **empty `static/portal.css`** (1 line) or document why it's loaded. Empty stylesheets are confusing.

### Out of Scope
- New CSS rules — only renames + DOM shape fixes.

## Verification
- `grep -E "kpi-value|rc-top|rc-name|lvl-info|risk-high|risk-med" templates/` returns 0 results.
- Each surface rendered in the browser shows correct styling for the affected regions (visual diff against the kit screenshots).
- `static/portal.css` is either removed or contains meaningful rules.

## Tests
- Snapshot tests on each affected fragment confirming the new class names.

## Risks
| Risk | Mitigation |
|---|---|
| Other templates reference the old class names via lookup | Grep the full codebase before renames; rename everywhere in one commit |
| Removing `portal.css` breaks something that depends on the empty file being loadable | Replace with a 1-line comment file rather than delete |
