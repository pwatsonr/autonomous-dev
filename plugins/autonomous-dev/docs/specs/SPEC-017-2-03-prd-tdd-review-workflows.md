# SPEC-017-2-03: prd-review.yml and tdd-review.yml Workflows

## Metadata
- **Parent Plan**: PLAN-017-2
- **Tasks Covered**: Task 6 (prd-review.yml), Task 7 (tdd-review.yml)
- **Estimated effort**: 2.5 hours
- **Future location**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-017-2-03-prd-tdd-review-workflows.md`

## Description
Author the first two consumer workflows that wire the SPEC-017-2-01/02 composite into PR-triggered checks: `prd-review.yml` for product requirements documents and `tdd-review.yml` for technical design documents. Both share the same shape — paths-filter, trust-gate job, document-review job — differing only in the path glob, agent name, and the rubric threshold (both 85 per PLAN-017-2 scope). This spec is intentionally short: the heavy lifting lives in the composite; the workflows are thin wrappers per the design that delivers a small per-workflow YAML footprint.

Both workflows declare `permissions: contents: read, pull-requests: write`, depend on the trust-gate from PLAN-017-1's composite, run with a 10-minute timeout, and produce status checks named `docs/prd-review` and `docs/tdd-review` respectively for branch-protection wiring.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `.github/workflows/prd-review.yml` | Create | Triggered on `plugins/*/docs/prd/PRD-*.md`; agent `prd-reviewer`; threshold 85 |
| `.github/workflows/tdd-review.yml` | Create | Triggered on `plugins/*/docs/tdd/TDD-*.md`; agent `tdd-reviewer`; threshold 85 |

## Implementation Details

### Common Workflow Shape

Both workflows share this structure (parameterized below per file):

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
          threshold: "85"
          prompt-template-path: plugins/autonomous-dev/agents/<agent-basename>.md
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### `prd-review.yml` Specifics

| Parameter | Value |
|-----------|-------|
| Workflow name | `PRD Review` |
| Trigger paths | `plugins/*/docs/prd/PRD-*.md` |
| Job step header comment | "Reviews PRDs against the rubric in plugins/autonomous-dev/agents/prd-reviewer.md (threshold 85). Status check: docs/prd-review." |
| `document-type` | `prd` |
| `agent-name` | `prd-reviewer` |
| `prompt-template-path` | `plugins/autonomous-dev/agents/prd-reviewer.md` |
| `threshold` | `"85"` |
| Status check produced | `docs/prd-review` |

### `tdd-review.yml` Specifics

| Parameter | Value |
|-----------|-------|
| Workflow name | `TDD Review` |
| Trigger paths | `plugins/*/docs/tdd/TDD-*.md` |
| Job step header comment | "Reviews TDDs for requirements traceability against the parent PRD per TDD-017 §5 (threshold 85). Status check: docs/tdd-review." |
| `document-type` | `tdd` |
| `agent-name` | `tdd-reviewer` |
| `prompt-template-path` | `plugins/autonomous-dev/agents/tdd-reviewer.md` |
| `threshold` | `"85"` |
| Status check produced | `docs/tdd-review` |

### Header Comment Template

Each workflow file begins with a comment block documenting trust model and verdict format so future readers do not have to chase the composite README:

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
# Threshold: <NN>. Set in the document-review composite invocation below.
# Smoke test PRs: <to be filled by SPEC-017-2-05 task 11>
```

### Concurrency Group Reasoning

The `concurrency.group` keys on workflow + PR number with `cancel-in-progress: true` so a force-push to the PR cancels the in-flight review and starts a fresh one. This avoids stacking reviews and minimizes Claude spend per the budget concerns owned by PLAN-017-4.

### Why Two Files Instead of One Matrix Workflow

PLAN-017-2 explicitly requires five separate workflows so each produces its own paths-filter, status-check name, and sticky-comment marker. A single matrix workflow would either trigger on all five path globs (defeating the per-document-type filter that keeps PR noise low) or require a paths-filter per matrix row (which GitHub Actions does not support). Per-file workflows are also easier to grant differentiated permissions if needed in future.

## Acceptance Criteria

- [ ] `.github/workflows/prd-review.yml` exists and `actionlint` exits 0.
- [ ] `.github/workflows/tdd-review.yml` exists and `actionlint` exits 0.
- [ ] Both workflows declare `permissions: contents: read, pull-requests: write` exactly (no other permissions granted).
- [ ] Both workflows declare `timeout-minutes: 10` on the review job.
- [ ] Both workflows declare `concurrency` with `group: ${{ github.workflow }}-${{ github.event.pull_request.number }}` and `cancel-in-progress: true`.
- [ ] Both workflows define a `trust-gate` job that uses `./.github/actions/claude-trust-gate` and exposes `allowed` as a job output.
- [ ] Both workflows' `review` job declares `needs: trust-gate` and `if: needs.trust-gate.outputs.allowed == 'true'`.
- [ ] Both workflows pass `prompt-template-path` to the document-review composite, pointing to a file under `plugins/autonomous-dev/agents/`.
- [ ] `prd-review.yml` triggers on path glob `plugins/*/docs/prd/PRD-*.md` and ONLY that glob.
- [ ] `tdd-review.yml` triggers on path glob `plugins/*/docs/tdd/TDD-*.md` and ONLY that glob.
- [ ] A test PR touching only a PRD file triggers `prd-review.yml` and does NOT trigger `tdd-review.yml` (verified by inspecting workflow runs for the PR).
- [ ] A test PR touching only a TDD file triggers `tdd-review.yml` and does NOT trigger `prd-review.yml`.
- [ ] Both workflows pass `threshold: "85"` to the composite.
- [ ] Both workflows pass `ANTHROPIC_API_KEY` from `secrets.ANTHROPIC_API_KEY` via job-level `env`.
- [ ] All third-party actions are pinned by commit SHA (no tag refs like `@v4` in the actual YAML).
- [ ] Each workflow's header comment block contains the 6-step composite summary, the threshold value, and a placeholder for smoke-test PR URLs.
- [ ] Status check names appear exactly as `docs/prd-review` and `docs/tdd-review` on test PRs (visible in the PR's checks tab).

## Dependencies

- **SPEC-017-2-01** (blocking): The `document-review` composite must exist and accept the documented inputs.
- **SPEC-017-2-02** (blocking): Verdict parsing, sticky comment, and commit status steps must be wired in the composite — without these, the workflows would only produce the neutral-pass behavior.
- **PLAN-017-1 / SPEC-017-1-XX** (blocking): The `claude-trust-gate` composite at `.github/actions/claude-trust-gate` must exist and expose an `allowed` output.
- **Reviewer agents** (must exist): `plugins/autonomous-dev/agents/prd-reviewer.md` and `plugins/autonomous-dev/agents/tdd-reviewer.md`. This spec does not create or modify them. If either does not exist, the workflow will fail at the prompt-loading step in the composite — this is the desired loud failure.
- **Repository secrets**: `ANTHROPIC_API_KEY` must be configured at the repo or org level. Without it, the Claude invocation step in the composite fails.
- **Branch protection** (downstream consumer): Branch protection rules referencing `docs/prd-review` and `docs/tdd-review` are configured outside this spec; the spec produces stable status-check names that those rules can consume.

## Notes

- These two workflows are deliberately thin. Anything more substantive would belong in the composite. This spec aims for a workflow file under 60 lines each (excluding the header comment), making them trivial to audit.
- The path glob `plugins/*/docs/prd/PRD-*.md` matches both `plugins/autonomous-dev/docs/prd/PRD-001.md` and `plugins/autonomous-dev-portal/docs/prd/PRD-001.md`, supporting the multi-plugin layout from PLAN-013-1. If a future plugin uses a different doc structure, it adds its own paths-filter; the existing workflows do not need to change.
- The `cancel-in-progress: true` choice trades off "always have the latest review" vs "never waste a Claude run." For document review, latest-wins is the right call: an outdated review on a force-pushed PR is misleading.
- `tdd-review.yml`'s threshold matches `prd-review.yml` (both 85) per PLAN-017-2 scope. The TDD agent's prompt is responsible for the additional traceability check against the parent PRD; this workflow does not enforce that separately — it relies on the agent doing its job.
- SPEC-017-2-04 follows the same pattern for plan-review and spec-review with threshold 80. SPEC-017-2-05 introduces the divergent agent-meta-review with checklist mode.
- These workflows have no direct integration with PLAN-017-4's budget gate. PLAN-017-4 task 8 will add a `needs: [budget-gate]` dependency or an early-exit guard via a separate `if:` clause; that wiring is intentionally not owned here so this spec can ship independently.
