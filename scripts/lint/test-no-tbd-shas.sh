#!/usr/bin/env bash
# scripts/lint/test-no-tbd-shas.sh
#
# Round-trip integration test for scripts/lint/no-tbd-shas.sh.
# Synthesizes a literal in a deploy-plugin file, verifies the guard
# detects it, then cleans up and re-verifies clean exit.
#
# Per SPEC-032-2-02: this test is NOT wired into CI (it would
# self-trigger the guard during the synthesize phase). Run locally
# during implementation; capture output for the closeout PR description.
#
# Run from the repo root. Cleans up its synthesized file via trap.

set -euo pipefail

WORKDIR=plugins/autonomous-dev-deploy-aws
TESTFILE="${WORKDIR}/.lint-test.yml"
GUARD=scripts/lint/no-tbd-shas.sh
# `git grep` only sees tracked or staged files. Use `git add --intent-to-add`
# so the synthesized file enters the index without committing it; cleanup
# in the EXIT trap removes it from both the index and the working tree.
trap 'git rm -f --cached --quiet "${TESTFILE}" 2>/dev/null || true; rm -f "${TESTFILE}"' EXIT

if [ ! -d "${WORKDIR}" ]; then
  echo "FAIL: ${WORKDIR} not found; run from repo root" >&2
  exit 2
fi
if [ ! -x "${GUARD}" ] && [ ! -f "${GUARD}" ]; then
  echo "FAIL: ${GUARD} not present" >&2
  exit 2
fi

# Phase A: clean tree exits 0.
bash "${GUARD}"
echo "Phase A passed (clean tree → exit 0)"

# Phase B: synthesize literal → exit 1.
echo "uses: actions/checkout@TBD-replace-with-pinned-SHA" > "${TESTFILE}"
git add --intent-to-add "${TESTFILE}"
if bash "${GUARD}" 2>/dev/null; then
  echo "FAIL: guard did not detect synthesized literal" >&2
  exit 1
fi
echo "Phase B passed (literal → exit 1)"

# Phase C: cleanup → exit 0.
git rm -f --cached --quiet "${TESTFILE}"
rm "${TESTFILE}"
bash "${GUARD}"
echo "Phase C passed (cleanup → exit 0)"

echo "All round-trip phases passed."
