# SPEC-032-3-01: Spec Path-Drift Audit Script + Hand-Edits + Script Deletion

## Metadata
- **Parent Plan**: PLAN-032-3 (Spec Drift Sweep + Stub-Assertion Lessons)
- **Parent TDD**: TDD-032 §5.4 (WS-4)
- **Parent PRD**: PRD-017 (FR-1715, FR-1716, FR-1717, FR-1719, FR-1720)
- **Tasks Covered**: PLAN-032-3 Task 1 (audit script), Task 2 (hand-edit drifted spec rows), Task 5 (delete the script)
- **Estimated effort**: 1.35 days
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-032-3-01-spec-drift-audit-script-and-hand-edits.md`

## Summary
Author a single-use TypeScript audit script that walks every spec
under `plugins/autonomous-dev/docs/specs/**`, parses each spec's
"Files to Create/Modify" tables, classifies every listed path as
present-vs-missing, applies a heuristic remap for known refactors,
and emits a CSV. Then hand-edit every drifted spec on the
production-code side (test-side rows deferred to PRD-016 per
FR-1720): insert a `<!-- moved-from: <original> -->` HTML comment
above the row and replace the path with the as-built path. Delete
the audit script in the SAME commit as the doc edits (NG-02: no new
shippable tooling).

This spec ships path-and-comment edits across ~30+ spec files plus
ONE summary CSV (transient — deleted before commit). The audit
script lives in tree only inside the closeout commit's working tree
and is removed by the same commit.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `scripts/audit-spec-drift.ts` | Create then DELETE in same commit | Single-use audit aid; not shipped (NG-02) |
| `tmp/spec-drift-report.csv` | Create (transient) | Audit output; consumed by hand-edits; NOT committed |
| `plugins/autonomous-dev/docs/specs/**/*.md` | Modify (per CSV) | Path edits + `<!-- moved-from: -->` HTML comments only |

The closeout commit's `git diff` shows:
- Spec file path edits (one row per drifted production-side path).
- `<!-- moved-from: -->` HTML comments inserted above each amended
  row.
- The audit script appears NEITHER in the staged tree post-commit
  NOR in `git ls-files` (created and deleted within the same
  commit's working set).

## Functional Requirements

| ID | Requirement | Task |
|----|-------------|------|
| FR-1 | A new file `scripts/audit-spec-drift.ts` exists during the implementation session and implements the algorithm in TDD §5.4.1. | T1 |
| FR-2 | The script walks every `*.md` file under `plugins/autonomous-dev/docs/specs/**`. For each file, locate any heading matching the regex `/^##.*Files to (Create\|Modify)/i`. | T1 |
| FR-3 | For each matched heading, parse the markdown table that follows; extract the path column (the column whose values look like file paths). | T1 |
| FR-4 | For each extracted path, run `fs.existsSync(repoRoot + path)`. If absent, apply the heuristic remap from TDD §5.4.1 (e.g. `src/portal/...` → `plugins/autonomous-dev-portal/server/...`; extend in-script as the audit reveals new patterns). | T1 |
| FR-5 | Emit a CSV row to `tmp/spec-drift-report.csv` with columns: `spec_id`, `original_path`, `candidate_path`, `exists_after_remap`, `is_test_path`. The `is_test_path` is `true` iff the path matches `/(tests?\|__tests__\|spec)\//`. | T1 |
| FR-6 | The script is a FINDER, not an EDITOR. It MUST NOT modify any spec file. Auto-`sed` is rejected per TDD §7.2 / Tenet 2. | T1 |
| FR-7 | Running `npx ts-node scripts/audit-spec-drift.ts > tmp/spec-drift-report.csv` produces a CSV with one row per drifted path. Total CSV row count equals the count of paths in spec "Files to Create/Modify" tables that fail `fs.existsSync` at the original path. | T1 |
| FR-8 | For each CSV row where `is_test_path=false` AND `exists_after_remap=true`: open the spec, find the "Files to Create/Modify" row matching `original_path`, insert the comment `<!-- moved-from: <original_path> -->` on the line immediately above the row, and replace the path in the row with `candidate_path`. | T2 |
| FR-9 | Hand-edits MUST NOT modify any other content in the spec — no acceptance criteria, no requirements, no test plan, no metadata changes (FR-1717 / Tenet 2). | T2 |
| FR-10 | For each CSV row where `is_test_path=false` AND `exists_after_remap=false`: perform a manual `git log --diff-filter=A -- <original_path>` investigation to discover the rename. Record the resolution (or "not found") in a `notes` column appended to the CSV. | T2 |
| FR-11 | For each CSV row where `is_test_path=true`: NO edit is made to the spec in this PR (FR-1720 / PRD-016 owns test-side drift). The row is preserved in the CSV for SPEC-032-3-02 (summary table) to surface as deferred. | T2 |
| FR-12 | After hand-edits complete, `git ls-files scripts/audit-spec-drift.ts` MUST return zero output. The script is deleted in the same commit as the doc edits (T5). | T5 |
| FR-13 | After the closeout commit, `git diff HEAD~1 -- 'plugins/autonomous-dev/docs/specs/'` shows ONLY: (a) lines added with `<!-- moved-from: ... -->`, (b) lines changed where the path column changed. No other line types are added or removed inside spec files. | T2 |

## Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| Audit script runtime | < 30s on the full spec tree | `time npx ts-node scripts/audit-spec-drift.ts` |
| Audit precision | Spot-check 3 random rows: `original_path` actually does not exist; `candidate_path` (if non-empty) exists | Manual `fs.existsSync` per spot-check |
| Edit precision | Spot-check 3 random amended specs: `git diff` shows only path + comment changes | Manual `git diff` review |
| Test-side exclusion correctness | Zero amended rows have a path matching `/(tests?\|__tests__\|spec)\//` | `git diff <commit> | grep -E '\| .*(tests?|__tests__|spec)/' | wc -l` is 0 |
| Script non-shipment | `git ls-files scripts/audit-spec-drift.ts` returns no output post-commit | Direct `git ls-files` |
| Regression posture | `npm test` pass count is EXACTLY equal to baseline (no test changes; doc-only) | TG-06 |
| Atomic commit | The closeout commit (or commits) for this spec contains BOTH spec edits AND the script-creation+deletion within a single commit's diff | `git log --stat <commit>` shows the script as 0 lines net |

## Technical Approach

### Audit script (`scripts/audit-spec-drift.ts`)

```typescript
#!/usr/bin/env ts-node
/* eslint-disable no-console */
// Single-use audit aid for PLAN-032-3. DELETED IN THE SAME COMMIT.
// Per TDD-032 §5.4.1 / NG-02: this is not shippable tooling.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..');
const SPECS_DIR = join(REPO_ROOT, 'plugins/autonomous-dev/docs/specs');

interface DriftRow {
  spec_id: string;
  original_path: string;
  candidate_path: string;
  exists_after_remap: boolean;
  is_test_path: boolean;
}

function walkSpecs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkSpecs(full));
    } else if (entry.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function specIdFromFilename(file: string): string {
  // SPEC-032-3-01-spec-drift-audit-script-and-hand-edits.md
  // → SPEC-032-3-01
  const base = file.split('/').pop()!;
  const match = base.match(/^(SPEC-\d+-\d+(?:-\d+)?)/);
  return match ? match[1] : base.replace(/\.md$/, '');
}

function extractFileRows(body: string): string[] {
  // Locate `## ... Files to (Create|Modify) ...` heading; capture the
  // following markdown table rows. Returns the path-column cell from
  // each table row (skipping the header and the `|---|---|` separator).
  const rows: string[] = [];
  const headingRegex = /^##.*Files to (Create|Modify).*$/im;
  const sections = body.split(/(?=^## )/m);
  for (const section of sections) {
    if (!headingRegex.test(section)) continue;
    const lines = section.split('\n');
    let inTable = false;
    for (const line of lines) {
      if (/^\|.*\|.*\|/.test(line)) {
        if (!inTable) {
          inTable = true;
          continue; // header row
        }
        if (/^\|\s*-{3,}/.test(line)) continue; // separator
        const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
        if (cells.length === 0) continue;
        // The path is typically the FIRST cell. Detect by leading
        // backtick or a slash.
        const first = cells[0].replace(/^`|`$/g, '');
        if (first.includes('/') || first.endsWith('.ts') || first.endsWith('.md') || first.endsWith('.yml')) {
          rows.push(first);
        }
      } else if (inTable && line.trim() === '') {
        break; // table ends at first blank line after rows
      }
    }
  }
  return rows;
}

function applyHeuristicRemap(p: string): string {
  // Extend in-script as the audit reveals new patterns.
  if (p.startsWith('src/portal/')) {
    return p.replace(/^src\/portal\//, 'plugins/autonomous-dev-portal/server/');
  }
  if (p.startsWith('plugins/autonomous-dev/intake/')) {
    return p; // already canonical
  }
  if (p.startsWith('plugins/autonomous-dev/') && !p.startsWith('plugins/autonomous-dev/intake/')) {
    // Some early specs prefixed everything under plugins/autonomous-dev/.
    // Recheck the as-built location.
    const candidate = p.replace(
      /^plugins\/autonomous-dev\//,
      'plugins/autonomous-dev/intake/',
    );
    if (existsSync(join(REPO_ROOT, candidate))) return candidate;
  }
  return p;
}

function isTestPath(p: string): boolean {
  return /(?:^|\/)(?:tests?|__tests__|spec)\//.test(p);
}

function main() {
  const specs = walkSpecs(SPECS_DIR);
  const out: DriftRow[] = [];
  for (const file of specs) {
    const body = readFileSync(file, 'utf8');
    const paths = extractFileRows(body);
    for (const p of paths) {
      const abs = join(REPO_ROOT, p);
      if (existsSync(abs)) continue; // not drifted
      const candidate = applyHeuristicRemap(p);
      const candidateAbs = join(REPO_ROOT, candidate);
      out.push({
        spec_id: specIdFromFilename(file),
        original_path: p,
        candidate_path: candidate === p ? '' : candidate,
        exists_after_remap: candidate !== p && existsSync(candidateAbs),
        is_test_path: isTestPath(p),
      });
    }
  }
  // CSV emit
  console.log('spec_id,original_path,candidate_path,exists_after_remap,is_test_path');
  for (const r of out) {
    console.log(
      [r.spec_id, r.original_path, r.candidate_path, r.exists_after_remap, r.is_test_path]
        .map((v) => String(v))
        .join(','),
    );
  }
}

main();
```

The script is intentionally minimal. The implementer extends
`applyHeuristicRemap()` as the audit reveals new rename patterns;
each new pattern is one new conditional branch. The closeout PR
description enumerates the patterns added.

### Hand-edit procedure

For each non-test row in the CSV with `exists_after_remap=true`:

1. Open the spec file at `<spec_id>`-named path.
2. Locate the "Files to Create/Modify" table.
3. Find the row whose first cell contains `<original_path>`.
4. On the line ABOVE that row, insert:
   ```
   <!-- moved-from: <original_path> -->
   ```
5. In the row itself, replace the `original_path` cell content with
   `candidate_path`. Leave all other cells (Action, Notes) unchanged.
6. Save. Move to the next row.

For each non-test row with `exists_after_remap=false`:

1. Run `git log --diff-filter=A -- <original_path>` to discover any
   prior rename (if `git log --follow` reveals a rename, that target
   is the actual as-built path).
2. If a rename is discovered: amend the CSV row's `notes` column
   with the discovered path; treat it as `exists_after_remap=true`
   and proceed with steps 1-6 above.
3. If no rename is discovered: leave the spec unchanged. Add
   `notes=NOT_FOUND` to the CSV. SPEC-032-3-02's summary table
   surfaces these as "follow-up" rows.

For each test-side row (`is_test_path=true`):

1. Do NOT amend the spec. Leave the row unchanged.
2. The CSV preserves the row. SPEC-032-3-02's "Deferred to PRD-016"
   table picks it up.

### Script deletion

In the SAME commit as the spec edits:

```bash
git rm scripts/audit-spec-drift.ts
git status   # confirm the script appears as `deleted` and the spec
             # files appear as `modified`
git commit -m "docs(specs): path-drift sweep + amendments summary (PLAN-032-3)"
```

The commit message is prescribed by PLAN-032-3 Task 5. The
two-commit layout ("docs(specs)..." + "docs(lessons)...") in the
plan separates this spec's edits from SPEC-032-3-03's lessons-
learned commit. SPEC-032-3-02's summary-table edit ships in the
same `docs(specs)` commit as this spec.

## Interfaces and Dependencies

**Consumes:**
- `ts-node` (assumed already a dev dependency of the repo; the
  script is single-use, no need to add a runtime dep).
- `fs`, `path` from node stdlib.

**Produces:**
- `tmp/spec-drift-report.csv` (transient, consumed by SPEC-032-3-02).
- Path edits + HTML comments in spec files.

**Cross-references:**
- SPEC-032-3-02: consumes the CSV; ships `_path-drift-amendments.md`
  summary table.
- SPEC-032-3-03: independent (lessons-learned appendix).

## Acceptance Criteria

```
Given the worktree at the start of implementation
When `npx ts-node scripts/audit-spec-drift.ts > tmp/spec-drift-report.csv` runs
Then the CSV is produced
And every row has all five columns populated
And the row count equals the number of paths in spec "Files to Create/Modify" tables that fail fs.existsSync at the original path

Given the audit CSV
When 3 random rows are spot-checked
Then `original_path` does not exist on disk for each
And `candidate_path` (if non-empty) exists on disk for each

Given a CSV row with is_test_path=false and exists_after_remap=true
When the spec is amended
Then the row immediately above the "Files to Create/Modify" target row contains `<!-- moved-from: <original_path> -->`
And the target row's path cell is replaced with `candidate_path`
And no other content in the spec is modified

Given a CSV row with is_test_path=false and exists_after_remap=false
When the implementer investigates via `git log --diff-filter=A`
Then either: (a) a rename target is discovered and the row is amended per the prior rule, OR (b) the row is recorded with `notes=NOT_FOUND` and the spec is left unchanged

Given a CSV row with is_test_path=true
When the implementer processes it
Then NO edit is made to the spec
And the row is preserved in the CSV for SPEC-032-3-02

Given the closeout commit
When `git diff HEAD~1 -- 'plugins/autonomous-dev/docs/specs/'` is inspected
Then every added line is either an `<!-- moved-from: ... -->` comment or a path-column edit inside a "Files to Create/Modify" table
And no acceptance criteria, requirement, NFR, or test-plan content has been modified

Given the closeout commit
When `git ls-files scripts/audit-spec-drift.ts` runs
Then no output is produced (the script is not in the working tree at HEAD)

Given the closeout commit
When `git log --stat HEAD` is inspected
Then `scripts/audit-spec-drift.ts` is NOT listed (because it was created and deleted within the same commit's diff and the file's net delta is zero)

Given the worktree at HEAD on this branch
When `npm test` is run
Then pass count is EXACTLY EQUAL to the pre-spec baseline (TG-06; doc-only spec)
```

## Test Requirements

- **Audit-script spot-check (NFR row "Audit precision"):** spot-check
  3 random CSV rows by manually `fs.existsSync`-ing both
  `original_path` and `candidate_path`. Document outcomes in PR
  description.
- **Edit-precision spot-check:** spot-check 3 random amended specs
  via `git diff <spec-file>`. Confirm only path + comment lines
  changed. Document outcomes in PR description.
- **Test-side exclusion check:** run
  `git diff <commit> | grep -E '<!-- moved-from:.*(tests?|__tests__|spec)/'`
  and confirm zero matches.
- **Script-deletion check:** `git ls-files scripts/audit-spec-drift.ts`
  returns no output. `git log --stat HEAD` does NOT list the script.
- **No new test framework:** consistent with PRD-017 NG-04. The
  audit script's correctness is verified by spot-check, not by an
  automated test.
- **Regression posture (TG-06):** `npm test` pass count exactly
  equals baseline.

## Implementation Notes

- The script's table parser (`extractFileRows`) is HEURISTIC. It
  detects `Files to Create/Modify` headings and tables that follow.
  Some specs may use slightly different heading text ("Files
  Created", "Files Modified") — extend the regex as the audit
  reveals these. Document each variation in the script's header
  comment.
- The path-column detection assumes the path is in the FIRST cell
  of each row. Some specs may put the path in a different column;
  inspect the CSV for rows where `original_path` looks like a
  description rather than a path, and re-run with adjusted column
  detection.
- The heuristic remap rules in `applyHeuristicRemap()` are seeded
  with TDD §5.4.1's known examples. Add new rules as the audit
  reveals patterns. Each new rule is one branch; do not factor into
  a config file (the script is single-use).
- The script does NOT auto-edit specs. Auto-`sed` is rejected per
  Tenet 2 (TDD §7.2 Alt-2). The human reads the CSV row-by-row
  and edits each spec by hand. ~30+ rows is tractable in 0.75 day.
- Spec files may have multiple "Files to Create/Modify" tables (some
  long specs split across sections). The parser handles ALL such
  tables by splitting on `## ` headings and re-checking each
  section.
- `<!-- moved-from: ... -->` is HTML, valid markdown, and visible in
  rendered output as a comment (not visible to readers). This is
  intentional: the marker is for git-grep traceability, not for
  reader consumption. SPEC-032-3-02's summary table is the
  reader-visible artifact.
- **Commit layout:** PLAN-032-3 prescribes one commit
  `docs(specs): path-drift sweep + amendments summary (PLAN-032-3)`
  for THIS spec + SPEC-032-3-02 (summary table). SPEC-032-3-03
  (lessons-learned) is a separate commit. Per FR-1719 the spec-drift
  sweep is its own commit regardless of PR layout.
- **Test-side rows in the CSV** are NOT deleted; SPEC-032-3-02's
  summary table needs them for the "Deferred to PRD-016" section.
  Keep the CSV in `tmp/` until SPEC-032-3-02's edits land, then
  delete before commit.
- The script's CSV has NO `notes` column at emit time. The hand-edit
  step appends `notes` for `exists_after_remap=false` rows. Because
  CSV emit is to stdout, the implementer redirects to a file then
  edits the file in `$EDITOR` to add the column. Alternatively,
  output a sixth column `notes` with empty string at emit time and
  fill in during hand-edit.

## Rollout Considerations

- **Doc-only.** Zero runtime impact. No CI behavior change.
- **Merge order:** TDD-032 §1 D1 recommends merging this plan
  (PLAN-032-3) BEFORE PRD-016's test-side sweep to minimize spec-file
  merge conflicts. The closeout PR description documents this
  recommendation.
- **Rollback:** revert the closeout commit. Spec files revert to
  their drifted paths. The audit script does not need to be
  re-deleted (it was never in HEAD).
- **Forward-compat:** future spec authors add new "Files to
  Create/Modify" rows that may also drift. The lint-style enforcement
  is OUT OF SCOPE for this PR (PRD-017 NG-04 / TDD §7.2 Alt-1
  rejects a spec-path linter). A follow-up PRD may revisit.

## Effort Estimate

- Audit script + run + spot-check: 0.5 day
- Hand-edits across ~30+ specs: 0.75 day
- Script deletion + commit ceremony: 0.1 day
- Total: 1.35 days
