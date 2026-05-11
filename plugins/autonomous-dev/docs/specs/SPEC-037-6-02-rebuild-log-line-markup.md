# SPEC-037-6-02: Rebuild log-line markup to kit `.l-*` shape

## Metadata
- **Parent Plan**: PLAN-037-6-css-class-drift-fix
- **Parent PRD**: PRD-018-portal-visual-redesign (kit parity, log tail)
- **Tasks Covered**: PLAN-037-6 row 3 of the rename table
- **Dependencies**: none (kit CSS rules `.log .l-time / .l-info / .l-warn
  / .l-err / .l-mark` already defined at `app.css:331-336` and 669)
- **Estimated effort**: 0.25 day
- **Status**: Draft
- **Date**: 2026-05-09

## 1. Objective

`fragments/live-log.tsx` currently emits per line:

```
<span class="ts">…</span>
<span class="lvl lvl-info">INFO</span>
<span class="msg">…</span>
```

with an outer `marker` modifier on the row. The kit defines no CSS rules
for `.ts`, `.lvl`, `.lvl-info`, `.lvl-warn`, `.lvl-err`, or `.msg` — only
`.l-time`, `.l-info`, `.l-warn`, `.l-err`, and `.l-mark`. Result: log lines
render with no color tier. Rebuild the per-line markup to the kit's
flat-span shape and drop the row-level `marker` class in favor of the
inline `.l-mark` span on matching lines.

## 2. Acceptance Criteria

Grep counts (run from `plugins/autonomous-dev-portal/`) — all must be zero:

```
grep -rnE 'class="lvl( |")|class="lvl-(info|warn|err)"' server/ tests/   # 0
grep -rnE 'class="ts"|class="msg"' server/ tests/                        # 0
grep -rn '"log-line marker"' server/                                     # 0
```

Positive assertions:

- `grep -rnE 'class="l-(time|info|warn|err|mark)"' server/templates/
  fragments/live-log.tsx` returns ≥5.
- For a marker-matching entry (e.g. `phase prd dispatched`) the rendered
  HTML contains a `<span class="l-mark">` *inside* the line (not as a row
  modifier).

## 3. Implementation

### 3.1 `server/templates/fragments/live-log.tsx`

- Replace `levelClass()` to return the kit's flat span class:
  - `ERROR | ERR` → `l-err`
  - `WARN`        → `l-warn`
  - `INFO`        → `l-info`
  - default       → `l-info` (or omit; pick whichever the kit `LiveLog`
    demos use)
- Per-line markup change (the only `<div class="log-line">` branch):

  Old:
  ```
  <div class={marker ? "log-line marker" : "log-line"}>
    <span class="ts">{e.ts}</span>
    <span class={levelClass(e.level)}>{LEVEL}</span>
    <span class="msg">{e.message}</span>
  </div>
  ```

  New:
  ```
  <div class="log-line">
    <span class="l-time">{e.ts}</span>
    <span class={levelClass(e.level)}>{LEVEL}</span>
    {marker
      ? <span class="l-mark">{e.message}</span>
      : <span>{e.message}</span>}
  </div>
  ```

  The third span carries no class for non-marker lines; the message
  inherits `.log` typography from the kit container rule.
- Update the two empty / offline placeholder branches to the same shape
  (`class="l-time"` on the timestamp slot; class-less or `class="l-info"`
  on the message slot; no `class="ts"` or `class="msg"`).
- Update file-top JSDoc: replace the `.lvl-*` enumeration with `.l-time /
  .l-info / .l-warn / .l-err / .l-mark` and reference `app.css:331-336`.

### 3.2 No CSS change

`portal.css` and the kit `app.css` already carry the `.l-*` rules. Do not
add new selectors.

## 4. Tests

- `tests/unit/live-log.test.tsx` (create if absent — current coverage is
  thin):
  - Render with three entries (INFO, WARN, ERROR) — assert each line
    contains exactly one `<span class="l-(info|warn|err)">`.
  - Render with `{ message: "phase prd dispatched", level: "INFO" }` —
    assert the message span is `<span class="l-mark">` and there is no
    `class="log-line marker"` on the row.
  - Render with `entries: []` and `offline: true` — assert one
    placeholder line containing `class="l-time"` and message `Daemon
    offline`.
- Snapshot diff: one fixture line before/after shows class renames and
  removal of the row-level `marker` modifier.

## 5. Verification

1. `bun test tests/unit/live-log.test.tsx` → green.
2. From `plugins/autonomous-dev-portal/`:
   `grep -rnE 'lvl-info|lvl-warn|lvl-err|class="ts"|class="msg"|log-line
   marker' server/ tests/` → 0 matches.
3. Manual: open `/ops`; daemon log tail shows muted timestamps,
   tier-colored level tags, and bold-brand marker lines for `phase` /
   `deploy` / `agent` dispatches.
