# PLAN-034-3: Phase Contrast Verification and Light/Dark Theme Parity

## Metadata
- **Parent TDD**: TDD-034-portal-redesign-foundations
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Estimated effort**: 2 days
- **Dependencies**: ["PLAN-034-1"]
- **Blocked by**: ["PLAN-034-1"]
- **Priority**: P1
- **Stage**: TDD-034 §8 Phase 4 (CI lint gates) -- contrast + parity slice

## Objective

Ship the merge-blocking phase-contrast verification script and the token-level
theme-parity check that together enforce PRD-018 success metrics M-02 (WCAG SC
1.4.11 + adjacent-pair contrast) and M-06 (light/dark variable coverage parity).
After this plan lands, any change to `design-tokens.css` that drops a phase color
below 3:1 contrast against `--bg-0`, breaks adjacent-pair distinguishability,
or introduces variable-coverage drift between the light and dark blocks fails
CI before merge.

Both Part A (phase vs `--bg-0`) and Part B (adjacent phase pair) are CI-blocking
per TDD-034 v1.1 / OI-3403 / PRD-018 M-02 -- there is no advisory-only mode.

## Scope

### In Scope
- `plugins/autonomous-dev-portal/scripts/check-phase-contrast.ts` -- single TypeScript script per TDD-034 §5.10 with three sections:
  - **Part A**: WCAG SC 1.4.11 check of each of the 8 phase colors vs `--bg-0` in both `:root` (light) and `:root[data-theme="dark"]` blocks; threshold ≥3:1; CI-blocking.
  - **Part B**: Adjacent-pair contrast for the 7 phase pairs in pipeline order (PRD/TDD, TDD/Plan, Plan/Spec, Spec/Code, Code/Review, Review/Deploy, Deploy/Observe); threshold ≥3:1; CI-blocking.
  - **Theme parity** (TDD-034 §5.11 / M-06): list every CSS variable defined in the `:root` block and the `:root[data-theme="dark"]` block; report light-only and dark-only sets; PASS only if both sets are empty (excluding the documented theme-invariant allowlist: spacing `--s-*`, radii `--r-*`, motion, type scale).
- Color math implementation per TDD-034 §5.10: `hexToRgb`, `srgbToLinear`, `relativeLuminance`, `contrastRatio`.
- Token parser per TDD-034 §5.10: regex extraction of `--bg-0` and the 8 `--phase-*` tokens from each block; throws on missing token.
- CI workflow update -- add `check-phase-contrast` job, conditionally triggered on PRs touching `plugins/autonomous-dev-portal/server/static/design-tokens.css`. Job runs `bun scripts/check-phase-contrast.ts`; non-zero exit blocks merge.
- `plugins/autonomous-dev-portal/tests/check-phase-contrast.test.ts` -- unit tests for the color math (known WCAG examples) and the parser (golden-file fixture from the vendored token file).
- A short note in `plugins/autonomous-dev-portal/scripts/README.md` (added in PLAN-034-2) documenting how to run the script locally and how to interpret Part A / Part B / parity output.

### Out of Scope
- Visual regression screenshot diffing -- TDD-035 M-03.
- Per-PR human screenshot review for surface adoption -- TDD-036.
- Auto-fix of contrast failures (re-pick phase colors) -- design-system owner concern, not CI scope.
- Re-balancing the design system phase palette -- if Part A or Part B fails on the vendored token file, escalate to the design-system owner per OI-3403.
- Lint scripts for hex / emoji / box-shadow -- PLAN-034-2.
- Theme switcher implementation -- PLAN-034-1.

## Work Breakdown

1. **Implement color math + parser** (TDD-034 §5.10) -- author the four pure functions (`hexToRgb`, `srgbToLinear`, `relativeLuminance`, `contrastRatio`) and the `parseTokens` extractor that returns `{ light: ThemeColors, dark: ThemeColors }`. Acceptance: unit tests assert `contrastRatio('#000000', '#ffffff') === 21` (WCAG max) and `contrastRatio('#777777', '#777777') === 1`; parser throws on a fixture missing `--phase-prd`.
2. **Implement Part A (WCAG vs `--bg-0`)** (TDD-034 §5.10) -- iterate the 8 phase tokens against `--bg-0` in both themes, print one line per phase (`--phase-prd #... ratio X.XX:1 PASS|FAIL`), set `exitCode = 1` on any FAIL. Acceptance: running against the vendored `design-tokens.css` from PLAN-034-1 prints all 16 lines (8 phases × 2 themes) and exits 0 if the design-system palette holds; a fixture token file with a deliberately bad phase color (e.g., `--phase-prd: #fafaf7` ≈ `--bg-0`) exits 1.
3. **Implement Part B (adjacent pair)** (TDD-034 §5.10 / OI-3403 / PRD-018 M-02) -- iterate the 7 ordered pairs in both themes, print `prd / tdd ratio X.XX:1 PASS|FAIL`, set `exitCode = 1` on any FAIL. Acceptance: 14 lines printed (7 pairs × 2 themes); failing fixture exits 1; success message references both Part A and Part B in the failure summary per §5.10.
4. **Implement theme parity check** (TDD-034 §5.11) -- after parsing, collect all `--*` variable names from the `:root` block and the `:root[data-theme="dark"]` block; subtract the theme-invariant allowlist (spacing `--s-*`, radii `--r-*`, type scale `--text-*`, motion `--ease-*`/`--dur-*`); print "Light-only variables: (none)" / "Dark-only variables: (none)" or the offending names; set `exitCode = 1` if either set is non-empty after allowlist subtraction. Acceptance: golden run on the vendored token file passes; fixture with `--bg-0` removed from dark block fails.
5. **Wire into CI** -- add a `phase-contrast` job to the portal CI workflow, path-filtered on `plugins/autonomous-dev-portal/server/static/design-tokens.css`. Job: `bun plugins/autonomous-dev-portal/scripts/check-phase-contrast.ts`. Non-zero exit blocks merge. Acceptance: a draft PR mutating one phase color to a low-contrast value fails the job; a no-op PR does not run the job (path filter respected).
6. **Author unit tests** -- `tests/check-phase-contrast.test.ts` with: WCAG color-math goldens (black-on-white = 21:1, gray-on-gray = 1:1, mid-gray = ~4.6:1), parser happy/missing-token cases, Part A pass/fail fixtures, Part B pass/fail fixtures, parity pass / light-only / dark-only fixtures. Acceptance: `bun test plugins/autonomous-dev-portal/tests/check-phase-contrast.test.ts` is green; coverage of the four math functions and the parser is 100%.
7. **Document local invocation** -- append a section to `scripts/README.md` (created in PLAN-034-2) covering: how to run the script, how to read Part A / Part B / parity output, what to do on failure (escalate to design-system owner -- do not soften the threshold). Acceptance: a developer can diagnose a CI failure from the README + script stdout alone.

## Verification

- **Part A (M-02 WCAG)**: golden run against the vendored token file prints 16 PASS lines (8 phases × 2 themes); seeded fixture with `--phase-prd: #fafaf7` (collision with `--bg-0`) prints FAIL and exits 1.
- **Part B (M-02 adjacent pair, OI-3403)**: golden run prints 14 PASS lines; seeded fixture with two adjacent phase colors set to the same hex prints FAIL and exits 1.
- **Theme parity (M-06)**: golden run prints "Light-only variables: (none)" and "Dark-only variables: (none)" with PASS; fixture with `--brand` removed from the dark block fails and lists `--brand` under "Light-only variables".
- **CI gate**: a draft PR that mutates `design-tokens.css` to drop any phase below 3:1 fails the `phase-contrast` job; merge is blocked.
- **Failure messaging**: stderr summary on failure mentions both "Part A failures: phase color vs --bg-0 (WCAG SC 1.4.11)" and "Part B failures: adjacent phase pair contrast (PRD-018 M-02)" per §5.10.

## Test Plan

- **Unit (color math)**: `contrastRatio` against WCAG reference pairs -- black/white, gray/gray, common brand pairs -- to ±0.01.
- **Unit (parser)**: golden parse of the vendored `design-tokens.css`; missing-token throws; malformed block throws.
- **Unit (Part A / B / parity)**: paired pass/fail fixtures under `plugins/autonomous-dev-portal/tests/fixtures/contrast/`; assert exit codes and key stdout/stderr lines.
- **CI**: dry-run on a draft PR mutating one phase color to a low-contrast value confirms the job fails; no-op PR confirms the job is skipped under the path filter.
- **Manual**: run `bun scripts/check-phase-contrast.ts` locally against the PLAN-034-1 vendored file; archive the stdout in the PR description as the v1 baseline.

## Rollback

- The script and its CI wiring are separate commits; revert the CI wiring to disable enforcement without losing the script.
- No runtime artifacts produced -- this is a pure CI-gate; rollback is git-only.
- If a legitimate design-system update fails the gate, escalate per OI-3403 (the design-system owner adjusts the palette); do not soften the threshold to unblock.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Vendored token file fails Part B on first run (existing palette has an adjacent pair below 3:1) | Medium | High -- merge is blocked on PLAN-034-1's tokens until palette is fixed | Run the script against the vendored file in this plan's verification step before declaring done. If a real failure exists, escalate to design-system owner per OI-3403; do not weaken the threshold. |
| Color-math implementation error inflates ratios and lets failures pass | Low | High -- silent regression of M-02 | Unit tests against WCAG reference pairs (black/white = 21:1, identical colors = 1:1) catch arithmetic errors. Cross-check one phase pair manually with an external WCAG tool. |
| Token-parser regex misses a `--phase-*` token defined on a multi-line declaration | Low | Medium -- false `not found` throw | TDD-034 §5.10 parser uses `[^}]+` block extraction and per-token line regex; vendored token file is single-line per declaration. Parser throws explicitly on missing token rather than silently passing. |
| Theme-invariant allowlist (spacing/radii/motion) under- or over-includes a token | Medium | Low -- false parity failure or missed real drift | Allowlist documented in `_phase-contract` style comment in the script; reviewer asserts each entry against `colors_and_type.css`. Adjusting the allowlist is a one-line PR if a new theme-invariant family ships. |
| CI path filter misses a relevant change (e.g., refactor of token file path) | Low | Medium -- contrast not re-checked when it should be | Path filter is `plugins/autonomous-dev-portal/server/static/design-tokens.css` (the only place the file lives). If a future refactor moves it, the CI filter must be updated in the same PR. |
| Bun runtime drift causes the script to fail in CI but pass locally | Low | Low | Script uses pure stdlib (`fs`, `path`); no Bun-specific APIs. Pin Bun version in CI to match the portal plugin's runtime per PRD-018 §8 constraint. |
