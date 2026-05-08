# SPEC-032-2-04: "How to Refresh Action Pins" Runbook

## Metadata
- **Parent Plan**: PLAN-032-2 (SHA Pinning + observe.yml.example + lint guard)
- **Parent TDD**: TDD-032 §5.2 (WS-2 closeout artifact)
- **Parent PRD**: PRD-017 (FR-1710)
- **Tasks Covered**: PLAN-032-2 Task 9 (author the runbook)
- **Estimated effort**: 0.5 day
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-032-2-04-refresh-action-pins-runbook.md`

## Summary
Author the canonical operator-facing runbook for refreshing pinned
action SHAs in the autonomous-dev cloud-deploy plugins and
`.github/workflows/release.yml`. The runbook documents: (1) why pins
exist, (2) the quarterly refresh cadence + CVE-driven trigger,
(3) the per-occurrence resolution procedure (the `gh api` flow from
SPEC-032-2-01), (4) the `lint:no-tbd-shas` regression guard
(SPEC-032-2-02), (5) a "Known unpinnable upstream" appendix seeded
empty for SPEC-032-2-01's deferrals, and (6) cross-references to
PRD-017 / TDD-032.

This spec ships ONE new markdown file. No code changes. The runbook
becomes the single source of truth for action-SHA hygiene; future
deploy-plugin authors copy this procedure rather than reinvent it.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/docs/runbooks/refresh-action-pins.md` | Create | Operator runbook |

## Functional Requirements

| ID | Requirement | Task |
|----|-------------|------|
| FR-1 | A new file `plugins/autonomous-dev/docs/runbooks/refresh-action-pins.md` exists. | T9 |
| FR-2 | The runbook has a `## Purpose` section explaining: (a) supply-chain integrity rationale, (b) tag-replay attack model, (c) pointer to TDD-032 §5.2. | T9 |
| FR-3 | The runbook has a `## Cadence` section stating: quarterly review (Q-month-1) AND triggered review on upstream CVE disclosure. | T9 |
| FR-4 | The runbook has a `## Per-occurrence procedure` section enumerating the four steps from SPEC-032-2-01: (a) read accompanying version comment, (b) `gh api repos/{org}/{action}/git/ref/tags/v{semver}` to resolve SHA, (c) `gh api repos/{org}/{action}/commits/{sha}` to verify upstream-main reachability, (d) edit YAML in place + refresh comment date. | T9 |
| FR-5 | The procedure section includes a copy-pasteable shell snippet (similar to SPEC-032-2-01's Resolution step) parameterized by `${ORG}`, `${ACTION}`, `${SEMVER}`. | T9 |
| FR-6 | The runbook has a `## Lint guard` section explaining: (a) `npm run lint:no-tbd-shas` purpose, (b) the path scope, (c) the contract that the guard MUST be reverted alongside any pin-set revert (TDD §4 / WS-6 paired-revert). | T9 |
| FR-7 | The runbook has a `## Known unpinnable upstreams` section, present but seeded EMPTY for SPEC-032-2-01's deferrals. The section's prose explains how to add entries (one row per deferral; columns `Action`, `Version`, `Reason`, `Filed upstream issue`, `First observed`). | T9 |
| FR-8 | The runbook has a `## Floating-tag remediation` section noting the lint guard does NOT catch floating-tag re-introduction; humans catch them at PR review. Documents the `git grep -nE 'uses: [a-z0-9-]+/[a-z0-9-]+@v[0-9]+(\.[0-9]+){0,2}$' -- 'plugins/autonomous-dev-deploy-*' '.github/workflows/release.yml'` ad-hoc check. | T9 |
| FR-9 | The runbook has a `## Cross-references` section linking to: PRD-017 FR-1710, TDD-032 §5.2, SPEC-032-2-01, SPEC-032-2-02, SPEC-032-2-03 (for the `.example` template), and SPEC-024-1 (origin of the version-comment convention). | T9 |
| FR-10 | The runbook has a `## actionlint` section noting where `actionlint` is installed (CI: pinned action; local: per SPEC-032-2-02 FR-11 install path). | T9 |
| FR-11 | The runbook is self-contained: a contributor with only this doc + `gh` CLI access can complete a pin refresh end-to-end without consulting other documents. | T9 |
| FR-12 | The runbook passes the existing `lychee` markdown link check from PLAN-016-2. | T9 |

## Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| Self-containment | A naive contributor (one with `gh` CLI access but no prior pin-refresh experience) reproduces the procedure end-to-end without external help | One reviewer reads the runbook cold and refreshes one randomly chosen pin during PR review |
| Length | ≤ 3 pages rendered (≈ 1500 words) | `wc -w plugins/autonomous-dev/docs/runbooks/refresh-action-pins.md` ≤ 1500 |
| Link integrity | All internal and external links resolve | `lychee` PASS |
| Procedure determinism | Following the runbook for the same `org/action@v{semver}` produces the same SHA | The `gh api` calls are deterministic (no time-dependent fields) |
| Comment-format consistency | The runbook's example pin comment uses the same regex as SPEC-032-2-01 FR-11 | Visual diff against SPEC-032-2-01 |
| Discoverability | The runbook is reachable from the deploy-plugin README and from the closeout PR description | Reviewer confirms a relative link exists in at least one of: `plugins/autonomous-dev-deploy-aws/README.md`, top-level docs index, or PRD-017 closeout PR |

## Technical Approach

### Runbook outline

```markdown
# How to Refresh Action Pins

## Purpose

Why we pin: supply-chain integrity (a malicious upstream maintainer
or a compromised tag cannot retroactively change what our CI runs).
Tag-replay attack model: an upstream re-points `vX` to a malicious
commit; floating-tag references silently inherit the change. Pinning
to a 40-char SHA blocks the attack.

See TDD-032 §5.2 and PRD-017 FR-1710 for the full rationale.

## Cadence

- **Quarterly review** in the first month of each quarter: walk the
  pin set, refresh any pin whose upstream tag has shipped a CVE-fix
  release.
- **Triggered review** on upstream CVE disclosure: refresh
  immediately for the affected action; defer the rest to the next
  quarterly review.

## actionlint

`actionlint` validates every workflow file we modify. Local install:
[per SPEC-032-2-02 FR-11 install path]. CI invocation: pinned
`rhysd/actionlint@<sha>` action in the `lint` job (PLAN-016-2).

## Per-occurrence procedure

For each `uses:` line you intend to refresh:

1. **Read the version comment.** Each pinned line has an accompanying
   comment in the form
   `# {action-name}@v{semver} (pinned YYYY-MM-DD)`. The `{action-name}`
   and `{semver}` are inputs to step 2.

2. **Resolve the SHA.**
   ```bash
   ORG=actions          # e.g. "actions" in actions/checkout
   ACTION=checkout
   SEMVER=4.1.7         # bump as needed for the refresh
   SHA=$(gh api "repos/${ORG}/${ACTION}/git/ref/tags/v${SEMVER}" \
          --jq '.object.sha')
   echo "${SHA}"        # 40-char hex
   ```

3. **Verify upstream-main reachability.**
   ```bash
   gh api "repos/${ORG}/${ACTION}/commits/${SHA}" --jq '.sha' \
     || { echo "DEFER: ${ORG}/${ACTION}@v${SEMVER}"; }
   ```
   If this returns 404 (or the SHA is otherwise unreachable on
   upstream `main`), record the action under "Known unpinnable
   upstreams" below and skip the pin. File an upstream issue.

4. **Edit the YAML.** Open the file. Replace the existing `@<ref>`
   with `@${SHA}`. Update or insert the comment to
   `# ${ACTION}@v${SEMVER} (pinned YYYY-MM-DD)` where `YYYY-MM-DD` is
   today's date. Match the comment-placement convention already used
   in the file (above-line vs. trailing).

5. **Verify.** Run `actionlint <file>` and `npm run lint:no-tbd-shas`.
   Both MUST exit 0.

## Lint guard

`npm run lint:no-tbd-shas` is the regression guard. It scans:
- `plugins/autonomous-dev-deploy-aws/**`
- `plugins/autonomous-dev-deploy-gcp/**`
- `plugins/autonomous-dev-deploy-azure/**`
- `plugins/autonomous-dev-deploy-k8s/**`
- `.github/workflows/release.yml`

for the literal `TBD-replace-with-pinned-SHA`. Exit 1 = literal
present (build break). Exit 0 = clean.

The guard is paired with the pin set per TDD-032 §4 / WS-6: any
revert of the pinned SHAs MUST also revert the guard, otherwise CI
will block every subsequent PR with no escape hatch.

## Floating-tag remediation

The lint guard does NOT catch floating-tag re-introductions
(e.g. `actions/checkout@v4` slipping past review). Use this ad-hoc
check during refresh sessions:

```bash
git grep -nE 'uses: [a-z0-9-]+/[a-z0-9-]+@v[0-9]+(\.[0-9]+){0,2}$' \
  -- 'plugins/autonomous-dev-deploy-*' '.github/workflows/release.yml'
```

Zero matches = clean. Any match = re-pin per the per-occurrence
procedure above.

## Known unpinnable upstreams

| Action | Version | Reason | Filed upstream issue | First observed |
|--------|---------|--------|---------------------|----------------|
| _none yet_ |  |  |  |  |

Add a row when an action's tag fails the upstream-main reachability
check (step 3). Include the `gh issue create` URL for the upstream
issue you file. Re-attempt the pin in a future refresh session.

## Cross-references

- [PRD-017 FR-1710](../prds/PRD-017-cleanup-and-operational-closeout.md#fr-1710)
- [TDD-032 §5.2](../tdd/TDD-032-cleanup-and-operational-closeout.md#52-action-sha-pinning)
- [SPEC-032-2-01](../specs/SPEC-032-2-01-action-pin-audit-and-resolution.md)
- [SPEC-032-2-02](../specs/SPEC-032-2-02-lint-no-tbd-shas-guard-and-ci-wiring.md)
- [SPEC-032-2-03](../specs/SPEC-032-2-03-observe-yml-example-and-doc-test.md)
- [SPEC-024-1](../specs/SPEC-024-1-...) (version-comment convention origin; verify exact filename at author time)
```

The above outline is a starting point. The implementer fleshes out
each section with the concrete procedural detail and validates link
targets resolve (some link paths are placeholders for the
implementer to disambiguate against the actual filenames).

### Tone and audience

- **Audience:** a contributor with `gh` CLI access and a working git
  checkout; no prior context about autonomous-dev's supply-chain
  posture.
- **Tone:** procedural and terse. Every step is a verb. No
  motivational prose. Cross-references point to the "why."
- **Voice:** imperative ("Read the comment," "Resolve the SHA"),
  matching existing runbooks under
  `plugins/autonomous-dev/docs/runbooks/`.

### Comment-date convention

The runbook reiterates the date format `YYYY-MM-DD` (ISO-8601
calendar date) and notes that future refreshes update the date in
the comment. The pinned date is the date of the refresh, not the
date the underlying action was released.

## Interfaces and Dependencies

**Consumes:**
- `gh` CLI (operator-side prerequisite, documented).
- The pin-comment convention shipped by SPEC-024-1 (read at refresh
  time).
- The lint guard contract from SPEC-032-2-02.

**Produces:**
- The canonical operator-facing reference for action-SHA hygiene.
- The "Known unpinnable upstreams" appendix that SPEC-032-2-01
  appends to during its closeout (if any deferrals happen).

**Cross-references:**
- See FR-9.

## Acceptance Criteria

```
Given the worktree after this spec lands
When `ls plugins/autonomous-dev/docs/runbooks/refresh-action-pins.md` runs
Then the file exists

Given the runbook
When the file is rendered
Then the following sections are present in order:
  - Purpose
  - Cadence
  - actionlint
  - Per-occurrence procedure
  - Lint guard
  - Floating-tag remediation
  - Known unpinnable upstreams
  - Cross-references

Given the Per-occurrence procedure section
When read by a contributor with gh CLI access
Then it contains four numbered steps
And step 2 has a copy-pasteable shell snippet using ${ORG}, ${ACTION}, ${SEMVER}
And step 3 documents the upstream-main reachability check
And step 3 documents the deferral path when reachability fails
And step 4 documents the comment-format `# {action}@v{semver} (pinned YYYY-MM-DD)`

Given the Lint guard section
When read
Then it names `npm run lint:no-tbd-shas` exactly
And it enumerates the four deploy-plugin path globs and `release.yml`
And it states the paired-revert contract (guard reverts with the pin set)

Given the Known unpinnable upstreams section
When this spec lands
Then the table is present
And the table body contains a single "_none yet_" placeholder row OR is empty with a "(none)" comment
And the table columns are: Action | Version | Reason | Filed upstream issue | First observed

Given the Floating-tag remediation section
When read
Then it documents the ad-hoc grep
And it explicitly states the lint guard does NOT catch floating-tag re-introductions

Given the runbook
When `lychee` markdown link check runs
Then exit code is 0 (all links resolve)

Given the runbook
When word-counted
Then total word count is ≤ 1500

Given a reviewer reading the runbook cold during PR review
When the reviewer attempts a pin refresh for one randomly chosen action
Then the reviewer can complete the refresh using only the runbook + gh CLI
And the reviewer signs off on FR-11 in the closeout PR review

Given the closeout PR for SPEC-032-2-01 has deferrals (per SPEC-032-2-01 FR-7)
When this runbook lands in the same closeout PR
Then the "Known unpinnable upstreams" table contains one row per deferral
And each row has Action, Version, Reason, Filed upstream issue (URL), First observed (today's date)
```

## Test Requirements

This spec is doc-only. Verification is via `lychee` link check and
human review. No unit/integration tests ship.

- `lychee plugins/autonomous-dev/docs/runbooks/refresh-action-pins.md`
  exits 0.
- A spot-check by one reviewer (not the author) walking through the
  procedure for one randomly chosen pin from SPEC-032-2-01's pin set
  during PR review. The reviewer documents the spot-check in the PR
  review comments.
- Word-count check: `wc -w` ≤ 1500.
- Section-presence check: visual inspection at PR review confirms all
  eight sections are present in order.

## Implementation Notes

- The runbook outline in Technical Approach is a STARTING POINT, not
  the final body. Flesh out each section with concrete procedural
  detail. Avoid duplicating SPEC-032-2-01's body verbatim; the
  runbook is the operator-facing summary, not a re-derivation.
- The "Known unpinnable upstreams" table ships seeded empty (or with
  a "_none yet_" placeholder row). If SPEC-032-2-01 ships deferrals,
  the closeout PR populates this table in the same commit as the
  pin-set edits. If no deferrals, the empty table stays.
- Link targets (cross-references section) are placeholder paths in
  the outline. The implementer disambiguates against actual on-disk
  filenames at author time. `lychee` PASS is the verification.
- The `## actionlint` section depends on SPEC-032-2-02 FR-11's
  install-path documentation. If SPEC-032-2-02 ships before this
  runbook, copy the install path verbatim. If they ship together,
  coordinate.
- The runbook does NOT prescribe Dependabot configuration. PRD-017
  §6 / NG-05 explicitly excludes Dependabot from this PRD's scope.
  A future PRD may add a Dependabot section; this runbook does not
  preempt that decision.
- **Tone discipline:** keep prose imperative and terse. Reviewers
  during the closeout PR will push back on motivational paragraphs
  or repeated explanations of "why we pin" — the Purpose section
  covers it once.
- The runbook's location under `plugins/autonomous-dev/docs/runbooks/`
  matches the existing runbook structure (see `ci-status-checks.md`
  and `claude-assistant-concurrency-test.md` for tone and format
  precedents).

## Rollout Considerations

- **Doc-only.** No CI behavior change, no runtime change, no
  operator-side action required at merge.
- **Discoverability:** consider adding a one-line link from a
  deploy-plugin README (e.g., `plugins/autonomous-dev-deploy-aws/README.md`)
  pointing to this runbook. This is OPTIONAL (NFR table item
  "Discoverability") — the closeout PR description is the primary
  surface; the README link is a discoverability hardening if low-cost.
- **Rollback:** delete the runbook file in a single revert. No other
  artifact depends on it programmatically — only humans do, and they
  can re-derive the procedure from SPEC-032-2-01 + SPEC-032-2-02.

## Effort Estimate

- Drafting the runbook (8 sections, ≤ 1500 words): 0.4 day
- `lychee` link check + reviewer spot-check coordination: 0.1 day
- Total: 0.5 day
