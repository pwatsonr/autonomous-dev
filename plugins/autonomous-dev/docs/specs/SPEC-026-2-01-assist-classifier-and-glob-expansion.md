# SPEC-026-2-01: assist.md Classifier Extension + Glob Expansion + Step-3 Multi-match

## Metadata
- **Parent Plan**: PLAN-026-2
- **Parent TDD**: TDD-026
- **Tasks Covered**: PLAN-026-2 Task 1 (baseline), Task 2 (Step-1 classifier), Task 3 (Step-2 Glob), Step-3 multi-match instruction
- **Estimated effort**: 4.5 hours
- **Status**: Draft
- **Author**: Specification Author (TDD-026 cascade)
- **Date**: 2026-05-02
- **Depends on**: PLAN-026-1 (the SKILL sections referenced by the new categories must exist for the classifier to load useful context)

## Summary
Extend `plugins/autonomous-dev-assist/commands/assist.md` so the operator-facing assist command routes chain, deploy, and security questions to the SKILL sections authored by PLAN-026-1. This spec adds three new classifier categories (`chains`, `deploy`, `security`) with their canonical keyword bag embedded inline (TDD-026 §4.2 / OQ-6 closed), appends nine new `Glob:` patterns covering chains/deploy/cred-proxy/firewall intake plus four cloud-backend plugins plus the `*-runbook.md` glob, and tweaks Step-3 so multi-category questions load context from ALL matched buckets while zero-match questions fall back to `help`.

## Functional Requirements

### Classifier extension (Task 2)

| ID    | Requirement                                                                                                                                                                                                  |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1  | The Step-1 classifier section MUST list six bullets in document order: `help`, `troubleshoot`, `config`, `chains`, `deploy`, `security`. The first three are existing; the last three are appended.            |
| FR-2  | The exact bullet wording for the three new categories MUST match TDD-026 §6.1 verbatim: `**chains** -- Questions about plugin chains, the manifest-v2 schema, the chain audit log, or chains CLI.` and analogues for deploy/security. |
| FR-3  | Below the bullet list a "Trigger keywords" subsection MUST be added that lists, for each new category, its canonical keyword bag from TDD-026 §4.2: chains (7 keywords), deploy (8 keywords), security (7 keywords). |
| FR-4  | Multi-match MUST be allowed: the classifier instruction MUST state that a question may match multiple categories and that the assist loads context from all matched categories.                              |
| FR-5  | The default-fallback behavior MUST be preserved: a question matching no category falls into `help`. This MUST be stated explicitly in the prompt.                                                            |

### Glob expansion (Task 3)

| ID    | Requirement                                                                                                                                                                                  |
|-------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-6  | The Step-2 Glob list MUST be append-only. No existing `Glob:` line may be removed or reordered.                                                                                              |
| FR-7  | Nine new `Glob:` lines MUST be appended in this exact order: `plugins/autonomous-dev/intake/chains/*`, `plugins/autonomous-dev/intake/deploy/*`, `plugins/autonomous-dev/intake/cred-proxy/*`, `plugins/autonomous-dev/intake/firewall/*`, `plugins/autonomous-dev-deploy-gcp/**`, `plugins/autonomous-dev-deploy-aws/**`, `plugins/autonomous-dev-deploy-azure/**`, `plugins/autonomous-dev-deploy-k8s/**`, `plugins/autonomous-dev-assist/instructions/*-runbook.md`. |
| FR-8  | Each new Glob line MUST follow the existing line format (one `Glob:` token followed by a single space and the pattern, no trailing whitespace).                                              |

### Step-3 multi-match instruction (within Task 2)

| ID    | Requirement                                                                                                                                                                                                                |
|-------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-9  | Step-3 MUST contain the verbatim instruction `If the question matches multiple categories, load context from all matched categories.` (or a phrasing that contains the substrings "multiple categories" and "all matched"). |
| FR-10 | Step-3 MUST contain a fallback instruction stating that when a Glob target is missing (cloud plugin not installed) the assist proceeds with available context AND surfaces an install hint of the form `claude plugin install autonomous-dev-deploy-<backend>` (TDD-026 §12.2). |

### Quality gates

| ID    | Requirement                                                                                                                                                                                                                |
|-------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-11 | The modified `commands/assist.md` MUST contain zero SHA-pin regex matches.                                                                                                                                                  |
| FR-12 | The PR description MUST record (Task 1 deliverable): the baseline classifier-bullet count (3), the baseline `Glob:` line count (an integer), the line ranges of Step-1, Step-2, Step-3, and the existing argument parsing.   |
| FR-13 | The PR description MUST list which of the four cloud-plugin globs return zero file matches today (expected: all four return zero until TDD-025 plugins ship).                                                                |

## Non-Functional Requirements

| Requirement                  | Target                  | Measurement                                                                       |
|------------------------------|--------------------------|-----------------------------------------------------------------------------------|
| File size growth             | < +60 lines             | `wc -l commands/assist.md` after - before                                         |
| markdownlint pass            | 0 errors                | `markdownlint commands/assist.md`                                                 |
| Existing 90-case eval suite  | ≥ 95% pass (regression) | `evals/runner.sh --suite all` against pre-PLAN-026-3 main                         |
| Classifier prompt bloat      | Step-1 ≤ 60 lines       | `awk` between Step-1 heading and Step-2 heading; line count                       |
| Glob reachability            | 5 of 9 globs non-empty  | Bash one-liner: each pattern resolved against repo root; intake + runbook globs match files; cloud-plugin globs return zero (expected per TDD-026 §12.2) |

## Technical Approach

### File modified
- `plugins/autonomous-dev-assist/commands/assist.md`

### Procedure
1. **Read** the current file (87 lines per TDD-026 §3.3). Record the line ranges of Step-1 (classifier), Step-2 (Glob), Step-3 (answer instructions), and the argument-parsing block. Capture in PR body (FR-12).
2. **Append** the three new classifier bullets after the `config` bullet using one `Edit` with the `config` line as `old_string` (last existing classifier line + the trailing context).
3. **Add** the "Trigger keywords" subsection immediately after the classifier bullet list using a second `Edit`. Format as a Markdown table or fenced list — the existing `commands/assist.md` style guides the choice (read first).
4. **Append** the nine new `Glob:` lines at the end of the existing Glob block (one Edit, locating the last existing `Glob:` line as the `old_string` anchor).
5. **Insert** the multi-match and missing-glob fallback instructions into Step-3 using a third Edit.
6. **Verify** all FRs via grep (see Acceptance Criteria).

### Classifier extension template

```markdown
**Step 1 — Classify the question**

Categorize the user's question into one or more of the following categories:

- **help** -- General usage questions about commands, agents, pipeline phases, concepts, or features.
- **troubleshoot** -- Something is broken, failing, or behaving unexpectedly.
- **config** -- Questions about configuration, settings, environment variables, or customization.
- **chains** -- Questions about plugin chains, the manifest-v2 schema, the chain audit log, or chains CLI.
- **deploy** -- Questions about the deploy framework, backends, the approval state machine, the ledger, cost caps, or deploy CLI.
- **security** -- Questions about HMAC keys, audit logs, credential proxy, egress firewall, or denied-permission errors.

A question may match **multiple** categories. When that happens, load context
from **all matched categories**. If no category matches, fall back to `help`.

**Trigger keywords**

| Category   | Keywords                                                                                  |
|------------|-------------------------------------------------------------------------------------------|
| chains     | chain, chains, produces, consumes, manifest-v2, audit.log, egress_allowlist               |
| deploy     | deploy, backend, approval, approve, ledger, cost cap, estimate, rollout                   |
| security   | HMAC, key rotation, audit, denied, permission denied, credentials, scoper                 |
```

### Glob append template

```markdown
**Step 2 — Load relevant context**

[existing Glob: lines preserved verbatim]

Glob: plugins/autonomous-dev/intake/chains/*
Glob: plugins/autonomous-dev/intake/deploy/*
Glob: plugins/autonomous-dev/intake/cred-proxy/*
Glob: plugins/autonomous-dev/intake/firewall/*
Glob: plugins/autonomous-dev-deploy-gcp/**
Glob: plugins/autonomous-dev-deploy-aws/**
Glob: plugins/autonomous-dev-deploy-azure/**
Glob: plugins/autonomous-dev-deploy-k8s/**
Glob: plugins/autonomous-dev-assist/instructions/*-runbook.md
```

### Step-3 instruction additions

```markdown
**Step 3 — Answer**

[existing instructions preserved]

If the question matches multiple categories, load context from all matched
categories. If a Glob target returns no files (e.g., the cloud-deploy plugins
are not installed), proceed with the available context and surface the install
pointer: `claude plugin install autonomous-dev-deploy-<backend>` (substitute
the relevant backend: gcp, aws, azure, or k8s).
```

## Interfaces and Dependencies
- **Consumes**: SKILL sections from PLAN-026-1 (the routing target).
- **Produces**: The routing surface that PLAN-026-2 chains-runbook (this plan, later specs) and PLAN-026-3 deploy-runbook are reachable through.
- **Validation tools**: `grep`, `awk`, `markdownlint`, optionally the existing eval runner for regression.

## Acceptance Criteria

### Six classifier bullets
```
Given commands/assist.md
When all lines matching the regex "^- \*\*[a-z]+\*\* --" within the Step-1 section are extracted in document order
Then the bold tokens are exactly: help, troubleshoot, config, chains, deploy, security
And no other category appears
```

### Verbatim wording for new categories
```
Given the file
When grep -F "Questions about plugin chains, the manifest-v2 schema, the chain audit log, or chains CLI." is run
Then ≥ 1 match
When grep -F "Questions about the deploy framework, backends, the approval state machine, the ledger, cost caps, or deploy CLI." is run
Then ≥ 1 match
When grep -F "Questions about HMAC keys, audit logs, credential proxy, egress firewall, or denied-permission errors." is run
Then ≥ 1 match
```

### Trigger keywords table
```
Given the file
When the table or block following the classifier bullets is parsed
Then for category "chains" the keywords include: chain, chains, produces, consumes, manifest-v2, audit.log, egress_allowlist
And for category "deploy" the keywords include: deploy, backend, approval, approve, ledger, cost cap, estimate, rollout
And for category "security" the keywords include: HMAC, key rotation, audit, denied, permission denied, credentials, scoper
```

### Multi-match instruction
```
Given the file
When the Step-3 section is searched for the substrings "multiple categories" AND "all matched"
Then both substrings appear within the same paragraph
```

### Default fallback
```
Given the file
When the classifier section is searched for the substring "fall back to `help`" or "default to `help`"
Then ≥ 1 match
```

### Glob append-only and ordered
```
Given the file
When all "^Glob: " lines in Step-2 are extracted in document order
Then the LAST nine entries equal exactly:
  Glob: plugins/autonomous-dev/intake/chains/*
  Glob: plugins/autonomous-dev/intake/deploy/*
  Glob: plugins/autonomous-dev/intake/cred-proxy/*
  Glob: plugins/autonomous-dev/intake/firewall/*
  Glob: plugins/autonomous-dev-deploy-gcp/**
  Glob: plugins/autonomous-dev-deploy-aws/**
  Glob: plugins/autonomous-dev-deploy-azure/**
  Glob: plugins/autonomous-dev-deploy-k8s/**
  Glob: plugins/autonomous-dev-assist/instructions/*-runbook.md
And every existing Glob line that was present before this spec is still present
```

### Glob reachability snapshot
```
Given the repo root
When each new Glob pattern is resolved with `find` or `ls -d`
Then plugins/autonomous-dev/intake/chains/*    matches at least one file (intake content shipped on main)
And plugins/autonomous-dev/intake/deploy/*     matches at least one file
And plugins/autonomous-dev/intake/cred-proxy/* matches at least one file
And plugins/autonomous-dev/intake/firewall/*   matches at least one file
And plugins/autonomous-dev-deploy-gcp/**       matches zero files (plugin not yet installed)
And plugins/autonomous-dev-deploy-aws/**       matches zero files
And plugins/autonomous-dev-deploy-azure/**     matches zero files
And plugins/autonomous-dev-deploy-k8s/**       matches zero files
And plugins/autonomous-dev-assist/instructions/*-runbook.md matches at least one file once chains-runbook.md lands (later in PLAN-026-2)
```

NOTE: the runbook-glob expectation flips from zero to one once SPEC-026-2-03 / -04 land; document this in the PR.

### Missing-glob fallback instruction
```
Given Step-3
When searched for "claude plugin install autonomous-dev-deploy-"
Then ≥ 1 match
```

### No SHA pinning
```
Given the file
When the SHA-pin regex grep is run
Then 0 matches
```

### markdownlint
```
Given the modified file
When markdownlint is run
Then exit 0
```

### PR description records baseline (Task 1)
```
Given the PR description
When read
Then it contains an integer for "Baseline Glob count: N"
And it contains "Baseline classifier bullets: 3"
And it contains the four cloud-plugin glob paths annotated as "expected zero matches until TDD-025 ships"
```

## Test Requirements
- Validation script (run during implementation):
  ```bash
  # Classifier bullet count
  awk '/^\*\*Step 1/,/^\*\*Step 2/' commands/assist.md | grep -cE '^- \*\*[a-z]+\*\* --'
  # Expect: 6

  # Glob count  
  grep -c '^Glob: ' commands/assist.md
  # Expect: baseline + 9
  ```
- markdownlint pass.
- Manual classifier walk (post-merge of PLAN-026-1 and this spec): run `/autonomous-dev-assist:assist "what manifest-v2 fields enable chaining?"` and confirm the answer cites `produces`, `consumes`, `egress_allowlist` from the help/SKILL.md Plugin Chains section.

## Implementation Notes
- The classifier is a Claude prompt, not a parser. The trigger-keyword table is documentation for the model, not a regex. Do NOT add code that attempts to enforce keyword matching — the prompt-engineering approach is the contract.
- Use `Edit` (not `replace_all`) for each insertion. Anchor each edit to a unique multi-line `old_string`.
- The runbook glob `plugins/autonomous-dev-assist/instructions/*-runbook.md` matches `runbook.md` (existing) AND `chains-runbook.md` / `deploy-runbook.md` (later in this plan / PLAN-026-3). The `*-runbook.md` form requires a `-` between the prefix and `runbook` — verify the existing `runbook.md` is NOT matched (it is not, because `*-runbook.md` requires at least one char before `-runbook`). If the existing file is named `runbook.md` it is correctly excluded.
- Do NOT change the existing argument-parsing block; it is out of scope here.

## Rollout Considerations
- No flag. Lazy classifier behavior — questions outside the new categories are unaffected.
- Rollback: `git revert`. Existing 90-case eval suite must still pass (regression gate).
- Post-merge: rerun the existing eval suite to confirm no regression. If pass-rate drops below 95%, defer the merge and tune the keyword bag.

## Effort Estimate
- Read baseline + PR description: 1 hour
- Classifier edit: 1 hour
- Glob edit: 0.5 hours
- Step-3 multi-match edit: 0.5 hours
- Validation + manual smoke + regression eval: 1.5 hours
- **Total: 4.5 hours**
