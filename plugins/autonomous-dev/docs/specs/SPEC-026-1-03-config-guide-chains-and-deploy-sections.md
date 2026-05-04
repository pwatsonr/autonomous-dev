# SPEC-026-1-03: config-guide/SKILL.md chains + deploy Sections + Renumbering

## Metadata
- **Parent Plan**: PLAN-026-1
- **Parent TDD**: TDD-026
- **Tasks Covered**: PLAN-026-1 Task 4 (chains section), Task 5 (deploy section), Task 6 (renumbering downstream sections)
- **Estimated effort**: 10 hours (4h chains + 4h deploy + 2h renumber)
- **Status**: Draft
- **Author**: Specification Author (TDD-026 cascade)
- **Date**: 2026-05-02

## Summary
Insert two new top-level sections into `plugins/autonomous-dev-assist/skills/config-guide/SKILL.md`: `## Section 19: chains` (FR-1510) and `## Section 20: deploy` (FR-1511). Both sit between the existing "Section 18: extensions" and the existing "Section 19: production_intelligence". The existing Section 19 is renumbered to Section 21 and the existing Section 20 is renumbered to Section 22. All cross-section references inside the file are updated.

## Functional Requirements

### Chains section (Task 4)

| ID    | Requirement                                                                                                                                                                                  |
|-------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1  | A new H2 `## Section 19: chains` MUST be inserted immediately after the existing `## Section 18: extensions` H2 (and immediately before the renumbered `## Section 21: production_intelligence`). |
| FR-2  | The H2 MUST open with the `*Topic:* chains` marker on the line following the heading.                                                                                                          |
| FR-3  | The section MUST contain a YAML configuration block with these four keys: `chains.enabled`, `chains.audit.key_env`, `chains.audit.log_path`, `chains.approval.required_for_prod_egress`.       |
| FR-4  | The section MUST contain a Markdown parameter table with one row per parameter showing: parameter name, type, default, description.                                                            |
| FR-5  | The defaults in the table MUST match: `chains.enabled = true`, `chains.audit.key_env = "CHAINS_AUDIT_KEY"`, `chains.audit.log_path = "~/.autonomous-dev/chains/audit.log"`, `chains.approval.required_for_prod_egress = true`. |
| FR-6  | The section MUST contain a worked manifest-v2 example showing a plugin declaring `produces`/`consumes` and a 3–4 line excerpt of the resulting `chains graph` output.                          |
| FR-7  | The section MUST contain HMAC-key custody guidance with the verbatim phrase `no rotation command exists` and a forward reference `TDD-022 OQ-3` describing rotation as future work.            |
| FR-8  | The section MUST end with a `### See also` block linking `chains-runbook §1 Bootstrap`, `TDD-022 §5`, and `TDD-022 §13` (three anchors minimum).                                               |
| FR-9  | The section MUST NOT contain any of: `chains rotate-key`, `manifest-v1` (outside "do NOT" context), `audit.json`.                                                                              |

### Deploy section (Task 5)

| ID    | Requirement                                                                                                                                                                                            |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-10 | A new H2 `## Section 20: deploy` MUST be inserted immediately after the new `## Section 19: chains`.                                                                                                    |
| FR-11 | The H2 MUST open with the `*Topic:* deploy` marker.                                                                                                                                                    |
| FR-12 | The section MUST link to the `deploy-config-v1` schema reference at `TDD-023 §9`.                                                                                                                       |
| FR-13 | The section MUST contain a worked YAML example showing `default_backend: gcp`, a `staging` env (`cost_cap_usd: 50.00`, `approval.required: false`), and a `prod` env with `is_prod: true`, `cost_cap_usd: 500.00`, `approval.required: true`. |
| FR-14 | The section MUST contain an approval-rules table with rows for trust levels L0/L1/L2/L3 × `is_prod: true|false` columns, and every row where `is_prod: true` MUST resolve to "approval required" with no exceptions. |
| FR-15 | The section MUST contain a cross-reference note pointing to the `cost_estimation` section owned by TDD-025 using the form `see TDD-025 §X Cost Estimation when published`.                              |
| FR-16 | The section MUST end with a `### See also` block linking `deploy-runbook §2 Approval State Machine`, `TDD-023 §9`, and `TDD-023 §11` (three anchors minimum).                                          |
| FR-17 | The section MUST NOT contain: `deploy force-approve`, `deploy auto-prod`, `cost cap.*ignore`.                                                                                                          |

### Renumbering (Task 6)

| ID    | Requirement                                                                                                                                                                                            |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-18 | The H2 currently titled `## Section 19: production_intelligence` (or its actual current title; verify via Read) MUST be renamed to `## Section 21: production_intelligence`.                            |
| FR-19 | The H2 currently titled `## Section 20: <name>` MUST be renamed to `## Section 22: <name>`.                                                                                                            |
| FR-20 | All in-file references to the old section numbers (`Section 19`, `Section 20`) inside running prose, table-of-contents bullets, and cross-section links MUST be updated to point at `Section 21`/`Section 22` where they refer to the renumbered sections, OR to `Section 19`/`Section 20` where they refer to the new chains/deploy sections (correctness depends on referent — manually verify each hit). |
| FR-21 | After renumbering, the file MUST contain exactly one H2 of each form `## Section N: <name>` for N = 1..22 with no gaps and no duplicates.                                                                |
| FR-22 | If the file has a top-of-file table of contents, every entry MUST be updated to the new numbering.                                                                                                     |
| FR-23 | No SHA-pin regex matches anywhere in the new content.                                                                                                                                                  |

## Non-Functional Requirements

| Requirement                       | Target              | Measurement Method                                                                |
|-----------------------------------|----------------------|-----------------------------------------------------------------------------------|
| Combined section size             | ≤ 250 lines (new)   | Sum of `## Section 19: chains` + `## Section 20: deploy` line counts              |
| File total after spec             | < 1100 lines        | `wc -l config-guide/SKILL.md` (baseline 812 + ≤ 250 + minor renumber edits)       |
| markdownlint pass                 | 0 errors            | `markdownlint config-guide/SKILL.md`                                              |
| markdown-link-check pass          | 0 broken links      | `markdown-link-check config-guide/SKILL.md`                                       |
| YAML block validity               | yamllint exit 0     | Extract YAML fences, pipe to `yamllint -`                                         |
| Renumber-leak grep                | 0 stale references  | `grep -n "Section 19" config-guide/SKILL.md` returns ONLY the new chains heading; `grep -n "Section 20"` returns ONLY the new deploy heading |

## Technical Approach

### File modified
- `plugins/autonomous-dev-assist/skills/config-guide/SKILL.md`

### Procedure
1. **Read the file** and tabulate every H2 currently numbered `Section 1` through the highest existing section. Confirm the current numbering. Capture the exact titles so renumbering is mechanical.
2. **Inventory cross-references**: `grep -n "Section 19\|Section 20" config-guide/SKILL.md`. Record each hit and decide whether it points at the to-be-renumbered content (must be updated to 21/22) or is part of new content (must be 19/20).
3. **Renumber FIRST** (FR-18, FR-19): change `## Section 19: ...` to `## Section 21: ...` and `## Section 20: ...` to `## Section 22: ...`. Do this with `Edit` (NOT `replace_all`) using full-line `old_string` to ensure uniqueness. Update any in-prose references in the renumbered sections themselves.
4. **Insert chains section** (FR-1..FR-9): use `Edit` with `old_string` anchored on the closing of `## Section 18: extensions` and the opening of `## Section 21: production_intelligence` (the just-renumbered section); insert the new chains H2 between them.
5. **Insert deploy section** (FR-10..FR-17): use `Edit` to insert between the new chains section and Section 21.
6. **Update TOC** (FR-22) if present at file top.
7. **Run validation grep**: see Acceptance Criteria.

### Section template — chains (illustrative)

```markdown
## Section 19: chains

*Topic:* chains

The `chains` section configures plugin chaining (TDD-022 §1) and the HMAC-chained
audit log.

```yaml
chains:
  enabled: true
  audit:
    key_env: CHAINS_AUDIT_KEY
    log_path: ~/.autonomous-dev/chains/audit.log
  approval:
    required_for_prod_egress: true
```

| Parameter                                | Type    | Default                              | Description                                         |
|------------------------------------------|---------|--------------------------------------|-----------------------------------------------------|
| `chains.enabled`                         | bool    | `true`                               | Enable plugin chaining engine                       |
| `chains.audit.key_env`                   | string  | `"CHAINS_AUDIT_KEY"`                 | Env var holding the HMAC key                        |
| `chains.audit.log_path`                  | string  | `"~/.autonomous-dev/chains/audit.log"` | Path to append-only HMAC-chained audit log        |
| `chains.approval.required_for_prod_egress` | bool  | `true`                               | Force approval gate when egress hits prod hosts     |

### Worked example

A `sql-injection-scanner` plugin declares it produces `findings/security` and
consumes `source/code`. The resulting `chains graph` excerpt:

```
source/code ──> sql-injection-scanner ──> findings/security ──> security-report
```

### HMAC key custody

- The HMAC key MUST live in the env var named by `chains.audit.key_env`. Never
  store it in this YAML file.
- **no rotation command exists** in TDD-022 §13. Rotating the key naively
  invalidates verification of every prior entry.
- Rotation is tracked as TDD-022 OQ-3 future work.

### See also
- [chains-runbook §1 Bootstrap](../../instructions/chains-runbook.md#1-bootstrap)
- [TDD-022 §5 Plugin Manifest Extensions](../../../autonomous-dev/docs/tdd/TDD-022-plugin-chaining-engine.md#5-plugin-manifest-extensions)
- [TDD-022 §13 Audit Log](../../../autonomous-dev/docs/tdd/TDD-022-plugin-chaining-engine.md#13-audit-log)
```

### Section template — deploy (illustrative)

```markdown
## Section 20: deploy

*Topic:* deploy

The `deploy` section configures the deploy framework (TDD-023 §1). The schema is
[`deploy-config-v1`](../../../autonomous-dev/docs/tdd/TDD-023-deployment-backend-framework-core.md#9-deploy-config-v1).

```yaml
deploy:
  default_backend: gcp
  environments:
    staging:
      backend: gcp
      cost_cap_usd: 50.00
      approval:
        required: false
    prod:
      backend: gcp
      is_prod: true
      cost_cap_usd: 500.00
      approval:
        required: true
```

### Approval rules

| Trust level | `is_prod: false` | `is_prod: true`                 |
|-------------|------------------|----------------------------------|
| L0          | approval required | approval required              |
| L1          | approval required | approval required              |
| L2          | auto-approved    | **approval required**            |
| L3          | auto-approved    | **approval required**            |

`is_prod: true` always requires human approval; trust elevation does NOT bypass.

### Cost-cap interaction

Cost caps and approval gates are independent. A staging deploy with
`cost_cap_usd: 50.00` and `approval.required: false` still aborts at 50 USD; a
prod deploy under cap still waits on approval. For per-environment cost
estimation, see TDD-025 §X Cost Estimation when published.

### See also
- [deploy-runbook §2 Approval State Machine](../../instructions/deploy-runbook.md#2-the-approval-state-machine)
- [TDD-023 §9 deploy-config-v1](../../../autonomous-dev/docs/tdd/TDD-023-deployment-backend-framework-core.md#9-deploy-config-v1)
- [TDD-023 §11 Trust Integration](../../../autonomous-dev/docs/tdd/TDD-023-deployment-backend-framework-core.md#11-trust-integration)
```

## Interfaces and Dependencies
- **Consumes**: TDD-022 §5 §13, TDD-023 §1 §9 §11.
- **Produces**: H2 anchors `#section-19-chains` and `#section-20-deploy` for runbook back-references.
- **Renumbering risk**: any other repo file that line-pins this file (search `grep -rn "config-guide/SKILL.md.*Section 19" plugins/`) MUST be updated. Capture in PR description.

## Acceptance Criteria

### New chains section presence
```
Given config-guide/SKILL.md
When grep -n "^## Section 19: chains$" is run
Then exactly 1 match
And it appears after "^## Section 18: extensions$" and before "^## Section 21:"
```

### New deploy section presence
```
Given the file
When grep -n "^## Section 20: deploy$" is run
Then exactly 1 match
And it appears immediately after "## Section 19: chains" with no other H2 between
```

### Renumbering completeness
```
Given the file
When all "^## Section N: " H2 headings are extracted in document order
Then the resulting numbers form the sequence 1, 2, 3, ..., 22 with no gaps and no duplicates
```

### Renumber-leak scan
```
Given the file
When grep -n "Section 19[^:]" or "Section 20[^:]" is run (matching prose mentions, not headings)
Then every hit refers EITHER to the new chains/deploy headings OR has been updated to 21/22
And no in-prose reference remains pointing at the OLD position of production_intelligence
```

### Topic markers
```
Given each new section
When the line after the H2 heading is read
Then it is exactly "*Topic:* chains" or "*Topic:* deploy" respectively
```

### Chains YAML validity
```
Given the YAML fence inside the chains section
When piped through "yamllint -"
Then exit code is 0
And the parsed structure has the four keys: chains.enabled, chains.audit.key_env, chains.audit.log_path, chains.approval.required_for_prod_egress
```

### Chains parameter table completeness
```
Given the chains parameter table
When rows are counted (excluding header and separator)
Then count is ≥ 4
And one row has parameter "chains.enabled" with default "true"
And one row has parameter "chains.audit.key_env" with default "CHAINS_AUDIT_KEY"
```

### HMAC custody verbatim string
```
Given the chains section body
When searched for the literal "no rotation command exists"
Then ≥ 1 match
And the body contains "TDD-022 OQ-3"
```

### Deploy YAML validity
```
Given the YAML fence inside the deploy section
When piped through yamllint
Then exit code 0
And the parsed env "prod" has is_prod: true AND approval.required: true AND cost_cap_usd: 500.00
And the parsed env "staging" has approval.required: false AND cost_cap_usd: 50.00
```

### Deploy approval-rules table — prod always required
```
Given the approval-rules table
When all rows where the is_prod column header is "true" are extracted
Then every such row's cell value resolves to "approval required" (case-insensitive)
And no row contains "auto" in the is_prod=true column
```

### See-also cross-links
```
Given each new section
When See-also links are extracted
Then chains See-also has ≥ 1 link to chains-runbook AND ≥ 2 links to TDD-022 anchors
And deploy See-also has ≥ 1 link to deploy-runbook AND ≥ 2 links to TDD-023 anchors
```

### Anchor convention
```
Given the modified file
When SHA-pin regex grep is run
Then 0 matches
```

### Negative-bag absence
```
Given the chains section, grep for chains rotate-key|audit\.json
Then 0 matches

Given the deploy section, grep for deploy force-approve|deploy auto-prod|cost cap.*ignore
Then 0 matches

Given either section, "manifest-v1" appears only inside "do NOT" context
```

### markdownlint and link checker
```
Given the modified file
When markdownlint and markdown-link-check are run
Then both exit 0
```

## Test Requirements
- Validation script (one-shot, run during implementation):
  ```bash
  # Section sequence check
  awk -F': ' '/^## Section [0-9]+:/ {print $1}' config-guide/SKILL.md \
    | grep -oE '[0-9]+' | paste -sd' ' -
  # Expected: 1 2 3 ... 22
  ```
- yamllint on each YAML fence (use a small extractor: `awk '/^```yaml$/{f=1; next} /^```$/{f=0} f' file`).
- markdownlint, markdown-link-check.
- Manual: render in a Markdown viewer; confirm tables render and TOC anchors resolve.

## Implementation Notes
- **Renumber FIRST, then insert.** Doing it in the other order makes the `Edit` `old_string` matches ambiguous (two `## Section 19` H2s temporarily exist).
- For renumbering use `Edit` with full-line `old_string` (e.g., `## Section 19: production_intelligence` → `## Section 21: production_intelligence`). Do NOT `replace_all "Section 19" "Section 21"` — that would clobber legitimate prose references and not handle the new chains heading correctly.
- The cost-estimation cross-reference uses placeholder `TDD-025 §X` because TDD-025 has not landed yet; this is acceptable (FR-15 specifies the form). PRD-010 markdown-link-check will skip the dead link if it has no URL; render the reference as plain text NOT a link, e.g., `see TDD-025 §X Cost Estimation when published`.
- The four-row trust × is_prod approval table is the safety-critical artifact — every row where `is_prod: true` MUST say "approval required" verbatim. Reviewers will fail the PR if any cell drifts.

## Rollout Considerations
- No flag. Lazy-loaded by `assist`.
- Rollback: `git revert`. Renumbering reverts to 19/20 for production_intelligence.

## Effort Estimate
- Read + inventory cross-refs: 1.5 hours
- Renumber existing sections: 1 hour
- Author chains section: 4 hours
- Author deploy section: 3 hours
- Validate (yamllint, grep checks, link checker): 0.5 hours
- **Total: 10 hours**
