# SPEC-034-1-01: Vendor design-tokens.css from colors_and_type.css

## Metadata
- **Parent Plan**: PLAN-034-1-tokens-and-theme
- **Parent TDD**: TDD-034-portal-redesign-foundations
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Estimated effort**: 2 hours
- **Dependencies**: []
- **Priority**: P0

## Objective

Vendor the design system's `colors_and_type.css` verbatim into `plugins/autonomous-dev-portal/server/static/design-tokens.css`, replacing the single `@import url('https://fonts.googleapis.com/...')` line with eight self-hosted `@font-face` declarations and prepending a "DO NOT EDIT" header comment. This is the single source of truth for color, type, spacing, radius, shadow, and motion tokens for the portal redesign and is the FIRST stylesheet loaded on every page (per TDD-034 §5.1).

## Acceptance Criteria

- [ ] AC-01: File `plugins/autonomous-dev-portal/server/static/design-tokens.css` exists.
- [ ] AC-02: First non-blank line of the file is the comment `/* Design tokens vendored from autonomous-dev-design-system. Source: colors_and_type.css. DO NOT EDIT -- regenerate from the design bundle. */`.
- [ ] AC-03: The file contains zero occurrences of `@import url(`. Verify: `grep -c '@import url(' plugins/autonomous-dev-portal/server/static/design-tokens.css` returns `0`.
- [ ] AC-04: The file contains exactly 8 `@font-face` blocks (4 Inter weights 400/500/600/700, 4 JetBrains Mono weights 400/500/600/700) per TDD-034 §5.4. Verify: `grep -c '^@font-face' plugins/autonomous-dev-portal/server/static/design-tokens.css` returns `8`.
- [ ] AC-05: Every `@font-face` block uses `src: url('/static/fonts/<name>.woff2') format('woff2');` and includes `font-display: swap;`.
- [ ] AC-06: The file preserves the `:root` light-mode token block and the `:root[data-theme="dark"]` dark-mode override block from the source verbatim (only the `@import` line is removed; everything else, including base resets, `.surface`, `.dot`, `.dot.live`, and `@keyframes pulse`, is byte-identical).
- [ ] AC-07: `diff` of the vendored file vs. the upstream `colors_and_type.css` shows ONLY: (a) the prepended header comment, (b) the deleted `@import` line, (c) the inserted 8 `@font-face` blocks. No other differences.

## Implementation

### Files to create / modify
- `plugins/autonomous-dev-portal/server/static/design-tokens.css` — NEW. Vendored token file.

### Step-by-step

1. Locate the upstream source `colors_and_type.css` from the `autonomous-dev-design-system` bundle (per PRD-018 §11 references — the design bundle's `project/colors_and_type.css`). Copy the file contents into `plugins/autonomous-dev-portal/server/static/design-tokens.css`.
2. At the very top of the new file, prepend exactly: `/* Design tokens vendored from autonomous-dev-design-system. Source: colors_and_type.css. DO NOT EDIT -- regenerate from the design bundle. */` followed by a blank line.
3. Locate the line `@import url('https://fonts.googleapis.com/css2?...')` and DELETE it.
4. In its place, insert the 8 `@font-face` declarations exactly as specified in TDD-034 §5.4 (Inter 400/500/600/700, JetBrains Mono 400/500/600/700; each with `font-style: normal`, `font-display: swap`, `src: url('/static/fonts/<file>.woff2') format('woff2')`).
5. Save and verify with `diff` against the upstream source.

## Tests

- Unit: none (this spec produces a static asset, not code).
- Integration: covered by SPEC-034-1-06 (base.tsx loads this file first).

## Verification

- `test -f plugins/autonomous-dev-portal/server/static/design-tokens.css && echo OK` returns `OK`.
- `grep -c '^@font-face' plugins/autonomous-dev-portal/server/static/design-tokens.css` returns `8`.
- `grep -c '@import url(' plugins/autonomous-dev-portal/server/static/design-tokens.css` returns `0`.
- `head -1 plugins/autonomous-dev-portal/server/static/design-tokens.css` contains `DO NOT EDIT`.
- `grep -c "data-theme=\"dark\"" plugins/autonomous-dev-portal/server/static/design-tokens.css` returns at least `1` (dark-mode override block preserved).
