# PLAN-031-2: Vitest → Jest Reference Sweep

## Metadata
- **Parent TDD**: TDD-031-spec-reconciliation-path-vitest-bats
- **Parent PRD**: PRD-016-test-suite-stabilization (G-08, FR-1651)
- **Estimated effort**: 0.5 day (~30 min mechanical sweep + ~1.5h secondary `\bvi\.` review pass)
- **Dependencies**: []
- **Blocked by**: [PLAN-031-1] (matrix scaffold; pre-stubbed `## Vitest (PLAN-031-2)` section)
- **Priority**: P1

## Objective
Reconcile approximately 26 SPEC files that name `Vitest` / `vitest` as the test
runner. The as-built runner is Jest (per PRD-016 NG-03 and `jest.config.cjs`).
After this plan lands, no SPEC under `plugins/autonomous-dev/docs/specs/` contains
the bare `vitest` token (case-insensitive, word-boundary-anchored), and SPECs that
mention Vitest-specific APIs (`vi.fn()`, `vi.mock()`) are flagged for manual
review per TDD §5.2 and OQ-31-05.

This is the second of four sequential commits inside the single TDD-031 doc-only
PR (per TDD §8.1).

## Scope

### In Scope
- A pre-sweep audit producing a frozen list of affected SPEC files via
  `grep -rlni "vitest" plugins/autonomous-dev/docs/specs/`. Confirms the cohort
  size against the TDD's audited 26 (vs PRD-016's older estimate of ~10).
- The mechanical case-aware substitutions per TDD §5.2:
  - `s/\bVitest\b/Jest/g`
  - `s/\bvitest\b/jest/g`
- A secondary scan for Vitest-specific API references (`vi.fn`, `vi.mock`,
  `vi.spyOn`, `vi.useFakeTimers`, etc.) using `grep -rln "\bvi\."` and
  hand-classification of each hit (rename to `jest.*` equivalent OR record an
  Open Question if no clean Jest equivalent exists).
- Append rows to the `## Vitest (PLAN-031-2)` section of
  `plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md`, one row
  per amended SPEC.
- A post-sweep verification step:
  `grep -rliE "\bvitest\b" plugins/autonomous-dev/docs/specs/` must return empty.

### Out of Scope
- Path-drift amendments — PLAN-031-1.
- Bats-reference reconciliation — PLAN-031-3.
- The verification script and CI guard — PLAN-031-4.
- Removing the `vitest` dev-dependency from any `package.json` (TDD NG-3106).
- Re-deriving SPEC content (NG-3101).
- Translating Vitest test code to Jest test code in any production-side test
  files. The plan amends SPEC prose only; `.test.ts` files are untouched.
- Vitest config files (`vitest.config.ts`) if any exist outside SPEC text.
- SPEC text that uses the word `Vitest` only inside a deliberate "rejected
  alternative considered" passage describing past evaluation (these are
  historical record, not drift). Such SPECs are flagged in task 4 and
  hand-amended with a clarifying note rather than a token swap.

## Tasks

1. **Audit pass: enumerate affected SPECs** — Run
   `grep -rlni "vitest" plugins/autonomous-dev/docs/specs/ | sort` and capture
   the file list. Compare against TDD §3.1's count of 26.
   - Files to create: none (working scratch only).
   - Acceptance criteria: Frozen list captured. Count documented in the matrix
     preamble for the Vitest section. Drift from 26 by more than ±5 triggers a
     pause to re-read the TDD audit notes.
   - Estimated effort: 10 min

2. **Hand-flag historical-context SPECs** — Walk the list from task 1 and grep
   the surrounding context for each hit (`grep -n -B2 -A2 -i "vitest" <file>`).
   Identify any SPECs where the `Vitest` mention is a deliberate alternative-rejected
   note (e.g., "considered Vitest, chose Jest because…"). These are NOT
   substituted; they get a hand-applied amendment (e.g., wrap in a "Historical
   note:" prefix or leave verbatim with a Notes-column annotation).
   - Files to modify: none in this task (pure classification).
   - Acceptance criteria: A pre-sweep classification list exists naming any
     SPECs that should be excluded from the mechanical substitution. List is
     pasted into the matrix preamble.
   - Estimated effort: 30 min

3. **Apply the Vitest → Jest sweep** — Run the BSD-sed-compatible substitutions
   per TDD §5.2, scoped to exclude the SPECs identified in task 2 (use
   `find ... -not -path` clauses, or apply per-file via xargs over the
   in-scope list):
   ```bash
   find plugins/autonomous-dev/docs/specs -name "*.md" -exec \
     sed -i.bak -e 's/\bVitest\b/Jest/g' -e 's/\bvitest\b/jest/g' {} \;
   find plugins/autonomous-dev/docs/specs -name "*.md.bak" -delete
   ```
   Then revert any task-2 historical-context SPECs to their original content
   and apply the hand-amendment instead.
   - Files to modify: ~26 SPEC files minus task-2 carve-outs (typically 0–2).
   - Acceptance criteria: `git diff --stat` shows the expected modified-file
     count. No `.md.bak` files remain.
     `grep -rliE "\bvitest\b" plugins/autonomous-dev/docs/specs/` returns
     empty (or returns only the historical-context SPECs, which are listed in
     the matrix preamble as known whitelist entries).
   - Estimated effort: 10 min

4. **Secondary `\bvi\.` review pass** — Run
   `grep -rln "\bvi\." plugins/autonomous-dev/docs/specs/`. For each hit, open
   the file, locate the API reference, and decide:
   - (a) Direct rename to Jest equivalent (`vi.fn()` → `jest.fn()`,
     `vi.mock()` → `jest.mock()`, `vi.spyOn()` → `jest.spyOn()`,
     `vi.useFakeTimers()` → `jest.useFakeTimers()`); apply by hand.
   - (b) No clean Jest equivalent (e.g., `vi.hoisted()`); leave the reference,
     add a Notes-column annotation in the matrix flagging the SPEC as Open
     Question OQ-31-05 follow-up.
   Each (a) decision is one extra hand-edit; each (b) decision is a matrix row
   only.
   - Files to modify: variable subset of SPECs (typically 0–5; depends on how
     many TDD-022/024 SPECs cite `vi.*` APIs).
   - Acceptance criteria: Every `\bvi\.` hit is either rewritten to `jest.*`
     or recorded as Open Question. No untouched `\bvi\.` reference remains
     unrecorded in the matrix.
   - Estimated effort: 30–60 min (depends on hit count)

5. **Populate matrix Vitest section** — For each amended SPEC, add a row:
   `| SPEC-NNN-N-NN | Vitest | <Token / vi.* / Historical> | @pwatson | <notes> |`
   The Action column distinguishes the three sub-classes (token sweep,
   `vi.*` API rename, historical-context hand-amendment).
   - Files to modify: `plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md`
   - Acceptance criteria: Row count equals total modified-SPEC count from this
     plan. Rows alphabetically sorted by SPEC ID. Action column values are one
     of {Token, vi-API, Historical}.
   - Estimated effort: 30 min

6. **Spot-check three amended SPECs** — Pick one from each Action sub-class and
   read the diff in context. Confirm `Jest` reads naturally (per TDD §9.3).
   Log the three checks in the matrix preamble for this section.
   - Files to modify: matrix preamble only.
   - Acceptance criteria: Three SPECs named, three checks recorded, all three
     read naturally post-amendment.
   - Estimated effort: 15 min

7. **Commit** — Single commit on the TDD-031 branch:
   `docs(specs): PLAN-031-2 vitest → jest sweep + vi.* API review (~26 SPECs)`.
   Body lists per-sub-class counts (Token N=…, vi-API N=…, Historical N=…) and
   the three spot-check results.
   - Files to modify: none beyond what tasks 3-6 staged.
   - Acceptance criteria: Single atomic commit. `git log -1 --stat` shows
     amended SPECs + matrix update.
   - Estimated effort: 5 min

## Dependencies & Integration Points

**Exposes to other plans:**
- Appends rows to the shared reconciliation matrix; PLAN-031-3 follows the same
  pattern. PLAN-031-4 reads the matrix to cross-reference its mechanical
  verification output.
- Records OQ-31-05 follow-ups (`\bvi\.` API references with no clean Jest
  equivalent) for downstream resolution; the verification script in PLAN-031-4
  does NOT block on these — they are tracked separately.

**Consumes from other plans:**
- **PLAN-031-1** (blocking): the reconciliation matrix file with its pre-stubbed
  `## Vitest (PLAN-031-2)` section. Without this scaffold the plan would have to
  author the matrix file from scratch and risk merge conflicts with PLAN-031-1.

## Testing Strategy

- **Pre-sweep audit (task 1):** Freezes scope; mismatched counts are caught
  before substitution.
- **Pre-sweep classification (task 2):** Catches the failure mode where the sed
  destroys an alternative-considered passage's meaning.
- **Post-sweep mechanical check (task 3):**
  `grep -rliE "\bvitest\b" plugins/autonomous-dev/docs/specs/` must return empty
  (modulo declared whitelist entries).
- **Secondary `\bvi\.` review (task 4):** Catches the failure mode flagged by
  TDD OQ-31-05 — SPECs that use Vitest-specific APIs without naming the runner.
- **Spot-check (task 6):** Three SPECs read by a human reviewer for naturalness
  per TDD §9.3.
- **No executable tests added.**

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| The word-boundary sed substitution incorrectly modifies an inflected form (e.g., `Vitest's`, `vitests`). | Low | Low | The `\b` anchors prevent suffix matches; `Vitest's` becomes `Jest's` (still correct), and `vitests` would not match (correct, no change). Spot-check (task 6) catches any anomaly. |
| A SPEC's "alternatives considered" passage is silently rewritten, erasing historical record. | Medium | Medium | Task 2 hand-flags such SPECs before the sweep; they are excluded from the mechanical pass and hand-amended with a clarifying note. |
| The `\bvi\.` secondary scan misses a Vitest API used via destructured import (`import { vi } from 'vitest'; const { fn } = vi; fn(...)` style). | Low | Low | Such usage is rare in SPEC prose (which describes tests, not implements them). If found post-merge, it gets a follow-up small PR; PLAN-031-4's verification script also catches the residual `vitest` import string. |
| A `vi.*` API has no clean Jest equivalent and the SPEC's intent is genuinely Vitest-coupled. | Low | Medium | Recorded as Open Question OQ-31-05; SPEC is not silently fudged. The follow-up may produce a SPEC-rewrite PR or a TDD amendment, but neither blocks PLAN-031-2. |
| Audited count of 26 is wrong because SPECs landed since the audit. | Medium | Low | Task 1 re-audits and freezes; matrix preamble records actual N. PRD-016's older "~10" estimate is explicitly superseded by the TDD's 26 audit and now by this plan's actual count. |

## Definition of Done

- [ ] `grep -rliE "\bvitest\b" plugins/autonomous-dev/docs/specs/` returns empty
      (or returns only declared historical-context whitelist entries).
- [ ] `grep -rln "\bvi\." plugins/autonomous-dev/docs/specs/` matches the
      whitelist of OQ-31-05 follow-ups in the matrix.
- [ ] `## Vitest (PLAN-031-2)` matrix section is populated with one row per
      amended SPEC, sorted by SPEC ID, with Action column ∈ {Token, vi-API, Historical}.
- [ ] Three spot-checks recorded in the matrix preamble for this section, one
      from each Action sub-class.
- [ ] No `.md.bak` files remain.
- [ ] Single commit on the TDD-031 branch with the prescribed message.
- [ ] No production code or `package.json` changes.
- [ ] No `.test.ts` / `.spec.ts` files modified.
