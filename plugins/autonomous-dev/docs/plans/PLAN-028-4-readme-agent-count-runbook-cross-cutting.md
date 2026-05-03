# PLAN-028-4: README, Agent-Count, Runbook See-Also, and Cross-Cutting Sweep

## Metadata
- **Parent TDD**: TDD-028-assist-evals-readme-cross-cutting
- **Estimated effort**: 2 days
- **Dependencies**: [PLAN-028-1, PLAN-028-2, PLAN-028-3]
- **Blocked by**: [PLAN-028-1]
- **Priority**: P1

## Objective
Land the operator-discoverability surfaces that complete TDD-028's cross-cutting work: bump the agent count in `skills/help/SKILL.md` from 13 to 18 (FR-1501) reflecting the five reviewer agents added by TDD-020; rewrite the plugin `README.md` (FR-1526) with the 7-bullet "What this plugin does", the rewritten "How to run evals" section pointing at the eight-suite layout and meta-lint, the expanded 14-entry "Project structure", and the new operator-facing "Document map" anchor table; append the four-runbook See-also index (FR-1531) to `instructions/runbook.md` covering chains, deploy, cred-proxy, firewall, and the cloud setup-wizard handoff. Enforce the cross-cutting bans on this PR's content: no SHA pinning (FR-1540), reviewer-tone parity (FR-1539), unified anchor-only cross-references (FR-1541), and a decomposition acknowledgement in the README footer pointing operators at PRD-015 (FR-1542). The README's Document Map is the single most important discoverability artifact in the plugin — operators landing on the README must find their question's answer in <30 seconds.

## Scope
### In Scope
- Update `plugins/autonomous-dev-assist/skills/help/SKILL.md` "Available agents" table from 13 rows to 18 rows. Five new rows for the reviewer agents added by TDD-020: `standards-meta-reviewer`, `qa-edge-case-reviewer`, `ux-ui-reviewer`, `accessibility-reviewer`, `rule-set-enforcement-reviewer`. Each row: `<name> | <one-line description from agent frontmatter> | <pipeline phase>`. Source the descriptions verbatim from the corresponding agent files' frontmatter `description:` field for accuracy.
- Rewrite `plugins/autonomous-dev-assist/README.md` per TDD-028 §7.2:
  - "What this plugin does" 3 → 7 bullets covering: assistant + chains/deploy/cloud/cred-proxy/firewall guidance; quickstart with `--with-cloud`; onboarding (cloud-aware); troubleshooter recognizing audit-log/ledger/socket/firewall; eight-suite eval harness gating ≥95% on security/cost-critical surfaces; surface-specific runbooks; anchor-only cross-refs to upstream `autonomous-dev` core TDDs.
  - "Available commands" unchanged (3 commands; toggle is a flag, not a new command — per TDD-028).
  - "How to run evals" rewritten per TDD-028 §7.2: per-PR single-suite invocation; nightly `eval all`; schema-lock at `evals/schema/eval-case-v1.json`; ≥5 negative cases per suite; 80% / 95% threshold split; results JSON path unchanged.
  - "Project structure" 8 → 14 entries adding the four new runbooks, the four new eval YAMLs, and the new schema directory per TDD-028 §7.2's structure block. Plus `cloud-prompt-tree.md` from TDD-027.
  - New H2 "Document map" with the 10-row anchor table per TDD-028 §7.2: question type → start surface → procedural deep-dive. Every cell resolves to an extant file or section anchor.
  - New footer paragraph: "This plugin's current capabilities were authored under PRD-015 (autonomous-dev/docs/prd/PRD-015). For decomposition rationale and the four-TDD breakdown (TDD-025, TDD-026, TDD-027, TDD-028), see PRD-015 §<anchor>." Anchor-only cross-ref per FR-1542.
- Append `## See also` H2 to `plugins/autonomous-dev-assist/instructions/runbook.md` per TDD-028 §8: 5-row table covering chains-runbook, deploy-runbook, cred-proxy-runbook, firewall-runbook, and the cloud setup-wizard handoff. Each row links to the runbook file (siblings will create the four runbook files; this plan only writes the index) and names the owning TDD by anchor.
- Verify and document graceful-degradation: the four runbook links in the See-also point to files owned by sibling TDDs (chains/deploy by TDD-026; cred-proxy/firewall by TDD-025). At PR-merge time those files may not yet exist on `main`. Flag the four links with a `<!-- pending: TDD-025/026 -->` HTML comment if needed; the markdown-link-checker (PRD-010 CI) recognizes the marker and skips the check until the marker is removed.
- SHA-pinning sweep: grep the changed files for any 7+ char hex sequence preceded by `commit `, `@`, or `sha:`; assert zero matches per FR-1540. Also grep for `github.com/.*/(commit|tree|blob)/[0-9a-f]{7,}` and assert zero matches.
- Reviewer-tone parity (FR-1539): the README's prose tone and the SKILL.md prose tone are reviewed against the existing `troubleshoot/SKILL.md` and `config-guide/SKILL.md` baselines for consistency (terse, operator-second-person, no marketing prose, no exclamation points, no first-person plural). The standards-reviewer agent explicitly checks tone parity during PR review.
- Decomposition acknowledgement (FR-1542): the README footer paragraph from above; additionally, a one-liner in `skills/help/SKILL.md` near the top noting "This plugin was extended under PRD-015 to cover plugin chains, deployment backends, cloud onboarding, credential proxy, and egress firewall."
- Cross-link contract enforcement (FR-1541): every cross-reference in the changed files is to either (a) a file path under the repo root, or (b) a heading anchor in a file under the repo root. No external URLs except the canonical `https://github.com/anthropics/claude-code-action` style references that already exist in the README. Standards-reviewer agent checks this.

### Out of Scope
- Authoring the four sibling runbook files (`chains-runbook.md`, `deploy-runbook.md`, `cred-proxy-runbook.md`, `firewall-runbook.md`) — owned by TDD-025 and TDD-026.
- Authoring the `cloud-prompt-tree.md` file referenced in the project structure — owned by TDD-027.
- Authoring SKILL.md sections for chains, deploy, cloud, cred-proxy, firewall — owned by TDD-025 and TDD-026.
- Authoring eval suite content — owned by PLAN-028-1, PLAN-028-2, PLAN-028-3 and sibling TDDs.
- Modifying the existing 90 reviewer-eval cases or four existing assist suites (regression-stable, per TDD-028 NG-07).
- Adding new agents or new commands — out of scope per TDD-028 NG-04, NG-05.
- Authoring agent frontmatter changes — agent descriptions are sourced verbatim; if a description needs updating, that is a separate ticket against the owning TDD.
- Versioning the plugin manifest (`plugin.json`) — release-version bump is a separate concern owned by PLAN-017-3.
- Authoring `commands/eval.md` updates (those are owned by PLAN-028-1 task 7).

## Tasks

1. **Bump agent count in `skills/help/SKILL.md`** — Update the "Available agents" table from 13 rows to 18. Source each new row's `description` and `pipeline phase` from the corresponding agent file frontmatter under `plugins/autonomous-dev/agents/`. The five new rows: `standards-meta-reviewer`, `qa-edge-case-reviewer`, `ux-ui-reviewer`, `accessibility-reviewer`, `rule-set-enforcement-reviewer`. Update any other count references in the same SKILL.md (e.g., a paragraph-level "13 agents" mention) for consistency.
   - Files to modify: `plugins/autonomous-dev-assist/skills/help/SKILL.md`
   - Acceptance criteria: Table has 18 rows. Each new row's description matches the agent file's frontmatter verbatim. Any other "13" reference in the file is updated to 18. Reviewer agent's count check (which counts agent files in `plugins/autonomous-dev/agents/`) returns 18 and matches the table.
   - Estimated effort: 1.5h

2. **Rewrite README "What this plugin does"** — Replace the 3-bullet list with the 7-bullet block per TDD-028 §7.2. Each bullet ≤180 chars, terse, operator-facing tense.
   - Files to modify: `plugins/autonomous-dev-assist/README.md`
   - Acceptance criteria: Diff is exactly the 4 new bullets added (chains/deploy/cloud/cred-proxy/firewall coverage; eight-suite eval harness; surface-specific runbooks; anchor-only cross-refs). Existing 3 bullets are minimally edited only to harmonize tone. Markdown lint passes.
   - Estimated effort: 1h

3. **Rewrite README "How to run evals"** — Replace the existing generic eval section with the 6-point list from TDD-028 §7.2: per-PR single-suite, nightly all, schema-lock, ≥5 negatives, 80%/95% thresholds, results JSON path. Each point references a real file path or command argument so the operator can self-serve.
   - Files to modify: `plugins/autonomous-dev-assist/README.md`
   - Acceptance criteria: Section is exactly 6 points; every file path resolves; every command argument matches `commands/eval.md` (PLAN-028-1 task 7). The 80%/95% threshold split is explicit. Markdown lint passes.
   - Estimated effort: 1h

4. **Expand README "Project structure"** — Replace the 8-entry tree with the 14-entry tree per TDD-028 §7.2, adding: `instructions/chains-runbook.md`, `instructions/deploy-runbook.md`, `instructions/cred-proxy-runbook.md`, `instructions/firewall-runbook.md`, `instructions/cloud-prompt-tree.md`, `evals/schema/eval-case-v1.json`, plus the four new test-cases entries. Mark sibling-owned files with `# NEW (TDD-XXX)` annotations as in §7.2.
   - Files to modify: `plugins/autonomous-dev-assist/README.md`
   - Acceptance criteria: Tree has all 14 entries in the documented order. Sibling-pending files are marked with `<!-- pending: TDD-XXX -->` so the markdown-link-checker tolerates them. Existing entries (eval-config.yaml, runner.sh, scorer.sh, the four existing test-cases YAMLs, the four reviewer YAMLs) are bit-identical.
   - Estimated effort: 1.5h

5. **Add README "Document map" H2** — Insert the new 10-row anchor table per TDD-028 §7.2 between "Project structure" and the footer. Each row: question type | start surface | procedural deep-dive. Every cell resolves: file paths use repo-relative paths, section anchors use `#kebab-case` form matching the heading text.
   - Files to modify: `plugins/autonomous-dev-assist/README.md`
   - Acceptance criteria: Table has 10 rows per TDD-028 §7.2. The markdown-link-checker resolves every link (including anchors). Sibling-owned destinations marked with `<!-- pending: TDD-XXX -->` if needed. Operator-walkthrough manual test: pick 3 question types at random, follow the row to the destination, confirm the destination answers the question (or, for sibling-pending destinations, confirm the eventual destination is the right one per the sibling TDD).
   - Estimated effort: 2h

6. **Add README decomposition acknowledgement footer** — Append a footer paragraph per TDD-028 FR-1542 referencing PRD-015 by anchor. Mention the four sibling TDDs (TDD-025, TDD-026, TDD-027, TDD-028) so an operator landing on the README can trace the decomposition rationale.
   - Files to modify: `plugins/autonomous-dev-assist/README.md`
   - Acceptance criteria: Footer paragraph exists; cross-ref is anchor-only (not commit-SHA pinned); standards-reviewer's SHA-pinning check passes. Footer is visually separated from the body content (preceded by `---`).
   - Estimated effort: 0.5h

7. **Add SKILL.md decomposition acknowledgement one-liner** — Append a one-liner near the top of `skills/help/SKILL.md` per the Scope section: "This plugin was extended under PRD-015 to cover plugin chains, deployment backends, cloud onboarding, credential proxy, and egress firewall." Anchor-only cross-ref to PRD-015.
   - Files to modify: `plugins/autonomous-dev-assist/skills/help/SKILL.md`
   - Acceptance criteria: One-liner is present, terse, anchor-only. Markdown lint passes.
   - Estimated effort: 0.25h

8. **Append See-also index to `instructions/runbook.md`** — Append the H2 + 5-row table from TDD-028 §8. Each row: topic | runbook file | owning TDD anchor. The four runbook files do not yet exist (sibling-owned); flag those four links with `<!-- pending: TDD-025/026 -->`.
   - Files to modify: `plugins/autonomous-dev-assist/instructions/runbook.md`
   - Acceptance criteria: New H2 is the final section in the file. Table has 5 rows per TDD-028 §8. Existing 1263-line content is bit-identical above the new H2. Markdown lint passes; markdown-link-checker tolerates pending links per the `<!-- pending: -->` marker.
   - Estimated effort: 1h

9. **SHA-pinning sweep** — Grep all changed files: `git diff --name-only main...HEAD | xargs grep -nE '(commit [0-9a-f]{7,}|@[0-9a-f]{40}|sha: [0-9a-f]{7,}|github\.com/.*(commit|tree|blob)/[0-9a-f]{7,})'`. Assert zero matches. If any match exists, replace with anchor-form cross-ref per the convention in TDD-026 §8.
   - Files to modify: any of the above as found
   - Acceptance criteria: Grep returns zero matches. Result captured in PR description as evidence. Standards-reviewer agent's SHA-pinning regex (per TDD-020 § rule-set-enforcement) also returns clean.
   - Estimated effort: 0.5h

10. **Reviewer-tone parity check** — Read the rewritten sections aloud (or use a tone-checker). Compare against `plugins/autonomous-dev-assist/skills/troubleshoot/SKILL.md` and `plugins/autonomous-dev-assist/skills/config-guide/SKILL.md` for: second-person operator voice; no first-person plural; no exclamation points; no marketing adjectives ("powerful", "seamless"); terse declarative sentences. Adjust the prose until parity is achieved. Standards-reviewer agent invoked explicitly during PR review.
    - Files to modify: `plugins/autonomous-dev-assist/README.md`, `plugins/autonomous-dev-assist/skills/help/SKILL.md` (touch-ups only)
    - Acceptance criteria: Standards-reviewer agent's tone-parity check passes. Manual diff inspection by author confirms the new prose reads in the same voice as the existing reference SKILLs. PR comment from the standards-reviewer captures the explicit approval.
    - Estimated effort: 1.5h

11. **Markdown-link-check sweep** — Run `markdown-link-check` (or the existing PRD-010 CI equivalent) over `README.md`, `skills/help/SKILL.md`, and `instructions/runbook.md`. Confirm: every non-pending link resolves; every pending link has the `<!-- pending: TDD-XXX -->` marker; every section anchor matches an actual heading.
    - Files to modify: PR fixes only if any non-pending link is broken
    - Acceptance criteria: Link checker exit 0 (or warns only on pending markers). The 10 Document-Map rows are individually verified; the 5 See-also rows are individually verified. Output captured in the PR description.
    - Estimated effort: 1h

12. **Operator-walkthrough smoke test** — Pretend to be an operator with each of the 10 Document-Map question types. For each, navigate from the README's Document Map to the destination and confirm the destination answers the question. For sibling-pending destinations, confirm the answer would be there once the sibling lands. Capture the walkthrough as a PR description annotation.
    - Files to modify: PR adjustments to anchor targets if any walkthrough fails
    - Acceptance criteria: 10/10 walkthroughs land at a destination that answers (or will answer) the question type. Any walkthrough that lands at a wrong destination triggers a Document-Map row fix and re-test. Captured as a checklist in PR.
    - Estimated effort: 2h

## Dependencies & Integration Points

**Exposes to other plans:**
- **README "Document map"** as the canonical operator-discoverability surface; consumed by every future plan that adds a new operator-facing surface (each new surface earns a row).
- **SKILL.md "Available agents" table** count of 18; consumed by reviewer agent's count-check (any future agent addition bumps this number and the count-check enforces the bump).
- **`instructions/runbook.md` See-also H2** as the canonical surface-runbook index; consumed by sibling TDD-025 and TDD-026 (their PRs verify their runbook is listed in the See-also at merge time).
- **Decomposition-acknowledgement footer** as the precedent for future PRD-decomposed work — every multi-TDD PRD's child plugin earns a footer pointing back at the PRD.

**Consumes from other plans:**
- **PLAN-028-1** (blocking): the new schema directory entry in the project structure; the meta-lint reference in "How to run evals"; the eval-config 95% threshold reference.
- **PLAN-028-2** and **PLAN-028-3** (soft dependency): the four new test-cases YAMLs are mentioned in the project structure tree. If those plans have not landed when this plan ships, the project-structure entries are marked `<!-- pending: PLAN-028-2/3 -->`.
- **TDD-020**: source of the five new agent rows for the SKILL.md table; standards-reviewer agent for tone parity; rule-set-enforcement-reviewer for SHA-pinning sweep.
- **TDD-025, TDD-026, TDD-027** (sibling TDDs): owners of the runbooks referenced in the See-also and Document Map. Cross-links use `<!-- pending: -->` markers until those land.
- **PRD-015**: footer cross-ref destination.
- **PRD-010 CI infrastructure**: markdown-link-checker workflow that runs on PR.

## Testing Strategy

- **Agent-count check:** the reviewer agent counts files in `plugins/autonomous-dev/agents/` and verifies the table count matches. Should now return 18=18 PASS.
- **Markdown lint:** all three changed markdown files pass `markdownlint` (or the equivalent PRD-010 lint). No trailing whitespace, no broken heading hierarchy, no inline HTML other than the documented `<!-- pending: -->` markers.
- **Markdown-link-check:** task 11 covers; non-pending links resolve, pending links are marked.
- **SHA-pinning sweep:** task 9 covers; zero matches.
- **Reviewer-tone parity:** task 10 covers; standards-reviewer approval captured.
- **Operator walkthroughs:** task 12 covers 10 question types from the Document Map; 10/10 land correctly.
- **Cross-link contract:** every cross-reference in the changed files is repo-relative or a heading anchor (FR-1541); standards-reviewer's anchor-convention check (TDD-026 §8) returns clean.
- **Regression stability:** existing prose, command list, and the 3 unchanged "What this plugin does" bullets are bit-identical (or only minimally tone-harmonized; harmonization captured explicitly in PR diff).
- **Decomposition acknowledgement:** README footer and SKILL.md one-liner reference PRD-015 anchor, not commit SHA.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Sibling runbooks (chains, deploy, cred-proxy, firewall) don't land in time, leaving the See-also and Document Map with stale `<!-- pending: -->` markers | High | Medium — broken-link CI noise; operator confusion | Pending-marker convention is documented; markdown-link-checker tolerates them. Once sibling lands, a one-line PR removes the marker. Tracking comment in this PR cross-links sibling TDDs so the cleanup is visible. |
| Agent frontmatter `description:` is too long to fit cleanly in the SKILL.md table | Medium | Low — table layout breaks | If a description exceeds ~80 chars, summarize in the SKILL.md table (preserve the verbatim source as a comment beneath); flag for follow-up to shorten the agent frontmatter itself. |
| Reviewer-tone parity is subjective; standards-reviewer and human reviewer disagree | Medium | Low — extra review cycle | Tone reference baseline (existing troubleshoot/config-guide SKILLs) is concrete and shared between reviewer and author. Disagreements resolved by the rule-set-enforcement-reviewer with the README of the existing SKILLs as the tie-breaker. |
| Document Map points an operator to a section that doesn't yet contain the answer (sibling SKILL section pending) | High | Medium — operator follows the link and hits a stub | `<!-- pending: -->` marker placed on Document Map rows whose destination is sibling-pending; README footer notes "if a destination is marked pending, the content is in the corresponding sibling TDD's PR — see PRD-015 §<anchor> for the rollout sequence." |
| Markdown-link-checker not configured to honor the `<!-- pending: -->` marker | Medium | Low — false-fail CI | If the existing checker doesn't know the marker, add a one-line config (regex skip pattern). Document the marker convention in `docs/conventions/pending-links.md` (a new short doc, ~10 lines). |
| SHA-pinning sweep regex misses a non-standard form (e.g., a hex string in a code block) | Low | Medium — silent SHA pin | Standards-reviewer agent's regex is more comprehensive than the grep in task 9; it serves as the second line of defense. The sweep regex is documented and reviewable. |
| README rewrite drops a piece of useful information that operators depend on | Medium | Medium — discoverability regression | Diff inspection by author + reviewer compares old README content section-by-section against the new structure. Anything dropped is captured in PR description with rationale (e.g., "command X removed because it was deprecated under PRD-006"). |
| Existing 1263-line `runbook.md` accidentally edited above the new H2 | Low | High — large diff hides accidental content change | `git diff` review confirms only the new H2 + 5-row table is added at the file end. PR template includes a checklist row for "runbook.md above-the-fold content is bit-identical." |
| Decomposition footer accidentally pins to a TDD-028 commit SHA | Low | Low — caught by SHA sweep in task 9 | Sweep is the same defense; footer template is anchor-only. |

## Definition of Done

- [ ] `skills/help/SKILL.md` "Available agents" table has 18 rows; each new row's description matches the agent frontmatter verbatim.
- [ ] All other "13 agents" references in `skills/help/SKILL.md` are updated to 18.
- [ ] `README.md` "What this plugin does" has 7 bullets per TDD-028 §7.2.
- [ ] `README.md` "How to run evals" has 6 points per TDD-028 §7.2.
- [ ] `README.md` "Project structure" has 14 entries per TDD-028 §7.2; sibling-pending files marked.
- [ ] `README.md` has a new "Document map" H2 with 10 rows; every link resolves (or is marked pending).
- [ ] `README.md` has a decomposition-acknowledgement footer cross-referencing PRD-015 by anchor.
- [ ] `skills/help/SKILL.md` has a top-of-file decomposition one-liner cross-referencing PRD-015 by anchor.
- [ ] `instructions/runbook.md` has a new `## See also` H2 at the file end with 5 rows; existing content above is bit-identical.
- [ ] SHA-pinning sweep returns zero matches across all changed files (task 9).
- [ ] Standards-reviewer agent has explicitly approved tone parity (task 10) — captured as a PR comment.
- [ ] Markdown-link-checker passes; pending links are marked with `<!-- pending: TDD-XXX -->`.
- [ ] All 10 Document Map walkthroughs (task 12) land at the correct destination.
- [ ] All cross-references in the changed files are repo-relative or section-anchor; no external commit SHAs.
- [ ] Reviewer agent's count-check confirms agent count of 18 matches the actual count of files under `plugins/autonomous-dev/agents/`.
- [ ] PR description captures: SHA-sweep grep output, markdown-link-check output, walkthrough results, standards-reviewer tone-parity approval.
- [ ] No existing eval-case file or sibling-owned runbook is modified.
