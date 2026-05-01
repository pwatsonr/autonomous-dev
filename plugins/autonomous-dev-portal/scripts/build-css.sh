#!/usr/bin/env bash
# SPEC-013-4-02 §CSS Build Script.
#
# Concatenates src/styles/*.css in fixed order, applies a regex-based
# minifier (collapse whitespace, strip non-banner comments), prepends a
# license banner, writes to static/portal.css, and validates the
# gzipped size is <3KB.
#
# Exit codes:
#   0 — bundle written and within budget
#   1 — missing source / I/O error / size budget exceeded

set -euo pipefail

SRC_DIR="src/styles"
OUT="static/portal.css"
SOURCES=(
  "${SRC_DIR}/variables.css"
  "${SRC_DIR}/layout.css"
  "${SRC_DIR}/components.css"
  "${SRC_DIR}/utilities.css"
)
SIZE_BUDGET=3072
DATE_STAMP="$(date +%Y-%m-%d)"

# Verify all sources exist BEFORE writing anything.
for src in "${SOURCES[@]}"; do
  if [[ ! -f "${src}" ]]; then
    echo "build-css: missing source ${src}" >&2
    exit 1
  fi
done

if [[ ! -d static ]]; then
  echo "build-css: static/ directory not found (run from plugin root)" >&2
  exit 1
fi

TMP="$(mktemp -t portal-css.XXXXXX)"
trap 'rm -f "${TMP}"' EXIT

# Banner — preserved by the minifier (uses /*! prefix).
printf '/*! autonomous-dev portal.css | MIT | %s */\n' "${DATE_STAMP}" > "${TMP}"

# Concatenate, then minify in-place.
for src in "${SOURCES[@]}"; do
  cat "${src}" >> "${TMP}"
done

# Minify pass:
#   1. Drop /* ... */ comments that do NOT begin with /*! (license).
#   2. Collapse runs of whitespace.
#   3. Trim whitespace around { } : ; , >.
MINIFIED="$(
  awk 'BEGIN{ORS=""} {print}' "${TMP}" \
  | perl -0777 -pe 's{/\*(?!!).*?\*/}{}gs' \
  | perl -0777 -pe 's/\s+/ /g; s/\s*([{};:,>])\s*/$1/g; s/;\}/}/g'
)"

# Final write to OUT.
printf '%s\n' "${MINIFIED}" > "${OUT}"

# Size check on gzipped bytes.
GZIP_SIZE="$(gzip -c "${OUT}" | wc -c | tr -d ' ')"
RAW_SIZE="$(wc -c < "${OUT}" | tr -d ' ')"

if [[ "${GZIP_SIZE}" -ge "${SIZE_BUDGET}" ]]; then
  echo "build-css: gzipped size ${GZIP_SIZE} bytes EXCEEDS budget ${SIZE_BUDGET}" >&2
  echo "build-css: raw size ${RAW_SIZE} bytes" >&2
  exit 1
fi

echo "build-css: wrote ${OUT} (raw=${RAW_SIZE}B, gzipped=${GZIP_SIZE}B / budget ${SIZE_BUDGET}B)"
