#!/usr/bin/env bash
# scripts/lint/no-tbd-shas.sh
#
# PRD-017 FR-1709 / SPEC-032-2-02 — regression guard against the
# `TBD-replace-with-pinned-SHA` literal re-entering the four
# cloud-deploy plugins or `.github/workflows/release.yml`.
#
# Path scope is intentionally narrow:
#   - plugins/autonomous-dev-deploy-aws/**
#   - plugins/autonomous-dev-deploy-gcp/**
#   - plugins/autonomous-dev-deploy-azure/**
#   - plugins/autonomous-dev-deploy-k8s/**
#   - .github/workflows/release.yml
# PRD/TDD docs that mention the literal as illustration do NOT trigger
# the guard. Path-broadening is the highest-risk regression mode; the
# closeout PR description and the runbook both reiterate this scope.
#
# Exit codes:
#   0 = clean (no literal in scope)
#   1 = literal found (build break)
#
# Cross-platform: POSIX-portable bash (macOS bash 3.2 + Ubuntu bash 5.x).
# Floating-tag re-introductions are NOT caught — humans catch them at
# PR review. See plugins/autonomous-dev/docs/runbooks/refresh-action-pins.md.
#
# Run from the repo root. Tarball installs (no git working tree) will
# fail with a confusing git error; this is acceptable.

set -euo pipefail

PATHS=(
  'plugins/autonomous-dev-deploy-aws'
  'plugins/autonomous-dev-deploy-gcp'
  'plugins/autonomous-dev-deploy-azure'
  'plugins/autonomous-dev-deploy-k8s'
  '.github/workflows/release.yml'
)

# `git grep -F` is literal-string match; exit 1 = no match (clean), 0 = match.
# Capture-on-match: the assignment succeeds either way; non-empty stdout
# (matches captured) means at least one offender.
matches=$(git grep -nF 'TBD-replace-with-pinned-SHA' -- "${PATHS[@]}" 2>/dev/null || true)

if [ -n "${matches}" ]; then
  echo "ERROR: TBD-replace-with-pinned-SHA reintroduced" >&2
  echo "${matches}" >&2
  exit 1
fi

exit 0
