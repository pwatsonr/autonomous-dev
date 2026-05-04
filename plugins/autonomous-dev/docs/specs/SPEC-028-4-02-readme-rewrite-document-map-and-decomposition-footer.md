# SPEC-028-4-02: README Rewrite — What/Evals/Project-Structure/Document-Map/Decomposition-Footer

## Metadata
- **Parent Plan**: PLAN-028-4
- **Parent TDD**: TDD-028 §7.2, FR-1526, FR-1542
- **Tasks Covered**: PLAN-028-4 task 2 (What this plugin does), task 3 (How to run evals), task 4 (Project structure), task 5 (Document map), task 6 (decomposition footer)
- **Estimated effort**: 6 hours
- **Status**: Draft

## Summary
Rewrite five surfaces of `plugins/autonomous-dev-assist/README.md` per TDD-028
§7.2: expand "What this plugin does" from 3 to 7 bullets; replace "How to run
evals" with the eight-suite, schema-locked, 80%/95%-threshold rewrite; expand
"Project structure" from 8 to 14 entries (adding the four new runbooks, the
four new eval YAMLs, the new schema directory, and the cloud-prompt-tree); add
a new "Document map" H2 with a 10-row anchor table; append a decomposition
acknowledgement footer cross-referencing PRD-015 by anchor.

## Functional Requirements

| ID | Requirement | Task |
|----|-------------|------|
| FR-1 | The "What this plugin does" section MUST contain exactly 7 bullets covering: assistant + chains/deploy/cloud/cred-proxy/firewall guidance; quickstart with `--with-cloud`; onboarding (cloud-aware); troubleshooter recognizing audit-log/ledger/socket/firewall; eight-suite eval harness gating ≥95% on security/cost-critical surfaces; surface-specific runbooks; anchor-only cross-refs to upstream `autonomous-dev` core TDDs. | T2 |
| FR-2 | Each bullet MUST be ≤180 chars and use terse, operator-facing prose (no marketing adjectives, no exclamation points, no first-person plural). | T2 |
| FR-3 | The "How to run evals" section MUST contain exactly 6 points covering: (1) per-PR single-suite invocation pattern with example, (2) nightly `--suite all` invocation, (3) schema-lock at `evals/schema/eval-case-v1.json`, (4) ≥5 negative cases per suite, (5) 80%/95% threshold split (default 80%; security/cost-critical suites 95% via `per_suite_overrides`), (6) results JSON path. | T3 |
| FR-4 | Each "How to run evals" point MUST reference a real file path or command argument so the operator can self-serve. | T3 |
| FR-5 | The "Project structure" section MUST contain exactly 14 entries listed in a tree/list block. New entries (vs. pre-edit 8): `instructions/chains-runbook.md`, `instructions/deploy-runbook.md`, `instructions/cred-proxy-runbook.md`, `instructions/firewall-runbook.md`, `instructions/cloud-prompt-tree.md`, `evals/schema/eval-case-v1.json`, plus the 4 new test-cases YAMLs (`chains-eval.yaml`, `deploy-eval.yaml`, `cred-proxy-eval.yaml`, `firewall-eval.yaml`). | T4 |
| FR-6 | Sibling-pending entries (files not yet on `main`) MUST be marked with `<!-- pending: TDD-XXX -->` HTML comment immediately after the entry. | T4 |
| FR-7 | The pre-existing 8 entries (eval-config.yaml, runner.sh, scorer.sh, the 4 existing test-cases YAMLs, the 4 reviewer YAMLs, etc.) MUST be bit-identical to pre-edit state. | T4 |
| FR-8 | A new H2 "Document map" MUST be inserted between "Project structure" and the footer with a 10-row anchor table. Columns: question type | start surface | procedural deep-dive. | T5 |
| FR-9 | Each Document Map row's destination MUST resolve to either (a) a repo-relative file path or (b) a heading anchor in a file under the repo root. NO external URLs. | T5 |
| FR-10 | Sibling-pending Document-Map destinations MUST be marked `<!-- pending: TDD-XXX -->`. | T5 |
| FR-11 | A footer paragraph MUST be appended (preceded by `---` separator): "This plugin's current capabilities were authored under PRD-015 (`docs/prd/PRD-015.md`). For decomposition rationale and the four-TDD breakdown (TDD-025, TDD-026, TDD-027, TDD-028), see [PRD-015 §Decomposition](../../docs/prd/PRD-015.md#decomposition)." | T6 |
| FR-12 | All cross-references in the changed sections MUST be repo-relative paths or section anchors. NO commit-SHA references (FR-1540). | T2-T6 |
| FR-13 | The "Available commands" section MUST be unchanged (still 3 commands; the toggle is a flag, not a new command). | T2-T6 (regression-stable) |
| FR-14 | The 10 Document-Map rows MUST cover the question types: (1) "What does this plugin do?", (2) "How do I install/use it?", (3) "How do I deploy?", (4) "How do I work with chains?", (5) "How do I configure cred-proxy?", (6) "How do I work with the firewall?", (7) "How do I onboard to cloud?", (8) "Why did my deploy fail?" (troubleshoot), (9) "How do I run evals locally?", (10) "Where is the decomposition rationale?". (Exact wording per TDD-028 §7.2 if defined; otherwise use these as canonical.) | T5 |

## Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| Markdown lint | 0 violations | `markdownlint plugins/autonomous-dev-assist/README.md` |
| Markdown-link-check | All non-pending links resolve; pending links honor the marker | `markdown-link-check` (see SPEC-028-4-03 for the sweep) |
| Bullet length | All "What this plugin does" bullets ≤ 180 chars | `awk` length check |
| Project-structure entry count | Exactly 14 entries | Manual count + verification in PR |
| Document-Map row count | Exactly 10 rows | `grep -c '^|' README.md` over the table block |
| Cross-ref hygiene | 0 SHA-style references in the diff | `git diff -- README.md \| grep -E '[0-9a-f]{7,}'` |
| Pre-existing-content stability | "Available commands" + the 3 unchanged "What this plugin does" bullets are bit-identical | Manual diff |
| Tone parity | Reviewed and approved by standards-reviewer agent (per SPEC-028-4-03) | PR comment from agent |
| Operator-walkthrough success | 10/10 Document-Map rows lead to a destination that answers the question (or, for sibling-pending, will answer it) | Walkthrough captured in SPEC-028-4-03 |

## Files to Modify

- **Path**: `plugins/autonomous-dev-assist/README.md`
  - **Action**: Modify (5 sections rewritten/added)

## Technical Approach

### Pre-implementation read

1. Read current `README.md` end-to-end. Capture:
   - The current "What this plugin does" 3 bullets (preserve verbatim except minimal tone harmonization)
   - The current "How to run evals" section verbatim (will be replaced wholesale)
   - The current 8 entries in "Project structure" (preserve verbatim; add 6 new)
   - The current footer (will be replaced/extended)
   - The exact heading hierarchy and anchor names
2. Read TDD-028 §7.2 for the exact bullet wording, threshold split, and Document Map row content (if present in the TDD).

### Section diffs

#### "What this plugin does" (3 → 7 bullets)

Existing 3 bullets are preserved verbatim (or with minimal tone harmonization
captured explicitly in the PR diff). Add 4 new bullets:

```markdown
- Surface-specific guidance for plugin chains, deploy backends, cloud
  onboarding, credential proxy, and egress firewall — under the same
  `autonomous-dev assist` entrypoint.
- Eight-suite eval harness (`autonomous-dev eval --suite <name>`) gating
  ≥95% on security/cost-critical surfaces (cred-proxy, firewall, deploy)
  and ≥80% on the others; schema-locked at
  `evals/schema/eval-case-v1.json`.
- Surface-specific runbooks under `instructions/` covering chains,
  deploy, cred-proxy, firewall, and the cloud setup-wizard handoff.
- Anchor-only cross-references to upstream `autonomous-dev` core TDDs;
  no commit-SHA pinning (per FR-1540).
```

#### "How to run evals" (rewrite)

Replace the current section content with:

```markdown
## How to run evals

1. Per-PR single-suite invocation: `autonomous-dev eval --suite chains`
   (or `deploy`, `cred-proxy`, `firewall`, `help`, `troubleshoot`,
   `config`, `onboarding`). Cost ≈ $1.50 per suite.
2. Nightly full-coverage invocation: `autonomous-dev eval --suite all`
   runs all eight suites in `default_invocation_order`. Cost ≈ $8.50.
3. Every case conforms to `evals/schema/eval-case-v1.json` (the
   schema lock); meta-lint (`evals/meta-lint.sh`) blocks PRs that
   introduce malformed cases.
4. Each suite has at least 5 negative cases (`must_not_mention`)
   targeting catastrophic-command hallucinations.
5. Threshold split via `eval-config.yaml`: default 80%; cred-proxy,
   firewall, and deploy enforce 95% via `per_suite_overrides`.
6. Results land at `evals/results/<timestamp>/<suite>/results.json`
   for downstream cost and drift tracking (per PRD-015).
```

#### "Project structure" (8 → 14 entries)

Preserve all 8 existing entries verbatim. Add the following (annotated with
sibling owners):

```markdown
plugins/autonomous-dev-assist/
  README.md
  commands/
    eval.md
    ...
  evals/
    eval-config.yaml
    runner.sh
    scorer.sh
    meta-lint.sh                 # NEW (SPEC-028-1-02)
    schema/
      eval-case-v1.json          # NEW (SPEC-028-1-01)
    test-cases/
      help-eval.yaml
      troubleshoot-eval.yaml
      config-eval.yaml
      onboarding-eval.yaml
      chains-eval.yaml           # NEW (SPEC-028-2-01)
      deploy-eval.yaml           # NEW (SPEC-028-2-02)
      cred-proxy-eval.yaml       # NEW (SPEC-028-3-01)
      firewall-eval.yaml         # NEW (SPEC-028-3-02)
  instructions/
    runbook.md
    chains-runbook.md            # <!-- pending: TDD-026 -->
    deploy-runbook.md            # <!-- pending: TDD-026 -->
    cred-proxy-runbook.md        # <!-- pending: TDD-025 -->
    firewall-runbook.md          # <!-- pending: TDD-025 -->
    cloud-prompt-tree.md         # <!-- pending: TDD-027 -->
  skills/
    ...
```

The exact tree shape MUST mirror the current README's pre-edit structure for
the 8 existing entries; only the 6 NEW lines (and the schema/ subdir) are
additive.

#### "Document map" (new H2)

```markdown
## Document map

| Question type | Start surface | Procedural deep-dive |
|---------------|---------------|----------------------|
| What does this plugin do? | This README §What this plugin does | [PRD-015](../../docs/prd/PRD-015.md) |
| How do I install/use it? | This README §Available commands | `skills/help/SKILL.md` |
| How do I deploy? | `skills/help/SKILL.md` | `instructions/deploy-runbook.md` <!-- pending: TDD-026 --> |
| How do I work with chains? | `skills/help/SKILL.md` | `instructions/chains-runbook.md` <!-- pending: TDD-026 --> |
| How do I configure cred-proxy? | `skills/help/SKILL.md` | `instructions/cred-proxy-runbook.md` <!-- pending: TDD-025 --> |
| How do I work with the firewall? | `skills/help/SKILL.md` | `instructions/firewall-runbook.md` <!-- pending: TDD-025 --> |
| How do I onboard to cloud? | `skills/onboarding/SKILL.md` | `instructions/cloud-prompt-tree.md` <!-- pending: TDD-027 --> |
| Why did my deploy fail? | `skills/troubleshoot/SKILL.md` | `instructions/runbook.md#deploy-failure-modes` |
| How do I run evals locally? | This README §How to run evals | `evals/eval-config.yaml`, `commands/eval.md` |
| Where is the decomposition rationale? | This README §footer | [PRD-015 §Decomposition](../../docs/prd/PRD-015.md#decomposition) |
```

#### Decomposition footer

```markdown
---

This plugin's current capabilities were authored under
[PRD-015](../../docs/prd/PRD-015.md). For decomposition rationale and the
four-TDD breakdown (TDD-025, TDD-026, TDD-027, TDD-028), see
[PRD-015 §Decomposition](../../docs/prd/PRD-015.md#decomposition).
```

### Validation procedure

1. `markdownlint plugins/autonomous-dev-assist/README.md` — assert 0 violations.
2. Count "What this plugin does" bullets — assert 7.
3. Count "How to run evals" points — assert 6.
4. Count "Project structure" entries — assert 14 (combining files + relevant directories per the existing convention).
5. Count "Document map" rows — assert 10.
6. Diff the unchanged sections ("Available commands", first 3 "What this plugin does" bullets) — assert bit-identical or only minimal tone harmonization captured explicitly.
7. `git diff -- README.md | grep -E '(commit [0-9a-f]{7,}|@[0-9a-f]{40}|sha: [0-9a-f]{7,})'` — assert 0 matches.
8. The full markdown-link-check sweep + walkthrough is owned by SPEC-028-4-03; this spec only asserts the local structure is correct.

## Acceptance Criteria

```
Given README.md is updated
When markdownlint runs
Then exit code is 0
```

```
Given the "What this plugin does" section
When bullets are counted
Then the count is exactly 7
And each bullet is ≤ 180 characters
And no bullet contains "powerful", "seamless", "amazing", or any exclamation point
And the first 3 bullets are bit-identical to pre-edit state (or only minimally tone-harmonized with the harmonization captured in the PR diff)
```

```
Given the "How to run evals" section
When points are counted
Then the count is exactly 6
And point 1 references the per-PR single-suite invocation pattern with at least one suite name argument
And point 2 references the nightly --suite all invocation
And point 3 references evals/schema/eval-case-v1.json
And point 4 references the 5-negative-case floor
And point 5 references the 80%/95% threshold split via per_suite_overrides
And point 6 references the results JSON path
```

```
Given the "Project structure" section
When entries are counted
Then the count is exactly 14
And the 8 pre-existing entries are bit-identical
And the 6 new entries are: chains-runbook.md, deploy-runbook.md, cred-proxy-runbook.md, firewall-runbook.md, cloud-prompt-tree.md, eval-case-v1.json (plus the 4 new test-cases YAMLs that count toward the 14)
And the sibling-pending entries are marked with <!-- pending: TDD-XXX --> HTML comments
```

```
Given the new "Document map" H2
When the table is parsed
Then it has 10 data rows (excluding header)
And every cell with a path resolves to a repo-relative path
And every cell with an anchor uses #kebab-case form
And no cell contains an external (https://) URL except those that already exist in the README pre-edit
And sibling-pending destinations are marked with <!-- pending: TDD-XXX -->
```

```
Given the decomposition footer
When inspected
Then it is preceded by a "---" separator
And it begins with "This plugin's current capabilities were authored under"
And it contains a Markdown link to PRD-015 (anchor #decomposition)
And it names all four sibling TDDs (TDD-025, TDD-026, TDD-027, TDD-028)
And no part of the footer references a commit SHA
```

```
Given the "Available commands" section
When inspected
Then it is bit-identical to its pre-edit state
And it lists exactly 3 commands
```

```
Given the diff of README.md
When grep'd for SHA-style references
Then `grep -E '(commit [0-9a-f]{7,}|@[0-9a-f]{40}|sha: [0-9a-f]{7,})'` returns 0 matches
```

```
Given a Document-Map row marked <!-- pending: TDD-026 -->
When the markdown-link-checker (per SPEC-028-4-03) runs with the pending-marker config
Then the link is skipped (not flagged as broken)
And the row remains in the table
```

```
Given an operator reads the README from top to bottom
When they encounter the "Document map"
Then they can identify, within 30 seconds, the row matching their question type
And the row's "procedural deep-dive" cell directs them to the canonical answer source
```

```
Given any of the 4 new sibling-runbook files lands on main
When this README is updated to remove the corresponding <!-- pending: --> marker
Then the diff is exactly the marker removal (no other content change)
```

## Test Requirements

- **Markdown lint**: 0 violations.
- **Bullet count**: 7 in What-this-plugin-does; 6 in How-to-run-evals; 14 in Project-structure; 10 rows in Document-map.
- **Length cap**: All "What this plugin does" bullets ≤ 180 chars.
- **Pre-existing-content stability**: "Available commands" diff is empty; first 3 What-this-plugin-does bullets diff is empty (or minimally tone-harmonized with the harmonization explicitly noted).
- **Cross-ref hygiene**: 0 SHA-style hits in the diff.
- **Pending-marker correctness**: every sibling-owned destination is marked `<!-- pending: TDD-XXX -->`.
- **Markdown-link-check** + walkthrough: covered by SPEC-028-4-03.

## Implementation Notes

- TDD-028 §7.2 is the canonical source of bullet wording. If §7.2 differs from this spec's draft wording, prefer §7.2 verbatim.
- The 80%/95% threshold split language MUST match SPEC-028-1-03's `per_suite_overrides` exactly. The "security/cost-critical" labeling is from TDD-028 — the security-critical surfaces are cred-proxy and firewall; deploy is cost-critical (failed deploys are expensive). Chains is also a 95% gate per TDD-028 §6.2 — verify and reflect.
- The Document Map's "Why did my deploy fail?" row points to `instructions/runbook.md#deploy-failure-modes` — verify that anchor exists in the existing 1263-line runbook.md before merging. If it does NOT exist, change the destination to a sibling-pending `instructions/deploy-runbook.md` and add the pending marker.
- The PRD-015 anchor (`#decomposition`) is a placeholder; verify the actual anchor in PRD-015 before authoring.
- Tone-harmonization of pre-existing bullets is permitted ONLY if explicitly captured in the PR diff with a one-line rationale per change. Do NOT silently rewrite existing prose.
- The "Available commands" section is regression-stable. Do not edit it.

## Rollout Considerations

- README rewrite is a single-file diff; trivially revertible.
- Sibling-pending markers ensure the markdown-link-checker tolerates the partial state (until TDD-025/026/027 land their files).
- After each sibling TDD lands, a one-line PR removes the corresponding `<!-- pending: -->` marker.
- No runtime impact (README is reference content only).

## Dependencies

- **Blocked by**: SPEC-028-1-01 (schema reference), SPEC-028-1-02 (meta-lint reference), SPEC-028-1-03 (per_suite_overrides + invocation order references), SPEC-028-2-01/02 (chains/deploy yaml entries), SPEC-028-3-01/02 (cred-proxy/firewall yaml entries), SPEC-028-4-01 (agent-count consistency for narrative coherence — soft dep).
- **Exposes to**: SPEC-028-4-03 (consumes README structure for SHA sweep, link-check, walkthrough, tone-parity); sibling TDD-025/026/027 (each removes its pending marker when its files land).

## Out of Scope

- Authoring the runbook See-also index — owned by SPEC-028-4-03.
- Authoring the four sibling runbook files — owned by TDD-025/TDD-026.
- Authoring `cloud-prompt-tree.md` — owned by TDD-027.
- SHA-pinning sweep, tone-parity review, link-check, walkthrough — owned by SPEC-028-4-03.
- Modifying the existing 90 reviewer-eval cases or the four existing assist suites (regression-stable per NG-07).
- Updating `commands/eval.md` — owned by SPEC-028-1-03 task (PLAN-028-1 task 7).
- Adding new agents or commands (per TDD-028 NG-04, NG-05).
