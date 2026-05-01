# Runbook: claude-assistant concurrency cancellation test

## Purpose

Verify that `claude-assistant.yml`'s per-issue/per-PR concurrency group
correctly cancels in-flight runs when a new `@claude` comment arrives.

## Prerequisites

- A trusted GitHub account (`OWNER`, `MEMBER`, or `COLLABORATOR`).
- A draft PR (or an open issue) in a repo where `claude-assistant.yml`
  is installed.
- Repository secret `ANTHROPIC_API_KEY` configured.
- Repository secret `BUDGET_HMAC_KEY` configured (consumed by the spend
  artifact step from SPEC-017-1-04).

## Procedure

1. Open or use an existing draft PR / issue.
2. From the trusted account, post **comment 1**:
   `@claude please count to 100 slowly.`
3. Within 10 seconds, post **comment 2**:
   `@claude what's 2+2?`
4. Open the **Actions** tab and locate the two `claude-assistant`
   runs that were initiated.
5. Inspect both runs.

## Expected outcome

- Two `claude-assistant` runs are initiated (one per comment).
- The first run shows status `cancelled` (not `failed`, not `success`).
- The second run shows status `success`.
- Exactly one Claude reply is posted on the PR/issue (the answer to
  comment 2).
- Both runs' `respond` jobs have an audit log entry on the workflow
  summary, because `if: always()` keeps the audit step running even on
  cancellation.
- The concurrency key is `claude-assistant-${{ github.event.issue.number }}`
  and is per-PR/per-issue. Two trusted users commenting on different
  PRs at the same time do **not** cancel each other.

## Troubleshooting

- **No runs initiated.** Verify the comment contains the literal
  substring `@claude` (zero-width characters break the match) and that
  the commenter's `author_association` is one of OWNER/MEMBER/COLLABORATOR.
- **Both runs succeeded (no cancellation).** Open `claude-assistant.yml`
  and confirm `concurrency.cancel-in-progress: true` is set under the
  top-level `concurrency:` block.
- **Audit log missing on the cancelled run.** Cancellation is
  cooperative per step. If GitHub cancels the job before the audit
  step starts (extremely fast cancellation), the summary will be
  empty. This is rare and acceptable; the second run's audit log still
  records the actor.
