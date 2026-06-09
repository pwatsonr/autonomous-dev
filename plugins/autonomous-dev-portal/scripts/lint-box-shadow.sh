#!/usr/bin/env bash
# SPEC-034-2-03 — Lint Box-Shadow Tokenization (TDD-034 §5.5, R-15a).
#
# Enforces that every `box-shadow:` declaration in non-token portal CSS
# references a `var(--shadow-*)` token. The portal's elevation system
# (Level 0/1/2/Pop) is defined exclusively via shadow tokens; raw shadow
# values bypass the system and are rejected here at PR time.
#
# Scans:
#   - plugins/autonomous-dev-portal/server/static/*.css
#   - plugins/autonomous-dev-portal/src/styles/**/*.css
# Excludes:
#   - design-tokens.css (defines the shadow tokens themselves)
#
# Usage:
#   lint-box-shadow.sh                       # full repo scan
#   lint-box-shadow.sh --scan-file <path>    # scan a single file (test driver)
#
# Exit codes:
#   0 — no violations
#   1 — one or more raw `box-shadow:` declarations found

set -euo pipefail

SCAN_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --scan-file)
      SCAN_FILE="${2:-}"
      if [[ -z "${SCAN_FILE}" ]]; then
        echo "lint-box-shadow: --scan-file requires a path" >&2
        exit 1
      fi
      shift 2
      ;;
    -h|--help)
      sed -n '2,21p' "$0"
      exit 0
      ;;
    *)
      echo "lint-box-shadow: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# Resolve plugin root from script location so the script works regardless of cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORTAL_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Build the list of files to scan.
files=()
if [[ -n "${SCAN_FILE}" ]]; then
  if [[ ! -f "${SCAN_FILE}" ]]; then
    echo "lint-box-shadow: scan-file not found: ${SCAN_FILE}" >&2
    exit 1
  fi
  files=("${SCAN_FILE}")
else
  # static/*.css (top-level only, excluding design-tokens.css). PRD-025
  # FR-025-01: the portal stylesheets live in static/, not server/static/
  # (which never existed) — the old path made this gate a silent no-op.
  if [[ -d "${PORTAL_ROOT}/static" ]]; then
    while IFS= read -r -d '' f; do
      files+=("$f")
    done < <(find "${PORTAL_ROOT}/static" -maxdepth 1 -type f -name '*.css' \
              ! -name 'design-tokens.css' -print0)
  fi
  # src/styles/**/*.css (recursive, excluding design-tokens.css)
  if [[ -d "${PORTAL_ROOT}/src/styles" ]]; then
    while IFS= read -r -d '' f; do
      files+=("$f")
    done < <(find "${PORTAL_ROOT}/src/styles" -type f -name '*.css' \
              ! -name 'design-tokens.css' -print0)
  fi
  # Fail-closed against future path drift: a scan of 0 files reads as green
  # but guarantees nothing (PRD-025 FR-025-01).
  if [[ ${#files[@]} -eq 0 ]]; then
    echo "lint-box-shadow: scanned 0 CSS files — check scan paths (${PORTAL_ROOT}/static, ${PORTAL_ROOT}/src/styles)." >&2
    exit 2
  fi
fi

violations=0
for file in "${files[@]}"; do
  # Skip the token file even if passed explicitly via --scan-file: it is the
  # canonical home for raw shadow definitions.
  case "$(basename "${file}")" in
    design-tokens.css) continue ;;
    *) ;;
  esac

  # Match every `box-shadow` line, then drop:
  #   - lines that already reference a shadow token (var(--shadow-...))
  #   - block-comment-only lines (`/* ... */` openers and `* ...` continuations)
  hits="$(grep -n 'box-shadow' "${file}" \
            | grep -v 'var(--shadow-' \
            | grep -v '^[[:space:]]*[0-9]\+:[[:space:]]*/\*' \
            | grep -v '^[[:space:]]*[0-9]\+:[[:space:]]*\*' \
            || true)"

  if [[ -n "${hits}" ]]; then
    while IFS= read -r line; do
      # `line` is `<lineno>:<content>` from grep -n.
      lineno="${line%%:*}"
      content="${line#*:}"
      # Trim leading whitespace from content for a clean report.
      content="${content#"${content%%[![:space:]]*}"}"
      printf 'lint-box-shadow: %s:%s: raw box-shadow (must use var(--shadow-*))\n' \
        "${file}" "${lineno}" >&2
      printf '  %s\n' "${content}" >&2
      violations=$((violations + 1))
    done <<< "${hits}"
  fi
done

if [[ "${violations}" -gt 0 ]]; then
  echo "lint-box-shadow: FAILED — ${violations} raw box-shadow declaration(s) found" >&2
  exit 1
fi

echo "lint-box-shadow: OK — all box-shadow declarations use var(--shadow-*) tokens"
exit 0
