# PRD-010: GitHub Actions CI/CD Pipeline

| Field       | Value                                      |
|-------------|--------------------------------------------|
| **Title**   | GitHub Actions CI/CD Pipeline               |
| **PRD ID**  | PRD-010                                    |
| **Version** | 1.0                                        |
| **Date**    | 2026-04-17                                 |
| **Author**  | Patrick Watson                             |
| **Status**  | Draft                                      |
| **Plugin**  | autonomous-dev (shared CI infrastructure)  |

---

## 0. Dependencies

This PRD cross-references PRD-008 and PRD-009, which are in review on GitHub PR #5 (branch `feat/prd-008-009-unified-submission-web-portal`). Links to those PRDs in §19 resolve correctly once PR #5 is merged to `main`. If this PR is reviewed before PR #5 merges, the reviewer should read PRD-008 and PRD-009 from that PR's diff. This PRD does not *depend on* PRD-008/009 implementation shipping (the assist eval gate, portal security cases, and CLI `observe` command can be stubbed with placeholders until those implementations land); it only references their specifications.

## 1. Problem Statement

The autonomous-dev repository has zero CI infrastructure today. Commits are pushed without automated validation, PRs are merged without test runs, security vulnerabilities slip through without scanning, and releases are performed manually without quality gates. PRD-001 NG-5 explicitly states "No built-in CI/CD pipeline. The engine invokes external CI systems; it does not replace them." The repository itself still needs CI to ensure quality *before* the autonomous pipeline ever runs.

The current operational pain is acute:
- Regressions can reach main without any test verification.
- Review agents defined in PRD-002 (prd-reviewer, tdd-reviewer, etc.) are not invoked on document PRs; reviews happen manually or not at all.
- Security vulnerabilities cannot pause the pipeline per PRD-007 FR-14 because no security scanning occurs on PRs.
- Assist eval thresholds required by PRD-008 §12.8 and PRD-009 §13.7 cannot be enforced because no workflow runs the eval harness.
- Plugin manifests (`.claude-plugin/plugin.json`) go unvalidated.
- Agent modification review (PRD-003 FR-32, agent-meta-reviewer) has no CI trigger.
- Releases are manual, error-prone, and lack changelog automation.

This creates a coordination failure between the autonomous pipeline (which assumes a stable, validated codebase) and the development process (which provides no such guarantee). The autonomous system can only be as reliable as the repository it operates from, and without CI, that reliability is zero.

PRD-010 establishes the **invocation contract** that PRD-001 NG-5 anticipated. GitHub Actions workflows provide the external CI system that the autonomous pipeline invokes for validation, and these same workflows independently ensure the quality of the autonomous system itself. The result is a dual-purpose CI infrastructure: it validates the pipeline's outputs AND validates the pipeline's implementation.

---

## 2. Goals

| ID     | Goal                                                                                                                                                                  |
|--------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| G-1001 | Establish baseline CI workflow that validates TypeScript compilation, linting, unit tests, shell scripts, markdown links, and plugin manifests on every PR.            |
| G-1002 | Implement eval regression gate that enforces assist eval thresholds (≥80% overall, ≥60% per case, ≤5pp suite regression) on releases and as advisory on PRs.          |
| G-1003 | Deploy Claude-powered PR assistance via `anthropics/claude-code-action@v1` that responds to `@claude` mentions and runs automated reviews on document changes.        |
| G-1004 | Enable security review workflow that scans every PR for vulnerabilities, secrets, and high-severity findings. Findings ≥ high severity pause merges per PRD-007 FR-14. |
| G-1005 | Provide automated release workflow that generates Claude-authored changelogs, validates plugin manifests, and creates per-plugin distribution artifacts.              |
| G-1006 | Integrate document review agents from PRD-002 as required status checks for PRD/TDD/Plan/Spec changes.                                                                |
| G-1007 | Add agent modification review workflow from PRD-003 that validates agent metadata changes and flags privilege escalation.                                             |
| G-1008 | Implement cost controls with monthly budget caps, per-workflow timeouts, and turn limits to prevent runaway Claude spending.                                          |
| G-1009 | Provide an opt-in scheduled observation workflow as an alternative to daemon-local cron for teams without a persistent daemon.                                        |
| G-1010 | Deliver production-grade branch protection: required status checks, review requirements, and merge policies documented per workflow.                                  |

## 3. Non-Goals

| ID      | Non-Goal                                                                                                                                    |
|---------|---------------------------------------------------------------------------------------------------------------------------------------------|
| NG-1001 | Replacing the daemon's autonomous pipeline. PRD-001 NG-5 stands: CI invokes the pipeline, doesn't replace it.                               |
| NG-1002 | Introducing a second LLM review loop that conflicts with PRD-002 gates. CI review workflows **trigger** the same reviewer agents PRD-002 defines; they don't re-invent reviewing. |
| NG-1003 | Self-hosted runners. Use GitHub-hosted by default for MVP.                                                                                  |
| NG-1004 | Jenkins, CircleCI, or other CI platforms. GitHub Actions is the only target.                                                                |
| NG-1005 | Multi-cloud deployment automation. CI validates and packages; deployment is a separate operational concern outside this PRD.                |
| NG-1006 | Publishing to npm, JSR, or any package registry. The Claude Code plugin marketplace is the only distribution channel.                       |
| NG-1007 | Billing integration with managed "Code Review" SaaS. MVP uses direct `claude-code-action` billing; managed SaaS is future work.             |
| NG-1008 | Windows runners. Target macOS and Ubuntu only.                                                                                              |
| NG-1009 | Replacing the daemon's observation loop. PRD-010's scheduled `observe.yml` is an optional alternative, not a replacement.                   |

---

## 4. User Stories

### Maintainer

| ID    | Story                                                                                                                      | Priority |
|-------|----------------------------------------------------------------------------------------------------------------------------|----------|
| US-01 | As a maintainer, I want every PR to pass TypeScript compile, lint, unit tests, and shellcheck so main stays green.         | P0       |
| US-02 | As a maintainer, I want required status checks that block merge until baseline CI, plugin validation, and document reviews pass. | P0       |
| US-03 | As a maintainer, I want security scanning on every PR that fails if high/critical findings appear.                          | P0       |
| US-04 | As a maintainer, I want assist eval regression tests that block releases when help/troubleshoot/config regresses.           | P0       |

### Contributor

| ID    | Story                                                                                                                      | Priority |
|-------|----------------------------------------------------------------------------------------------------------------------------|----------|
| US-05 | As a contributor, I want baseline CI feedback within 8 minutes so I can iterate quickly.                                   | P0       |
| US-06 | As a contributor, I want clear failure messages linking to logs so I know what to fix.                                     | P1       |
| US-07 | As a contributor, I want `@claude` assistance on PRs where I can ask about failures or request suggestions.                 | P1       |
| US-08 | As a contributor, I want document review automation so PRD/TDD changes get reviewed without me pinging someone manually.    | P1       |

### Release Manager

| ID    | Story                                                                                                                      | Priority |
|-------|----------------------------------------------------------------------------------------------------------------------------|----------|
| US-09 | As a release manager, I want automated changelog generation summarizing changes since the last tag.                        | P1       |
| US-10 | As a release manager, I want version validation that ensures `plugin.json` versions increment correctly.                    | P0       |
| US-11 | As a release manager, I want per-plugin zip artifacts attached to every release for easy distribution.                     | P1       |
| US-12 | As a release manager, I want all quality gates (tests, evals, security, reviews) enforced before any release is published.  | P0       |

### Security Reviewer

| ID    | Story                                                                                                                      | Priority |
|-------|----------------------------------------------------------------------------------------------------------------------------|----------|
| US-13 | As a security reviewer, I want every PR scanned for secrets and common vulnerability patterns before merge.                | P0       |
| US-14 | As a security reviewer, I want SARIF uploads to GitHub Advanced Security so findings appear in the repo security tab.       | P1       |
| US-15 | As a security reviewer, I want agent definition changes (PRD-003) reviewed for privilege escalation and tool access modifications. | P0       |

### Eval Author

| ID    | Story                                                                                                                      | Priority |
|-------|----------------------------------------------------------------------------------------------------------------------------|----------|
| US-16 | As an eval author, I want assist eval runs on every release candidate to catch regressions before they ship.               | P0       |
| US-17 | As an eval author, I want eval results published as workflow artifacts so I can review per-case scoring when tests fail.    | P1       |
| US-18 | As an eval author, I want baseline comparison that shows which specific cases regressed vs. the prior release.              | P1       |

---

## 5. Functional Requirements

### 5.1 Baseline CI Workflow (`.github/workflows/ci.yml`)

| ID     | Requirement                                                                                                                                                  | Priority |
|--------|--------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-1001 | SHALL trigger on `push` to `main`, `pull_request` (opened/synchronize). SHALL use `dorny/paths-filter@v3` to skip irrelevant jobs.                          | P0       |
| FR-1002 | SHALL use a matrix strategy: Node.js `[18, 20]` × runner `[ubuntu-latest, macos-latest]` for the TS jobs. Bash jobs run on `ubuntu-latest` only.           | P0       |
| FR-1003 | The `typecheck` job SHALL run `tsc --noEmit` in `plugins/autonomous-dev/`.                                                                                   | P0       |
| FR-1004 | The `lint` job SHALL run `eslint` on TypeScript sources and `prettier --check` on TS + JSON + YAML. (Eslint + prettier configs SHALL be added in Phase 1 rollout.) | P0       |
| FR-1005 | The `test` job SHALL run `jest --passWithNoTests` with coverage collection and upload `coverage/` as an artifact.                                            | P0       |
| FR-1006 | The `shell` job SHALL run `shellcheck` on `plugins/autonomous-dev/bin/*.sh` and `shfmt -d` on the same files.                                                 | P0       |
| FR-1007 | The `markdown` job SHALL run `markdownlint` on `plugins/*/docs/**/*.md` and `lychee --cache` for link checking.                                              | P1       |
| FR-1008 | The `plugin-validate` job SHALL run `claude plugin validate` on both `.claude-plugin/plugin.json` files. The Claude CLI SHALL be bootstrapped via `npm install -g @anthropic-ai/claude-code@latest` (pinned major via the `CLAUDE_CLI_VERSION` workflow env var, default `2.x`) at the start of the job; on install failure the job SHALL fall back to a JSON-schema validation step using a schema vendored at `.github/schemas/plugin.schema.json` (a Phase 1 deliverable — see §15). | P0       |
| FR-1009 | The `actionlint` job SHALL run `actionlint` on `.github/workflows/*.yml` to catch workflow YAML errors before they merge.                                   | P1       |
| FR-1010 | The workflow SHALL set `concurrency: group: ci-${{ github.ref }}, cancel-in-progress: true` so superseding pushes cancel stale runs.                        | P0       |
| FR-1011 | The workflow SHALL cache `~/.npm`, `node_modules`, and the `tsc --incremental` build info to keep p95 under 8 minutes (NFR-1001).                           | P1       |

### 5.2 Assist Eval Regression Workflow (`.github/workflows/assist-evals.yml`)

| ID     | Requirement                                                                                                                                                  | Priority |
|--------|--------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-2001 | SHALL trigger on (a) `push` of tags matching `v*`, (b) `pull_request` when files under `plugins/autonomous-dev-assist/` change (advisory mode), and (c) `workflow_dispatch`. | P0       |
| FR-2002 | SHALL execute `bash plugins/autonomous-dev-assist/evals/runner.sh all` with the assist plugin loaded against the current branch.                            | P0       |
| FR-2003 | SHALL enforce thresholds per PRD-008 §12.8: ≥80% overall, ≥60% per case, ≥80% per suite, max 20% case failure rate. Release mode SHALL fail the workflow on any breach; PR mode SHALL post a warning but not block merge. | P0       |
| FR-2004 | SHALL compare the current suite-level scores against the last tagged release's eval artifact. A regression >5pp in any suite SHALL fail the workflow in release mode per PRD-008 §12.8. | P0       |
| FR-2005 | SHALL upload `evals/results/eval-<timestamp>.json` as a workflow artifact named `eval-results-<git_sha>` with 90-day retention.                              | P1       |
| FR-2006 | SHALL enforce the PRD-009 §13.7 rule: all portal security cases (CSRF, XSS, path traversal, ReDoS) SHALL pass at 100% or the release is blocked unconditionally. | P0       |
| FR-2007 | SHALL require `ANTHROPIC_API_KEY` from repository secrets. The `test` environment SHALL supply `DISCORD_BOT_TOKEN`, `SLACK_BOT_TOKEN`, and similar as needed for channel-specific evals. | P0       |
| FR-2008 | SHALL have a 15-minute timeout to prevent runaway eval execution.                                                                                            | P0       |

### 5.3 Claude PR-Assistant Workflow (`.github/workflows/claude-assistant.yml`)

| ID     | Requirement                                                                                                                                                  | Priority |
|--------|--------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-3001 | SHALL trigger on `issue_comment.created` and `pull_request_review_comment.created` when the comment body contains `@claude`.                                 | P0       |
| FR-3002 | SHALL use `anthropics/claude-code-action@v1` pinned to the major version.                                                                                    | P0       |
| FR-3003 | SHALL pass `anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}` and omit `prompt:` so the action runs in interactive mode.                                  | P0       |
| FR-3004 | SHALL pass `claude_args: "--max-turns 10 --model claude-opus-4-7"` as a cost/latency cap.                                                                    | P0       |
| FR-3005 | SHALL set workflow permissions: `contents: write`, `pull-requests: write`, `issues: write`. No `id-token: write` unless an OIDC integration is added later.  | P0       |
| FR-3006 | SHALL set `concurrency: group: claude-${{ github.event.issue.number || github.event.pull_request.number }}, cancel-in-progress: true` to prevent dogpile. | P0       |
| FR-3007 | SHALL have `timeout-minutes: 10` per job to cap worst-case cost.                                                                                             | P0       |
| FR-3008 | SHALL gate invocation on commenter trust: `if: contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association)`. Drive-by fork commenters SHALL NOT trigger Claude runs. `pull_request_target` SHALL NOT be used; the `issue_comment` event already executes in the base repo context and exposes secrets — the author-association gate is the primary defense. | P0       |
| FR-3009 | SHALL log the triggering comment author and association to the workflow summary for audit. Drive-by invocation attempts SHALL be silently skipped (no reply) to avoid giving attackers signal about trust boundaries. | P1       |

### 5.4 Document Review Workflows

| ID     | Requirement                                                                                                                                                  | Priority |
|--------|--------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-4001 | SHALL create four workflows: `prd-review.yml`, `tdd-review.yml`, `plan-review.yml`, `spec-review.yml`.                                                       | P0       |
| FR-4002 | Each workflow SHALL trigger on `pull_request` with `paths: "plugins/*/docs/<type>/<TYPE>-*.md"` (e.g., `plugins/*/docs/prd/PRD-*.md`).                       | P0       |
| FR-4003 | Each workflow SHALL invoke `anthropics/claude-code-action@v1` with a `prompt:` that dispatches the corresponding reviewer agent from PRD-002. **The changed files SHALL be passed to the agent via `--attach <file-path>` (file attachment), NOT via string interpolation into the prompt.** This prevents prompt-injection attacks via file contents (a malicious PR adding an `AI_INSTRUCTIONS.md` file cannot override the reviewer's system prompt). | P0       |
| FR-4004 | Each review workflow SHALL post the verdict as a PR comment with one of `APPROVE`, `CONCERNS`, or `REQUEST_CHANGES`, followed by severity-tagged findings.    | P0       |
| FR-4005 | Each workflow SHALL set a required GitHub status check `docs/<type>-review` that fails if the verdict is `REQUEST_CHANGES` or contains any CRITICAL finding.  | P0       |
| FR-4006 | Each workflow SHALL have `timeout-minutes: 10`.                                                                                                              | P0       |
| FR-4007 | **Fork PR handling.** Review workflows use the `pull_request` trigger, which intentionally does NOT expose secrets to forked-PR contexts — so `ANTHROPIC_API_KEY` is unavailable on fork PRs. For fork PRs, the review check SHALL be recorded as `neutral` (not blocking merge) with a comment asking a maintainer to push the branch to the base repo for a full review. The required-check configuration SHALL accept `neutral` as passing for fork-PR contexts; same-repo PRs still require `success`. | P0       |
| FR-4008 | Review workflows SHALL NOT run on automated pushes from `claude[bot]`, `dependabot[bot]`, `renovate[bot]`, or any identity with `author_association: "NONE"` that is a known bot user, to prevent infinite loops and save cost. | P1       |

### 5.5 Agent Modification Review Workflow (`.github/workflows/agent-meta-review.yml`)

| ID     | Requirement                                                                                                                                                  | Priority |
|--------|--------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-5001 | SHALL trigger on `pull_request` with `paths: "plugins/*/agents/*.md"`.                                                                                       | P0       |
| FR-5002 | SHALL run a schema-validation step first: verify frontmatter includes `name`, `description`, `model`, `tools`; reject unknown fields; reject `tools` additions beyond the existing allowlist without a `rationale` comment in the PR. | P0       |
| FR-5003 | SHALL dispatch the `agent-meta-reviewer` agent (PRD-003 FR-32) via `anthropics/claude-code-action@v1` with the PR diff passed as a file attachment (see FR-4003 reasoning).                         | P0       |
| FR-5004 | SHALL set a required status check `agents/meta-review` that fails if the meta-reviewer flags any privilege-escalation or scope-creep finding.                | P0       |
| FR-5005 | SHALL post detailed findings as a PR comment including the specific security concerns and suggested mitigations.                                             | P0       |
| FR-5006 | SHALL permit override ONLY via the `agents:meta-override-approved` label, AND ONLY when applied by an org-admin (enforced via `gh api` permission check in the workflow; non-admin labels SHALL be rejected). The override SHALL require a mandatory comment from the applying admin containing the substring "Reason:" followed by ≥50 characters of justification. Both the admin identity and the justification text SHALL be appended to `audit.jsonl` and to the workflow summary. | P0       |

### 5.6 Security Review Workflow (`.github/workflows/security-review.yml`)

| ID     | Requirement                                                                                                                                                  | Priority |
|--------|--------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-6001 | SHALL trigger on `pull_request` (every PR, regardless of path).                                                                                              | P0       |
| FR-6002 | SHALL run `gitleaks/gitleaks-action@v2` with SARIF output.                                                                                                   | P0       |
| FR-6003 | SHALL run `anthropics/claude-code-security-review@v1` with `timeout-minutes: 20`, SARIF output.                                                              | P1       |
| FR-6004 | SHALL run `trufflehog/trufflehog-actions-scan@v3` on a weekly `schedule: cron "0 6 * * 1"` trigger for repository-wide secret verification.                | P1       |
| FR-6005 | SHALL fail the PR status check if any finding has severity ≥ HIGH per PRD-007 FR-14.                                                                         | P0       |
| FR-6006 | SHALL upload SARIF output via `github/codeql-action/upload-sarif@v3` for display in GitHub Advanced Security.                                                | P1       |
| FR-6007 | SHALL exclude `plugins/autonomous-dev/tests/fixtures/` and `**/__mocks__/**` from secret scanning to reduce false positives.                                  | P1       |
| FR-6008 | SHALL support an admin override via label `security:reviewed-and-accepted` with a mandatory comment explaining why a finding was accepted.                   | P1       |

### 5.7 Plugin Manifest Validation (folded into ci.yml)

| ID     | Requirement                                                                                                                                                  | Priority |
|--------|--------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-7001 | Plugin validation (FR-1008) SHALL additionally assert that on release PRs (branches beginning with `release/*` or tags), `plugin.json` `version` is greater than the last tagged release's version using semver comparison. | P0       |
| FR-7002 | SHALL fail if required fields are missing: `name`, `version`, `description`, `author`, `license`.                                                            | P0       |
| FR-7003 | SHALL verify that `plugins/autonomous-dev/.claude-plugin/plugin.json` and `plugins/autonomous-dev-assist/.claude-plugin/plugin.json` both validate.           | P0       |

### 5.8 Release Workflow (`.github/workflows/release.yml`)

| ID     | Requirement                                                                                                                                                  | Priority |
|--------|--------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-8001 | SHALL trigger on `push` of tags matching `^v[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.]+)?$` (strict semver). Tag names SHALL be validated server-side in the workflow's first step and non-matching tags SHALL fail fast before any subsequent step runs. | P0       |
| FR-8002 | SHALL call the reusable baseline CI workflow (`.github/workflows/ci.yml` via `workflow_call`) and require it to succeed before proceeding.                   | P0       |
| FR-8003 | SHALL run the assist-eval workflow in release mode and require all thresholds pass.                                                                          | P0       |
| FR-8004 | SHALL generate a changelog via `anthropics/claude-code-action@v1`. The prompt SHALL construct commit-range references via validated tag names only (per FR-8001's regex); tag names SHALL NOT be interpolated without validation. Commit messages and bodies SHALL be passed to the action via `--attach` (file attachment), NOT via string interpolation, to prevent prompt injection. Output format: Markdown grouped by features, fixes, docs, breaking. | P1       |
| FR-8005 | SHALL build a per-plugin distribution zip: one for `plugins/autonomous-dev/`, one for `plugins/autonomous-dev-assist/`. Exclude `node_modules/`, `tests/`, and `__mocks__/`. | P1       |
| FR-8006 | SHALL create a GitHub Release via `softprops/action-gh-release@v2` with the generated changelog as the release body, the two plugin zips as release assets. Each zip SHALL also be published with a `.sha256` checksum file for integrity verification. | P1       |
| FR-8007 | SHALL verify that tag version matches both `plugin.json` versions before creating the release; mismatch SHALL fail the workflow.                             | P0       |
| FR-8008 | SHALL append eval summary (overall %, per-suite %, security-suite %) and test summary (pass count, coverage) to the release body.                            | P2       |

### 5.9 Scheduled Observation Workflow (opt-in template, `.github/workflows/observe.yml.example`)

| ID     | Requirement                                                                                                                                                  | Priority |
|--------|--------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-9001 | SHALL be shipped as `observe.yml.example` (not `.yml`) so it is not active by default. Operators rename to `observe.yml` to enable.                          | P0       |
| FR-9002 | SHALL trigger on `schedule: cron "0 */4 * * *"` (every 4 hours) per PRD-005 default cadence, and on `workflow_dispatch` for manual runs.                    | P1       |
| FR-9003 | SHALL run `autonomous-dev observe --scope all --format json` (which PRD-008 CLI will provide).                                                               | P1       |
| FR-9004 | SHALL post the observation summary to an operator-configured webhook via repository secret `OBSERVE_WEBHOOK_URL`.                                            | P1       |
| FR-9005 | SHALL document clearly that this is an **alternative to** (not replacement of) the PRD-005 daemon-local cron; operators choose one or run both with dedup.    | P1       |
| FR-9006 | SHALL have `timeout-minutes: 15` and `concurrency: group: observe, cancel-in-progress: false` so scheduled runs queue rather than cancel each other.         | P1       |

### 5.10 Cost & Budget Gate (`.github/workflows/budget-gate.yml`)

| ID     | Requirement                                                                                                                                                  | Priority |
|--------|--------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-10001 | SHALL run as a required check on every `pull_request` that would trigger a Claude-powered workflow (agent meta-review, document reviews, security review, assistant). | P0       |
| FR-10002 | **Primary mechanism: local spend estimator.** Every Claude-powered workflow SHALL write a spend-estimate artifact (`.github/budget/spend-<run_id>.json`) on completion containing `{ run_id, workflow, timestamp, estimated_cost_usd, model, turns }`. The budget-gate SHALL aggregate artifacts from the current calendar month to compute month-to-date spend. Cost estimation uses the documented Claude pricing per-model with actual turn counts. **No Anthropic Usage API is assumed** (no stable public endpoint exists at this time; if one becomes available, it MAY be added as a validation cross-check but not as the primary mechanism). | P0       |
| FR-10003 | SHALL read repository secret `CLAUDE_MONTHLY_BUDGET_USD` (default: 500).                                                                                    | P0       |
| FR-10004 | **Tiered thresholds:** (a) at ≥80% spend the workflow SHALL post a warning comment but pass; (b) at ≥100% spend the workflow SHALL fail the check; (c) at ≥110% spend the workflow SHALL additionally emit a `critical` status message and require two-org-admin approval via the `cost:override-critical` label (any single admin's application is insufficient — the workflow SHALL verify two distinct admin identities have applied the label). | P0       |
| FR-10005 | SHALL support a `cost:override` label (org-admin only) for routine operational needs that allows the workflow to pass at the 100% threshold for a specific PR; the override SHALL be logged with admin identity and justification comment. This is distinct from the two-admin `cost:override-critical` label for the 110% threshold. | P1       |
| FR-10006 | SHALL reset its counter on month boundary (UTC). Per-workflow spend-estimate artifacts SHALL be retained for 90 days for aggregation and post-hoc audit.   | P1       |
| FR-10007 | SHALL emit an accurate estimation disclaimer: the spend estimator is based on recorded turn counts × list prices; actual Anthropic billing may differ by ~5–10%. Operators should set `CLAUDE_MONTHLY_BUDGET_USD` with appropriate headroom. | P2       |

---

## 6. Non-Functional Requirements

| ID      | Requirement                                                                                                                                                  | Priority |
|---------|--------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| NFR-1001 | Baseline CI (`ci.yml`) SHALL complete within 8 minutes at p95 to keep contributor feedback fast.                                                            | P0       |
| NFR-1002 | Assist eval workflow SHALL complete within 10 minutes at p95.                                                                                                | P1       |
| NFR-1003 | Claude PR assistance (`claude-assistant.yml`) SHALL produce a first response within 5 minutes at p95.                                                        | P1       |
| NFR-1004 | Security workflow SHALL complete within 15 minutes including SARIF upload.                                                                                   | P1       |
| NFR-1005 | Document review workflows SHALL complete within 10 minutes per type.                                                                                         | P1       |
| NFR-1006 | All workflows SHALL set `concurrency` to cancel superseding runs on the same ref.                                                                            | P0       |
| NFR-1007 | Cache hit rate (node_modules + tsc build info) SHALL exceed 60% on typical PR runs.                                                                          | P1       |
| NFR-1008 | Status check names SHALL be stable and operator-facing (e.g., `ci/typecheck`, `docs/prd-review`, `agents/meta-review`) so branch-protection rules don't break on rename. | P0       |
| NFR-1009 | No single workflow SHALL exceed $5 USD expected spend per invocation; enforced via `--max-turns` and `timeout-minutes`.                                      | P0       |
| NFR-1010 | Error messages in failed status checks SHALL include: what failed, why, and a pointer to the job log URL. All dynamic values that could contain secrets (tokens, bot IDs, webhook URLs) SHALL be masked via `::add-mask::` before appearing in any log, comment, or summary. | P1       |
| NFR-1011 | Operational metrics (§17) SHALL be measured over a rolling 30-day window for CI-wall-time / pass-rate / cache-hit-rate metrics, and per-release for eval-regression / security-findings-pre-merge metrics. Dashboards SHALL display both. | P1       |

---

## 7. Architecture

```
Pull Request Event
       │
       ▼
┌────────────────┐
│ paths-filter   │
└───┬────────────┘
    │ any code change
    ├────────────▶ ci.yml ──▶ [typecheck, lint, test, shell, markdown, plugin-validate, actionlint]
    │
    │ docs/prd/PRD-*.md       agent file change        any PR
    ├──▶ prd-review.yml       ├──▶ agent-meta-         ├──▶ security-review.yml
    ├──▶ tdd-review.yml       │    review.yml         │    ├──▶ gitleaks
    ├──▶ plan-review.yml      │                       │    ├──▶ claude-code-security-review
    └──▶ spec-review.yml      │                       │    └──▶ SARIF upload
                              │                       │
All Claude-powered    ───▶ budget-gate.yml (required check if any of the above fires)

@claude mention ──▶ claude-assistant.yml (interactive, no path filter)

Tag push (v*) ──▶ release.yml ──▶ [ci.yml, assist-evals.yml, changelog via claude-code-action,
                                    build zips, create GitHub Release]

Schedule (opt-in) ──▶ observe.yml.example (operator copies to observe.yml)
```

### Daemon vs. CI (honoring PRD-001 NG-5)

```
Development Repository                      Runtime Operation
┌─────────────────────┐                     ┌─────────────────────┐
│   GitHub Actions    │   artifacts/        │  Autonomous Daemon  │
│       (PRD-010)     │─────validate───────▶│      (PRD-001)      │
│                     │                     │                     │
│ Validates code,     │                     │ Executes pipeline   │
│ docs, security,     │                     │ phases on validated │
│ evals, releases     │                     │ artifacts.          │
└─────────────────────┘                     └─────────────────────┘
```

CI validates what goes *into* the autonomous pipeline. The autonomous pipeline executes the work. They are distinct control planes; PRD-010 does not replace PRD-001's supervisor loop.

---

## 8. Secrets & Permissions

### Secrets (all in repository secrets, scoped to appropriate environments)

| Secret Name                   | Environment      | Purpose                                                      |
|-------------------------------|------------------|--------------------------------------------------------------|
| `ANTHROPIC_API_KEY`           | `release`, `ci`  | Claude API for Actions (claude-code-action, security-review, changelog) |
| `DISCORD_BOT_TOKEN`           | `test`           | Assist eval Discord intake cases                              |
| `DISCORD_GUILD_ID`            | `test`           | Discord test guild                                            |
| `DISCORD_APPLICATION_ID`      | `test`           | Discord test app                                              |
| `SLACK_BOT_TOKEN`             | `test`           | Assist eval Slack intake cases                                |
| `SLACK_APP_TOKEN`             | `test`           | Socket-mode Slack tests                                       |
| `SLACK_SIGNING_SECRET`        | `test`           | Slack signature verification tests                            |
| `CLAUDE_MONTHLY_BUDGET_USD`   | `ci`             | Monthly budget cap (default: 500)                             |
| `OBSERVE_WEBHOOK_URL`         | `operator-fork`  | Operator-side webhook for opt-in observe.yml                  |

### Permissions (least-privilege per workflow)

| Workflow                 | contents | pull-requests | issues | security-events | id-token |
|--------------------------|----------|---------------|--------|-----------------|----------|
| `ci.yml`                 | read     | read          | —      | —               | —        |
| `assist-evals.yml`       | read     | —             | —      | —               | —        |
| `claude-assistant.yml`   | write    | write         | write  | —               | —        |
| `prd/tdd/plan/spec-review.yml` | read | write       | —      | —               | —        |
| `agent-meta-review.yml`  | read     | write         | —      | —               | —        |
| `security-review.yml`    | read     | write         | —      | write           | —        |
| `release.yml`            | write    | write         | —      | —               | —        |
| `budget-gate.yml`        | read     | write         | —      | —               | —        |
| `observe.yml.example`    | read     | —             | —      | —               | —        |

### Supply-chain hygiene

- All third-party Actions SHALL be pinned to a commit SHA (not a tag) in production workflows, except for first-party Anthropic and GitHub Actions which MAY be pinned to major versions during Phase 1 and moved to commit SHA by Phase 3.
- Dependabot SHALL be configured to open PRs for Actions updates weekly.
- `pull_request_target` is forbidden except in the claude-assistant workflow for `issue_comment` and `pull_request_review_comment` events. That exception is justified because those events run in the base repo's context, not the fork's.

---

## 9. Dependency Pins (canonical)

| Action                                            | Pin                    | Purpose                                  |
|---------------------------------------------------|------------------------|------------------------------------------|
| `actions/checkout@v4`                             | Major (or SHA by Ph3) | Repo checkout                             |
| `actions/setup-node@v4`                           | Major                 | Node.js toolchain                         |
| `actions/cache@v4`                                | Major                 | Dep + build caching                       |
| `dorny/paths-filter@v3`                           | Major                 | Path-based conditional jobs              |
| `gitleaks/gitleaks-action@v2`                     | Major                 | Secret scanning (CI)                      |
| `trufflehog/trufflehog-actions-scan@v3`           | Major                 | Secret scanning (weekly)                  |
| `github/codeql-action/upload-sarif@v3`            | Major                 | SARIF → GHAS                              |
| `anthropics/claude-code-action@v1`                | Major                 | Claude Actions                            |
| `anthropics/claude-code-security-review@v1`       | Major                 | Security review                           |
| `softprops/action-gh-release@v2`                  | Major                 | Release creation                          |
| `rhysd/actionlint@v1`                             | Major                 | Workflow lint                             |
| `DavidAnson/markdownlint-cli2-action@v18`         | Major                 | Markdown lint                             |
| `lycheeverse/lychee-action@v1`                    | Major                 | Link check                                |

---

## 10. Workflow Inventory

| Workflow File                            | Trigger                              | Duration | Required on `main`? | Phase |
|------------------------------------------|--------------------------------------|----------|---------------------|-------|
| `.github/workflows/ci.yml`               | PR, push main                        | ≤8 min   | Required            | 1     |
| `.github/workflows/assist-evals.yml`     | Tags (`v*`), eval PRs, dispatch      | ≤10 min  | Required on release, advisory on PR | 2     |
| `.github/workflows/security-review.yml`  | PR + weekly schedule                 | ≤15 min  | Required (high+ findings fail) | 2     |
| `.github/workflows/claude-assistant.yml` | `@claude` mention                    | ≤10 min  | Advisory            | 3     |
| `.github/workflows/prd-review.yml`       | PRs touching `docs/prd/PRD-*.md`     | ≤10 min  | Required            | 3     |
| `.github/workflows/tdd-review.yml`       | PRs touching `docs/tdd/TDD-*.md`     | ≤10 min  | Required            | 3     |
| `.github/workflows/plan-review.yml`      | PRs touching `docs/plans/*.md`       | ≤8 min   | Required            | 3     |
| `.github/workflows/spec-review.yml`      | PRs touching `docs/specs/*.md`       | ≤8 min   | Required            | 3     |
| `.github/workflows/agent-meta-review.yml`| PRs touching `**/agents/*.md`        | ≤8 min   | Required            | 3     |
| `.github/workflows/release.yml`          | Tags (`v*`)                          | ≤25 min  | Required on release | 4     |
| `.github/workflows/observe.yml.example`  | Schedule (opt-in)                    | ≤15 min  | N/A                 | 4     |
| `.github/workflows/budget-gate.yml`      | Callable from Claude-powered workflows | ≤1 min | Required (when any Claude workflow fires) | 4 |

---

## 11. Autonomous-Dev-Assist Updates

### New skills

| Skill Name               | Coverage                                                                                                     |
|--------------------------|--------------------------------------------------------------------------------------------------------------|
| `github-actions-setup`   | First-time install: copy workflows into a target repo, configure secrets, enable branch protection rules. Handles coexistence with existing `.github/workflows/` (detect → offer diff/skip/overwrite per file). Idempotent on re-run. Verifies required secrets via `gh secret list` before marking complete. |
| `ci-troubleshoot`        | Diagnose a failing workflow. At minimum 10 scenarios: `ci/typecheck` red, `ci/lint` red, `ci/test` red, `ci/shell` red, `ci/plugin-validate` red, eval regression gate failing, agent meta-review blocking a tools-field change, security-review flagging a test fixture, fork-PR required check stuck at `neutral`, Dependabot PR mystery failures. |
| `release-workflow-guide` | How to cut a release: prep PR, validate plugin.json versions, tag (including `rc-*` dry-run tags for release.yml validation), monitor release.yml, verify artifacts and checksums, announce. |
| `ci-budget-guide`        | Budget-gate operations: setting `CLAUDE_MONTHLY_BUDGET_USD`, interpreting 80/100/110% thresholds, using `cost:override` (single-admin) vs `cost:override-critical` (two-admin), reading the spend-estimate artifacts, reconciling estimated vs actual billing. |
| `ci-migration-guide`     | Adopting PRD-010 CI into a repo that already has some CI: which workflows coexist vs conflict, branch-protection merge strategy, partial adoption path (security-only, then evals, then Claude-powered). |

### Existing skill updates (concrete)

- `setup-wizard` — Phase 9 "CI setup" SHALL: (a) detect existing `.github/workflows/` and offer diff/skip/overwrite per file; (b) prompt for and set via `gh secret set` each required secret from §8; (c) configure branch protection on `main` to require the Phase-1 status checks; (d) write a completion marker at `.github/.wizard-ci-phase-done`; (e) re-runs SHALL be idempotent (no net change if marker exists, unless `--reconfigure` flag is used).
- `help` — add Q&A for: "What checks are required on `main`?", "What does `docs/prd-review` mean on my PR?", "How is `@claude` billed?", "What does `paths-filter` skip?", "How do I enable `observe.yml`?", "What's the difference between `cost:override` and `cost:override-critical`?", "My fork PR's review check shows `neutral` — why?"
- `troubleshoot` — add the 10 scenarios listed in `ci-troubleshoot` above, plus: expected test-fixture false positive in gitleaks, canary-PR Monday failure runbook, admin-override label audit queries.
- `config-guide` — document every new secret from §8 (nine secrets), the four admin-override labels (`agents:meta-override-approved`, `security:reviewed-and-accepted`, `cost:override`, `cost:override-critical`), and the CI-related userConfig keys (`CLAUDE_CLI_VERSION`, `CLAUDE_MONTHLY_BUDGET_USD`, `OBSERVE_WEBHOOK_URL`).

### New eval suite

| Suite Name  | Case Count | Focus                                                                                                            |
|-------------|------------|------------------------------------------------------------------------------------------------------------------|
| `ci-guide`  | 22 cases   | Workflow discovery (5), failure triage (6), security & meta-review triage (5), release process (3), budget & cost (3) |

### Assist eval regression gate

Per PRD-008 §12.8 and PRD-009 §13.7, the `ci-guide` suite SHALL be included in the `assist-evals.yml` run. The following case IDs (to be assigned in the suite) SHALL pass at 100% (security-required subset): any case testing (a) secret-scanning triage (gitleaks vs trufflehog vs claude-code-security-review), (b) agent privilege-escalation detection, (c) admin-override-label misuse detection (`cost:override` applied by non-admin, or to fork-PR contexts), (d) fork-PR secret isolation, (e) SARIF interpretation. Any regression in these cases blocks release unconditionally.

---

## 12. Testing Strategy

### Self-testing CI

- `actionlint` runs as a job in `ci.yml` on every PR — catches YAML/syntax errors in workflows before they merge.
- `act` or `nektos/act` can be used locally to dry-run workflows; documented in contributor guide.
- **Canary PR** every Monday (`schedule`-triggered) opens a trivial PR (touch a file) and verifies every required check fires and passes. Failure pages the maintainer.

### Workflow-level tests

- Unit tests for any scripts embedded in workflows (budget-gate arithmetic, eval baseline comparison) live in `plugins/autonomous-dev/tests/ci/`.
- Integration test: a fixture-based test that takes a known eval-results JSON, applies the regression rule, and asserts pass/fail is correct.

### Review-agent false-positive mitigation

- A tagged sample set of 20 historical PRs (10 clean, 10 with known issues) SHALL be run through every new document-review workflow before that workflow is promoted to required status. Precision ≥ 80% and recall ≥ 70% required for promotion.

### Release-workflow test

- Dry-run release on a non-`v*` tag (e.g., `rc-*`) that runs the full workflow but does not create a GitHub Release — used to validate changes to `release.yml` before cutting a real release.

---

## 13. Setup-Wizard Phase Coordination

Extending the table from PRD-008 §13.4 (which already coordinates PRD-008 + PRD-009) by inserting a new Phase 9:

| Phase | Topic                                    | Owning PRD |
|-------|------------------------------------------|-----------|
| 1     | Prerequisites                            | existing  |
| 2     | Plugin installation                      | existing  |
| 3     | Configuration                            | existing  |
| 4     | Trust level                              | existing  |
| 5     | Cost budget                              | existing  |
| 6     | Daemon install + start                   | existing  |
| 7     | Submit first request (CLI)               | PRD-008   |
| 8     | Enable chat channels (Discord/Slack)     | PRD-008   |
| **9** | **CI setup (copy workflows, set secrets, enable branch protection)** | **PRD-010** |
| 10    | Notifications                            | existing  |
| 11    | Production intelligence                  | existing  |
| 12    | Web portal install (optional)            | PRD-009   |
| 13    | Verification & summary                   | existing  |

PRD-008, PRD-009, and PRD-010 all reference this table as the canonical sequence.

---

## 14. Cost & Observability

### Budget targets

- Repository default: `CLAUDE_MONTHLY_BUDGET_USD=500` (tunable per repo).
- Per-PR expected spend:
  - Claude assistant invocation: $0.20–$1.50 per `@claude` reply (depends on turns + diff size)
  - Document review (one PRD/TDD): $0.50–$2.00
  - Security review: $0.30–$1.00
  - Agent meta-review: $0.20–$0.80
- Per-release expected spend: $5–$15 (full eval + changelog).

### Observability

- `ci.yml` maintains a status badge in README.md.
- Workflow duration dashboard: GitHub Actions insights, supplemented by workflow-artifact aggregation.
- Cost dashboard: a weekly job reads the budget-gate artifacts and posts a summary issue (or updates a pinned tracking issue) with per-workflow spend breakdown.
- Security findings surface in GHAS (GitHub Advanced Security) dashboard via SARIF upload.

---

## 15. Migration & Rollout

### Phase 1 — Baseline CI (Week 1)

**Deliverables**: `ci.yml` (all jobs), `eslint` + `prettier` config files in both plugins, `shellcheck` config, `markdownlint` config.

**Acceptance**: open a test PR that includes changes in each job's trigger area; all jobs run and pass.

### Phase 2 — Security + Evals (Week 2)

**Deliverables**: `security-review.yml`, `assist-evals.yml` (release-mode only initially; PR-advisory mode follows).

**Acceptance**: `gitleaks` catches a planted test secret and blocks the PR. Eval workflow runs on a dry-run tag and correctly computes thresholds.

### Phase 3 — Claude-powered review (Weeks 3–4)

**Pre-phase prerequisite (Phase 2.5, Week 2.5):** A labeled fixture set of 20 historical PRs (10 clean, 10 with known issues spanning PRD/TDD/Plan/Spec/agent changes) SHALL be assembled by the maintainer listed as **fixture-set owner**. Each fixture includes the PR diff, the changed files, and a human-authored verdict (APPROVE/CONCERNS/REQUEST_CHANGES) with supporting findings. The fixture set lives at `.github/fixtures/review-corpus/` and is versioned. Without this fixture set, Phase 3 does not begin. Owner SHALL be named in the project board; default: the maintainer who owns the `docs/` subtree.

**Deliverables**: `claude-assistant.yml`, `prd-review.yml`, `tdd-review.yml`, `plan-review.yml`, `spec-review.yml`, `agent-meta-review.yml`, and the fixture set at `.github/fixtures/review-corpus/`.

**Acceptance**: Each workflow is validated against the 20-PR fixture set (precision ≥ 80%, recall ≥ 70%) before promotion to required status. Workflows with weaker precision/recall SHALL ship as advisory checks (non-blocking) until the gate is met.

### Phase 4 — Release + Observe + Budget (Weeks 5–6)

**Deliverables**: `release.yml`, `observe.yml.example`, `budget-gate.yml`, Dependabot config, branch-protection rules.

**Acceptance**: A `v0.2.0` rc tag cuts successfully, produces both plugin zips, appends eval summary, publishes changelog. Budget-gate is invoked by at least one Claude-powered workflow and passes.

### Phase 5 — Post-launch options

**Deliverables**: Optional adoption of managed Code Review SaaS (if an operator moves to Team/Enterprise), Dependabot upgrades to commit-SHA pins, self-hosted runner support (if a deployment needs sensitive env isolation).

---

## 16. Risks & Mitigations

| ID    | Risk                                                                                                | Likelihood | Impact | Mitigation                                                                                  |
|-------|-----------------------------------------------------------------------------------------------------|------------|--------|---------------------------------------------------------------------------------------------|
| R-01  | Runaway Claude costs on a large diff (e.g., generated code floods the context)                       | Medium     | High   | `--max-turns`, `timeout-minutes`, `concurrency`, budget-gate workflow                       |
| R-02  | `ANTHROPIC_API_KEY` leaked via workflow log or error message                                          | Low        | High   | Never `echo` secrets, use `::add-mask::` for any dynamic values, rotate quarterly           |
| R-03  | Fork PR executes untrusted code with secret access                                                    | Medium     | High   | `pull_request` trigger (no secrets) except explicit allowlist of trusted-context workflows |
| R-04  | GitHub Actions outage blocks all merges                                                               | Low        | Medium | Document manual release process; release.yml tested against `rc-*` tags quarterly          |
| R-05  | Flaky tests block legitimate merges                                                                   | High       | Medium | Test-quarantine label, retry step with capped retries, clear attribution in failure messages |
| R-06  | `claude plugin validate` unavailable on the runner                                                    | Medium     | Medium | Bootstrap step installs Claude CLI; fallback to JSON-schema validation                     |
| R-07  | Bun not installable on macOS runner (observed under Rosetta)                                          | Low        | Low    | Use Node.js for CI; Bun is portal runtime only (PRD-009)                                   |
| R-08  | Test-environment Discord/Slack credentials leaked                                                     | Medium     | High   | Dedicated test guild/workspace with minimal scopes; rotate on any repo security event     |
| R-09  | Review-agent false positives block legitimate PRs                                                     | Medium     | Medium | 20-PR precision/recall gate before promotion; admin override label documented             |
| R-10  | Managed Code Review's always-neutral status confuses reviewers                                        | Low        | Low    | Deferred to Phase 5; not adopted until policy documented                                    |
| R-11  | `paths-filter` misses a path pattern and important changes skip CI                                    | Medium     | High   | Filter patterns reviewed at every PRD landing; test PR per quarter exercises all branches  |
| R-12  | PRD-002 reviewer agents invoked from CI produce different verdicts than human review in the pipeline  | Low        | Medium | Both use the same agent definition and rubric; human is final authority at merge           |

---

## 17. Success Metrics

| Metric                                                       | Target                | Measurement                                                        |
|--------------------------------------------------------------|-----------------------|--------------------------------------------------------------------|
| p95 baseline CI wall time                                    | < 8 minutes           | GitHub Actions insights, rolling 30-day                            |
| Required-check pass rate on merges to `main`                 | > 98%                 | `(green merges) / (total merges)` over 30-day window               |
| Eval-regression escape rate                                  | < 2%                  | Post-release bugs attributable to eval gap / total releases        |
| Security findings caught pre-merge                           | > 95%                 | Pre-merge SARIF findings / (pre + post-merge)                      |
| Claude review verdict accepted as-is                         | > 70%                 | PRs where the reviewer's auto-verdict matches final human decision |
| Monthly spend within budget                                  | 100% of months        | Budget-gate artifact vs. `CLAUDE_MONTHLY_BUDGET_USD`                |
| Time-to-green after a workflow file edit                     | ≤ 2 iterations        | Median PR-to-green count for PRs modifying `.github/workflows/`    |
| Workflow cache hit rate                                      | > 60%                 | Cache telemetry from `actions/cache`                                |
| False-positive rate on document-review status checks         | < 15%                 | Override-label usage / total document-review runs                   |

---

## 18. Open Questions

| ID    | Question                                                                                                                              | Owner       | Priority |
|-------|---------------------------------------------------------------------------------------------------------------------------------------|-------------|----------|
| OQ-1  | Do we auto-approve PRs authored by @claude-bot, or always require a human review even for AI-authored changes?                         | Product     | High     |
| OQ-2  | Should document-review workflows run on every PR touching docs, or only on status transitions (e.g., `status: Draft` → `status: Review`)? | Engineering | Medium   |
| OQ-3  | Budget-gate: hard-fail vs warn-only? Leaning hard-fail but with a documented override label for operational emergencies.              | Operations  | High     |
| OQ-4  | When is adoption of managed Code Review SaaS justified? Define the trigger (PR volume, team size, Enterprise-plan status).             | Product     | Low      |
| OQ-5  | Should agent-meta-review run on all `agents/*.md` changes, or only when tools/model fields change? Current design: all changes.        | Security    | Medium   |
| OQ-6  | How do we establish eval baselines for the first release where no prior tag exists?                                                   | Engineering | Medium   |

---

## 19. References

- [PRD-001: System Core & Daemon Engine](./PRD-001-system-core.md) — NG-5 defines the invocation contract PRD-010 implements.
- [PRD-002: Document Pipeline & Review Gates](./PRD-002-document-pipeline.md) — reviewer agents invoked by §5.4 document-review workflows.
- [PRD-003: Agent Factory & Self-Improvement](./PRD-003-agent-factory.md) — FR-32 `agent-meta-reviewer` invoked by §5.5.
- [PRD-005: Production Intelligence Loop](./PRD-005-production-intelligence.md) — observe loop whose cadence §5.9 replicates via `schedule`.
- [PRD-007: Escalation & Trust Framework](./PRD-007-escalation-trust.md) — FR-14 security pause rule enforced by §5.6.
- [PRD-008: Unified Request Submission Packaging](./PRD-008-unified-request-submission.md) — §12.8 assist eval regression gate enforced by §5.2; `observe --scope all` CLI provided by PRD-008 used in §5.9.
- [PRD-009: Web Control Plane](./PRD-009-web-control-plane.md) — §13.7 portal security cases must pass at 100%, enforced by §5.2 FR-2006.
- Claude Code GitHub Actions documentation: https://code.claude.com/docs/en/github-actions
- `anthropics/claude-code-action` repo: https://github.com/anthropics/claude-code-action
- `anthropics/claude-code-security-review` repo: https://github.com/anthropics/claude-code-security-review

---

**END PRD-010**
