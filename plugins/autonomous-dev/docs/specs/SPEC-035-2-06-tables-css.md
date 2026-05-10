# SPEC-035-2-06: Table Styling CSS — `.tbl` Class Contract

## Metadata
- **Parent Plan**: PLAN-035-2 (Primitive Components)
- **Parent TDD**: TDD-035, §6.6 (Table Styling)
- **Parent PRD**: PRD-018, R-14, R-15a
- **Tasks Covered**: portion of PLAN-035-2 Task 8 covering `.tbl` rules.
- **Depends on**: PLAN-034-1 (`design-tokens.css` providing `--bg-2`, `--brand`, `--line-1`, `--line-2`, font tokens).
- **Estimated effort**: 0.2 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Author the `.tbl` table styling contract that surfaces opt into via `<table class="tbl">`. Tables are not a JSX primitive — they are a CSS class contract per TDD §6.6. The contract delivers horizontal hairlines only (no zebra), sticky uppercase mono headers, hover-row highlight in `--bg-2`, and a 2px left bar in `--brand` for active selection (R-14). No outer card frame, no `box-shadow` (R-15a).

## Acceptance Criteria

1. The CSS rules below are added to `server/static/portal.css` (or `server/static/primitives.css` per SPEC-035-2-07's location decision — exactly one of the two; same file system either way).
2. **`.tbl`** base table:
   - `width: 100%`
   - `border-collapse: collapse`
   - `font-size: 13px`
3. **`.tbl th`** (sticky header):
   - `position: sticky; top: 0`
   - `background: var(--bg-1)` (or `--bg-0`, whichever the shell uses for content surface — match the kit screenshot)
   - `font: 700 10px/1 var(--font-mono)`; `text-transform: uppercase`; `letter-spacing: 0.04em`
   - `text-align: left`; `padding: 10px 12px`
   - `border-bottom: 1px solid var(--line-2)`
4. **`.tbl td`** (cell):
   - `padding: 10px 12px`
   - `border-bottom: 1px solid var(--line-1)` (the horizontal hairline, R-14)
5. **`.tbl tr:hover td`**:
   - `background: var(--bg-2)`
6. **`.tbl tr.active td:first-child`**:
   - `box-shadow: inset 2px 0 0 var(--brand)` — the 2px-left-bar selection mark for the active row (R-14). This is the ONE permitted `box-shadow` in this CSS block; it uses the spec value (not a `--shadow-*` token) but is exempted under R-15a's "inset bar via box-shadow" pattern. Document the exemption with a CSS comment so the lint script (PLAN-034-1) can whitelist it.
7. **No zebra striping**, no `:nth-child(even)` rule, no outer table-wrapping `.card` frame in the CSS contract.
8. **Cell modifier classes**: `.tbl td.mono` applies `font-family: var(--font-mono)`; `.tbl td.num` applies `text-align: right; font-variant-numeric: tabular-nums`; `.tbl td.title` applies `font-weight: 600`. (Listed in TDD §15 inventory.)
9. The CSS file imports nothing new — all values come from `design-tokens.css` already imported at the page root (R-01).

## Implementation

```css
/* === Tables (R-14) ============================================== */
/* Horizontal hairlines only. No zebra. No outer card frame.       */

.tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
}

.tbl th {
    position: sticky;
    top: 0;
    background: var(--bg-1);
    text-align: left;
    padding: 10px 12px;
    font: 700 10px/1 var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--fg-2);
    border-bottom: 1px solid var(--line-2);
}

.tbl td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--line-1);
}

.tbl tr:hover td {
    background: var(--bg-2);
}

/* Active-row marker (R-14): 2px brand bar via inset box-shadow.
 * R-15a exemption: inset-bar pattern; CI lint whitelist. */
.tbl tr.active td:first-child {
    box-shadow: inset 2px 0 0 var(--brand);
}

/* Cell modifiers (TDD §15 inventory). */
.tbl td.mono { font-family: var(--font-mono); }
.tbl td.num  { text-align: right; font-variant-numeric: tabular-nums; }
.tbl td.title { font-weight: 600; }
```

## Tests

| Test | Assertion |
|------|-----------|
| `.tbl` width 100% | computed style on `<table class="tbl">` is full container width |
| Sticky header | scroll the table, `<th>` remains visible at `top: 0` |
| No zebra | `tr:nth-child(even) td` background equals normal-row background |
| Hover row | hovering `<tr>` makes `<td>` background equal `var(--bg-2)` |
| Active row bar | `<tr class="active">` first cell has `box-shadow: inset 2px 0 0 var(--brand)` |
| Header is mono uppercase | computed `font-family` includes mono token; `text-transform` is `uppercase` |
| Hairline only | `<td>` has `border-bottom: 1px solid var(--line-1)`; no `border-top` / `border-left` / `border-right` declared |

CSS regression: visual goldens for tables on `/design-system` (PLAN-035-4 / M-03) catch any drift in the rendered table chrome.

## Verification

- The `.tbl` rules above appear verbatim (modulo whitespace) in the target CSS file.
- `grep -nE "(:nth-child|zebra)" <css-file>` returns zero matches inside the `.tbl` block.
- `grep -nE "box-shadow:" <css-file>` returns exactly one occurrence inside the `.tbl` block (the active-row inset bar) and that line carries the R-15a exemption comment.
- An existing portal table re-skinned with `class="tbl"` matches the kit screenshots (`Dashboard.jsx`, `Costs.jsx`) — verified in TDD-018-C, not this spec.
- TDD §6.6 acceptance: the five-row CSS contract (`.tbl`, `.tbl th`, `.tbl td`, hover, active) is delivered in full; no extra rules introduced beyond cell modifiers.
