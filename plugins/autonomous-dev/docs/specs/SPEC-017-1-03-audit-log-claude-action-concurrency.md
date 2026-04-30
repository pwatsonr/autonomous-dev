# SPEC-017-1-03: Audit Logging, Claude Action Invocation & Concurrency Cancellation Verification

## Metadata
- **Parent Plan**: PLAN-017-1
- **Tasks Covered**: Task 4 (audit logging step), Task 5 (anthropics/claude-code-action@v1 invocation), Task 7 (concurrency cancellation verification)
- **Estimated effort**: 4.5 hours

## Description
Layer the runtime behavior of `claude-assistant.yml` on top of the scaffold from SPEC-017-1-02. This spec adds three changes to the `respond` job, in the following execution order:

1. **Audit log step** — writes the triggering user, association level, comment URL, and UTC timestamp to `$GITHUB_STEP_SUMMARY`. Runs unconditionally (`if: always()`) so failed runs still record who triggered them.
2. **Claude action step** — invokes `anthropics/claude-code-action@v1` with the comment body as the prompt, `--max-turns 5`, and the `ANTHROPIC_API_KEY` secret.
3. **Concurrency verification** — a manual smoke-test procedure documented in this spec; no code changes for the test itself.

The placeholder `echo` step from SPEC-017-1-02 is removed. The Claude step is responsible for posting Claude's reply on the issue/PR (the action handles that internally via the GitHub token derived from `permissions:`). The audit log writes only GitHub-public data; no API keys, no comment bodies (which can contain author-controlled content), no Claude responses.

This spec does NOT add the spend artifact emission — that lives in SPEC-017-1-04 along with the trust-model header comment. Splitting these keeps the diff sizes manageable and isolates the artifact's HMAC contract for focused review.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/.github/workflows/claude-assistant.yml` | Modify | Replace placeholder step with audit-log step, then Claude step |
| `plugins/autonomous-dev/docs/runbooks/claude-assistant-concurrency-test.md` | Create | Manual concurrency-cancellation procedure (one-page runbook) |

## Implementation Details

### Modified `respond` Job

After this spec, the `respond` job contains exactly two steps (audit log, then Claude action). Step ordering matters: the audit log MUST run before the Claude step so a Claude failure (timeout, API error, rate limit) still leaves an auditable record.

```yaml
respond:
  name: Respond to @claude mention
  needs: trust-check
  runs-on: ubuntu-latest
  if: >-
    contains(github.event.comment.body, '@claude') &&
    needs.trust-check.outputs.is-trusted == 'true'
  steps:
    - name: Write audit log
      if: always()
      run: |
        set -euo pipefail
        timestamp_utc="$(date -u +%FT%TZ)"
        {
          echo "## Claude assistant invocation"
          echo ""
          echo "| Field | Value |"
          echo "|-------|-------|"
          echo "| Actor | ${{ github.event.comment.user.login }} |"
          echo "| Association | ${{ github.event.comment.author_association }} |"
          echo "| Comment URL | ${{ github.event.comment.html_url }} |"
          echo "| UTC timestamp | $timestamp_utc |"
        } >> "$GITHUB_STEP_SUMMARY"

    - name: Invoke Claude
      uses: anthropics/claude-code-action@v1
      with:
        anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
        prompt: ${{ github.event.comment.body }}
        claude_args: '--max-turns 5'
```

### Audit Log Contract

The four required fields and their sources:

| Field | Source | Rationale |
|-------|--------|-----------|
| Actor | `github.event.comment.user.login` | The GitHub login of the commenter. Public data. |
| Association | `github.event.comment.author_association` | The trust level that passed the gate. Tells reviewers WHY the workflow ran. |
| Comment URL | `github.event.comment.html_url` | Direct link back to the triggering comment for forensic review. |
| UTC timestamp | `date -u +%FT%TZ` | ISO-8601 UTC timestamp at the moment the audit step runs. |

Notes:
- `if: always()` is critical. Without it, a failed Claude step would skip the audit log per default behavior. With `always()`, the audit log runs whether or not a downstream step fails or the job is cancelled.
- The comment body is intentionally NOT logged. It can contain attacker-controlled prose, secrets pasted by the actor, or large blobs that bloat the summary. The URL is sufficient for traceability.
- The Claude response is intentionally NOT logged. Logging model output back into the workflow summary is a tempting debugging convenience but creates a sink for prompt-injection attempts to surface in audit-only views.

### Claude Action Invocation Contract

| Input | Value | Constraint |
|-------|-------|------------|
| `anthropic_api_key` | `${{ secrets.ANTHROPIC_API_KEY }}` | Must be a repository secret. Never log; never expose in expression syntax that could surface in error messages. |
| `prompt` | `${{ github.event.comment.body }}` | The comment body verbatim. Never concatenate with file content or shell-interpolated paths. |
| `claude_args` | `'--max-turns 5'` | A literal string. Never interpolate from comment content. |

Forbidden patterns (must NOT appear in this spec or its successors without an explicit security review):
- `prompt: ${{ github.event.comment.body }} - file: $(cat some/path)` — inlines file content into the prompt; future `--attach` work uses the action's attach mechanism instead.
- `claude_args: ${{ github.event.comment.body }}` — interpolates user content into the args string; would allow attackers to set arbitrary `--max-turns`, `--model`, etc.
- `claude_args: --max-turns ${{ env.SOMETHING }}` where `SOMETHING` is derived from a comment.

Pin: `@v1` is the major-version pin per autonomous-dev policy. Patch updates within v1 are accepted automatically; breaking changes (v2+) require an explicit migration spec.

### Concurrency Cancellation Verification (Task 7)

This spec ships a one-page runbook at `docs/runbooks/claude-assistant-concurrency-test.md` that describes the manual test procedure:

1. Open or use an existing draft PR in a repo where `claude-assistant.yml` is installed and the test author has trusted association.
2. From the trusted account, post comment 1: `@claude please count to 100 slowly.`
3. Within 10 seconds, post comment 2: `@claude what's 2+2?`
4. Open the Actions tab and verify:
   - Two `claude-assistant` runs were initiated.
   - The first run shows status `cancelled` (not `failed` and not `success`).
   - The second run shows status `success`.
   - Exactly one Claude reply is posted on the PR (the answer to comment 2).
5. Verify both runs' `respond` job logged audit entries to their workflow summaries (cancelled runs still execute the `if: always()` audit step before cancellation if the job had started).

The runbook also documents that the concurrency key `claude-assistant-${{ github.event.issue.number }}` is per-PR/per-issue, not global. Two trusted users commenting on different PRs at the same time do NOT cancel each other.

### Runbook File Structure

`docs/runbooks/claude-assistant-concurrency-test.md` must contain, in order:

1. **Purpose** — One sentence: verify concurrency cancellation works as designed.
2. **Prerequisites** — Trusted GitHub account; a draft PR; `claude-assistant.yml` installed; `ANTHROPIC_API_KEY` configured.
3. **Procedure** — The five numbered steps above.
4. **Expected outcome** — Bulleted list (cancelled+success, single Claude reply, both audit logs present).
5. **Troubleshooting** — At minimum: "no runs initiated" (check `@claude` substring + trust gate); "both runs succeeded" (check `cancel-in-progress: true` is set in the workflow's `concurrency` block).

The runbook must be ≤ 60 lines.

## Acceptance Criteria

- [ ] `claude-assistant.yml`'s `respond` job contains exactly two steps after this spec: `Write audit log`, then `Invoke Claude`. The placeholder echo step from SPEC-017-1-02 is removed.
- [ ] The `Write audit log` step has `if: always()`.
- [ ] Audit log writes all four required fields (Actor, Association, Comment URL, UTC timestamp) to `$GITHUB_STEP_SUMMARY` as a Markdown table.
- [ ] Audit log does NOT write the comment body, the Claude response, or any secret value to the summary.
- [ ] UTC timestamp is generated via `date -u +%FT%TZ` (ISO-8601 with trailing Z).
- [ ] `Invoke Claude` step uses `anthropics/claude-code-action@v1` (literal `@v1`, not floating).
- [ ] `anthropic_api_key` input is exactly `${{ secrets.ANTHROPIC_API_KEY }}`; no other source.
- [ ] `prompt` input is exactly `${{ github.event.comment.body }}`; no concatenation, no file content.
- [ ] `claude_args` input is the literal string `'--max-turns 5'`; no interpolation from event data.
- [ ] `actionlint` passes on the modified workflow with zero warnings.
- [ ] `docs/runbooks/claude-assistant-concurrency-test.md` exists, is ≤ 60 lines, and contains all five documented sections (Purpose, Prerequisites, Procedure, Expected outcome, Troubleshooting).
- [ ] Runbook explicitly states the expected outcome: first run `cancelled`, second run `success`, exactly one Claude reply posted.
- [ ] Manual smoke test executed at least once before sign-off; result documented as a comment on the PR for this spec.
- [ ] When the manual smoke test runs against an untrusted commenter, no Claude reply appears AND no audit log is written (the `respond` job is skipped before any of its steps run, so no summary entry).

## Dependencies

- **SPEC-017-1-02** (Workflow Scaffold) must be merged first; this spec edits the `respond` job created there.
- **SPEC-017-1-01** (Composite Action) must be merged first (transitive dependency via SPEC-017-1-02).
- Repository secret `ANTHROPIC_API_KEY` configured before manual smoke test.
- `anthropics/claude-code-action@v1` — pinned external action; trusted by Anthropic policy.
- A draft PR or test issue available for the manual concurrency test.

## Notes

- `if: always()` on the audit step does NOT mean the step runs when the job is skipped (a skipped job has no steps). It means the step runs whether or not earlier steps in the SAME job succeeded. Combined with the trust-gate `if:` on the job itself, the audit log is only written for runs that passed the trust gate, which is the desired behavior — there is nothing to audit for silent-skipped runs.
- The Markdown-table format for the summary is chosen for readability in the GitHub UI; the same data could be a JSON blob if a future plan needs machine-parseable audit. Deferred until a consumer materializes.
- Cancelled runs that have started executing the `respond` job will run the `if: always()` audit step before the cancellation takes effect (GitHub's cancellation is cooperative on a per-step basis). This is intentional and desirable: cancelled runs are still audited.
- This spec lives at `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-017-1-03-audit-log-claude-action-concurrency.md` once promoted from staging.
- The runbook for the manual concurrency test is intentionally a markdown file rather than an automated CI test. Automating the test would require a real Claude invocation in CI (cost), an `ANTHROPIC_API_KEY` exposed to PR authors (security regression), and timing flakiness handling. The manual test is run once during initial verification and re-run if the workflow's concurrency block changes.
