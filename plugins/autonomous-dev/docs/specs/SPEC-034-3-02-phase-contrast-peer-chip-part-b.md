# SPEC-034-3-02: Phase-Contrast Verification — Part B (Adjacent-Pair / Peer-Chip)

## Metadata
- **Parent Plan**: PLAN-034-3 (Phase Contrast Verification + Light/Dark Theme Parity)
- **Parent TDD**: TDD-034 (Portal Redesign Foundations) §5.10
- **Parent PRD**: PRD-018 (Portal Visual Redesign) M-02 (binding part B: peer-chip), OI-3403
- **Tasks Covered**: PLAN-034-3 Task 3 (Part B adjacent-pair contrast check)
- **Estimated effort**: 2-3 hours
- **Future home**: `plugins/autonomous-dev-portal/scripts/check-phase-contrast.ts` (modify), `plugins/autonomous-dev-portal/tests/check-phase-contrast.test.ts` (modify), `plugins/autonomous-dev-portal/tests/fixtures/contrast/tokens-bad-pair.css` (new)
- **Depends on**: SPEC-034-3-01 (color math, parser, Part A loop, fixtures directory must exist)

## Description

Extend `scripts/check-phase-contrast.ts` with Part B: the peer-chip / adjacent-pair contrast check. For each of the 7 ordered pairs in pipeline order — `prd/tdd`, `tdd/plan`, `plan/spec`, `spec/code`, `code/review`, `review/deploy`, `deploy/observe` — the contrast ratio between the two phase colors MUST be ≥ 3.0:1 in BOTH light and dark themes, so an operator can distinguish adjacent phase chips placed side-by-side without relying on labels alone. 14 PASS/FAIL lines total (7 pairs × 2 themes).

Per PRD-018 v1.1 M-02 and TDD-034 OI-3403, Part B is CI-blocking — the same blocking status as Part A. There is no advisory carve-out. If the vendored palette fails Part B on first run, escalate to the design-system owner; do not weaken the threshold.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-portal/scripts/check-phase-contrast.ts` | Modify | Append Part B section after Part A; extend the failure-summary stderr block. |
| `plugins/autonomous-dev-portal/tests/check-phase-contrast.test.ts` | Modify | Add Part B pass/fail cases. |
| `plugins/autonomous-dev-portal/tests/fixtures/contrast/tokens-bad-pair.css` | Create | Fixture where `--phase-prd` and `--phase-tdd` are set to the same hex (ratio 1:1). |

One commit. Body references `Refs PRD-018 M-02 part B; TDD-034 §5.10 + OI-3403; PLAN-034-3 Task 3`.

## Implementation Details

### Step 1: Define the pair list

In `scripts/check-phase-contrast.ts`, declare the ordered pair list as a constant derived from the existing `PHASES` tuple:

```ts
// 7 adjacent pairs in pipeline order
const PAIRS = PHASES.slice(0, -1).map((a, i) => [a, PHASES[i + 1]] as const);
```

This MUST be derived from `PHASES`, not hard-coded — if a future TDD adds a 9th phase, the pair list updates automatically and the Part B count rises to 8.

### Step 2: Part B loop

After the Part A block (and its trailing `console.log()`), append:

```
=== Part B: Adjacent phase pair contrast (>=3:1) ===
  Theme: light
    prd     / tdd      ratio 4.21:1  PASS
    ... (7 lines)
  Theme: dark
    ... (7 lines)
```

For each `(theme, [a, b])` pair, compute `contrastRatio(theme.phases[a], theme.phases[b])`, render the line with both names `padEnd(7)` and `ratio.toFixed(2)`, and set `exitCode = 1` on any ratio < 3.0. Print all 14 lines — do NOT short-circuit.

### Step 3: Extend the failure summary

Update the stderr block at the bottom of the script so that on `exitCode !== 0` it prints both anchors:

```
FAIL: One or more contrast checks did not meet the >=3:1 threshold.
  Part A failures: phase color vs --bg-0 (WCAG SC 1.4.11)
  Part B failures: adjacent phase pair contrast (PRD-018 M-02)
```

The two lines are printed unconditionally on any failure (the script does not currently track which part failed at the summary level). A reader sees both anchors and inspects the per-line PASS/FAIL output above to find the offending check. This matches TDD-034 §5.10 verbatim.

### Step 4: Tests

Add to `tests/check-phase-contrast.test.ts`:
- Part B passes on `tokens-good.css` (the vendored-shape fixture from SPEC-034-3-01) — exit 0, 14 PASS lines.
- Part B fails on `tokens-bad-pair.css` (where `--phase-prd` and `--phase-tdd` are identical) — exit 1, includes `prd     / tdd      ratio 1.00:1  FAIL` in stdout, stderr includes the Part B anchor line.

### Step 5: Document local invocation

This spec does not own the `scripts/README.md` documentation — that lives with PLAN-034-2. If `scripts/README.md` already exists and has a Part A section from SPEC-034-3-01, append a Part B section after it. If it does not exist yet, leave a `// TODO: document Part B` marker in the script's top-of-file comment for the README spec to pick up. Do NOT create `scripts/README.md` from this spec.

### What NOT to do

- Do NOT add non-adjacent pairs (e.g., `prd/observe`). Operators look at adjacent chips in pipeline-order timelines; non-adjacent contrast is not a binding requirement and would over-constrain the palette.
- Do NOT change the threshold from 3.0. PRD-018 M-02 binds 3:1; tightening it without a PRD update is out of scope; loosening it defeats the gate.
- Do NOT collapse Part A and Part B into a single loop. The two checks measure different things (foreground/background vs side-by-side chips); keeping them separate makes failure diagnosis straightforward.
- Do NOT remove or weaken the Part A failure summary line. Both anchors print together so the reviewer can locate the failing line in the per-pair output above.
- Do NOT wire CI in this spec — the CI job (path-filtered on `design-tokens.css`) lands as part of PLAN-034-3 Task 5 in a follow-up spec.

## Acceptance Criteria

- [ ] `PAIRS` is derived from `PHASES.slice(0, -1)` — not hard-coded.
- [ ] Running `bun scripts/check-phase-contrast.ts` against the vendored token file prints the Part B header and 14 lines, all PASS, exit 0 (assuming Part A also passes).
- [ ] Running against `tokens-bad-pair.css` (prd == tdd) prints a `prd / tdd` FAIL line in both themes (or in whichever theme the fixture targets) and exits 1.
- [ ] On any failure, stderr includes both `Part A failures: phase color vs --bg-0 (WCAG SC 1.4.11)` and `Part B failures: adjacent phase pair contrast (PRD-018 M-02)`.
- [ ] `bun test plugins/autonomous-dev-portal/tests/check-phase-contrast.test.ts` is green; the new Part B cases are present.
- [ ] No CI workflow files modified (CI wiring is a separate spec).
- [ ] Exactly one commit lands. Body references `PRD-018 M-02 part B; TDD-034 §5.10 + OI-3403; PLAN-034-3 Task 3`.

## Verification

Manual: run the script locally against the vendored `design-tokens.css`; archive stdout (Part A + Part B sections together) in the PR description as the v1 baseline. Cross-check one adjacent pair's ratio against an external WCAG calculator. Confirm that swapping any two adjacent phase colors to identical hex in a scratch copy of the token file produces a Part B FAIL and exit 1.
