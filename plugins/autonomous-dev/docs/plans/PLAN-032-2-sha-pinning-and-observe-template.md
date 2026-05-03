# PLAN-032-2: Cloud SHA Pinning + Lint Guard + observe.yml.example

## Metadata
- **Parent TDD**: TDD-032-cleanup-and-operational-closeout (§5.2, §5.3, §5.6, WS-2 + WS-3 + WS-6)
- **Parent PRD**: PRD-017 (FR-1706..FR-1714)
- **Estimated effort**: 2 days
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P0
- **Closes FRs**: FR-1706, FR-1707, FR-1708, FR-1709, FR-1710, FR-1711, FR-1712, FR-1713, FR-1714

## Objective
Close the supply-chain hygiene loop and ship the missing observe
template in a single coherent commit set:
1. Audit and resolve every `TBD-replace-with-pinned-SHA` literal
   across the four cloud-deploy plugins and `.github/workflows/release.yml`,
   verifying each pin against the upstream tag-to-SHA mapping.
2. Verify every other third-party action reference in the deploy
   plugins and `release.yml` is pinned by 40-char SHA (not by
   floating tag), since the audit log shows several `@v4`-style
   references that should already be SHA-pinned per SPEC-024-1.
3. Add an `npm run lint:no-tbd-shas` script and wire it into CI as
   the regression guard (WS-6, paired with WS-2 per TDD §4 so the
   guard reverts together with the pin if either rolls back).
4. Ship the missing
   `plugins/autonomous-dev/.github/workflows/observe.yml.example`
   template with `if: false` default, `actionlint`-clean YAML, and
   a cross-reference to `commands/observe.md`.
5. Author the "How to refresh pins" runbook and a doc-only test that
   prevents `observe.yml.example` regression.

## Scope

### In Scope
- Per-occurrence audit of `TBD-replace-with-pinned-SHA` across:
  - `plugins/autonomous-dev-deploy-aws/**`
  - `plugins/autonomous-dev-deploy-gcp/**`
  - `plugins/autonomous-dev-deploy-azure/**`
  - `plugins/autonomous-dev-deploy-k8s/**`
  - `.github/workflows/release.yml`
- For each occurrence: resolve the version comment to a SHA via
  `gh api repos/{org}/{action}/git/ref/tags/v{semver}`, verify
  upstream-`main` reachability, and replace with the 40-char SHA
  plus a refreshed comment in the form
  `# {action-name}@v{semver} (pinned 2026-05-02)`.
- Audit (and re-pin if needed) every other third-party action
  already referenced by `@v…` floating tag in the same files. This
  is *not* a version bump — it pins the version that is already in
  use (PRD-017 NG-05, TDD-032 Tenet 4).
- New `lint:no-tbd-shas` script in `package.json` `scripts:` field
  that runs the `git grep` guard from TDD §5.2.3. Wire it into the
  existing `ci.yml` `lint` job as one new `run:` step.
- Ship `plugins/autonomous-dev/.github/workflows/observe.yml.example`
  with the content from TDD §5.3.2 (header comments, `if: false`
  default, weekly `cron`, `workflow_dispatch`, sticky-comment closer
  pinned by SHA).
- Cross-reference the example from `commands/observe.md` (one new
  paragraph + relative link).
- Doc-only test in the existing `test:docs` (or equivalent) suite:
  - `expect(fs.existsSync('plugins/autonomous-dev/.github/workflows/observe.yml.example')).toBe(true)`
  - `actionlint <path>` exits 0.
- Add `actionlint` to devDependencies if not already present
  (resolves OQ-06).
- Author the "How to refresh action pins" runbook at
  `plugins/autonomous-dev/docs/runbooks/refresh-action-pins.md`
  documenting the per-occurrence procedure plus a quarterly cadence
  reminder (FR-1710).

### Out of Scope
- Bumping any third-party action to a newer version (PRD-017 NG-05;
  TDD-032 Tenet 4 — pin to what is already running).
- Configuring Dependabot for action SHAs (TDD §7.3 Alt-3 rejected
  for this PR).
- Pinning third-party action SHAs in any vendored backend that ships
  outside this repo's deploy plugins (PRD-017 NG-06).
- Changing `observe.md`'s runbook semantics — only adds the
  workflow cross-reference paragraph.
- Operator-side adoption of `observe.yml` itself; the file ships as
  `.example` and the autonomous-dev CI never invokes it.
- Test-side path drift sweep (PLAN-032-3 owns it).

## Tasks

1. **Inventory TBD literals + floating tags.** Run:
   ```
   git grep -nE 'TBD-replace-with-pinned-SHA|uses: [a-z0-9-]+/[a-z0-9-]+@v[0-9]+(\.[0-9]+){0,2}$' \
     -- 'plugins/autonomous-dev-deploy-*' '.github/workflows/release.yml'
   ```
   Build a CSV (`tmp/plan-032-2-pin-audit.csv`, deleted before
   commit) with columns: `file`, `line`, `action`, `current_ref`,
   `target_action_version_comment`, `kind` (TBD | floating-tag |
   already-sha-pinned).
   - Files to create: none shipped (audit aid only).
   - Acceptance criteria: CSV covers every `uses:` reference under
     the four plugin dirs and `release.yml`. Every row's `kind`
     column is populated. Total row count matches `grep -c uses:`
     across the affected files.
   - Estimated effort: 0.5 day

2. **Resolve and pin SHAs.** For every CSV row with `kind` in `{TBD,
   floating-tag}`:
   - Read the accompanying version comment (SPEC-024-1 deviation
     guarantees one exists for TBD rows; floating-tag rows take
     their `@vX.Y.Z` literal as the version).
   - Run `gh api repos/{org}/{action}/git/ref/tags/v{semver}` and
     extract the SHA.
   - Verify the SHA is reachable on upstream `main` via
     `gh api repos/{org}/{action}/commits/{sha}` (defense against
     tag-replay).
   - If verification fails (tag re-pointed upstream), record the
     row in the runbook's "Known unpinnable upstream" appendix and
     skip the pin. Per OQ-04, the closeout PR may ship without that
     one pin and files an upstream issue.
   - Otherwise edit the file: replace the ref with the 40-char SHA;
     update the comment to `# {action-name}@v{semver} (pinned 2026-05-02)`.
   - Files to modify: every file listed in task 1's CSV.
   - Acceptance criteria:
     `git grep 'TBD-replace-with-pinned-SHA' -- 'plugins/autonomous-dev-deploy-*' '.github/workflows/release.yml'`
     returns zero matches (AC-02). Every previously floating-tag
     reference now uses a 40-char SHA. Each pinned line has a
     comment matching `^\s*#\s+[a-z0-9-]+/?[a-z0-9-]+@v[0-9.]+\s+\(pinned\s+\d{4}-\d{2}-\d{2}\)$`.
   - Estimated effort: 0.5 day

3. **Author `lint:no-tbd-shas` script.** Add a new `scripts/lint/no-tbd-shas.sh`
   shell script (or a `package.json` inline `scripts:` entry — pick
   the option already used by sibling lint scripts, see
   PLAN-016-2 for the precedent) implementing:
   ```
   if git grep -nE 'TBD-replace-with-pinned-SHA' \
        -- 'plugins/autonomous-dev-deploy-*' '.github/workflows/release.yml'; then
     echo "ERROR: TBD-replace-with-pinned-SHA reintroduced"; exit 1
   fi
   exit 0
   ```
   Wire it into `package.json` `scripts.lint:no-tbd-shas`.
   - Files to create: `scripts/lint/no-tbd-shas.sh` (if scripted out).
   - Files to modify: `package.json`.
   - Acceptance criteria: `npm run lint:no-tbd-shas` exits 0 on a
     clean tree, exits 1 (with the clear ERROR message naming file
     + line) on a tree where the literal is reintroduced. Unit-test
     this round-trip: synthesize a tempfile under
     `plugins/autonomous-dev-deploy-aws/.lint-test.yml` containing
     the literal, run the script, assert exit 1, remove the file,
     re-run, assert exit 0 (TDD §10.1 WS-2 contract).
   - Estimated effort: 0.25 day

4. **Wire the lint guard into CI.** In `.github/workflows/ci.yml`,
   add one `run: npm run lint:no-tbd-shas` step inside the existing
   `lint` job (do not create a new job — TDD §5.2.3 mandates "no
   new workflow file; no new tooling"). The step runs unconditionally
   (no `if:` gating) so any path-filter regression still trips the
   guard.
   - Files to modify: `.github/workflows/ci.yml`.
   - Acceptance criteria: `actionlint .github/workflows/ci.yml`
     passes. The new step appears in the `lint` job's steps array
     after existing lint steps. PR introducing the literal fails
     the `lint` status check with an annotation pointing to the
     offending file:line.
   - Estimated effort: 0.25 day

5. **Verify `actionlint` is a devDependency.** Inspect
   `package.json` and the existing `lint` job. If `actionlint` is
   not currently invoked from `npm run` or as an action in CI, add
   the appropriate setup (e.g., `npm install --save-dev actionlint`
   or pin the `rhysd/actionlint@<sha>` action). Resolves OQ-06.
   - Files to modify: `package.json` (if needed); `.github/workflows/ci.yml` (if a new setup step is needed).
   - Acceptance criteria: `actionlint <yml-file>` is invokable from
     both local dev (`npx actionlint`) and CI. Existing
     `actionlint` job from PLAN-016-2 still runs unchanged.
   - Estimated effort: 0.25 day

6. **Ship `observe.yml.example`.** Author the file at
   `plugins/autonomous-dev/.github/workflows/observe.yml.example`
   with the exact body from TDD §5.3.2:
   - Header comments: opt-in, copy-target instructions, required
     secrets (`AUTONOMOUS_DEV_OBSERVE_TOKEN`), required inputs,
     pointer to `commands/observe.md`.
   - `name: Observe (autonomous-dev digest)`.
   - Trigger: `schedule: cron '0 14 * * 1'` (Mondays 14:00 UTC,
     documented as customizable) plus `workflow_dispatch`.
   - `permissions: contents: read, pull-requests: write, issues: write`.
   - One `digest` job on `ubuntu-latest` with `if: false` default
     (Risk R5 mitigation: prevents unconfigured runs).
   - Steps: `actions/checkout@<sha>` (pinned in task 2),
     `npx @autonomous-dev/observe digest --window 7d` with the
     observe-token env var, `marocchino/sticky-pull-request-comment@<sha>`
     posting `observe-digest.md` with header
     `autonomous-dev-observe`.
   - Files to create: `plugins/autonomous-dev/.github/workflows/observe.yml.example`.
   - Acceptance criteria: `actionlint` exits 0. File ends with a
     trailing newline. All third-party `uses:` references are
     SHA-pinned with the same comment format as task 2. The
     `if: false` line is present on the `digest` job; flipping it
     to `if: true` makes the workflow runnable in a downstream
     repo.
   - Estimated effort: 0.5 day

7. **Cross-reference observe.md.** Add a short section
   `## Workflow template` (or equivalent) to
   `plugins/autonomous-dev/commands/observe.md` linking to the new
   `.example` file and explaining the copy-and-customize flow.
   Match the prose conventions used elsewhere in `commands/`.
   - Files to modify: `plugins/autonomous-dev/commands/observe.md`.
   - Acceptance criteria: New section exists, ≤120 words, links via
     a relative path to the example file, names the required secret
     `AUTONOMOUS_DEV_OBSERVE_TOKEN`, references "opt-in" and
     "if: false default". `lychee` link-check (PLAN-016-2) passes.
   - Estimated effort: 0.25 day

8. **Doc-only test for observe template.** Add a test in the
   existing `test:docs` suite (or wherever
   `plugins/autonomous-dev/tests/docs/**` lives — discover during
   implementation). The test:
   - Asserts `fs.existsSync('plugins/autonomous-dev/.github/workflows/observe.yml.example')`.
   - Spawns `actionlint <path>` and asserts exit code 0 (skip the
     test with a clear message if `actionlint` is not on `$PATH` —
     the CI matrix installs it via task 5).
   - Greps the file for `if: false` and the
     `AUTONOMOUS_DEV_OBSERVE_TOKEN` secret reference; asserts both
     present.
   - Greps `commands/observe.md` for the relative link to the
     example; asserts present.
   - Files to create: `plugins/autonomous-dev/tests/docs/test-observe-yml-example.test.ts`
     (or co-locate per existing convention).
   - Acceptance criteria: Test passes. Deleting either the example
     file or the cross-reference makes the test fail with a clear
     message (closes FR-1714).
   - Estimated effort: 0.25 day

9. **Author the refresh-pins runbook (FR-1710).** Create
   `plugins/autonomous-dev/docs/runbooks/refresh-action-pins.md`.
   Sections:
   - **Purpose.** Why pins exist (supply-chain integrity); pointer
     to TDD-032 §5.2.
   - **Cadence.** Quarterly review; trigger on upstream CVE.
   - **Per-occurrence procedure.** The four-step `gh api` flow
     from task 2 (read ref, resolve SHA, verify upstream-main
     reachability, edit file + comment).
   - **Lint guard.** How `npm run lint:no-tbd-shas` enforces
     non-regression.
   - **Known unpinnable upstreams.** Empty subsection seeded for
     task 2's runbook entries; reviewers append rows here as
     upstream tag-replay incidents are discovered.
   - **Cross-reference.** Pointer to PRD-017 FR-1710 and TDD-032
     §5.2.
   - Files to create: `plugins/autonomous-dev/docs/runbooks/refresh-action-pins.md`.
   - Acceptance criteria: File exists. `lychee` link-check passes.
     Runbook procedure is reproducible by a contributor with only
     the doc plus `gh` CLI access.
   - Estimated effort: 0.25 day

## Dependencies & Integration Points

**Exposes to other plans:**
- `lint:no-tbd-shas` script as the regression guard for any future
  closeout-style PR that pins SHAs.
- The refresh-pins runbook as the canonical source for action-SHA
  hygiene; future deploy-plugin authors copy this procedure.
- `observe.yml.example` as the copy-target referenced by AMENDMENT-002's
  setup-wizard onboarding flow.

**Consumes from other plans:**
- PLAN-016-2's `actionlint` integration (already in CI). This plan
  reuses the existing `actionlint` job to validate the new example
  file via the doc-only test in task 8.
- PLAN-017-3 (`release.yml`'s changelog generation) is the largest
  single consumer of pinned SHAs in `release.yml`; this plan
  preserves the version pinned at SPEC-024-1 time.

## Testing Strategy

- **Lint-guard round-trip (task 3 acceptance):** synthesize a
  tempfile containing the literal, run the script, assert exit 1.
  Remove, re-run, assert exit 0.
- **CI integration (task 4):** PR introducing the literal must fail
  the `lint` status check; PR removing it must pass.
- **Doc-only test (task 8, FR-1714):** missing example file or
  missing cross-reference fails the suite.
- **`actionlint` validation:** every workflow file modified by
  task 2 and the new example file pass `actionlint` (no warnings).
- **Manual verification:** for two random pinned SHAs from task 2,
  re-run the upstream-main reachability check; confirm the SHA is
  still reachable.
- **Regression posture (TG-06):** `npm test` pass count strictly
  non-decreasing.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| An upstream action has re-tagged a semver upstream so the SHA we resolve is not what shipped at SPEC-024-1 time. | Medium | Medium | Task 2's `commits/{sha}` reachability check on upstream `main` defends against tag-replay. If reachability fails, the runbook records the action under "Known unpinnable" and the closeout PR ships without that one pin (per OQ-04). |
| `marocchino/sticky-pull-request-comment` (used in `observe.yml.example`) does not have a stable SHA at the version comment we record. | Low | Low | The example is opt-in; consumers re-pin when they adopt. Task 6's pinning still happens to harden the example, but a stale pin in an opt-in template is acceptable. |
| The `lint:no-tbd-shas` script triggers on the literal appearing in this PRD's own docs (PRD-017 + TDD-032 mention the literal frequently). | High | Low | The grep is path-scoped to `plugins/autonomous-dev-deploy-*` and `.github/workflows/release.yml` only. PRDs and TDDs live under `plugins/autonomous-dev/docs/**` — outside the scope. Task 3's acceptance criteria includes a positive test that the docs pass through cleanly. |
| Operators copy `observe.yml.example` to `observe.yml` and forget to flip `if: false` to `if: true`. | Medium | Low | This is the *desired* default per Risk R5 — an unconfigured workflow does not run. Task 6's header comments call out the toggle; AMENDMENT-002's wizard handles the toggle when the operator opts in. |
| `actionlint` is not actually a devDependency (OQ-06), and adding it conflicts with PLAN-016-2's existing `rhysd/actionlint@v1` action. | Low | Low | Task 5 verifies first; if PLAN-016-2 already provides the action in CI, task 5's "add to devDependencies" is a no-op for CI but adds local-dev support. The doc-only test in task 8 skips gracefully if `actionlint` is not on `$PATH`. |
| The `release.yml` audit reveals an action used only by branch-protected releases that cannot be re-pinned without a manual release dry-run. | Low | Medium | Task 2 ships every safe pin and records any deferred pin in the runbook. The closeout PR description enumerates deferrals so the reviewer can decide to merge partial coverage or block. |

## Definition of Done

- [ ] `git grep 'TBD-replace-with-pinned-SHA' -- 'plugins/autonomous-dev-deploy-*' '.github/workflows/release.yml'` returns zero matches (AC-02).
- [ ] Every previously floating-tag third-party action under the affected paths is now SHA-pinned with a `# {name}@v{semver} (pinned YYYY-MM-DD)` comment.
- [ ] `npm run lint:no-tbd-shas` exists, exits 0 on the clean tree, exits 1 with a clear error when the literal is reintroduced.
- [ ] CI's `lint` job runs `npm run lint:no-tbd-shas` (one new step; no new workflow file).
- [ ] `plugins/autonomous-dev/.github/workflows/observe.yml.example` exists, passes `actionlint`, has `if: false` default, and pins all third-party `uses:` references.
- [ ] `plugins/autonomous-dev/commands/observe.md` cross-references the example via a relative link.
- [ ] Doc-only test in `tests/docs/test-observe-yml-example.test.ts` passes; deletion of the example or the cross-reference fails the test (FR-1714).
- [ ] `plugins/autonomous-dev/docs/runbooks/refresh-action-pins.md` exists and documents the per-occurrence procedure plus quarterly cadence (FR-1710).
- [ ] `actionlint` is invokable locally and in CI (OQ-06 resolved).
- [ ] PR description enumerates `closes FR-1706, FR-1707, FR-1708, FR-1709, FR-1710, FR-1711, FR-1712, FR-1713, FR-1714` and links to TDD-032 §5.2 + §5.3.
- [ ] Total `npm test` pass count strictly non-decreasing (TG-06).
- [ ] Commit message: `chore(deploy,ci): pin action SHAs + lint guard + observe.yml.example (PLAN-032-2)`.
