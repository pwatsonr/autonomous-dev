# SPEC-036-4-02: Settings Tabs JS Module (Deep-Link Mechanism)

## Metadata
- **Parent Plan**: PLAN-036-4
- **Parent TDD**: TDD-036-portal-redesign-surfaces (v1.1, §6.5 deep-link mechanism)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-20)
- **Tasks Covered**: PLAN-036-4 Task 10 (`settings-tabs.js`)
- **Estimated effort**: 0.5 day
- **Dependencies**: SPEC-036-4-01 (server emits `data-active-tab`), SPEC-035-2 (segmented-control CSS)
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Implement `static/js/settings-tabs.js`, the vanilla-JS module that
replaces the kit's React `useState + useEffect` synchronization on
`Settings.jsx:4`. The module reads the server-rendered `data-active-tab`
attribute on `DOMContentLoaded`, binds tab-button click handlers that
update the URL via `history.pushState`, and listens for `popstate` so
browser back/forward restore the right tab. The server is the source of
truth for the *initial* tab; this module owns *transitions* without
round-tripping the server.

## Acceptance Criteria

| ID    | Criterion |
|-------|-----------|
| AC-01 | The module is loaded as `<script type="module" src="/static/js/settings-tabs.js">` and is idempotent — calling twice does not double-bind handlers (use a `dataset.bound` sentinel on the nav). |
| AC-02 | On `DOMContentLoaded`, the module reads `nav.dataset.activeTab` from `.seg.seg-tabs`. If the attribute is absent or `null`, fall back to `'general'`. Calls `showTab(initialTab)` for defense-in-depth (server already set `hidden`; protects against stale cache per TDD-036 §6.5 step 3). |
| AC-03 | Each `.seg-btn` click handler calls `showTab(tabId)` then `history.pushState({}, '', '?tab=' + tabId)`. The handler does **not** prevent default on a `<button>` (no default to prevent) and does **not** issue a network request. |
| AC-04 | A `popstate` listener reads `new URLSearchParams(location.search).get('tab')` and calls `showTab(value || 'general')`. Browser back/forward across pushed states restore tab visibility without page reload. |
| AC-05 | `showTab(tabId)` toggles the `on` class on every `.seg-btn` (true iff `dataset.tab === tabId`) and toggles `hidden` on every `[data-tab-panel]` (true iff `dataset.tabPanel !== tabId`). |
| AC-06 | If `.seg.seg-tabs` is absent (e.g. the script loads on a non-Settings page that shares the bundle), the module no-ops without throwing. |
| AC-07 | The script does not interact with HTMX URL management; tab clicks fire `pushState` but never trigger `hx-push-url` (per PLAN-036-4 risk row 2). |

## Implementation

```javascript
(function () {
    document.addEventListener('DOMContentLoaded', () => {
        const nav = document.querySelector('.seg.seg-tabs');
        if (!nav || nav.dataset.bound === '1') return;
        nav.dataset.bound = '1';

        const initialTab = nav.dataset.activeTab || 'general';
        showTab(initialTab);

        nav.querySelectorAll('.seg-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tabId = btn.dataset.tab;
                showTab(tabId);
                history.pushState({}, '', '?tab=' + tabId);
            });
        });

        window.addEventListener('popstate', () => {
            const params = new URLSearchParams(location.search);
            showTab(params.get('tab') || 'general');
        });
    });

    function showTab(tabId) {
        document.querySelectorAll('.seg-btn').forEach(b => {
            b.classList.toggle('on', b.dataset.tab === tabId);
        });
        document.querySelectorAll('[data-tab-panel]').forEach(p => {
            p.hidden = p.dataset.tabPanel !== tabId;
        });
    }
})();
```

## Tests

- **jsdom (`tests/clientside/settings-tabs.test.ts`)**:
  - Initial render: fixture HTML with `data-active-tab="standards"`; after script execution, the `standards` panel lacks `hidden` and the other four carry it.
  - Default fallback: nav without `data-active-tab` resolves to `general`.
  - Click + pushState: simulate click on `[data-tab="variants"]`; assert `history.pushState` was called with `?tab=variants` and `variants` panel becomes visible.
  - Popstate: dispatch `popstate` after setting `location.search='?tab=agents'`; assert `agents` panel visible.
  - No-op on missing nav: load script on a fixture without `.seg.seg-tabs`; assert no throw and no console errors.
  - Idempotency: invoke `DOMContentLoaded` twice; assert click on a tab fires `pushState` exactly once per click.

## Verification

- `bun test plugins/autonomous-dev-portal/tests/clientside/settings-tabs.test.ts` passes (6 cases).
- Manual smoke: visit `/settings?tab=agents`, click each of the five tabs, observe URL update; press browser Back; observe previous tab restored. Reload `/settings?tab=standards`; observe standards panel visible.
