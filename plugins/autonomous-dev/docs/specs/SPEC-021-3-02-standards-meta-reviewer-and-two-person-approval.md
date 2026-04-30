# SPEC-021-3-02: standards-meta-reviewer Agent, Reviewer-Chain Trigger, and Two-Person Approval Flag

## Metadata
- **Parent Plan**: PLAN-021-3
- **Tasks Covered**: Task 5 (`standards-meta-reviewer.md`), Task 6 (reviewer-chain trigger), Task 7 (two-person approval flag)
- **Estimated effort**: 6.5 hours
- **Future location**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-021-3-02-standards-meta-reviewer-and-two-person-approval.md`

## Description
Author the `standards-meta-reviewer` governance agent that audits proposed changes to a repository's `standards.yaml` for consistency, unworkability, impact on existing code, and overly broad predicates (TDD-021 §12). Wire it into the reviewer-chain config from PLAN-020-2 via a path-filter trigger so PRs touching `<repo>/.autonomous-dev/standards.yaml` automatically invoke the meta-reviewer alongside the standard review chain. Implement the two-person approval policy: when a PR adds `immutable: true` rules or modifies framework requirements, the meta-reviewer's verdict carries `requires_two_person_approval: true`, and PLAN-020-2's score aggregator gates the merge until two distinct human approvers have approved the PR.

The agent is read-only (`tools: Read, Glob, Grep` — no Write/Edit/Bash) so it can audit repo state without changing it. Its output validates against PLAN-020-1's `reviewer-finding-v1.json` schema with one extension: an optional top-level `requires_two_person_approval: bool` field. The reviewer-chain config gains a new entry under each request type's `pr_review` gate that fires the meta-reviewer when the PR diff matches the path glob `**/.autonomous-dev/standards.yaml`.

This spec does NOT define the `prompt-renderer`, the standards prompt template, or the `fix-recipe` schema (covered by SPEC-021-3-01 and SPEC-021-3-03). It does NOT implement the human-approver UI (out-of-scope per PLAN-021-3 — the policy is defined and the trigger is exposed; the UI/CLI is a separate plan). The aggregator change in `src/reviewers/aggregator.ts` is part of this spec because PLAN-021-3 task 7 explicitly calls it out as an in-spec modification.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/agents/standards-meta-reviewer.md` | Create | Agent file: frontmatter + system prompt covering 4 detection categories + two-person-approval directive |
| `plugins/autonomous-dev/config_defaults/reviewer-chains.json` | Modify | Add `standards-meta-reviewer` entry to each request type's `pr_review` gate with the path-filter trigger |
| `plugins/autonomous-dev/schemas/reviewer-finding-v1.json` | Modify | Add optional top-level `requires_two_person_approval: { "type": "boolean" }` |
| `plugins/autonomous-dev/src/reviewers/aggregator.ts` | Modify | Honor `requires_two_person_approval` flag: gate cannot pass until two distinct GitHub login approvals are present |

## Implementation Details

### `agents/standards-meta-reviewer.md`

Frontmatter (verbatim, matches TDD-021 §12):

```yaml
---
name: standards-meta-reviewer
description: |
  Audits proposed changes to standards.yaml for rule conflicts, unworkability,
  impact on existing code, and overly broad predicates. Read-only.
model: claude-sonnet-4-6
tools: [Read, Glob, Grep]
---
```

System prompt body MUST cover the four detection categories explicitly, each as a top-level section with a short rationale and a worked example:

1. **Detect rule conflicts** — Two rules requiring opposite things in the same `applies_to` scope. Example: rule A requires `framework: fastapi` and rule B requires `framework: flask` in the same predicate scope.
2. **Detect unworkability** — A rule requires X but X is unattainable on the target stack. Example: rule requires `dependency_present: tornado` but the project's `package.json` shows it is a Node.js project (not Python).
3. **Detect impact** — Would this rule fail on existing code? Scan the last 50 commits using `Grep`/`Glob` to find files that would violate the proposed rule. Surface the count of probable violations.
4. **Detect overly broad predicates** — A predicate that matches almost everything (e.g., `applies_to: { language: "*" }` with a rule that should only apply to a specific service type).

After the four detection sections, the prompt MUST include the two-person-approval directive:

> **Two-person approval requirement.** Inspect the proposed `standards.yaml` diff. If the diff (a) ADDS any rule with `immutable: true`, (b) REMOVES any existing rule with `immutable: true`, or (c) ADDS or MODIFIES any rule whose assertion kind is `framework_match`, set `requires_two_person_approval: true` in the top-level output. Otherwise omit the field (or set `false`). Rule edits that change only `description` or `severity: advisory` do NOT trigger the flag. The aggregator (PLAN-020-2) will gate the merge until two distinct human approvers have approved the PR.

Output instruction (verbatim, end of prompt):

> Output JSON matching `schemas/reviewer-finding-v1.json` with the optional top-level field `requires_two_person_approval` set per the directive above. The `findings[]` array MUST include one entry per detected concern (severity: `info`/`warning`/`blocker`) with `category` set to one of `conflict`, `unworkability`, `impact`, `breadth`. The `verdict` field MUST be `APPROVE` if no blockers were found, `CONCERNS` if only `info`/`warning` findings, or `REQUEST_CHANGES` if any blocker.

The prompt MUST NOT use any tool other than `Read`, `Glob`, `Grep`. The agent file MUST NOT list `Write`, `Edit`, `Bash`, or any other mutating tool in its frontmatter.

Impact-scan scope cap (per PLAN-021-3 risk mitigation): the prompt instructs the agent to limit its commit scan to the most recent 50 commits via `git log -50` (or equivalent). For broader impact analysis, the agent SHOULD recommend a separate offline analysis rather than slow the review.

False-positive guard (per PLAN-021-3 risk mitigation): the prompt MUST include the directive "Treat a rule update (existing rule, modified fields) as a single change, NOT a delete-then-add. A diff that removes one rule and adds a near-identical one with the same `id` is an update, not a conflict."

### `config_defaults/reviewer-chains.json` Modification

Each request-type entry's `pr_review` gate gains a new reviewer entry. Final shape (illustrative for the `feature` type; mirror across `bug`, `infra`, `refactor`, `hotfix`):

```json
{
  "feature": {
    "pr_review": {
      "reviewers": [
        { "name": "code-reviewer", "type": "built-in", "blocking": true, "threshold": 80 },
        { "name": "qa-edge-case-reviewer", "type": "specialist", "blocking": false, "threshold": 75 },
        {
          "name": "standards-meta-reviewer",
          "type": "specialist",
          "blocking": true,
          "threshold": 0,
          "trigger": {
            "kind": "path-filter",
            "paths": ["**/.autonomous-dev/standards.yaml"]
          }
        }
      ]
    }
  }
}
```

Trigger semantics (already supported by PLAN-020-2's scheduler):
- `trigger.kind == "path-filter"` means the reviewer is invoked ONLY when the PR diff includes at least one file matching one of `trigger.paths`.
- The `paths` glob uses standard `minimatch`-style globbing (consistent with PLAN-020-2's existing `frontend` trigger).
- `threshold: 0` because the meta-reviewer's verdict is binary (APPROVE/CONCERNS/REQUEST_CHANGES), not score-based; the threshold field is required by the schema but ignored.
- `blocking: true` because a `REQUEST_CHANGES` verdict from the meta-reviewer must block the gate.

If PLAN-020-2's `reviewer-chains-v1.json` schema does not yet include `trigger.kind == "path-filter"` (it currently supports `trigger == "frontend"` per the PLAN-020-2 task list), this spec REQUIRES extending the schema's `trigger` discriminated union to include the path-filter shape. The schema change is documented here:

```json
"trigger": {
  "oneOf": [
    { "type": "string", "enum": ["frontend"] },
    {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "paths"],
      "properties": {
        "kind": { "type": "string", "enum": ["path-filter"] },
        "paths": { "type": "array", "items": { "type": "string", "minLength": 1 }, "minItems": 1 }
      }
    }
  ]
}
```

The meta-reviewer entry MUST be added to all five request types (`feature`, `bug`, `infra`, `refactor`, `hotfix`) since `standards.yaml` changes can land in any request type.

### `schemas/reviewer-finding-v1.json` Modification

Add the optional top-level field:

```json
"requires_two_person_approval": {
  "type": "boolean",
  "description": "Set true by the standards-meta-reviewer when a PR contains major changes (immutable rules, framework requirement changes). The aggregator gates the merge until two distinct human approvers have approved the PR."
}
```

The field is optional; absence means `false`. The schema's existing `additionalProperties: false` already permits this addition (it explicitly declares the field). No other reviewer is expected to set this field today, but the schema permits it for future governance reviewers.

### `src/reviewers/aggregator.ts` Modification

Locate the existing aggregation function (PLAN-020-2 Task 6). After the existing scoring/blocking logic, add the two-person-approval gate:

```typescript
// New: two-person-approval gate
const requiresTwoPersonApproval = reviewerOutputs
  .some((output) => output.requires_two_person_approval === true);

if (requiresTwoPersonApproval) {
  const approvers = await loadDistinctHumanApprovers(prContext);
  if (approvers.length < 2) {
    return {
      verdict: 'BLOCKED',
      reason: `Two-person approval required (immutable rule or framework change). ${approvers.length} of 2 distinct approvals received.`,
      // ...preserve existing fields
    };
  }
}
```

`loadDistinctHumanApprovers(prContext)` is a small helper (added in this spec) that queries the GitHub PR's review list and returns the unique set of GitHub logins that have submitted an `APPROVED` review. Bot accounts (login ending in `[bot]` or matching the configured bot allowlist from PLAN-018-2's config) are excluded. The helper's signature:

```typescript
async function loadDistinctHumanApprovers(prContext: PrContext): Promise<string[]>;
```

Implementation notes:
- The helper consumes `prContext` (which already exists in the aggregator's scope per PLAN-020-2). If `prContext.repo`, `prContext.prNumber`, or the GH token is unavailable (e.g., local-only runs), the helper returns the empty array, which results in a `BLOCKED` verdict with a clear reason — fail-closed for governance changes.
- "Distinct" is by login string equality (case-insensitive normalization).
- The PR author is NOT counted as an approver even if they self-approved (defensive against accidental auto-approval).

### Aggregator Output Compatibility

The new `verdict: 'BLOCKED'` value MUST be added to the aggregator's verdict enum if not already present. PLAN-020-2's existing verdicts are likely `PASS | FAIL | ADVISORY`. The two-person-approval gate produces `BLOCKED` (a distinct fourth value) so downstream consumers can distinguish a governance hold from a quality failure. Document the new value in the aggregator's exported types.

## Acceptance Criteria

- [ ] `agents/standards-meta-reviewer.md` exists with frontmatter `name: standards-meta-reviewer`, `model: claude-sonnet-4-6`, and `tools: [Read, Glob, Grep]` (exactly these three tools, no others).
- [ ] The agent file's prompt body contains four labeled sections: "Detect rule conflicts", "Detect unworkability", "Detect impact", "Detect overly broad predicates".
- [ ] The prompt body contains the two-person-approval directive and explicitly enumerates the three trigger conditions (add immutable rule, remove immutable rule, add/modify framework requirement).
- [ ] The prompt body contains the false-positive guard ("Treat a rule update as a single change, NOT a delete-then-add").
- [ ] The prompt body contains the impact-scan cap ("limit your commit scan to the most recent 50 commits").
- [ ] The agent file's frontmatter passes the agent-meta-reviewer (PLAN-017-2) checklist (verifiable manually pre-merge); in particular, the read-only-tools constraint is enforced.
- [ ] `config_defaults/reviewer-chains.json` contains a `standards-meta-reviewer` entry under each of the five request types' `pr_review` gates.
- [ ] Each meta-reviewer entry has `trigger.kind: "path-filter"` and `trigger.paths: ["**/.autonomous-dev/standards.yaml"]`.
- [ ] Each meta-reviewer entry has `blocking: true`.
- [ ] `schemas/reviewer-chains-v1.json` accepts the new path-filter trigger shape (verified by ajv-cli against `config_defaults/reviewer-chains.json`).
- [ ] `schemas/reviewer-finding-v1.json` accepts a finding object with `requires_two_person_approval: true` and continues to accept findings without the field.
- [ ] `src/reviewers/aggregator.ts` produces verdict `BLOCKED` with a reason mentioning "Two-person approval required" when any reviewer output has `requires_two_person_approval: true` and fewer than 2 distinct human approvers exist.
- [ ] When 2 distinct human approvers exist, the two-person-approval gate passes and the existing scoring logic determines the final verdict.
- [ ] The PR author's own approval does not count toward the 2-approver threshold (verified via a unit-test scenario with author=approver).
- [ ] Bot accounts (login ending in `[bot]`) are excluded from the approver count.
- [ ] When `prContext` lacks GH credentials (local-only run), the aggregator returns `BLOCKED` rather than silently passing.

## Dependencies

- **PLAN-020-1** (existing): `schemas/reviewer-finding-v1.json` — extended by this spec with one optional field.
- **PLAN-020-2** (existing): `config_defaults/reviewer-chains.json`, `schemas/reviewer-chains-v1.json`, `src/reviewers/aggregator.ts`, scheduler's path-filter trigger evaluation. This spec extends each.
- **PLAN-017-2** (existing): `agent-meta-reviewer` validates `standards-meta-reviewer.md` pre-merge as a quality gate (no code dependency, just a process gate).
- **GitHub REST API** (runtime): the aggregator's `loadDistinctHumanApprovers()` helper queries `GET /repos/{owner}/{repo}/pulls/{number}/reviews`. The existing `prContext` already carries the GH token; no new credential plumbing.
- **No new external libraries**.

## Notes

- The agent is intentionally narrow: read-only tools mean it cannot accidentally modify the repo it is auditing. The `agent-meta-reviewer` from PLAN-017-2 enforces this constraint as a pre-merge check; this spec relies on that check rather than re-implementing the rule.
- The path-filter trigger lives on the reviewer entry (not as a separate config block) so future governance reviewers can be added the same way without further config schema work.
- Two-person approval is enforced at the aggregator (not at the reviewer) because the meta-reviewer is stateless w.r.t. approval counts; the aggregator already has the PR context. This keeps the agent prompt focused on auditing the diff, not querying the GitHub API.
- The `BLOCKED` verdict is distinct from `FAIL` so observability can distinguish "code quality issue" from "governance hold". Operator dashboards (out-of-scope here) can surface BLOCKED differently.
- Future extensibility: if new categories of "major change" emerge (e.g., adding a new evaluator from PLAN-021-2's catalog with broad scope), the directive's enumeration can be extended without changing the aggregator. The aggregator only checks the boolean flag; it does not interpret the cause.
- The PLAN-021-3 task 7 acceptance criterion mentions "A PR removing an immutable rule (also a major change) likewise" — this is captured in the prompt's enumeration. The acceptance criterion above ("set `requires_two_person_approval: true` ... if the diff REMOVES any existing rule with `immutable: true`") covers it.
