# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

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
