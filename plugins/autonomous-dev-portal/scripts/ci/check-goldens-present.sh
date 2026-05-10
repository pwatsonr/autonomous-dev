#!/usr/bin/env bash
# SPEC-035-4-04 §Pre-flight golden presence check.
#
# Asserts every expected golden PNG exists at
# `tests/visual-regression/goldens/`. On any miss, exits 1 with the
# documented `GOLDEN_MISSING:` message so CI fails fast with a
# human-readable error rather than an opaque Playwright stack trace.
#
# Expected golden set (21 total):
#   design-system-full.png
#   design-system-card-{01..20}.png

set -euo pipefail

GOLD_DIR="tests/visual-regression/goldens"
EXPECTED=("design-system-full.png")
for n in $(seq -f "%02g" 1 20); do
  EXPECTED+=("design-system-card-${n}.png")
done

missing=0
for name in "${EXPECTED[@]}"; do
  if [[ ! -s "${GOLD_DIR}/${name}" ]]; then
    echo "GOLDEN_MISSING: No golden image found at ${GOLD_DIR}/${name}. Run \"npm run gen:visual-goldens\" locally and commit the generated files."
    missing=1
  fi
done

exit "${missing}"
