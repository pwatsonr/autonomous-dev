# SPEC-017-4-01: Budget Gate Workflow Scaffold & HMAC Artifact Verification

## Metadata
- **Parent Plan**: PLAN-017-4
- **Tasks Covered**: Task 1 (scaffold `budget-gate.yml` reusable workflow), Task 2 (HMAC artifact verification script + canonical-json helper)
- **Estimated effort**: 4.5 hours
- **Future location**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-017-4-01-budget-gate-scaffold-hmac-verify.md`

## Description
Stand up the structural foundation for the cost-control gating layer: the reusable `budget-gate.yml` workflow shell (no thresholds yet — those land in SPEC-017-4-02 and SPEC-017-4-03) and the cryptographic primitives that prove a spend artifact was produced by a trusted Claude-powered workflow run. Subsequent specs build aggregation, threshold logic, integration wiring, tests, and docs on top of this scaffold.

The workflow declares the `workflow_call` trigger contract (so callers in SPEC-017-4-04 can wire `needs: budget-gate`), the permission set required by all later steps (`contents: read`, `pull-requests: write`), the 2-minute timeout from TDD §16, and the per-PR concurrency group. The HMAC verifier and canonical-JSON helper are reusable Node modules with no GitHub-Actions coupling, so they can be unit-tested directly (SPEC-017-4-05) and reused by the aggregator (SPEC-017-4-02).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `.github/workflows/budget-gate.yml` | Create | Reusable workflow shell with `workflow_call`, inputs, permissions, timeout, concurrency. No threshold steps yet. |
| `scripts/ci/verify-spend-artifact.js` | Create | Reads a spend artifact JSON, recomputes HMAC-SHA256 over canonical JSON, exits 0 on match. |
| `scripts/ci/canonical-json.js` | Create | Deterministic JSON serializer (sorted keys, no whitespace) used by the verifier and aggregator. |

## Implementation Details

### `.github/workflows/budget-gate.yml`

```yaml
# Reusable budget gate. Invoked by Claude-powered workflows via `uses: ./.github/workflows/budget-gate.yml`.
# Threshold steps (warn / fail / critical) are added in SPEC-017-4-02 and SPEC-017-4-03.

name: budget-gate

on:
  workflow_call:
    inputs:
      triggering_workflow:
        description: 'Name of the workflow that invoked the gate (for telemetry + summary).'
        required: true
        type: string
    secrets:
      BUDGET_HMAC_KEY:
        required: true
      BUDGET_HMAC_KEY_PREVIOUS:
        required: false
      CLAUDE_MONTHLY_BUDGET_USD:
        required: true

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: budget-gate-${{ github.event.number || github.ref }}
  cancel-in-progress: false

jobs:
  evaluate:
    name: Evaluate monthly budget
    runs-on: ubuntu-latest
    timeout-minutes: 2
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          persist-credentials: false

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      # TODO(SPEC-017-4-02): aggregate step
      # TODO(SPEC-017-4-02): warn step (80%)
      # TODO(SPEC-017-4-03): fail step (100%) + override consumption
      # TODO(SPEC-017-4-03): critical step (110%) + two-admin verification
      # TODO(PLAN-017-4 risk row 2): default to advisory (status comment) for first 30 days post-launch.

      - name: Record gate invocation
        env:
          TRIGGERING_WORKFLOW: ${{ inputs.triggering_workflow }}
        run: |
          echo "## Budget Gate" >> "$GITHUB_STEP_SUMMARY"
          echo "Triggered by: \`$TRIGGERING_WORKFLOW\`" >> "$GITHUB_STEP_SUMMARY"
          echo "Mode: scaffold (thresholds not yet wired — SPEC-017-4-02/03)" >> "$GITHUB_STEP_SUMMARY"
```

### `scripts/ci/canonical-json.js`

Pure module (no I/O). Recursively sorts object keys and emits compact JSON (no whitespace). Arrays preserve order. Numbers, booleans, strings, null serialize per `JSON.stringify` defaults. Throws on circular structures and on `undefined` values inside objects (which would silently disappear).

```js
'use strict';

function canonicalize(value) {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite number not allowed in canonical JSON');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const parts = keys.map((k) => {
      if (value[k] === undefined) {
        throw new Error(`Undefined value at key "${k}" not permitted in canonical JSON`);
      }
      return JSON.stringify(k) + ':' + canonicalize(value[k]);
    });
    return '{' + parts.join(',') + '}';
  }
  throw new Error(`Unsupported type for canonical JSON: ${typeof value}`);
}

module.exports = { canonicalize };
```

### `scripts/ci/verify-spend-artifact.js`

CLI: `node scripts/ci/verify-spend-artifact.js <artifact-path>`. Reads `BUDGET_HMAC_KEY` (and optional `BUDGET_HMAC_KEY_PREVIOUS`) from env. Tries each key in order; success on first match.

Behavior:
1. Read and parse the artifact as JSON. Malformed JSON → exit 1, log `::warning::Malformed JSON in artifact <path>`.
2. Extract and remove `hmac` field. Missing `hmac` → exit 1, log `::warning::Unsigned artifact <path>`.
3. Canonicalize the remaining object using `canonical-json`.
4. For each candidate key, compute `crypto.createHmac('sha256', key).update(canonical).digest('hex')`. If matches the extracted `hmac` (constant-time compare via `crypto.timingSafeEqual`), exit 0 and print `::notice::Verified artifact <path>`.
5. No key matches → exit 1, log `::warning::HMAC verification failed for artifact <path>`.

```js
#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { canonicalize } = require('./canonical-json');

const path = process.argv[2];
if (!path) {
  console.error('Usage: verify-spend-artifact.js <artifact-path>');
  process.exit(2);
}

const candidateKeys = [
  process.env.BUDGET_HMAC_KEY,
  process.env.BUDGET_HMAC_KEY_PREVIOUS,
].filter(Boolean);

if (candidateKeys.length === 0) {
  console.error('::error::BUDGET_HMAC_KEY not set');
  process.exit(2);
}

let raw;
try {
  raw = JSON.parse(fs.readFileSync(path, 'utf8'));
} catch (err) {
  console.log(`::warning::Malformed JSON in artifact ${path}: ${err.message}`);
  process.exit(1);
}

const claimed = raw.hmac;
if (typeof claimed !== 'string' || claimed.length === 0) {
  console.log(`::warning::Unsigned artifact ${path}`);
  process.exit(1);
}

const { hmac: _drop, ...payload } = raw;
const canonical = canonicalize(payload);

const claimedBuf = Buffer.from(claimed, 'hex');
for (const key of candidateKeys) {
  const computed = crypto.createHmac('sha256', key).update(canonical).digest();
  if (computed.length === claimedBuf.length && crypto.timingSafeEqual(computed, claimedBuf)) {
    console.log(`::notice::Verified artifact ${path}`);
    process.exit(0);
  }
}

console.log(`::warning::HMAC verification failed for artifact ${path}`);
process.exit(1);
```

## Acceptance Criteria

- [ ] `.github/workflows/budget-gate.yml` exists, parses with `yamllint`, and `actionlint` passes with no warnings.
- [ ] Workflow declares `on.workflow_call.inputs.triggering_workflow` as `required: true, type: string`.
- [ ] Workflow declares secrets `BUDGET_HMAC_KEY` (required), `CLAUDE_MONTHLY_BUDGET_USD` (required), `BUDGET_HMAC_KEY_PREVIOUS` (optional).
- [ ] Permissions are exactly `contents: read` and `pull-requests: write` per TDD §10.1.
- [ ] Single job `evaluate` has `timeout-minutes: 2` and uses `runs-on: ubuntu-latest`.
- [ ] Concurrency group is `budget-gate-${{ github.event.number || github.ref }}` with `cancel-in-progress: false`.
- [ ] Workflow can be invoked from a test caller via `uses: ./.github/workflows/budget-gate.yml` and completes successfully (scaffold mode emits a step summary line and exits 0).
- [ ] `scripts/ci/canonical-json.js` exports `canonicalize(value)` that produces byte-identical output for inputs with reordered keys (`{a:1,b:2}` and `{b:2,a:1}` → same string).
- [ ] `canonicalize` throws on `undefined` values inside objects, on `NaN`/`Infinity`, and on circular structures (verified by SPEC-017-4-05 unit tests).
- [ ] `scripts/ci/verify-spend-artifact.js` exits 0 when the artifact's `hmac` field matches `HMAC-SHA256(BUDGET_HMAC_KEY, canonicalize(payload-without-hmac))`.
- [ ] Verifier exits 1 with `::warning::HMAC verification failed for artifact <path>` when the artifact body is tampered.
- [ ] Verifier exits 1 with `::warning::Unsigned artifact <path>` when `hmac` field is missing or empty.
- [ ] Verifier exits 1 with `::warning::Malformed JSON in artifact <path>` when the file is not valid JSON.
- [ ] Verifier accepts `BUDGET_HMAC_KEY_PREVIOUS` as a fallback (rotation overlap window per PLAN-017-4 risk row 1).
- [ ] HMAC comparison uses `crypto.timingSafeEqual` (constant-time) to prevent timing oracles.
- [ ] Verifier exits 2 (configuration error, distinct from verification failure) when `BUDGET_HMAC_KEY` is unset.

## Dependencies

- Node 20+ runtime (provided by `actions/setup-node@v4` in the workflow; matches plugin's Vitest target in SPEC-017-4-05).
- No new npm packages — uses Node built-ins (`node:crypto`, `node:fs`).
- `actionlint` and `yamllint` from TDD-016 baseline CI must already be configured.

## Notes

- The threshold logic (warn/fail/critical), aggregator script, label handling, and PR-comment posting are intentionally deferred to SPEC-017-4-02 and SPEC-017-4-03. This spec is a clean interface boundary: the workflow file is added with `TODO(SPEC-017-4-02/03)` markers so reviewers can confirm later specs are slotted into the scaffold rather than rewriting it.
- `canonical-json.js` is intentionally tiny and dependency-free so it can be reused unmodified by the aggregator (SPEC-017-4-02), the override-verification script (SPEC-017-4-03), and any future signing tooling.
- `crypto.timingSafeEqual` requires equal-length buffers; the verifier checks length before calling it to avoid a thrown exception leaking timing info on the malformed-hex path.
- The concurrency group key uses `github.event.number || github.ref` so the gate works for both `pull_request` callers (PR number) and `push`/`workflow_dispatch` callers (ref name).
- Per PLAN-017-4 risk row 2, the workflow ships in advisory mode for the first 30 days; SPEC-017-4-03's fail step will include a `BUDGET_GATE_ADVISORY_MODE` env toggle so operators can promote it to a required check after baseline data is collected.
