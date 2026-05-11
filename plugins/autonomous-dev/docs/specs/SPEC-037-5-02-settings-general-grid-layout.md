# SPEC-037-5-02: Settings General Grid Layout

## Metadata
- **Parent Plan**: PLAN-037-5-settings-tab-layouts
- **Parent TDD**: TDD-037-portal-kit-parity
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Tasks Covered**: PLAN-037-5 Task 1 (General tab rebuild)
- **Estimated effort**: 0.5 day
- **Dependencies**: SPEC-036-4-03 (trust tab), SPEC-036-4-04 (cost cap card), SPEC-036-4-06 (notifications card)
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Replace the current flat General tab with a 2-column `.settings-grid`
of `.sec` cards (Trust / Cost caps / Default variant / Default backend
/ Notifications / Repo allowlist) matching `Settings.jsx:35-75`. The
cost-cap card uses `.input-row` with `$` prefix and `/ day` suffix.

## Acceptance Criteria

| ID    | Criterion |
|-------|-----------|
| AC-01 | The General panel root is `<div class="settings-grid">` (two-column grid via existing `app.css:544`). |
| AC-02 | Each child card is `<section class="sec">` with a `<div class="sec-head"><h2>…</h2></div>` header, optional `<p class="dim">…</p>` helper, and the field below — no extra wrapper `.card` class. |
| AC-03 | Cards rendered in this order: `Trust level` (reuses `TrustCard`), `Daily cost cap`, `Default pipeline variant`, `Default deploy backend`, `Notifications`, `Repo allowlist`. The last two span both columns via `<section class="sec span-2">` (a new CSS rule is **not** required — they are siblings rendered last; if visual span is needed, add `grid-column: 1 / -1;` in `app.css` under `.settings-grid .sec.span-2`). |
| AC-04 | Daily cost cap field uses `.input-row`: `<span class="input-prefix">$</span><input class="input" name="dailyCap" value={data.dailyCap}/><span class="input-suffix">/ day</span>`. |
| AC-05 | Default pipeline variant is a `<select class="input" name="defaultVariant">` of `data.variants`; selected option matches `data.defaultVariant`; a `<div class="dim small mt8">{desc}</div>` shows the active variant's description (server-rendered against `data.defaultVariant`). |
| AC-06 | Default deploy backend is `<select class="input" name="defaultBackend">` of `data.backends.filter(b => b.status === 'available')`. |
| AC-07 | The Trust card slot reuses the existing `TrustCard` and `TrustOverridesCard` (SPEC-036-4-03) but emits them as `<section class="sec">` not `<section class="card">`. |
| AC-08 | All fields carry stable `name` attributes so the Save POST (SPEC-037-5-01) round-trips them. |

## Implementation

- Refactor `views/settings.tsx` `GeneralPanel` to emit the
  `.settings-grid` wrapper. Inline the four small cards (cost cap,
  default variant, default backend, plus a thin re-skin of
  Notifications) directly in the view; keep `TrustCard`,
  `TrustOverridesCard`, `NotificationsCard`, and `AllowlistTable` as
  separate fragments but ensure their root element uses
  `class="sec"` (rename existing `class="card"` usages).
- Add the `.settings-grid .sec.span-2 { grid-column: 1 / -1; }` rule
  to `app.css` if Notifications / Allowlist should run full width.
- Concrete JSX for the cost-cap card:

  ```tsx
  <section class="sec">
    <div class="sec-head"><h2>Daily cost cap</h2></div>
    <p class="dim">Hard cap. Pipelines pause when reached.</p>
    <div class="input-row">
      <span class="input-prefix">$</span>
      <input class="input" name="dailyCap" value={data.dailyCap}/>
      <span class="input-suffix">/ day</span>
    </div>
  </section>
  ```

- All inputs are descendants of the `data-dirty-tracking` container
  added by SPEC-037-5-01, so Save/Discard wiring is automatic.

## Tests

- **Snapshot (`tests/snapshot/settings-general-grid.test.ts`)**: assert
  the wrapper class, that six `<section class="sec">` children exist
  in the documented order, and that the cost-cap card contains
  `.input-prefix` `$` and `.input-suffix` `/ day`.
- **Snapshot (`tests/snapshot/trust-card-sec.test.ts`)**: re-render
  the existing `TrustCard` snapshot to confirm the class flip from
  `card` to `sec`.

## Verification

- `bun test tests/snapshot/settings-general-*.test.ts tests/snapshot/trust-card-sec.test.ts` passes.
- Manual smoke: load `/settings`, observe two-column grid; the cost
  cap input is flanked by `$` and `/ day`; default variant select
  shows the description string beneath.
