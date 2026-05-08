# SPEC-033-4-01: Cred-Proxy Bridge Full Implementation + Credential-Pattern Scanner

## Metadata
- **Parent Plan**: PLAN-033-4
- **Parent TDD**: TDD-033 §6.7, §12 (security invariant)
- **Parent PRD**: AMENDMENT-002 §4.7, AC-08
- **Tasks Covered**: PLAN-033-4 Tasks 1, 2
- **Estimated effort**: 1.5 days
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-02

## 1. Summary

Replace the PLAN-033-1 cred-proxy bridge stub with the full TDD-024
integration: `cred_proxy_provision`, `cred_proxy_validate_handle`, and
`cred_proxy_revoke` wrapping the `autonomous-dev cred-proxy` CLI such
that no credential ever appears on stdout or in any file the wizard
process writes. Also ship a reusable credential-pattern scanner
(`lib/credential-scanner.sh`) that detects six credential pattern
families before any operator-supplied input is written, used by phase
16 inline and by the eval framework as a regression gate. These two
artifacts are the security foundation for phase 16.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                                              | Task |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | `plugins/autonomous-dev-assist/skills/setup-wizard/lib/cred-proxy-bridge.sh` MUST replace the SPEC-033-1-02 stub. The header banner MUST read (verbatim): `# !!! credentials NEVER appear on stdout from this script !!!` followed by a documentation paragraph mapping each function to its TDD-024 CLI call. | T1   |
| FR-2  | `cred_proxy_provision <backend> <env>` MUST invoke `autonomous-dev cred-proxy provision --backend <backend> --env <env>` as a subprocess with the cred-proxy attached to its OWN tty (file descriptors 0/1/2 redirected to `/dev/tty` of the controlling terminal so credential entry happens outside the wizard's pipes). On success it MUST emit ONLY the opaque handle string (regex `^cph_[A-Za-z0-9]{32}$`) on stdout and exit 0. On failure it MUST emit a diagnostic to stderr (no credential bytes) and exit 1. | T1   |
| FR-3  | `cred_proxy_validate_handle <handle>` MUST invoke `autonomous-dev cred-proxy validate --handle <handle>`. On success (handle exists, non-expired) emit `ok` on stdout and exit 0. On expired emit `expired` and exit 2. On unknown emit `unknown` and exit 3. The credential value MUST never appear in stdout/stderr regardless of cred-proxy CLI behavior. | T1   |
| FR-4  | `cred_proxy_revoke <handle>` MUST invoke `autonomous-dev cred-proxy revoke --handle <handle>`. On success exit 0; on already-revoked exit 0 (idempotent); on unknown handle exit 3. Revocation MUST be safe to re-run. | T1   |
| FR-5  | None of the three functions MAY persist the credential to any file accessible by the wizard process (`secrets.env`, wizard.log, eval transcripts, state files). The functions MUST NOT call `cred_proxy_read_handle` from the SPEC-033-1-02 stub; that stub function is removed in this SPEC. | T1   |
| FR-6  | A CI lint MUST fail any phase module other than `phase-16-deploy-backends.md` that calls any function from `lib/cred-proxy-bridge.sh`. The lint is implemented as a grep over `phases/phase-*.md` excluding phase 16. | T1   |
| FR-7  | `tests/setup-wizard/cred-proxy-bridge.bats` MUST exercise each function with a mocked TDD-024 backend (a fixture script on `$PATH` shimming `autonomous-dev cred-proxy`). The mock MUST be parameterizable to return: success+handle, expired, unknown, network error. | T1   |
| FR-8  | The bats suite MUST include a fuzz harness that feeds 50 candidate credential strings (from `tests/fixtures/credential-corpus.txt`) into the mock cred-proxy and asserts NONE appear on the wizard process's captured stdout/stderr. | T1   |
| FR-9  | `plugins/autonomous-dev-assist/skills/setup-wizard/lib/credential-scanner.sh` MUST expose `scan_for_credential <input>` that scans the input string against six pattern families: (a) `AKIA[0-9A-Z]{16}` (AWS access key), (b) `ya29\.[A-Za-z0-9_-]+` (Google OAuth), (c) `xoxb-[A-Za-z0-9-]+` (Slack bot token), (d) `-----BEGIN [A-Z ]+PRIVATE KEY-----` (PEM keys), (e) `gh[pousr]_[A-Za-z0-9]{36,}` (GitHub tokens), (f) high-entropy heuristic: `[A-Za-z0-9_-]{40,}` when within 32 chars of `password|secret|api[_-]?key|token` keyword. | T2   |
| FR-10 | `scan_for_credential` MUST exit 0 (clean) when no pattern matches. On match it MUST exit 1 and emit on stderr `[credential-scanner] match: family=<a-f> reason=<short-string>` (no credential bytes echoed; the literal match is replaced with `<REDACTED>` in the diagnostic). | T2   |
| FR-11 | The scanner MUST be invokable as both a sourced function and as a standalone executable (`credential-scanner.sh "$candidate"`) so the eval framework can use it as a post-run sweep over transcripts. | T2   |
| FR-12 | `tests/setup-wizard/credential-scanner.bats` MUST exercise each pattern family with at least 3 positive cases (real-shape credential strings) and 3 negative cases (similar but non-credential strings). | T2   |
| FR-13 | The scanner MUST produce false-positive rate < 5% across `tests/fixtures/non-credential-corpus.txt` containing 100 strings: port numbers, URLs, hashes, env-var names, common identifiers, base64-encoded short data, UUIDs. | T2   |
| FR-14 | The scanner MUST produce true-positive rate ≥ 95% across `tests/fixtures/credential-corpus.txt` containing ≥ 30 candidate credentials covering all six families. | T2   |
| FR-15 | Both libraries MUST source-protect (`set -uo pipefail`; no `set -e` to allow callers to capture exit codes). Header banners MUST be `#`-comment, present at top of file, and parseable by the `STAGE-4-CANARY.md` security review checklist. | T1, T2 |

## 3. Non-Functional Requirements

| Requirement                                  | Target                                                   | Measurement Method                                                  |
|----------------------------------------------|----------------------------------------------------------|---------------------------------------------------------------------|
| Credential leak                              | 0 occurrences of credential bytes in stdout/stderr/log/transcript across full test suite | `credential-scanner.sh` post-run sweep over captured streams        |
| Cred-proxy invocation isolation              | Wizard process file descriptors 0/1/2 MUST NOT contain credential bytes during provision | Linux: `lsof -p $WIZARD_PID` + FD-content snapshot during cred-proxy subprocess lifetime |
| Scanner false-positive rate                  | < 5%                                                     | bats run over 100-entry non-credential corpus                       |
| Scanner true-positive rate                   | ≥ 95%                                                    | bats run over ≥ 30-entry credential corpus                          |
| Scanner per-input latency                    | < 25ms                                                   | `time` block in bats; averaged across 1000 inputs                    |
| Cred-proxy provision wall-clock              | < 30s with mocked backend                                | bats `time` measurement                                             |
| Read-only invariant for validate/revoke      | 0 wizard-process file writes during validate; revoke writes only via cred-proxy CLI's own state | fs-snapshot diff per bats case                                      |
| CI lint on non-phase-16 callers              | exit 1 on any non-phase-16 call to cred_proxy_*          | bats running the lint shim against fixture phase files              |

## 4. Technical Approach

**File 1: `lib/cred-proxy-bridge.sh`** (full replacement of SPEC-033-1-02 stub)

```bash
#!/usr/bin/env bash
# !!! credentials NEVER appear on stdout from this script !!!
#
# This script wraps TDD-024's cred-proxy CLI. The credential is entered
# by the operator into the cred-proxy's own TTY (the wizard process
# never has the credential bytes in any file descriptor). The script
# emits only an opaque handle (cph_*).
#
# Functions:
#   cred_proxy_provision <backend> <env>  -> opaque handle on stdout
#   cred_proxy_validate_handle <handle>   -> ok|expired|unknown
#   cred_proxy_revoke <handle>            -> idempotent
#
# CI lint enforced: only phase-16-deploy-backends.md may call these
# functions; any other phase module triggers a build failure.

set -uo pipefail

cred_proxy_provision() {
  local backend="$1" env="$2"
  # Subprocess attaches to controlling tty; wizard never sees credential.
  # `setsid` ensures cred-proxy gets its own session so its TTY allocation is
  # independent of the wizard's pipes.
  local handle
  handle="$(setsid autonomous-dev cred-proxy provision \
              --backend "$backend" --env "$env" \
              < /dev/tty 2>&1 1>/dev/tty | tail -1)" \
    || { echo "[cred-proxy-bridge] provision failed for $backend/$env" >&2; return 1; }
  # Validate the handle shape; reject anything else (defense in depth).
  if [[ ! "$handle" =~ ^cph_[A-Za-z0-9]{32}$ ]]; then
    echo "[cred-proxy-bridge] invalid handle shape returned" >&2
    return 1
  fi
  printf '%s\n' "$handle"
}

cred_proxy_validate_handle() {
  local handle="$1"
  local rc
  autonomous-dev cred-proxy validate --handle "$handle" >/dev/null 2>&1
  rc=$?
  case "$rc" in
    0) echo ok ;;
    2) echo expired ;;
    3) echo unknown ;;
    *) echo "[cred-proxy-bridge] validate unexpected rc=$rc" >&2; return 1 ;;
  esac
  return "$rc"
}

cred_proxy_revoke() {
  local handle="$1"
  autonomous-dev cred-proxy revoke --handle "$handle" >/dev/null 2>&1
  local rc=$?
  case "$rc" in
    0|2) return 0 ;;   # 2 == already revoked → idempotent success
    3)   return 3 ;;   # unknown handle
    *)   echo "[cred-proxy-bridge] revoke unexpected rc=$rc" >&2; return 1 ;;
  esac
}
```

The stdout-rewiring trick (`< /dev/tty 2>&1 1>/dev/tty | tail -1`) is
intentional: cred-proxy reads/writes operator interaction on `/dev/tty`,
and the wizard captures only the cred-proxy CLI's last printed line
(the handle). Tests assert that no other line content reaches the
wizard's pipe.

**File 2: `lib/credential-scanner.sh`**

```bash
#!/usr/bin/env bash
# Credential pattern scanner. Used inline by phase 16 against operator
# inputs and as a post-run sweep over transcripts in the eval framework.
# Six pattern families per TDD-033 §6.7.

set -uo pipefail

readonly _CRED_PATTERNS=(
  'AKIA[0-9A-Z]{16}'
  'ya29\.[A-Za-z0-9_-]+'
  'xoxb-[A-Za-z0-9-]+'
  '-----BEGIN [A-Z ]+PRIVATE KEY-----'
  'gh[pousr]_[A-Za-z0-9]{36,}'
)
# (f) is keyword-proximity heuristic, applied in scan_for_credential body.

scan_for_credential() {
  local input="$1"
  local i family reason
  for i in "${!_CRED_PATTERNS[@]}"; do
    if [[ "$input" =~ ${_CRED_PATTERNS[$i]} ]]; then
      family=$(printf "%c" $((97 + i)))   # a..e
      reason="pattern=family-$family"
      echo "[credential-scanner] match: family=$family reason=$reason value=<REDACTED>" >&2
      return 1
    fi
  done
  # (f) high-entropy heuristic: scan for keyword + 40+ char alnum within 32 chars.
  if [[ "$input" =~ (password|secret|api[_-]?key|token).{0,32}[A-Za-z0-9_-]{40,} ]]; then
    echo "[credential-scanner] match: family=f reason=keyword-proximity value=<REDACTED>" >&2
    return 1
  fi
  return 0
}

# Allow standalone invocation:
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  scan_for_credential "$1"
fi
```

**Test fixtures:**

`tests/fixtures/credential-corpus.txt` (≥ 30 lines): real-shape but
non-functional credentials covering all six families (e.g.
`AKIAIOSFODNN7EXAMPLE`, `ya29.a0AfH6SMBxFakeExample-token`, multi-line
PEM blocks, GitHub PATs, `password=` lines with 40+ char alnum tail,
etc.). Each entry must NOT be a real working credential — the file is
checked into git.

`tests/fixtures/non-credential-corpus.txt` (≥ 100 lines): port
numbers (`8080`, `443`), URLs, SHA-256 hashes, env-var names like
`AKIA_REGION`, UUIDs, base64 of short payloads, common identifiers
like `master-of-puppets`, `tokens-bay-area`, etc.

**bats test plan (selection):**

| Test ID | Scenario                                                    | Assert                                                            |
|---------|-------------------------------------------------------------|-------------------------------------------------------------------|
| CPB-101 | provision happy path with mock                              | stdout matches `^cph_[A-Za-z0-9]{32}$`; exit 0                    |
| CPB-102 | provision invalid handle shape                              | exit 1; stderr diagnostic                                         |
| CPB-103 | provision network error                                     | exit 1; no stdout                                                 |
| CPB-201 | validate ok                                                 | stdout `ok`; exit 0                                               |
| CPB-202 | validate expired                                            | stdout `expired`; exit 2                                          |
| CPB-203 | validate unknown                                            | stdout `unknown`; exit 3                                          |
| CPB-301 | revoke happy                                                | exit 0                                                            |
| CPB-302 | revoke already-revoked                                      | exit 0 (idempotent)                                               |
| CPB-303 | revoke unknown                                              | exit 3                                                            |
| CPB-401 | fuzz: 50 credential strings via mock backend                | scanner sweep reports 0 leaks across all captured streams         |
| CPB-501 | CI lint: phase-12 calls cred_proxy_provision                | lint exits 1                                                      |
| CPB-502 | CI lint: phase-16 calls cred_proxy_provision                | lint exits 0                                                      |
| CS-101  | scan family a (AKIA…)                                       | exit 1; reason=family-a                                           |
| CS-102  | scan family b (ya29…)                                       | exit 1; reason=family-b                                           |
| CS-103  | scan family c (xoxb…)                                       | exit 1; reason=family-c                                           |
| CS-104  | scan family d (BEGIN PRIVATE KEY)                           | exit 1; reason=family-d                                           |
| CS-105  | scan family e (ghp_…)                                       | exit 1; reason=family-e                                           |
| CS-106  | scan family f (password=<entropy>)                          | exit 1; reason=family-f                                           |
| CS-201  | non-credential corpus 100 inputs                            | < 5% false-positive rate                                          |
| CS-202  | credential corpus 30+ inputs                                | ≥ 95% true-positive rate                                          |
| CS-301  | scanner per-input latency                                   | < 25ms averaged                                                   |
| CS-401  | standalone invocation                                       | `credential-scanner.sh "$cred"` exits 1                           |

**CI lint shim:** a small bash script invoked by `tests/setup-wizard/cred-proxy-lint.bats`:

```bash
grep -lE 'cred_proxy_(provision|validate_handle|revoke)' \
  plugins/autonomous-dev-assist/skills/setup-wizard/phases/*.md \
  | grep -v 'phase-16-deploy-backends.md' && exit 1 || exit 0
```

## 5. Interfaces and Dependencies

**Consumed:**
- TDD-024 `autonomous-dev cred-proxy {provision,validate,revoke}` CLI surface.
- SPEC-033-1-02 stub being replaced (function signature `cred_proxy_read_handle` REMOVED; `cred_proxy_write_env` retained for phase-8 callers).
- `setsid`, `tail`, `bash 4+`, `grep -E`.

**Produced:**
- `lib/cred-proxy-bridge.sh` (full).
- `lib/credential-scanner.sh`.
- `tests/setup-wizard/cred-proxy-bridge.bats`.
- `tests/setup-wizard/credential-scanner.bats`.
- `tests/setup-wizard/cred-proxy-lint.bats`.
- `tests/fixtures/credential-corpus.txt`.
- `tests/fixtures/non-credential-corpus.txt`.

**Mocks for tests:** `tests/setup-wizard/mocks/autonomous-dev-cred-proxy` shim
(installed on `$PATH` via `PATH="$BATS_TEST_DIRNAME/mocks:$PATH"`) returning
canned outcomes per fixture flag.

## 6. Acceptance Criteria

### Cred-proxy provision returns only handle (FR-2)

```
Given a mock cred-proxy backend configured to return a valid handle
When cred_proxy_provision aws dev is invoked
Then stdout contains exactly one line matching ^cph_[A-Za-z0-9]{32}$
And no credential bytes appear on stdout, stderr, or in any file the wizard wrote
And exit code is 0
```

### Cred-proxy provision failure (FR-2)

```
Given a mock cred-proxy backend configured to fail (network error)
When cred_proxy_provision aws dev is invoked
Then exit code is 1
And stdout is empty
And stderr contains [cred-proxy-bridge] provision failed
And no credential bytes appear in any captured stream
```

### Validate (FR-3)

```
Given a mock backend returning expired
When cred_proxy_validate_handle cph_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA is invoked
Then stdout is "expired"
And exit code is 2

Given a mock backend returning unknown
Then stdout is "unknown"
And exit code is 3
```

### Revoke idempotency (FR-4)

```
Given a previously-revoked handle
When cred_proxy_revoke is invoked twice
Then both invocations exit 0
```

### CI lint (FR-6)

```
Given any phase file other than phase-16-deploy-backends.md contains a call to cred_proxy_provision
When the lint runs
Then it exits 1 with a diagnostic naming the offending file
```

### Scanner pattern coverage (FR-9, FR-10)

```
Given input "AKIAIOSFODNN7EXAMPLE..."
When scan_for_credential is invoked
Then exit code is 1
And stderr contains family=a
And the literal match value is replaced by <REDACTED>

Given input "8080"
When scan_for_credential is invoked
Then exit code is 0
```

### Scanner false-positive rate (FR-13, NFR fp)

```
Given 100 inputs from non-credential-corpus.txt
When scan_for_credential runs against each
Then fewer than 5 produce exit code 1
```

### Scanner true-positive rate (FR-14, NFR tp)

```
Given ≥ 30 inputs from credential-corpus.txt
When scan_for_credential runs against each
Then ≥ 95% produce exit code 1
```

### Cred-proxy invocation FD isolation (NFR isolation)

```
Given cred_proxy_provision is running
When lsof -p $WIZARD_PID is captured during the cred-proxy subprocess lifetime
Then no file descriptor of the wizard process is connected to a file/pipe
  whose contents (snapshot) match any credential pattern from FR-9
```

### Header banner present (FR-1, FR-15)

```
Given lib/cred-proxy-bridge.sh
When the first 20 lines are read
Then the verbatim banner "# !!! credentials NEVER appear on stdout from this script !!!" appears
```

## 7. Test Requirements

- `tests/setup-wizard/cred-proxy-bridge.bats` — see CPB-101 through CPB-502 above.
- `tests/setup-wizard/credential-scanner.bats` — see CS-101 through CS-401 above.
- `tests/setup-wizard/cred-proxy-lint.bats` — runs the lint shim against
  positive (phase 16) and negative (phase 12 fixture) inputs.
- Fixture corpora (credential + non-credential) checked into the repo under
  `tests/fixtures/`.
- A mock cred-proxy executable shim under `tests/setup-wizard/mocks/`.

## 8. Implementation Notes

- The `setsid` + `< /dev/tty` redirection requires a controlling
  terminal. In CI/headless eval runs, the harness MUST stub the
  cred-proxy CLI entirely (via the mock on `$PATH`); no real
  cred-proxy invocation in CI.
- The handle shape regex `^cph_[A-Za-z0-9]{32}$` is from TDD-024's
  cred-proxy contract. If TDD-024 changes this shape, FR-2's regex and
  the scanner family list must update together.
- Removing `cred_proxy_read_handle` from the stub is a breaking change
  to any phase-8 caller introduced in PLAN-033-1. Audit phase-8 module
  source; phase 8 should be using `cred_proxy_write_env` for env-file
  writes only and never `read_handle`. If a caller exists, the lint
  test must catch it.
- The keyword-proximity heuristic (family f) tolerates a small false-positive
  rate; tune the regex against the corpus during implementation if the
  rate drifts above 5%.
- The PEM-key pattern (family d) intentionally accepts whitespace
  variants (`PRIVATE KEY-----` vs `PRIVATE-KEY-----`) so corpus must
  exercise both.
- `setsid` is GNU coreutils on Linux and a separate binary on macOS;
  document in module body that this is Linux-first; on macOS the
  fallback is `script -q /dev/null` but is not under test in this
  SPEC (TDD-033 NG: macOS-only deploy-backend support deferred).

## 9. Rollout Considerations

- Feature flag: tied to `wizard.phase_16_module_enabled` (set in
  SPEC-033-4-04). When the flag is false, neither the bridge nor the
  scanner is exercised at runtime; both still ship in the repo.
- Rollback: `cred-proxy-bridge.sh` is replaced as a unit; revert is a
  single-file revert. `credential-scanner.sh` is additive (new file).
- The CI lint (FR-6) is gating: any PR that introduces a non-phase-16
  caller will be blocked.
- Stage 4 canary gate (per PLAN-033-4 task 10): security review sign-off
  on the header banner, the FD isolation check, and the `setsid` hand-off.

## 10. Effort Estimate

| Activity                                                        | Estimate  |
|-----------------------------------------------------------------|-----------|
| `lib/cred-proxy-bridge.sh` full implementation                  | 0.5 day   |
| `lib/credential-scanner.sh` + corpora                           | 0.5 day   |
| `cred-proxy-bridge.bats` (mock + 12+ cases)                     | 0.25 day  |
| `credential-scanner.bats` (pattern coverage + corpus FP/TP)     | 0.15 day  |
| `cred-proxy-lint.bats`                                          | 0.05 day  |
| Header banner + docs review                                     | 0.05 day  |
| **Total**                                                       | **1.5 day** |
