# SPEC-033-1-05: Phase 11 Module — Portal Install + Eval Set

## Metadata
- **Parent Plan**: PLAN-033-1
- **Parent TDD**: TDD-033 §6.2
- **Parent PRD**: AMENDMENT-002 §4.2
- **Tasks Covered**: PLAN-033-1 Task 7 (`phases/phase-11-portal-install.md`), Task 9 (phase-11 eval set)
- **Estimated effort**: 1.5 days
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-02

## 1. Summary

Author the phase 11 module that optionally installs the autonomous-dev
web portal as a managed daemon child. Default flow is **skip** (most
operators are CLI-only). When opted in, the phase collects port,
base-url, session secret and admin credentials (passwords via
`read -s` then bcrypt-hashed before any write), invokes
`autonomous-dev portal install`, polls `/healthz`, and verifies both
admin and non-admin accounts via `/api/auth/login`. Default port-bind
is `127.0.0.1` (TDD-033 §15 Risk: "portal exposed publicly"). Idempotency
reuses an already-responding `/healthz` endpoint and offers
keep-vs-wipe on existing `portal.db`.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                            | Task |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | A markdown file at `plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-11-portal-install.md` MUST exist with a YAML front-matter block conforming to `_phase-contract.md` (SPEC-033-1-01). | T7   |
| FR-2  | The front-matter MUST set `phase: 11`, `title: "Web portal install (optional)"`, `amendment_001_phase: 11`, `tdd_anchors: [TDD-013, TDD-014, TDD-015]`, `required_inputs.phases_complete: [1,2,3,4,5,6,7,8,9,10]`. | T7   |
| FR-3  | The front-matter MUST set `skip_predicate: "skip-predicates.sh portal_install_default_skip"` so that the **default** path is skip. The predicate returns 0 (skip) unless the operator has explicitly set `wizard.portal_install_opt_in=true`. | T7   |
| FR-4  | `skip_consequence` MUST contain the verbatim text "No browser pipeline view; CLI status remains via `autonomous-dev status`." | T7   |
| FR-5  | The front-matter MUST set `idempotency_probe: "idempotency-checks.sh phase-11-probe"` (wrapper documented in §4). | T7   |
| FR-6  | The front-matter MUST set `output_state.config_keys_written: ["portal.enabled", "portal.port", "portal.bind_address", "portal.base_url", "portal.session_secret_env", "portal.daemon_managed"]` and `output_state.files_created: ["~/.autonomous-dev/portal.db"]`. | T7   |
| FR-7  | The module body MUST collect: port (default `8788`), bind address (default `127.0.0.1`), base URL (default `http://127.0.0.1:8788`), session secret (auto-generated 64-byte hex via `openssl rand -hex 32` if operator declines to type one), admin username, admin password, optional non-admin username/password. | T7   |
| FR-8  | Admin and non-admin passwords MUST be collected via `read -s` (no echo). After collection, the module MUST bcrypt-hash each password (cost 12) BEFORE any write to `portal.db`. The plaintext password MUST be `unset` from the bash variable immediately after hashing. | T7   |
| FR-9  | If the operator chooses bind address `0.0.0.0`, the module MUST emit a "WARNING: portal will be reachable from any network interface" prompt and require an explicit "yes-confirm-public-bind" string (literal) before proceeding. | T7   |
| FR-10 | The module MUST invoke `autonomous-dev portal install --port <port> --bind <bind> --base-url <url> --db ~/.autonomous-dev/portal.db --session-secret-env PORTAL_SESSION_SECRET`. The session secret value is written via `cred_proxy_write_env PORTAL_SESSION_SECRET` (SPEC-033-1-02). | T7   |
| FR-11 | The module MUST register the portal as a managed daemon child by writing `portal.daemon_managed=true` to config and SIGHUPing the daemon. | T7   |
| FR-12 | The module MUST poll `/healthz` at `http://<bind>:<port>/healthz` up to 5 times at 2 s intervals (10 s total) per TDD-033 §6.2. A 200 response with body containing `"build_id"` field matching the just-installed binary's build-id MUST be observed. | T7   |
| FR-13 | The module MUST verify both accounts by POSTing `{"username":..., "password":...}` to `/api/auth/login` and asserting HTTP 200 + JSON `{"ok": true}`. | T7   |
| FR-14 | If `portal.db` already exists, the module MUST prompt the operator to choose `keep` (preserve existing accounts; skip account creation steps) or `wipe` (delete `portal.db` and rebuild). The operator's choice MUST be stored in `~/.autonomous-dev/wizard-checkpoint.json` so a kill-and-resume mid-phase respects the prior choice. | T7   |
| FR-15 | If `/healthz` already responds 200 with a current build-id when the phase enters, the module MUST skip the install step entirely and proceed directly to verify (account login). The idempotency probe MUST emit `already-complete` in this case if accounts also validate. | T7   |
| FR-16 | The module MUST NEVER print the plaintext password, session secret, or bcrypt hash to stdout, stderr, or `wizard.log`. | T7   |
| FR-17 | An eval directory at `plugins/autonomous-dev-assist/evals/test-cases/setup-wizard/phase-11-portal-install/` MUST contain four cases: `happy-path.md`, `skip-with-consequence.md`, `error-recovery.md`, `idempotency-resume.md`. | T9   |
| FR-18 | The `happy-path.md` case MUST assert: `/healthz` 200 within 10 s, both `/api/auth/login` calls return `ok:true`, `portal.bind_address=127.0.0.1` (default), no plaintext password leak (regex sweep). | T9   |
| FR-19 | The `skip-with-consequence.md` case MUST assert the verbatim consequence text from FR-4 appears, no `portal.db` written, `portal.enabled=false` in config. | T9   |
| FR-20 | The `error-recovery.md` case MUST cover (a) portal binary missing from PATH and (b) `/healthz` never responds within 10 s; both MUST exit with an actionable diagnostic pointing at `/autonomous-dev-assist:troubleshoot`. | T9   |
| FR-21 | The `idempotency-resume.md` case MUST cover: existing `portal.db` + operator picks `keep` → install skipped, only verify runs; existing `portal.db` + operator picks `wipe` → install rebuilds; phase killed mid-install → re-run resumes at install step (not at password collection). | T9   |
| FR-22 | The eval set MUST also include a public-bind opt-in case (or a sub-assertion in `error-recovery.md`) asserting that `bind=0.0.0.0` without the literal "yes-confirm-public-bind" string is refused. | T9   |

## 3. Non-Functional Requirements

| Requirement                  | Target                                                                | Measurement Method                                                |
|------------------------------|-----------------------------------------------------------------------|-------------------------------------------------------------------|
| Eval pass rate               | ≥ 90% per TDD-033 §9.3 / AMENDMENT-002 AC-03                           | eval framework score over the four-case suite                     |
| `/healthz` poll budget       | ≤ 5 polls × 2 s = 10 s wall clock                                      | poll counter in module body                                       |
| Plaintext password leak      | 0 occurrences in stdout, stderr, wizard.log                            | regex sweep of captured streams per eval case                     |
| Session secret leak          | 0 occurrences outside `secrets.env`                                    | regex sweep of stdout, stderr, wizard.log, config.json            |
| Bcrypt cost factor           | ≥ 12                                                                  | unit test asserts hash prefix `$2a$12$` or `$2b$12$`              |
| Default bind privacy         | `127.0.0.1` is default; `0.0.0.0` requires explicit confirmation       | eval assertion + bats test                                        |
| Phase total runtime (happy)  | < 90 s wall clock (excluding install package download)                 | eval framework duration                                           |

## 4. Technical Approach

**File: `plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-11-portal-install.md`**

```yaml
---
phase: 11
title: "Web portal install (optional)"
amendment_001_phase: 11
tdd_anchors: [TDD-013, TDD-014, TDD-015]
prd_links: []
required_inputs:
  phases_complete: [1,2,3,4,5,6,7,8,9,10]
  config_keys: []
optional_inputs:
  existing_portal_db: true
  port_override: true
  bind_override: true
skip_predicate: "skip-predicates.sh portal_install_default_skip"
skip_consequence: |
  No browser pipeline view; CLI status remains via `autonomous-dev status`.
idempotency_probe: "idempotency-checks.sh phase-11-probe"
output_state:
  config_keys_written:
    - portal.enabled
    - portal.port
    - portal.bind_address
    - portal.base_url
    - portal.session_secret_env
    - portal.daemon_managed
  files_created:
    - "~/.autonomous-dev/portal.db"
  external_resources_created: []
verification:
  - "/healthz returns 200 with matching build_id within 10s"
  - "/api/auth/login admin returns ok:true"
  - "/api/auth/login non-admin returns ok:true (if non-admin configured)"
  - "Daemon reports portal as managed child"
eval_set: "evals/test-cases/setup-wizard/phase-11-portal-install/"
---
```

**Idempotency probe wrapper** (`idempotency-checks.sh phase-11-probe`):
```
1. If portal.enabled is unset or false → emit start-fresh
2. Resolve portal.port + portal.bind_address; curl http://<bind>:<port>/healthz with 2s timeout
3. If not 200 → emit start-fresh (portal.db may exist but daemon isn't running)
4. Compare /healthz response.build_id with $(autonomous-dev portal --build-id)
   - If mismatch → emit resume-from:install (rebuild needed; existing portal.db reuse decided in body)
5. POST /api/auth/login with the configured admin username + a known-good
   probe credential reference (see "verify-without-password trick" below)
6. If login probe returns 200 → emit already-complete
7. Otherwise → emit resume-from:verify-accounts
```

**Verify-without-password trick** for the idempotency probe: the
probe MUST NOT require the operator to re-enter credentials. We use a
short-lived "wizard-probe" account row provisioned during phase 11
install that has a random per-install password stored in `secrets.env`
under `PORTAL_WIZARD_PROBE_PW`. The probe reads that env-var, posts to
`/api/auth/login`, and on 200 confirms portal liveness. The probe row
is documented in TDD-014's portal install path; if absent, the probe
falls back to `/healthz` only and emits `resume-from:verify-accounts`
to re-collect accounts.

**Module body steps:**

| Step name                  | Behavior                                                                                                                                |
|----------------------------|-----------------------------------------------------------------------------------------------------------------------------------------|
| `intro`                    | Banner; portal is **opt-in**; default skip; consequence text shown.                                                                     |
| `confirm-opt-in`           | `read` y/N (default N). On N → mark phase skipped, emit consequence, return to orchestrator.                                            |
| `collect-network`          | Port (default 8788), bind address (default 127.0.0.1), base URL (default `http://127.0.0.1:8788`).                                      |
| `confirm-public-bind`      | If bind=0.0.0.0 → require literal "yes-confirm-public-bind" string per FR-9; otherwise skip step.                                       |
| `collect-session-secret`   | Prompt "auto-generate session secret? [Y/n]". Default Y → `openssl rand -hex 32`. Else `read -s` operator value.                        |
| `db-decision`              | If `~/.autonomous-dev/portal.db` exists → prompt keep/wipe; record in checkpoint.                                                       |
| `collect-admin`            | Skipped on `keep`. `read` username; `read -s` password. bcrypt-hash via `htpasswd -bnBC 12`. unset plaintext.                           |
| `collect-non-admin`        | Skipped on `keep`. Optional. Same flow as admin.                                                                                        |
| `install`                  | `cred_proxy_write_env PORTAL_SESSION_SECRET "$secret"`; `unset secret`. `autonomous-dev portal install --port ... --bind ... --base-url ... --db ... --session-secret-env PORTAL_SESSION_SECRET`. |
| `account-create`           | Skipped on `keep`. `autonomous-dev portal account create --username "$u" --password-hash "$h" [--admin]` per account.                   |
| `register-daemon-child`    | Write `portal.daemon_managed=true`; SIGHUP daemon.                                                                                       |
| `healthz-poll`             | 5 polls × 2 s; assert build_id match. On exhaustion → fail with diagnostic.                                                             |
| `verify-accounts`          | POST `/api/auth/login` for admin (and non-admin if configured); assert 200 + ok:true.                                                   |
| `write-config`             | Write the six output_state config keys.                                                                                                  |

**Defense-in-depth on password handling:**
- `set +x` at top of every step touching a password.
- `htpasswd -bnBC 12` is invoked with password passed via stdin (heredoc with `<<<`), not argv.
- bcrypt hash is read from `htpasswd` stdout, then plaintext is `unset`.
- The hash is passed to `autonomous-dev portal account create --password-hash` (NOT `--password`), so the daemon never sees plaintext.

**Eval set files (FR-17–FR-22):**

`happy-path.md`: opt-in confirmed, port 8788, bind 127.0.0.1, admin + non-admin created, `/healthz` 200 within 10 s, both logins succeed.
- Asserts: `portal.enabled=true`, `portal.port=8788`, `portal.bind_address=127.0.0.1`, `portal.daemon_managed=true`.
- Regex sweep: plaintext password (test value `WizardTest!Password-XYZ123`) appears 0 times in stdout/stderr/wizard.log.
- Session secret regex (`^[a-f0-9]{64}$`) appears in `secrets.env` exactly once and 0 times elsewhere.

`skip-with-consequence.md`: operator declines opt-in.
- Asserts: verbatim consequence text from FR-4 emitted; `portal.enabled=false`; `~/.autonomous-dev/portal.db` does not exist; phase status="skipped".

`error-recovery.md`:
- Sub-case A: `autonomous-dev portal` binary missing from PATH → install step fails; phase exits with diagnostic referencing `/autonomous-dev-assist:troubleshoot`; no config keys written for portal.
- Sub-case B: install succeeds but `/healthz` returns 503 for all 5 polls → phase exits with diagnostic listing the last response body; portal install is left running (no auto-uninstall — rollback is a separate CLI per SPEC-033-4-05).
- Sub-case C: bind=0.0.0.0 without confirmation string → phase refuses; re-prompts.

`idempotency-resume.md`:
- Sub-case A: `portal.db` exists; operator picks `keep` → install + account-create steps skipped; only `healthz-poll` and `verify-accounts` run; phase completes.
- Sub-case B: `portal.db` exists; operator picks `wipe` → `portal.db` deleted; install + account-create + verify run fresh.
- Sub-case C: phase killed during `install` step (after `cred_proxy_write_env` but before binary install completes) → re-run reads checkpoint, resumes at `install` (not at `collect-network`), reuses already-written session secret.
- Sub-case D: full re-run against complete state where probe wizard account validates → emits `already-complete` and is a no-op.

## 5. Interfaces and Dependencies

**Consumed:**
- SPEC-033-1-01: `lib/skip-predicates.sh::portal_install_default_skip` (this SPEC adds it).
- SPEC-033-1-02: `lib/idempotency-checks.sh::phase-11-probe` wrapper (extension here).
- SPEC-033-1-02: `lib/cred-proxy-bridge.sh::cred_proxy_write_env`.
- SPEC-033-1-03: orchestrator state, snapshot, log infrastructure, feature flag `wizard.phase_11_module_enabled`.
- TDD-013 / TDD-014 / TDD-015: portal binary contract (`autonomous-dev portal install`, `/healthz`, `/api/auth/login`, `portal account create --password-hash`).
- PRD-017: portal at `server/portal/...` path.

**Produced:**
- `phases/phase-11-portal-install.md` (the module).
- 4 eval cases under `evals/test-cases/setup-wizard/phase-11-portal-install/`.
- Helper extension: `portal_install_default_skip` predicate (≤ 20 LOC); `phase-11-probe` wrapper (≤ 40 LOC).

**External CLIs / endpoints:**
- `autonomous-dev portal install`, `autonomous-dev portal account create`, `autonomous-dev portal --build-id`.
- Local HTTP: `GET /healthz`, `POST /api/auth/login`.
- `htpasswd` (apache-utils on Linux, brew `httpd` on macOS) or fallback `python3 -c "import bcrypt"` if `htpasswd` unavailable.

## 6. Acceptance Criteria

### Front-matter contract (FR-1–FR-6)

```
Given phases/phase-11-portal-install.md
When the front-matter is parsed by yq
Then phase=11, title="Web portal install (optional)", amendment_001_phase=11
And tdd_anchors == ["TDD-013","TDD-014","TDD-015"]
And required_inputs.phases_complete == [1,2,3,4,5,6,7,8,9,10]
And skip_predicate == "skip-predicates.sh portal_install_default_skip"
And skip_consequence (string-stripped) matches "No browser pipeline view; CLI status remains via `autonomous-dev status`."
And output_state.config_keys_written contains exactly the six keys from FR-6
And output_state.files_created == ["~/.autonomous-dev/portal.db"]
```

### Default-skip path (FR-3, FR-4, FR-19)

```
Given the operator has NOT set wizard.portal_install_opt_in=true
When phase 11 enters
Then portal_install_default_skip exits 0
And the orchestrator emits the verbatim consequence text from FR-4
And phases.11.status == "skipped"
And ~/.autonomous-dev/portal.db is not created
And no portal.* config key other than portal.enabled=false is written
```

### Public-bind guard (FR-9)

```
Given the operator picks bind address 0.0.0.0
When the confirm-public-bind step prompts for confirmation
And the operator types anything other than the literal "yes-confirm-public-bind"
Then the module re-prompts up to 3 times, then aborts with diagnostic
And no install step is executed

Given the operator types exactly "yes-confirm-public-bind"
Then the module proceeds with bind=0.0.0.0 and a WARNING line is logged to wizard.log
```

### Bcrypt + plaintext-no-leak (FR-8, FR-16)

```
Given the operator types admin password "WizardTest!Password-XYZ123"
When the collect-admin step completes
Then the bash variable holding the password is unset (test via `set | grep -c '^password='` returns 0)
And portal account create is invoked with --password-hash starting with "$2a$12$" or "$2b$12$"
And grep "WizardTest!Password-XYZ123" against stdout, stderr, wizard.log, and any temp file under /tmp/wizard-* returns 0 matches
```

### /healthz poll budget (FR-12, NFR poll budget)

```
Given the portal binary is installed
When healthz-poll runs
Then at most 5 GET requests to /healthz occur, separated by 2s
And the first 200 response with matching build_id terminates the loop early
And on poll exhaustion the phase fails with diagnostic body of the last response
```

### Build-id verification (FR-12)

```
Given a stale portal process running an older build
When healthz-poll runs
Then the response body's build_id does not match $(autonomous-dev portal --build-id)
And the phase rejects the response and continues polling
And on exhaustion the phase fails (does not silently accept stale binary)
```

### Idempotency: keep vs wipe (FR-14, FR-21 sub-A, sub-B)

```
Given ~/.autonomous-dev/portal.db exists
When the db-decision step runs
And the operator picks "keep"
Then the install step is skipped
And the account-create step is skipped
And the wizard-checkpoint.json records {"phase":11,"db_decision":"keep"}
And the verify-accounts step runs against existing accounts

Given ~/.autonomous-dev/portal.db exists
When the operator picks "wipe"
Then ~/.autonomous-dev/portal.db is unlinked
And install + account-create run fresh
```

### Idempotency: already-complete (FR-15)

```
Given /healthz responds 200 with current build_id
And the wizard probe account exists and authenticates
When the phase-11-probe idempotency check runs
Then it emits "already-complete"
And the orchestrator marks phases.11.status=complete with no body execution
```

### Mid-install resume (FR-21 sub-C)

```
Given phase 11 is killed during the install step (after cred_proxy_write_env)
When the wizard is re-run
Then the orchestrator emits WIZARD_RESUME_STEP=install
And the previously-written PORTAL_SESSION_SECRET in secrets.env is reused (not regenerated)
And the install step retries from the binary-install command
```

### Eval pass rate (FR-17–FR-22, NFR Eval pass rate)

```
Given the four eval cases run via the eval framework
When scoring is computed
Then per-case pass rate is ≥ 90%
And happy-path asserts: /healthz 200 within 10s, both logins ok:true, bind=127.0.0.1
And skip-with-consequence asserts verbatim consequence text + no portal.db
And error-recovery covers binary-missing, /healthz-never-responds, public-bind-refusal
And idempotency-resume covers keep, wipe, mid-install resume, already-complete
```

## 7. Test Requirements

**Eval cases** (under `evals/test-cases/setup-wizard/phase-11-portal-install/`):
- `happy-path.md` — see above.
- `skip-with-consequence.md` — see above.
- `error-recovery.md` — see above (three sub-cases).
- `idempotency-resume.md` — see above (four sub-cases).

**Unit (bats — `tests/setup-wizard/phase-11.bats`):**

| Test ID | Scenario                            | Assert                                                            |
|---------|-------------------------------------|-------------------------------------------------------------------|
| P11-101 | Front-matter parse                  | yq returns expected values for all 12 keys                        |
| P11-201 | Default-skip                        | predicate returns 0 unless opt-in flag set                        |
| P11-301 | Public-bind refusal                 | bind=0.0.0.0 without literal string aborts                        |
| P11-401 | Bcrypt cost                         | hash prefix matches `$2[ab]$12$`                                  |
| P11-501 | Plaintext password no-leak          | regex sweep across captured streams returns 0 hits                |
| P11-601 | Session secret no-leak              | secret appears only in secrets.env                                |
| P11-701 | /healthz poll budget                | ≤ 5 GETs at 2s separation                                         |
| P11-801 | Build-id mismatch rejection         | phase fails when build_id stale                                   |
| P11-901 | keep-vs-wipe                        | both branches reach correct downstream steps                      |
| P11-A01 | Mid-install resume                  | session secret reused; resume at install step                     |
| P11-B01 | Probe wizard account                | already-complete path validates without operator credential entry |

**Mocking:**
- A local fake portal HTTP server (Python or Node) that exposes `/healthz` and `/api/auth/login`. Build-id is set via env var so tests can simulate stale-binary mismatch.
- `htpasswd` and `autonomous-dev portal` are stubbed via shim binaries on PATH for headless eval.

## 8. Implementation Notes

- The default-skip predicate `portal_install_default_skip` reads `wizard.portal_install_opt_in` from the operator's config. Default is unset/false → predicate returns 0 (skip). Operators flip to `true` either via a phase-1 prompt (existing inline phase) or `wizard --phase 11 --opt-in`.
- The wizard probe account row is created with username `__wizard_probe__` and a random per-install password stored in `secrets.env` as `PORTAL_WIZARD_PROBE_PW`. Document this in the module's `Implementation Notes` section so operators know not to delete it.
- `htpasswd` may not be installed by default on macOS minimal setups. Fallback to `python3 -c "import bcrypt; print(bcrypt.hashpw(...))"` if `htpasswd` is absent. Document the fallback dependency.
- The 10s `/healthz` window is intentionally tight; on slow CI runners increase via env var `WIZARD_HEALTHZ_TIMEOUT_SECONDS`.
- Existing inline phase 9 already SIGHUPs the daemon; phase 11's SIGHUP is a second event. The daemon's hup-count test in eval frameworks tracks deltas, not absolute counts.
- The `--password-hash` flag on `autonomous-dev portal account create` is the only documented way to avoid plaintext passing through the wizard process. If TDD-014 changes the CLI surface, this SPEC must be updated.

## 9. Rollout Considerations

- Feature flag `wizard.phase_11_module_enabled` (default `true` per SPEC-033-1-03).
- Default skip means most operators are unaffected; the module is opt-in.
- Rollback path: `autonomous-dev wizard rollback --phase 11` (SPEC-033-4-05) reverts the six config keys, stops the portal daemon child, and **prompts before deleting `portal.db`** (data preservation default).
- Public-bind opt-in (`0.0.0.0`) is logged at WARN level so security review can audit.

## 10. Effort Estimate

| Activity                                      | Estimate |
|-----------------------------------------------|----------|
| Front-matter + module body                    | 0.75 day |
| Idempotency probe + probe-account wiring      | 0.25 day |
| Eval cases (4)                                | 0.5 day  |
| **Total**                                     | **1.5 day** |
