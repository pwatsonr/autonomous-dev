# SPEC-026-2-02: quickstart.md --with-cloud Flag

## Metadata
- **Parent Plan**: PLAN-026-2
- **Parent TDD**: TDD-026
- **Tasks Covered**: PLAN-026-2 Task 4 (`--with-cloud` argument plumbing)
- **Estimated effort**: 2 hours
- **Status**: Draft
- **Author**: Specification Author (TDD-026 cascade)
- **Date**: 2026-05-02

## Summary
Add an optional `--with-cloud` argument to `plugins/autonomous-dev-assist/commands/quickstart.md` (PRD-015 FR-1524, TDD-026 §6.3). When the flag is present, the quickstart inserts a single deferred-bridge line after Step 4 (start the daemon) pointing operators at the setup-wizard cloud-onboarding flow owned by TDD-027. When the flag is absent, the existing local-only quickstart flow is unchanged. This spec implements ONLY the entry-point and the missing-plugin install hint; the wizard's per-cloud phase content is TDD-027 §5.

## Functional Requirements

| ID    | Requirement                                                                                                                                                                                            |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1  | An "Argument" or "Flags" section MUST appear at the top of `commands/quickstart.md` (above Step 1) listing `--with-cloud (optional)` with a one-line description: "Surface the cloud deploy onboarding bridge after the daemon starts." |
| FR-2  | Argument parsing logic in the prompt MUST recognize `--with-cloud` and set an internal flag the rest of the prompt consults. (The prompt is a Claude prompt, not a script — the "parsing" is a documented instruction the model follows.) |
| FR-3  | After Step 4 ("start the daemon" or its existing equivalent — verify exact heading via Read), a NEW conditional block MUST be inserted that fires ONLY when `--with-cloud` is present.                  |
| FR-4  | The conditional block's primary line MUST contain the verbatim string: `For cloud deploy onboarding, run /autonomous-dev-assist:setup-wizard --with-cloud`.                                            |
| FR-5  | The conditional block MUST include a missing-plugin guard that detects whether any of `autonomous-dev-deploy-{gcp,aws,azure,k8s}` are installed. If none are installed, output the install hint: `If the autonomous-dev-deploy-{gcp,aws,azure,k8s} plugins are not installed, the setup-wizard will offer to install them; see TDD-027 §5 (when published).` |
| FR-6  | When `--with-cloud` is ABSENT, the existing quickstart content from Step 1 through the file end MUST remain BYTE-IDENTICAL to its pre-spec state EXCEPT for the new top-of-file argument documentation block.  |
| FR-7  | The reference to `TDD-027 §5` MUST use the section-anchor form (no SHA pin, no commit hash).                                                                                                            |
| FR-8  | The new content MUST contain zero matches for the SHA-pin regex.                                                                                                                                        |
| FR-9  | The argument MUST be optional. The default behavior (no flag) MUST continue to work for local-only operators who have no cloud plugins installed.                                                       |

## Non-Functional Requirements

| Requirement                  | Target                | Measurement                                                                       |
|------------------------------|------------------------|-----------------------------------------------------------------------------------|
| File size growth             | < +20 lines           | `wc -l` after vs. before                                                          |
| markdownlint pass            | 0 errors              | `markdownlint commands/quickstart.md`                                             |
| markdown-link-check pass     | 0 broken links        | `markdown-link-check commands/quickstart.md`                                      |
| Local-flow regression        | 0 changes Steps 1-end | `diff <(git show HEAD~1:.../quickstart.md) <(awk after Step 1 line)` empty diff  |
| Manual smoke (with flag)     | bridge line appears   | Run `/autonomous-dev-assist:quickstart --with-cloud` post-merge; confirm output    |
| Manual smoke (without flag)  | bridge line absent    | Run `/autonomous-dev-assist:quickstart`; confirm no bridge line                    |

## Technical Approach

### File modified
- `plugins/autonomous-dev-assist/commands/quickstart.md`

### Procedure
1. **Read** the file. Locate the existing argument-documentation pattern (if any) and Step 4's exact heading. The file is 124 lines per TDD-026 §3.3.
2. **Insert** the argument documentation block at the top of the file, immediately after any existing intro or "Arguments" header. If no Arguments section exists, create a `## Arguments` H2 between the file header and Step 1.
3. **Insert** the conditional block immediately AFTER Step 4's content and BEFORE Step 5 (or before any concluding content if Step 5 does not exist). Verify the insertion point during Read.
4. **Validate**: ensure Steps 1-4 are unchanged (FR-6).

### Argument-doc template (illustrative)

```markdown
## Arguments

| Flag           | Required | Description                                                                              |
|----------------|----------|------------------------------------------------------------------------------------------|
| `--with-cloud` | No       | Surface the cloud deploy onboarding bridge after the daemon starts. See Step 4 below.    |
```

### Conditional block template (illustrative — to be inserted after Step 4)

```markdown
### Step 4a — Cloud onboarding bridge (if `--with-cloud`)

If the user invoked this command with `--with-cloud`:

> For cloud deploy onboarding, run `/autonomous-dev-assist:setup-wizard --with-cloud`

If the `autonomous-dev-deploy-{gcp,aws,azure,k8s}` plugins are not installed,
the setup-wizard will offer to install them; see TDD-027 §5 (when published)
for the full flow.

If the user did NOT pass `--with-cloud`, skip this step entirely and continue
with the existing local-only quickstart.
```

### TDD-027 cross-reference
The link `TDD-027 §5` is rendered as plain text (NOT a Markdown link with URL) because TDD-027 has not been authored yet. This is acceptable per FR-7 — the section-anchor form is preserved for when the link is wired in TDD-027's plan.

## Interfaces and Dependencies
- **Consumes**: nothing additional. This is a self-contained extension.
- **Produces**: The hook that TDD-027's setup-wizard `--with-cloud` extension consumes when it lands. The setup-wizard prompt itself is out of scope here.
- **No code dependencies.**

## Acceptance Criteria

### Argument documented at top
```
Given commands/quickstart.md
When the file is read top-to-bottom
Then within the first 30 lines an "Arguments" section (H2 or table heading) appears
And that section contains a row or bullet for "--with-cloud"
And the description contains either "optional" or "Surface the cloud deploy onboarding bridge"
```

### Conditional block placement
```
Given the file
When the line numbers of "## Step 4" or "### Step 4" and the next sibling step heading are identified
Then a new heading or paragraph block exists strictly between them OR immediately after Step 4 closes
And that block contains the literal string "For cloud deploy onboarding, run /autonomous-dev-assist:setup-wizard --with-cloud"
```

### Conditional execution wording
```
Given the conditional block
When read
Then it contains the substring "If the user invoked this command with --with-cloud" OR equivalent guard wording
And it contains a clear "skip this step" instruction for the absence path
```

### Missing-plugin install hint
```
Given the conditional block
When searched for "autonomous-dev-deploy-{gcp,aws,azure,k8s}"
Then ≥ 1 match
And the same block contains "TDD-027 §5"
And the same block contains "not installed"
```

### Existing flow unchanged
```
Given the file
When git diff is run between HEAD~1 (pre-spec) and HEAD (post-spec)
Then the only added lines are within the new Arguments section AND the new conditional block
And no line within the existing Step 1, Step 2, Step 3, Step 4 (or final Step) bodies is modified or removed
```

### TDD-027 reference uses section-anchor form
```
Given the file
When all references to "TDD-027" are extracted
Then every reference contains "§" followed by a number
And no reference contains a 7+ hex-char commit-SHA-like token
```

### No SHA pinning
```
Given the file
When the SHA-pin regex grep is run
Then 0 matches
```

### markdownlint and link checker
```
Given the file
When markdownlint is run
Then exit 0

When markdown-link-check is run
Then exit 0 (the TDD-027 plain-text reference is not a hyperlink, so the checker does not flag it)
```

### Manual smoke (post-merge)
```
Given a post-merge environment with the daemon installed and no cloud plugins
When the operator runs "/autonomous-dev-assist:quickstart --with-cloud"
Then the response includes the literal "For cloud deploy onboarding, run /autonomous-dev-assist:setup-wizard --with-cloud"
And the response includes the install-hint reference to "autonomous-dev-deploy-{gcp,aws,azure,k8s}"

When the same operator runs "/autonomous-dev-assist:quickstart" (no flag)
Then the response does NOT include "For cloud deploy onboarding"
And the response does NOT include "setup-wizard --with-cloud"
```

## Test Requirements
- **Doc smoke (deferred to SPEC-026-2-04)**: SPEC-026-2-04's smoke script asserts the argument is documented and the conditional bridge line is present in the file source.
- **Local validation during implementation**:
  - `grep "For cloud deploy onboarding" commands/quickstart.md` → exit 0
  - `grep "TDD-027 §5" commands/quickstart.md` → exit 0
  - `grep -E "(commit\s+[a-f0-9]{7,40}|as of [a-f0-9]{7,40})" commands/quickstart.md` → exit 1
- **Manual smoke**: Run with and without the flag (see acceptance criteria); record both transcripts in PR description.

## Implementation Notes
- The `quickstart.md` file is a Claude prompt. The "argument parsing" is a documented instruction that the model interprets when it reads the prompt — there is no executable code to write.
- Mirror the existing argument-handling pattern in `commands/assist.md` (TDD-026 §6.3 cites it as the model). If `commands/assist.md` uses a top-of-file "Arguments" table, replicate that style here. If it uses a different convention (e.g., inline parenthetical), follow that convention to maintain stylistic consistency.
- The bridge line must be inserted such that markdown rendering produces a clear visual break between Step 4 and Step 5 (use a `### Step 4a` H3 sub-heading or a clear horizontal-rule separator).
- DO NOT include any cloud-specific content (cred-proxy, firewall, dry-run details). That is TDD-027's territory. This spec is the entry-point ONLY.

## Rollout Considerations
- No flag. Backward-compatible by design (the new arg is optional).
- Rollback: `git revert`. Operators who relied on the bridge line lose only that single line.
- Forward compatibility: when TDD-027 ships its setup-wizard extension, the bridge line becomes a working pointer. Until then it is a documented hand-off path that resolves manually.

## Effort Estimate
- Read baseline + locate insertion point: 0.5 hours
- Author argument doc + conditional block: 1 hour
- Validation + manual smoke transcripts: 0.5 hours
- **Total: 2 hours**
