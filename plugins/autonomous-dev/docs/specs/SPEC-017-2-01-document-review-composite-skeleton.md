# SPEC-017-2-01: document-review Composite Action Skeleton + Fork-PR Neutral-Pass

## Metadata
- **Parent Plan**: PLAN-017-2
- **Tasks Covered**: Task 1 (composite action skeleton), Task 2 (fork-PR neutral-pass logic)
- **Estimated effort**: 8 hours
- **Future location**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-017-2-01-document-review-composite-skeleton.md`

## Description
Create the foundational `document-review` GitHub Actions composite action that all five document-review workflows (PRD/TDD/Plan/Spec/Agent Meta in subsequent specs) will reuse. This spec delivers two concerns: (1) the composite skeleton with declared inputs/outputs and the `claude-code-action@v1` invocation that passes file content via `--attach` (never string-interpolated, defending against the prompt injection vector documented in TDD-017 §5.3), and (2) the fork-PR neutral-pass branch that detects `head.repo.full_name != base.repo.full_name` and short-circuits to a neutral commit status before any secrets are touched.

This spec deliberately omits verdict parsing, sticky-comment update, and commit-status writing — those concerns belong to SPEC-017-2-02. The composite produced here is callable but produces only the neutral-pass output for fork PRs and a raw Claude response artifact for same-repo PRs; the consumer workflow has no useful verdict yet. Subsequent specs in PLAN-017-2 layer in the parsing and reporting steps.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `.github/actions/document-review/action.yml` | Create | Composite action: inputs, outputs, fork-check, changed-files detection, attach-only Claude invocation |
| `.github/actions/document-review/README.md` | Create | Usage docs: inputs table, outputs, the trust model, attach-only contract |
| `tests/ci/test_document_review_action.bats` | Create | Bats stub file with the fork-PR detection test (further tests added by SPEC-017-2-02) |

## Implementation Details

### Composite Inputs and Outputs

The composite declares the following surface (final shape; verdict-mode is added by SPEC-017-2-05):

```yaml
name: document-review
description: |
  Reusable review skeleton invoked by per-document-type workflows
  (prd-review, tdd-review, plan-review, spec-review, agent-meta-review).
  Hardcodes --attach for file content; no codepath interpolates file bodies
  into the prompt string (TDD-017 §5.3 prompt-injection defense).

inputs:
  document-type:
    description: "Slug used in the status-check name (e.g. 'prd', 'tdd', 'plan', 'spec', 'agent-meta')."
    required: true
  agent-name:
    description: "Reviewer agent file basename (e.g. 'prd-reviewer'). Loaded from plugins/*/agents/."
    required: true
  path-glob:
    description: "Glob the workflow already filtered on; used to enumerate changed files for --attach."
    required: true
  threshold:
    description: "Numeric rubric pass threshold (e.g. '85'). Ignored in checklist mode (SPEC-017-2-05)."
    required: false
    default: "0"
  prompt-template-path:
    description: "Path to the reviewer agent .md file under plugins/*/agents/."
    required: true

outputs:
  verdict:
    description: "Parsed verdict (populated by SPEC-017-2-02 step). Empty for fork-PR neutral-pass runs."
    value: ${{ steps.parse-verdict.outputs.verdict }}
  score:
    description: "Numeric score parsed from response (populated by SPEC-017-2-02). Empty if not in numeric mode."
    value: ${{ steps.parse-verdict.outputs.score }}
  has-critical:
    description: "true if any finding tagged [CRITICAL] (populated by SPEC-017-2-02)."
    value: ${{ steps.parse-verdict.outputs.has-critical }}
  is-fork:
    description: "true if the PR head.repo differs from base.repo; the rest of the flow short-circuits."
    value: ${{ steps.fork-check.outputs.is-fork }}
```

### Step Sequence (this spec)

The composite runs these steps in order. SPEC-017-2-02 adds steps 5-7.

1. **Assert event context** — `if: github.event_name != 'pull_request'` then `::error::document-review composite requires pull_request event`. Fail fast.
2. **Fork check** (`id: fork-check`) — Compare `${{ github.event.pull_request.head.repo.full_name }}` vs `${{ github.event.pull_request.base.repo.full_name }}`. Emit `is-fork=true|false` to `$GITHUB_OUTPUT`. If `true`:
   - Use `actions/github-script@v7` to set a neutral commit status with `context: docs/${{ inputs.document-type }}-review`, `state: success` (GitHub commit statuses lack a true "neutral" state; use success with description "Fork PR — secrets withheld; ask maintainer to push to base repo for full review").
   - Post a single PR comment with the hidden marker `<!-- ${{ inputs.document-type }}-review-comment -->` and the friendly fork-PR template (see "Fork-PR Comment Template" below).
   - Set `verdict=`, `score=`, `has-critical=false` on the parse-verdict output via a stub step (so the downstream workflow gets sensible defaults).
   - All subsequent steps must guard on `if: steps.fork-check.outputs.is-fork != 'true'`.
3. **Detect changed files** (`if: steps.fork-check.outputs.is-fork != 'true'`) — Use `tj-actions/changed-files@v45` (pinned to a commit SHA in the actual YAML) with `files: ${{ inputs.path-glob }}`. Output `all_changed_files` is the space-separated list.
4. **Stage attach payload** — Bash step: `mkdir -p /tmp/review_files && for f in ${{ steps.changed-files.outputs.all_changed_files }}; do cp "$f" "/tmp/review_files/$(basename "$f")"; done`. If the list is empty, exit early with `::notice::No matching files changed; skipping review`.
5. **Invoke Claude** — Use `anthropics/claude-code-action@v1` (pinned by SHA). Pass `claude_args: "--attach /tmp/review_files --max-turns 3"`. Set `prompt` to the contents of `${{ inputs.prompt-template-path }}` loaded via a prior `cat` step into an env var; the prompt itself contains no file content interpolation. Outputs the response to `$GITHUB_OUTPUT` as `claude-response` (multiline).

Steps 6 (parse verdict), 7 (sticky comment), and 8 (commit status) are deferred to SPEC-017-2-02. This spec emits the raw response as a step output but does not act on it.

### Fork-PR Comment Template

```
<!-- ${{ inputs.document-type }}-review-comment -->
## ${{ inputs.document-type }} Review — Fork PR Notice

This pull request originates from a fork (`${{ github.event.pull_request.head.repo.full_name }}`).
Repository secrets are not exposed to fork builds, so the automated reviewer cannot run.

**To get a full review:** a maintainer can push your branch to this repository and reopen the PR,
or rebase onto a branch in this repo.

_The status check has been marked passing so this notice does not block your PR; reviewers will
inspect manually._
```

### Trust Boundary Contract

The composite consumes the trust gate from SPEC-017-1's `claude-trust-gate` action *before* this composite is invoked at the workflow level. This composite assumes the trust gate has already passed. Document this clearly in the composite README so future workflow authors do not accidentally invoke `document-review` without `claude-trust-gate` upstream.

### README.md Skeleton

The composite's README must include, in order:
1. **Purpose** — One paragraph: why this composite exists, who calls it.
2. **Inputs / Outputs** — Two tables matching the YAML.
3. **Trust Model** — Explicit statement that this composite assumes `claude-trust-gate` ran and passed in a prior job; consumers MUST wire `needs: [trust-gate]` and `if: needs.trust-gate.outputs.allowed == 'true'`.
4. **Attach-Only Contract** — Why `--attach` is hardcoded (TDD-017 §5.3); explicit instruction to never modify the composite to inline file content.
5. **Fork-PR Behavior** — What happens, why secrets are not exposed, the sample comment shown to authors.
6. **Extension Points** — Pointer to SPEC-017-2-05 for the upcoming `verdict-mode` input.

### Bats Test Stub

`tests/ci/test_document_review_action.bats` is created with one passing test for fork-detection logic:

```bash
#!/usr/bin/env bats

@test "fork detection: head.repo == base.repo => is-fork=false" {
  HEAD_REPO="acme/proj"
  BASE_REPO="acme/proj"
  if [[ "$HEAD_REPO" != "$BASE_REPO" ]]; then result=true; else result=false; fi
  [ "$result" = "false" ]
}

@test "fork detection: head.repo != base.repo => is-fork=true" {
  HEAD_REPO="contributor/proj"
  BASE_REPO="acme/proj"
  if [[ "$HEAD_REPO" != "$BASE_REPO" ]]; then result=true; else result=false; fi
  [ "$result" = "true" ]
}
```

SPEC-017-2-02 will extend this file with verdict-parsing tests.

## Acceptance Criteria

- [ ] `.github/actions/document-review/action.yml` exists and `actionlint` exits 0.
- [ ] All five inputs (`document-type`, `agent-name`, `path-glob`, `threshold`, `prompt-template-path`) are declared with `required` flags and descriptions.
- [ ] All four outputs (`verdict`, `score`, `has-critical`, `is-fork`) are declared.
- [ ] The composite asserts `github.event_name == 'pull_request'` and fails with a clear error otherwise.
- [ ] The fork-check step compares `head.repo.full_name` vs `base.repo.full_name` and emits `is-fork` to `$GITHUB_OUTPUT`.
- [ ] When `is-fork=true`, the composite posts a neutral commit status with description containing "Fork PR" and exits without invoking Claude.
- [ ] When `is-fork=true`, a single PR comment is posted with the hidden marker `<!-- {document-type}-review-comment -->` and the fork-PR template body.
- [ ] When `is-fork=false`, the changed-files step runs and stages matching files into `/tmp/review_files`.
- [ ] The Claude invocation step uses `claude_args: "--attach /tmp/review_files --max-turns 3"` exactly. There is no codepath in the composite that string-concatenates file content into the `prompt` parameter (verified by grep for `${{ steps.*.outputs.*content*` patterns in action.yml: must return zero matches).
- [ ] All third-party actions (`tj-actions/changed-files`, `actions/github-script`, `anthropics/claude-code-action`) are pinned to commit SHAs, not tag names.
- [ ] `tests/ci/test_document_review_action.bats` exists with at least the two fork-detection tests above and `bats tests/ci/test_document_review_action.bats` exits 0.
- [ ] `.github/actions/document-review/README.md` contains all 6 documented sections in order.
- [ ] README explicitly states the trust-gate prerequisite and the attach-only contract.

## Dependencies

- **PLAN-017-1 / SPEC-017-1-XX** (blocking): The `claude-trust-gate` composite action must exist; this composite assumes it ran and passed in a prior workflow job. This spec does not invoke trust-gate directly — the consumer workflows in SPEC-017-2-03/04/05 wire the dependency.
- **GitHub Actions runtime**: `actions/github-script@v7`, `tj-actions/changed-files@v45`, `anthropics/claude-code-action@v1` (all pinned by SHA in the actual YAML).
- **Reviewer agents**: This spec does not create or modify any agent prompts; it loads them by path from `inputs.prompt-template-path`. The agents (`prd-reviewer`, `tdd-reviewer`, `plan-reviewer`/`doc-reviewer`, `spec-reviewer`/`doc-reviewer`, `agent-meta-reviewer`) are assumed to exist in `plugins/autonomous-dev/agents/` and `plugins/autonomous-dev-assist/agents/`.

## Notes

- This spec is intentionally narrow. It produces a callable composite with a no-op verdict-parsing step (empty outputs). SPEC-017-2-02 fills in parsing, sticky comments, and commit status. The split keeps each spec testable in isolation: this one verifies the skeleton + fork-PR branch; the next verifies the report-back logic.
- Commit status uses `state: success` for fork PRs (with a "Fork PR — secrets withheld" description) because GitHub's commit status API has no native "neutral" state — only check runs do, and we are using commit statuses for branch-protection compatibility. Description text makes the rationale unambiguous to PR viewers.
- The `--max-turns 3` cap and 10-minute timeout (set by the consumer workflow) bound the cost per invocation. PLAN-017-2's spend-artifact emission for budget tracking is layered on by PLAN-017-4 — this spec does not own that wiring.
- Future additions like RFC-review or ADR-review can call this composite directly with their own `document-type` and `path-glob`, satisfying PLAN-017-2's "exposes to other plans" contract.
- The composite README is a contract document, not marketing; it must be read by anyone authoring a new document-type workflow downstream.
