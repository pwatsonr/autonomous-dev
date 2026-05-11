# SPEC-037-1-03: Theme-Toggle JS Click Handler Wiring

## Metadata
- **Parent Plan**: PLAN-037-1-dark-theme-and-toggle
- **Parent TDD**: TDD-035-portal-redesign-shell-primitives (SS 6.7 theme-toggle module)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-03 theme persistence — cookie + localStorage round-trip)
- **Tasks Covered**: PLAN-037-1 in-scope item 5 (wire `theme-toggle.js` click handler to the new pill; cookie key alignment)
- **Estimated effort**: 0.5 day
- **Dependencies**: SPEC-037-1-02 (pill DOM exists with `data-action="toggle-theme"`), SPEC-034-1-05 (theme cookie module)
- **Priority**: P0 (closes the user-facing loop: click changes theme, persists across reload)
- **Status**: Draft
- **Date**: 2026-05-09

## Objective

Wire `server/static/theme-toggle.js` to attach a delegated click handler to `[data-action="toggle-theme"]` (the pill rendered by SPEC-037-1-02). On click: read the current `<html data-theme>`, compute the opposite, call the existing `setTheme(...)` to update DOM + `localStorage["portal-theme"]` + the `portal-theme` cookie, and also flip the `.tt-track.light`/`.tt-track.dark` class on the pill's inner span so the knob animates without a page reload. Cookie key is `portal-theme` (already in use; reject the kit's `autodev-theme`).

## Acceptance Criteria

- **AC-01**: After `DOMContentLoaded`, a single delegated `click` listener is registered on `document` (not on the button directly) that matches `event.target.closest('[data-action="toggle-theme"]')`. Adding/removing pills via HTMX swaps does not require re-registration.
- **AC-02**: On click, the handler reads `document.documentElement.dataset.theme`, sets `next = current === "dark" ? "light" : "dark"`, and calls the existing `setTheme(next)`. `setTheme` already writes `localStorage["portal-theme"]`, sets `data-theme`, and writes the `portal-theme` cookie (path=/, max-age=31536000, SameSite=Lax) — no duplication.
- **AC-03**: After `setTheme`, the handler finds the clicked button's descendant `.tt-track` and toggles its `light`/`dark` class to match `next` so the knob CSS transition fires.
- **AC-04**: The handler calls `event.preventDefault()` (button is `type="button"` so this is defensive only).
- **AC-05**: Cookie key constants in `theme-toggle.js` (`STORAGE_KEY`, `COOKIE_NAME`) remain `"portal-theme"`. No `autodev-theme` string appears anywhere in `plugins/autonomous-dev-portal/server/` after this spec. The kit's `autodev-theme` is documented as rejected in this spec's header comment.
- **AC-06**: Round-trip test: programmatic click → next SSR request (with the newly written cookie) returns HTML with the toggled `data-theme`. No page reload required for the in-page DOM change.
- **AC-07**: `node --check server/static/theme-toggle.js` passes. The file remains a single IIFE; no ES module syntax is introduced (the `<script>` tag in `shell.tsx` carries `type="module"`, which is compatible with the wrapped IIFE).

## Implementation

**Files modified:**

1. `plugins/autonomous-dev-portal/server/static/theme-toggle.js`
   - Inside the existing IIFE, after the line `window.setTheme = setTheme;`, add a `DOMContentLoaded` listener (guarded so it does not double-register if the script is parsed after DOMContentLoaded has already fired — use `document.readyState !== "loading"` check):
     ```
     function attachToggleHandler() {
       document.addEventListener("click", function (ev) {
         var btn = ev.target && ev.target.closest
           ? ev.target.closest('[data-action="toggle-theme"]')
           : null;
         if (!btn) return;
         ev.preventDefault();
         var current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
         var next = current === "dark" ? "light" : "dark";
         setTheme(next);
         var track = btn.querySelector(".tt-track");
         if (track) {
           track.classList.remove("light", "dark");
           track.classList.add(next);
         }
       });
     }
     if (document.readyState === "loading") {
       document.addEventListener("DOMContentLoaded", attachToggleHandler);
     } else {
       attachToggleHandler();
     }
     ```
   - Update the file header docstring to record that the delegated `[data-action="toggle-theme"]` handler is wired here; cookie key stays `portal-theme`; kit's `autodev-theme` is intentionally not adopted.

2. `plugins/autonomous-dev-portal/tests/unit/theme-toggle-handler.test.ts` (NEW)
   - Set up a `jsdom` document with the pill markup. Load `theme-toggle.js`. Dispatch a `click` on the button. Assert `data-theme` flipped, `localStorage["portal-theme"]` flipped, `document.cookie` contains `portal-theme=<next>`, and `.tt-track` class flipped.

3. `plugins/autonomous-dev-portal/tests/integration/theme-cookie-roundtrip.test.ts` (NEW or extend `theme-cookie.test.ts`)
   - Hit `GET /`, capture `Set-Cookie` after simulating a toggle, then hit `GET /` again with that cookie and assert SSR `data-theme` flipped.

**Steps:**

1. Add the handler block + readyState guard to `theme-toggle.js`.
2. Write the jsdom unit test.
3. Extend the integration test.
4. Manual smoke per PLAN-037-1 Verification: click the pill, watch `data-theme` flip without reload, reload, confirm SSR honors the cookie.

## Tests

`tests/unit/theme-toggle-handler.test.ts`:

| ID | Assertion |
|----|-----------|
| H-01 | Click on pill with `data-theme="dark"` results in `documentElement.dataset.theme === "light"` |
| H-02 | After click, `localStorage.getItem("portal-theme")` matches the new theme |
| H-03 | After click, `document.cookie` contains `portal-theme=<new>` |
| H-04 | After click, the inner `.tt-track` has class `light` (or `dark`) matching the new theme and not the old |
| H-05 | A second click flips back to the original theme |
| H-06 | Clicking a non-toggle element does not change `data-theme` |

`tests/integration/theme-cookie-roundtrip.test.ts`:

| ID | Assertion |
|----|-----------|
| R-01 | `GET /` (no cookie) returns `data-theme="dark"` (per SPEC-037-1-01) |
| R-02 | Subsequent `GET /` with `Cookie: portal-theme=light` returns `data-theme="light"` |
| R-03 | Subsequent `GET /` with `Cookie: portal-theme=dark` returns `data-theme="dark"` |

## Verification

```
cd plugins/autonomous-dev-portal
node --check server/static/theme-toggle.js
npm test -- tests/unit/theme-toggle-handler.test.ts
npm test -- tests/integration/theme-cookie-roundtrip.test.ts
grep -RIn "autodev-theme" server/ tests/ && echo "FAIL: stray autodev-theme reference" || echo "OK no autodev-theme leak"
grep -n "data-action=\"toggle-theme\"" server/static/theme-toggle.js >/dev/null && echo "OK handler bound to selector" || echo "FAIL selector missing"
curl -s "http://127.0.0.1:${PORT:-19281}/" | grep -o 'data-action="toggle-theme"' >/dev/null && echo "OK pill rendered for handler" || echo "FAIL no pill on page"
```
