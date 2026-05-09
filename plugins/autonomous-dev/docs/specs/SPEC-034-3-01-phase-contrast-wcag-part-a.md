# SPEC-034-3-01: Phase-Contrast Verification — Part A (WCAG SC 1.4.11 vs `--bg-0`)

## Metadata
- **Parent Plan**: PLAN-034-3 (Phase Contrast Verification + Light/Dark Theme Parity)
- **Parent TDD**: TDD-034 (Portal Redesign Foundations) §5.10
- **Parent PRD**: PRD-018 (Portal Visual Redesign) M-02 (binding part A: WCAG)
- **Tasks Covered**: PLAN-034-3 Tasks 1, 2 (color math + parser + Part A WCAG check)
- **Estimated effort**: 4-6 hours
- **Future home**: `plugins/autonomous-dev-portal/scripts/check-phase-contrast.ts` (new), `plugins/autonomous-dev-portal/tests/check-phase-contrast.test.ts` (new), `plugins/autonomous-dev-portal/tests/fixtures/contrast/` (new)
- **Depends on**: PLAN-034-1 (vendored `server/static/design-tokens.css` must exist with `:root` and `:root[data-theme="dark"]` blocks containing `--bg-0` and the 8 `--phase-*` tokens)

## Description

Author the first section of `scripts/check-phase-contrast.ts`: the WCAG SC 1.4.11 non-text contrast check. For each of the 8 phase tokens (`--phase-prd`, `--phase-tdd`, `--phase-plan`, `--phase-spec`, `--phase-code`, `--phase-review`, `--phase-deploy`, `--phase-observe`) the contrast ratio against `--bg-0` MUST be ≥ 3.0:1 in BOTH the light theme (`:root` block) and the dark theme (`:root[data-theme="dark"]` block). 16 PASS/FAIL lines total (8 phases × 2 themes). Per PRD-018 v1.1 M-02 and TDD-034 OI-3403, this check is CI-blocking — there is no advisory mode.

This spec also lands the shared building blocks the rest of the plan reuses: the four pure color-math functions (`hexToRgb`, `srgbToLinear`, `relativeLuminance`, `contrastRatio`) and the token-block parser. SPEC-034-3-02 (Part B) and SPEC-034-3-03 (parity) extend the same script.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-portal/scripts/check-phase-contrast.ts` | Create | Bun-runnable TypeScript; pure stdlib (`fs`, `path`); shebang `#!/usr/bin/env bun`; sets `process.exitCode = 1` on any FAIL, then `process.exit(exitCode)` once at the bottom. |
| `plugins/autonomous-dev-portal/tests/check-phase-contrast.test.ts` | Create | Jest-style unit tests for color math + parser + Part A pass/fail fixtures. |
| `plugins/autonomous-dev-portal/tests/fixtures/contrast/tokens-good.css` | Create | Golden fixture mirroring the vendored token file (Part A passes). |
| `plugins/autonomous-dev-portal/tests/fixtures/contrast/tokens-bad-phase-a.css` | Create | Fixture with `--phase-prd: #fafaf7` (collides with `--bg-0` in light). |

One commit. Body references `Refs PRD-018 M-02 part A; TDD-034 §5.10; PLAN-034-3 Tasks 1, 2`.

## Implementation Details

### Step 1: Color math (pure functions)

Implement `hexToRgb(hex: string): [number, number, number]` returning normalized 0..1 channels. Implement `srgbToLinear(c: number): number` per WCAG (`c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)^2.4`). Implement `relativeLuminance([r,g,b])` as `0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b)`. Implement `contrastRatio(hex1, hex2)` as `(L_lighter + 0.05) / (L_darker + 0.05)`.

Goldens that MUST hold to ±0.01: `contrastRatio('#000000', '#ffffff') === 21`, `contrastRatio('#777777', '#777777') === 1`. A reviewer cross-checks one phase vs `--bg-0` ratio against an external WCAG calculator before merge.

### Step 2: Token parser

`parseTokens(css: string): { light: ThemeColors; dark: ThemeColors }`. Use the `[^}]+` regex extraction from TDD-034 §5.10 — match `:root\s*\{([^}]+)\}` and `:root\[data-theme="dark"\]\s*\{([^}]+)\}`. Inside each block, extract `--bg-0` and each `--phase-*` token via `--<name>:\s*(#[0-9a-fA-F]{6})`. Throw with a clear message if any expected token is missing (`--phase-prd not found in dark block`). Throw if either block itself is missing.

### Step 3: Part A loop

```
=== Part A: WCAG SC 1.4.11 — Phase colors vs --bg-0 ===
  Theme: light (--bg-0: #fafaf7)
    --phase-prd     #2f7a3e  ratio 4.81:1  PASS
    ... (8 lines)
  Theme: dark (--bg-0: #14130f)
    ... (8 lines)
```

For each `(theme, phase)` pair, compute the ratio, render the line with `phase.padEnd(7)` and `ratio.toFixed(2)`, and set `exitCode = 1` on any ratio < 3.0. Do NOT exit early — print all 16 lines so the reviewer sees the full picture on one failure.

### Step 4: Failure summary

If `exitCode !== 0` at the bottom of the script, print to stderr:
```
FAIL: One or more contrast checks did not meet the >=3:1 threshold.
  Part A failures: phase color vs --bg-0 (WCAG SC 1.4.11)
```
The Part B summary line (added by SPEC-034-3-02) is appended in that spec, not here. SPEC-034-3-03 adds the parity summary line. Land Part A's stderr line as written above; the next spec edits this block.

### Step 5: Tests

`tests/check-phase-contrast.test.ts` covers: WCAG goldens (black/white = 21, gray/gray = 1, mid-gray pair to ±0.01), parser happy path against `tokens-good.css`, parser throws on missing `--phase-prd` (delete the line in a temp fixture), Part A passes on `tokens-good.css` (exit 0), Part A fails on `tokens-bad-phase-a.css` (exit 1, includes `--phase-prd ... FAIL` in stdout).

### What NOT to do

- Do NOT use a CSS-parser library. The TDD §5.10 regex extraction is pinned; pulling in `postcss` introduces a dependency and a Bun-vs-Node compatibility risk for no benefit on a 314-line known-shape file.
- Do NOT widen the threshold below 3.0 to make a real failure pass. If the vendored palette fails on first run, escalate per OI-3403 — the design-system owner adjusts colors, not the spec.
- Do NOT short-circuit on the first FAIL. Print all 16 lines so the reviewer sees both themes.
- Do NOT include Part B logic, parity logic, or CI workflow wiring in this spec — those land in SPEC-034-3-02, SPEC-034-3-03, and a follow-up CI spec respectively.

## Acceptance Criteria

- [ ] `scripts/check-phase-contrast.ts` exists, has `#!/usr/bin/env bun`, and exports nothing (run-as-script).
- [ ] The four color-math functions match the WCAG goldens above to ±0.01.
- [ ] `parseTokens` returns `{ light, dark }` with `bg0` (`#xxxxxx`) and `phases` (8 entries) per theme; throws on missing `--bg-0` or any missing `--phase-*` in either block.
- [ ] Running `bun scripts/check-phase-contrast.ts` against the vendored token file prints the Part A header and 16 lines, all PASS, exit 0.
- [ ] Running against `tokens-bad-phase-a.css` prints a FAIL line for `--phase-prd` in light theme and exits 1.
- [ ] On failure, stderr includes `Part A failures: phase color vs --bg-0 (WCAG SC 1.4.11)`.
- [ ] `bun test plugins/autonomous-dev-portal/tests/check-phase-contrast.test.ts` is green; color-math + parser coverage is 100%.
- [ ] Exactly one commit lands. Body references `PRD-018 M-02 part A; TDD-034 §5.10; PLAN-034-3 Tasks 1, 2`.

## Verification

Manual: run the script against the PLAN-034-1 vendored `design-tokens.css`, archive stdout in the PR description as the v1 baseline. Cross-check one phase ratio against an external WCAG tool (e.g., webaim.org/resources/contrastchecker) and confirm agreement to ±0.01.
