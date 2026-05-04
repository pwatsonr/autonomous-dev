# SPEC-032-2-01: Cloud Action Pin Audit and SHA Resolution

## Metadata
- **Parent Plan**: PLAN-032-2 (SHA Pinning + observe.yml.example + lint guard)
- **Parent TDD**: TDD-032 §5.2 (WS-2)
- **Parent PRD**: PRD-017 (FR-1706, FR-1707, FR-1708)
- **Tasks Covered**: PLAN-032-2 Task 1 (inventory), Task 2 (resolve + pin)
- **Estimated effort**: 1 day
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-032-2-01-action-pin-audit-and-resolution.md`

## Summary
Audit every `uses:` reference under the four cloud-deploy plugins and
the root `.github/workflows/release.yml`, classify each as TBD literal
/ floating tag / already SHA-pinned, then resolve every TBD or
floating-tag reference to a 40-char SHA via `gh api` and replace in
place with a refreshed comment in the form
`# {action-name}@v{semver} (pinned 2026-05-02)`.

This spec ships only edits to existing YAML files. No new files. The
companion lint guard (SPEC-032-2-02) ships in the same PR so the
guard's contract is testable against the just-pinned tree.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-deploy-aws/**/*.yml` | Modify | Replace `TBD-replace-with-pinned-SHA` and floating tags |
| `plugins/autonomous-dev-deploy-gcp/**/*.yml` | Modify | Same |
| `plugins/autonomous-dev-deploy-azure/**/*.yml` | Modify | Same |
| `plugins/autonomous-dev-deploy-k8s/**/*.yml` | Modify | Same |
| `.github/workflows/release.yml` | Modify | Same |
| `tmp/plan-032-2-pin-audit.csv` | Create (audit aid; NOT committed) | One row per `uses:` reference |

The CSV is generated locally and consumed by the implementer; deleted
before commit (PRD-017 NG-02; TDD-032 OQ-03).

## Functional Requirements

| ID | Requirement | Task |
|----|-------------|------|
| FR-1 | Run `git grep -nE 'TBD-replace-with-pinned-SHA\|uses: [a-z0-9-]+/[a-z0-9-]+@v[0-9]+(\.[0-9]+){0,2}$' -- 'plugins/autonomous-dev-deploy-*' '.github/workflows/release.yml'`, then enrich with rows for already-SHA-pinned references. | T1 |
| FR-2 | Build `tmp/plan-032-2-pin-audit.csv` with columns `file,line,action,current_ref,target_action_version_comment,kind` where `kind ∈ {TBD,floating-tag,already-sha-pinned}`. | T1 |
| FR-3 | Total CSV row count MUST match the count of `uses:` references in the affected files (`grep -c '^\s*-\?\s*uses:'`). | T1 |
| FR-4 | For each row with `kind=TBD`: read the accompanying `# {action}@v{semver}` comment (SPEC-024-1 deviation guarantees one exists) and resolve it via `gh api repos/{org}/{action}/git/ref/tags/v{semver}`. | T2 |
| FR-5 | For each row with `kind=floating-tag`: take the `@vX.Y.Z` literal as the version and resolve via `gh api`. | T2 |
| FR-6 | For each resolved SHA: verify reachability on upstream `main` via `gh api repos/{org}/{action}/commits/{sha}` (returns HTTP 200 with non-error body). | T2 |
| FR-7 | If verification fails (tag re-pointed upstream / 404 / other): the row MUST be recorded in the runbook's "Known unpinnable upstream" appendix (SPEC-032-2-04 owns the runbook) AND the closeout PR description MUST list the deferral. The line is left as-is. | T2 |
| FR-8 | For each verified SHA: edit the YAML file in place to replace the ref with the 40-char SHA, AND replace/insert the comment as `# {action-name}@v{semver} (pinned 2026-05-02)`. | T2 |
| FR-9 | After all edits, `git grep 'TBD-replace-with-pinned-SHA' -- 'plugins/autonomous-dev-deploy-*' '.github/workflows/release.yml'` MUST return zero matches (AC-02). | T2 |
| FR-10 | After all edits, `git grep -nE 'uses: [a-z0-9-]+/[a-z0-9-]+@v[0-9]+' -- 'plugins/autonomous-dev-deploy-*' '.github/workflows/release.yml'` MUST return zero matches (no remaining floating-tag references in scope). | T2 |
| FR-11 | Every modified line MUST have a comment matching `^\s*#\s+[a-z0-9-]+/?[a-z0-9-]+@v[0-9.]+\s+\(pinned\s+\d{4}-\d{2}-\d{2}\)$` either above the `uses:` line or trailing it (consistent with project convention; pick one and apply uniformly). | T2 |

## Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| Cleanliness of TBD literal | Zero matches in scope after edits | `git grep` per FR-9 |
| Cleanliness of floating tags | Zero matches in scope after edits | `git grep` per FR-10 |
| YAML validity | `actionlint` exit 0 on every modified file | `actionlint <file>` per file |
| Comment format consistency | 100% of pinned lines match the comment regex | `git grep -E '^\s*uses: [a-z0-9-]+/[a-z0-9-]+@[a-f0-9]{40}'` count == number of comment lines matching the regex |
| Audit traceability | CSV rows exist for every reference at audit time | Row count assertion (FR-3) |
| Tag-replay defense | Every pinned SHA passes the upstream-main reachability check | Implementer documents `gh api repos/.../commits/{sha}` HTTP 200 in PR description |

## Technical Approach

### Inventory step

```bash
# Step A: TBD literals
git grep -nF 'TBD-replace-with-pinned-SHA' \
  -- 'plugins/autonomous-dev-deploy-*' '.github/workflows/release.yml' \
  > /tmp/tbd-rows.txt

# Step B: floating tags
git grep -nE 'uses: [a-z0-9-]+/[a-z0-9-]+@v[0-9]+(\.[0-9]+){0,2}$' \
  -- 'plugins/autonomous-dev-deploy-*' '.github/workflows/release.yml' \
  > /tmp/floating-rows.txt

# Step C: already-pinned references (for traceability)
git grep -nE 'uses: [a-z0-9-]+/[a-z0-9-]+@[a-f0-9]{40}' \
  -- 'plugins/autonomous-dev-deploy-*' '.github/workflows/release.yml' \
  > /tmp/pinned-rows.txt

# Step D: assemble CSV (manually or via awk)
#   Columns: file,line,action,current_ref,target_action_version_comment,kind
#   target_action_version_comment is read from the line above (or trailing)
#   the `uses:` line; YAML files in this repo follow SPEC-024-1 which
#   requires the version comment for TBD lines.
```

### Resolution step

For each row with `kind ∈ {TBD,floating-tag}`:

```bash
# action e.g. "actions/checkout", semver e.g. "4.1.7"
SHA=$(gh api "repos/${ORG}/${ACTION}/git/ref/tags/v${SEMVER}" \
       --jq '.object.sha')

# tag-replay defense: the SHA must be reachable on upstream main
gh api "repos/${ORG}/${ACTION}/commits/${SHA}" --jq '.sha' \
  || { echo "DEFER: ${ORG}/${ACTION}@v${SEMVER} not reachable"; continue; }

# In-place edit (manual; no sed -i across the tree)
#   Open the file in $EDITOR, replace the @ref with @${SHA}
#   Update or insert the comment: # ${ACTION}@v${SEMVER} (pinned 2026-05-02)
```

The in-place edit is **manual per occurrence** (TDD §5.2.1). Reasoning:
batch `sed -i` is brittle across YAML quoting variations; manual
editing keeps the diff reviewable and matches Tenet 2 (doc-and-config
edits are line-by-line reviewed).

### Comment placement convention

Pick the convention already used in the affected files. If the
existing comments live above the `uses:` line, place new comments
above. If trailing, trail. Document the choice in Implementation
Notes; uniformity across the diff is the FR-11 success criterion.

### Pinned-date string

Use `2026-05-02` for every pin landed in this PR. Future pin
refreshes update the date per the runbook (SPEC-032-2-04).

## Interfaces and Dependencies

**Consumes:**
- `gh` CLI (assumed available; matches PRD-017 §6 tooling).
- `actionlint` (already in CI per PLAN-016-2; SPEC-032-2-02 confirms
  local-dev availability).

**Produces:**
- A clean tree where the regression guard (SPEC-032-2-02) can run
  with no false positives.
- Audit traceability via the (deleted-before-commit) CSV.

**Cross-references:**
- The `.example` workflow file (SPEC-032-2-03) inherits the same pin
  set for its third-party `uses:` references.
- The runbook (SPEC-032-2-04) documents the resolution procedure.

## Acceptance Criteria

```
Given the worktree before any edits
When the FR-1 grep is run
Then tmp/plan-032-2-pin-audit.csv is produced
And every CSV row's kind column is populated
And the row count equals `grep -c "^\s*-\?\s*uses:"` across the in-scope files

Given a TBD-literal row
When `gh api repos/{org}/{action}/git/ref/tags/v{semver}` is invoked
Then a 40-char hex SHA is returned

Given a resolved SHA from the prior step
When `gh api repos/{org}/{action}/commits/{sha}` is invoked
Then HTTP 200 is returned with a non-error body

Given a SHA that fails the reachability check
When the implementer processes the row
Then the line is left unchanged
And the row is logged for inclusion in the runbook's "Known unpinnable upstream" appendix
And the closeout PR description enumerates the deferral

Given a verified SHA
When the YAML file is edited
Then the @ref is replaced with the 40-char SHA
And a comment in the form `# {action}@v{semver} (pinned 2026-05-02)` accompanies the line

Given the worktree after all edits
When `git grep 'TBD-replace-with-pinned-SHA' -- 'plugins/autonomous-dev-deploy-*' '.github/workflows/release.yml'` runs
Then zero matches are returned (AC-02 / FR-9)

Given the worktree after all edits
When `git grep -nE 'uses: [a-z0-9-]+/[a-z0-9-]+@v[0-9]+' -- 'plugins/autonomous-dev-deploy-*' '.github/workflows/release.yml'` runs
Then zero matches are returned (FR-10)

Given each modified file
When `actionlint <file>` runs
Then exit code is 0 with no warnings

Given the comment format regex from FR-11
When applied to every modified `uses:` line
Then 100% of pinned lines have a matching comment

Given the worktree at HEAD on this branch
When the audit CSV is sought
Then `tmp/plan-032-2-pin-audit.csv` is NOT present (audit aid only; not shipped)
```

## Test Requirements

This spec is YAML-edit only. The verification is via `git grep`
assertions and `actionlint`. The companion lint-guard regression
test (SPEC-032-2-02) ships the only automated test for this
workstream. Manual verification artifacts:

- The audit CSV (transient, deleted before commit).
- The PR description's listing of resolved SHAs and any deferrals.
- The PR description's evidence of `actionlint` clean output for two
  randomly chosen modified files.
- Repeat the FR-6 reachability check for two randomly chosen pinned
  SHAs at PR-review time as a manual spot check.

## Implementation Notes

- The CSV is your work-list. Generate, edit per row, verify, then
  delete before `git add`. Add to `.gitignore` if helpful.
- `gh api` requires authentication. The implementer must have a
  `gh auth status` of OK; document any auth setup needed.
- For monorepo-style actions (e.g. `actions/cache/save`), the
  `repos/{org}/{action}/git/ref/tags/v{semver}` call may 404 — try
  `repos/{org}/cache/git/ref/tags/v{semver}` instead. The 'action'
  in `org/action/sub-path@ref` is the repo, not the sub-path.
- Some referenced actions (`marocchino/sticky-pull-request-comment`)
  are also referenced from `observe.yml.example` (SPEC-032-2-03).
  Keep the SHA consistent across both.
- Per OQ-04: if a referenced action's tag is re-pointed upstream,
  ship the closeout PR with that one pin deferred. Do not block.
- Date format `2026-05-02` is ISO-8601 calendar date; matches the
  TDD's "Date" header convention. Future refreshes update this date.
- The lint guard (SPEC-032-2-02) is a CI-side defense against
  re-introduction. Floating-tag re-introductions are NOT caught by
  the guard — humans catch those at PR review. Document this gap in
  the runbook.

## Rollout Considerations

- The pinning is **immediate** at merge. There is no feature flag.
  An incorrect SHA causes the workflow run to fail with an action
  not-found error — visible in CI logs.
- Rollback: revert this commit. Companion lint guard (SPEC-032-2-02)
  must revert in the same revert (paired per TDD §4 / WS-6).
- This spec touches `release.yml`, which is branch-protected.
  Implementer must have permission to merge changes to that file or
  enlist a reviewer who does.

## Effort Estimate

- Audit: 0.25 day (CSV build, scope verification)
- Resolution + edits: 0.5 day (per-occurrence `gh api` calls + manual edits)
- Verification: 0.25 day (`actionlint`, grep assertions, PR description)
- Total: 1 day
