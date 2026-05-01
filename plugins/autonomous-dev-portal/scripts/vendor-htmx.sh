#!/usr/bin/env bash
# SPEC-013-4-02 §HTMX Vendoring.
#
# Downloads HTMX from unpkg, verifies SHA-256 against the pinned hash,
# and writes static/htmx.min.js + static/htmx.min.js.LICENSE.
#
# Idempotent: if the local file already matches the pinned hash, exits 0
# without re-downloading. This makes the script safe to run on every
# build and supports offline operation.
#
# Upgrading: edit BOTH HTMX_VERSION and HTMX_SHA256 together; mismatched
# constants are intentional friction to prevent silent CDN drift.
#
# Exit codes:
#   0 — vendored file matches pinned hash
#   1 — download failed, hash mismatch, or move error

set -euo pipefail

HTMX_VERSION="1.9.12"
HTMX_SHA256="449317ade7881e949510db614991e195c3a099c4c791c24dacec55f9f4a2a452"
HTMX_URL="https://unpkg.com/htmx.org@${HTMX_VERSION}/dist/htmx.min.js"

OUT="static/htmx.min.js"
LIC="static/htmx.min.js.LICENSE"

if [[ ! -d "static" ]]; then
  echo "vendor-htmx: static/ directory not found (run from plugin root)" >&2
  exit 1
fi

# Portable sha256 helper.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Idempotency: skip the network round-trip if the file is already
# byte-identical to the pinned hash.
if [[ -f "${OUT}" ]]; then
  EXISTING_SHA="$(sha256_of "${OUT}")"
  if [[ "${EXISTING_SHA}" == "${HTMX_SHA256}" ]]; then
    echo "vendor-htmx: ${OUT} already matches pinned SHA — skipping download"
    exit 0
  fi
  echo "vendor-htmx: existing ${OUT} hash mismatch (${EXISTING_SHA}) — re-vendoring"
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "vendor-htmx: curl not found — cannot fetch ${HTMX_URL}" >&2
  exit 1
fi

TMP="$(mktemp -t htmx-vendor.XXXXXX)"
trap 'rm -f "${TMP}"' EXIT

echo "vendor-htmx: downloading ${HTMX_URL}"
if ! curl -fsSL --max-time 30 "${HTMX_URL}" -o "${TMP}"; then
  echo "vendor-htmx: download failed from ${HTMX_URL}" >&2
  exit 1
fi

ACTUAL_SHA="$(sha256_of "${TMP}")"
if [[ "${ACTUAL_SHA}" != "${HTMX_SHA256}" ]]; then
  echo "vendor-htmx: SHA-256 mismatch!" >&2
  echo "  expected: ${HTMX_SHA256}" >&2
  echo "  actual:   ${ACTUAL_SHA}" >&2
  echo "  URL:      ${HTMX_URL}" >&2
  echo "vendor-htmx: refusing to overwrite ${OUT}" >&2
  exit 1
fi

mv "${TMP}" "${OUT}"
trap - EXIT
echo "vendor-htmx: wrote ${OUT} (sha256=${HTMX_SHA256})"

# License is committed; refresh only if missing or empty.
if [[ ! -s "${LIC}" ]]; then
  echo "vendor-htmx: WARNING — ${LIC} missing; commit the BSD-2-Clause text" >&2
fi
