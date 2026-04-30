# SPEC-017-1-02: claude-assistant.yml Workflow Scaffold & Trust Gate Wiring

## Metadata
- **Parent Plan**: PLAN-017-1
- **Tasks Covered**: Task 2 (scaffold claude-assistant.yml), Task 3 (implement top-level trust gate `if:`)
- **Estimated effort**: 3.5 hours

## Description
Scaffold the `claude-assistant.yml` GitHub Actions workflow that responds to `@claude` mentions in issue and PR comments. This spec creates the workflow file with its event trigger, permissions, concurrency policy, and the two-job structure (`trust-check` → `respond`) that wires in the `claude-trust-gate` composite action from SPEC-017-1-01. The `respond` job's body is a placeholder bash step in this spec — the audit log, Claude action invocation, and spend artifact are layered in by SPEC-017-1-03 and SPEC-017-1-04.

The trust gate uses two combined conditions: `contains(github.event.comment.body, '@claude')` AND `needs.trust-check.outputs.is-trusted == 'true'`. When either condition fails the workflow silent-skips: no comment is posted, no error surfaces in the Actions UI beyond the `respond` job's `skipped` status. This silent-skip is the security-critical UX from TDD-017 §4.2.2 — attackers learn nothing about the trust boundary.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/.github/workflows/claude-assistant.yml` | Create | Workflow with `issue_comment` trigger, two jobs, trust-gate wiring |

## Implementation Details

### Workflow Skeleton

The workflow is structured as two jobs:

1. **`trust-check`** — runs the `claude-trust-gate` composite, exposes `is-trusted` as a job output. Always runs (no `if:` gate) because its only job is to compute the boolean.
2. **`respond`** — depends on `trust-check`. Its job-level `if:` combines the comment-substring check and the trust-gate output. Body is a placeholder echo step in this spec; subsequent specs add audit logging (017-1-03), the Claude action call (017-1-03), and spend artifact emission (017-1-04).

```yaml
name: claude-assistant

on:
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write

concurrency:
  group: claude-assistant-${{ github.event.issue.number }}
  cancel-in-progress: true

jobs:
  trust-check:
    name: Evaluate author trust
    runs-on: ubuntu-latest
    outputs:
      is-trusted: ${{ steps.gate.outputs.is-trusted }}
    steps:
      - name: Checkout (for composite action)
        uses: actions/checkout@v4
        with:
          persist-credentials: false
      - name: Evaluate author_association
        id: gate
        uses: ./.github/actions/claude-trust-gate
        with:
          author-association: ${{ github.event.comment.author_association }}

  respond:
    name: Respond to @claude mention
    needs: trust-check
    runs-on: ubuntu-latest
    if: >-
      contains(github.event.comment.body, '@claude') &&
      needs.trust-check.outputs.is-trusted == 'true'
    steps:
      - name: Placeholder (audit log + Claude invocation added in SPEC-017-1-03)
        run: |
          echo "Trust gate passed; downstream specs add audit + Claude steps."
```

### Event Trigger Choice

The workflow listens to `issue_comment` (types `[created]`) only. Both PR comments and issue comments arrive via this event — `pull_request` is intentionally NOT a trigger because PR descriptions are author-controlled and would expand the attack surface (an attacker could open a PR with `@claude` in the description). Comments require an explicit author_association which the composite gates on.

### Permissions

Matches TDD-017 §4.1:
- `contents: read` — enables checkout of the composite action.
- `pull-requests: write` — required for Claude to post replies on PRs in subsequent specs.
- `issues: write` — required for replies on issues (the workflow runs identically for issue comments).

No other permissions are granted. Notably, `id-token`, `actions: write`, and `packages: *` are absent.

### Concurrency

`group: claude-assistant-${{ github.event.issue.number }}` keys cancellation per issue/PR (issues and PRs share the same `issue.number` namespace in `issue_comment` events). `cancel-in-progress: true` ensures rapid-fire `@claude` comments cancel the prior in-flight run; only the latest comment produces a reply. The behavior is verified manually in SPEC-017-1-03's task list (Task 7 in the parent plan) and documented in the workflow header comment added by SPEC-017-1-04.

### Trust Gate Composition

The `respond` job's `if:` is the security boundary:

```yaml
if: >-
  contains(github.event.comment.body, '@claude') &&
  needs.trust-check.outputs.is-trusted == 'true'
```

Both conditions must hold. Important invariants:

- `contains()` is a byte-exact substring match. Zero-width-character tricks (e.g. `@cl<zwsp>aude`) do not match, which means they fail to trigger — the desired behavior.
- `needs.trust-check.outputs.is-trusted` is the literal string `"true"` or `"false"` (per the composite's contract); the `== 'true'` comparison is case-sensitive and tolerates no other values.
- Neither condition's failure produces a comment or error visible to the comment author. The `respond` job appears as `skipped` in the Actions UI; the `trust-check` job always succeeds (its job is just to compute a boolean). From an attacker's perspective the workflow is indistinguishable from "not configured for this repo."

### Checkout Configuration

`actions/checkout@v4` is invoked with `persist-credentials: false`. The composite action does not need git credentials — it only needs the `action.yml` file at `./.github/actions/claude-trust-gate/`. Disabling credential persistence reduces the blast radius if a downstream spec accidentally adds a step that runs untrusted code.

## Acceptance Criteria

- [ ] `plugins/autonomous-dev/.github/workflows/claude-assistant.yml` exists and passes `actionlint` with zero warnings or errors.
- [ ] `name:` is `claude-assistant`.
- [ ] `on:` is exactly `issue_comment` with `types: [created]` — no other events.
- [ ] Top-level `permissions:` block contains exactly three entries: `contents: read`, `pull-requests: write`, `issues: write`. No other permissions are granted.
- [ ] `concurrency.group` is `claude-assistant-${{ github.event.issue.number }}` and `cancel-in-progress: true`.
- [ ] Two jobs are defined: `trust-check` and `respond`. No other jobs.
- [ ] `trust-check` job declares `outputs.is-trusted` mapped to `steps.gate.outputs.is-trusted`.
- [ ] `trust-check` job uses `actions/checkout@v4` with `persist-credentials: false` before invoking the composite.
- [ ] `trust-check` job invokes `./.github/actions/claude-trust-gate` with `author-association: ${{ github.event.comment.author_association }}` and no other inputs.
- [ ] `respond` job declares `needs: trust-check`.
- [ ] `respond` job's `if:` evaluates both `contains(github.event.comment.body, '@claude')` AND `needs.trust-check.outputs.is-trusted == 'true'` (combined with `&&`).
- [ ] `respond` job contains exactly one placeholder step that echoes a message; no Claude invocation, no audit log, no spend artifact in this spec (those are layered in by SPEC-017-1-03 and -04).
- [ ] All third-party actions are pinned to a major version (`@v4` for `actions/checkout`); no floating `@main` or `@master` references.
- [ ] When the workflow runs against a comment from an untrusted author containing `@claude`, the `respond` job appears as `skipped` (verified by manually inspecting a draft-PR test or by reading the rendered `if:` evaluation in `actionlint --shellcheck=never` output).

## Dependencies

- **SPEC-017-1-01** (Claude Trust Gate Composite Action) must be merged first — this workflow's `trust-check` job depends on `./.github/actions/claude-trust-gate/action.yml` being present.
- `actionlint` v1.6+ available on developer machines and CI for local validation.
- `actions/checkout@v4` (already used by other autonomous-dev workflows; no new dependency).
- A repository secret `ANTHROPIC_API_KEY` must exist before SPEC-017-1-03's Claude action call works at runtime; this spec does not consume the secret directly.

## Notes

- The `respond` job's body is intentionally a single placeholder step. Splitting the workflow scaffold from the audit-log + Claude-invocation work (SPEC-017-1-03) and the spend artifact + header docs (SPEC-017-1-04) keeps each PR small and reviewable. Each subsequent spec edits the same `respond` job, adding steps in a documented order.
- `concurrency` keys both issues and PRs by `github.event.issue.number`. GitHub uses the same numeric space for both within a repo when seen via `issue_comment`, so a comment on issue #42 and a comment on PR #42 share a concurrency group. This is the desired behavior — the workflow body cannot tell them apart at the trigger level, and the practical risk (one being cancelled by the other) is low and acceptable.
- The `if:` is evaluated server-side by GitHub before any runner is allocated for the `respond` job. Silent-skip therefore has zero compute cost beyond the `trust-check` job (which is itself trivial). This is intentional — we don't want a denial-of-spend vector where untrusted authors can burn CI minutes.
- This spec lives at `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-017-1-02-claude-assistant-workflow-scaffold.md` once promoted from staging.
- The substring match `contains(..., '@claude')` is liberal by design: it matches `@claude please review`, `Hey @claude`, `@claude-code`, etc. Restricting to a stricter regex (e.g. word boundary) is deferred until a documented need arises; the trust gate is the binding security control, not the substring match.
