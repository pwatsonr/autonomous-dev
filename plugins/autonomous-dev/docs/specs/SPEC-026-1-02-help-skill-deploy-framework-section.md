# SPEC-026-1-02: help/SKILL.md Deploy Framework Section

## Metadata
- **Parent Plan**: PLAN-026-1
- **Parent TDD**: TDD-026
- **Tasks Covered**: PLAN-026-1 Task 3 (Deploy Framework section authoring)
- **Estimated effort**: 5 hours
- **Status**: Draft
- **Author**: Specification Author (TDD-026 cascade)
- **Date**: 2026-05-02
- **Depends on**: SPEC-026-1-01 (Plugin Chains section must exist first so insertion order is `Pipeline Phases → Plugin Chains → Deploy Framework → Trust Levels`)

## Summary
Insert a new `## Deploy Framework` H2 section into `plugins/autonomous-dev-assist/skills/help/SKILL.md` immediately after the `## Plugin Chains` section authored by SPEC-026-1-01 and before the existing `## Trust Levels` H2. The section is the operator quick-reference for TDD-023's seven deploy CLI subcommands, the four-state approval state machine (with the prod-always-approval rule), the cost-cap ledger, and the HealthMonitor pointer. Satisfies PRD-015 FR-1503.

## Functional Requirements

| ID    | Requirement                                                                                                                                                                                              | Task |
|-------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | The new H2 MUST be titled exactly `## Deploy Framework` and inserted between `## Plugin Chains` (from SPEC-026-1-01) and `## Trust Levels`.                                                                | T3   |
| FR-2  | The H2 MUST open with the `*Topic:* deploy` marker on the line immediately following the H2 heading.                                                                                                       | T3   |
| FR-3  | The H2 MUST contain seven H3 subsections in this exact order: `### What the deploy framework is`, `### The seven deploy commands`, `### The approval state machine`, `### The cost-cap ledger`, `### The HealthMonitor`, `### When deploys stall`, `### See also`. | T3 |
| FR-4  | Every H3 subsection MUST be ≤ 30 lines.                                                                                                                                                                    | T3   |
| FR-5  | `### What the deploy framework is` MUST position the framework as the post-pipeline ship phase distinct from the daemon document-review pipeline; cites `TDD-023 §1`.                                      | T3   |
| FR-6  | `### The seven deploy commands` MUST be a Markdown table with rows for: `backends list`, `backends describe`, `plan`, `approve`, `reject`, `logs`, `cost`, `estimate` (eight rows total — `backends` splits into two). | T3 |
| FR-7  | `### The approval state machine` MUST contain an ASCII state diagram showing exactly the five states `pending`, `awaiting-approval`, `approved\|rejected`, `executing`, `completed\|failed` with directed-arrow transitions. | T3 |
| FR-8  | `### The approval state machine` MUST contain the verbatim phrase `regardless of trust level` at least once, in a sentence that asserts every environment with `is_prod: true` requires human approval.    | T3   |
| FR-9  | `### The cost-cap ledger` MUST contain the file path `~/.autonomous-dev/deploy/ledger.json`, the verbatim phrase `do NOT edit by hand`, and a reference to `deploy ledger reset` as the supported recovery. | T3 |
| FR-10 | `### The HealthMonitor` MUST be a one-paragraph pointer to `deploy logs REQ-NNNNNN --health` for SLA output (do NOT duplicate the deep-dive — that lives in deploy-runbook §5).                            | T3   |
| FR-11 | `### When deploys stall` MUST list three stall causes: `awaiting-approval`, `cost-cap-tripped`, backend not registered — each with a one-line recovery hint.                                                | T3   |
| FR-12 | `### See also` MUST contain Markdown links to `../../instructions/deploy-runbook.md` and to `TDD-023 §5`, `TDD-023 §11`, `TDD-023 §14` (three TDD anchors total).                                          | T3   |
| FR-13 | No new content matches the SHA-pin regex `(commit\s+[a-f0-9]{7,40}\|as of [a-f0-9]{7,40}\|fixed in [a-f0-9]{7,40})`.                                                                                       | T3   |
| FR-14 | No positive-guidance use of the negative bag: `deploy force-approve`, `deploy auto-prod`, `cost cap.*ignore`, `deploy.*--no-approval`, `edit.*ledger\.json` (only inside "do NOT" context).                | T3   |

## Non-Functional Requirements

| Requirement                       | Target              | Measurement Method                                                              |
|-----------------------------------|----------------------|---------------------------------------------------------------------------------|
| Section size budget               | ≤ 230 lines total    | `awk '/^## Deploy Framework/,/^## Trust Levels/' help/SKILL.md \| wc -l`        |
| Read-step latency contribution    | ≤ 250 ms             | Diff `Read` time before/after                                                   |
| markdownlint pass                 | 0 errors             | `markdownlint help/SKILL.md`                                                    |
| markdown-link-check pass          | 0 broken links       | `markdown-link-check help/SKILL.md`                                             |
| Total file size after both specs  | < 700 lines          | `wc -l` (baseline 385 + 200 chains + 230 deploy ≈ 815 — TARGET allowing slack)  |

## Technical Approach

### File modified
- `plugins/autonomous-dev-assist/skills/help/SKILL.md`

### Insertion procedure
1. After SPEC-026-1-01 has merged (or is staged), `Read` the file and locate the closing of the `## Plugin Chains` section's `### See also` block.
2. Use `Edit` with `old_string` set to the last line of the `## Plugin Chains` block plus the blank line plus the `## Trust Levels` H2; replace with the same anchor and the new `## Deploy Framework` H2 block in between.
3. Do NOT modify the `## Plugin Chains` content.

### Section template (illustrative — finalize wording at implementation)

```markdown
## Deploy Framework

*Topic:* deploy

The deploy framework ships built artifacts to a backend (cloud or k8s). It is
distinct from the daemon document-review pipeline; see TDD-023 §1 Deployment
Backend Framework Core.

### What the deploy framework is
[1-paragraph definition; positions as post-pipeline ship phase; cites TDD-023 §1]

### The seven deploy commands

| Command                              | Purpose                                       |
|--------------------------------------|-----------------------------------------------|
| `deploy backends list`               | Enumerate registered backends                 |
| `deploy backends describe <name>`    | Show backend capabilities and config schema   |
| `deploy plan REQ-NNNNNN [--env <e>]` | Stage a deploy plan; populates the ledger     |
| `deploy approve REQ-NNNNNN`          | Move from awaiting-approval to approved       |
| `deploy reject REQ-NNNNNN [--reason]`| Reject a pending plan                         |
| `deploy logs REQ-NNNNNN`             | Stream execution and HealthMonitor output     |
| `deploy cost REQ-NNNNNN`             | Show ledger entries for the request           |
| `deploy estimate --env <e> --backend <b>` | Pre-plan cost estimate                  |

### The approval state machine

```
   pending ──> awaiting-approval ──> approved ──> executing ──> completed
                       │                                          └─> failed
                       └─────────────> rejected
```

Every environment with `is_prod: true` traverses `awaiting-approval` and requires
human approval **regardless of trust level**. There is no bypass; trust elevation
does not skip the gate (TDD-023 §11 Trust Integration).

### The cost-cap ledger
- Path: `~/.autonomous-dev/deploy/ledger.json`
- Contract: append-only, Stripe-style. **do NOT edit by hand.**
- Recovery: use `deploy ledger reset` (see deploy-runbook §3).
- Trip behavior: when running tally would exceed `cost_cap_usd`, the plan aborts
  with status `cost-cap-tripped`.

### The HealthMonitor
Post-deploy SLA tracking is reported via `deploy logs REQ-NNNNNN --health`. For
the rollback decision tree see deploy-runbook §5.

### When deploys stall

| Cause                  | Recovery hint                                                  |
|------------------------|-----------------------------------------------------------------|
| `awaiting-approval`    | `deploy approve REQ-NNNNNN` (prod requires this regardless of trust) |
| `cost-cap-tripped`     | See deploy-runbook §3 Cost-cap trip recovery                    |
| Backend not registered | `claude plugin install autonomous-dev-deploy-<backend>`         |

### See also
- [deploy-runbook.md](../../instructions/deploy-runbook.md) — operator deep-dive
- [TDD-023 §5 Deploy CLI](../../../autonomous-dev/docs/tdd/TDD-023-deployment-backend-framework-core.md#5-deploy-cli)
- [TDD-023 §11 Trust Integration](../../../autonomous-dev/docs/tdd/TDD-023-deployment-backend-framework-core.md#11-trust-integration)
- [TDD-023 §14 Ledger Reset](../../../autonomous-dev/docs/tdd/TDD-023-deployment-backend-framework-core.md#14-ledger-reset)
```

## Interfaces and Dependencies
- **Consumes**: TDD-023 anchors §1, §5, §11, §14.
- **Produces**: A stable H2 anchor `#deploy-framework` linked from PLAN-026-3 deploy-runbook §8 and chains-runbook §8.
- **Code**: none.

## Acceptance Criteria

### Section presence and ordering
```
Given help/SKILL.md
When the H2 line numbers are extracted in document order
Then the sequence includes:
  ## Pipeline Phases (existing)
  ## Plugin Chains (from SPEC-026-1-01)
  ## Deploy Framework (this spec)
  ## Trust Levels (existing)
And these four H2s appear in that exact relative order
```

### Topic marker
```
Given the ## Deploy Framework section
When the first non-blank line after the H2 heading is read
Then it equals exactly "*Topic:* deploy"
```

### Seven H3 subsections in order
```
Given the new section
When all "^### " lines within it are extracted
Then the sequence equals exactly:
  ### What the deploy framework is
  ### The seven deploy commands
  ### The approval state machine
  ### The cost-cap ledger
  ### The HealthMonitor
  ### When deploys stall
  ### See also
```

### Subsection size budget
```
Given each H3 subsection within the new section
When line-count is measured
Then count is ≤ 30
```

### State diagram presence
```
Given the ### The approval state machine subsection
When the body is searched for the five state names
Then "pending", "awaiting-approval", "approved", "rejected", "executing", "completed", "failed"
  are all present at least once
And at least one ASCII arrow ("──>", "->", or "→") is present in a fenced code block
```

### Prod-approval verbatim string
```
Given the ### The approval state machine subsection
When the body is searched for the literal string "regardless of trust level"
Then exactly one or more matches are found
```

### Cost-cap safety string
```
Given the ### The cost-cap ledger subsection
When the body is searched for the literal "do NOT edit by hand"
Then at least one match is found
And the body contains the literal "deploy ledger reset"
And the body contains the literal "~/.autonomous-dev/deploy/ledger.json"
```

### Three TDD-023 anchors in See also
```
Given the ### See also subsection
When all Markdown links to TDD-023 anchors are counted
Then count ≥ 3
And at least one link contains "#5-"
And at least one link contains "#11-"
And at least one link contains "#14-"
```

### Anchor convention
```
Given the new section content
When SHA-pin regex grep is run
Then 0 matches
```

### Negative-bag scrubbing
```
Given the new section content
When grep -E "(deploy force-approve|deploy auto-prod|deploy.*--no-approval)" is run
Then 0 matches
And the literal "edit the ledger.json" appears ONLY inside a sentence beginning with "do NOT"
```

### markdownlint and link checker
```
Given the modified file
When markdownlint and markdown-link-check are run
Then both exit code 0
```

## Test Requirements
- Smoke assertions deferred to SPEC-026-1-04.
- Spec-local: `grep -c "^### " <section>` = 7; `grep "regardless of trust level"` ≥ 1; `grep "do NOT edit by hand"` ≥ 1.
- Manual: render the file in a Markdown viewer; confirm the ASCII state diagram preserves alignment.

## Implementation Notes
- Order matters: this spec assumes SPEC-026-1-01 has placed `## Plugin Chains` before `## Trust Levels`. If the implementer takes both specs in one PR, author SPEC-026-1-01 first then this one.
- The state-diagram fence MUST use a plain ` ``` ` block (no language tag) so the ASCII renders without highlighter mangling.
- Use the EXACT phrase "regardless of trust level" (not "regardless of trust" or "regardless of the trust level") — the eval suite in PLAN-026-3 grep-asserts the canonical wording.
- The HealthMonitor subsection deliberately is short. Do NOT expand it; the deep-dive belongs in deploy-runbook §5.

## Rollout Considerations
- No flag. Lazy-loaded by `assist`. Rollback = `git revert`.

## Effort Estimate
- Authoring: 4 hours
- Cross-link verification: 0.5 hours
- markdownlint + manual review: 0.5 hours
- **Total: 5 hours**
