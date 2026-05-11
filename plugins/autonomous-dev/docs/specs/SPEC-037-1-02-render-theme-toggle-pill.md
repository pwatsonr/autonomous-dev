# SPEC-037-1-02: Render Theme-Toggle Pill in Rail-Ops

## Metadata
- **Parent Plan**: PLAN-037-1-dark-theme-and-toggle
- **Parent TDD**: TDD-035-portal-redesign-shell-primitives (SS 6.7 theme-toggle)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-03 theme persistence)
- **Tasks Covered**: PLAN-037-1 in-scope item 4 (render `.theme-toggle` pill markup inside `<div class="rail-ops">`)
- **Estimated effort**: 0.25 day
- **Dependencies**: SPEC-037-1-01 (dark default flipped; pill initial state depends on the new default)
- **Priority**: P0 (no DOM control exists today — CSS at `static/app.css:111-160` has no consumer)
- **Status**: Draft
- **Date**: 2026-05-09

## Objective

Render the kit's `.theme-toggle` pill markup inside `ShellLayout`'s `<div class="rail-ops">`, immediately after the kill-switch button, using the exact structure from `/tmp/portal-design-v2/.../Shell.jsx`. The `.theme-toggle`, `.tt-track`, `.tt-knob`, and `.tt-l` CSS rules already exist; this spec is markup-only. JS wiring is deferred to SPEC-037-1-03.

## Acceptance Criteria

- **AC-01**: `ShellLayout` renders, inside `<div class="rail-ops">` and after the existing kill-switch `<button class="kbtn">`, a `<button class="theme-toggle" type="button" aria-label="Toggle theme" data-action="toggle-theme">` element.
- **AC-02**: The button's only child is `<span class="tt-track {theme}">` where `{theme}` is the resolved theme (`"light"` or `"dark"`). The track contains exactly three children in order: `<span class="tt-knob" />`, `<span class="tt-l tt-light">LIGHT</span>`, `<span class="tt-l tt-dark">DARK</span>`.
- **AC-03**: When `ShellLayout` resolves `theme === "dark"`, the rendered class is `tt-track dark` (knob translated right per CSS). When `"light"`, class is `tt-track light` (knob at left).
- **AC-04**: The button is rendered AFTER the kill-switch button and AFTER the optional `mtdSpend` `<div>`, so it is the last child of `.rail-ops`. (Placement matches the kit Shell.jsx order; mtd-spend remains visually above the toggle.)
- **AC-05**: No inline `style=""` attribute, no inline `onclick`. CSP-safe by construction.
- **AC-06**: Visual diff against `/tmp/portal-design-v2/autonomous-dev-design-system/project/screenshots/dashboard.png` shows the toggle pill rendered with the knob on the dark side for a cookie-less request.

## Implementation

**Files modified:**

1. `plugins/autonomous-dev-portal/server/components/shell.tsx`
   - Inside the `<div class="rail-ops">` block, AFTER the `mtdSpend` conditional (so the toggle is the final child), insert:
     ```
     <button
       type="button"
       class="theme-toggle"
       aria-label="Toggle theme"
       data-action="toggle-theme"
     >
       <span class={`tt-track ${resolvedTheme}`}>
         <span class="tt-knob"></span>
         <span class="tt-l tt-light">LIGHT</span>
         <span class="tt-l tt-dark">DARK</span>
       </span>
     </button>
     ```
   - No other changes to `shell.tsx`. The button has no `onclick`; SPEC-037-1-03 attaches a delegated handler.

2. `plugins/autonomous-dev-portal/tests/unit/theme-toggle-pill.test.tsx` (NEW)
   - JSX-render `ShellLayout` and assert the pill markup matches AC-01..AC-04.

**Steps:**

1. Add the button to `shell.tsx` in the location specified above.
2. Write the new unit test file.
3. Run unit + render integration tests.
4. Manual smoke: load portal cold, confirm pill renders with knob on the right (dark side).

## Tests

`tests/unit/theme-toggle-pill.test.tsx`:

| ID | Assertion |
|----|-----------|
| P-01 | Rendered HTML contains a `<button class="theme-toggle" ... data-action="toggle-theme">` inside `.rail-ops` |
| P-02 | The button's child is `<span class="tt-track dark">` when `theme="dark"` (or omitted, given SPEC-037-1-01) |
| P-03 | The button's child is `<span class="tt-track light">` when `theme="light"` |
| P-04 | `.tt-track` has exactly three children: `.tt-knob`, `.tt-l.tt-light`, `.tt-l.tt-dark`, in that order |
| P-05 | The `.theme-toggle` button is the LAST child of `.rail-ops` |
| P-06 | `aria-label="Toggle theme"` is present |

## Verification

```
cd plugins/autonomous-dev-portal
npm test -- tests/unit/theme-toggle-pill.test.tsx
npm test -- tests/unit/shell-layout.test.tsx
curl -s "http://127.0.0.1:${PORT:-19281}/" | grep -o 'class="theme-toggle"' >/dev/null && echo "OK pill rendered" || echo "FAIL pill missing"
curl -s "http://127.0.0.1:${PORT:-19281}/" | grep -oE 'tt-track (dark|light)' | head -1
curl -s "http://127.0.0.1:${PORT:-19281}/" | grep -o 'data-action="toggle-theme"' >/dev/null && echo "OK data-action present" || echo "FAIL data-action missing"
```
