# SPEC-039-4-01: Smoke end-to-end test

## Metadata
- **Parent Plan**: PLAN-039
- **Parent TDD**: TDD-038
- **Parent PRD**: PRD-019
- **Tasks Covered**: PLAN-039 TASK-020
- **Dependencies**: SPEC-039-2-06, SPEC-039-2-09, SPEC-039-3-01
- **Estimated effort**: 4 hours
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-11

## Objective

Implement `test/e2e/smoke-e2e.sh` — an end-to-end smoke test (FR-019-19) that creates a fresh `TMP_REPO`, submits a request via the CLI, runs the daemon `--once` (or a small number of iterations), and **hard-fails** if a PRD artifact (`<TMP_REPO>/docs/prd/*.md`) is not produced. Supports `CAPTURE_SPAWN_TO=<dir>` mock mode (OQ-039-6 resolution) so CI runs without real Anthropic API spend; real-API runs gated to a nightly job.

## Acceptance Criteria

1. (AC-038-19) Smoke test completes in < 10 minutes wall-clock.
2. Hard-fails (exit 1) if no `<TMP_REPO>/docs/prd/*.md` artifact is created after the daemon iteration window.
3. `CAPTURE_SPAWN_TO=<dir>` env var: when set, `spawn_session_typed` writes the would-be `claude` argv to that dir instead of invoking — enables CI to assert dispatch happened without spending API credits.
4. Cleans up `TMP_REPO` and any temp daemon state on exit (trap EXIT).
5. Smoke test sets up a minimal allowlisted repo so the daemon picks it up.
6. Exit codes: 0 success, 1 missing artifact, 2 daemon crash, 3 setup failure, 4 timeout.

## Implementation

**Files created**
- `plugins/autonomous-dev/test/e2e/smoke-e2e.sh`
- `plugins/autonomous-dev/test/e2e/fixtures/mock-claude.sh` — stub binary that writes a minimal `docs/prd/<slug>.md` and `phase-result-<phase>.json`, used when `CAPTURE_SPAWN_TO` is set.

**Script structure**
```bash
#!/usr/bin/env bash
set -euo pipefail

TMP_REPO=$(mktemp -d)
trap 'rm -rf "$TMP_REPO"' EXIT

# Setup: git init, add to allowlist, init intake DB
git -C "$TMP_REPO" init -q
echo "${TMP_REPO}" >> ~/.autonomous-dev/allowlist

# Optional mock mode
if [[ -n "${CAPTURE_SPAWN_TO:-}" ]]; then
  export CLAUDE_BIN="$(dirname "$0")/fixtures/mock-claude.sh"
fi

# Submit
autonomous-dev request submit "Add a hello-world README section" \
  --repo "$TMP_REPO" --type feature

# Drive daemon
timeout 600 autonomous-dev daemon --once-N 3

# Assert
shopt -s nullglob
prds=( "$TMP_REPO"/docs/prd/*.md )
if (( ${#prds[@]} == 0 )); then
  echo "FAIL: no PRD artifact produced under $TMP_REPO/docs/prd/" >&2
  exit 1
fi
echo "PASS: PRD artifact produced: ${prds[0]}"
exit 0
```

**Mock claude binary** — bash script that:
- Parses `--agent <name>` from argv.
- For agent `prd-author`: writes a stub `<TMP_REPO>/docs/prd/<slug>.md` + phase-result.json with `status=pass`.
- For other agents: writes a no-op phase-result.json `status=pass`.
- Writes its argv to `${CAPTURE_SPAWN_TO}/argv-<phase>.txt` for assertion in CI.

## Tests

The smoke test IS the test artifact. Self-validating.

Additional sanity tests:
- `plugins/autonomous-dev/test/e2e/smoke-e2e.smoke-mode.bats` — verifies the smoke harness itself: CAPTURE_SPAWN_TO writes argv files; mock-claude produces stub PRD.

## Verification

- `bash -n test/e2e/smoke-e2e.sh`
- `CAPTURE_SPAWN_TO=/tmp/spawn-capture bash test/e2e/smoke-e2e.sh` exits 0.
- Real-API: `unset CAPTURE_SPAWN_TO; ANTHROPIC_API_KEY=... bash test/e2e/smoke-e2e.sh` exits 0 (nightly gated job; not blocking PRs).

## Open Questions resolved

- OQ-039-6 — resolved by `CAPTURE_SPAWN_TO` mock-mode default in CI; real-API runs in nightly gated job.
