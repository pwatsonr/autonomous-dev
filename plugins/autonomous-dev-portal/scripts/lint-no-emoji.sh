#!/usr/bin/env bash
# SPEC-034-2-02 §M-05 — Reject Unicode emoji in portal templates.
#
# Scans server/templates/**/*.tsx for Unicode emoji codepoints and exits
# non-zero with a `path:line:match` diagnostic on any hit. The portal's
# voice is deliberately text-only; once SPEC-034-2-04 wires this script
# into CI as merge-blocking, no PR can re-introduce emoji.
#
# Codepoint ranges (per TDD-034 §5.6 rule 2):
#   \x{1F300}-\x{1F9FF}  Misc Symbols & Pictographs / Emoticons /
#                       Transport & Map / Supplemental
#   \x{2600}-\x{26FF}    Miscellaneous Symbols
#   \x{2700}-\x{27BF}    Dingbats
#   \x{FE00}-\x{FE0F}    Variation Selectors (emoji presentation)
#   \x{1F1E0}-\x{1F1FF}  Regional Indicator Symbols (flags)
#   \x{200D}             Zero-Width Joiner (emoji ZWJ sequences)
#   \x{20E3}             Combining Enclosing Keycap
#   \x{E0020}-\x{E007F}  Tag characters (subdivision flags)
#
# Comment-line skip: lines beginning with `//` or `*` (after optional
# leading whitespace) are exempt so commentary about emoji policy does
# not self-trigger.
#
# Usage:
#   bash lint-no-emoji.sh                       # scan default tree
#   bash lint-no-emoji.sh --scan-file <path>    # scan a single file
#                                                 (test-driver hook)
#
# Exit codes:
#   0 — clean
#   1 — at least one emoji codepoint found
#   2 — usage error / missing input

set -euo pipefail

# Force UTF-8 so PCRE \x{...} ranges are interpreted as Unicode
# codepoints rather than raw bytes.
export LC_ALL="${LC_ALL:-C.UTF-8}"

PORTAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE_DIR="${PORTAL_DIR}/server/templates"

# Emoji codepoint character class.
EMOJI_RE='[\x{1F300}-\x{1F9FF}\x{2600}-\x{26FF}\x{2700}-\x{27BF}\x{FE00}-\x{FE0F}\x{1F1E0}-\x{1F1FF}\x{200D}\x{20E3}\x{1FA00}-\x{1FAFF}]|[\x{E0020}-\x{E007F}]'

# Comment-line skip pattern: leading whitespace then // or *.
COMMENT_RE='^[[:space:]]*(\/\/|\*)'

# Portability shim. CI runs on Linux (GNU grep -P available); macOS
# ships BSD grep which lacks -P. We probe for `grep -P`; if absent we
# fall back to `pcre2grep -u` (homebrew pcre2) or `perl -nE`. All three
# evaluate the SAME PCRE \x{...} character class, so behavior is
# identical wherever PCRE is available.
_pcre_engine=""
if echo "" | grep -qP '' 2>/dev/null; then
  _pcre_engine="grep"
elif command -v pcre2grep >/dev/null 2>&1; then
  _pcre_engine="pcre2grep"
elif command -v perl >/dev/null 2>&1; then
  _pcre_engine="perl"
else
  echo "lint-no-emoji: no PCRE engine found (need grep -P, pcre2grep, or perl)" >&2
  exit 2
fi

pcre_grep_n() {
  # $1 = pattern, $2 = file. Emits `LINE:CONTENT` on stdout for hits.
  local pattern="$1" file="$2"
  case "${_pcre_engine}" in
    grep)
      grep -nP "${pattern}" "${file}" 2>/dev/null || true
      ;;
    pcre2grep)
      pcre2grep -u -n "${pattern}" "${file}" 2>/dev/null || true
      ;;
    perl)
      perl -CSDA -ne 'BEGIN{$p=shift @ARGV} print "$.:$_" if /$p/' \
        "${pattern}" "${file}" 2>/dev/null || true
      ;;
    *)
      echo "lint-no-emoji: internal — unknown PCRE engine ${_pcre_engine}" >&2
      return 2
      ;;
  esac
}

pcre_grep_v() {
  # Inverse match on stdin against $1; outputs surviving lines.
  local pattern="$1"
  case "${_pcre_engine}" in
    grep)
      grep -vP "${pattern}" || true
      ;;
    pcre2grep)
      pcre2grep -u -v "${pattern}" || true
      ;;
    perl)
      perl -CSDA -ne 'BEGIN{$p=shift @ARGV} print unless /$p/' \
        "${pattern}" || true
      ;;
    *)
      echo "lint-no-emoji: internal — unknown PCRE engine ${_pcre_engine}" >&2
      return 2
      ;;
  esac
}

usage() {
  cat <<USAGE >&2
usage: $(basename "$0") [--scan-file <path>]

Scans server/templates/**/*.tsx (or a single file via --scan-file) for
Unicode emoji codepoints and exits 1 on any hit, 0 otherwise.
USAGE
}

# Argument parse — supports --scan-file <path> override.
SCAN_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --scan-file)
      if [[ $# -lt 2 ]]; then
        echo "lint-no-emoji: --scan-file requires a path" >&2
        usage
        exit 2
      fi
      SCAN_FILE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "lint-no-emoji: unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

# Build the file list. NUL-delimited to handle paths with spaces.
FILE_LIST_TMP="$(mktemp -t lint-no-emoji.XXXXXX)"
trap 'rm -f "${FILE_LIST_TMP}"' EXIT

if [[ -n "${SCAN_FILE}" ]]; then
  if [[ ! -f "${SCAN_FILE}" ]]; then
    echo "lint-no-emoji: scan file not found: ${SCAN_FILE}" >&2
    exit 2
  fi
  printf '%s\0' "${SCAN_FILE}" > "${FILE_LIST_TMP}"
else
  if [[ ! -d "${TEMPLATE_DIR}" ]]; then
    echo "lint-no-emoji: template dir not found: ${TEMPLATE_DIR}" >&2
    exit 2
  fi
  find "${TEMPLATE_DIR}" -type f -name '*.tsx' -print0 > "${FILE_LIST_TMP}"
fi

# Scan loop. We collect hits, print them, and exit 1 if any.
hits=0
while IFS= read -r -d '' file; do
  # PCRE pass 1: line-numbered emoji matches (LINE:CONTENT).
  # PCRE pass 2: drop entries whose CONTENT begins with whitespace then
  # `//` or `*` (TS/JSX comment lines).
  matches="$(
    pcre_grep_n "${EMOJI_RE}" "${file}" \
      | pcre_grep_v '^[0-9]+:[[:space:]]*(\/\/|\*)' \
      || true
  )"
  if [[ -n "${matches}" ]]; then
    while IFS= read -r line; do
      printf '%s:%s\n' "${file}" "${line}"
      hits=$((hits + 1))
    done <<<"${matches}"
  fi
done < "${FILE_LIST_TMP}"

if [[ "${hits}" -gt 0 ]]; then
  echo "lint-no-emoji: ${hits} emoji codepoint hit(s) found" >&2
  exit 1
fi

exit 0
