# SPEC-037-4-02: Approvals segmented filter (`.seg` + `segmented-filter.js`)

## Metadata
- **Parent Plan**: PLAN-037-4 (Approvals surface rebuild)
- **Parent TDD**: TDD-037 (Portal kit parity)
- **Tasks Covered**: PLAN-037-4 Scope item (3) segmented filter, item (7) `segmented-filter.js` module
- **Estimated effort**: 0.5 day
- **Dependencies**: SPEC-037-4-01 (page-head precedes the filter); SPEC-037-4-03 (gate rows carry `data-filter` attribute)
- **Priority**: P1
- **Status**: Draft
- **Date**: 2026-05-09

## Objective

Render a kit-matching segmented filter (`<div class="seg">` with four `.seg-btn` children) between the KPI strip and the gate-list section head, and ship a small vanilla JS module `segmented-filter.js` that toggles `.hidden` on rows based on the active button's `data-filter` value. No HTMX round-trip — filtering is purely client-side (per PLAN-037-4 Scope item 3).

## Acceptance Criteria

1. **Markup** placed inside the gate-list section head (per kit `Approvals.jsx:39-48`):
   ```html
   <div class="sec-head">
     <h2>Open gates · {totalGates}</h2>
     <div class="seg" data-segmented-filter="approvals">
       <button class="seg-btn on" data-filter="all">All</button>
       <button class="seg-btn"    data-filter="reviewer-chain">Reviewer</button>
       <button class="seg-btn"    data-filter="standards-violation">Standards</button>
       <button class="seg-btn"    data-filter="cost-cap">Cost</button>
     </div>
   </div>
   ```
2. Initial state: `data-filter="all"` button has class `on`; all rows visible.
3. **JS module** `segmented-filter.js`:
   - Self-attaches on `DOMContentLoaded` and on `htmx:afterSwap` (so it survives OOB swaps).
   - For each `[data-segmented-filter]` group, binds `click` on each `.seg-btn`.
   - On click: removes `on` from all siblings; adds `on` to the clicked button; reads `data-filter`; toggles `.hidden` on every `[data-gate-type]` row in the nearest ancestor `<section>`: row is shown when `data-filter==="all"` OR `row.dataset.gateType===data-filter`.
   - When the visible-row count is 0, ensures a sibling `<div class="empty">No {label} gates</div>` is rendered (label derived from active button's text). Re-uses an existing `.empty[data-empty-for]` element if present; otherwise creates one. Removes the empty element when count > 0.
4. **Loading**: `<script src="/static/segmented-filter.js" defer></script>` injected by the portal shell layout (or imported alongside `gate-actions.js`).
5. **Zero dependencies** — pure DOM API, no HTMX, no framework.
6. Works with keyboard: `Enter`/`Space` activate the focused `.seg-btn` (native `<button>` behavior suffices); `aria-pressed` updated on each click for SR users.

## Implementation

**File 1**: `plugins/autonomous-dev-portal/server/templates/views/approvals.tsx` — insert markup from AC-1 above the gate-list (mounted inside `<section class="sec">` per SPEC-037-4-03).

**File 2**: `plugins/autonomous-dev-portal/server/static/segmented-filter.js` (new, ~60 LOC):

```js
(function () {
  function applyFilter(group) {
    const active = group.querySelector('.seg-btn.on');
    const filter = active ? active.dataset.filter : 'all';
    const section = group.closest('section') || document;
    const rows = section.querySelectorAll('[data-gate-type]');
    let visible = 0;
    rows.forEach((r) => {
      const show = filter === 'all' || r.dataset.gateType === filter;
      r.classList.toggle('hidden', !show);
      if (show) visible++;
    });
    updateEmpty(section, group, visible, active);
  }
  function updateEmpty(section, group, visible, active) {
    let empty = section.querySelector('.empty[data-empty-for]');
    if (visible === 0) {
      const label = active ? active.textContent.trim() : '';
      if (!empty) {
        empty = document.createElement('div');
        empty.className = 'empty';
        empty.setAttribute('data-empty-for', 'gate-list');
        group.parentElement.parentElement.appendChild(empty);
      }
      empty.textContent = `No ${label.toLowerCase()} gates`;
    } else if (empty) {
      empty.remove();
    }
  }
  function bind(group) {
    group.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.seg-btn').forEach((b) => {
          b.classList.remove('on');
          b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('on');
        btn.setAttribute('aria-pressed', 'true');
        applyFilter(group);
      });
    });
  }
  function init() {
    document.querySelectorAll('[data-segmented-filter]').forEach(bind);
  }
  document.addEventListener('DOMContentLoaded', init);
  document.body && document.body.addEventListener('htmx:afterSwap', init);
})();
```

**File 3**: shell layout — add `<script src="/static/segmented-filter.js" defer></script>` (e.g. `server/templates/layout.tsx` next to existing `gate-actions.js`).

## Tests

| Test | Assertion |
|------|-----------|
| Renders 4 buttons | `.seg .seg-btn` count is 4; first has class `on` |
| Click Reviewer hides others | After dispatching click on `[data-filter="reviewer-chain"]`, rows without `data-gate-type="reviewer-chain"` carry `.hidden` |
| Click All restores | All rows lose `.hidden` |
| Empty state injected | Filter with zero matches → `.empty[data-empty-for="gate-list"]` element appears with the matching label |
| aria-pressed toggles | Only one button has `aria-pressed="true"` at a time |
| Re-init on htmx swap | After dispatching `htmx:afterSwap`, clicking still works |

## Verification

- `bun test plugins/autonomous-dev-portal/tests/unit/segmented-filter.test.ts` passes (jsdom).
- Manual: load `/approvals`, click `Standards`; only standards rows visible.
- `curl -s http://127.0.0.1:19280/approvals | grep -c 'class="seg-btn'` returns `4`.
- `grep -nE '#[0-9a-fA-F]{3,6}' plugins/autonomous-dev-portal/server/static/segmented-filter.js` returns no matches.
