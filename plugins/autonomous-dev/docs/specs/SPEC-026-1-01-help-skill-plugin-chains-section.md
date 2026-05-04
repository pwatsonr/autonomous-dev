# SPEC-026-1-01: help/SKILL.md Plugin Chains Section

## Metadata
- **Parent Plan**: PLAN-026-1
- **Parent TDD**: TDD-026
- **Tasks Covered**: PLAN-026-1 Task 1 (baseline read) + Task 2 (Plugin Chains section authoring)
- **Estimated effort**: 5 hours (1h baseline + 4h authoring)
- **Status**: Draft
- **Author**: Specification Author (TDD-026 cascade)
- **Date**: 2026-05-02

## Summary
Insert a new `## Plugin Chains` H2 section into `plugins/autonomous-dev-assist/skills/help/SKILL.md`, between the existing "Pipeline Phases" H2 and the existing "Trust Levels" H2. The section is the operator quick-reference for TDD-022's chain CLI tree, manifest-v2 schema, and HMAC-chained audit log. It satisfies PRD-015 FR-1502 and is the link target for the chains-runbook §8 cross-reference (PLAN-026-2). This spec is documentation-only; no executable behavior changes.

## Functional Requirements

| ID     | Requirement                                                                                                                                                                                  | Task |
|--------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1   | The new H2 section MUST be titled exactly `## Plugin Chains` and inserted immediately after the existing `## Pipeline Phases` H2 and immediately before the existing `## Trust Levels` H2. | T2   |
| FR-2   | The H2 MUST open with the `*Topic:* chains` marker on the line immediately following the H2 heading (TDD-026 §11.3 SKILL section contract).                                                 | T2   |
| FR-3   | The H2 MUST contain six H3 subsections in this exact order: `### What chains are`, `### The four chain commands`, `### The audit log`, `### Manifest-v2 fields`, `### When chains pause`, `### See also`. | T2   |
| FR-4   | Every H3 subsection MUST be ≤ 30 lines (heading line inclusive, blank lines inclusive).                                                                                                      | T2   |
| FR-5   | `### What chains are` MUST contain a one-paragraph conceptual definition that cites `TDD-022 §1` using the section-anchor form (no SHA pinning).                                              | T2   |
| FR-6   | `### The four chain commands` MUST contain a Markdown table with one row per CLI subcommand: `chains list`, `chains graph`, `chains audit verify`, `chains approve\|reject REQ-NNNNNN`.       | T2   |
| FR-7   | `### The audit log` MUST contain the file path `~/.autonomous-dev/chains/audit.log`, the env-var name `CHAINS_AUDIT_KEY`, and the verbatim warning string `do NOT delete the audit log`.     | T2   |
| FR-8   | `### Manifest-v2 fields` MUST list the three optional plugin.json fields `produces`, `consumes`, `egress_allowlist` with a JSON code block example.                                          | T2   |
| FR-9   | `### When chains pause` MUST enumerate three pause causes (cycle detected, HMAC mismatch, approval pending) and the corresponding next-step CLI command for each.                            | T2   |
| FR-10  | `### See also` MUST contain at least one Markdown link to `../../instructions/chains-runbook.md` and at least one Markdown link of the form `TDD-022 §M Section-Title`.                       | T2   |
| FR-11  | The new content MUST NOT contain any string matching the regex `(commit\s+[a-f0-9]{7,40}\|as of [a-f0-9]{7,40}\|fixed in [a-f0-9]{7,40})` (TDD-026 §8 anchor convention).                   | T2   |
| FR-12  | The new content MUST NOT contain any of these negative-bag strings as positive guidance: `chains rotate-key`, `chains delete`, `manifest-v1` (except inside a "do NOT" sentence), `audit.json`. | T2   |
| FR-13  | The PR description MUST record the baseline line count of `help/SKILL.md` BEFORE this spec lands and the new line count AFTER (Task 1 deliverable).                                          | T1   |

## Non-Functional Requirements

| Requirement                                  | Target                | Measurement Method                                                          |
|----------------------------------------------|------------------------|------------------------------------------------------------------------------|
| Section size budget                          | ≤ 200 lines total      | `awk '/^## Plugin Chains/,/^## Trust Levels/' help/SKILL.md \| wc -l`        |
| Read-step latency contribution               | ≤ 250 ms               | Time `Read` of help/SKILL.md before/after; difference < 250 ms (TDD-026 §13) |
| markdownlint pass                            | 0 errors               | `markdownlint plugins/autonomous-dev-assist/skills/help/SKILL.md`            |
| markdown-link-check pass                     | 0 broken links         | `markdown-link-check plugins/autonomous-dev-assist/skills/help/SKILL.md`     |
| File total size                              | < 600 lines after spec | `wc -l` (baseline 385 + ≤ 200 new = ≤ 585)                                   |

## Technical Approach

### Files modified
- `plugins/autonomous-dev-assist/skills/help/SKILL.md` (insert one H2 block; existing content untouched)

### Insertion procedure
1. `Read` the file. Locate the exact line of `## Pipeline Phases` and the exact line of `## Trust Levels`. The insertion point is the blank line immediately preceding `## Trust Levels`.
2. Use `Edit` with `old_string` set to a unique anchor (the last paragraph of the "Pipeline Phases" section plus the blank line plus the `## Trust Levels` heading) and `new_string` set to the same anchor with the new `## Plugin Chains` block inserted between the blank line and `## Trust Levels`.
3. Do NOT modify the existing "Pipeline Phases" or "Trust Levels" content.

### Section template (illustrative — author the final wording during implementation)

```markdown
## Plugin Chains

*Topic:* chains

Plugin chains let one plugin consume the artifacts another emits. The chain
executor (TDD-022 §1 Plugin Chaining Engine) topologically orders plugins by
their declared `produces`/`consumes` types and runs each in a sandboxed worker.

### What chains are
[1-paragraph definition citing TDD-022 §1 — Plugin Chaining Engine]

### The four chain commands

| Command                                  | Purpose                                       |
|------------------------------------------|-----------------------------------------------|
| `chains list`                            | Enumerate registered chain-aware plugins      |
| `chains graph`                           | Render the dependency DAG                     |
| `chains audit verify`                    | HMAC-validate the chain audit log             |
| `chains approve\|reject REQ-NNNNNN`      | Resolve a pending approval gate               |

### The audit log
- Path: `~/.autonomous-dev/chains/audit.log`
- Integrity: HMAC-chained — each entry depends on the previous entry's HMAC.
- Key custody: env var `CHAINS_AUDIT_KEY` (no rotation command exists in TDD-022 §13).
- **WARNING: do NOT delete the audit log.** The record is irrecoverable; if you
  hit a verification failure, see chains-runbook §3 Audit Verification.

### Manifest-v2 fields
Each plugin's `.claude-plugin/plugin.json` may declare:

```json
{
  "produces": ["findings/security"],
  "consumes": ["source/code"],
  "egress_allowlist": ["api.example.com:443"]
}
```

See TDD-022 §5 Plugin Manifest Extensions.

### When chains pause

| Cause                  | Next step                                                          |
|------------------------|---------------------------------------------------------------------|
| Cycle detected         | `chains graph` to find the loop; remove or split offending plugin   |
| HMAC mismatch          | `chains audit verify --shadow`; do NOT delete the log               |
| Approval pending       | `chains approve REQ-NNNNNN` or `chains reject REQ-NNNNNN`           |

### See also
- [chains-runbook.md](../../instructions/chains-runbook.md) — operator deep-dive
- [TDD-022 §5 Plugin Manifest Extensions](../../../autonomous-dev/docs/tdd/TDD-022-plugin-chaining-engine.md#5-plugin-manifest-extensions)
- [TDD-022 §13 Audit Log](../../../autonomous-dev/docs/tdd/TDD-022-plugin-chaining-engine.md#13-audit-log)
```

The implementer may rephrase the prose, but every Required element above (FR-2 through FR-10) MUST be present.

### Anchor-convention enforcement
Before committing, run:
```bash
grep -nE '(commit\s+[a-f0-9]{7,40}|as of [a-f0-9]{7,40}|fixed in [a-f0-9]{7,40})' \
  plugins/autonomous-dev-assist/skills/help/SKILL.md
```
The command MUST exit with status 1 (no matches) — this is FR-11.

## Interfaces and Dependencies
- **Consumes**: TDD-022 anchors §1, §5, §13 (must remain stable in the upstream TDD).
- **Produces**: A stable H2 anchor `#plugin-chains` that PLAN-026-2 chains-runbook §8 and PLAN-026-3 deploy-runbook §8 link to.
- **No code dependencies.** Markdown only.

## Acceptance Criteria

### Section presence
```
Given the file plugins/autonomous-dev-assist/skills/help/SKILL.md
When grep -n "^## Plugin Chains$" is run against it
Then exactly one match is returned
And the matched line number is greater than the line number of "^## Pipeline Phases$"
And the matched line number is less than the line number of "^## Trust Levels$"
```

### Topic marker
```
Given the new ## Plugin Chains section
When the line immediately following the H2 heading is read (skipping a single blank line)
Then it equals exactly "*Topic:* chains"
```

### H3 subsections present in order
```
Given the new section
When all "^### " lines between "## Plugin Chains" and "## Trust Levels" are extracted
Then the resulting sequence is exactly:
  ### What chains are
  ### The four chain commands
  ### The audit log
  ### Manifest-v2 fields
  ### When chains pause
  ### See also
```

### Subsection size budget
```
Given each H3 subsection
When its line count is measured (heading line through the line before the next H3 or H2)
Then the count is ≤ 30
```

### Audit-log safety string
```
Given the ### The audit log subsection
When the section body is searched for the literal string "do NOT delete the audit log"
Then exactly one match is found
```

### Manifest-v2 JSON example
```
Given the ### Manifest-v2 fields subsection
When the section is parsed for fenced code blocks marked ```json
Then at least one block exists
And the block contains the keys "produces", "consumes", "egress_allowlist"
```

### See-also cross-links
```
Given the ### See also subsection
When all Markdown links are extracted
Then at least one link target ends with "instructions/chains-runbook.md"
And at least one link target matches the pattern "TDD-022.*\.md#"
```

### Anchor-convention compliance
```
Given the modified file
When grep -E '(commit\s+[a-f0-9]{7,40}|as of [a-f0-9]{7,40}|fixed in [a-f0-9]{7,40})' is run
Then zero matches are returned
```

### Negative-bag absence
```
Given the new section
When grep -E '(chains rotate-key|chains delete|audit\.json)' is run against just the section
Then zero matches are returned
And the literal "manifest-v1" appears only inside a sentence beginning with "do NOT"
```

### markdownlint
```
Given the modified file
When markdownlint is run with the existing repo config
Then exit code is 0
```

### markdown-link-check
```
Given the modified file
When markdown-link-check is run
Then exit code is 0
And every link in the new section resolves
```

### Baseline record (Task 1)
```
Given the PR description
When read
Then it contains the literal phrase "Baseline help/SKILL.md line count:" followed by an integer
And it contains "After SPEC-026-1-01 line count:" followed by an integer
And the second integer is greater than the first by between 80 and 200
```

## Test Requirements
- **Doc smoke (deferred to SPEC-026-1-04)**: SPEC-026-1-04 asserts section presence and safety strings. This spec produces the content; the smoke test in SPEC-026-1-04 enforces it.
- **Spec-local checks (run during implementation)**:
  - `grep -c "^### " <section>` returns 6.
  - `grep "do NOT delete the audit log" <section>` returns 1.
  - `markdownlint` and `markdown-link-check` exit 0.
- **Manual review**: A reviewer reads the section in rendered Markdown and confirms the table renders correctly and the JSON fence is highlighted.

## Implementation Notes
- Use one `Edit` call with a unique multi-line `old_string` to avoid ambiguity. Do NOT use `replace_all`.
- Read both `Pipeline Phases` and `Trust Levels` sections in full first to confirm the exact whitespace pattern between them.
- The cross-link path `../../../autonomous-dev/docs/tdd/TDD-022-plugin-chaining-engine.md` assumes the standard repo layout; verify the file exists before committing. If the upstream TDD filename differs (e.g., suffix `-engine` vs `-chaining`), use the actual filename.
- Do NOT touch any other section in the file. Subsequent specs (SPEC-026-1-02, SPEC-026-1-03) will modify other parts; tight insertion scope keeps merge conflicts minimal.

## Rollout Considerations
- No feature flag. Markdown content is loaded lazily by the `assist` command; questions that don't trigger the chains category never read this section.
- Rollback: revert the single commit; baseline behavior (no chains content) returns immediately.

## Effort Estimate
- Coding/authoring: 4 hours
- Baseline reading + PR-description note: 1 hour
- **Total: 5 hours**
