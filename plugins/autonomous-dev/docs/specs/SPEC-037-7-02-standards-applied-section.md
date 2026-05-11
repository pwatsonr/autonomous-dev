# SPEC-037-7-02: Standards-applied section (`.std-list`)

## Metadata
- **Parent Plan**: PLAN-037-7
- **Parent PRD**: PRD-018-portal-visual-redesign (PRD-013 standards)
- **Tasks Covered**: PLAN-037-7 §Scope item 4
- **Dependencies**: kit `RequestDetail.jsx:149-167`
- **Estimated effort**: 0.5 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Render the Standards-applied section on Request Detail when the request
carries standards hits, matching the kit's `.std-list` of
`.std-row.sev-{blocking|warn|advisory}` cards. The section is hidden
when `request.flags.hasStandards` is falsy.

## Acceptance Criteria

1. A new fragment `server/templates/fragments/standards-applied.tsx`
   emits:
   - `<section class="sec">` wrapper.
   - `.sec-head` with `<h2>Standards applied</h2>` and a
     `<span class="meta-mono dim">{count} rules</span>` summary on the right.
   - `<div class="std-list">` containing one `.std-row.sev-{severity}`
     per rule.
   - Each row has 4 cells in this order:
     - `<div class="std-id meta-mono">{rule.id}</div>`
     - `<div class="std-desc">{rule.desc}</div>`
     - `<div class="std-sev {severity}">{severity}</div>`
     - `<div class="std-source">{rule.source}{rule.immutable ? ' · 🔒' : ''}</div>`
2. Severity values are constrained to `"blocking" | "warn" | "advisory"`.
   Unknown severities default to `"advisory"`.
3. `StandardsRule` type added to `server/types/render.ts`:
   `{ id: string; desc: string; severity: "blocking" | "warn" | "advisory"; source: string; immutable?: boolean }`.
4. `RequestRecord.standardsApplied?: StandardsRule[]` is added;
   `request.flags.hasStandards` already exists. The section renders
   iff `request.flags.hasStandards === true` AND
   `standardsApplied.length > 0`.
5. `request-detail.tsx` view mounts `<StandardsApplied>` after
   `<GateDetail>` and before `<RequestTimeline>`.
6. CSS for `.std-list`, `.std-row`, `.std-sev`, severity tints
   (`sev-blocking` red-tint, `sev-warn` amber-tint, `sev-advisory`
   neutral) is added to `static/shell.css` (or the design-tokens layer
   if those tokens live there) under a `/* SPEC-037-7-02 */` block.

## Implementation

**Files**
- `server/types/render.ts` — `StandardsRule`, `standardsApplied`.
- `server/templates/fragments/standards-applied.tsx` — new fragment.
- `server/templates/views/request-detail.tsx` — mount the fragment.
- `server/static/shell.css` — `.std-list` / `.std-row` styles using
  existing severity tint tokens.
- `server/stubs/requests.ts` — example `standardsApplied` array on a
  fixture request that has `flags.hasStandards = true`.

## Tests

- `tests/fragments/standards-applied.test.ts`: snapshot per severity;
  rendered iff `hasStandards` true and list non-empty; lock glyph
  appears when `immutable`; row count matches `meta-mono` summary.
- `tests/views/request-detail.test.ts`: section absent when
  `hasStandards` is false; present when true with rows.

## Verification

- `bun test tests/fragments/standards-applied.test.ts` passes.
- Visual match against kit `RequestDetail.jsx:149-167`.
