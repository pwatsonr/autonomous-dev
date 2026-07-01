# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- **REQ-000056 / #620**: Self-healing pipeline — autonomous-dev now detects
  and auto-remediates nine in-run failure modes (F1–F9) without human
  intervention. Detections are always recorded; each mode maps to an automatic
  remediation policy or a safe-continue with a human as the final escalation.
  Key capabilities: review-gate loop breaking (F1), repeated reviewer timeout
  escalation and fallback (F2), phase-timeout budget extension when progress
  is detected (F3), reviewer error retry-then-exclude (F4), suspicious
  empty/fast result re-queuing with prompt hint (F5/F6), verification
  false-negative self-correction (F7), and novel/unknown failure diagnostic
  bundling with optional `gh issue create` (F9). Implementation adds four new
  bash library modules (`self-heal.sh`, `self-heal-state.sh`,
  `self-heal-events.sh`, `self-heal-telemetry.sh`), nine integration hooks
  (H1–H9) in `supervisor-loop.sh`, 15 JSON event schemas, TypeScript
  `runReviewers` API with `excludedReviewers` + `retryOnce` opts, and
  `--state-file` support in `review-gate-cli.ts`. Master kill switch:
  `AUTONOMOUS_DEV_SELF_HEAL=0` restores bit-for-bit legacy semantics.
  Covered by 14 bats tests (TC-001–TC-014) and 13 Jest tests (TC-040–TC-042).
  See `docs/operations/self-healing-pipeline.md` and
  `docs/architecture/adr-005-self-heal-dispatch.md`.

### Fixed

- **REQ-000054 / #629**: Unblock autonomous merge gate — add configurable
  `merge_gate_non_blocking_checks` allowlist and `merge_gate_skip_baseline_red`
  flag so PRs whose own real checks (typecheck/lint/test/shell) all pass can
  auto-merge even while permanently-red pre-existing CI gates (markdown/lychee,
  visual-regression #361, scope-enforcement/kind #575) remain failing. The
  synthetic-readiness path is disabled by default when the allowlist is empty
  and baseline-red opt-in is off, preserving the previous strict-CLEAN
  behaviour. Covered by T09–T25 in `trust_gated_merge.bats` and
  `merge_gate_order_aware.bats`.

- **REQ-000054 / #628**: Fix `pr_comment_reentry` over-count — `read_pr_comment_payload`
  now fetches PR-scoped inline comments (`/pulls/{pr}/comments`) instead of the
  repo-wide endpoint, and `pr_comment_new_ids` filters out comments from
  non-actionable authors (CI bots, the PR author themselves) before counting new
  comments. A configurable `pr_comment_non_actionable_authors` list (default:
  `[bot]`, github-actions, dependabot, renovate, codecov) controls the filter.
  User config overrides the default array entirely (replace, not union). Covered
  by T02–T08 in `pr_comment_loop.bats`.
