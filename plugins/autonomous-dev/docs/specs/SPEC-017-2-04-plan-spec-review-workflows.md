# SPEC-017-2-04: plan-review.yml and spec-review.yml Workflows

## Metadata
- **Parent Plan**: PLAN-017-2
- **Tasks Covered**: Task 8 (plan-review.yml), Task 9 (spec-review.yml)
- **Estimated effort**: 2 hours
- **Future location**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-017-2-04-plan-spec-review-workflows.md`

## Description
Author two more consumer workflows wiring the SPEC-017-2-01/02 composite into PR-triggered checks: `plan-review.yml` for plan documents and `spec-review.yml` for spec documents. These follow the same thin-wrapper pattern as SPEC-017-2-03 (PRD/TDD), differing only in the path glob, agent name, and a lower rubric threshold of 80 (vs 85 for PRD/TDD) per PLAN-017-2 scope. The lower threshold reflects that plans and specs are working-level documents iterated more rapidly than the foundational PRD/TDD layer.

Both workflows declare `permissions: contents: read, pull-requests: write`, depend on the `claude-trust-gate` from PLAN-017-1's composite, run with a 10-minute timeout, and produce status checks named `docs/plan-review` and `docs/spec-review` for branch-protection wiring. Each falls back to the generic `doc-reviewer` agent if a dedicated `plan-reviewer` or `spec-reviewer` does not exist in the agents directory.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `.github/workflows/plan-review.yml` | Create | Triggered on `plugins/*/docs/plans/PLAN-*.md`; agent `plan-reviewer` (fallback `doc-reviewer`); threshold 80 |
| `.github/workflows/spec-review.yml` | Create | Triggered on `plugins/*/docs/specs/SPEC-*.md`; agent `spec-reviewer` (fallback `doc-reviewer`); threshold 80 |

## Implementation Details

### Common Shape

Both workflows reuse the structure defined in SPEC-017-2-03's "Common Workflow Shape" section verbatim. Re-stated here so this spec is self-contained:

```yaml
name: <Document Type> Review
on:
  pull_request:
    paths:
      - "<path-glob>"

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  trust-gate:
    name: Trust gate
    runs-on: ubuntu-latest
    timeout-minutes: 2
    outputs:
      allowed: ${{ steps.gate.outputs.allowed }}
    steps:
      - uses: actions/checkout@v4  # PIN-BY-SHA
        with:
          fetch-depth: 0
      - uses: ./.github/actions/claude-trust-gate
        id: gate

  review:
    name: <Document Type> Review
    needs: trust-gate
    if: needs.trust-gate.outputs.allowed == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4  # PIN-BY-SHA
        with:
          fetch-depth: 0
      - uses: ./.github/actions/document-review
        with:
          document-type: <slug>
          agent-name: <agent-basename>
          path-glob: "<path-glob>"
          threshold: "80"
          prompt-template-path: <prompt-path>
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### `plan-review.yml` Specifics

| Parameter | Value |
|-----------|-------|
| Workflow name | `Plan Review` |
| Trigger paths | `plugins/*/docs/plans/PLAN-*.md` |
| `document-type` | `plan` |
| `agent-name` | `plan-reviewer` if `plugins/autonomous-dev/agents/plan-reviewer.md` exists at workflow author time; otherwise `doc-reviewer` (resolved at spec-implementation time, not at runtime) |
| `prompt-template-path` | `plugins/autonomous-dev/agents/plan-reviewer.md` (or `…/doc-reviewer.md` per fallback) |
| `threshold` | `"80"` |
| Status check produced | `docs/plan-review` |

### `spec-review.yml` Specifics

| Parameter | Value |
|-----------|-------|
| Workflow name | `Spec Review` |
| Trigger paths | `plugins/*/docs/specs/SPEC-*.md` |
| `document-type` | `spec` |
| `agent-name` | `spec-reviewer` if `plugins/autonomous-dev/agents/spec-reviewer.md` exists; otherwise `doc-reviewer` |
| `prompt-template-path` | `plugins/autonomous-dev/agents/spec-reviewer.md` (or `…/doc-reviewer.md` per fallback) |
| `threshold` | `"80"` |
| Status check produced | `docs/spec-review` |

### Agent Fallback Resolution

The implementer of this spec must check whether the dedicated agent files exist *at the time of implementation* (not at runtime — workflows do not branch on file existence; they hard-code the path). Resolution procedure:

1. List `plugins/autonomous-dev/agents/*.md` and `plugins/autonomous-dev-assist/agents/*.md`.
2. If `plan-reviewer.md` exists in either, set `prompt-template-path` to that file's path.
3. Otherwise, set `prompt-template-path` to `plugins/autonomous-dev/agents/doc-reviewer.md` (which must exist; if it doesn't, halt and escalate — this is a missing prerequisite from the agents inventory).
4. Repeat for `spec-reviewer.md` → `doc-reviewer.md`.

The chosen path is hard-coded into the workflow YAML. There is no runtime conditional. This keeps the workflow trivially auditable and `actionlint`-clean.

### Header Comment Template

Same as SPEC-017-2-03's "Header Comment Template" section, with the relevant slug substituted:

```yaml
# <Document Type> Review Workflow
#
# Triggers on PRs that modify <path-glob>. Runs the document-review composite
# (see .github/actions/document-review/README.md) which:
#   1. Enforces the claude-trust-gate (author-association boundary; PLAN-017-1)
#   2. Detects fork PRs and posts a neutral status (no secrets exposed)
#   3. Invokes Claude with --attach (file content never inlined; TDD-017 §5.3)
#   4. Parses VERDICT: APPROVE|CONCERNS|REQUEST_CHANGES
#   5. Posts a sticky PR comment marked <!-- <slug>-review-comment -->
#   6. Sets commit status docs/<slug>-review
#
# Status check fails if VERDICT is REQUEST_CHANGES or any finding is **[CRITICAL]**.
# CONCERNS does NOT block merge per TDD-017 §5.2.
#
# Threshold: 80 (lower than PRD/TDD's 85, reflecting working-level iteration cadence).
# Reviewer agent: <agent-basename>.md
# Smoke test PRs: <to be filled by SPEC-017-2-05 task 11>
```

### Why 80 vs 85

PLAN-017-2 sets PRD/TDD at threshold 85 and Plan/Spec at 80. The workflows here do not enforce this — the composite's parser captures the score, and the agent prompts are tuned to verdict APPROVE/CONCERNS/REQUEST_CHANGES based on rubric outcome. The numeric `threshold` input is currently informational (passed for forward compatibility); it is the agent prompt that owns the threshold semantics. This is documented in the composite README from SPEC-017-2-01.

### Concurrency Group Reasoning

Same as SPEC-017-2-03: cancel-in-progress on force-push to avoid stacking reviews and to bound Claude spend.

## Acceptance Criteria

- [ ] `.github/workflows/plan-review.yml` exists and `actionlint` exits 0.
- [ ] `.github/workflows/spec-review.yml` exists and `actionlint` exits 0.
- [ ] Both workflows declare `permissions: contents: read, pull-requests: write` exactly.
- [ ] Both workflows declare `timeout-minutes: 10` on the review job.
- [ ] Both workflows declare `concurrency` with `group: ${{ github.workflow }}-${{ github.event.pull_request.number }}` and `cancel-in-progress: true`.
- [ ] Both workflows define a `trust-gate` job that uses `./.github/actions/claude-trust-gate` and exposes `allowed` as a job output.
- [ ] Both workflows' `review` job declares `needs: trust-gate` and `if: needs.trust-gate.outputs.allowed == 'true'`.
- [ ] `plan-review.yml` triggers on path glob `plugins/*/docs/plans/PLAN-*.md` and ONLY that glob.
- [ ] `spec-review.yml` triggers on path glob `plugins/*/docs/specs/SPEC-*.md` and ONLY that glob.
- [ ] A test PR touching only a plan file triggers `plan-review.yml` and does NOT trigger `spec-review.yml`, `prd-review.yml`, or `tdd-review.yml`.
- [ ] A test PR touching only a spec file triggers `spec-review.yml` and does NOT trigger any other document-review workflow.
- [ ] Both workflows pass `threshold: "80"` to the composite.
- [ ] Each workflow's `prompt-template-path` points to a file that exists in the agents directory at the time the workflow is added (verified by the spec implementer per the Agent Fallback Resolution procedure above).
- [ ] Both workflows pass `ANTHROPIC_API_KEY` from `secrets.ANTHROPIC_API_KEY` via job-level `env`.
- [ ] All third-party actions pinned by commit SHA (no `@v4`/`@v7` tag refs in the actual YAML).
- [ ] Header comment block in each file contains the 6-step composite summary, the threshold value (80), the chosen reviewer agent basename, and a placeholder for smoke-test PR URLs.
- [ ] Status check names appear exactly as `docs/plan-review` and `docs/spec-review` on test PRs.
- [ ] If `plan-reviewer.md` and `spec-reviewer.md` exist as dedicated files, the workflows reference them; otherwise the spec implementer documents the fallback to `doc-reviewer.md` in the workflow header comment.

## Dependencies

- **SPEC-017-2-01** (blocking): The `document-review` composite skeleton.
- **SPEC-017-2-02** (blocking): Verdict parsing, sticky comment, and commit status steps wired in the composite.
- **PLAN-017-1 / SPEC-017-1-XX** (blocking): The `claude-trust-gate` composite at `.github/actions/claude-trust-gate`.
- **Reviewer agents** (must exist): At minimum `plugins/autonomous-dev/agents/doc-reviewer.md` MUST exist (fallback). Optionally `plan-reviewer.md` and `spec-reviewer.md`. Resolution happens at spec-implementation time; the spec implementer MUST verify file existence before committing the workflow YAML and MUST document the chosen fallback in the header comment.
- **Repository secrets**: `ANTHROPIC_API_KEY` configured at the repo or org level.
- **Branch protection** (downstream consumer): Rules referencing `docs/plan-review` and `docs/spec-review` are configured outside this spec.

## Notes

- These workflows are intentionally a near-copy of SPEC-017-2-03's PRD/TDD pair. The duplication is by design: PLAN-017-2 mandates per-document-type files for paths-filter clarity and per-type sticky-comment markers. A matrix workflow would compromise both. The composite absorbs the actual logic, so the per-file overhead is ~50 lines each.
- The fallback to `doc-reviewer` is a one-time decision made at spec implementation, not a runtime branch. This keeps the workflow trivially auditable. If the dedicated reviewer agents are added later, a follow-up PR updates the workflow YAML; this is a low-effort change with a single line modified per workflow.
- Plan and spec PRs are higher-volume than PRD/TDD PRs in steady state. The threshold of 80 (vs 85) reflects this: working-level documents tolerate slightly looser scoring without becoming sloppy. The agent prompt owns the actual semantics; this spec passes 80 forward for future compatibility.
- The lower threshold also matters indirectly for budget: lower threshold → more APPROVE verdicts → fewer rerun cycles → less Claude spend over the long run. PLAN-017-4's budget gate is independent but benefits from this design choice.
- Same as SPEC-017-2-03: no direct wiring to PLAN-017-4's budget gate. That dependency is added by PLAN-017-4 task 8.
- SPEC-017-2-05 picks up the divergent fifth workflow (agent-meta-review with checklist mode), which deliberately differs from these four to enforce a binary security-checklist outcome rather than a numeric rubric.
