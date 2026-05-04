# SPEC-031-3-02: Bats Per-SPEC Manual Amendment Application

## Metadata
- **Parent Plan**: PLAN-031-3 (bats → jest reconciliation)
- **Parent TDD**: TDD-031-spec-reconciliation-path-vitest-bats (§5.3, §6.4)
- **Parent PRD**: PRD-016-test-suite-stabilization (G-08, FR-1652)
- **Tasks Covered**: PLAN-031-3 task 3 (apply per-SPEC amendments)
- **SPECs amended by this spec**: ~15 SPECs (mostly TDD-002 / TDD-010 children, exact list from SPEC-031-3-01)
- **Estimated effort**: 30 minutes (~2 min per SPEC across ~15 SPECs)
- **Status**: Draft
- **Depends on**: SPEC-031-3-01 (decision list with case (a)/(b)/Historical classifications)

## Summary
Apply the per-SPEC manual amendments produced by SPEC-031-3-01's decision
list. For case (a) rows, replace the cited Bats path with the Jest path and
revise surrounding prose. For case (b) rows, replace the Bats reference with
a one-sentence retirement note. For Historical rows, prefix the existing
prose with `Historical:` to mark it as alternative-considered context.

## Functional Requirements

- **FR-1**: For every case-(a) row in the decision list, the SPEC body
  MUST be amended such that the cited Bats path string is replaced by the
  case-(a) Jest path. Surrounding prose explaining the test choice (e.g.,
  "we use Bats because…") MUST be revised to match the Jest reality.
  Task: PLAN-031-3 task 3 case (a).
- **FR-2**: For every case-(b) row, the cited Bats reference (path AND any
  immediately surrounding sentence describing the test) MUST be replaced by a
  one-sentence retirement note. The note's exact suggested template:
  ```
  Bats coverage (originally <bats-path>) was retired in PRD-016 cleanup;
  no Jest replacement is currently planned.
  ```
  Reasonable per-SPEC rewording is allowed if the template reads
  ungrammatically in context, but the meaning (retirement + no replacement)
  MUST be preserved. Task: PLAN-031-3 task 3 case (b).
- **FR-3**: For every Historical row, the SPEC body MUST be amended only
  by prefixing the relevant passage with `Historical:` (or a contextually
  equivalent phrasing such as `Historical note:` if the passage is a
  bullet). The Bats path string itself is NOT removed — it remains as
  alternative-considered context.
- **FR-4**: After all amendments are applied, the verification grep
  MUST report zero hits over `docs/specs/` (excluding any declared
  Historical-row SPECs):
  ```bash
  grep -rlnE "\.bats|tests/unit/test_.*\.sh" plugins/autonomous-dev/docs/specs/
  ```
- **FR-5**: All amendments MUST be performed by hand-edit; `sed` MUST NOT
  be used because the substitutions are not uniform across SPECs. Multi-
  occurrence SPECs (e.g., a SPEC citing multiple Bats files) get one
  amendment per occurrence; the decision list expands those into separate
  rows ahead of time.
- **FR-6**: Files modified MUST be limited to `plugins/autonomous-dev/docs/specs/`.
  No `.bats` files (none should still exist), no `.test.ts` files, no
  `package.json`, no production code is touched (NG-3103, NG-3105 / PRD-016 NG-03).
- **FR-7**: After amendments, working tree changes MUST be staged but
  NOT committed by this spec. SPEC-031-3-03 produces the single atomic
  commit that closes PLAN-031-3.

## Non-Functional Requirements

| Requirement | Target | Measurement Method |
|-------------|--------|---------------------|
| Amendment completeness | Every decision-list row has a corresponding diff hunk | `git diff --name-only` ⊇ decision list's case (a)/(b)/Historical SPEC IDs |
| Bats-token elimination | Zero matches post-amendment (excluding Historical SPECs) | `grep -rlnE "\.bats|tests/unit/test_.*\.sh"` returns empty over non-historical SPECs |
| Prose readability | Each amended passage reads as a complete sentence | Spot-check sampling in SPEC-031-3-03 |
| Idempotence | Re-running this spec on a clean tree is a no-op | After staging, re-walk the decision list; second pass produces no new diffs |

## Patterns to Find/Replace

This spec performs per-SPEC manual edits. There is no uniform pattern; each
case-(a) edit substitutes one specific Bats path for one specific Jest path,
each case-(b) edit substitutes one Bats reference for the retirement-note
template, and each Historical edit prefixes a passage with `Historical:`.

### Suggested case-(b) retirement-note template

```
Bats coverage (originally tests/unit/test_<name>.sh) was retired in PRD-016
cleanup; no Jest replacement is currently planned.
```

### Examples (illustrative, not authoritative)

| SPEC ID | Original | Amended (case (a)) |
|---------|----------|----------------------|
| SPEC-002-1-05 (case (a)) | `Run tests/unit/test_daemon_lifecycle.sh` | `Run tests/intake/daemon-lifecycle.test.ts via Jest` |
| SPEC-010-2-04 (case (b)) | `Validated by tests/unit/test_legacy_init.sh` | `Bats coverage (originally tests/unit/test_legacy_init.sh) was retired in PRD-016 cleanup; no Jest replacement is currently planned.` |

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| ~15 SPEC files under `plugins/autonomous-dev/docs/specs/` | Modify | Per-SPEC hand edits driven by SPEC-031-3-01's decision list. Exact list = decision-list rows. |

No new files are created. The matrix file is appended to in SPEC-031-3-03,
not by this spec.

## Verification Commands

```bash
# 1. Sanity: working tree starts from a state where SPEC-031-3-01's
#    decision list exists (in scratch or in the matrix preamble) and no
#    SPECs have yet been edited for the bats class.
git diff --name-only plugins/autonomous-dev/docs/specs/  # should be empty

# 2. After all amendments, count modified SPECs
git diff --name-only plugins/autonomous-dev/docs/specs/ | wc -l   # ≈ 15

# 3. Bats-token elimination
grep -rlnE "\.bats|tests/unit/test_.*\.sh" \
  plugins/autonomous-dev/docs/specs/   # must return empty (modulo Historical whitelist)

# 4. No production code touched
git diff --name-only | grep -vE "^plugins/autonomous-dev/docs/specs/" | \
  grep -v "PRD-016-spec-reconciliation.md"   # must return empty

# 5. No `.bats` or `.test.ts` files modified
git diff --name-only | grep -E "\.bats$|\.test\.ts$"   # must return empty

# 6. Idempotence: re-walking the decision list produces no further diffs
# (Manual; reviewer reads the diff and confirms each row mapped 1:1.)
```

## Acceptance Criteria

```
Given the decision list classifies SPEC-NNN-N-NN as case (a) → <jest-path>
When SPEC-031-3-02 applies the amendment
Then the SPEC body no longer contains the original Bats path string
And the SPEC body contains the case-(a) Jest path string
And surrounding prose has been revised to match the Jest reality (no leftover "Bats" mention)
```

```
Given the decision list classifies SPEC-NNN-N-NN as case (b)
When SPEC-031-3-02 applies the amendment
Then the SPEC body no longer contains the original Bats path string
And the SPEC body contains a one-sentence retirement note
And the retirement note names the original Bats path AND states "no Jest replacement is currently planned"
```

```
Given the decision list classifies SPEC-NNN-N-NN as Historical
When SPEC-031-3-02 applies the amendment
Then the original passage retains the Bats path string verbatim
And the passage is prefixed with `Historical:` (or `Historical note:` for bullets)
And the SPEC is recorded in the matrix as a Historical-row whitelist entry for the FR-4 grep
```

```
Given a SPEC cites multiple Bats files
When SPEC-031-3-02 walks the decision list
Then each occurrence is amended independently per its own decision-list row
And the SPEC's diff shows one hunk per occurrence (not one bulk rewrite)
```

```
Given all amendments are applied
When `grep -rlnE "\.bats|tests/unit/test_.*\.sh" plugins/autonomous-dev/docs/specs/` is run
Then it returns empty over non-Historical SPECs
And any returned files are explicitly listed in the matrix preamble's Historical whitelist
```

```
Given amendments are complete
When `git status` is observed
Then ~15 SPEC files are staged (modified)
And no production code, `.bats`, `.test.ts`, or `package.json` files appear in the staged set
And no commit has been created (SPEC-031-3-03 produces the commit)
```

```
Given a case-(a) edit was applied
When the reviewer reads the amended passage in isolation
Then it reads as a coherent statement about a Jest test (no orphaned "Bats" word, no broken sentence)
```

## Rollback Plan

If amendments are incorrect (wrong paths, broken prose, missed rows),
revert the staged SPEC changes:
```bash
git checkout -- plugins/autonomous-dev/docs/specs/
```
The decision list (SPEC-031-3-01) remains intact for re-application.

If amendments have been committed (i.e., SPEC-031-3-03 already ran):
```bash
git revert <commit-sha>
```
This restores the SPEC corpus exactly to its pre-PLAN-031-3 state.

## Implementation Notes

- The 15-SPEC ceiling is approximate. The actual count is whatever
  SPEC-031-3-01's decision list contains. If the count is materially
  different, the matrix preamble already records the divergence (per
  SPEC-031-3-01 FR-2); this spec inherits that count without question.
- Hand-edits introduce typo risk. Re-read each amended passage in context
  before staging the next file. The PR's diff review is the human gate;
  PLAN-031-4's verification script is the mechanical gate.
- Multi-occurrence SPECs are intentionally surfaced as multiple decision-
  list rows in SPEC-031-3-01 so this spec applies them per-occurrence rather
  than per-file. This makes the diff easier to review and reverts more
  granular.
- Per TDD §6.4 reliability principle: each Bats decision is recorded so a
  misclassification is revertable in isolation. Do NOT collapse multi-row
  SPECs into single-line edits.
- The retirement-note template is suggested, not mandatory. If a SPEC's
  context demands different phrasing (e.g., a table cell where the template
  doesn't fit), use a contextually appropriate alternative that preserves
  the meaning.
- Per NG-3105 / PRD-016 NG-03: do NOT create Jest tests to cover retired
  Bats surface. Case (b) classifications stay case (b) in this PR.

## Out of Scope

- Audit and case classification (handled by SPEC-031-3-01).
- Authoring matrix rows (handled by SPEC-031-3-03).
- Path-drift or vitest amendments (PLAN-031-1 / PLAN-031-2).
- The verification script and CI guard (PLAN-031-4).
- Authoring new Jest tests, Bats files, or any production-side test code.
- Modifying `package.json`, `jest.config.cjs`, or other config.
- Re-deriving SPEC content (NG-3101).
- Production code changes (NG-3103).
