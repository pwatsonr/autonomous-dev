#!/usr/bin/env bats

# tests/ci/test_budget_gate.bats
#
# SPEC-017-4-05: bats unit tests for the three budget-gate scripts
# produced by SPEC-017-4-01/02:
#
#   scripts/ci/canonical-json.js
#   scripts/ci/verify-spend-artifact.js
#   scripts/ci/aggregate-spend.js
#
# Tests for verify-two-admin-override.js live in test_two_admin_override.bats.
#
# The verifier is exercised through the CLI (process exit code is the
# contract). Pure aggregator helpers (currentMonthBucket, readCostUsd,
# verifyHmac) are exercised via `node -e` so the tests do not need to
# stand up a mock HTTPS server. Network-dependent tests for the
# aggregator's full flow are out of scope here per SPEC-017-4-05 §Notes.
#
# Tools assumed:
#   - bats-core (already vendored per repo CI; required)
#   - node 20+ (skips with a clear reason otherwise)

setup() {
  REPO_ROOT="$(git rev-parse --show-toplevel)"
  FIXTURES="${REPO_ROOT}/tests/ci/fixtures/spend-artifacts"
  # 64-char hex test key used to sign every fixture under FIXTURES.
  # MUST match the key in tests/ci/helpers/sign-fixture.js invocations
  # documented in the file header for that helper.
  TEST_HMAC_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  WRONG_HMAC_KEY="ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
  export REPO_ROOT FIXTURES TEST_HMAC_KEY WRONG_HMAC_KEY
}

# --------------------------------------------------------------------
# canonical-json.js
# --------------------------------------------------------------------

@test "canonical-json: identical output regardless of key order" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  a=$(node -e 'process.stdout.write(require("./scripts/ci/canonical-json").canonicalize({a:1,b:2}))')
  b=$(node -e 'process.stdout.write(require("./scripts/ci/canonical-json").canonicalize({b:2,a:1}))')
  [ "${a}" = "${b}" ]
  [ "${a}" = '{"a":1,"b":2}' ]
}

@test "canonical-json: nested key order is sorted recursively" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  out=$(node -e 'process.stdout.write(require("./scripts/ci/canonical-json").canonicalize({z:{b:2,a:1},a:1}))')
  [ "${out}" = '{"a":1,"z":{"a":1,"b":2}}' ]
}

@test "canonical-json: arrays preserve insertion order" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  out=$(node -e 'process.stdout.write(require("./scripts/ci/canonical-json").canonicalize([3,1,2]))')
  [ "${out}" = '[3,1,2]' ]
}

@test "canonical-json: serializes string-escaped keys" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  out=$(node -e 'process.stdout.write(require("./scripts/ci/canonical-json").canonicalize({"a\"b":1}))')
  [ "${out}" = '{"a\"b":1}' ]
}

# --------------------------------------------------------------------
# verify-spend-artifact.js — CLI contract
# --------------------------------------------------------------------

@test "verify-spend-artifact: exits 0 for a valid signed artifact" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  run env BUDGET_HMAC_KEY="${TEST_HMAC_KEY}" node "${REPO_ROOT}/scripts/ci/verify-spend-artifact.js" \
    "${FIXTURES}/valid-current-month.json"
  [ "${status}" -eq 0 ]
}

@test "verify-spend-artifact: exits 1 for a tampered artifact" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  run env BUDGET_HMAC_KEY="${TEST_HMAC_KEY}" node "${REPO_ROOT}/scripts/ci/verify-spend-artifact.js" \
    "${FIXTURES}/tampered.json"
  [ "${status}" -eq 1 ]
  echo "${output}" | grep -F "HMAC verification failed"
}

@test "verify-spend-artifact: exits 1 for an unsigned artifact" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  run env BUDGET_HMAC_KEY="${TEST_HMAC_KEY}" node "${REPO_ROOT}/scripts/ci/verify-spend-artifact.js" \
    "${FIXTURES}/unsigned.json"
  [ "${status}" -eq 1 ]
  echo "${output}" | grep -F "Unsigned artifact"
}

@test "verify-spend-artifact: exits 1 for malformed JSON" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  bad="$(mktemp)"
  printf '{not json' > "${bad}"
  run env BUDGET_HMAC_KEY="${TEST_HMAC_KEY}" node "${REPO_ROOT}/scripts/ci/verify-spend-artifact.js" "${bad}"
  rm -f "${bad}"
  [ "${status}" -eq 1 ]
  echo "${output}" | grep -F "Malformed JSON"
}

@test "verify-spend-artifact: exits 2 when no key configured" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  run env -u BUDGET_HMAC_KEY -u BUDGET_HMAC_KEY_PREVIOUS \
    node "${REPO_ROOT}/scripts/ci/verify-spend-artifact.js" \
    "${FIXTURES}/valid-current-month.json"
  [ "${status}" -eq 2 ]
  echo "${output}" | grep -F "BUDGET_HMAC_KEY not set"
}

@test "verify-spend-artifact: exits 2 when artifact path missing" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  run env BUDGET_HMAC_KEY="${TEST_HMAC_KEY}" node "${REPO_ROOT}/scripts/ci/verify-spend-artifact.js"
  [ "${status}" -eq 2 ]
}

@test "verify-spend-artifact: BUDGET_HMAC_KEY_PREVIOUS accepted as fallback (rotation overlap)" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  # Current key is wrong; previous key is correct → must verify.
  run env BUDGET_HMAC_KEY="${WRONG_HMAC_KEY}" BUDGET_HMAC_KEY_PREVIOUS="${TEST_HMAC_KEY}" \
    node "${REPO_ROOT}/scripts/ci/verify-spend-artifact.js" \
    "${FIXTURES}/valid-current-month.json"
  [ "${status}" -eq 0 ]
}

@test "verify-spend-artifact: rejects when both keys are wrong" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  run env BUDGET_HMAC_KEY="${WRONG_HMAC_KEY}" BUDGET_HMAC_KEY_PREVIOUS="${WRONG_HMAC_KEY}" \
    node "${REPO_ROOT}/scripts/ci/verify-spend-artifact.js" \
    "${FIXTURES}/valid-current-month.json"
  [ "${status}" -eq 1 ]
}

@test "verify-spend-artifact: exits 1 when hmac is non-hex (length-mismatched bytes)" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  bad="$(mktemp)"
  printf '%s' '{"workflow":"x","run_id":"1","actor":"a","month":"2026-05","estimated_cost_usd":1,"timestamp":"2026-05-01T00:00:00Z","hmac":"ZZZZ"}' > "${bad}"
  run env BUDGET_HMAC_KEY="${TEST_HMAC_KEY}" node "${REPO_ROOT}/scripts/ci/verify-spend-artifact.js" "${bad}"
  rm -f "${bad}"
  [ "${status}" -eq 1 ]
}

@test "verify-spend-artifact: rejects array body (not an object)" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  bad="$(mktemp)"
  printf '[]' > "${bad}"
  run env BUDGET_HMAC_KEY="${TEST_HMAC_KEY}" node "${REPO_ROOT}/scripts/ci/verify-spend-artifact.js" "${bad}"
  rm -f "${bad}"
  [ "${status}" -eq 1 ]
}

@test "verify-spend-artifact: confirms HMAC uses constant-time compare (timingSafeEqual)" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  # The contract is enforced by reading the source: an external attacker
  # cannot prove timing-safety from the outside, but a regression that
  # replaces timingSafeEqual with `===` is a security issue, so we lock
  # the symbol presence into the test suite.
  run grep -F "timingSafeEqual" "${REPO_ROOT}/scripts/ci/verify-spend-artifact.js"
  [ "${status}" -eq 0 ]
}

# --------------------------------------------------------------------
# aggregate-spend.js — pure helpers (importable via node -e)
# --------------------------------------------------------------------

@test "aggregate-spend: currentMonthBucket formats UTC YYYY-MM" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  out=$(node -e '
    const m = require("./scripts/ci/aggregate-spend").currentMonthBucket(new Date("2026-05-01T00:00:00Z"));
    process.stdout.write(m);
  ')
  [ "${out}" = "2026-05" ]
}

@test "aggregate-spend: currentMonthBucket pads single-digit month" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  out=$(node -e '
    const m = require("./scripts/ci/aggregate-spend").currentMonthBucket(new Date("2026-01-15T00:00:00Z"));
    process.stdout.write(m);
  ')
  [ "${out}" = "2026-01" ]
}

@test "aggregate-spend: readCostUsd accepts numeric estimated_cost_usd" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  out=$(node -e '
    const v = require("./scripts/ci/aggregate-spend").readCostUsd({estimated_cost_usd: 12.5});
    process.stdout.write(String(v));
  ')
  [ "${out}" = "12.5" ]
}

@test "aggregate-spend: readCostUsd accepts string estimated_cost_usd" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  out=$(node -e '
    const v = require("./scripts/ci/aggregate-spend").readCostUsd({estimated_cost_usd: "0.30"});
    process.stdout.write(String(v));
  ')
  [ "${out}" = "0.3" ]
}

@test "aggregate-spend: readCostUsd falls back to cost_usd" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  out=$(node -e '
    const v = require("./scripts/ci/aggregate-spend").readCostUsd({cost_usd: 5});
    process.stdout.write(String(v));
  ')
  [ "${out}" = "5" ]
}

@test "aggregate-spend: readCostUsd returns null when no field present" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  out=$(node -e '
    const v = require("./scripts/ci/aggregate-spend").readCostUsd({});
    process.stdout.write(String(v));
  ')
  [ "${out}" = "null" ]
}

@test "aggregate-spend: verifyHmac accepts a valid signature" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  out=$(BUDGET_HMAC_KEY="${TEST_HMAC_KEY}" FIX="${FIXTURES}/valid-current-month.json" node -e '
    const fs = require("node:fs");
    const { verifyHmac } = require("./scripts/ci/aggregate-spend");
    const raw = JSON.parse(fs.readFileSync(process.env.FIX, "utf8"));
    const claimed = raw.hmac;
    const payload = { ...raw }; delete payload.hmac;
    process.stdout.write(String(verifyHmac(payload, claimed, [process.env.BUDGET_HMAC_KEY])));
  ')
  [ "${out}" = "true" ]
}

@test "aggregate-spend: verifyHmac rejects a tampered body" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  out=$(BUDGET_HMAC_KEY="${TEST_HMAC_KEY}" FIX="${FIXTURES}/tampered.json" node -e '
    const fs = require("node:fs");
    const { verifyHmac } = require("./scripts/ci/aggregate-spend");
    const raw = JSON.parse(fs.readFileSync(process.env.FIX, "utf8"));
    const claimed = raw.hmac;
    const payload = { ...raw }; delete payload.hmac;
    process.stdout.write(String(verifyHmac(payload, claimed, [process.env.BUDGET_HMAC_KEY])));
  ')
  [ "${out}" = "false" ]
}

@test "aggregate-spend: verifyHmac rejects unsigned artifact (no hmac field)" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  out=$(BUDGET_HMAC_KEY="${TEST_HMAC_KEY}" node -e '
    const { verifyHmac } = require("./scripts/ci/aggregate-spend");
    process.stdout.write(String(verifyHmac({a:1}, undefined, [process.env.BUDGET_HMAC_KEY])));
  ')
  [ "${out}" = "false" ]
}

@test "aggregate-spend: verifyHmac accepts previous-key fallback" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  out=$(K="${TEST_HMAC_KEY}" W="${WRONG_HMAC_KEY}" FIX="${FIXTURES}/valid-current-month.json" node -e '
    const fs = require("node:fs");
    const { verifyHmac } = require("./scripts/ci/aggregate-spend");
    const raw = JSON.parse(fs.readFileSync(process.env.FIX, "utf8"));
    const claimed = raw.hmac;
    const payload = { ...raw }; delete payload.hmac;
    process.stdout.write(String(verifyHmac(payload, claimed, [process.env.W, process.env.K])));
  ')
  [ "${out}" = "true" ]
}

@test "aggregate-spend: AGE_CAP_MS is 32 days in milliseconds" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  out=$(node -e '
    const { AGE_CAP_MS } = require("./scripts/ci/aggregate-spend");
    process.stdout.write(String(AGE_CAP_MS));
  ')
  [ "${out}" = "$((32 * 24 * 60 * 60 * 1000))" ]
}

@test "aggregate-spend: DOWNLOAD_BATCH is 8 (parallelism cap)" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  out=$(node -e '
    const { DOWNLOAD_BATCH } = require("./scripts/ci/aggregate-spend");
    process.stdout.write(String(DOWNLOAD_BATCH));
  ')
  [ "${out}" = "8" ]
}

@test "aggregate-spend: inBatches caps in-flight promises at the batch size" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  out=$(node -e '
    (async () => {
      const { inBatches } = require("./scripts/ci/aggregate-spend");
      let inflight = 0; let peak = 0;
      const items = Array.from({length: 25}, (_, i) => i);
      await inBatches(items, 8, async () => {
        inflight++;
        if (inflight > peak) peak = inflight;
        await new Promise(r => setImmediate(r));
        inflight--;
      });
      process.stdout.write(String(peak));
    })();
  ')
  # peak should be ≤ DOWNLOAD_BATCH (8)
  [ "${out}" -le 8 ]
  [ "${out}" -ge 1 ]
}

@test "aggregate-spend: exits 2 when CLAUDE_MONTHLY_BUDGET_USD unset" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  run env -u CLAUDE_MONTHLY_BUDGET_USD GITHUB_TOKEN=x GITHUB_REPOSITORY=o/r BUDGET_HMAC_KEY="${TEST_HMAC_KEY}" \
    node "${REPO_ROOT}/scripts/ci/aggregate-spend.js"
  [ "${status}" -eq 2 ]
  echo "${output}" | grep -F "CLAUDE_MONTHLY_BUDGET_USD not set"
}

@test "aggregate-spend: exits 2 when GITHUB_TOKEN unset" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  run env -u GITHUB_TOKEN GITHUB_REPOSITORY=o/r BUDGET_HMAC_KEY="${TEST_HMAC_KEY}" CLAUDE_MONTHLY_BUDGET_USD=500 \
    node "${REPO_ROOT}/scripts/ci/aggregate-spend.js"
  [ "${status}" -eq 2 ]
  echo "${output}" | grep -F "GITHUB_TOKEN not set"
}

@test "aggregate-spend: exits 2 when BUDGET_HMAC_KEY unset" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  run env -u BUDGET_HMAC_KEY -u BUDGET_HMAC_KEY_PREVIOUS \
    GITHUB_TOKEN=x GITHUB_REPOSITORY=o/r CLAUDE_MONTHLY_BUDGET_USD=500 \
    node "${REPO_ROOT}/scripts/ci/aggregate-spend.js"
  [ "${status}" -eq 2 ]
  echo "${output}" | grep -F "BUDGET_HMAC_KEY not set"
}

# --------------------------------------------------------------------
# Fixture integrity — guards against silent fixture rot.
# --------------------------------------------------------------------

@test "fixtures: every spend-artifact fixture file exists" {
  for f in valid-current-month.json valid-current-month-2.json tampered.json unsigned.json previous-month.json older-than-32-days.json; do
    [ -f "${FIXTURES}/${f}" ] || { echo "missing fixture: ${f}" >&2; return 1; }
  done
}

@test "fixtures: tampered.json HMAC differs from its body's true HMAC" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  out=$(BUDGET_HMAC_KEY="${TEST_HMAC_KEY}" FIX="${FIXTURES}/tampered.json" node -e '
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    const { canonicalize } = require("./scripts/ci/canonical-json");
    const raw = JSON.parse(fs.readFileSync(process.env.FIX, "utf8"));
    const claimed = raw.hmac;
    const payload = { ...raw }; delete payload.hmac;
    const recomputed = crypto.createHmac("sha256", process.env.BUDGET_HMAC_KEY)
      .update(canonicalize(payload)).digest("hex");
    process.stdout.write(claimed === recomputed ? "match" : "differ");
  ')
  [ "${out}" = "differ" ]
}
