# SPEC-028-4-01: skills/help/SKILL.md Agent-Count Bump (13→18) and Decomposition One-Liner

## Metadata
- **Parent Plan**: PLAN-028-4
- **Parent TDD**: TDD-028 §7.1, FR-1501, FR-1542
- **Tasks Covered**: PLAN-028-4 task 1 (agent-count bump), task 7 (decomposition one-liner in SKILL.md)
- **Estimated effort**: 1.75 hours
- **Status**: Draft

## Summary
Update `plugins/autonomous-dev-assist/skills/help/SKILL.md` "Available agents"
table from 13 rows to 18, sourcing each new row's description verbatim from the
five reviewer-agent files added by TDD-020 (`standards-meta-reviewer`,
`qa-edge-case-reviewer`, `ux-ui-reviewer`, `accessibility-reviewer`,
`rule-set-enforcement-reviewer`). Update any other "13 agents" prose references
in the same file. Append a one-line decomposition acknowledgement near the top
referencing PRD-015 by anchor.

## Functional Requirements

| ID | Requirement | Task |
|----|-------------|------|
| FR-1 | The "Available agents" table in `plugins/autonomous-dev-assist/skills/help/SKILL.md` MUST contain exactly 18 data rows (excluding header row). | T1 |
| FR-2 | Five new rows MUST be added: `standards-meta-reviewer`, `qa-edge-case-reviewer`, `ux-ui-reviewer`, `accessibility-reviewer`, `rule-set-enforcement-reviewer`. | T1 |
| FR-3 | Each new row MUST have three columns: `<agent name> | <description from agent frontmatter, verbatim or summarized to ≤80 chars> | <pipeline phase>`. | T1 |
| FR-4 | If an agent's frontmatter `description:` exceeds 80 chars, the table cell MUST contain a faithful summary AND the verbatim source MUST appear as an HTML comment immediately below the table row. | T1 |
| FR-5 | The 13 existing rows MUST be bit-identical (no edits to existing agent descriptions or pipeline-phase columns). | T1 |
| FR-6 | Any prose reference to "13 agents" elsewhere in `skills/help/SKILL.md` MUST be updated to "18 agents". | T1 |
| FR-7 | A one-line decomposition acknowledgement MUST be appended near the top of the file (after the file's existing intro paragraph, before any H2): "This plugin was extended under PRD-015 to cover plugin chains, deployment backends, cloud onboarding, credential proxy, and egress firewall. See [PRD-015](../../docs/prd/PRD-015.md#decomposition) for the four-TDD breakdown." | T7 |
| FR-8 | The decomposition cross-reference MUST use anchor-only convention; no SHA pinning (FR-1540). | T7 |
| FR-9 | The agent-count number in the table heading or section heading (if any pre-existing pattern like "## Available agents (13)") MUST be updated to 18. | T1 |
| FR-10 | The five new agent files at `plugins/autonomous-dev/agents/<name>.md` MUST exist before this spec is implementable. If any are missing at implementation time, the implementer MUST escalate to TDD-020 owners and pause this spec. | T1 (precondition) |

## Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| Markdown validity | `markdownlint` returns 0 violations | `markdownlint plugins/autonomous-dev-assist/skills/help/SKILL.md` |
| Table-row count parity | Count of agent files under `plugins/autonomous-dev/agents/*.md` matches table data-row count (both 18) | `ls plugins/autonomous-dev/agents/*.md \| wc -l` and table row count |
| Description fidelity | Each new row's description matches the source agent's frontmatter `description:` byte-for-byte (or, if summarized, the HTML comment below preserves the verbatim source) | Manual diff per row |
| Cross-ref hygiene | 0 SHA-style references in changed file content | `git diff -- plugins/autonomous-dev-assist/skills/help/SKILL.md \| grep -E '[0-9a-f]{7,}'` returns no commit-style hits |
| Pre-existing content stability | Diff of the 13 existing rows = 0 lines | `git diff` shows changes only in the 5 added rows + count references + decomposition one-liner |
| Tone parity | New rows use the same prose style as the existing 13 (terse, no marketing prose, no exclamation points) | Standards-reviewer agent confirmation in SPEC-028-4-03 |

## Files to Modify

- **Path**: `plugins/autonomous-dev-assist/skills/help/SKILL.md`
  - **Action**: Modify
  - **Description**: Add 5 table rows; update agent-count references; append decomposition one-liner.

## Technical Approach

### Pre-implementation read

1. Read `plugins/autonomous-dev-assist/skills/help/SKILL.md` to identify:
   - Current location of the "Available agents" table
   - Current section heading (e.g., `## Available agents` or `## Agents (13)`)
   - Current header row column count and column names
   - Any prose mention of "13 agents" or similar
   - Best location for the decomposition one-liner (after intro paragraph; before first H2)
2. Read each of the five new agent files for frontmatter `description:`:
   - `plugins/autonomous-dev/agents/standards-meta-reviewer.md`
   - `plugins/autonomous-dev/agents/qa-edge-case-reviewer.md`
   - `plugins/autonomous-dev/agents/ux-ui-reviewer.md`
   - `plugins/autonomous-dev/agents/accessibility-reviewer.md`
   - `plugins/autonomous-dev/agents/rule-set-enforcement-reviewer.md`
3. For each agent, also identify the pipeline phase (commonly stated in the agent file's body or frontmatter `phase:` if present; otherwise infer from the agent's sibling rows in the existing table).

### Diff shape

```diff
@@ skills/help/SKILL.md @@
 # ... existing intro paragraph ...

+This plugin was extended under PRD-015 to cover plugin chains, deployment
+backends, cloud onboarding, credential proxy, and egress firewall. See
+[PRD-015](../../docs/prd/PRD-015.md#decomposition) for the four-TDD breakdown.
+
 ## Available agents
 
 | Agent | Description | Pipeline phase |
 |-------|-------------|----------------|
 | <existing 13 rows unchanged> | ... | ... |
+| standards-meta-reviewer | <description from frontmatter> | <phase> |
+| qa-edge-case-reviewer | <description from frontmatter> | <phase> |
+| ux-ui-reviewer | <description from frontmatter> | <phase> |
+| accessibility-reviewer | <description from frontmatter> | <phase> |
+| rule-set-enforcement-reviewer | <description from frontmatter> | <phase> |
```

If a description exceeds 80 chars, the row body uses a summary and an HTML
comment is added below the row preserving the verbatim source:

```markdown
| accessibility-reviewer | Validates a11y of designs and code (WCAG 2.1 AA). | Review |
<!-- verbatim: Validates accessibility of designs and code against WCAG 2.1 AA, focusing on color contrast, keyboard navigation, semantic HTML, and ARIA correctness. -->
```

### Agent-count reference update

Search the file for:
- Numeric "13" near the word "agents"
- Headings like `## Agents (13)` or table captions

Update each to "18". Capture the exact diff in the PR description.

### Decomposition one-liner placement

Place after the file's existing intro paragraph (likely 2-5 lines below the H1)
and before the first H2. The one-liner is a single paragraph with one
cross-reference. Visually separated from surrounding paragraphs by a blank line
above and below.

### Validation procedure

1. Run `markdownlint plugins/autonomous-dev-assist/skills/help/SKILL.md`; assert 0 violations.
2. Run `ls plugins/autonomous-dev/agents/*.md | wc -l`; assert 18.
3. Count table data rows: `awk '/^\| [a-z]/' plugins/autonomous-dev-assist/skills/help/SKILL.md | wc -l`; assert ≥ 18 (the file may have other tables; isolate to the agents table by line range).
4. Grep for residual "13 agents" references: `grep -n '13 agents\|(13)' SKILL.md`; assert 0 hits in updated regions.
5. Grep for SHA references in diff: `git diff -- SKILL.md | grep -E '[0-9a-f]{7,}'`; assert no commit-style hits.

## Acceptance Criteria

```
Given skills/help/SKILL.md is updated
When the "Available agents" table is parsed
Then it contains exactly 18 data rows (header excluded)
And the 5 new rows are: standards-meta-reviewer, qa-edge-case-reviewer, ux-ui-reviewer, accessibility-reviewer, rule-set-enforcement-reviewer
And the 13 pre-existing rows are bit-identical to pre-edit state
```

```
Given each of the 5 new rows
When inspected
Then the description column matches the source agent's frontmatter "description:" verbatim (or is a faithful summary with the verbatim source captured in an HTML comment immediately below)
And the pipeline-phase column is non-empty and matches the agent's documented phase
```

```
Given the file's prose
When grep'd for "13 agents" or "(13)"
Then 0 hits remain (all updated to 18)
```

```
Given the agent files under plugins/autonomous-dev/agents/
When counted
Then count == 18
And count matches the table's data-row count
```

```
Given the decomposition one-liner
When inspected
Then it appears after the file's intro paragraph and before the first H2
And it begins with "This plugin was extended under PRD-015"
And it ends with a Markdown link to PRD-015 with anchor "#decomposition" (or the actual anchor used in PRD-015)
And the link target uses repo-relative path (no SHA pinning)
```

```
Given markdownlint runs against the updated file
When invoked with the repo's existing config
Then exit code is 0 (no violations)
```

```
Given a description exceeds 80 characters
When the row is authored
Then the row cell contains a faithful summary
And an HTML comment immediately below the row contains the verbatim source as "<!-- verbatim: ... -->"
```

```
Given the diff of the file
When grep'd for SHA-style references
Then `grep -E '(commit [0-9a-f]{7,}|@[0-9a-f]{40}|sha: [0-9a-f]{7,})'` returns 0 matches
```

```
Given any of the 5 new agent files does NOT exist at implementation time
When the implementer attempts to source the description
Then the implementer escalates to TDD-020 owners
And this spec is paused (no partial commit)
```

```
Given the standards-reviewer agent reviews the changed file
When tone-parity is checked against existing rows
Then the new rows use the same terse declarative prose
And the agent posts an APPROVE comment on the PR
```

## Test Requirements

- **Markdownlint**: 0 violations.
- **Row count**: 18 data rows in the agents table.
- **Filesystem parity**: agent file count under `plugins/autonomous-dev/agents/` equals 18.
- **Verbatim/summary fidelity**: Each new row's description matches source frontmatter byte-for-byte OR has a verbatim HTML comment.
- **Pre-existing-row stability**: Diff over the 13 pre-existing rows is empty.
- **Cross-ref hygiene**: 0 SHA-style hits in the diff.
- **Tone-parity**: standards-reviewer agent (per SPEC-028-4-03) confirms new rows match existing tone.
- **Decomposition one-liner**: present, anchor-only, appears in the prescribed location.

## Implementation Notes

- The 80-char column-width is a Markdown rendering concern (table cell wrapping); the goal is readability without breaking the table layout in plain-text view. If the agent's description is genuinely under 80 chars, no summary is needed.
- If the file does not currently have a section heading like `## Available agents`, the spec assumes the table appears under whatever heading actually exists. Implementer adapts.
- The PRD-015 anchor target ("#decomposition") is a placeholder; verify the actual anchor in PRD-015's heading structure before authoring. If PRD-015 uses a different heading (e.g., "## Decomposition rationale"), use the kebab-case anchor that matches that heading.
- The pipeline-phase column for the five new reviewer agents is most likely "Review" or "Standards-review" or similar — read each agent file's body for the canonical phase name and use it verbatim. Do NOT invent a new phase name.
- Run the SHA grep on the diff (not the whole file) to avoid false positives on pre-existing content the spec did not touch.

## Rollout Considerations

- Single-file change; trivially revertible via `git revert`.
- No runtime impact (SKILL.md is informational/reference content).
- Coordination: this spec depends on TDD-020 having merged the five new agent files. If TDD-020 ships a sixth or seventh agent before this spec lands, the spec author bumps the count and adds rows; do NOT block on TDD-020's exact agent set, but verify the count at implementation time.

## Dependencies

- **Blocked by**: TDD-020 (the five new agent files must exist on `main` before sourcing descriptions).
- **Exposes to**: SPEC-028-4-02 (README "Project structure" entry count assumes 18 agents), SPEC-028-4-03 (tone-parity review covers this file).

## Out of Scope

- Authoring agent files themselves — owned by TDD-020.
- README rewrite — owned by SPEC-028-4-02.
- Runbook See-also + SHA sweep + tone-parity review + link-check + walkthrough — owned by SPEC-028-4-03.
- Modifying agent-file frontmatter to shorten descriptions — out of scope; if an agent's description is too long for the table, summarize in the table and preserve the source as HTML comment, do NOT edit the agent file.
- Bumping any version number in `plugin.json` — owned by PLAN-017-3.
