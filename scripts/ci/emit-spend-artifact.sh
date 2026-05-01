#!/usr/bin/env bash
# scripts/ci/emit-spend-artifact.sh
#
# Emits the HMAC-signed spend artifact consumed by PLAN-017-4's budget
# gate. Builds the seven-field JSON envelope, computes a SHA-256 HMAC
# over the canonical JSON of the six non-HMAC fields, and writes the
# artifact to .github/budget/spend-${GITHUB_RUN_ID}.json.
#
# Required env vars:
#   BUDGET_HMAC_KEY      Repository secret, hex-encoded.
#   GITHUB_RUN_ID        Provided automatically by GitHub Actions.
#   GITHUB_ACTOR_LOGIN   Comment author's GitHub login.

set -euo pipefail

: "${BUDGET_HMAC_KEY:?BUDGET_HMAC_KEY must be set}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID must be set}"
: "${GITHUB_ACTOR_LOGIN:?GITHUB_ACTOR_LOGIN must be set}"

month="$(date -u +%Y-%m)"
timestamp="$(date -u +%FT%TZ)"
estimated_cost_usd=0.0

mkdir -p .github/budget
output_path=".github/budget/spend-${GITHUB_RUN_ID}.json"

base_json="$(jq -n \
  --arg workflow 'claude-assistant' \
  --arg run_id "$GITHUB_RUN_ID" \
  --arg actor "$GITHUB_ACTOR_LOGIN" \
  --arg month "$month" \
  --argjson estimated_cost_usd "$estimated_cost_usd" \
  --arg timestamp "$timestamp" \
  '{workflow:$workflow, run_id:$run_id, actor:$actor, month:$month, estimated_cost_usd:$estimated_cost_usd, timestamp:$timestamp}')"

canonical="$(printf '%s' "$base_json" | node scripts/ci/canonical-json.js)"

hmac="$(printf '%s' "$canonical" | openssl dgst -sha256 -mac HMAC -macopt "key:${BUDGET_HMAC_KEY}" -hex | awk '{print $2}')"

printf '%s' "$base_json" | jq --arg hmac "$hmac" '. + {hmac:$hmac}' > "$output_path"
