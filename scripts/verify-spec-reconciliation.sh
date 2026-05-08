#!/usr/bin/env bash
# scripts/verify-spec-reconciliation.sh
#
# TDD-031 (PRD-016 G-08, FR-1654) verification gate. Re-runs the three
# drift audits (path, vitest, bats) plus a path-existence check across
# every SPEC under plugins/autonomous-dev/docs/specs/. Exits 0 with a
# final "PASS" line on a clean tree; exits non-zero with one or more
# FAIL: lines naming the offending SPECs and tokens otherwise.
#
# Implements TDD-031 §5.4 checks:
#   (1) path drift     — `src/portal/` references must be replaced with
#                        `plugins/autonomous-dev-portal/server/`
#   (2) vitest         — case-insensitive word-bounded `\bvitest\b` must
#                        be replaced with the Jest equivalents per
#                        SPEC-031-2-02 (with OQ-31-05 whitelist applied
#                        prior to running this gate)
#   (3) bats           — no `.bats` extension or `tests/unit/test_*.sh`
#                        Bash-test references in SPECs
#   (4) path existence — every cited
#                        `plugins/autonomous-dev[^[:space:]\`]+\.(ts|js|md|json|yml|yaml)`
#                        path must resolve on disk
#
# All four checks run unconditionally; failures accumulate. The script
# exits 0 only if every check passes.
#
# Portability: POSIX-portable grep flags only (-E, -l, -n, -r, -i, -o, -h).
# Avoids -P (Perl regex), --include, --exclude long flags. Verified on
# macOS BSD grep and Linux GNU grep.
#
# Local invocation: bash scripts/verify-spec-reconciliation.sh
# Help banner:      bash scripts/verify-spec-reconciliation.sh --help
#
# CI integration: invoked unconditionally by the `spec-reconciliation`
# step in .github/workflows/ci.yml (no paths filter; ~500 ms cost is
# negligible).

set -euo pipefail

SPECS_DIR="plugins/autonomous-dev/docs/specs"

print_help() {
  cat <<'HELP'
verify-spec-reconciliation.sh — TDD-031 SPEC drift + path-existence gate

Usage:
  bash scripts/verify-spec-reconciliation.sh        Run the four checks
  bash scripts/verify-spec-reconciliation.sh -h     Print this banner
  bash scripts/verify-spec-reconciliation.sh --help Print this banner

Checks (all run; failures accumulate):
  (1) Path drift     — no `src/portal/` references in SPECs
  (2) Vitest         — no `\bvitest\b` (case-insensitive) tokens in SPECs
  (3) Bats           — no `.bats` or `tests/unit/test_*.sh` references
  (4) Path existence — every cited plugins/autonomous-dev/*.{ts,js,md,
                       json,yml,yaml} path resolves on disk

Exit codes:
  0   All four checks passed; final stdout line is "PASS"
  1+  One or more checks failed; FAIL: lines emitted to stderr
HELP
}

# Argument handling — only --help / -h is supported.
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  print_help
  exit 0
fi

# Confirm we are run from the repo root (SPECS_DIR must be reachable).
if [[ ! -d "$SPECS_DIR" ]]; then
  echo "FAIL: $SPECS_DIR not found; run from repo root" >&2
  exit 2
fi

status_path=0
status_vitest=0
status_bats=0
status_paths=0

# ---------------------------------------------------------------------------
# Check (1): path drift — `src/portal/` references must be reconciled.
# ---------------------------------------------------------------------------
path_hits="$(grep -rln "src/portal/" "$SPECS_DIR" || true)"
if [[ -n "$path_hits" ]]; then
  status_path=1
  {
    echo "FAIL: src/portal/ references remain in:"
    while IFS= read -r f; do
      [[ -n "$f" ]] && echo "  $f"
    done <<< "$path_hits"
  } >&2
fi

# ---------------------------------------------------------------------------
# Check (2): vitest — case-insensitive word-bounded `\bvitest\b`.
# ---------------------------------------------------------------------------
vitest_hits="$(grep -rliE "\bvitest\b" "$SPECS_DIR" || true)"
if [[ -n "$vitest_hits" ]]; then
  status_vitest=1
  {
    echo "FAIL: vitest references remain in:"
    while IFS= read -r f; do
      [[ -n "$f" ]] && echo "  $f"
    done <<< "$vitest_hits"
  } >&2
fi

# ---------------------------------------------------------------------------
# Check (3): bats — `.bats` extension or `tests/unit/test_*.sh` patterns.
# ---------------------------------------------------------------------------
bats_hits="$(grep -rlE "\.bats|tests/unit/test_.*\.sh" "$SPECS_DIR" || true)"
if [[ -n "$bats_hits" ]]; then
  status_bats=1
  {
    echo "FAIL: bats references remain in:"
    while IFS= read -r f; do
      [[ -n "$f" ]] && echo "  $f"
    done <<< "$bats_hits"
  } >&2
fi

# ---------------------------------------------------------------------------
# Check (4): path existence — every cited `plugins/autonomous-dev/...`
# file path with one of the recognized suffixes must exist on disk.
# ---------------------------------------------------------------------------
missing_count=0
missing_tmp="$(mktemp)"
trap 'rm -f "$missing_tmp"' EXIT

# Extract unique cited paths. -o emits only the match; -h suppresses
# filename prefix; -E enables ERE; -r recurses. All POSIX-portable.
cited_paths="$(
  grep -rohE "plugins/autonomous-dev[^[:space:]\`]+\.(ts|js|md|json|yml|yaml)" \
    "$SPECS_DIR" 2>/dev/null | sort -u || true
)"

if [[ -n "$cited_paths" ]]; then
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    # Skip glob/placeholder patterns; they cannot be tested with `test -e`.
    case "$p" in
      *'*'*|*'<'*|*'{'*|*'}'*) continue ;;
      *) ;;
    esac
    if [[ ! -e "$p" ]]; then
      echo "MISSING: $p" >> "$missing_tmp"
      missing_count=$((missing_count + 1))
    fi
  done <<< "$cited_paths"
fi

if [[ "$missing_count" -gt 0 ]]; then
  status_paths=1
  cat "$missing_tmp" >&2
  echo "FAIL: $missing_count cited paths do not exist" >&2
fi

# ---------------------------------------------------------------------------
# Aggregate exit code. No short-circuit: every check above ran.
# ---------------------------------------------------------------------------
if [[ $status_path -ne 0 || $status_vitest -ne 0 || $status_bats -ne 0 || $status_paths -ne 0 ]]; then
  exit 1
fi

echo "PASS"
exit 0
