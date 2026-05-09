# SPEC-034-1-04: Migrate portal CSS to design-token references; delete variables.css

## Metadata
- **Parent Plan**: PLAN-034-1-tokens-and-theme
- **Parent TDD**: TDD-034-portal-redesign-foundations
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Estimated effort**: 4 hours
- **Dependencies**: [SPEC-034-1-01]
- **Priority**: P0

## Objective

Refactor `plugins/autonomous-dev-portal/src/styles/{layout,components,utilities}.css` to reference token names from `design-tokens.css` exclusively (per the TDD-034 §5.2 mapping table). Delete the now-redundant `src/styles/variables.css` (whose tokens are superseded by `design-tokens.css`). Remove the `@media (prefers-color-scheme: dark)` block (dark mode is now driven by `[data-theme="dark"]`). Update `scripts/build-css.sh` to drop `variables.css` from the concatenation. After this spec, `static/portal.css` contains zero hex literals, zero hardcoded `font-family` declarations, and references only token CSS variables.

## Acceptance Criteria

- [ ] AC-01: File `plugins/autonomous-dev-portal/src/styles/variables.css` does not exist (deleted).
- [ ] AC-02: `grep -RnE '#[0-9][0-9a-fA-F]{2,7}\b' plugins/autonomous-dev-portal/src/styles plugins/autonomous-dev-portal/server/static/portal.css | grep -v 'design-tokens.css'` returns zero matches.
- [ ] AC-03: `grep -Rn 'font-family' plugins/autonomous-dev-portal/src/styles | grep -v 'var(--font-'` returns zero matches.
- [ ] AC-04: `grep -Rn 'prefers-color-scheme' plugins/autonomous-dev-portal/src/styles` returns zero matches.
- [ ] AC-05: Every old token name from the TDD-034 §5.2 mapping table has been migrated. Verify: `grep -RnE '\-\-(primary-color|primary-hover|success-color|success-light|warning-color|warning-light|danger-color|danger-light|info-color|info-light|bg-primary|bg-secondary|bg-tertiary|text-primary|text-secondary|text-muted|border-color|border-hover|radius-sm|radius-md|radius-lg|shadow-sm|shadow-md|shadow-lg|space-xs|space-sm|space-md|space-lg|space-xl)\b' plugins/autonomous-dev-portal/src/styles` returns zero matches.
- [ ] AC-06: `plugins/autonomous-dev-portal/scripts/build-css.sh` does NOT list `variables.css` as a concatenation input. Verify: `grep -c 'variables\.css' plugins/autonomous-dev-portal/scripts/build-css.sh` returns `0`.
- [ ] AC-07: `bun run build:css` (or invoking `scripts/build-css.sh` directly) exits `0` and produces a valid `plugins/autonomous-dev-portal/server/static/portal.css`.
- [ ] AC-08: The rebuilt `portal.css` references only CSS variables defined in `design-tokens.css`. Verify by spot-check that `var(--brand)`, `var(--bg-1)`, `var(--fg-0)`, `var(--line-1)`, `var(--r-2)`, `var(--s-4)` appear and old names do not.
- [ ] AC-09: All existing portal route smoke tests still pass (`npx jest plugins/autonomous-dev-portal/tests/`).

## Implementation

### Files to create / modify
- `plugins/autonomous-dev-portal/src/styles/variables.css` — DELETE.
- `plugins/autonomous-dev-portal/src/styles/layout.css` — MODIFY (rename token references).
- `plugins/autonomous-dev-portal/src/styles/components.css` — MODIFY (rename token references).
- `plugins/autonomous-dev-portal/src/styles/utilities.css` — MODIFY (rename token references).
- `plugins/autonomous-dev-portal/scripts/build-css.sh` — MODIFY (remove `variables.css` from concat list).
- `plugins/autonomous-dev-portal/server/static/portal.css` — REGENERATED via build script.

### Step-by-step

1. Apply the TDD-034 §5.2 mapping table to each of `layout.css`, `components.css`, `utilities.css`. For each old → new pair (e.g., `--primary-color` → `--brand`, `--bg-primary` → `--bg-1`, `--radius-md` → `--r-2`, `--space-md` → `--s-4`, etc.), do a global replace within the file. The full mapping is in TDD-034 §5.2 — replicate it verbatim.
2. After token-name renaming, scan each file for hardcoded hex literals (`grep -nE '#[0-9][0-9a-fA-F]{2,7}\b'`). Replace each hit with the appropriate token variable. If no exact match exists, escalate to the reviewer rather than guessing.
3. Replace any hardcoded `font-family:` declaration with `var(--font-sans)` (UI/prose) or `var(--font-mono)` (IDs/timestamps/status).
4. Delete the entire `@media (prefers-color-scheme: dark)` block from any file that still contains one (these are now superseded by `:root[data-theme="dark"]` in `design-tokens.css`).
5. `git rm plugins/autonomous-dev-portal/src/styles/variables.css`.
6. Open `plugins/autonomous-dev-portal/scripts/build-css.sh`. Locate the line(s) that concatenate `variables.css` and remove them. The build order must be `layout.css` → `components.css` → `utilities.css` (no `variables.css`).
7. Run `bun run build:css` (or the equivalent invocation used by the project) to regenerate `server/static/portal.css`. Verify the file is non-empty and contains the new token references.
8. Run the portal test suite: `npx jest plugins/autonomous-dev-portal/tests/`. All previously-passing tests must still pass; no behavior changes.

## Tests

- Unit: covered by existing portal tests (no new tests required for a pure CSS rename).
- Integration: existing route-rendering tests must still pass. Manual smoke of all 6 portal surfaces (Dashboard, Approvals, Request Detail, Settings, Costs, Ops) before merge.

## Verification

- `test ! -f plugins/autonomous-dev-portal/src/styles/variables.css && echo OK` returns `OK`.
- `grep -RnE '#[0-9][0-9a-fA-F]{2,7}\b' plugins/autonomous-dev-portal/src/styles` returns zero matches.
- `grep -c 'variables\.css' plugins/autonomous-dev-portal/scripts/build-css.sh` returns `0`.
- `bash plugins/autonomous-dev-portal/scripts/build-css.sh && test -s plugins/autonomous-dev-portal/server/static/portal.css && echo OK` returns `OK`.
- `npx jest plugins/autonomous-dev-portal/tests/` exits `0`.
