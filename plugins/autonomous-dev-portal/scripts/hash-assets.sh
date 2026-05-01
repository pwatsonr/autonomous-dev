#!/usr/bin/env bash
# SPEC-013-4-01 §Hash Build Script.
#
# For each non-hashed source file under static/, copy it to a hashed
# filename (`<basename>-<8-hex>.<ext>`) and write the logical→hashed map
# to static/asset-manifest.json atomically.
#
# Cleans up orphaned hashed copies whose source has been removed.
#
# Exit codes:
#   0 — manifest written
#   1 — invocation / I/O / sha256 failure
#
# Usage:  scripts/hash-assets.sh
# Cwd:    must be the autonomous-dev-portal/ plugin root.

set -euo pipefail

STATIC_DIR="static"
MANIFEST="${STATIC_DIR}/asset-manifest.json"
MANIFEST_TMP="${MANIFEST}.tmp.$$"

if [[ ! -d "${STATIC_DIR}" ]]; then
  echo "hash-assets: ${STATIC_DIR}/ not found (run from plugin root)" >&2
  exit 1
fi

# sha256 driver (portable across Linux + macOS).
sha256_first8() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print substr($1, 1, 8)}'
  else
    shasum -a 256 "$1" | awk '{print substr($1, 1, 8)}'
  fi
}

# Build list of source files (exclude already-hashed filenames and the
# manifest itself). Recognised extensions: js, css, svg, woff2.
SRC_PATTERN='\.(js|css|svg|woff2)$'
HASHED_PATTERN='-[a-f0-9]{8,}\.[a-z0-9]+$'

declare -a SOURCES=()
while IFS= read -r -d '' file; do
  base="${file##*/}"
  if [[ "${base}" == "asset-manifest.json"* ]]; then continue; fi
  if [[ "${base}" =~ ${HASHED_PATTERN} ]]; then continue; fi
  if [[ "${base}" =~ ${SRC_PATTERN} ]]; then
    SOURCES+=("${file}")
  fi
done < <(find "${STATIC_DIR}" -maxdepth 2 -type f -print0)

# Collect existing hashed files for cleanup pass below.
declare -a EXISTING_HASHED=()
while IFS= read -r -d '' file; do
  base="${file##*/}"
  if [[ "${base}" =~ ${HASHED_PATTERN} ]]; then
    EXISTING_HASHED+=("${file}")
  fi
done < <(find "${STATIC_DIR}" -maxdepth 2 -type f -print0)

# Build manifest entries + write hashed copies.
declare -a JSON_ENTRIES=()
declare -a KEEP_HASHED=()

for src in "${SOURCES[@]}"; do
  dir="$(dirname "${src}")"
  base="$(basename "${src}")"
  ext=".${base##*.}"
  stem="${base%${ext}}"
  hash="$(sha256_first8 "${src}")"
  hashed_name="${stem}-${hash}${ext}"
  hashed_path="${dir}/${hashed_name}"

  cp "${src}" "${hashed_path}"
  KEEP_HASHED+=("${hashed_path}")

  # Logical key: relative path under static/ for sources, but logical
  # name == basename for top-level assets per spec example.
  rel_key="${base}"
  rel_value="${hashed_name}"
  # Subdirectory assets retain their relative path on both sides.
  if [[ "${dir}" != "${STATIC_DIR}" ]]; then
    sub="${dir#${STATIC_DIR}/}"
    rel_key="${sub}/${base}"
    rel_value="${sub}/${hashed_name}"
  fi

  # JSON-escape values minimally — we control the input so quotes/
  # backslashes are not expected, but emit safely anyway.
  esc_key="${rel_key//\\/\\\\}"; esc_key="${esc_key//\"/\\\"}"
  esc_val="${rel_value//\\/\\\\}"; esc_val="${esc_val//\"/\\\"}"
  JSON_ENTRIES+=("  \"${esc_key}\": \"${esc_val}\"")
done

# Cleanup orphaned hashed files.
for old in "${EXISTING_HASHED[@]}"; do
  keep=false
  for keeper in "${KEEP_HASHED[@]:-}"; do
    if [[ "${old}" == "${keeper}" ]]; then
      keep=true
      break
    fi
  done
  if [[ "${keep}" == "false" ]]; then
    rm -f -- "${old}"
  fi
done

# Atomic manifest write.
{
  printf '{\n'
  if [[ ${#JSON_ENTRIES[@]} -gt 0 ]]; then
    IFS=$',\n'
    printf '%s\n' "${JSON_ENTRIES[*]}"
    unset IFS
  fi
  printf '}\n'
} > "${MANIFEST_TMP}"

mv "${MANIFEST_TMP}" "${MANIFEST}"

echo "hash-assets: wrote ${MANIFEST} with ${#JSON_ENTRIES[@]} entries"
