# SPEC-026-2-03: chains-runbook.md §1 Bootstrap, §2 Deps, §3 Audit, §4 Manifest

## Metadata
- **Parent Plan**: PLAN-026-2
- **Parent TDD**: TDD-026
- **Tasks Covered**: PLAN-026-2 Task 5 (§1 Bootstrap, §2 Dependency-graph troubleshooting), Task 6 (§3 Audit verification — safety-critical), Task 7 (§4 Manifest-v2 migration)
- **Estimated effort**: 12 hours
- **Status**: Draft
- **Author**: Specification Author (TDD-026 cascade)
- **Date**: 2026-05-02

## Summary
Create `plugins/autonomous-dev-assist/instructions/chains-runbook.md` and author its first four sections per TDD-026 §7.1. §1 (~30 lines) covers env-var setup and key generation. §2 (~60 lines) covers cycle detection, missing produces/consumes, and DAG interpretation. §3 (~80 lines) is the safety-critical audit-verification section that must contain the verbatim "do NOT delete the audit log" and "do NOT rotate the HMAC key" warnings — operator following this section incorrectly destroys an irreplaceable security record (PRD-015 R-7). §4 (~50 lines) is the v1→v2 manifest migration cookbook. Sections 5–8 are authored by SPEC-026-2-04.

## Functional Requirements

### File creation

| ID   | Requirement                                                                                                                                                                                  |
|------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1 | A new file MUST be created at `plugins/autonomous-dev-assist/instructions/chains-runbook.md`.                                                                                                |
| FR-2 | The file MUST open with a header block (title + intro paragraph) mirroring the existing `instructions/runbook.md` style — verify by reading the first 20 lines of the existing file.         |
| FR-3 | The file MUST contain a Table of Contents (or a section list) referencing all eight planned sections (§1 through §8) so SPEC-026-2-04 can append §5–§8 without re-authoring the TOC.          |

### §1 Bootstrap (~30 lines)

| ID   | Requirement                                                                                                                                                                                                          |
|------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-4 | An H2 `## 1. Bootstrap` MUST be present.                                                                                                                                                                              |
| FR-5 | §1 MUST document creation of the env var with the EXACT name `CHAINS_AUDIT_KEY` and an illustrative key-generation command (e.g., `export CHAINS_AUDIT_KEY=$(openssl rand -hex 32)`) annotated as illustrative — not for production cut-and-paste. |
| FR-6 | §1 MUST point to the manifest-v2 migration entry (cross-link to §4 of this same runbook).                                                                                                                            |
| FR-7 | §1 MUST cite TDD-022 §5 Plugin Manifest Extensions using section-anchor form.                                                                                                                                          |
| FR-8 | §1 line count (heading line through the line before §2) MUST be between 25 and 40.                                                                                                                                    |

### §2 Dependency-graph troubleshooting (~60 lines)

| ID    | Requirement                                                                                                                                                                                                              |
|-------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-9  | An H2 `## 2. Dependency-graph troubleshooting` MUST be present.                                                                                                                                                            |
| FR-10 | §2 MUST cover four scenarios with H3 subsections or clearly delimited blocks: (a) cycle detection via `chains graph`, (b) missing `produces` declaration, (c) missing `consumes` declaration, (d) DAG ASCII output interpretation. |
| FR-11 | §2 MUST use placeholder plugin names `example-plugin-a`, `example-plugin-b` (or equivalent neutral placeholders) per the privacy rule (TDD-026 §10.2). It MUST NOT reference real or named third-party plugins.            |
| FR-12 | §2 line count MUST be between 50 and 75.                                                                                                                                                                                  |

### §3 Audit verification — safety-critical (~80 lines)

| ID    | Requirement                                                                                                                                                                                                              |
|-------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-13 | An H2 `## 3. Audit verification` MUST be present.                                                                                                                                                                          |
| FR-14 | §3 MUST explain the HMAC chain mechanism (each entry's HMAC depends on the previous entry's) in plain English in the opening paragraph.                                                                                    |
| FR-15 | §3 MUST document `chains audit verify`: exit codes (0 = pass, non-zero = mismatch), output format (entry index of first divergence).                                                                                      |
| FR-16 | §3 MUST contain the verbatim phrase `do NOT delete the audit log` AT LEAST TWICE — once in the section opening (warning callout) and once in the recovery procedure.                                                       |
| FR-17 | §3 MUST contain the verbatim phrase `do NOT rotate the HMAC key` AT LEAST ONCE.                                                                                                                                          |
| FR-18 | §3 MUST cite TDD-022 §13 Audit Log using section-anchor form.                                                                                                                                                              |
| FR-19 | §3 MUST document the supported recovery: if `~/.autonomous-dev/chains/audit.log.shadow` exists, run `chains audit verify --shadow`; otherwise file a TDD-022 issue. Do NOT invent commands beyond these.                  |
| FR-20 | §3 MUST document at least three error patterns: "HMAC mismatch at entry N", "audit log truncated", "audit key not set" — each with its recovery step.                                                                       |
| FR-21 | §3 MUST NOT contain the literal strings `chains rotate-key` or `audit.json` (negative-bag scrub from TDD-026 §9.1).                                                                                                       |
| FR-22 | §3 line count MUST be between 70 and 95.                                                                                                                                                                                  |

### §4 Manifest-v2 migration (~50 lines)

| ID    | Requirement                                                                                                                                                                                                              |
|-------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-23 | An H2 `## 4. Manifest-v2 migration` MUST be present.                                                                                                                                                                      |
| FR-24 | §4 MUST walk through migrating one example plugin (placeholder name `example-scanner-plugin`): identify artifact types, add `produces`/`consumes` to the manifest, validate with `chains list`, commit.                  |
| FR-25 | §4 MUST contain a JSON example showing the upgraded `plugin.json` `produces`/`consumes` fields.                                                                                                                           |
| FR-26 | §4 MUST state that the chain executor REJECTS v1 manifests with a clear error per TDD-022 §5; do NOT skip the migration.                                                                                                  |
| FR-27 | The literal `manifest-v1` MUST appear ONLY inside a "do NOT" sentence (negative-bag rule from TDD-026 §9.1).                                                                                                              |
| FR-28 | §4 line count MUST be between 40 and 60.                                                                                                                                                                                  |

### Quality gates

| ID    | Requirement                                                                                                                                                                  |
|-------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-29 | The new file MUST have zero SHA-pin regex matches.                                                                                                                           |
| FR-30 | All cross-references to TDD-022, TDD-023, or any other TDD MUST use the `TDD-NNN §M Section-Title` form.                                                                       |
| FR-31 | markdownlint MUST pass on the new file.                                                                                                                                      |
| FR-32 | markdown-link-check MUST pass on the new file.                                                                                                                                |

## Non-Functional Requirements

| Requirement                          | Target                | Measurement                                                                |
|--------------------------------------|------------------------|----------------------------------------------------------------------------|
| Combined §1–§4 line count            | 185–270                | `awk` from `## 1. Bootstrap` to (before) `## 5.`; `wc -l`                  |
| Read-step latency for partial file    | < 600 ms              | Time `Read` of chains-runbook.md (~270 lines)                             |
| Total file size after this spec       | 200–300 lines         | `wc -l` (sections 5–8 add ~100 lines later in SPEC-026-2-04)              |
| markdownlint                          | 0 errors              | Existing repo config                                                       |
| markdown-link-check                   | 0 broken links        | Caveat: `TDD-022` upstream anchors must exist in their target file        |

## Technical Approach

### Files created
- `plugins/autonomous-dev-assist/instructions/chains-runbook.md`

### Procedure
1. **Read** `plugins/autonomous-dev-assist/instructions/runbook.md` first 30 lines to extract the existing header style, intro pattern, and any frontmatter conventions. Mirror this in the new file's preamble.
2. **Author** §1 → §4 in document order using `Write` (single new file). The TOC at the top references §5–§8 with placeholder lines; SPEC-026-2-04 fills those bodies.
3. **Validate** every safety-string FR via grep before committing.

### File preamble template

```markdown
# Chains Runbook

This runbook is the operator deep-dive companion to the
[`## Plugin Chains` section in help/SKILL.md](../skills/help/SKILL.md#plugin-chains).
It covers chain bootstrapping, dependency-graph troubleshooting, the HMAC-chained
audit log, manifest-v2 migration, the approval flow, common errors, escalation,
and cross-references.

For chain CLI command reference and conceptual definition, see
[help/SKILL.md Plugin Chains](../skills/help/SKILL.md#plugin-chains).
For chain configuration parameters, see
[config-guide/SKILL.md Section 19 chains](../skills/config-guide/SKILL.md#section-19-chains).
Upstream design: TDD-022 Plugin Chaining Engine.

## Table of Contents

1. [Bootstrap](#1-bootstrap)
2. [Dependency-graph troubleshooting](#2-dependency-graph-troubleshooting)
3. [Audit verification](#3-audit-verification)
4. [Manifest-v2 migration](#4-manifest-v2-migration)
5. [Approval flow](#5-approval-flow)            <!-- authored by SPEC-026-2-04 -->
6. [Common errors](#6-common-errors)            <!-- authored by SPEC-026-2-04 -->
7. [Escalation](#7-escalation)                  <!-- authored by SPEC-026-2-04 -->
8. [See also](#8-see-also)                      <!-- authored by SPEC-026-2-04 -->
```

### §1 template (illustrative)

```markdown
## 1. Bootstrap

To enable chain-aware plugin execution, set the HMAC audit key in the env var
named by `chains.audit.key_env` (default `CHAINS_AUDIT_KEY`):

```bash
# Illustrative — for production, store the key in your secret manager.
export CHAINS_AUDIT_KEY=$(openssl rand -hex 32)
```

The audit log path defaults to `~/.autonomous-dev/chains/audit.log` and is
created lazily on the first chain invocation.

For plugins to participate in chains, their `.claude-plugin/plugin.json` MUST
declare manifest-v2 fields. See §4 below for the migration cookbook and
TDD-022 §5 Plugin Manifest Extensions for the schema.
```

### §3 template (safety-critical — illustrative excerpts)

```markdown
## 3. Audit verification

The chain audit log at `~/.autonomous-dev/chains/audit.log` is HMAC-chained:
each entry's HMAC depends on the previous entry's HMAC. A single tampered or
corrupted entry breaks verification of every subsequent entry.

> **WARNING: do NOT delete the audit log.** The file is the irrecoverable
> record of every chain approval and execution. Deletion destroys the
> security audit trail; there is no rebuild path.

> **WARNING: do NOT rotate the HMAC key.** No rotation command exists in
> TDD-022 §13 Audit Log. Rotating the env-var value naively invalidates
> verification of every prior entry. Rotation is tracked as TDD-022 OQ-3
> future work.

### `chains audit verify`

```
$ chains audit verify
verifying ~/.autonomous-dev/chains/audit.log
entries verified: 0..N
status: PASS                   # exit 0
```

```
$ chains audit verify
verifying ~/.autonomous-dev/chains/audit.log
HMAC mismatch at entry 42      # exit 2
```

### Recovery procedure

1. **do NOT delete the audit log.** Stop and read this section in full.
2. Check whether a shadow log exists at `~/.autonomous-dev/chains/audit.log.shadow`.
3. If yes: run `chains audit verify --shadow` to cross-check the live log
   against the shadow.
4. If no shadow log exists: file a TDD-022 issue with the verify output and
   do NOT modify the log file. The integrity record is more valuable than
   the inconvenience of a paused chain.

### Error patterns

| Error                          | Cause                                          | Action                                                                  |
|--------------------------------|------------------------------------------------|-------------------------------------------------------------------------|
| `HMAC mismatch at entry N`     | An entry was edited or the key changed          | do NOT delete; check shadow log; file TDD-022 issue                     |
| `audit log truncated`          | A crash interrupted an append                   | Investigate via shadow log; do NOT regenerate                           |
| `audit key not set`            | `CHAINS_AUDIT_KEY` env var missing              | Set the env var; do NOT generate a new key if entries already exist     |
```

## Interfaces and Dependencies
- **Consumes**: PLAN-026-1 SKILL anchors `#plugin-chains` and `#section-19-chains` (referenced from preamble).
- **Produces**: Anchor `#3-audit-verification` consumed by chains-runbook §8 (later) and deploy-runbook §8 (PLAN-026-3).
- **Upstream contracts**: TDD-022 §5, §13 anchors must remain stable.

## Acceptance Criteria

### File presence
```
Given the repo
When ls plugins/autonomous-dev-assist/instructions/chains-runbook.md is run
Then the file exists
And it is non-empty
```

### Section ordering
```
Given the file
When all "^## " H2 lines are extracted in document order
Then the first four are exactly:
  ## 1. Bootstrap
  ## 2. Dependency-graph troubleshooting
  ## 3. Audit verification
  ## 4. Manifest-v2 migration
And the file may also contain placeholder anchors or H2s for §5-§8 (added by SPEC-026-2-04)
```

### TOC presence
```
Given the file
When the first 50 lines are read
Then they contain a "Table of Contents" or "## Contents" section
And that section lists 8 numbered items (one per planned section)
```

### §1 line count
```
Given the file
When the lines from "^## 1. Bootstrap" through the line before "^## 2." are counted
Then 25 ≤ count ≤ 40
And the section body contains "CHAINS_AUDIT_KEY"
And the section body contains a forward reference to "§4" or "section 4"
```

### §3 safety strings
```
Given §3 (lines from "^## 3. Audit verification" to before "^## 4.")
When grep -F "do NOT delete the audit log" is run
Then ≥ 2 matches

When grep -F "do NOT rotate the HMAC key" is run
Then ≥ 1 match

When grep -E "(chains rotate-key|audit\.json)" is run
Then 0 matches

When the section is searched for "shadow log" or "audit.log.shadow"
Then ≥ 1 match
```

### §3 error patterns
```
Given §3
When error rows or paragraphs are enumerated
Then at least three distinct error labels appear: "HMAC mismatch", "audit log truncated", "audit key not set"
And each has a recovery action visible
```

### §4 manifest-v1 negative-bag rule
```
Given §4 (lines from "^## 4." to before "^## 5." or end of file)
When all lines containing "manifest-v1" are extracted
Then every such line ALSO contains "do NOT" or is inside a fenced code block that documents an error message
```

### §4 placeholder names
```
Given §2 and §4
When third-party-style names are searched for
Then only generic placeholders ("example-plugin-a", "example-scanner-plugin", etc.) appear
And no real plugin name (e.g., specific company products) appears
```

### Anchor convention across whole file
```
Given the new file
When SHA-pin regex grep is run
Then 0 matches

When all references to TDD-NNN are extracted
Then every reference uses the "§M Section-Title" form (no commit hashes, no "as of" SHA prefixes)
```

### markdownlint
```
Given the file
When markdownlint is run
Then exit 0
```

### markdown-link-check (caveat for SPEC-026-2-04 deferred §8 link)
```
Given the file
When markdown-link-check is run
Then exit 0 EXCEPT for the deploy-runbook §8 cross-link in §8 (which does not exist until PLAN-026-3 lands)
And SPEC-026-2-04 § 8 introduces the deploy-runbook link with an XFAIL whitelist; this spec does NOT include §8 yet, so all links must currently resolve
```

NOTE: Because §5–§8 are authored later, this spec's file content has NO references to deploy-runbook.md. All TDD-022 anchors must resolve.

## Test Requirements
- **Local validation during implementation**:
  - `awk '/^## 1\. Bootstrap/,/^## 2\./' chains-runbook.md | wc -l` ∈ [25, 40]
  - `grep -c "do NOT delete the audit log" chains-runbook.md` ≥ 2
  - `grep -c "do NOT rotate the HMAC key" chains-runbook.md` ≥ 1
  - `grep -cE "(chains rotate-key|audit\.json)" chains-runbook.md` = 0
- **Doc smoke (SPEC-026-2-04)**: full structural assertions land there.
- **Manual review**: a senior reviewer reads §3 end-to-end and confirms operator-following-this would NOT delete the audit log under any error scenario.

## Implementation Notes
- Author the four sections in one `Write` call (single new file). Subsequent specs append §5–§8 via `Edit`.
- The TOC links use anchors auto-generated by GitHub-style Markdown rendering (`#3-audit-verification`). Verify by previewing in a Markdown viewer; the link checker will confirm at CI time.
- Repeat the "do NOT delete" warning twice in §3 — once at the top as a callout block, once inside the recovery procedure. The redundancy is intentional: operators who skim only the recovery list still hit the warning.
- Do NOT speculate about future TDD-022 features beyond what the upstream TDD documents. The chains-runbook is a documentation artifact for SHIPPED behavior (TDD-026 NG-01).
- The illustrative `openssl rand -hex 32` command must be annotated as ILLUSTRATIVE so an operator does not paste it into prod and rotate over an existing key.

## Rollout Considerations
- New file. No flag. Loaded by `assist` only when the chains classifier triggers and the runbook glob from SPEC-026-2-01 matches.
- Rollback: `git revert`. The chains-runbook §-anchors disappear; SKILL "See also" links go dead until re-introduced.

## Effort Estimate
- Read existing runbook style + author preamble + TOC: 1.5 hours
- §1: 1.5 hours
- §2: 2.5 hours
- §3 (safety-critical, careful authoring + manual review): 4 hours
- §4: 2 hours
- Validation + manual review: 0.5 hours
- **Total: 12 hours**
