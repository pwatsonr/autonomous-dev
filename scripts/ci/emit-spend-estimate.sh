#!/usr/bin/env bash
# scripts/ci/emit-spend-estimate.sh
#
# Emits the HMAC-signed spend-estimate artifact consumed by PLAN-017-4's
# budget gate. Shared by `release.yml` (SPEC-017-3-01/02) and
# `assist-evals.yml` (SPEC-017-3-03). Builds a seven-field JSON envelope,
# computes a SHA-256 HMAC over the canonical JSON of the six non-HMAC
# fields, and writes the artifact to .github/budget/spend-${GITHUB_RUN_ID}.json.
#
# This emitter MUST produce byte-identical output (modulo run-time fields)
# to PLAN-017-1's `emit-spend-artifact.sh` so the same verifier accepts both.
#
# Required env vars:
#   BUDGET_HMAC_KEY        Repository secret, hex-encoded.
#   GITHUB_RUN_ID          Provided automatically by GitHub Actions.
#   GITHUB_ACTOR           Provided automatically by GitHub Actions.
#   ESTIMATED_COST_USD     Caller-supplied dollar estimate (e.g. "0.00", "0.15").
#   GITHUB_WORKFLOW        Provided automatically; logical workflow name.

set -euo pipefail
# Ensure secret material is never echoed even if the shell traces commands.
set +x

: "${BUDGET_HMAC_KEY:?BUDGET_HMAC_KEY must be set}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID must be set}"
: "${GITHUB_ACTOR:?GITHUB_ACTOR must be set}"
: "${ESTIMATED_COST_USD:?ESTIMATED_COST_USD must be set}"

workflow_name="${SPEND_WORKFLOW_NAME:-${GITHUB_WORKFLOW:-unknown}}"
month="$(date -u +%Y-%m)"
timestamp="$(date -u +%FT%TZ)"

mkdir -p .github/budget
output_path=".github/budget/spend-${GITHUB_RUN_ID}.json"

base_json="$(jq -n \
  --arg workflow "$workflow_name" \
  --arg run_id "$GITHUB_RUN_ID" \
  --arg actor "$GITHUB_ACTOR" \
  --arg month "$month" \
  --arg estimated_cost_usd "$ESTIMATED_COST_USD" \
  --arg timestamp "$timestamp" \
  '{workflow:$workflow, run_id:$run_id, actor:$actor, month:$month, estimated_cost_usd:$estimated_cost_usd, timestamp:$timestamp}')"

canonical="$(printf '%s' "$base_json" | node scripts/ci/canonical-json.js)"

hmac="$(printf '%s' "$canonical" | openssl dgst -sha256 -mac HMAC -macopt "key:${BUDGET_HMAC_KEY}" -hex | awk '{print $2}')"

printf '%s' "$base_json" | jq --arg hmac "$hmac" '. + {hmac:$hmac}' > "$output_path"

echo "Wrote $output_path"
