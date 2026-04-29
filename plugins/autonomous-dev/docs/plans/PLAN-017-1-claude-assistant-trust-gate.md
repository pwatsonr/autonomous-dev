# PLAN-017-1: Claude Assistant Workflow & Trust Gate

## Metadata
- **Parent TDD**: TDD-017-claude-workflows-release
- **Estimated effort**: 3 days
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P0

## Objective
Deliver the foundational `claude-assistant.yml` workflow that responds to `@claude` mentions in PR/issue comments via `anthropics/claude-code-action@v1`, plus the reusable `actions/claude-trust-gate` composite action that enforces the `author_association` trust boundary used by every downstream Claude-powered workflow. This plan establishes the security-critical pattern of passing file content via `--attach` (never inlined into the prompt) and silent-skip for untrusted authors so attackers receive no signal about the trust boundary.

## Scope
### In Scope
- `.github/actions/claude-trust-gate/action.yml` composite action that takes an `author_association` value and outputs a boolean `is-trusted` flag for `OWNER`/`MEMBER`/`COLLABORATOR`
- `.github/workflows/claude-assistant.yml` workflow triggered by `issue_comment` (created) on issues and PRs
- Top-level `if:` gate that runs the workflow only when the comment body contains `@claude` AND `author_association` is in the trusted set; silent-skip (no comment, no error) for untrusted authors per TDD §4.2.2
- `concurrency` group keyed by issue/PR number with `cancel-in-progress: true` so rapid-fire comments don't stack
- Audit-log step writing the triggering user, association level, comment URL, and UTC timestamp to the workflow summary per TDD §4.2.3
- `anthropics/claude-code-action@v1` invocation with `claude_args: "--max-turns 5"` (no `--attach` here since the prompt is the comment body itself, but the composite enforces no string interpolation of file paths from the comment)
- Spend artifact upload step (HMAC-signed) producing `.github/budget/spend-${{ github.run_id }}.json` consumed by PLAN-017-4's budget gate
- 30-day retention on spend artifacts
- Documentation: header comment in the workflow explaining the trust model and how to extend
- Unit tests for the composite action's boolean logic (5 cases: each association level)

### Out of Scope
- Document review workflows (prd-review, tdd-review, plan-review, spec-review, agent-meta-review) -- PLAN-017-2 reuses this composite
- Release and assist-eval workflows -- PLAN-017-3
- Budget gate enforcement -- PLAN-017-4 (this plan emits the artifact; the gate consumes it)
- Anthropic API key provisioning -- ops concern, secret named `ANTHROPIC_API_KEY` is a precondition
- Rate limiting beyond what `concurrency` provides -- not in TDD-017 scope
- Multi-language assistance -- TDD-017 NG-05 explicitly defers

## Tasks

1. **Author the `claude-trust-gate` composite action** -- Create `.github/actions/claude-trust-gate/action.yml` with input `author-association` (string, required) and output `is-trusted` (string `"true"` or `"false"`). Implementation: a single bash step that compares the input against the allow-list `OWNER MEMBER COLLABORATOR` and writes the result to `$GITHUB_OUTPUT`.
   - Files to create: `.github/actions/claude-trust-gate/action.yml`
   - Acceptance criteria: `actionlint` passes. Composite action is callable from another workflow (`uses: ./.github/actions/claude-trust-gate`). Inputs `OWNER`, `MEMBER`, `COLLABORATOR` produce `is-trusted=true`. Inputs `CONTRIBUTOR`, `FIRST_TIMER`, `NONE`, empty string produce `is-trusted=false`. Action README documents the contract.
   - Estimated effort: 2h

2. **Scaffold `claude-assistant.yml` workflow** -- Create `.github/workflows/claude-assistant.yml` with `name`, `on: issue_comment` (types `[created]`), top-level `permissions` (`contents: read`, `pull-requests: write`, `issues: write`), `concurrency` group `claude-assistant-${{ github.event.issue.number }}` with `cancel-in-progress: true`.
   - Files to create: `.github/workflows/claude-assistant.yml`
   - Acceptance criteria: `actionlint` passes. Workflow has correct event filter and concurrency key. Permissions match TDD §4.1.
   - Estimated effort: 1.5h

3. **Implement top-level trust gate `if:`** -- Add a single job-level `if:` that combines two conditions: `contains(github.event.comment.body, '@claude')` AND the result of the composite action when called via `uses: ./.github/actions/claude-trust-gate`. Use a job-level approach: a `trust-check` job runs the composite, then the `respond` job depends on `needs.trust-check.outputs.is-trusted == 'true'`.
   - Files to modify: `.github/workflows/claude-assistant.yml`
   - Acceptance criteria: Comment from OWNER containing `@claude` triggers the `respond` job. Comment from CONTRIBUTOR containing `@claude` does NOT trigger `respond` (verified by manual draft PR test). Comment from OWNER without `@claude` does NOT trigger. No reply or error is posted in the silent-skip case (TDD §4.2.2).
   - Estimated effort: 2h

4. **Implement audit logging step** -- In the `respond` job, add a step that writes to `$GITHUB_STEP_SUMMARY`: triggering user login, association level, full comment URL (`github.event.comment.html_url`), UTC timestamp from `date -u +%FT%TZ`. The step runs unconditionally (not gated by `if: success()`) so failed runs still log who triggered them.
   - Files to modify: `.github/workflows/claude-assistant.yml`
   - Acceptance criteria: Workflow summary shows the four required fields after every run. Failed runs (e.g., Claude API error) still log the trigger metadata. No PII beyond GitHub-public data is logged.
   - Estimated effort: 1h

5. **Wire the `anthropics/claude-code-action@v1` invocation** -- Add the Claude step with `anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}`, `claude_args: "--max-turns 5"`, and `prompt: ${{ github.event.comment.body }}`. Critical: the prompt is the comment body, not a string-interpolated path. File content is never inlined into prompts in this workflow (the comment IS the input). Per TDD §4.1, do NOT pass file paths from the comment via shell; that's a future feature gated by the security review.
   - Files to modify: `.github/workflows/claude-assistant.yml`
   - Acceptance criteria: Action is pinned to `v1`. Anthropic API key comes from a secret, never from comment content. `claude_args` is a literal string, not interpolated from the comment. A test comment "@claude what's the time?" produces a Claude reply on the PR.
   - Estimated effort: 1.5h

6. **Implement spend artifact emission** -- Add a step that constructs a JSON object with fields `workflow`, `run_id`, `actor`, `month` (ISO `YYYY-MM`), `estimated_cost_usd`, `timestamp`, plus an HMAC field `hmac` computed via `HMAC-SHA256(BUDGET_HMAC_KEY, canonical_json_without_hmac)`. Write to `.github/budget/spend-${{ github.run_id }}.json` and upload via `actions/upload-artifact@v4` with `retention-days: 90` (consumed by PLAN-017-4's gate).
   - Files to modify: `.github/workflows/claude-assistant.yml`
   - Acceptance criteria: Artifact is created on every successful Claude invocation. JSON validates against the spend artifact schema (will be vendored in PLAN-017-4 task 12 fixtures). HMAC field is non-empty and matches the canonical-JSON computation. Artifact uploads with name pattern `spend-estimate-<run_id>`.
   - Estimated effort: 2h

7. **Add concurrency cancellation test** -- Manual test: post two `@claude` comments on the same PR within 10 seconds. Verify the first run is cancelled and only the second produces a reply. Document the expected behavior in the workflow header comment.
   - Files to modify: None (test-only, document in workflow header)
   - Acceptance criteria: Two rapid comments produce one Claude reply (the second). The first run shows "cancelled" status in the Actions tab. Concurrency key `claude-assistant-${{ github.event.issue.number }}` is documented in the workflow header.
   - Estimated effort: 1h

8. **Author composite action tests** -- Create `tests/ci/test_claude_trust_gate.bats` with one test per association level: `OWNER`, `MEMBER`, `COLLABORATOR` (all should output `is-trusted=true`), and `CONTRIBUTOR`, `FIRST_TIMER`, `NONE`, `""` (empty), `null` (all should output `is-trusted=false`). Tests invoke the composite via `nektos/act` or a direct shell harness that simulates `$GITHUB_OUTPUT`.
   - Files to create: `tests/ci/test_claude_trust_gate.bats`
   - Acceptance criteria: All eight test cases pass. Coverage of the composite's bash logic is 100% (the logic is small enough to enumerate). Tests run in `<10s` total.
   - Estimated effort: 2h

9. **Document the trust model** -- Add a comment block at the top of `claude-assistant.yml` (15-30 lines) explaining: (a) the silent-skip pattern for untrusted authors, (b) the `--attach` rule for any future feature that adds file content, (c) the `author_association` allow-list, (d) how to extend the workflow without weakening the trust boundary. Cross-link to TDD §4 and PRD-010 §FR-4001..FR-4007.
   - Files to modify: `.github/workflows/claude-assistant.yml`
   - Acceptance criteria: Comment block is present, ≤30 lines, references TDD-017 §4 and PRD-010 §4. Comment uses `#` (YAML) line comments, not `<!-- -->`.
   - Estimated effort: 0.5h

## Dependencies & Integration Points

**Exposes to other plans:**
- `.github/actions/claude-trust-gate/action.yml` composite action consumed by PLAN-017-2 (five document-review workflows + agent-meta-review) and PLAN-017-3 (release.yml's changelog generation step that invokes Claude).
- Spend artifact contract (JSON shape + HMAC field) consumed by PLAN-017-4's budget aggregation. This plan defines the producer side; PLAN-017-4 defines the consumer side.
- The "silent-skip for untrusted authors" precedent that PLAN-017-2/3 follow.
- `BUDGET_HMAC_KEY` secret usage pattern (read via `${{ secrets.BUDGET_HMAC_KEY }}`, never logged).

**Consumes from other plans:**
- None (foundational plan).

## Testing Strategy

- **Composite unit tests (task 8):** Eight cases covering the full `author_association` enum, run via bats with mocked `$GITHUB_OUTPUT`.
- **Manual smoke test (task 7):** Post real `@claude` comments from accounts with each association level. Verify the silent-skip behavior for untrusted authors (no reply, no error visible to attacker).
- **Concurrency test (task 7):** Rapid-fire comment test confirms `cancel-in-progress: true` works as expected.
- **Spend artifact verification:** After a Claude run, download the artifact via `gh run download` and verify the JSON shape and HMAC field validate against the contract (using the verifier script vendored in PLAN-017-4 task 2).
- **No mocking of `claude-code-action@v1`:** The action is pinned to v1; we trust its contract. If the action's API changes, the failure mode is "Claude doesn't reply" which is detected by manual smoke testing.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Attacker posts `@claude` in a PR description (not comment) hoping it triggers; or uses `@cl<zwsp>aude` to bypass the substring match | Low | High -- prompt injection or unexpected invocation | Workflow trigger is `issue_comment` only, not `pull_request`. The substring match is `contains()` which is byte-exact; zero-width tricks only hide the trigger, they don't re-add it. Composite action's allow-list is the primary defense — even if the trigger fires, an untrusted author is silent-skipped. |
| Future feature that adds `--attach` is implemented incorrectly and inlines file content into the prompt string | Medium | Critical -- prompt injection vector | Header comment (task 9) explicitly documents the rule. Composite-action README has a "Common pitfalls" section. PR template adds a checkbox: "If this PR adds file content to a Claude prompt, content is passed via `--attach`, not interpolated." Reviewer checks this for any change to a Claude workflow. |
| `anthropics/claude-code-action@v1` rate-limits or queues requests, causing visible delays for trusted users | Medium | Low -- UX degradation only | Concurrency cancellation prevents stacking. If queueing becomes a problem, add a job-level timeout and post a "still working..." comment after 5 minutes (deferred to a follow-up). |
| Spend artifact's HMAC computation is non-deterministic across Node versions, causing PLAN-017-4's verifier to reject valid artifacts | Medium | Medium -- gate falsely fails | Use the canonical-JSON helper (vendored in PLAN-017-4 task 2). This plan and PLAN-017-4 share `scripts/ci/canonical-json.js`. Coordinate via task 6's acceptance criteria which require fixture verification. |
| Comment with `@claude` posted on an issue (not PR) triggers the workflow but `pull-requests: write` permission isn't applicable | Low | Low -- workflow runs but Claude can't post replies on issues | Permissions block includes `issues: write`. Manual smoke test on an issue verifies behavior. |

## Definition of Done

- [ ] `.github/actions/claude-trust-gate/action.yml` exists and passes all 8 unit tests
- [ ] `.github/workflows/claude-assistant.yml` exists, passes `actionlint`, and has the documented header comment
- [ ] Workflow triggers only on `issue_comment` of type `created`
- [ ] Trust gate combines `contains(comment.body, '@claude')` AND composite-action `is-trusted=true`
- [ ] Untrusted author with `@claude` produces silent-skip (no reply, no error, manual test verified)
- [ ] Audit log writes user, association, comment URL, UTC timestamp to workflow summary on every run
- [ ] `anthropics/claude-code-action@v1` is pinned and invoked with `--max-turns 5`
- [ ] Spend artifact is uploaded after every successful Claude invocation with the HMAC contract from PLAN-017-4
- [ ] Concurrency cancellation works (rapid-fire comment test verified)
- [ ] Header comment documents the trust model with links to TDD-017 §4 and PRD-010 §FR-4001..4007
- [ ] No `actionlint` warnings on the workflow or composite action
- [ ] All third-party actions pinned to a major version (`@v1`, `@v4`, etc.)
