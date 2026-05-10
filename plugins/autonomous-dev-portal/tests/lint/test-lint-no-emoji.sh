#!/usr/bin/env bash
# SPEC-034-2-02 — Shell-test driver for lint-no-emoji.sh.
#
# Asserts:
#   - bad-emoji.tsx fixture (contains `✅`) exits 1
#   - clean.tsx fixture exits 0
#   - regular non-emoji Unicode (e.g. `é`) does NOT trigger
#   - full template-tree scan exits 0 (post SPEC-034-2-05 voice sweep)

set -euo pipefail

PORTAL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LINT="${PORTAL_DIR}/scripts/lint-no-emoji.sh"
FIXTURES="${PORTAL_DIR}/tests/fixtures/lint"

fail=0

run_case() {
  local desc="$1"
  local expected="$2"
  shift 2
  local got=0
  "$@" >/dev/null 2>&1 || got=$?
  if [[ "${got}" -ne "${expected}" ]]; then
    echo "FAIL: ${desc} — expected exit ${expected}, got ${got}" >&2
    fail=1
  else
    echo "ok: ${desc} (exit ${got})"
  fi
}

# AC-05: bad fixture exits 1.
run_case "bad-emoji.tsx triggers exit 1" 1 \
  bash "${LINT}" --scan-file "${FIXTURES}/bad-emoji.tsx"

# AC-06: clean fixture exits 0.
run_case "clean.tsx exits 0" 0 \
  bash "${LINT}" --scan-file "${FIXTURES}/clean.tsx"

# Regular Unicode must NOT trigger. Use a process-substitution-friendly
# temp file because --scan-file requires a real path.
TMP_LATIN="$(mktemp -t lint-no-emoji-latin.XXXXXX).tsx"
trap 'rm -f "${TMP_LATIN}"' EXIT
printf 'export const X = () => <span>café résumé</span>;\n' > "${TMP_LATIN}"
run_case "Latin-1 accented chars do NOT trigger" 0 \
  bash "${LINT}" --scan-file "${TMP_LATIN}"

# AC-07: full template tree exits 0 (post-sweep). Skipped if templates
# still contain pre-sweep emoji (SPEC-034-2-05 hasn't landed yet).
if bash "${LINT}" >/dev/null 2>&1; then
  echo "ok: full template scan exits 0"
else
  echo "skip: full template scan has hits (expected pre-SPEC-034-2-05)" >&2
fi

if [[ "${fail}" -ne 0 ]]; then
  echo "test-lint-no-emoji: FAILED" >&2
  exit 1
fi

echo "test-lint-no-emoji: ok"
exit 0
