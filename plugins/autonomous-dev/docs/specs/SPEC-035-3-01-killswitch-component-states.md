# SPEC-035-3-01: KillSwitch Primitive — Three Render States

## Metadata
- **Parent Plan**: PLAN-035-3
- **Parent TDD**: TDD-035-portal-redesign-shell-primitives (§6.5.7 v1.1)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-13, G-05)
- **Tasks Covered**: PLAN-035-3 Tasks 1, 2, 7
- **Estimated effort**: 1.0 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09
- **Safety Class**: SAFETY-CRITICAL (action of last resort; no silent failure)

## 1. Summary

Add the `KillSwitch` Hono JSX FC to
`plugins/autonomous-dev-portal/server/components/primitives.tsx` and the
matching CSS to `portal.css`. The component is a stateless presentational
primitive that renders one of three states (idle / armed / engaged) based
strictly on its props. It contains no client-side state and no fetch logic;
the server-side state machine (SPEC-035-3-02..04) is authoritative and
drives transitions via HTMX `outerHTML` swaps.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                                                                          | Task |
|-------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | The file `server/components/primitives.tsx` MUST export a named function component `KillSwitch` with signature `FC<{ engaged: boolean; onConfirm: string; armed?: boolean; armedAt?: string; csrfToken?: string }>`. | T1   |
| FR-2  | When `engaged === false && armed !== true`, the component MUST render the **idle** fragment per TDD §6.5.7 lines 893–909: `<div class="ks-panel">` containing `<span class="chip ok">DISENGAGED</span>` and the destructive HTMX button (`hx-get={onConfirm + "?step=arm"}`, `hx-target="closest .ks-panel"`, `hx-swap="outerHTML"`). | T1   |
| FR-3  | When `armed === true`, the component MUST render the **armed** fragment per TDD §6.5.7 lines 911–929: `<div class="ks-panel armed">`, a `<form method="POST" action={onConfirm}>` with hidden `_csrf` (value `csrfToken ?? ""`), hidden `armed_at` (value `armedAt ?? ""`), a `<input pattern="CONFIRM" name="confirmation" class="input mono" autocomplete="off" required>`, and a destructive submit `<button>Confirm engage</button>`. | T1   |
| FR-4  | When `engaged === true`, the component MUST render the **engaged** fragment per TDD §6.5.7 lines 931–943: `<div class="ks-panel">` with `<span class="chip err">ENGAGED</span>`, meta text "All daemon processing halted.", and a `<form method="POST" action={onConfirm + "/reset"}>` with hidden `_csrf` and a non-destructive `<button>Reset kill switch</button>`. | T1   |
| FR-5  | The component MUST NOT render `<script>` tags, inline event handlers (`onclick=`), or any client-side stateful behavior. All transitions are server-driven via HTMX swaps.                            | T1   |
| FR-6  | If `csrfToken` is `undefined` or empty in the **armed** or **engaged** state, the component MUST still render `<input type="hidden" name="_csrf" value="">` (empty value). The CSRF middleware will reject the empty value on POST — failure mode is a 403 from the server, not a missing input that fragments the form. | T1   |
| FR-7  | The component MUST NOT mutate any global state, MUST NOT log, and MUST NOT have side effects. It is a pure render function of its props.                                                              | T1   |
| FR-8  | Visual differentiation per R-13/G-05: armed state uses `border-color: var(--err-line); background: var(--err-tint)` (CSS class `.ks-panel.armed`); engaged state uses `--err` palette via `.chip.err`; idle state uses neutral `var(--line-1)` border. CSS lives in `portal.css`. | T2   |
| FR-9  | The confirm input MUST use class `input mono` (mono typography per R-13's "distinct typography" requirement) and MUST have attribute `pattern="CONFIRM"` for browser-side defense-in-depth (the server is authoritative per FR-2 of SPEC-035-3-03). | T1   |
| FR-10 | The component MUST NOT render the destructive engage button when `engaged === true` (no path to re-engage an already-engaged kill switch via the UI; reset is the only available action).             | T1   |

## 3. Non-Functional Requirements

| Requirement                              | Target                                                          | Measurement                                                       |
|------------------------------------------|------------------------------------------------------------------|-------------------------------------------------------------------|
| Render determinism                        | Identical HTML output for identical prop tuples across runs     | Unit-test snapshot comparison                                      |
| No client-side state                      | 0 `<script>`, 0 `on*=` attributes in any rendered state         | grep on rendered output in unit tests                              |
| Bundle impact                             | < 1 KB minified added to `primitives.tsx` exports                | Build-size diff in CI                                              |
| A11y — armed state                        | Confirm input is reachable by Tab; label is associated via `for/id` | Manual a11y check + jsdom test for `<label for="ks-confirm-input">` paired with `<input id="ks-confirm-input">` |

## 4. Technical Approach

**File: `plugins/autonomous-dev-portal/server/components/primitives.tsx`** — append the `KillSwitch` FC after `Card`. Use the prop-driven branch structure from TDD §6.5.7 (lines 679–745). Compute `panelClass = armed ? "ks-panel armed" : "ks-panel"` and `chipClass / chipText` per `engaged`. Render exactly one of the three button/form blocks based on `(engaged, armed)`.

**File: `plugins/autonomous-dev-portal/server/styles/portal.css`** — append:
```css
.ks-panel { border: 1px solid var(--line-1); border-radius: 3px; padding: 12px 14px; }
.ks-panel.armed { border-color: var(--err-line); background: var(--err-tint); }
.ks-panel.ks-error { border-color: var(--err-line); background: var(--err-tint); }
.ks-status { display: flex; align-items: center; gap: 12px; }
.ks-action { margin-top: 8px; }
.ks-confirm-label { font: 11px/1.4 var(--mono); color: var(--err); display: block; margin-bottom: 4px; }
```
No box-shadow (per R-15a).

## 5. Acceptance Criteria

### AC-1: Idle render (FR-2)
```
Given props {engaged: false, onConfirm: "/ops/kill-switch"}
When KillSwitch is rendered
Then output contains exactly one <div class="ks-panel"> (no "armed" modifier)
And contains <span class="chip ok">DISENGAGED</span>
And contains <button class="btn destructive" hx-get="/ops/kill-switch?step=arm"
                  hx-target="closest .ks-panel" hx-swap="outerHTML">
And output contains NO <form>, NO <input>, NO <script>
```

### AC-2: Armed render (FR-3, FR-9)
```
Given props {engaged: false, armed: true, armedAt: "2026-05-09T20:00:00.000Z", csrfToken: "tok-123", onConfirm: "/ops/kill-switch"}
When KillSwitch is rendered
Then output contains <div class="ks-panel armed">
And contains <form method="POST" action="/ops/kill-switch">
And contains <input type="hidden" name="_csrf" value="tok-123">
And contains <input type="hidden" name="armed_at" value="2026-05-09T20:00:00.000Z">
And contains <input ... name="confirmation" class="input mono" pattern="CONFIRM" autocomplete="off" required>
And contains <button class="btn destructive" type="submit">Confirm engage</button>
And contains <label class="ks-confirm-label" for="ks-confirm-input">
```

### AC-3: Engaged render (FR-4, FR-10)
```
Given props {engaged: true, csrfToken: "tok-456", onConfirm: "/ops/kill-switch"}
When KillSwitch is rendered
Then output contains <span class="chip err">ENGAGED</span>
And contains <form method="POST" action="/ops/kill-switch/reset">
And contains <input type="hidden" name="_csrf" value="tok-456">
And contains a non-destructive <button class="btn" type="submit">Reset kill switch</button>
And output contains NO "Engage kill switch" button (no path to double-engage)
```

### AC-4: Failure-path safety (FR-6)
```
Given props {armed: true, csrfToken: undefined, armedAt: undefined, onConfirm: "/ops/kill-switch"}
When KillSwitch is rendered
Then output contains <input type="hidden" name="_csrf" value="">
And contains <input type="hidden" name="armed_at" value="">
And the form is structurally complete (no missing inputs that would silently break POST validation)
And subsequent POST will be REJECTED by csrfMiddleware (403) — not silently accepted
```

### AC-5: Stateless purity (FR-5, FR-7)
```
Given any prop combination
When KillSwitch is rendered twice with identical props
Then both outputs are byte-identical
And neither output contains <script>, onclick=, onchange=, or any on*= attribute
And no console output, no network call, no module-level mutation has occurred
```

### AC-6: Visual treatment (FR-8, R-13)
```
Given the armed CSS class is applied
When the rendered DOM is inspected via computed styles
Then border-color resolves to var(--err-line)
And background resolves to var(--err-tint)
And no box-shadow is applied (R-15a)
```

## 6. Tests

**Unit — `tests/unit/components/primitives.test.tsx` (extend existing file):**

| Test ID | Scenario              | Assert                                                                                  |
|---------|-----------------------|-----------------------------------------------------------------------------------------|
| KS-U-01 | Idle render           | Contains `.chip.ok` + `DISENGAGED`; no `<form>`; HTMX attributes present                |
| KS-U-02 | Engaged render        | Contains `.chip.err` + `ENGAGED`; reset form present; no engage button                  |
| KS-U-03 | Armed render — inputs | `<input name="armed_at">` + `<input name="confirmation" pattern="CONFIRM">` present     |
| KS-U-04 | Armed render — CSRF   | `<input type="hidden" name="_csrf" value="<token>">` matches supplied token             |
| KS-U-05 | Empty CSRF            | When `csrfToken` undefined, hidden `_csrf` input present with `value=""` (not omitted)  |
| KS-U-06 | No client JS          | grep over rendered string for `<script` and `on*=` returns 0 matches in all 3 states    |

## 7. Verification

- All six unit-test rows pass under `bun test tests/unit/components/primitives.test.tsx`.
- Visual regression: Storybook / `/design-system` preview card (PLAN-035-4) renders idle and engaged states without box-shadow and with correct `--err` palette on `.armed`.
- Manual a11y: Tab order in armed state reaches the confirm input before the submit button; label is screen-reader-associated.
- `git diff` of `primitives.tsx` shows ONLY the appended `KillSwitch` export and no edits to other primitives.
