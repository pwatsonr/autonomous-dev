# SPEC-017-1-04: Spend Artifact Emission with HMAC & Trust-Model Documentation Header

## Metadata
- **Parent Plan**: PLAN-017-1
- **Tasks Covered**: Task 6 (spend artifact emission with HMAC), Task 9 (trust-model documentation header)
- **Estimated effort**: 2.5 hours

## Description
Add the final two pieces of `claude-assistant.yml`: a spend-artifact emission step that produces an HMAC-signed JSON cost record consumed by PLAN-017-4's budget gate, and a top-of-file documentation comment block that explains the trust model and links back to TDD-017 §4 and PRD-010 §FR-4001..FR-4007.

The spend artifact is the producer side of the contract that PLAN-017-4 will consume. This spec defines the JSON shape, the canonical-JSON serialization rule that the HMAC is computed over, and the artifact upload using `actions/upload-artifact@v4`. The HMAC key is supplied via the `BUDGET_HMAC_KEY` repository secret and is never logged. The artifact is uploaded with a 30-day retention so PLAN-017-4's monthly aggregation has access to the prior month's records.

The header comment is operator-facing documentation embedded in the workflow file itself. It is the first thing a reviewer sees when opening `claude-assistant.yml` and codifies the four trust-model invariants that no future change may violate without a security review.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/.github/workflows/claude-assistant.yml` | Modify | Add header comment block (top of file) and spend-artifact step (end of `respond` job) |
| `plugins/autonomous-dev/scripts/ci/canonical-json.js` | Create | Deterministic JSON serializer shared with PLAN-017-4 |
| `plugins/autonomous-dev/scripts/ci/emit-spend-artifact.sh` | Create | Bash wrapper that builds the JSON, computes the HMAC, writes the file |

## Implementation Details

### Header Comment Block

Inserted at the top of `claude-assistant.yml`, before `name:`. Must use `#` YAML line comments (not HTML comments). Length ≤ 30 lines.

```yaml
# ============================================================
# Claude Assistant Workflow — Trust Model
# ============================================================
# This workflow responds to `@claude` mentions in issue/PR comments
# via `anthropics/claude-code-action@v1`. The four invariants below
# are the security boundary; changes to any of them require an
# explicit security review (see TDD-017 §4 and PRD-010 §FR-4001..FR-4007).
#
# 1. SILENT-SKIP for untrusted authors. Comments from anyone outside
#    the {OWNER, MEMBER, COLLABORATOR} allow-list never produce a
#    reply or visible error. Attackers learn nothing about the trust
#    boundary. Enforced by the `claude-trust-gate` composite action.
#
# 2. AUTHOR_ASSOCIATION ALLOW-LIST is fixed: OWNER, MEMBER,
#    COLLABORATOR. Adding CONTRIBUTOR, FIRST_TIMER, or NONE requires
#    a documented threat-model review.
#
# 3. PROMPT IS THE COMMENT BODY VERBATIM. Never concatenate file
#    content into the prompt string. Future features that need file
#    context MUST use the action's `--attach` mechanism, not shell
#    interpolation. `claude_args` is a literal string, never
#    interpolated from event data.
#
# 4. CONCURRENCY KEY is per-issue/per-PR with cancel-in-progress.
#    Rapid-fire comments produce a single reply (the latest); prior
#    runs are cancelled. The audit log still records cancelled runs.
#
# Cross-reference: TDD-017 §4, PRD-010 §FR-4001..FR-4007.
# ============================================================
```

### Spend Artifact JSON Shape

The artifact is a single JSON object written to `.github/budget/spend-${{ github.run_id }}.json`. Fields:

| Field | Type | Source / Value |
|-------|------|----------------|
| `workflow` | string | Literal `"claude-assistant"`. |
| `run_id` | string | `${{ github.run_id }}` as a string. |
| `actor` | string | `${{ github.event.comment.user.login }}` (the comment author). |
| `month` | string | ISO `YYYY-MM` derived from UTC `date -u +%Y-%m`. |
| `estimated_cost_usd` | number | Numeric estimate of this run's cost. Initial implementation: `0.0` (real estimation arrives in PLAN-017-4 task 5 once the action exposes token counts). |
| `timestamp` | string | ISO-8601 UTC timestamp via `date -u +%FT%TZ`. |
| `hmac` | string | Hex-encoded HMAC-SHA256 of the canonical JSON of the OTHER six fields, keyed by `BUDGET_HMAC_KEY`. |

### Canonical-JSON Rule

The HMAC is computed over a canonical serialization of the six non-HMAC fields to guarantee determinism across Node versions and runners. `scripts/ci/canonical-json.js` implements:

1. Sort object keys lexicographically (recursively if nested; the spend artifact is flat but the helper supports nesting for PLAN-017-4 reuse).
2. Serialize with `JSON.stringify` after sorting; no whitespace, no trailing newline.
3. Numbers serialize via JS default representation (no exponential notation tweaks).

```js
// scripts/ci/canonical-json.js
'use strict';

function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

module.exports = { canonicalize };

if (require.main === module) {
  let input = '';
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    const obj = JSON.parse(input);
    process.stdout.write(canonicalize(obj));
  });
}
```

The script can be invoked as `node scripts/ci/canonical-json.js < input.json` or required as a module by future Node-based consumers (PLAN-017-4 task 2's verifier reuses this exact module).

### Spend-Artifact Emission Script

`scripts/ci/emit-spend-artifact.sh` is invoked by the workflow step. It:

1. Builds the six-field JSON object via `jq -n`.
2. Pipes it through `node scripts/ci/canonical-json.js` to produce the canonical string.
3. Computes `openssl dgst -sha256 -mac HMAC -macopt key:"$BUDGET_HMAC_KEY"` over the canonical string and extracts the hex digest.
4. Adds the `hmac` field to the original (non-canonical) JSON via `jq` and writes the result to `.github/budget/spend-${RUN_ID}.json`.

```bash
#!/usr/bin/env bash
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
```

### Workflow Step Additions

Append two steps to the end of the `respond` job (after the `Invoke Claude` step from SPEC-017-1-03):

```yaml
- name: Emit spend artifact
  if: success()
  env:
    BUDGET_HMAC_KEY: ${{ secrets.BUDGET_HMAC_KEY }}
    GITHUB_ACTOR_LOGIN: ${{ github.event.comment.user.login }}
  run: ./scripts/ci/emit-spend-artifact.sh

- name: Upload spend artifact
  if: success()
  uses: actions/upload-artifact@v4
  with:
    name: spend-estimate-${{ github.run_id }}
    path: .github/budget/spend-${{ github.run_id }}.json
    retention-days: 30
    if-no-files-found: error
```

Notes:
- `if: success()` ensures the artifact only emits for completed Claude invocations. Failed runs do not contribute to spend tallies (their cost is recorded by Anthropic's billing dashboard, not by us).
- `BUDGET_HMAC_KEY` is exported via `env:` (not interpolated into the script) so it does not leak into job logs via `set -x` or trace output.
- `if-no-files-found: error` prevents silent omission if the artifact path is wrong; surfacing the error early avoids PLAN-017-4's gate falsely concluding "no recent runs."
- The artifact name pattern `spend-estimate-<run_id>` is the contract PLAN-017-4 consumes via `gh run download --name 'spend-estimate-*'`.

## Acceptance Criteria

- [ ] Header comment block exists at the top of `claude-assistant.yml`, uses `#` YAML comments, is ≤ 30 lines, and references both TDD-017 §4 and PRD-010 §FR-4001..FR-4007.
- [ ] Header documents all four invariants: silent-skip, allow-list, prompt rule, concurrency.
- [ ] `actionlint` passes with zero warnings on the modified workflow.
- [ ] `scripts/ci/canonical-json.js` exists and exports a `canonicalize(value)` function that produces deterministic output (verified by a smoke test: same input always produces byte-identical output).
- [ ] `scripts/ci/canonical-json.js` sorts object keys recursively and uses `JSON.stringify` for primitives.
- [ ] `scripts/ci/emit-spend-artifact.sh` exists, is executable (`chmod +x`), and uses `set -euo pipefail`.
- [ ] The script hard-fails (exits non-zero) when `BUDGET_HMAC_KEY`, `GITHUB_RUN_ID`, or `GITHUB_ACTOR_LOGIN` is unset.
- [ ] The emitted JSON contains exactly seven fields: `workflow`, `run_id`, `actor`, `month`, `estimated_cost_usd`, `timestamp`, `hmac`. No extra fields.
- [ ] `workflow` field equals the literal string `"claude-assistant"`.
- [ ] `month` field matches the regex `^\d{4}-\d{2}$` and is the UTC year/month at run time.
- [ ] `timestamp` field matches the ISO-8601 UTC pattern `YYYY-MM-DDTHH:MM:SSZ`.
- [ ] `hmac` field is a 64-character lowercase hex string (SHA-256 output length).
- [ ] The HMAC value verifies correctly when re-computed: take the JSON, drop the `hmac` field, canonicalize, HMAC-SHA256 with `BUDGET_HMAC_KEY`, hex-encode → must equal the `hmac` field.
- [ ] `BUDGET_HMAC_KEY` does NOT appear in any workflow log or job summary (verified by `actionlint`'s shellcheck pass and by manual log inspection on a test run).
- [ ] `actions/upload-artifact@v4` is used; `retention-days: 30`; `if-no-files-found: error`; artifact name is `spend-estimate-${{ github.run_id }}`.
- [ ] After a successful Claude invocation, `gh run download --name spend-estimate-<run_id>` retrieves a file that parses as JSON and matches all of the above field-shape rules.

## Dependencies

- **SPEC-017-1-03** (Audit log + Claude action) must be merged first; this spec appends two steps after the Claude action step.
- **SPEC-017-1-02** (Workflow scaffold) and **SPEC-017-1-01** (Composite action) must be merged first (transitive).
- Node.js 20+ available on `ubuntu-latest` (default; no extra install).
- `jq` available on `ubuntu-latest` (default; preinstalled).
- `openssl` available on `ubuntu-latest` (default; preinstalled).
- Repository secret `BUDGET_HMAC_KEY` configured. Generation: `openssl rand -hex 32` and stored via `gh secret set BUDGET_HMAC_KEY`.
- `actions/upload-artifact@v4` (already used by other workflows in autonomous-dev).

## Notes

- The `estimated_cost_usd` field is `0.0` in this spec because `anthropics/claude-code-action@v1` does not yet expose per-run token counts in its outputs. PLAN-017-4 task 5 (Claude action wrapper that captures usage stats) will replace the `0.0` with a real estimate. The HMAC field is signed regardless so the contract is forward-compatible — PLAN-017-4's verifier accepts any non-negative number.
- The canonical-JSON helper at `scripts/ci/canonical-json.js` is intentionally vendored here rather than fetched from npm. It is small (≤ 30 lines), zero-dependency, and the determinism guarantee depends on knowing exactly what code runs. PLAN-017-4 task 2 imports the SAME file (not a copy) so producer and consumer cannot drift.
- The `BUDGET_HMAC_KEY` is a symmetric secret shared between this workflow (signer) and PLAN-017-4's gate (verifier). Both run in the same repository so a shared repository secret is the correct trust boundary; rotation is documented in PLAN-017-4's runbook (out of scope for this spec).
- `if: success()` on both new steps means a failed Claude invocation does NOT emit a spend artifact. This is correct: the budget gate counts successful invocations only, and Anthropic's own billing already accounts for partial failures separately.
- The artifact's 30-day retention matches PLAN-017-4's monthly aggregation window with a small buffer. PLAN-017-4 task 4 documents the storage cost (negligible at expected volumes).
- This spec lives at `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-017-1-04-spend-artifact-hmac-and-trust-model-header.md` once promoted from staging.
- The `awk '{print $2}'` extraction from `openssl dgst` output is portable across BSD and GNU openssl (both emit `(stdin)= <hex>` format with the hex as the second whitespace-separated token). If a future runner change introduces variance, replace with `openssl dgst ... -binary | xxd -p -c 256` for unambiguous binary extraction.
