# SPEC-033-1-02: Idempotency-Check Helper Library + Cred-Proxy Bridge Stub

## Metadata
- **Parent Plan**: PLAN-033-1 (Wizard Orchestrator + Phase Modules 8 & 11)
- **Parent TDD**: TDD-033-setup-wizard-phase-modules
- **Tasks Covered**: PLAN-033-1 Task 3 (`lib/idempotency-checks.sh`), Task 4 (`lib/cred-proxy-bridge.sh` stub)
- **Estimated effort**: 0.75 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-02

## 1. Summary

This spec implements the idempotency-probe helper library and the
phase-1 stub of the cred-proxy bridge. Idempotency probes are read-only
state inspectors that the orchestrator calls before entering a phase to
decide between three outcomes: `start-fresh`, `resume-from:<step>`, and
`already-complete`. The cred-proxy bridge stub exposes the function
signatures phase-8 will use for `secrets.env` writes today, with a
hard-fail stub for cloud credential paths that PLAN-033-4 replaces.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                                              | Task |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | A bash library at `plugins/autonomous-dev-assist/skills/setup-wizard/lib/idempotency-checks.sh` MUST expose helpers `config_key_equals`, `file_exists_with_hash`, `endpoint_responds_2xx`, `gh_api_returns_200`, `wizard_state_phase_complete`. | T3   |
| FR-2  | Each helper MUST emit one of `start-fresh`, `resume-from:<step>`, `already-complete` to stdout and exit 0 on a successful probe. Probe-evaluation errors exit 2 with stderr prefixed `[idempotency-checks]`. | T3   |
| FR-3  | `endpoint_responds_2xx <url>` MUST poll up to 5 times at 2-second intervals (TDD-033 §6.2) and return `already-complete` if any poll returns 2xx, else `start-fresh`.    | T3   |
| FR-4  | `gh_api_returns_200 <api-path>` MUST issue a single `gh api <path>` call (no retry; the API call is idempotent) and return `already-complete` on 200, `start-fresh` on 404, `resume-from:<step>` on 200 with partial body. | T3   |
| FR-5  | `file_exists_with_hash <path> <expected-sha256>` MUST return `already-complete` if the file exists and `sha256sum` matches; `resume-from:rescaffold` if the file exists with a different hash; `start-fresh` if missing. | T3   |
| FR-6  | `wizard_state_phase_complete <NN>` MUST read `~/.autonomous-dev/wizard-state.json` and return `already-complete` if `phases.NN.status == "complete"`, else `start-fresh`. | T3   |
| FR-7  | All helpers MUST be read-only: zero filesystem writes, asserted by the bats fs-snapshot harness from SPEC-033-1-01.                                                       | T3   |
| FR-8  | A bash library at `plugins/autonomous-dev-assist/skills/setup-wizard/lib/cred-proxy-bridge.sh` MUST expose stubs `cred_proxy_write_env <var-name> <secret>`, `cred_proxy_read_handle <env> <backend>`. | T4   |
| FR-9  | `cred_proxy_write_env` MUST append `<var-name>=<secret>` to `${AUTONOMOUS_DEV_SECRETS_FILE:-$HOME/.autonomous-dev/secrets.env}`, ensuring file mode `0600`, and emit no echo of the secret to stdout/stderr. If the variable already exists with a different value, it MUST be replaced (upsert). | T4   |
| FR-10 | `cred_proxy_read_handle` MUST emit `[cred-proxy-bridge] cloud handles unimplemented; see PLAN-033-4` to stderr and exit 99 (sentinel). | T4   |
| FR-11 | The cred-proxy bridge file header MUST include a bold "STUB; cloud handles unimplemented" warning paragraph documenting which calls are functional (env-write) and which are stubbed (cloud handles). | T4   |
| FR-12 | A bats test file at `plugins/autonomous-dev-assist/tests/setup-wizard/idempotency-checks.bats` MUST exercise each helper across truth-table inputs.                                              | T3   |

## 3. Non-Functional Requirements

| Requirement                  | Target                                       | Measurement Method                                          |
|------------------------------|----------------------------------------------|-------------------------------------------------------------|
| Probe latency (local file)   | < 50ms per helper (file/json reads)          | bats with `time` block; averaged across 20 runs             |
| Network probe ceiling        | ≤ 5 polls × 2s = 10s for `endpoint_responds_2xx` | unit test with mocked HTTP server returning 503 → 200 transition |
| Network probe ceiling        | ≤ 5 calls per probe per TDD-033 §10.3        | bats counts `curl`/`gh` invocations                          |
| Read-only invariant          | 0 fs writes during helper invocation         | fs-snapshot diff before/after                               |
| `secrets.env` permission     | mode 0600 enforced after every write         | `stat -c %a` (Linux) / `stat -f %A` (macOS) returns `600`   |
| Secret leak                  | 0 occurrences of secret value in stdout/stderr/log of cred_proxy_write_env | grep on captured streams during bats runs    |

## 4. Technical Approach

**File 1: `lib/idempotency-checks.sh`**

Header docstring: contract — "stdout MUST be one of `start-fresh|resume-from:<step>|already-complete`; exit 0 on success, 2 on probe-eval error". `set -uo pipefail` (no `-e`).

| Function                    | Implementation sketch                                                                                                          |
|-----------------------------|--------------------------------------------------------------------------------------------------------------------------------|
| `config_key_equals`         | Same as skip-predicates' helper but maps to `already-complete` (match) / `start-fresh` (no match). For idempotency consumers.   |
| `file_exists_with_hash`     | If file missing → `start-fresh`. If hash matches → `already-complete`. Else → `resume-from:rescaffold`.                         |
| `endpoint_responds_2xx`     | Loop `for i in 1 2 3 4 5; do curl -fsS -m 2 "$1" >/dev/null && { echo "already-complete"; exit 0; }; sleep 2; done; echo "start-fresh"`. |
| `gh_api_returns_200`        | `gh api "$1" --jq . >/tmp/probe.json 2>/dev/null` → on 200 emit `already-complete`; 404 → `start-fresh`; partial body markers (e.g. body lacks `required_status_checks`) → `resume-from:configure-protection`. |
| `wizard_state_phase_complete` | `jq -e ".phases.\"$1\".status == \"complete\"" $WIZARD_STATE_FILE` → `already-complete` else `start-fresh`.                  |

Dispatch shim identical to SPEC-033-1-01.

**File 2: `lib/cred-proxy-bridge.sh`**

Header banner: 8-line `#`-comment block beginning `# !!! STUB — DO NOT USE FOR CLOUD CREDENTIALS !!!`. Documents:
- functional path: `cred_proxy_write_env` writes to `secrets.env` mode 0600.
- stub path: `cred_proxy_read_handle` errors out with sentinel exit 99.
- pointer to PLAN-033-4 / SPEC-033-4-01 for full implementation.

Implementation pseudocode:

```
cred_proxy_write_env() {
  local name="$1" secret="$2"
  local file="${AUTONOMOUS_DEV_SECRETS_FILE:-$HOME/.autonomous-dev/secrets.env}"
  mkdir -p "$(dirname "$file")"
  touch "$file"
  chmod 0600 "$file"
  # upsert: drop existing line for this var, append new
  grep -v "^${name}=" "$file" > "${file}.new" || true
  printf '%s=%s\n' "$name" "$secret" >> "${file}.new"
  mv "${file}.new" "$file"
  chmod 0600 "$file"
  unset secret
}

cred_proxy_read_handle() {
  echo "[cred-proxy-bridge] cloud handles unimplemented; see PLAN-033-4" >&2
  exit 99
}
```

The function signature MUST NOT echo `$secret` anywhere. The implementation uses temp-file-rename to avoid leaving a half-written `secrets.env`.

**File 3: bats tests** — `tests/setup-wizard/idempotency-checks.bats`. One `@test` per helper × truth-table row. Each test wraps a `run` block, asserts stdout, exit code, and (where applicable) the fs-snapshot invariant.

## 5. Interfaces and Dependencies

**Consumed:**
- `jq`, `curl` (>= 7.60), `gh` (>= 2.20), `sha256sum` or `shasum -a 256`.
- `~/.autonomous-dev/wizard-state.json` schema: `{phases: {"08": {status, started_at, completed_at}, ...}}` — written by orchestrator (SPEC-033-1-03).

**Produced:**
- `idempotency-checks.sh` callable + sourceable.
- `cred-proxy-bridge.sh` callable + sourceable; `cred_proxy_write_env` is the only path used in PLAN-033-1 (called by phase 8 in SPEC-033-1-04).

**No external services.**

## 6. Acceptance Criteria

### `file_exists_with_hash` (FR-5)

```
Given a file at /tmp/x.yml whose sha256 is "abc..."
When `file_exists_with_hash /tmp/x.yml abc...` runs
Then stdout is "already-complete" and exit 0

Given the same file with hash "def..."
When `file_exists_with_hash /tmp/x.yml abc...` runs
Then stdout is "resume-from:rescaffold" and exit 0

Given /tmp/x.yml does not exist
When `file_exists_with_hash /tmp/x.yml abc...` runs
Then stdout is "start-fresh" and exit 0
```

### `endpoint_responds_2xx` (FR-3)

```
Given a local HTTP server that returns 503 for the first 2 polls then 200
When `endpoint_responds_2xx http://127.0.0.1:9876/healthz` runs
Then stdout is "already-complete" within 6 seconds (≤ 3 polls)
And exit 0

Given a local HTTP server that always returns 503
When `endpoint_responds_2xx http://127.0.0.1:9876/healthz` runs
Then stdout is "start-fresh" after exactly 5 polls (≈ 10s)
And exit 0
```

### `gh_api_returns_200` (FR-4)

```
Given gh api responds with 404
When `gh_api_returns_200 repos/foo/bar/branches/main/protection` runs
Then stdout is "start-fresh" and exit 0

Given gh api responds with 200 and a body containing `required_status_checks`
When `gh_api_returns_200 ...` runs
Then stdout is "already-complete"

Given gh api responds with 200 but the body lacks `required_status_checks`
When `gh_api_returns_200 ...` runs
Then stdout is "resume-from:configure-protection"
```

### `wizard_state_phase_complete` (FR-6)

```
Given wizard-state.json with {"phases":{"08":{"status":"complete"}}}
When `wizard_state_phase_complete 08` runs
Then stdout is "already-complete"

Given wizard-state.json with {"phases":{"08":{"status":"in-progress"}}}
When `wizard_state_phase_complete 08` runs
Then stdout is "start-fresh"

Given wizard-state.json missing
When `wizard_state_phase_complete 08` runs
Then stdout is "start-fresh" and exit 0 (treat missing as not-yet-run)
```

### Read-only invariant (FR-7)

```
Given any helper in idempotency-checks.sh
When invoked from a clean fs-snapshot
Then the post-invocation fs-snapshot diff against the pre-snapshot is empty
```

### `cred_proxy_write_env` upsert + mode (FR-9)

```
Given an empty secrets.env
When `cred_proxy_write_env DISCORD_TOKEN sek-ret-1` is invoked
Then secrets.env contains exactly the line "DISCORD_TOKEN=sek-ret-1"
And `stat -c %a secrets.env` returns "600" on Linux (or 0600 on macOS)
And the captured stdout/stderr of the helper contain zero occurrences of "sek-ret-1"

Given secrets.env already containing "DISCORD_TOKEN=old"
When `cred_proxy_write_env DISCORD_TOKEN new` is invoked
Then secrets.env contains exactly the line "DISCORD_TOKEN=new"
And no "DISCORD_TOKEN=old" line remains
And mode is still 0600
```

### `cred_proxy_read_handle` stub (FR-10, FR-11)

```
Given any inputs to cred_proxy_read_handle
When invoked
Then exit code is 99
And stderr matches "/cloud handles unimplemented; see PLAN-033-4/"
And stdout is empty

Given the file lib/cred-proxy-bridge.sh
When the file is read
Then the first 20 lines contain a paragraph including the literal text "STUB" and "cloud handles unimplemented"
```

### Secret leak invariant (NFR — Secret leak)

```
Given a fuzz corpus of 100 secret-like strings (including high-entropy and ones containing shell metacharacters like `$`, `"`, `\`)
When cred_proxy_write_env is invoked for each
Then for every invocation: stdout is empty, stderr is empty, and grep of the secret string against both streams returns 0 matches
```

## 7. Test Requirements

**bats — `tests/setup-wizard/idempotency-checks.bats`:**

| Test ID | Helper                       | Setup                                          | Assert                                          |
|---------|------------------------------|------------------------------------------------|-------------------------------------------------|
| T-101   | file_exists_with_hash        | matching file                                   | stdout "already-complete", exit 0               |
| T-102   | file_exists_with_hash        | mismatching hash                                | stdout "resume-from:rescaffold"                 |
| T-103   | file_exists_with_hash        | missing file                                    | stdout "start-fresh"                            |
| T-201   | endpoint_responds_2xx        | mocked 503→503→200                              | "already-complete" within 6s                    |
| T-202   | endpoint_responds_2xx        | mocked 503 forever                              | "start-fresh" after 5 polls                     |
| T-203   | endpoint_responds_2xx        | invocation count                                | curl invoked ≤ 5 times                          |
| T-301   | gh_api_returns_200           | mocked 404                                      | "start-fresh"                                   |
| T-302   | gh_api_returns_200           | mocked 200 with required_status_checks          | "already-complete"                              |
| T-303   | gh_api_returns_200           | mocked 200 without required_status_checks       | "resume-from:configure-protection"              |
| T-401   | wizard_state_phase_complete  | state.json status=complete                      | "already-complete"                              |
| T-402   | wizard_state_phase_complete  | state.json status=in-progress                   | "start-fresh"                                   |
| T-403   | wizard_state_phase_complete  | missing state.json                              | "start-fresh", exit 0                           |
| T-501   | invariant                    | fs-snapshot before/after each helper            | empty diff                                      |

**bats — `tests/setup-wizard/cred-proxy-bridge.bats`:**

| Test ID | Function                | Setup                            | Assert                                                          |
|---------|-------------------------|----------------------------------|-----------------------------------------------------------------|
| T-601   | cred_proxy_write_env    | empty secrets.env                | line written, mode 0600, no leak                                |
| T-602   | cred_proxy_write_env    | existing var                     | upserted, mode preserved                                        |
| T-603   | cred_proxy_write_env    | secret with `"`, `$`, `\\`       | line written verbatim; no shell expansion of secret             |
| T-604   | cred_proxy_write_env    | fuzz corpus (100 secrets)        | none appear in stdout/stderr                                    |
| T-701   | cred_proxy_read_handle  | any args                         | exit 99, stderr matches sentinel pattern                        |
| T-702   | header banner           | grep first 20 lines of file      | contains "STUB" and "cloud handles unimplemented"                |

## 8. Implementation Notes

- For HTTP mocking in bats, use `python3 -m http.server` against a temp document root or a small `socat`/`nc` script; pin the port to avoid collisions.
- For `gh api` mocking, set `GH_HOST` to a local stub or use a `gh` shim on a temp `$PATH`.
- macOS `stat` syntax differs; tests should detect platform and use the matching flag.
- The temp-file-rename in `cred_proxy_write_env` is critical: a `>>` append on a missing-newline final line corrupts the file.
- `set -e` is intentionally NOT enabled; all error paths are explicit.

## 9. Rollout Considerations

- Pure libraries; no feature flag.
- `cred-proxy-bridge.sh` ships as STUB; SPEC-033-4-01 replaces it. CI lint (added in SPEC-033-4-01) prevents non-phase-16 callers of `cred_proxy_read_handle`.

## 10. Effort Estimate

| Activity                                        | Estimate |
|-------------------------------------------------|----------|
| Implement `idempotency-checks.sh`               | 0.25 day |
| Implement `cred-proxy-bridge.sh` stub           | 0.1 day  |
| Author bats suites for both                     | 0.4 day  |
| **Total**                                       | **0.75 day** |
