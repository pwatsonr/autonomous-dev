# SPEC-034-3-03: Light/Dark Theme Parity — CSS Variable Coverage Check

## Metadata
- **Parent Plan**: PLAN-034-3 (Phase Contrast Verification + Light/Dark Theme Parity)
- **Parent TDD**: TDD-034 (Portal Redesign Foundations) §5.11
- **Parent PRD**: PRD-018 (Portal Visual Redesign) M-06 (light + dark theme parity)
- **Tasks Covered**: PLAN-034-3 Task 4 (theme parity check)
- **Estimated effort**: 3-4 hours
- **Future home**: `plugins/autonomous-dev-portal/scripts/check-phase-contrast.ts` (modify), `plugins/autonomous-dev-portal/tests/check-phase-contrast.test.ts` (modify), `plugins/autonomous-dev-portal/tests/fixtures/contrast/tokens-bad-parity.css` (new)
- **Depends on**: SPEC-034-3-01 (parser, fixtures dir), SPEC-034-3-02 (Part B failure-summary block — this spec appends a parity line)

## Description

Add the M-06 theme-parity check to `scripts/check-phase-contrast.ts`. After Part A and Part B run, the script enumerates every CSS variable name (`--*`) declared inside the `:root` (light) block and inside the `:root[data-theme="dark"]` block, subtracts a documented allowlist of theme-invariant token families, and FAILS the run if either set has anything left over. This enforces PRD-018 M-06: every theme-sensitive token defined in light has a counterpart in dark, and vice versa. The output reads `Light-only variables: (none)` / `Dark-only variables: (none)` on success.

The allowlist captures token families that are intentionally theme-invariant: spacing (`--s-*`), radii (`--r-*`), motion (`--ease-*`, `--dur-*`), and the type scale (`--text-*`). These are defined once in `:root` and not re-declared per theme. Every other token (colors, semantic tones, phase colors, line/border, shadow) MUST appear in both blocks. The allowlist is documented inline in the script as a `_phase-contract`-style comment block, reviewable on every PR.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-portal/scripts/check-phase-contrast.ts` | Modify | Append a third section (`=== Theme parity: Variable coverage ===`) after Part B; extend the failure-summary stderr block. |
| `plugins/autonomous-dev-portal/tests/check-phase-contrast.test.ts` | Modify | Add parity pass/fail cases. |
| `plugins/autonomous-dev-portal/tests/fixtures/contrast/tokens-bad-parity.css` | Create | Fixture with `--brand` removed from the `:root[data-theme="dark"]` block. |

One commit. Body references `Refs PRD-018 M-06; TDD-034 §5.11; PLAN-034-3 Task 4`.

## Implementation Details

### Step 1: Define the allowlist

Inline near the top of the script, alongside `PHASES`:

```ts
// Theme-invariant token families (defined once in :root, not per theme).
// Reviewer asserts each prefix against design-tokens.css on every PR.
const THEME_INVARIANT_PREFIXES = ['--s-', '--r-', '--text-', '--ease-', '--dur-'] as const;

function isThemeInvariant(name: string): boolean {
    return THEME_INVARIANT_PREFIXES.some((p) => name.startsWith(p));
}
```

Place a comment block above the constant explaining: "These prefixes are theme-invariant by design. Adding a new theme-invariant family is a one-line edit; converting a theme-sensitive family to invariant requires a TDD update."

### Step 2: Variable extraction

Add a helper that returns `Set<string>` of all `--*` names in a block:

```ts
function extractVarNames(block: string): Set<string> {
    const names = new Set<string>();
    const re = /(--[a-z0-9-]+)\s*:/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) names.add(m[1]);
    return names;
}
```

Reuse the `:root` and `:root[data-theme="dark"]` block matches already extracted by `parseTokens` — refactor `parseTokens` to also return the raw block strings, OR add a sibling function `parseBlocks(css)` that returns `{ lightBlock, darkBlock }` and call both. Either is acceptable; pick the smaller diff.

### Step 3: Parity diff

After Part B completes, compute:

```ts
const lightOnly = [...lightVars].filter((n) => !darkVars.has(n) && !isThemeInvariant(n)).sort();
const darkOnly = [...darkVars].filter((n) => !lightVars.has(n) && !isThemeInvariant(n)).sort();
```

Print:

```
=== Theme parity: Variable coverage ===
  Light-only variables: (none)
  Dark-only variables: (none)
  PASS
```

If either array is non-empty, replace `(none)` with a comma-separated list and replace `PASS` with `FAIL`; set `exitCode = 1`.

### Step 4: Extend the failure summary

Update the bottom-of-script stderr block so it appends a parity anchor when relevant:

```
FAIL: One or more contrast checks did not meet the >=3:1 threshold.
  Part A failures: phase color vs --bg-0 (WCAG SC 1.4.11)
  Part B failures: adjacent phase pair contrast (PRD-018 M-02)
  Parity failures: light/dark variable coverage (PRD-018 M-06)
```

Print the parity line unconditionally alongside the Part A/B anchors when `exitCode !== 0`. The reader uses the per-section output above to locate which check actually failed.

### Step 5: Tests

Add to `tests/check-phase-contrast.test.ts`:
- Parity passes on the vendored-shape `tokens-good.css` (light-only and dark-only both empty after allowlist subtraction; section prints PASS; exit 0).
- Parity fails on `tokens-bad-parity.css` (where `--brand` is removed from the dark block) — section prints `Light-only variables: --brand` and `FAIL`; exit 1; stderr includes the parity anchor.
- Allowlist short-circuit: a fixture where `--s-9` exists only in `:root` (not in dark) MUST still pass — `--s-*` is theme-invariant.

### Step 6: Document the allowlist

Add a one-line comment immediately above each `THEME_INVARIANT_PREFIXES` entry explaining why it is invariant. A reviewer reading the script sees: spacing scale (one source of truth), radii (geometry, not theme), type scale (sizes, not colors), motion (durations/eases, not theme).

### What NOT to do

- Do NOT add color-family prefixes (`--bg-`, `--fg-`, `--phase-`, `--ok`, `--err`, etc.) to the allowlist. Those MUST appear in both blocks.
- Do NOT compare values between light and dark — the parity check is about variable presence, not equality. Light and dark are expected to have different colors for the same name.
- Do NOT add visual-regression screenshot diffing here. That is TDD-035 M-03 territory and explicitly out of scope per PLAN-034-3.
- Do NOT silently expand the allowlist to make a real failure pass. If a new theme-invariant family ships in the design system, update `THEME_INVARIANT_PREFIXES` in a one-line PR with a rationale linked back to the design-system commit; do not bury the addition in this spec.
- Do NOT make the parity check advisory. PRD-018 M-06 binds it as a success metric; CI-blocking is the only viable enforcement.

## Acceptance Criteria

- [ ] `THEME_INVARIANT_PREFIXES` contains exactly `['--s-', '--r-', '--text-', '--ease-', '--dur-']` with one-line comments explaining each.
- [ ] `extractVarNames` returns the full set of `--*` declarations in a block (matched against the vendored token file's known shape — at minimum the 8 phase tokens, `--bg-0`, `--bg-1`, `--bg-2`, `--fg-0`, `--fg-1`, `--fg-2`, `--brand`, `--ok`, `--warn`, `--err`, `--info`, `--line-1`, `--line-2`).
- [ ] Running `bun scripts/check-phase-contrast.ts` against the vendored token file prints `Light-only variables: (none)`, `Dark-only variables: (none)`, `PASS`, and exits 0 (assuming Part A and Part B also pass).
- [ ] Running against `tokens-bad-parity.css` (with `--brand` removed from dark) prints `Light-only variables: --brand` and `FAIL`, exits 1, and stderr includes `Parity failures: light/dark variable coverage (PRD-018 M-06)`.
- [ ] A fixture where `--s-9` is light-only does NOT trigger a parity failure (allowlist works).
- [ ] `bun test plugins/autonomous-dev-portal/tests/check-phase-contrast.test.ts` is green; parity cases (pass, light-only fail, dark-only fail, allowlist short-circuit) are present.
- [ ] Exactly one commit lands. Body references `PRD-018 M-06; TDD-034 §5.11; PLAN-034-3 Task 4`.

## Verification

Manual: run the script locally against the vendored `design-tokens.css`; the parity section MUST print `(none)` / `(none)` / `PASS` on the v1 palette. Manually delete `--brand` from the dark block in a scratch copy and confirm the script flags it; restore. Archive the parity-section stdout in the PR description alongside Part A and Part B output as the v1 baseline.
