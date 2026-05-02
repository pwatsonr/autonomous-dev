#!/usr/bin/env bats

# tests/ci/test_two_admin_override.bats
#
# SPEC-017-4-05: bats unit tests for scripts/ci/verify-two-admin-override.js.
#
# The verifier exposes `verify({httpRequest, ...})` so tests can inject
# a mock HTTP layer and exercise the full validator without touching
# the live GitHub API. Each test loads one of the JSON fixtures under
# tests/ci/fixtures/admin-responses/, builds a mock httpRequest closure
# in a tiny node -e script, and asserts the exit code and stderr line.
#
# Live-API smoke tests (per PLAN-017-4 §Testing Strategy) are out of
# scope; they live in the operator runbook as a manual exercise.
#
# Tools assumed:
#   - bats-core (already vendored per repo CI; required)
#   - node 20+ (skips with a clear reason otherwise)

setup() {
  REPO_ROOT="$(git rev-parse --show-toplevel)"
  ADMIN_FIX="${REPO_ROOT}/tests/ci/fixtures/admin-responses"
  SCRIPT="${REPO_ROOT}/scripts/ci/verify-two-admin-override.js"
  export REPO_ROOT ADMIN_FIX SCRIPT
}

# Helper: run the verifier with a mock httpRequest sourced from a
# fixture path. Echoes the exit code on stdout (0/1/2) and writes the
# verifier's stderr (the ::error:: line) to BATS_TEST_TMPDIR/stderr.
#
# A tiny inline node -e wraps the verifier:
#   - Loads the fixture (admins, labelers).
#   - Implements httpRequest paths:
#       /orgs/<org>/members?role=admin... → admin list
#       /repos/<owner>/<repo>/issues/<n>/events... → labeled events
#       /users/<login> → email lookup
#   - Calls verify() with retry attempts=1 to keep tests fast.
run_verifier_with_fixture() {
  local fixture_path="$1"
  command -v node >/dev/null 2>&1 || skip "node not installed"

  FIX="${fixture_path}" SCRIPT="${SCRIPT}" node -e '
    (async () => {
      const fs = require("node:fs");
      const fix = JSON.parse(fs.readFileSync(process.env.FIX, "utf8"));
      const { verify } = require(process.env.SCRIPT);

      // Build a mock httpRequest that returns paginated responses.
      // First page returns the data; subsequent pages return [] so the
      // verifier short-circuits.
      let callLog = [];
      const httpRequest = async (token, pathStr) => {
        callLog.push(pathStr);
        if (pathStr.includes("/members?role=admin")) {
          if (pathStr.includes("page=1")) {
            return { status: 200, body: fix.admins.map(a => ({ login: a.login })) };
          }
          return { status: 200, body: [] };
        }
        if (pathStr.includes("/issues/") && pathStr.includes("/events")) {
          if (pathStr.includes("page=1")) {
            // Build labeled events for each labeler (in order, no dups
            // — the verifier already dedupes by login but we mirror
            // the GitHub events format faithfully).
            const events = fix.labelers.map((login, i) => ({
              event: "labeled",
              label: { name: "cost:override-critical" },
              actor: { login },
              created_at: new Date(2026, 4, 1, 12, i).toISOString(),
            }));
            return { status: 200, body: events };
          }
          return { status: 200, body: [] };
        }
        if (pathStr.startsWith("/users/")) {
          const login = pathStr.replace("/users/", "");
          const admin = fix.admins.find(a => a.login.toLowerCase() === login.toLowerCase());
          return { status: 200, body: admin ? { email: admin.email } : { email: null } };
        }
        throw new Error("Unmocked path: " + pathStr);
      };

      try {
        const code = await verify({
          token: "test-token",
          repository: "test-org/test-repo",
          prNumber: "42",
          criticalLabel: "cost:override-critical",
          httpRequest,
          retryOpts: { attempts: 1, backoffMs: 0, sleep: () => Promise.resolve() },
        });
        process.exit(code);
      } catch (err) {
        process.stderr.write("UNEXPECTED: " + (err.stack || err.message) + "\n");
        process.exit(99);
      }
    })();
  ' 2>"${BATS_TEST_TMPDIR}/stderr"
}

# --------------------------------------------------------------------
# Happy path
# --------------------------------------------------------------------

@test "two-admin override: accepts two distinct admins with distinct emails (exit 0)" {
  run run_verifier_with_fixture "${ADMIN_FIX}/two-distinct-admins.json"
  [ "${status}" -eq 0 ]
}

# --------------------------------------------------------------------
# Failure modes
# --------------------------------------------------------------------

@test "two-admin override: rejects single admin labeling twice (exit 1)" {
  run run_verifier_with_fixture "${ADMIN_FIX}/single-admin-twice.json"
  [ "${status}" -eq 1 ]
  grep -F "two distinct org admin approvals" "${BATS_TEST_TMPDIR}/stderr"
}

@test "two-admin override: rejects two admins sharing the same verified email (exit 1)" {
  run run_verifier_with_fixture "${ADMIN_FIX}/same-email.json"
  [ "${status}" -eq 1 ]
  grep -F "Same-email accounts not permitted" "${BATS_TEST_TMPDIR}/stderr"
}

@test "two-admin override: rejects when a labeler is not in the admin set (exit 1)" {
  run run_verifier_with_fixture "${ADMIN_FIX}/non-admin-labeler.json"
  [ "${status}" -eq 1 ]
  grep -F "two distinct org admin approvals" "${BATS_TEST_TMPDIR}/stderr"
}

@test "two-admin override: rejects when an admin has email: null (exit 1)" {
  run run_verifier_with_fixture "${ADMIN_FIX}/null-email.json"
  [ "${status}" -eq 1 ]
  grep -F "no verified public email" "${BATS_TEST_TMPDIR}/stderr"
}

# --------------------------------------------------------------------
# Email comparison invariants (case-insensitive)
# --------------------------------------------------------------------

@test "two-admin override: same-email check is case-insensitive (Alice@Example == alice@example)" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  # The same-email.json fixture mixes case ("shared@example.com" vs
  # "Shared@Example.com"). The verifier MUST treat them as identical.
  run run_verifier_with_fixture "${ADMIN_FIX}/same-email.json"
  [ "${status}" -eq 1 ]
  grep -F "Same-email accounts not permitted" "${BATS_TEST_TMPDIR}/stderr"
}

# --------------------------------------------------------------------
# Retry behavior (5xx backoff)
# --------------------------------------------------------------------

@test "two-admin override: retries 3x on 5xx and succeeds on 3rd attempt" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  out=$(node -e '
    (async () => {
      const { withRetry } = require("./scripts/ci/verify-two-admin-override");
      let calls = 0;
      const fn = async () => {
        calls++;
        if (calls < 3) throw new Error("status=503");
        return [{login: "ok"}];
      };
      const result = await withRetry(fn, 3, 0, () => Promise.resolve());
      process.stdout.write(`calls=${calls} result=${result[0].login}`);
    })();
  ')
  [ "${out}" = "calls=3 result=ok" ]
}

@test "two-admin override: surfaces the last error after 3 failed attempts" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  run node -e '
    (async () => {
      const { withRetry } = require("./scripts/ci/verify-two-admin-override");
      try {
        await withRetry(async () => { throw new Error("status=503"); }, 3, 0, () => Promise.resolve());
        process.stdout.write("UNEXPECTED_OK");
      } catch (err) {
        process.stdout.write("THREW:" + err.message);
      }
    })();
  '
  [ "${status}" -eq 0 ]
  echo "${output}" | grep -F "THREW:status=503"
}

@test "two-admin override: empty admin list triggers retry (transient)" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  out=$(node -e '
    (async () => {
      const { withRetry } = require("./scripts/ci/verify-two-admin-override");
      let calls = 0;
      const fn = async () => {
        calls++;
        if (calls < 2) return [];           // transient empty page
        return [{login: "alice"}];
      };
      const result = await withRetry(fn, 3, 0, () => Promise.resolve());
      process.stdout.write(`calls=${calls} len=${result.length}`);
    })();
  ')
  [ "${out}" = "calls=2 len=1" ]
}

# --------------------------------------------------------------------
# CLI contract — exit code 2 for missing env vars.
# --------------------------------------------------------------------

@test "two-admin override (CLI): exits 2 when GITHUB_TOKEN missing" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  run env -u GITHUB_TOKEN GITHUB_REPOSITORY=o/r PR_NUMBER=42 node "${SCRIPT}"
  [ "${status}" -eq 2 ]
  echo "${output}" | grep -F "GITHUB_TOKEN not set"
}

@test "two-admin override (CLI): exits 2 when GITHUB_REPOSITORY missing or invalid" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  run env -u GITHUB_REPOSITORY GITHUB_TOKEN=x PR_NUMBER=42 node "${SCRIPT}"
  [ "${status}" -eq 2 ]
  echo "${output}" | grep -F "GITHUB_REPOSITORY"

  run env GITHUB_TOKEN=x GITHUB_REPOSITORY=norepo PR_NUMBER=42 node "${SCRIPT}"
  [ "${status}" -eq 2 ]
}

@test "two-admin override (CLI): exits 2 when PR_NUMBER missing" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  run env -u PR_NUMBER GITHUB_TOKEN=x GITHUB_REPOSITORY=o/r node "${SCRIPT}"
  [ "${status}" -eq 2 ]
  echo "${output}" | grep -F "PR_NUMBER not set"
}

# --------------------------------------------------------------------
# Module exports — guards against silent API drift.
# --------------------------------------------------------------------

@test "two-admin override: exports verify, withRetry, listAdmins, listLabelers, lookupEmail" {
  command -v node >/dev/null 2>&1 || skip "node not installed"
  out=$(node -e '
    const m = require("./scripts/ci/verify-two-admin-override");
    const expected = ["verify","withRetry","listAdmins","listLabelers","lookupEmail","main"];
    const missing = expected.filter(k => typeof m[k] !== "function");
    process.stdout.write(missing.length ? "MISSING:" + missing.join(",") : "OK");
  ')
  [ "${out}" = "OK" ]
}
