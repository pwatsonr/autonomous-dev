# SPEC-032-3-02: `_path-drift-amendments.md` Summary Table + Closeout PR Checklist

## Metadata
- **Parent Plan**: PLAN-032-3 (Spec Drift Sweep + Stub-Assertion Lessons)
- **Parent TDD**: TDD-032 §5.4 (WS-4 closeout artifact)
- **Parent PRD**: PRD-017 (FR-1718, FR-1720)
- **Tasks Covered**: PLAN-032-3 Task 3 (summary table), Task 4 (PR-time checklist)
- **Estimated effort**: 0.25 day
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-032-3-02-path-drift-amendments-summary-and-pr-checklist.md`

## Summary
Author the operator-and-reviewer-facing summary index of every path
drift amendment shipped by SPEC-032-3-01. The summary lives at
`plugins/autonomous-dev/docs/specs/_path-drift-amendments.md` (the
underscore prefix sorts it to the top of the specs directory listing).
It contains TWO tables:

1. **Production-side amendments** (sorted by spec ID): `Spec ID |
   Original Path | As-Built Path | Commit SHA`. One row per
   `<!-- moved-from: -->` HTML comment introduced by SPEC-032-3-01.

2. **Deferred to PRD-016** (test-side): `Spec ID | Original Path |
   As-Built Path` (no commit SHA — those amendments belong to
   PRD-016's sweep).

Also: prescribe the closeout PR description's testing checklist
(FR-1720 / OQ-05) — three reviewer-verified checkboxes that gate
merge.

This spec ships ONE new markdown file plus a documented PR-description
contract (the checklist text itself lives in this spec; the PR-author
copies it into the closeout PR description at PR-creation time).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/docs/specs/_path-drift-amendments.md` | Create | Summary index for the path-drift sweep |

The closeout PR description is NOT a tracked file; this spec
prescribes the exact checklist text the PR author pastes in.

## Functional Requirements

| ID | Requirement | Task |
|----|-------------|------|
| FR-1 | A new file `plugins/autonomous-dev/docs/specs/_path-drift-amendments.md` exists. | T3 |
| FR-2 | The file has a header / frontmatter explaining: (a) the file's purpose (index of path amendments), (b) the closeout PR commit SHA it accompanies (filled in at commit time), (c) the production-vs-test boundary (FR-1720 — production-side rows are amended; test-side rows are deferred to PRD-016). | T3 |
| FR-3 | The file has a "Production-side amendments" table with columns `Spec ID | Original Path | As-Built Path | Commit SHA`, sorted ascending by `Spec ID`. | T3 |
| FR-4 | The "Production-side amendments" table row count equals `git grep -c '<!-- moved-from:' -- 'plugins/autonomous-dev/docs/specs/'` minus any rows in this very summary file (the file references the marker prose without containing actual `<!-- moved-from: -->` markers; OR if the file does contain quoted markers in prose, the grep is run with a `-v _path-drift-amendments.md` exclusion). | T3 |
| FR-5 | Each "Production-side amendments" table row's `As-Built Path` value MUST satisfy `fs.existsSync(repoRoot + value) === true` at HEAD. | T3 |
| FR-6 | Each "Production-side amendments" table row's `Original Path` value MUST appear in exactly one `<!-- moved-from: <original> -->` HTML comment in some spec under `plugins/autonomous-dev/docs/specs/`. | T3 |
| FR-7 | The file has a "Deferred to PRD-016" section with a table whose columns are `Spec ID | Original Path | As-Built Path (best-known)`. The row count equals the count of `is_test_path=true` rows in the audit CSV produced by SPEC-032-3-01. | T3 |
| FR-8 | The file has a "Cross-references" footer linking to PRD-017 §5.4, TDD-032 §5.4, SPEC-032-3-01, and (forward) PRD-016. | T3 |
| FR-9 | The closeout PR description includes the verbatim checklist (per FR-1720 / OQ-05): | T4 |
|  | `- [ ] Every amended row in this PR has a path that fs.existsSync returns true for at HEAD.` |  |
|  | `- [ ] No amended row's path matches /(tests?|__tests__|spec)\//.` |  |
|  | `- [ ] Every test-path drift discovered by the audit is listed in _path-drift-amendments.md's "Deferred to PRD-016" section.` |  |
| FR-10 | A reviewer cannot approve the closeout PR until they have manually marked all three checkboxes (per OQ-05; no CI gate, no NG-04 violation — purely process-side enforcement). | T4 |

## Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| Row-count integrity | Production-side row count exactly matches `git grep -c '<!-- moved-from:'` (with the exclusion noted in FR-4) | Run grep at PR-review time and compare |
| As-built path correctness | 100% of As-Built Path entries `fs.existsSync` true at HEAD | Spot-check 5 random rows + a full sweep before commit |
| Deferred row count integrity | Deferred row count exactly matches CSV `is_test_path=true` count | Compare CSV vs. table line count |
| Sort order | Spec ID column is monotonic ascending (lexicographic) | Visual inspection or `sort -c` on extracted column |
| Discoverability | Underscore prefix sorts the file to top of `ls plugins/autonomous-dev/docs/specs/` | Verify post-commit |
| Link integrity | All footer links resolve | `lychee` PASS |
| Length | ≤ 1 page header prose + tables (tables can grow); the prose around the tables is ≤ 200 words | Word count on prose only |

## Technical Approach

### File body

```markdown
# Spec Path-Drift Amendments

This index records every path amendment landed by the PRD-017
closeout (SPEC-032-3-01). Each row corresponds to one
`<!-- moved-from: <original> -->` HTML comment in the affected spec.

**Production-side amendments are LANDED in this PR's commit.**
**Test-side amendments are DEFERRED to PRD-016.**

Closeout commit: `<COMMIT-SHA-FILLED-AT-COMMIT-TIME>`

## Production-side amendments

| Spec ID         | Original Path                                            | As-Built Path                                                          | Commit SHA |
|-----------------|----------------------------------------------------------|------------------------------------------------------------------------|------------|
| SPEC-XXX-Y-NN   | src/portal/foo.ts                                        | plugins/autonomous-dev-portal/server/foo.ts                            | <SHA>      |
| ...             | ...                                                      | ...                                                                    | ...        |

(Sort rows by `Spec ID` ascending. Use the same `<COMMIT-SHA>` for every
row in this PR; `Commit SHA` exists per-row to support future
amendments landing in different PRs.)

## Deferred to PRD-016

These rows are test-side drift. PRD-016 owns the test-file path
sweep; this PR amends nothing on the test side.

| Spec ID         | Original Path                                | As-Built Path (best-known)             |
|-----------------|----------------------------------------------|----------------------------------------|
| SPEC-XXX-Y-NN   | tests/foo/bar.test.ts                        | _to be assigned by PRD-016_            |
| ...             | ...                                          | ...                                    |

If `As-Built Path (best-known)` is unknown at sweep time (the audit
heuristic did not resolve), use `_to be assigned by PRD-016_` as the
placeholder.

## Cross-references

- [PRD-017 §5.4](../prds/PRD-017-cleanup-and-operational-closeout.md#54-spec-path-drift)
- [TDD-032 §5.4](../tdd/TDD-032-cleanup-and-operational-closeout.md#54-spec-path-drift-sweep)
- [SPEC-032-3-01](./SPEC-032-3-01-spec-drift-audit-script-and-hand-edits.md)
- PRD-016 (test-side sweep, forthcoming) — picks up "Deferred to PRD-016" rows.
```

### Generation aid

After SPEC-032-3-01's hand-edits land in the working tree (but before
the commit), generate the production-side table body:

```bash
# Extract spec_id + original path from every <!-- moved-from --> comment
git grep -nE '<!-- moved-from:.*-->' \
  -- 'plugins/autonomous-dev/docs/specs/' \
  | grep -v '_path-drift-amendments.md' \
  | sed -E 's/^([^:]+):[0-9]+:.*<!-- moved-from: ([^ ]+) -->.*/\1|\2/' \
  > /tmp/drift-extract.txt

# Each line: <spec-file-path>|<original-path>
# Convert to markdown rows by hand or via awk:
awk -F'|' '
  { spec_id = $1; sub(/.*\//, "", spec_id); sub(/\.md$/, "", spec_id);
    sub(/-.*/, "", spec_id);  # crude — adjust to match file naming
    print "| " spec_id " | " $2 " | (look-up as-built) | <SHA> |" }' \
  /tmp/drift-extract.txt
```

The `As-Built Path` column is filled in by reading the amended row in
each spec — it is the path the row was changed to. The implementer
opens each spec, finds the amended row, copies the new path. Tedious
but tractable for ~30+ rows.

The `Commit SHA` column is filled in AFTER `git commit` lands; the
`<COMMIT-SHA-FILLED-AT-COMMIT-TIME>` placeholder in the file body
becomes the actual SHA via a follow-up amend (or via `git commit
--amend` after recording the SHA from `git rev-parse HEAD`).

Acceptable simplification: ship the file with `<SHA>` as a literal
placeholder in every row, and add ONE line in the header prose
"Closeout commit: `<SHA>`" filled in via the amend. The per-row SHA
column then collapses to a single header reference. Document the
chosen layout in the closeout PR description.

### Closeout PR-description checklist

The PR author copies this verbatim into the PR description's
"Test plan" or "Checklist" section:

```markdown
### Path-drift verification (FR-1720 / OQ-05)

- [ ] Every amended row in this PR has a path that `fs.existsSync`
      returns true for at HEAD.
- [ ] No amended row's path matches `/(tests?|__tests__|spec)\//`.
- [ ] Every test-path drift discovered by the audit is listed in
      `_path-drift-amendments.md`'s "Deferred to PRD-016" section.
```

The reviewer marks each box BEFORE approving. If any box cannot be
marked, the reviewer requests changes.

## Interfaces and Dependencies

**Consumes:**
- The audit CSV from SPEC-032-3-01 (transient; consumed at hand-edit
  time).
- The `<!-- moved-from: -->` HTML comments inserted by SPEC-032-3-01.

**Produces:**
- The reader-facing summary index referenced by:
  - The closeout PR description.
  - PRD-016 (consumes the "Deferred to PRD-016" table).
  - Any future spec author who needs to know whether a path has
    been moved.

**Cross-references:**
- See FR-8.

## Acceptance Criteria

```
Given the worktree after SPEC-032-3-01's hand-edits land
When `ls plugins/autonomous-dev/docs/specs/_path-drift-amendments.md` runs
Then the file exists

Given the file
When the contents are read
Then a "Production-side amendments" table is present with columns
  Spec ID | Original Path | As-Built Path | Commit SHA
And a "Deferred to PRD-016" section is present with columns
  Spec ID | Original Path | As-Built Path (best-known)
And a "Cross-references" footer is present linking to PRD-017 §5.4,
  TDD-032 §5.4, SPEC-032-3-01, and PRD-016

Given the production-side table
When sorted by Spec ID column
Then the row order is unchanged (already sorted ascending)

Given the production-side table row count
When compared against
  `git grep -c '<!-- moved-from:' -- 'plugins/autonomous-dev/docs/specs/'`
  (with `_path-drift-amendments.md` itself excluded from the grep)
Then the two counts are exactly equal (FR-4)

Given each As-Built Path value in the production-side table
When `fs.existsSync(repoRoot + value)` is checked
Then the result is true (FR-5)

Given each Original Path value in the production-side table
When `git grep '<!-- moved-from: <original> -->'` is run across spec files
Then the marker appears in exactly one spec (FR-6)

Given the deferred table row count
When compared against the audit CSV's count of rows where is_test_path=true
Then the two counts are exactly equal (FR-7)

Given the file
When `lychee` is run on it
Then exit code is 0 (all links resolve)

Given the closeout PR description
When inspected by the reviewer
Then the three-checkbox path-drift checklist is present verbatim per FR-9

Given the reviewer evaluating the PR
When all three checkboxes are marked complete
Then the reviewer may approve
And if any checkbox cannot be marked, the reviewer requests changes (FR-10)

Given the worktree at HEAD on this branch
When `npm test` is run
Then pass count is exactly equal to the pre-spec baseline (TG-06; doc-only)
```

## Test Requirements

This spec is doc-only. Verification artifacts:

- **Row-count integrity check (FR-4 / FR-7):** the implementer runs
  the grep and CSV count comparisons before commit and pastes the
  numeric output in the PR description.
- **As-built path validity (FR-5):** the implementer runs a script
  (one-liner is fine) over the table:
  ```bash
  awk -F'|' '/^\| SPEC/ { gsub(/^ | $/, "", $3); print $3 }' \
    plugins/autonomous-dev/docs/specs/_path-drift-amendments.md \
    | xargs -I {} sh -c 'test -e "{}" || echo "MISSING: {}"'
  ```
  Output MUST be empty.
- **`lychee` link check.** Required.
- **No new test framework.** Doc-only (PRD-017 NG-04).
- **Reviewer spot-check.** PR review confirms the three checkboxes
  are marked.

## Implementation Notes

- The underscore prefix in `_path-drift-amendments.md` is intentional:
  it sorts to the top of `ls plugins/autonomous-dev/docs/specs/` and
  visually groups with other index/meta files. The convention is
  documented in this spec for future reference.
- The `Commit SHA` per-row column is awkward — every row in this PR
  has the same SHA. Two acceptable layouts:
  1. **Per-row SHA (preferred for forward-compat):** every row
     carries the SHA. Amend-after-commit fills it in.
  2. **Header SHA (simpler):** drop the per-row column; the file
     header has a single "Closeout commit: <SHA>" reference. Future
     additional amendments add new rows without per-row SHAs (the
     header gets a new entry).
  Pick one and document the choice in the closeout PR description.
- The summary file CONTAINS the literal text `<!-- moved-from:` in
  prose (e.g., "Each row corresponds to one `<!-- moved-from:
  <original> -->` HTML comment"). FR-4's grep MUST exclude this file
  (`grep -v _path-drift-amendments.md`) to keep the row-count
  invariant true. Alternatively, the prose uses backtick-escaped
  markup that does not match the grep regex; pick whichever keeps
  FR-4 self-consistent and document.
- The "Deferred to PRD-016" rows reference paths that don't exist
  yet (or exist under a still-drifted path that PRD-016 will sweep).
  The placeholder `_to be assigned by PRD-016_` is the canonical
  unknown-value sentinel.
- The summary file's underscore-prefixed name conflicts with the
  `_*.md` glob some markdown tooling treats as "include". Verify
  the file is rendered (not skipped) by the project's markdown
  preview tooling. If conflicts arise, fall back to `path-drift-
  amendments.md` (no underscore) and document the change in the
  closeout PR description.
- **Ship-with-SPEC-032-3-01:** PLAN-032-3 prescribes ONE commit
  `docs(specs): path-drift sweep + amendments summary (PLAN-032-3)`
  carrying SPEC-032-3-01's edits AND this spec's summary file. The
  two specs land together. SPEC-032-3-03 (lessons-learned) is a
  separate commit.
- The closeout PR description's checklist MUST appear under a clear
  heading (`### Path-drift verification (FR-1720 / OQ-05)`); reviewers
  check the section by name.

## Rollout Considerations

- **Doc-only.** No CI behavior change.
- **Future reads:** PRD-016's test-side sweep PR will modify this
  file (move rows from "Deferred to PRD-016" to a "Production-side
  amendments" continuation table). The file format must support
  that future edit cleanly.
- **Rollback:** revert the closeout commit. Both SPEC-032-3-01's
  edits and this summary file revert together.
- **Discoverability:** consider linking from `plugins/autonomous-dev/docs/specs/README.md`
  if one exists; otherwise the closeout PR description is the
  primary surface.

## Effort Estimate

- Authoring the summary file (header + two tables + cross-refs): 0.15 day
- Generation aid + verification (row-count check, link check): 0.05 day
- PR-description checklist coordination: 0.05 day
- Total: 0.25 day
