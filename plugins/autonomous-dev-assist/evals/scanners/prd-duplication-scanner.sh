#!/usr/bin/env bash
# prd-duplication-scanner.sh — detect >=N-char verbatim sentence duplication
# between a rendered wizard phase module and a PRD chain section.
#
# usage:
#   prd-duplication-scanner.sh --rendered <md> --prd <md> --section <name> --min-len N
#
# exit:
#   0 = clean (no duplications)
#   1 = duplication(s) found (offending sentences echoed to stderr)
#   2 = usage / argument error
#
# Splits the rendered file into sentence-like fragments using `[.!?]\s+`
# delimiters. Strips fenced code blocks. Drops fragments shorter than
# --min-len. Exact-matches each remaining fragment against the named
# section of the PRD (markdown H2 heading prefix match, e.g. `## chain`).
#
# Reusable: SPEC-033-2-03 (phase 12) and SPEC-033-4-02 (phase 16)
# both invoke this scanner against PRD-015 / PRD-017.

set -uo pipefail

usage() {
  echo "usage: $0 --rendered <md> --prd <md> --section <name> --min-len N" >&2
  exit 2
}

rendered=""
prd=""
section=""
min_len=40

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rendered) rendered="${2:-}"; shift 2 ;;
    --prd)      prd="${2:-}"; shift 2 ;;
    --section)  section="${2:-}"; shift 2 ;;
    --min-len)  min_len="${2:-}"; shift 2 ;;
    -h|--help)  usage ;;
    *) echo "[scanner] unknown argument: $1" >&2; usage ;;
  esac
done

[[ -z "$rendered" || -z "$prd" || -z "$section" ]] && usage
[[ ! -f "$rendered" ]] && { echo "[scanner] rendered file not found: $rendered" >&2; exit 2; }

# PRD file is optional; if absent we treat the run as scanner-clean (no source).
if [[ ! -f "$prd" ]]; then
  echo "[scanner] PRD file not found; treating as scanner-clean: $prd" >&2
  exit 0
fi

# Extract the named section from the PRD (markdown H2 heading prefix match).
prd_section="$(awk -v sect="$section" '
  BEGIN { flag = 0 }
  /^## / {
    if (flag) exit
    if (tolower($0) ~ tolower(sect)) flag = 1
    next
  }
  flag { print }
' "$prd")"

# If section absent → no source to compare; clean.
if [[ -z "$prd_section" ]]; then
  exit 0
fi

# Strip code fences from the rendered file before sentence splitting.
rendered_text="$(awk '/^```/{f=!f;next} !f {print}' "$rendered")"

# Split into sentence fragments. Use a portable awk RS approach.
mapfile -t fragments < <(printf '%s' "$rendered_text" | awk -v ml="$min_len" '
  BEGIN { RS = "[.!?]"; }
  {
    gsub(/[\n\r]/, " ", $0);
    gsub(/^[ \t]+|[ \t]+$/, "", $0);
    gsub(/[ \t]{2,}/, " ", $0);
    if (length($0) >= ml + 0) print
  }
')

found=0
for frag in "${fragments[@]}"; do
  [[ -z "$frag" ]] && continue
  if grep -qF -- "$frag" <<< "$prd_section"; then
    echo "[scanner] DUPLICATION (>=${min_len} chars): $frag" >&2
    found=1
  fi
done

exit "$found"
