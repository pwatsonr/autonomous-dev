# SPEC-026-3-01: deploy-runbook §1 Bootstrap + §2 Approval State Machine

## Metadata
- **Parent Plan**: PLAN-026-3
- **Parent TDD**: TDD-026
- **Tasks Covered**: PLAN-026-3 Task 1 (§1 Bootstrap + §2 Approval state machine)
- **Estimated effort**: 4 hours
- **Status**: Draft
- **Author**: Specification Author (TDD-026 cascade)
- **Date**: 2026-05-02
- **Depends on**: PLAN-026-1 merged (`help/SKILL.md` Deploy Framework H2 exists), PLAN-026-2 merged (`chains-runbook.md` is the cross-link sibling)

## Summary
Create `plugins/autonomous-dev-assist/instructions/deploy-runbook.md` and author the first two sections of the deploy operator deep-dive: §1 Bootstrap (~40 lines) and §2 The approval state machine (~60 lines). §1 walks through `deploy.yaml` authoring with a worked staging+prod example and the first dry-run via `deploy estimate`. §2 walks through all five states (`pending`, `awaiting-approval`, `approved|rejected`, `executing`, `completed|failed`) and states the **prod-always-approval rule** ("regardless of trust level") as a callout AND a worked prod example. The state-machine ASCII diagram is reused verbatim from `help/SKILL.md` Deploy Framework so a single source of truth makes drift detectable by the meta-reviewer. This spec creates the file; subsequent specs (SPEC-026-3-02 through -03) append the remaining sections.

## Functional Requirements

### File creation and front-matter

| ID   | Requirement |
|------|-------------|
| FR-1 | A new file MUST be created at `plugins/autonomous-dev-assist/instructions/deploy-runbook.md`. |
| FR-2 | The file MUST open with the same front-matter style as `instructions/runbook.md` (operator-runbook H1 + 1–3 line description + an H2 table-of-contents listing all eight sections by anchor). The TOC entries for §3–§8 are PLACEHOLDERS that point at the future anchors authored by SPEC-026-3-02 / -03. |
| FR-3 | The H1 MUST be `# Deploy Framework Runbook`. |
| FR-4 | The TOC MUST list all eight sections in order: §1 Bootstrap, §2 Approval state machine, §3 Cost-cap trip recovery, §4 Ledger inspection, §5 HealthMonitor + SLA tracker, §6 Rollback, §7 Common errors, §8 See also. |

### §1 Bootstrap (~40 lines)

| ID    | Requirement |
|-------|-------------|
| FR-5  | An H2 `## 1. Bootstrap` MUST be the first content section after the TOC. |
| FR-6  | §1 MUST include a worked `deploy.yaml` example with three top-level fields: `default_backend: gcp`, an `environments.staging` block, and an `environments.prod` block where the prod block sets `is_prod: true` and `cost_cap_usd: 500.00`. |
| FR-7  | §1 MUST document the first dry-run via the literal command `deploy estimate --env staging --backend gcp` and explain its read-only behavior (no ledger entry, no approval flow). |
| FR-8  | §1 MUST cite TDD-023 §9 (`deploy-config-v1` schema) using section-anchor form (`TDD-023 §9` or a Markdown link with the same section anchor). NO SHA pinning. |
| FR-9  | §1 line count MUST be between 35 and 50 (target ~40). |
| FR-10 | §1 MUST use the `REQ-NNNNNN` placeholder for any sample request IDs (per TDD-026 §10.2 privacy rule). |

### §2 Approval state machine (~60 lines)

| ID    | Requirement |
|-------|-------------|
| FR-11 | An H2 `## 2. The approval state machine` MUST be appended immediately after §1. |
| FR-12 | §2 MUST OPEN with a callout/blockquote (e.g. `> **Prod-override rule:** ...`) stating the rule that ANY environment with `is_prod: true` requires human approval **regardless of trust level**. The callout MUST contain the verbatim phrase `regardless of trust level`. |
| FR-13 | §2 MUST include a worked prod example that walks `pending` → `awaiting-approval` → `approved` → `executing` → `completed` for a request against the prod env defined in §1, with the exact CLI command at each transition (`deploy plan REQ-NNNNNN --env prod`, `deploy approve REQ-NNNNNN`, etc.). The worked example MUST contain the verbatim phrase `regardless of trust level` a SECOND time (in a sentence like "the request still requires `deploy approve` regardless of trust level"). |
| FR-14 | §2 MUST embed the exact same ASCII state-machine diagram that PLAN-026-1 (SPEC-026-1-01 / `help/SKILL.md` Deploy Framework `### The approval state machine`) ships. The diagram MUST be in a fenced code block with no language tag (or `text` tag) so renderers preserve spacing. |
| FR-15 | §2 MUST list all five states and the transitions between them: `pending` → `awaiting-approval` → (`approved` OR `rejected`); `approved` → `executing` → (`completed` OR `failed`). The terminal states `rejected` and `failed` are sinks. |
| FR-16 | §2 MUST cite TDD-023 §11 (Trust Integration) using section-anchor form. |
| FR-17 | §2 line count MUST be between 50 and 70 (target ~60). |
| FR-18 | §2 MUST use only `REQ-NNNNNN` placeholders for sample request IDs. |
| FR-19 | §2 MUST NOT contain any of the deploy negative-bag strings: `deploy force-approve`, `deploy auto-prod`, `deploy.*--no-approval`, `cost cap.*ignore`. |

## Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| `regardless of trust level` total occurrences in §2 | ≥ 2 | `awk '/^## 2\./, /^## 3\./' deploy-runbook.md \| grep -c 'regardless of trust level'` |
| §1 + §2 combined line count | 85 – 120 | `awk '/^## 1\./, /^## 3\./' deploy-runbook.md \| wc -l` |
| State-machine diagram parity with `help/SKILL.md` | byte-identical | `diff <(awk '/state-machine-start/,/state-machine-end/' help/SKILL.md) <(awk '/state-machine-start/,/state-machine-end/' deploy-runbook.md)` returns no differences (use sentinel comments OR run a content-fingerprint compare in the smoke test from SPEC-026-3-05). |
| markdownlint pass | 0 errors | `markdownlint deploy-runbook.md` |
| SHA-pin regex match count | 0 | `grep -cE '(commit[[:space:]]+[a-f0-9]{7,40}\|as of [a-f0-9]{7,40}\|fixed in [a-f0-9]{7,40})' deploy-runbook.md` |
| Idempotent re-render | identical 5x | 5 consecutive `cat deploy-runbook.md \| sha256sum` produce the same hash (no $RANDOM, no timestamps inside the file) |

## Technical Approach

### File created
- `plugins/autonomous-dev-assist/instructions/deploy-runbook.md`

### Procedure
1. **Read** `plugins/autonomous-dev-assist/instructions/runbook.md` head (first ~50 lines) and reuse its front-matter style.
2. **Read** `plugins/autonomous-dev-assist/skills/help/SKILL.md` `### The approval state machine` H3 section (authored by SPEC-026-1-01) and copy the ASCII state-machine diagram verbatim. Confirm both copies are byte-identical with `diff`.
3. **Read** the worked `deploy.yaml` example from `plugins/autonomous-dev-assist/skills/config-guide/SKILL.md` `## Section 20: deploy` (authored by SPEC-026-1-03). Reuse the `default_backend`, `staging`, and `prod` blocks verbatim where possible to avoid drift across the cascade.
4. **Author** the H1, TOC, and §1 in a single `Write`. The TOC entries for §3–§8 use anchor placeholders (e.g., `[3. Cost-cap trip recovery](#3-cost-cap-trip-recovery)`) — the targets do not exist yet but `markdown-link-check` does not catch unresolved internal anchors at write-time (deferred to SPEC-026-3-05's smoke).
5. **Append** §2 via `Edit` with the §1 closing line as the unique `old_string`.
6. **Validate** locally:
   - `wc -l deploy-runbook.md` reports ~100 lines (file is partial; full file lands at ~390 after SPEC-026-3-02 / -03).
   - `awk '/^## 2\./, /^## 3\./' deploy-runbook.md | grep -c 'regardless of trust level'` ≥ 2.
   - `markdownlint deploy-runbook.md` exits 0.

### §1 template (illustrative — implementer adapts to existing front-matter)

```markdown
# Deploy Framework Runbook

The operator deep-dive for the autonomous-dev deploy framework. Use this
runbook when:

- A deploy stalled and you need to inspect the state machine.
- A cost-cap trip needs recovery (see §3 — never edit the ledger by hand).
- The HealthMonitor reports a degraded SLA.

For the quick reference, see `help/SKILL.md` Deploy Framework. For chains, see
`chains-runbook.md`.

## Table of contents

1. [Bootstrap](#1-bootstrap)
2. [The approval state machine](#2-the-approval-state-machine)
3. [Cost-cap trip recovery](#3-cost-cap-trip-recovery)
4. [Ledger inspection](#4-ledger-inspection)
5. [HealthMonitor + SLA tracker](#5-healthmonitor--sla-tracker)
6. [Rollback](#6-rollback)
7. [Common errors](#7-common-errors)
8. [See also](#8-see-also)

## 1. Bootstrap

Before your first deploy, author a `deploy.yaml` at the repo root. The schema
is defined in TDD-023 §9 (`deploy-config-v1`).

```yaml
# deploy.yaml — minimal staging + prod
default_backend: gcp

environments:
  staging:
    backend: gcp
    cost_cap_usd: 50.00
    auto_approve_at_trust: L2

  prod:
    backend: gcp
    is_prod: true            # forces approval regardless of trust level
    cost_cap_usd: 500.00
```

Run a dry-run estimate (no ledger write, no approval flow):

```bash
deploy estimate --env staging --backend gcp
```

The estimate prints the projected cost, validates the config against
`deploy-config-v1`, and exits without creating a request. Use it to verify the
manifest before running `deploy plan REQ-NNNNNN --env staging`, which DOES
write a ledger entry and enters the state machine described in §2.
```

### §2 template (illustrative)

```markdown
## 2. The approval state machine

> **Prod-override rule.** Any environment with `is_prod: true` always passes
> through `awaiting-approval` regardless of trust level. There is no path that
> skips human approval for a prod environment — see TDD-023 §11.

The state graph (reused verbatim from `help/SKILL.md` Deploy Framework):

```text
       ┌─────────┐  deploy plan       ┌───────────────────┐
       │ pending │ ─────────────────▶ │ awaiting-approval │
       └─────────┘                    └───────────────────┘
                                          │            │
                          deploy approve  │            │  deploy reject
                                          ▼            ▼
                                     ┌──────────┐  ┌──────────┐
                                     │ approved │  │ rejected │
                                     └──────────┘  └──────────┘
                                          │
                                          ▼
                                     ┌────────────┐
                                     │  executing │
                                     └────────────┘
                                       │        │
                                       ▼        ▼
                                ┌───────────┐ ┌────────┐
                                │ completed │ │ failed │
                                └───────────┘ └────────┘
```

### Worked prod example

```bash
$ deploy plan REQ-NNNNNN --env prod
state: awaiting-approval

# the request still requires `deploy approve` regardless of trust level
$ deploy approve REQ-NNNNNN --comment "rollout per RFC-XYZ"
state: approved → executing → completed
```

The transitions are:

- `pending → awaiting-approval` on `deploy plan`.
- `awaiting-approval → approved` on `deploy approve` (or `→ rejected` on `deploy reject`).
- `approved → executing` automatically once approval lands.
- `executing → completed` on success, `→ failed` on error.
```

## Interfaces and Dependencies
- **Consumes**: `help/SKILL.md` Deploy Framework `### The approval state machine` (SPEC-026-1-01) for the ASCII diagram; `config-guide/SKILL.md` `## Section 20: deploy` (SPEC-026-1-03) for the YAML example.
- **Produces**: the deploy-runbook file with §1 and §2 only; subsequent specs append §3 onward.
- **Anchors stable**: `#1-bootstrap`, `#2-the-approval-state-machine`. SPEC-026-3-02 / -03 / -04 / -05 cross-link these.

## Acceptance Criteria

### File and TOC
```
Given the post-spec tree
When `ls plugins/autonomous-dev-assist/instructions/deploy-runbook.md` is run
Then the file exists
And `head -1` returns "# Deploy Framework Runbook"
And `grep -c '^## ' deploy-runbook.md` returns AT LEAST 2 (§1, §2; the TOC entries are bullets, not H2s)
And the TOC lists exactly eight numbered items in order
```

### §1 Bootstrap content
```
Given §1 of deploy-runbook.md
When the section body is parsed
Then it contains a fenced YAML block with `default_backend:`, `staging:`, `prod:`, `is_prod: true`, `cost_cap_usd:`
And it contains the literal command `deploy estimate --env staging --backend gcp`
And it cites TDD-023 §9 in section-anchor form
And §1 line count (between `## 1.` and `## 2.`) is in [35, 50]
```

### §2 prod-override rule (the safety-critical assertion)
```
Given §2 of deploy-runbook.md
When `awk '/^## 2\./, /^## 3\./' deploy-runbook.md | grep -c 'regardless of trust level'` is run
Then count >= 2
And one occurrence is inside a callout/blockquote at the section opening (a line starting with `>`)
And one occurrence is inside the worked prod example (a line near a `deploy approve` command)
```

### §2 state-machine diagram parity
```
Given the ASCII state-machine diagram in §2
And the ASCII state-machine diagram in `help/SKILL.md` `### The approval state machine`
When the two diagrams are extracted from their fenced code blocks
Then their content is byte-identical
```

### §2 negative-bag absence
```
Given §2 of deploy-runbook.md
When `grep -E 'deploy force-approve|deploy auto-prod|deploy.*--no-approval|cost cap.*ignore'` is run
Then 0 matches
```

### REQ-ID privacy rule
```
Given §1 and §2 of deploy-runbook.md
When `grep -E 'REQ-[0-9]{6}' file` is run AND each match is checked
Then every sample REQ-ID is the literal token `REQ-NNNNNN` (no real digits)
```

### markdownlint and SHA-pin
```
Given deploy-runbook.md
When `markdownlint` is run
Then exit 0

Given deploy-runbook.md
When the SHA-pin regex is grepped
Then 0 matches
```

### Idempotency
```
Given the post-spec tree
When `cat deploy-runbook.md | sha256sum` is run 5 times
Then the same hash appears 5 times
```

## Test Requirements
- Manual: render `deploy-runbook.md` in a Markdown viewer; verify the TOC links resolve to the existing §1, §2 anchors, and the §3–§8 anchors are unresolved (expected — placeholders for SPEC-026-3-02/-03).
- `markdownlint plugins/autonomous-dev-assist/instructions/deploy-runbook.md` exits 0.
- `grep -c 'regardless of trust level' deploy-runbook.md` returns ≥ 2 (the full smoke from SPEC-026-3-05 enforces this; the spec-author validates locally first).
- Run a `diff` between the §2 ASCII diagram and the `help/SKILL.md` source diagram. They must be byte-identical.

## Implementation Notes
- The "single source of truth" rule for the state-machine diagram is critical: if the diagram drifts between `help/SKILL.md` and `deploy-runbook.md`, the meta-reviewer (PLAN-021-3) flags it. Do NOT re-author the diagram — copy verbatim, including spacing.
- The TOC anchors for §3–§8 will resolve once SPEC-026-3-02 and SPEC-026-3-03 land. `markdown-link-check` does not flag unresolved INTERNAL anchors by default (only external dead links). If the project's link-check config is stricter, whitelist the §3–§8 anchors with an XFAIL marker until the cascading specs land.
- The `deploy.yaml` example is consumed by `deploy-eval.yaml` (SPEC-026-3-04) — the eval cases that ask "what does the prod block look like?" will reference fields by name. Keep field names stable (`is_prod`, `cost_cap_usd`).
- This spec creates the file; SPEC-026-3-02 will extend it. Use `Edit` with unique `old_string` markers (e.g., the closing `## ` line of §2) for the next spec to append safely.

## Rollout Considerations
- Pure documentation. No runtime impact.
- Rollback: `git revert`. The runbook disappears; the cascading specs that cross-link it (SPEC-026-3-04 eval, SPEC-026-3-05 smoke) catch the missing file at CI.

## Effort Estimate
- TOC + front-matter authoring: 0.5 hour
- §1 Bootstrap (~40 lines, careful YAML example reuse): 1.5 hours
- §2 Approval state machine (~60 lines, diagram copy + worked example): 1.5 hours
- markdownlint + local validation: 0.5 hour
- **Total: 4 hours**
