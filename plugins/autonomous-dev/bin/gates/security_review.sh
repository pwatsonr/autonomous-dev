#!/usr/bin/env bash
# STUB: replace with a real gate evaluator before relying on this in
# production. Emits a passing artifact unconditionally so infra-typed
# requests do not hang on missing gate evaluation. See bin/gates/README.md.
set -euo pipefail

state_dir="${1:-}"
if [[ -z "${state_dir}" ]]; then
    echo "ERROR: usage: $(basename "$0") <state-dir>" >&2
    exit 2
fi
if [[ ! -d "${state_dir}" ]]; then
    echo "ERROR: state-dir not found: ${state_dir}" >&2
    exit 2
fi

mkdir -p "${state_dir}/gates"
artifact="${state_dir}/gates/security_review.json"
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

jq -n --arg ts "${ts}" '{
  gate: "security_review",
  status: "passed",
  stub: true,
  evaluated_at: $ts
}' > "${artifact}"
