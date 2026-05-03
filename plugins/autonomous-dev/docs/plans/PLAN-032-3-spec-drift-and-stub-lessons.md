# PLAN-032-3: Spec Path-Drift Sweep + Stub-Assertion Lessons-Learned

## Metadata
- **Parent TDD**: TDD-032-cleanup-and-operational-closeout (§5.4, §5.5, WS-4 + WS-5)
- **Parent PRD**: PRD-017 (FR-1715..FR-1725)
- **Estimated effort**: 2.5 days
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P1
- **Closes FRs**: FR-1715, FR-1716, FR-1717, FR-1718, FR-1719, FR-1720, FR-1721, FR-1722, FR-1723, FR-1724, FR-1725

## Objective
Land the two doc-only workstreams that close PRD-017's hygiene loops:
1. **Spec path-drift sweep (production-code side).** Audit every spec
   under `plugins/autonomous-dev/docs/specs/**`, identify "Files to
   Create/Modify" rows whose paths do not exist as-built, amend each
   row to the as-built path with a `<!-- moved-from: ... -->` HTML
   comment preserving the original, and publish a summary table at
   `_path-drift-amendments.md`. Test-side drift (paths matching
   `/(tests?|__tests__|spec)\//`) is flagged but deferred to PRD-016
   per FR-1720.
2. **Stub-assertion staleness lessons-learned.** Author the
   appendix at
   `plugins/autonomous-dev/docs/lessons-learned/stub-assertion-staleness.md`
   with the pattern description, three real cited examples from the
   spec→code session, the proposed `stubOf().supersededBy().delete()`
   helper (FR-1723), a worked example, and a deferred-adoption open
   questions list (FR-1725).

Both workstreams are doc-only; neither changes runtime behavior.

## Scope

### In Scope
- One-shot detection script `scripts/audit-spec-drift.ts` that walks
  every spec, parses "Files to Create/Modify" tables, tests
  `fs.existsSync` per path, runs the heuristic remap from TDD §5.4.1,
  and emits a CSV with columns `spec_id`, `original_path`,
  `candidate_path`, `exists_after_remap`. The script is deleted in
  the same commit as the doc edits per OQ-03 — it is single-use, not
  shippable infrastructure.
- Hand-edit of every drifted spec's "Files to Create/Modify" row,
  with `<!-- moved-from: <original> -->` HTML comment immediately
  preceding the amended row (FR-1716).
- Test-side drift exclusion: rows whose path matches
  `/(tests?|__tests__|spec)\//` are flagged in
  `_path-drift-amendments.md` under a "Deferred to PRD-016" section
  and **not** amended in this PR (FR-1720).
- Summary table at
  `plugins/autonomous-dev/docs/specs/_path-drift-amendments.md`
  with columns `Spec ID | Original Path | As-Built Path | Commit SHA`,
  sorted by spec ID (FR-1718).
- Lessons-learned appendix at
  `plugins/autonomous-dev/docs/lessons-learned/stub-assertion-staleness.md`
  containing:
  - Pattern description (FR-1721).
  - At least three real examples from the spec→code session
    (FR-1722).
  - Proposed `stubOf(specId, replacedBySpecId?).supersededBy().delete()`
    helper convention (FR-1723).
  - Worked example showing the `delete()` flip in a follow-up PR's
    diff (FR-1724).
  - Deferred-adoption open questions (FR-1725).
- The convention proposal is **documentation, not enforcement** —
  no linter, no CI gate, no runtime helper ships in this PR (NG-04,
  Tenet 1).

### Out of Scope
- Modifying spec acceptance criteria, requirements, or test
  expectations. The sweep edits paths and adjacent prose only
  (FR-1717).
- Test-file path drift: PRD-016 owns the test-side analog (FR-1720).
  If a spec's drift is *only* in test paths, this PR flags the spec
  in the summary table and amends nothing.
- Test-tag convention enforcement: the proposed `stubOf()` helper
  is documented but unimplemented; adoption is deferred (FR-1725).
- Cross-spec consistency edits beyond path remapping. If the audit
  surfaces a spec whose acceptance criteria reference a non-existent
  module, that is filed as a follow-up; this PR does not edit
  semantic content.
- Specs outside the TDD-010-024 audit window unless the as-built
  path differs from the spec (per OQ-03: "audit broadly; fix
  narrowly").

## Tasks

1. **Author detection script `scripts/audit-spec-drift.ts`.**
   Implement the algorithm from TDD §5.4.1:
   - For every `.md` file under `plugins/autonomous-dev/docs/specs/**`:
     - Parse markdown; locate any heading matching
       `/^##.*Files to (Create|Modify)/i`.
     - Extract the markdown table that follows; pull the path column.
     - For each path, run `fs.existsSync(repoRoot + path)`.
     - If absent, apply the heuristic remap:
       - `src/portal/...` → `plugins/autonomous-dev-portal/server/...`
       - `plugins/autonomous-dev/...` (when as-built) → `plugins/autonomous-dev/intake/...`
       - any other heuristic the audit reveals (extend in-script).
     - Emit a CSV row: `spec_id,original_path,candidate_path,exists_after_remap,is_test_path`.
   - The script is intentionally a *finder*, not an *editor* (Tenet
     2 — doc-only edits are line-by-line reviewed; auto-`sed` is
     rejected per §7.2 Alt-2).
   - Files to create: `scripts/audit-spec-drift.ts`,
     `tmp/spec-drift-report.csv` (audit output; not shipped).
   - Acceptance criteria: Running `npx ts-node scripts/audit-spec-drift.ts > tmp/spec-drift-report.csv`
     produces a CSV with one row per drifted path. Manual spot-check
     of three random rows confirms the path actually does not exist
     as-listed and the candidate path (if any) does. Test paths are
     flagged via `is_test_path=true`.
   - Estimated effort: 0.5 day

2. **Hand-edit drifted spec rows (production-code side).** For
   each CSV row where `is_test_path=false` and `exists_after_remap=true`:
   - Open the spec.
   - Find the "Files to Create/Modify" row matching the original
     path.
   - Insert `<!-- moved-from: <original_path> -->` on the line
     immediately above the row.
   - Replace the path in the row with the as-built path.
   - Do not touch any other content in the spec (FR-1717).
   - For rows where `exists_after_remap=false` (heuristic did not
     resolve), perform a manual investigation: `git log --diff-filter=A` for
     the original path may reveal a rename. Record the resolution
     in the CSV's `notes` column.
   - Files to modify: every spec file flagged by the CSV (~30+
     expected per PRD-017 §1).
   - Acceptance criteria: Every drifted row has a `<!-- moved-from: -->`
     comment immediately above. `git diff` on each spec shows
     path-only edits — no acceptance criteria, no requirements, no
     test plan changes (FR-1717). Spot-check: three randomly
     sampled amended specs have rows whose new paths
     `fs.existsSync` true.
   - Estimated effort: 0.75 day

3. **Generate summary table `_path-drift-amendments.md`.** Author
   `plugins/autonomous-dev/docs/specs/_path-drift-amendments.md`:
   - Frontmatter / header explaining the table's purpose, the
     PRD-017 commit it accompanies, and the production-vs-test
     boundary (FR-1720).
   - Main table sorted by spec ID with columns
     `Spec ID | Original Path | As-Built Path | Commit SHA`.
   - "Deferred to PRD-016" section listing every CSV row where
     `is_test_path=true`, with the same columns minus `Commit SHA`
     (PRD-016 owns those amendments).
   - Footer linking to PRD-017 §5.4 and TDD-032 §5.4.
   - Generation aid: post-edit, run
     `git grep -n '<!-- moved-from:' -- 'plugins/autonomous-dev/docs/specs/' | sort | sed -E 's/^([^:]+):.*moved-from: (.*) -->$/\1|\2/' > /tmp/drift.tsv`
     and convert TSV → markdown table.
   - Files to create: `plugins/autonomous-dev/docs/specs/_path-drift-amendments.md`.
   - Acceptance criteria: Summary table row count matches
     `git grep -c '<!-- moved-from:' -- 'plugins/autonomous-dev/docs/specs/'`
     (FR-1718, SM-04 verification). The "Deferred to PRD-016"
     section row count matches the CSV's `is_test_path=true` row
     count.
   - Estimated effort: 0.25 day

4. **Closeout-PR checklist for test-side exclusion (FR-1720).**
   The closeout PR description SHALL include a checklist:
   ```
   - [ ] Every amended row in this PR has a path that
         `fs.existsSync` returns true for at HEAD.
   - [ ] No amended row's path matches `/(tests?|__tests__|spec)\//`.
   - [ ] Every test-path drift discovered by the audit is listed
         in `_path-drift-amendments.md`'s "Deferred to PRD-016"
         section.
   ```
   Per OQ-05, this is a checklist (no CI gate, no new tooling per
   NG-04).
   - Files to modify: closeout PR description (managed at PR-author
     time, not in tree).
   - Acceptance criteria: Reviewer verifies each checkbox before
     approving.
   - Estimated effort: 0 day (PR-time)

5. **Delete the detection script.** After tasks 1-3 are complete,
   delete `scripts/audit-spec-drift.ts` in the same commit as the
   doc edits (OQ-03: single-use audit aid; NG-02 forbids new
   tooling).
   - Files to delete: `scripts/audit-spec-drift.ts`.
   - Acceptance criteria: `git ls-files scripts/audit-spec-drift.ts`
     returns no output post-commit.
   - Estimated effort: 0.1 day (in the same commit as task 2-3).

6. **Author lessons-learned appendix — pattern + examples.** Create
   `plugins/autonomous-dev/docs/lessons-learned/stub-assertion-staleness.md`.
   Sections (matching TDD §5.5.1):
   - **Pattern Description.** SPEC-N stubs assert
     `console.warn('stub')` to certify wiring; SPEC-N+1 replaces the
     stub with the real impl; the SPEC-N test still passes
     vacuously (other unrelated `console.warn` matches the
     assertion, OR the stub-warning was silently dropped during a
     typing-driven test edit). Cite PRD-017 §4.1 for the broader
     accumulation pattern.
   - **Three Cited Examples (FR-1722).** Real SPEC IDs from the
     spec→code session. Source the IDs by greping
     `plugins/autonomous-dev/tests/**` for `console.warn('stub'`
     patterns and cross-referencing the spec that originally landed
     the stub. Each example reports:
     - Spec ID, file path, line number of the stale assertion.
     - The stub assertion text.
     - Which SPEC-N+1 replaced the stub (cite the commit SHA from
       `git log --oneline -- <stub-file>`).
     - Why the assertion still passes (unrelated `console.warn`
       collateral, OR silently dropped from the test).
   - Files to create: `plugins/autonomous-dev/docs/lessons-learned/stub-assertion-staleness.md`
     (this task ships the first half — pattern + examples).
   - Acceptance criteria: Three cited examples have file path, line
     number, both spec IDs, and a commit SHA each. `lychee` link
     check passes.
   - Estimated effort: 0.5 day

7. **Author the proposed convention (FR-1723) + worked example
   (FR-1724) + deferred adoption (FR-1725).** Append to the same
   appendix:
   - **Proposed Convention.** The
     `stubOf(specId, replacedBySpecId?).supersededBy(...).delete()`
     helper from TDD §5.5.1. Show the helper signature, the
     intended import path
     (`@autonomous-dev/test-utils` — proposed; not implemented),
     and the failure mode when `.delete()` is invoked on a stub
     whose superseder has shipped.
   - **Worked Example.** Show the diff TDD §5.5.1 sketches:
     ```
     - stubOf('SPEC-023-2-04').supersededBy('SPEC-023-3-03');
     + stubOf('SPEC-023-2-04').supersededBy('SPEC-023-3-03').delete();
     ```
     Explain that the `.delete()` flip lives in SPEC-023-3-03's PR
     and surfaces the stale block in the diff so the reviewer
     deletes the assertion.
   - **Deferred Adoption.** Open questions for the follow-up PRD:
     - Runtime no-op or compile-time check? (TDD-032 OQ-02
       recommends runtime with `test.fail`).
     - How does the helper interact with `describe.skip`?
     - Mechanism for "delete me" — `throw`, `fail`, or `warn`?
     - Where does `@autonomous-dev/test-utils` live? (Standalone
       package vs. internal to the autonomous-dev plugin.)
   - **Cross-reference.** Pointer to PRD-017 §5.5, TDD-032 §5.5,
     and PRD-016 (which owns the test-side cleanup).
   - Files to modify: `plugins/autonomous-dev/docs/lessons-learned/stub-assertion-staleness.md`.
   - Acceptance criteria: Appendix has all five sections (pattern,
     three examples, proposed convention, worked example, deferred
     adoption). Worked example renders correctly in markdown
     fenced-diff blocks. `lychee` link check passes.
   - Estimated effort: 0.5 day

## Dependencies & Integration Points

**Exposes to other plans:**
- `_path-drift-amendments.md` summary table is referenced by
  PRD-016's test-side sweep when it picks up the deferred rows.
- The `stub-assertion-staleness.md` appendix is the canonical
  reference for any follow-up PRD that adopts the proposed
  `stubOf()` convention. PRD-017 R4 acknowledges adoption may not
  happen; the appendix's documentation value stands either way.

**Consumes from other plans:**
- None. The audit script is single-use and self-contained. The
  appendix is doc-only.
- *Soft sequencing:* TDD-032 §1 dependency D1 recommends merging
  PLAN-032-3 (this plan) before PRD-016's test-side sweep to
  minimize spec-file merge conflicts.

## Testing Strategy

- **Detection script (task 1):** Spot-check three random output
  rows by manually `fs.existsSync`-ing both `original_path` and
  `candidate_path`.
- **Spec edit verification (task 2):** Spot-check three random
  amended specs:
  - Each amended row has a `<!-- moved-from: -->` comment.
  - Each amended row's new path returns true from `fs.existsSync`.
  - `git diff <spec-file>` shows path-only edits — no semantic
    content change.
- **Summary table integrity (task 3):** Row count of the main table
  matches `git grep -c '<!-- moved-from:' -- 'plugins/autonomous-dev/docs/specs/'`
  (FR-1718).
- **Test-side exclusion (FR-1720):** No amended row's path matches
  `/(tests?|__tests__|spec)\//`. Asserted by the closeout PR
  checklist (task 4) — no CI gate per NG-04.
- **Doc-only regression posture (TG-06):** `npm test` pass count
  strictly non-decreasing (this plan ships no test changes; the
  count must be exactly equal).
- **Lychee link check:** Both
  `_path-drift-amendments.md` and `stub-assertion-staleness.md`
  pass the existing PLAN-016-2 markdown link check.
- **No new tooling tests:** The proposed `stubOf()` helper is
  documented, not implemented; no test ships for it (FR-1725).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| The detection script's heuristic remap (TDD §5.4.1) misses a path that drifted in an unanticipated direction. | Medium | Low | The script reports `exists_after_remap=false` for unmatched rows; task 2 includes a manual `git log --diff-filter=A` investigation step. Worst case: a few rows slip and surface in PRD-016's sweep. |
| Hand-editing ~30+ specs introduces accidental semantic edits that violate FR-1717. | Low | High | Tenet 2 mandates line-by-line review. The closeout commit is doc-only; reviewer scans `git diff` for any line that is not a path or an HTML comment. Task 4's checklist makes the contract explicit. |
| The three cited stub-assertion examples (FR-1722) cannot be sourced because the spec→code session's commit log does not preserve enough context. | Low | Medium | Task 6's grep + `git log --oneline` workflow finds the SPEC-N landing commit; cross-reference with the SPEC-N+1 PR via the spec's "Replaces" or "Closes" links. If three examples are not findable, document the gap and ship two — the appendix's pattern description still satisfies FR-1721. |
| The proposed `stubOf()` convention (FR-1723) is rejected by the follow-up PRD's reviewer, leaving the appendix as decor. | Medium | Low | PRD-017 R4 explicitly accepts this. The appendix's value as *documentation of the pattern* stands even if the convention is replaced. FR-1725 explicitly defers adoption. |
| `_path-drift-amendments.md` collides with PRD-016's parallel sweep, producing merge conflicts. | Medium | Low | PRD-017 D1 recommends merging this plan first. The "Deferred to PRD-016" section is the explicit hand-off surface; PRD-016 picks up only those rows. |
| The audit script is accidentally shipped in tree (NG-02 violation). | Low | Low | Task 5's deletion is part of the same commit as the doc edits. CI's `lint:no-tbd-shas` won't catch this — but reviewer + the closeout PR checklist will. Task 5's acceptance criteria include `git ls-files` returning no output post-commit. |

## Definition of Done

- [ ] `scripts/audit-spec-drift.ts` was used to generate the CSV and is deleted in the closeout commit (`git ls-files` returns no output).
- [ ] Every drifted spec row (production-code side) is amended; each amended row has a `<!-- moved-from: <original> -->` HTML comment immediately above (FR-1716).
- [ ] No amended row touches acceptance criteria, requirements, or test-plan content (FR-1717).
- [ ] No amended row's new path matches `/(tests?|__tests__|spec)\//` (FR-1720); test-side rows are listed in `_path-drift-amendments.md`'s "Deferred to PRD-016" section.
- [ ] `plugins/autonomous-dev/docs/specs/_path-drift-amendments.md` exists, sorted by spec ID, with row count matching `git grep -c '<!-- moved-from:'` (FR-1718).
- [ ] `plugins/autonomous-dev/docs/lessons-learned/stub-assertion-staleness.md` exists with all five sections (pattern, ≥3 cited examples, proposed convention, worked example, deferred adoption) — closes FR-1721 through FR-1725.
- [ ] `lychee` link check passes for both new markdown files.
- [ ] Closeout PR description includes the test-side-exclusion checklist (task 4).
- [ ] Total `npm test` pass count is exactly equal to baseline (no test changes; doc-only).
- [ ] PR description enumerates `closes FR-1715, FR-1716, FR-1717, FR-1718, FR-1719, FR-1720, FR-1721, FR-1722, FR-1723, FR-1724, FR-1725` and links to TDD-032 §5.4 + §5.5.
- [ ] Commit messages: one commit `docs(specs): path-drift sweep + amendments summary (PLAN-032-3)`; one commit `docs(lessons): stub-assertion-staleness appendix (PLAN-032-3)`. Per FR-1719 the spec-drift sweep is its own commit regardless of PR layout.
