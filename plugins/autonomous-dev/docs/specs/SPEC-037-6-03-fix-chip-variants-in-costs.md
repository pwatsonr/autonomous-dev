# SPEC-037-6-03: Fix chip variants in Costs view; resolve `static/portal.css`

## Metadata
- **Parent Plan**: PLAN-037-6-css-class-drift-fix
- **Parent PRD**: PRD-018-portal-visual-redesign (kit parity, chip palette)
- **Tasks Covered**: PLAN-037-6 row 5 (`.chip info` → role / backend
  variants) + the `static/portal.css` housekeeping note
- **Dependencies**: none — kit defines `.chip.role-author`,
  `.chip.role-reviewer`, `.chip.role-specialist`, `.chip.role-generic`,
  `.chip.backend`, `.chip.sm` (`app.css:396, 408-412`)
- **Estimated effort**: 0.25 day
- **Status**: Draft
- **Date**: 2026-05-09

## 1. Objective

Two unrelated but tightly coupled cleanups:

1. **Reviewer / backend chips in Costs view.** `templates/views/costs.tsx`
   currently emits reviewer-role chips as `<Chip tone="info">` or
   `<Chip tone="muted">` (generic info/muted palette) and deploy-backend
   chips as `<Chip tone="info">`. The kit ships purpose-built variants:
   `.chip.role-specialist` (phase-PRD tint, bold), `.chip.role-generic`
   (muted), and `.chip.backend.sm` (compact backend marker). Switch the
   emitters in costs.tsx to these variants so the role / backend rows
   render with the intended palette.
2. **`static/portal.css`.** The audit calls this file "empty (1 line)".
   It is in fact populated — it carries kit overrides plus the
   `kill-switch` rules (`.ks-panel`, `.ks-status`, `.ks-action`) and a
   `.repo-card` rule that conflicts with the kit rule loaded from
   `app.css`. Reconcile: delete the conflicting `.repo-card` block
   (kit-canonical wins after SPEC-037-6-01) and add a 1-line header
   comment naming the file's purpose ("portal-only kill-switch + error
   page overrides; see PLAN-035-3 + PLAN-036-1").

## 2. Acceptance Criteria

Grep counts (from `plugins/autonomous-dev-portal/`) — all must be zero:

```
grep -nE 'tone="info"' server/templates/views/costs.tsx                  # 0
grep -nE 'tone="muted"' server/templates/views/costs.tsx                 # 0 for role chips
grep -nE '^\.repo-card\b' static/portal.css                              # 0
```

(The reviewer / backend tone changes; other `tone="info"` usages in
non-costs files are out of scope for this spec.)

Positive assertions:

- `costs.tsx` reviewer row emits the chip with
  `class="chip role-specialist"` when `r.role === "specialist"`,
  else `class="chip role-generic"`. Implementation may pass a new
  `tone` value into `<Chip>` (e.g. `tone="role-specialist"`) or render
  the chip class directly — match the existing primitive contract.
- `costs.tsx` deploy-backend column emits `<Chip variant="backend"
  size="sm">{d.backend}</Chip>` (or the literal `class="chip backend
  sm"` if the primitive doesn't support a `size` prop yet — extend the
  primitive in that case; one-line change).
- `static/portal.css` first non-comment line is a 1-line header
  comment describing the file's purpose; the `.repo-card` rule block
  is removed.

## 3. Implementation

### 3.1 `server/components/primitives/Chip.tsx` (or wherever Chip lives)

Audit current Chip API. If `tone` is a closed union `{ ok | warn | err |
info | muted | brand }`, extend it to also accept `role-author |
role-reviewer | role-specialist | role-generic | backend`. Emit the
matching kit class. Add a `size?: "sm"` prop that appends ` sm` to the
class list (maps to kit `.chip.sm`). No new CSS — kit `app.css:408-412`
already covers every new class.

### 3.2 `server/templates/views/costs.tsx`

Reviewer-spend table (lines ~163-176):
- Replace the inline ternary `tone={r.role === "specialist" ? "info" :
  "muted"}` with `tone={r.role === "specialist" ? "role-specialist" :
  "role-generic"}`.

Deploy-backend table (lines ~220-228):
- Replace `<Chip variant="status" tone="info">{d.backend}</Chip>` with
  `<Chip variant="backend" size="sm">{d.backend}</Chip>`.

Health column (`d.health` chips, ~237-247) — out of scope; the existing
`ok | warn | err` chip palette is the kit-canonical one for health.

### 3.3 `static/portal.css`

- Strip the leading kit-redundant block:
  - Remove the `.repo-card`, `.repo-card:hover`, and
    `.repo-status-badge.*` rules — they shadow / conflict with kit
    `app.css:370-378` after SPEC-037-6-01.
  - Keep the `kill-switch` block (`.ks-panel`, `.ks-status`,
    `.ks-action`, `.ks-confirm-label`) — these are portal-only.
  - Keep `.daemon-status-banner.*`, `.error-page`, and `.error-details`
    rules (used by `server/routes/error.tsx`).
- Prepend a single-line header comment:
  ```
  /*! autonomous-dev portal.css | portal-only overrides: kill-switch
   *  (PLAN-035-3) + error page (PLAN-036-1). Kit base rules live in
   *  app.css; do not duplicate them here. */
  ```

## 4. Tests

- `tests/unit/costs-view.test.tsx` (or the closest existing render
  test):
  - Fixture with `reviewerSpend: [{ role: "specialist", … }, { role:
    "generic", … }]` — assert HTML contains `class="chip
    role-specialist"` and `class="chip role-generic"`; assert NO
    `class="chip info"` or `class="chip muted"` inside the reviewer
    table.
  - Fixture with `deploySpend: [{ backend: "fly", … }]` — assert HTML
    contains `class="chip backend sm"`.
- `tests/unit/primitives/chip.test.tsx` — add coverage for the new
  `tone` values and `size="sm"` prop.

## 5. Verification

1. `bun test tests/unit/costs-view.test.tsx
   tests/unit/primitives/chip.test.tsx` → green.
2. From `plugins/autonomous-dev-portal/`:
   - `grep -nE 'tone="info"|tone="muted"' server/templates/views/
     costs.tsx` → 0.
   - `grep -nE '^\.repo-card\b' static/portal.css` → 0.
3. Manual: `/costs` reviewer table shows specialist chips in
   phase-PRD tint + bold (kit `.chip.role-specialist`); generic
   reviewer chips render muted (kit `.chip.role-generic`); deploy
   backends render as compact `.chip.backend.sm` markers.
