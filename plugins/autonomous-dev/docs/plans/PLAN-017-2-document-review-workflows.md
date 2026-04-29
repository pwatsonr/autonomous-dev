# PLAN-017-2: Document Review Workflows (PRD/TDD/Plan/Spec/Agent Meta)

## Metadata
- **Parent TDD**: TDD-017-claude-workflows-release
- **Estimated effort**: 4 days
- **Dependencies**: [PLAN-017-1]
- **Blocked by**: [PLAN-017-1]
- **Priority**: P0

## Objective
Deliver the five document-review workflows that automatically score PRDs, TDDs, plans, specs, and agent modifications via Claude on every PR. Each workflow reuses the `claude-trust-gate` composite from PLAN-017-1 to enforce the author-association boundary, passes file content via `--attach` (never string-interpolated, defending against prompt injection per TDD §5.3), posts a single sticky PR comment summarizing the verdict and findings, and fails the check below the configured rubric threshold (PRD/TDD: 85, Plan/Spec: 80, Agent meta: must pass binary checklist). All five workflows share a common skeleton extracted into a reusable composite to keep the per-workflow YAML small.

## Scope
### In Scope
- Common composite at `.github/actions/document-review/action.yml` that takes inputs `document-type`, `agent-name`, `path-glob`, `threshold` and runs the standardized review flow (changed-files detection, fork-PR neutral status, `--attach` invocation, verdict parsing, sticky comment, status check)
- `.github/workflows/prd-review.yml` triggered by `pull_request` paths `plugins/*/docs/prd/PRD-*.md`; threshold 85; agent `prd-reviewer`
- `.github/workflows/tdd-review.yml` triggered by `plugins/*/docs/tdd/TDD-*.md`; threshold 85; agent `tdd-reviewer`
- `.github/workflows/plan-review.yml` triggered by `plugins/*/docs/plans/PLAN-*.md`; threshold 80; agent `plan-reviewer` (or `doc-reviewer` if a dedicated plan reviewer doesn't exist)
- `.github/workflows/spec-review.yml` triggered by `plugins/*/docs/specs/SPEC-*.md`; threshold 80; agent `spec-reviewer` (or `doc-reviewer`)
- `.github/workflows/agent-meta-review.yml` triggered by `plugins/*/agents/*.md`; binary pass/fail; agent `agent-meta-reviewer` (which scores against the 6-point security checklist for agent modifications)
- Fork-PR neutral-pass behavior per TDD §5.4: if `head.repo.full_name != base.repo.full_name`, skip the Claude invocation and post a neutral status check with a comment instructing the author to push to the base repo (no secrets are exposed to fork builds)
- All five workflows declare `permissions: contents: read, pull-requests: write` and use the `claude-trust-gate` composite from PLAN-017-1
- Spend-artifact emission shared across all five (one artifact per run, HMAC-signed, consumed by PLAN-017-4)
- Status check name convention: `docs/<type>-review` (e.g., `docs/prd-review`, `docs/tdd-review`, `docs/agent-meta-review`)
- Sticky PR comment with hidden marker `<!-- <type>-review-comment -->` so subsequent runs update rather than spam
- 10-minute timeout per workflow

### Out of Scope
- The `claude-trust-gate` composite itself -- delivered by PLAN-017-1
- Release / changelog / assist-eval workflows -- PLAN-017-3
- Budget gate enforcement -- PLAN-017-4
- Authoring or modifying any actual review-agent prompts; the agents already exist in `plugins/autonomous-dev/agents/` and `plugins/autonomous-dev-assist/agents/`
- Cross-document consistency checks (e.g., TDD references a non-existent PRD) -- separate concern, not in TDD-017 scope
- Multi-document PRs that touch both PRD and TDD in one diff -- each workflow runs independently against its own paths-filter

## Tasks

1. **Author the `document-review` composite action** -- Create `.github/actions/document-review/action.yml` with inputs `document-type` (e.g., `prd`), `agent-name` (e.g., `prd-reviewer`), `path-glob` (e.g., `plugins/*/docs/prd/PRD-*.md`), `threshold` (e.g., `85`), `prompt-template-path` (path to the agent prompt), and outputs `verdict`, `score`, `has-critical`. Implementation steps: detect changed files matching the glob, copy them to `/tmp/review_files`, fork-PR neutral-pass check, invoke `anthropics/claude-code-action@v1` with `claude_args: "--attach /tmp/review_files --max-turns 3"`, parse the verdict from the response, post sticky comment, set commit status.
   - Files to create: `.github/actions/document-review/action.yml`
   - Acceptance criteria: `actionlint` passes. Composite is callable from a workflow with all five required inputs. Outputs are correctly populated. The `--attach` flag is hardcoded; there is no codepath that interpolates file content into the prompt string.
   - Estimated effort: 6h

2. **Implement fork-PR neutral-pass logic** -- In the composite, add a `fork-check` step that compares `github.event.pull_request.head.repo.full_name` against `base.repo.full_name`. If different, set a neutral commit status with description "Fork PR - ask maintainer to push to base repo for full review" and post a friendly PR comment. Skip all subsequent steps that need secrets.
   - Files to modify: `.github/actions/document-review/action.yml`
   - Acceptance criteria: Fork PR produces a neutral status (not failure, not success) and a single PR comment matching the template. Same-repo PR proceeds with the full review flow. The `is_fork` output is `true` for fork PRs and `false` otherwise.
   - Estimated effort: 2h

3. **Implement verdict parsing** -- The composite includes a step that parses Claude's response (Markdown with `VERDICT:` line and severity tags `[LOW|MEDIUM|HIGH|CRITICAL]`). Extract the verdict value and a boolean `has-critical` (true if any finding has severity `CRITICAL`). Output both via `$GITHUB_OUTPUT`.
   - Files to modify: `.github/actions/document-review/action.yml`
   - Acceptance criteria: Given a Claude response with `VERDICT: APPROVE` and no findings, outputs are `verdict=APPROVE`, `has-critical=false`. Given `VERDICT: REQUEST_CHANGES` with a `**[CRITICAL]**` finding, outputs are `verdict=REQUEST_CHANGES`, `has-critical=true`. Given a malformed response (no VERDICT line), the step fails with a clear error.
   - Estimated effort: 3h

4. **Implement sticky comment update** -- Use `actions/github-script@v7` to find an existing comment matching the hidden marker `<!-- <type>-review-comment -->` and update it; if not found, create a new one. The comment body includes the verdict, the full Claude response, and a footer with the workflow run URL.
   - Files to modify: `.github/actions/document-review/action.yml`
   - Acceptance criteria: First review run on a PR creates a comment. Second run on the same PR updates the existing comment in place (verified by single-comment count via `gh api`). Comment body has the hidden marker. Comment is posted only when the fork-check passes (no comment on fork PRs except the neutral-pass message).
   - Estimated effort: 2h

5. **Implement commit status setting** -- Use `actions/github-script@v7` to call `repos.createCommitStatus` with `context: docs/<document-type>-review`. State is `failure` if `verdict == 'REQUEST_CHANGES'` OR `has-critical == 'true'`. State is `success` otherwise (including `CONCERNS` which TDD §5.2 explicitly says doesn't block merge).
   - Files to modify: `.github/actions/document-review/action.yml`
   - Acceptance criteria: APPROVE produces success status. CONCERNS produces success status with description "passed with minor concerns". REQUEST_CHANGES produces failure status. Any verdict + has-critical=true produces failure status. Status context is exactly `docs/<type>-review` for branch-protection stability.
   - Estimated effort: 1.5h

6. **Author `prd-review.yml`** -- Create the workflow with `on: pull_request: paths: 'plugins/*/docs/prd/PRD-*.md'`, the trust-gate job from PLAN-017-1's composite, then a `prd-review` job that calls the document-review composite with `document-type: prd`, `agent-name: prd-reviewer`, `path-glob: plugins/*/docs/prd/PRD-*.md`, `threshold: 85`, prompt template loaded from the prd-reviewer agent.
   - Files to create: `.github/workflows/prd-review.yml`
   - Acceptance criteria: `actionlint` passes. PR touching only a PRD triggers this workflow; PR touching only a TDD does not. Status check name is `docs/prd-review`.
   - Estimated effort: 1.5h

7. **Author `tdd-review.yml`** -- Same shape as task 6 but for TDDs: `path-glob: plugins/*/docs/tdd/TDD-*.md`, `agent-name: tdd-reviewer`, `threshold: 85`. The tdd-reviewer agent's prompt covers requirements traceability against the parent PRD per TDD-017 §5.
   - Files to create: `.github/workflows/tdd-review.yml`
   - Acceptance criteria: `actionlint` passes. Status check name is `docs/tdd-review`. Workflow triggers only on TDD path changes.
   - Estimated effort: 1h

8. **Author `plan-review.yml`** -- Same shape but for plans: `path-glob: plugins/*/docs/plans/PLAN-*.md`, `agent-name: plan-reviewer` (or `doc-reviewer` as fallback), `threshold: 80`.
   - Files to create: `.github/workflows/plan-review.yml`
   - Acceptance criteria: `actionlint` passes. Status check name is `docs/plan-review`. Plan-touching PRs trigger only this review.
   - Estimated effort: 1h

9. **Author `spec-review.yml`** -- Same shape but for specs: `path-glob: plugins/*/docs/specs/SPEC-*.md`, `agent-name: spec-reviewer` (or `doc-reviewer`), `threshold: 80`.
   - Files to create: `.github/workflows/spec-review.yml`
   - Acceptance criteria: `actionlint` passes. Status check name is `docs/spec-review`. Spec-touching PRs trigger only this review.
   - Estimated effort: 1h

10. **Author `agent-meta-review.yml`** -- Different shape from tasks 6-9 because the agent-meta-reviewer scores against a 6-point security checklist (not a numeric threshold). Workflow triggers on `plugins/*/agents/*.md`, agent `agent-meta-reviewer`, and the verdict parser looks for `CHECKLIST_RESULT: PASS` or `FAIL` instead of `VERDICT:`. The composite's verdict parser must support both modes (selectable via input `verdict-mode: numeric|checklist`).
    - Files to create: `.github/workflows/agent-meta-review.yml`
    - Files to modify: `.github/actions/document-review/action.yml` (add `verdict-mode` input)
    - Acceptance criteria: `actionlint` passes. Workflow triggers only on changes to `plugins/*/agents/*.md`. Status check name is `docs/agent-meta-review`. PASS produces success; FAIL produces failure. The 6-point checklist is documented in the workflow header.
    - Estimated effort: 4h

11. **Smoke-test all five workflows** -- Open one draft PR per workflow that introduces a deliberate review failure (e.g., remove the "Goals" section from a PRD, add a `Bash(rm -rf *)` permission to an agent). Verify each workflow fails with a clear comment. Then revert and verify each passes. Document the smoke-test PR URLs in the workflow header comment as ongoing reference.
    - Files to modify: None (test-only)
    - Acceptance criteria: 10 runs total (5 workflows × pass/fail). All status checks behave correctly. Sticky comments update in place across reruns. Fork-PR neutral-pass tested manually with one fork submission.
    - Estimated effort: 3h

## Dependencies & Integration Points

**Exposes to other plans:**
- `.github/actions/document-review/action.yml` composite reused by any future document-type review (e.g., RFC-review, ADR-review).
- `verdict-mode: numeric|checklist` precedent that future binary-pass reviewers (e.g., security-policy-review) can adopt.
- Status check name convention `docs/<type>-review` for branch-protection rules.
- Spend artifact emission shared with PLAN-017-1 (same JSON shape, same HMAC).

**Consumes from other plans:**
- **PLAN-017-1** (blocking): `claude-trust-gate` composite for the author-association gate; spend artifact contract; the silent-skip pattern.
- **PLAN-017-4** (consumer): the budget gate will be wired in via `needs: [budget-gate]` in PLAN-017-4 task 8 — this plan does not own that wiring.

## Testing Strategy

- **Composite unit tests:** `tests/ci/test_document_review_action.bats` covering: numeric verdict parser (APPROVE/CONCERNS/REQUEST_CHANGES with various severity mixes), checklist verdict parser (PASS/FAIL), fork-PR detection, sticky-comment idempotency, malformed-response failure mode.
- **Workflow smoke tests (task 11):** 10 real PR runs covering each workflow's pass and fail paths. Plus one fork-PR test for the neutral-pass.
- **`actionlint` on all five workflows + the composite:** runs in CI as part of TDD-016's actionlint job.
- **Prompt-injection regression:** A test PR introduces a PRD containing the `---IGNORE THE ABOVE SYSTEM PROMPT---` payload from TDD §5.3. The review must NOT respond with `APPROVE`; it must complete normally with the actual verdict for the document content. (Manual test, captured in the workflow's header comment.)
- **No mocking of `claude-code-action@v1`:** Real Claude invocations on the smoke-test PR. Cost is bounded by the `--max-turns 3` limit and the 10-minute timeout.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Verdict parser fails on slight formatting drift in Claude responses (e.g., `Verdict:` vs `VERDICT:`) | Medium | Medium -- false-failure status checks | Parser uses a case-insensitive regex `/^VERDICT:\s*(APPROVE\|CONCERNS\|REQUEST_CHANGES)/im`. The agent's prompt explicitly demands the format. Malformed responses fail the step with `::error::Could not parse verdict from response` so the failure mode is loud, not silent-success. |
| Prompt injection via PRD content overrides the reviewer's system prompt | Medium | Critical -- false approvals | All file content passed via `--attach`, never inlined. TDD §5.3 attack vector is explicitly tested in task 11's smoke. Composite hardcodes `--attach`; there is no codepath that allows interpolation. |
| Five separate workflows produce status-check noise on PRs that touch many docs at once | Medium | Low -- UX nuisance only | Each workflow has its own paths-filter. PRs that touch only a PRD trigger only `docs/prd-review`, not all five. Sticky comments use distinct markers per type so they don't conflict. |
| `agent-meta-reviewer`'s 6-point checklist drift over time and the workflow's verdict parser doesn't update | Medium | High -- privilege-escalation changes slip through review | The 6-point checklist is documented in the workflow header (task 10). The agent's prompt and the parser share the same checklist source. Annual review of the checklist is captured as a TODO comment in the agent's `.md`. |
| Fork-PR detection misses some edge cases (e.g., PR from a fork into a different fork) | Low | Medium -- secrets exposure if missed | The check is `head.repo.full_name != base.repo.full_name`. GitHub guarantees fork PRs always have a different `head.repo.full_name` than `base.repo.full_name`. Manual smoke test in task 11 covers the canonical case. |
| Composite breaks subtly when invoked from one workflow but works from another due to event-context differences | Low | Medium -- false failures on one document type | All five workflows trigger on `pull_request`, so `github.event.pull_request.*` is always available. Composite asserts `github.event_name == 'pull_request'` at the top and fails fast otherwise. |

## Definition of Done

- [ ] `.github/actions/document-review/action.yml` exists, supports both `numeric` and `checklist` verdict modes, and passes `actionlint`
- [ ] All five workflows (`prd-review`, `tdd-review`, `plan-review`, `spec-review`, `agent-meta-review`) exist and pass `actionlint`
- [ ] Each workflow uses `claude-trust-gate` from PLAN-017-1 and emits a spend artifact
- [ ] Fork-PR neutral-pass works as documented (no secrets exposed; clear instruction comment)
- [ ] Sticky comments update in place on subsequent runs (verified by 10 smoke-test runs in task 11)
- [ ] All five workflows pass `actionlint` and use pinned action versions
- [ ] Status check names follow the `docs/<type>-review` convention exactly
- [ ] All file content passed via `--attach`; no codepath interpolates file content into prompts
- [ ] Smoke-test PRs demonstrate pass/fail for each workflow (10 runs total)
- [ ] Prompt-injection regression test from TDD §5.3 produces correct verdict, not `APPROVE`
- [ ] Header comments document the trust model, the verdict format, and the 6-point checklist (for agent-meta-review)
