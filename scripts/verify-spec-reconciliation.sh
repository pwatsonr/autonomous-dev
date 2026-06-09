#!/usr/bin/env bash
# scripts/verify-spec-reconciliation.sh
#
# TDD-031 (PRD-016 G-08, FR-1654) verification gate. Runs three drift
# audits (path, vitest, bats) plus a path-existence check over SPEC files
# under plugins/autonomous-dev/docs/specs/.
#
# SCOPING (PRD-016 follow-up): by default the gate only inspects SPEC files
# that a change actually touches (diff vs the merge base), so a PR is
# accountable for the specs it edits — not the entire historical corpus.
# This keeps new drift out while the pre-existing TDD-031 backlog (stale
# vitest/bats refs and placeholder path citations in already-shipped specs)
# is paid down separately. Set SPEC_RECON_SCOPE=full to scan every SPEC
# (legacy behavior); the gate auto-falls back to a full scan when no git
# base is resolvable (e.g. a detached local checkout).
#
# Checks (TDD-031 §5.4):
#   (1) path drift     — `src/portal/` -> `plugins/autonomous-dev-portal/server/`
#   (2) vitest         — no case-insensitive `\bvitest\b`
#   (3) bats           — no `.bats` / `tests/unit/test_*.sh` references
#   (4) path existence — every cited plugins/autonomous-dev/*.{ts,js,md,json,
#                        yml,yaml} path resolves on disk
#
# Portability: POSIX-portable grep flags only (-E,-l,-n,-r,-i,-o,-h).
#
# Local invocation: bash scripts/verify-spec-reconciliation.sh
# Help banner:      bash scripts/verify-spec-reconciliation.sh --help

set -euo pipefail

SPECS_DIR="plugins/autonomous-dev/docs/specs"
BASE_REF="${SPEC_RECON_BASE:-origin/main}"
SCOPE_MODE="${SPEC_RECON_SCOPE:-auto}"   # auto | changed | full

print_help() {
  cat <<'HELP'
verify-spec-reconciliation.sh — TDD-031 SPEC drift + path-existence gate

Usage:
  bash scripts/verify-spec-reconciliation.sh        Run the four checks
  bash scripts/verify-spec-reconciliation.sh -h     Print this banner

Scope (env):
  SPEC_RECON_SCOPE=auto    (default) diff vs base when resolvable, else full
  SPEC_RECON_SCOPE=changed only SPECs changed vs base (fails if no base)
  SPEC_RECON_SCOPE=full    every SPEC under the specs dir (legacy)
  SPEC_RECON_BASE=<ref>    base ref for diff scope (default: origin/main)

Checks (all run; failures accumulate):
  (1) Path drift     — no `src/portal/` references
  (2) Vitest         — no `\bvitest\b` (case-insensitive)
  (3) Bats           — no `.bats` or `tests/unit/test_*.sh` references
  (4) Path existence — every cited plugins/autonomous-dev/*.{ts,js,md,json,
                       yml,yaml} path resolves on disk

Exit codes:
  0   All checks passed (final stdout line is "PASS")
  1+  One or more checks failed; FAIL: lines emitted to stderr
HELP
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  print_help
  exit 0
fi

if [[ ! -d "$SPECS_DIR" ]]; then
  echo "FAIL: $SPECS_DIR not found; run from repo root" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Build the list of SPEC files to inspect, honoring the scope mode.
# ---------------------------------------------------------------------------
resolve_base() {
  # Echo a usable base SHA/ref or nothing. Tries the configured ref, then a
  # shallow fetch, then the local main.
  if git rev-parse --verify --quiet "$BASE_REF" >/dev/null 2>&1; then
    git merge-base "$BASE_REF" HEAD 2>/dev/null || echo "$BASE_REF"
    return 0
  fi
  if git fetch --quiet --depth=1 origin main >/dev/null 2>&1 \
     && git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
    git merge-base origin/main HEAD 2>/dev/null || echo "origin/main"
    return 0
  fi
  return 1
}

FILES=()
scope_used="full"
if [[ "$SCOPE_MODE" != "full" ]] && git rev-parse --git-dir >/dev/null 2>&1; then
  if base="$(resolve_base)" && [[ -n "$base" ]]; then
    scope_used="changed"
    # Committed diff vs base + working-tree (unstaged/staged) + untracked,
    # restricted to the specs dir and to files that still exist.
    while IFS= read -r f; do
      [[ -n "$f" && -f "$f" ]] && FILES+=("$f")
    done < <(
      {
        git diff --name-only "$base" HEAD -- "$SPECS_DIR" 2>/dev/null || true
        git diff --name-only -- "$SPECS_DIR" 2>/dev/null || true
        git ls-files --others --exclude-standard -- "$SPECS_DIR" 2>/dev/null || true
      } | sort -u
    )
  elif [[ "$SCOPE_MODE" == "changed" ]]; then
    echo "FAIL: SPEC_RECON_SCOPE=changed but no git base (${BASE_REF}) resolvable" >&2
    exit 2
  fi
fi

if [[ "$scope_used" == "full" ]]; then
  while IFS= read -r f; do
    [[ -n "$f" ]] && FILES+=("$f")
  done < <(find "$SPECS_DIR" -type f -name '*.md' | sort)
fi

if [[ "${#FILES[@]}" -eq 0 ]]; then
  echo "PASS (scope=${scope_used}: no SPEC files to check)"
  exit 0
fi

status_path=0
status_vitest=0
status_bats=0
status_paths=0

# Check (1): path drift.
path_hits="$(grep -lE "src/portal/" "${FILES[@]}" 2>/dev/null || true)"
if [[ -n "$path_hits" ]]; then
  status_path=1
  { echo "FAIL: src/portal/ references remain in:"; sed 's/^/  /' <<< "$path_hits"; } >&2
fi

# Check (2): vitest.
vitest_hits="$(grep -liE "\bvitest\b" "${FILES[@]}" 2>/dev/null || true)"
if [[ -n "$vitest_hits" ]]; then
  status_vitest=1
  { echo "FAIL: vitest references remain in:"; sed 's/^/  /' <<< "$vitest_hits"; } >&2
fi

# Check (3): bats.
bats_hits="$(grep -lE "\.bats|tests/unit/test_.*\.sh" "${FILES[@]}" 2>/dev/null || true)"
if [[ -n "$bats_hits" ]]; then
  status_bats=1
  { echo "FAIL: bats references remain in:"; sed 's/^/  /' <<< "$bats_hits"; } >&2
fi

# Check (4): path existence (paths cited in the in-scope SPECs).
missing_count=0
missing_tmp="$(mktemp)"
trap 'rm -f "$missing_tmp"' EXIT
cited_paths="$(
  grep -ohE "plugins/autonomous-dev[^[:space:]\`]+\.(ts|js|md|json|yml|yaml)" \
    "${FILES[@]}" 2>/dev/null | sort -u || true
)"
if [[ -n "$cited_paths" ]]; then
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
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

if [[ $status_path -ne 0 || $status_vitest -ne 0 || $status_bats -ne 0 || $status_paths -ne 0 ]]; then
  exit 1
fi

echo "PASS (scope=${scope_used}, files=${#FILES[@]})"
exit 0
