# SPEC-017-3-01: release.yml Scaffold, Tag-vs-Manifest Version Check, and Spend Artifact (Release)

## Metadata
- **Parent Plan**: PLAN-017-3
- **Tasks Covered**: Task 1 (scaffold release.yml), Task 2 (tag-vs-manifest version check), Task 10 (spend artifact emission — release portion)
- **Estimated effort**: 5 hours
- **Spec path (after promotion)**: `plugins/autonomous-dev/docs/specs/SPEC-017-3-01-release-yml-version-check-spend.md`

## Description
Establish the `release.yml` workflow skeleton and the first hard precondition for every tagged release: the pushed tag must match the version recorded in the `autonomous-dev` plugin manifest. This spec produces a workflow that triggers only on `v*` tag pushes, asserts version agreement via `jq`, and emits a HMAC-signed spend-estimate artifact that downstream budget gating (PLAN-017-4) consumes. No Claude invocation, no GitHub Release creation, no eval gating yet — those land in SPEC-017-3-02 and SPEC-017-3-04. The workflow is non-cancellable (releases are precious) and has a 10-minute top-level timeout.

This spec defines the spine onto which SPEC-017-3-02 (changelog + release) and SPEC-017-3-04 (verify-evals job) graft additional jobs via `needs:` edges. The job names declared here (`verify-version`) and the artifact-name pattern (`spend-estimate-${{ github.run_id }}`) are stable contracts those specs depend on.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `.github/workflows/release.yml` | Create | Scaffold + verify-version job + spend artifact step |
| `scripts/ci/canonical-json.js` | Create (or reuse) | Deterministic JSON serializer for HMAC input. Reuse if PLAN-017-1 already vendored it; otherwise create per the contract below. |
| `scripts/ci/emit-spend-estimate.sh` | Create | Helper that constructs the spend JSON and computes HMAC. Shared with `assist-evals.yml` (SPEC-017-3-03). |

## Implementation Details

### `release.yml` Top-Level Structure

```yaml
name: release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write       # required for softprops/action-gh-release in SPEC-017-3-02
  pull-requests: read

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false   # releases must complete

jobs:
  verify-version:
    name: Verify tag matches plugin manifest
    runs-on: ubuntu-latest
    timeout-minutes: 10
    outputs:
      version: ${{ steps.extract.outputs.version }}
    steps:
      - uses: actions/checkout@v4

      - id: extract
        name: Extract tag and manifest versions
        run: |
          set -euo pipefail
          TAG_VERSION="${GITHUB_REF_NAME#v}"
          MANIFEST_VERSION="$(jq -r '.version' plugins/autonomous-dev/.claude-plugin/plugin.json)"
          echo "Tag version:      $TAG_VERSION"
          echo "Manifest version: $MANIFEST_VERSION"
          if [ "$TAG_VERSION" != "$MANIFEST_VERSION" ]; then
            echo "::error::Tag ${GITHUB_REF_NAME} does not match plugin manifest version ${MANIFEST_VERSION}"
            exit 1
          fi
          echo "version=${TAG_VERSION}" >> "$GITHUB_OUTPUT"

      - name: Emit spend estimate
        if: always()
        env:
          BUDGET_HMAC_KEY: ${{ secrets.BUDGET_HMAC_KEY }}
          ESTIMATED_COST_USD: "0.00"   # no Claude calls in this job
        run: bash scripts/ci/emit-spend-estimate.sh

      - name: Upload spend artifact
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: spend-estimate-${{ github.run_id }}
          path: .github/budget/spend-${{ github.run_id }}.json
          retention-days: 90
```

### `verify-version` Semantics

- `GITHUB_REF_NAME` is the tag string (e.g. `v0.2.0`, `v0.2.0-rc.1`). Strip a single leading `v` only — never a leading `V` and never multiple `v`s. A tag `vv0.2.0` (operator typo) must surface as a mismatch, not be silently normalized.
- Manifest version is read with `jq -r '.version'` from `plugins/autonomous-dev/.claude-plugin/plugin.json`. The path is hard-coded (per-plugin release; multi-plugin coordination is out of scope per PLAN-017-3 §Out of Scope).
- Comparison is byte-exact string equality. Semver pre-release suffixes (`-rc.1`, `-beta.2`) are preserved on both sides.
- Error message format MUST be `::error::Tag <ref> does not match plugin manifest version <manifest>` (exact text — downstream operators grep for this string).

### Spend Artifact Contract (shared with PLAN-017-1, PLAN-017-3 evals)

`scripts/ci/emit-spend-estimate.sh` produces a JSON object at `.github/budget/spend-${GITHUB_RUN_ID}.json`:

```json
{
  "workflow": "release",
  "run_id": "${GITHUB_RUN_ID}",
  "actor": "${GITHUB_ACTOR}",
  "month": "YYYY-MM",
  "estimated_cost_usd": "0.00",
  "timestamp": "2026-04-29T12:34:56Z",
  "hmac": "<hex>"
}
```

- `month` derived from `date -u +%Y-%m`.
- `timestamp` derived from `date -u +%FT%TZ`.
- `hmac` = `HMAC-SHA256(BUDGET_HMAC_KEY, canonical_json_without_hmac_field)` where canonicalization uses `scripts/ci/canonical-json.js` (sorted keys, no whitespace, UTF-8). This MUST match PLAN-017-1's emitter byte-for-byte so PLAN-017-4's verifier accepts both.
- `BUDGET_HMAC_KEY` is read from `secrets.BUDGET_HMAC_KEY` and never logged. The script MUST `set +x` before reading the secret.
- `estimated_cost_usd` is supplied by the caller via the `ESTIMATED_COST_USD` env var. For the `verify-version` job it is `"0.00"` (no Claude invocation). For the changelog job in SPEC-017-3-02 it will be the Claude-call estimate.

### `scripts/ci/canonical-json.js` Contract (if not already vendored)

```js
#!/usr/bin/env node
// Deterministic JSON: sorted keys, no whitespace, no trailing newline.
// Input: JSON on stdin. Output: canonicalized JSON on stdout.
const fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}
process.stdout.write(canon(input));
```

If PLAN-017-1 has already shipped `scripts/ci/canonical-json.js`, this spec MUST reuse it unmodified — do not introduce a second copy. Verify by running `git ls-files scripts/ci/canonical-json.js` before creating.

## Acceptance Criteria

- [ ] `.github/workflows/release.yml` exists and `actionlint` exits 0.
- [ ] Workflow trigger is exactly `on: push: tags: ['v*']` — no other triggers.
- [ ] Top-level `permissions` block contains `contents: write` and `pull-requests: read`.
- [ ] `concurrency` group is `release-${{ github.ref }}` with `cancel-in-progress: false`.
- [ ] Job-level `timeout-minutes: 10` is set on `verify-version`.
- [ ] Pushing tag `v0.2.0` against a manifest containing `"version": "0.2.0"` produces a successful `verify-version` job.
- [ ] Pushing tag `v0.2.0` against a manifest containing `"version": "0.1.9"` fails with stderr containing the exact line `::error::Tag v0.2.0 does not match plugin manifest version 0.1.9`.
- [ ] Pushing tag `v0.2.0-rc.1` against a manifest containing `"version": "0.2.0-rc.1"` succeeds (pre-release suffix preserved on both sides).
- [ ] Pushing tag `vv0.2.0` (typo) against a manifest containing `"version": "0.2.0"` fails (no double-strip normalization).
- [ ] After every run (success or failure), an artifact named `spend-estimate-${{ github.run_id }}` is uploaded with `retention-days: 90`.
- [ ] The artifact JSON validates against the documented shape: `workflow`, `run_id`, `actor`, `month`, `estimated_cost_usd`, `timestamp`, `hmac` are all present and non-empty.
- [ ] The `hmac` field reproduces when re-computed via `cat <artifact> | jq 'del(.hmac)' | node scripts/ci/canonical-json.js | openssl dgst -sha256 -hmac "$BUDGET_HMAC_KEY" -hex` — i.e., HMAC verification passes.
- [ ] `BUDGET_HMAC_KEY` value never appears in the workflow log (verify by searching the run log for the secret value placeholder).
- [ ] `actions/checkout@v4` and `actions/upload-artifact@v4` are pinned to a major version.
- [ ] `verify-version` exposes a job-level output `version` containing the stripped tag (consumed by SPEC-017-3-02's `create-release` job).

## Dependencies

- **Blocking dependency on PLAN-017-1**: `BUDGET_HMAC_KEY` secret must already be configured in repo secrets, and `scripts/ci/canonical-json.js` must already be vendored. If either is absent, this spec creates them per the contract above.
- **Manifest precondition**: `plugins/autonomous-dev/.claude-plugin/plugin.json` must exist with a `version` field. (It does as of the current repo state — see file contents at write time.)
- **No new third-party actions** introduced by this spec beyond `actions/checkout@v4` and `actions/upload-artifact@v4` (both standard).

## Notes

- This spec deliberately ships a release workflow that does NOT yet create a GitHub Release or generate a changelog. The `verify-version` job produces an output (`version`) and a spend artifact and exits — useful as an early-warning trigger that catches version-mismatch typos before any expensive downstream step runs.
- `cancel-in-progress: false` is intentional: a partial release (tag pushed, partial publish, then cancelled) leaves the repo in a hard-to-reason-about state. We accept the duplicate-run risk in exchange for atomic completion.
- The `if: always()` guards on the spend-emission steps mean a failed `verify-version` still emits a (zero-cost) spend artifact. PLAN-017-4's gate must tolerate zero-cost rows; this is the intended design.
- Future: when SPEC-017-3-02 adds the Claude changelog step, it will wire `estimated_cost_usd` to a non-zero value and the same emitter script will be reused. Do not duplicate the emitter logic.
- The `month` field uses `date -u` (UTC), not local time. Operators in non-UTC timezones can still attribute spend to the correct month boundary.
