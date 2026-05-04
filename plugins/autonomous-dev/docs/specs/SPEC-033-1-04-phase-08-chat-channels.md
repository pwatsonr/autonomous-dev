# SPEC-033-1-04: Phase 08 Module — Chat Channels (Discord / Slack) + Eval Set

## Metadata
- **Parent Plan**: PLAN-033-1
- **Parent TDD**: TDD-033 §6.1
- **Tasks Covered**: PLAN-033-1 Task 6 (`phases/phase-08-chat-channels.md`), Task 8 (phase-08 eval set)
- **Estimated effort**: 1.5 days
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-02

## 1. Summary

Author the phase 08 module that onboards Discord and/or Slack chat
channels into autonomous-dev's intake layer. The module collects bot
tokens via stdin no-echo, validates them against the upstream APIs,
sends a probe message, writes env-var-name pointers to config (NEVER
the literal token), and SIGHUPs the daemon. Skip path requires
operator decline of both channels. Idempotency reuses still-valid
existing tokens.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                            | Task |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | A markdown file at `plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-08-chat-channels.md` MUST exist with a YAML front-matter block conforming to `_phase-contract.md` (SPEC-033-1-01). | T6   |
| FR-2  | The front-matter MUST set `phase: 8`, `title: "Chat channels (Discord/Slack)"`, `amendment_001_phase: 8`, `tdd_anchors: [TDD-008, TDD-011]`, `required_inputs.phases_complete: [1,2,3,4,5,6,7]`. | T6   |
| FR-3  | The front-matter MUST set `skip_predicate: "skip-predicates.sh is_cli_only_mode"` and `skip_consequence` to the verbatim text "You will only be able to submit requests via the CLI. Notifications will go to terminal only." | T6   |
| FR-4  | The front-matter MUST set `idempotency_probe: "idempotency-checks.sh phase-08-probe"` (a small wrapper documented in this SPEC; see §4 for body). | T6   |
| FR-5  | The front-matter MUST set `output_state.config_keys_written: ["intake.discord.enabled", "intake.discord.webhook_env", "intake.slack.enabled", "intake.slack.token_env", "intake.slack.channel_id"]`. | T6   |
| FR-6  | The module body MUST collect a boolean for each provider (Discord, Slack) and require **at least one** to be enabled OR an explicit operator skip. The phase MUST refuse to proceed with both disabled and no skip. | T6   |
| FR-7  | When Discord is enabled, the module MUST collect the bot token AND the webhook URL via `read -s` (no echo). | T6   |
| FR-8  | When Slack is enabled, the module MUST collect the bot token (must begin with `xoxb-`) AND the target channel ID. | T6   |
| FR-9  | The module MUST validate Discord credentials via `curl -s -H "Authorization: Bot $TOKEN" https://discord.com/api/v10/users/@me`, asserting HTTP 200 and JSON body `bot: true`. | T6   |
| FR-10 | The module MUST validate Slack credentials via `curl -s -H "Authorization: Bearer $TOKEN" https://slack.com/api/auth.test`, asserting JSON body `ok: true`. | T6   |
| FR-11 | The module MUST send a probe message ("autonomous-dev wizard verification") to each enabled channel and assert HTTP 200/204. | T6   |
| FR-12 | All credentials (Discord bot token, Discord webhook URL, Slack bot token) MUST be written to `secrets.env` via `cred_proxy_write_env` (SPEC-033-1-02). The wizard process MUST NOT echo any credential to stdout, stderr, or `wizard.log`. | T6   |
| FR-13 | Config keys MUST store env-var-name pointers (`intake.discord.webhook_env = "DISCORD_WEBHOOK_URL"`, `intake.slack.token_env = "SLACK_BOT_TOKEN"`) — NEVER the literal token. | T6   |
| FR-14 | The phase MUST issue exactly one SIGHUP to the daemon at the end of the verification step. | T6   |
| FR-15 | If a stored token's auth.test/users.@me probe returns 401, the wizard MUST emit "Your existing <provider> token failed validation; please re-enter" and prompt for re-entry rather than reusing the stored value. | T6   |
| FR-16 | An eval directory at `plugins/autonomous-dev-assist/evals/test-cases/setup-wizard/phase-08-chat-channels/` MUST contain four cases: `happy-path.md`, `skip-with-consequence.md`, `error-recovery.md`, `idempotency-resume.md`. | T8   |
| FR-17 | The `happy-path.md` case MUST assert all of: structured log lines per TDD-033 §10.5, exactly one SIGHUP, `intake.discord.enabled=true`, no token in transcripts (regex sweep). | T8   |
| FR-18 | The `skip-with-consequence.md` case MUST assert the verbatim consequence text from FR-3 appears in operator-facing output. | T8   |
| FR-19 | The `error-recovery.md` case MUST inject a 401 Discord token; assert the re-entry prompt from FR-15 appears; assert no partial config write. | T8   |
| FR-20 | The `idempotency-resume.md` case MUST kill the wizard mid-token-collection, re-run, and assert resume at the same step (no duplicate writes). | T8   |

## 3. Non-Functional Requirements

| Requirement                  | Target                                                                | Measurement Method                                                |
|------------------------------|-----------------------------------------------------------------------|-------------------------------------------------------------------|
| Eval pass rate               | ≥ 90% per TDD-033 §9.3 / AMENDMENT-002 AC-03                           | eval framework score over the four-case suite                     |
| Token leak (stdout)          | 0 occurrences of any captured credential in stdout                     | regex sweep of stdout transcript per case                         |
| Token leak (log)             | 0 occurrences of any captured credential in wizard.log                 | regex sweep of wizard.log per case                                |
| Webhook URL leak             | 0 occurrences of webhook URL outside `secrets.env`                     | regex sweep across stdout, stderr, wizard.log                     |
| Phase total runtime (happy)  | < 60s wall clock (excluding operator typing)                           | eval framework duration                                           |
| API call cap                 | ≤ 5 calls per provider per probe (TDD-033 §10.3)                       | curl invocation counter                                           |

## 4. Technical Approach

**File: `plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-08-chat-channels.md`**

```yaml
---
phase: 8
title: "Chat channels (Discord/Slack)"
amendment_001_phase: 8
tdd_anchors: [TDD-008, TDD-011]
prd_links: []
required_inputs:
  phases_complete: [1,2,3,4,5,6,7]
  config_keys: []
optional_inputs:
  existing_intake_config: true
skip_predicate: "skip-predicates.sh is_cli_only_mode"
skip_consequence: |
  You will only be able to submit requests via the CLI.
  Notifications will go to terminal only.
idempotency_probe: "idempotency-checks.sh phase-08-probe"
output_state:
  config_keys_written:
    - intake.discord.enabled
    - intake.discord.webhook_env
    - intake.slack.enabled
    - intake.slack.token_env
    - intake.slack.channel_id
  files_created: []
  external_resources_created: []
verification:
  - "Discord users.@me returns 200 with bot:true (if enabled)"
  - "Slack auth.test returns ok:true (if enabled)"
  - "Probe message delivered to each enabled channel"
  - "Daemon SIGHUP issued"
eval_set: "evals/test-cases/setup-wizard/phase-08-chat-channels/"
---
```

**Idempotency probe wrapper** (referenced by `idempotency-checks.sh phase-08-probe`):
```
1. If neither intake.discord.enabled nor intake.slack.enabled is true → emit start-fresh
2. For each enabled provider:
   - Read the env-var named in *_token_env / *_webhook_env from secrets.env
   - Call the provider's auth probe
   - If probe returns 200 → already-validated for that provider
3. If all enabled providers validate → emit already-complete
4. If at least one fails → emit resume-from:re-collect-failed-provider
```

**Module body (operator-facing prose) outline:**

| Step name             | Behavior                                                                                                                       |
|-----------------------|--------------------------------------------------------------------------------------------------------------------------------|
| `intro`               | Banner; explain that chat channels are optional; minimum-one-or-skip rule.                                                     |
| `collect-providers`   | `read` (yes/no) for Discord; `read` (yes/no) for Slack. If both no → prompt "skip phase entirely?" → if yes, mark skipped.     |
| `collect-discord`     | Only if Discord enabled. `read -s` token; `read -s` webhook URL. Trim whitespace.                                              |
| `collect-slack`       | Only if Slack enabled. `read -s` token (validate `xoxb-` prefix; reject + re-prompt up to 3 times); `read` channel id.         |
| `validate`            | curl probes per FR-9, FR-10. On 401 → re-entry per FR-15.                                                                       |
| `probe-message`       | Send "autonomous-dev wizard verification" to each enabled provider; assert 200/204.                                            |
| `write-secrets`       | `cred_proxy_write_env DISCORD_BOT_TOKEN "$disc_tok"`; `cred_proxy_write_env DISCORD_WEBHOOK_URL "$disc_hook"` (idem for Slack). |
| `write-config`        | Write env-var-name pointers + booleans + channel_id to `~/.autonomous-dev/config.json` via the orchestrator's config writer.   |
| `sighup`              | `kill -HUP $(cat ~/.autonomous-dev/daemon.pid)` (skip in headless eval; fixture flag).                                         |
| `verify`              | Poll daemon's intake-status endpoint (or read its log) confirming new adapters are loaded. Bounded ≤ 10s.                      |

Each step is named explicitly so the orchestrator's `WIZARD_RESUME_STEP` env var can jump to it.

**Token-handling discipline (NFR — Token leak):**
- `set +x` at top of every step that touches a credential variable.
- All `curl` calls use `-H "Authorization: Bot $TOK"` via env var, never on the command line: prefer `curl -H "@$tmp_header_file"`.
- All probe-validation `curl` invocations redirect both stdout and stderr to a temp file; the temp file's contents are inspected for `200`/`ok:true`/etc. and then deleted with `shred -u` (Linux) or `rm -P` (macOS).
- The bash variable holding the secret is `unset` after the `cred_proxy_write_env` call.

**Eval set files (FR-16–FR-20):**

`happy-path.md`:
- Operator enables Discord with valid token + webhook.
- Asserts: `auth.test`/`users.@me` probe 200, probe message delivered, `intake.discord.enabled=true` in config, `wizard.log` contains all expected step lines, regex `[A-Za-z0-9._-]{40,}` against transcripts returns 0 matches that are credential-shaped.
- Asserts: SIGHUP issued exactly once (process tree inspection or daemon log marker).

`skip-with-consequence.md`:
- Operator declines both providers AND confirms phase-skip.
- Asserts: verbatim consequence text appears; phases.08.status = "skipped"; no entries in `secrets.env` for chat tokens.

`error-recovery.md`:
- Inject Discord 401: probe responds 401 once, then 200 after re-entry.
- Asserts: re-entry prompt text matches FR-15; final state is "complete"; no partial write occurred during the failure window (no `intake.discord.enabled=true` while token is invalid).

`idempotency-resume.md`:
- Start phase, kill (`SIGTERM`) after `collect-discord` step but before `validate`.
- Re-run wizard.
- Asserts: orchestrator emits `WIZARD_RESUME_STEP=validate`; no duplicate token write to `secrets.env`; phase completes.

## 5. Interfaces and Dependencies

**Consumed:**
- SPEC-033-1-01: `lib/skip-predicates.sh::is_cli_only_mode`.
- SPEC-033-1-02: `lib/idempotency-checks.sh` (extended with `phase-08-probe` wrapper here).
- SPEC-033-1-02: `lib/cred-proxy-bridge.sh::cred_proxy_write_env`.
- SPEC-033-1-03: orchestrator state/log/snapshot infrastructure.
- TDD-008/TDD-011: Discord & Slack intake-adapter contracts (no API surface change here).

**Produced:**
- `phases/phase-08-chat-channels.md` (the module).
- 4 eval cases under `evals/test-cases/setup-wizard/phase-08-chat-channels/`.
- New entries in `idempotency-checks.sh` for the `phase-08-probe` wrapper (small extension; ≤ 30 LOC).

**External APIs (during eval, mocked; during real run, live):**
- `https://discord.com/api/v10/users/@me`
- `https://discord.com/api/v10/webhooks/{id}/{token}` (probe message)
- `https://slack.com/api/auth.test`
- `https://slack.com/api/chat.postMessage` (probe message)

## 6. Acceptance Criteria

### Front-matter contract (FR-1–FR-5)

```
Given phases/phase-08-chat-channels.md
When the front-matter is parsed by yq
Then phase=8, title="Chat channels (Discord/Slack)", amendment_001_phase=8
And tdd_anchors == ["TDD-008", "TDD-011"]
And required_inputs.phases_complete == [1,2,3,4,5,6,7]
And skip_predicate == "skip-predicates.sh is_cli_only_mode"
And skip_consequence (string-stripped) matches "You will only be able to submit requests via the CLI. Notifications will go to terminal only."
And output_state.config_keys_written == [
   "intake.discord.enabled","intake.discord.webhook_env",
   "intake.slack.enabled","intake.slack.token_env","intake.slack.channel_id"]
```

### Both-disabled refusal (FR-6)

```
Given the operator declines both Discord and Slack
When the wizard does NOT confirm phase-skip
Then the module body refuses to proceed
And re-prompts the operator with "At least one chat channel must be enabled, or the phase must be skipped"

Given the operator declines both AND confirms phase-skip
Then the orchestrator marks the phase as "skipped"
And the consequence text from FR-3 is emitted verbatim
```

### Token validation success (FR-9, FR-10)

```
Given a valid Discord bot token
When the module's validate step calls users.@me
Then the response is 200 with body containing "bot": true
And the step proceeds to probe-message

Given a valid Slack bot token starting with xoxb-
When the module's validate step calls auth.test
Then the response body contains "ok": true
```

### Token validation failure → re-entry (FR-15)

```
Given a stored Discord token that returns 401 from users.@me
When the idempotency probe runs
Then it emits "resume-from:re-collect-failed-provider"
And the orchestrator re-enters the phase at the collect-discord step
And the operator sees "Your existing Discord token failed validation; please re-enter"
And the prior token is left untouched in secrets.env until the new one validates
```

### Probe message (FR-11)

```
Given Discord is enabled with valid token + webhook
When the probe-message step runs
Then a POST to the webhook with body matching /autonomous-dev wizard verification/ is sent
And the HTTP response is 200 or 204
```

### Token-write discipline (FR-12, FR-13)

```
Given the operator enters Discord token "fake-but-valid-bot-token-XXXXXXX"
When the module completes
Then secrets.env contains the line "DISCORD_BOT_TOKEN=fake-but-valid-bot-token-XXXXXXX"
And config.json's intake.discord.webhook_env equals "DISCORD_WEBHOOK_URL" (not the URL itself)
And grep "fake-but-valid-bot-token-XXXXXXX" against ~/.autonomous-dev/logs/wizard.log returns 0 matches
And grep against the captured stdout returns 0 matches
```

### Single SIGHUP (FR-14)

```
Given the daemon PID is recorded
When the phase reaches the sighup step
Then exactly one SIGHUP signal is sent to that PID
And the daemon's hup-handler increments its hup-count by 1 (no double-fire)
```

### Eval set passes (FR-16–FR-20, NFR — Eval pass rate)

```
Given the four eval cases are run by the eval framework
When scoring is computed
Then the per-case pass rate is ≥ 90%
And happy-path asserts all three: SIGHUP, config keys present, no token leak
And skip-with-consequence asserts verbatim consequence text
And error-recovery asserts re-entry prompt + no partial write
And idempotency-resume asserts WIZARD_RESUME_STEP=validate after a kill mid-collect-discord
```

## 7. Test Requirements

**Eval cases (under `evals/test-cases/setup-wizard/phase-08-chat-channels/`):**
- `happy-path.md` — see above.
- `skip-with-consequence.md` — see above.
- `error-recovery.md` — see above.
- `idempotency-resume.md` — see above.

**Unit (bats — `tests/setup-wizard/phase-08.bats`):**

| Test ID | Scenario                          | Assert                                                        |
|---------|-----------------------------------|---------------------------------------------------------------|
| P8-101  | Front-matter parse                 | yq returns expected values for all 12 keys                    |
| P8-201  | Both-disabled refusal              | re-prompt fires; no config written                            |
| P8-301  | Discord 401 → re-entry             | re-entry prompt observed; no config write                     |
| P8-401  | Token-handling no-leak             | regex sweep across captured streams returns 0 hits            |
| P8-501  | Webhook leak                       | webhook URL appears in secrets.env only (regex sweep)         |
| P8-601  | SIGHUP single fire                 | hup-count delta == 1                                          |
| P8-701  | Resume mid-phase                   | WIZARD_RESUME_STEP set; phase completes; no duplicate writes  |

**Mocking:** Use a local HTTP server (e.g. `python3 -m http.server` with a small handler) to simulate Discord and Slack endpoints. Provide canned responses for 200 valid, 401 invalid, and 204 webhook delivery.

## 8. Implementation Notes

- The phase MUST NOT be entered if `is_cli_only_mode` predicate returns true; orchestrator already enforces this — the module body assumes it is being entered legitimately.
- Use `IFS= read -rs token` (note `r` and `s`) to avoid backslash interpretation and echo.
- After all secret-handling lines, `unset disc_tok disc_hook slack_tok` to scrub from process memory.
- The probe-message body should include a UUID in operator's local config so subsequent re-runs can identify their own probes (avoids duplicating notifications across runs).
- Discord webhook URL is itself secret; treat it identically to a token for leak purposes (FR-12 already covers this).

## 9. Rollout Considerations

- Feature flag `wizard.phase_08_module_enabled` (default `true`, set in SPEC-033-1-03).
- No external resources are created; no rollback path beyond reverting config keys via `wizard rollback --phase 08` (SPEC-033-4-05).

## 10. Effort Estimate

| Activity                                      | Estimate |
|-----------------------------------------------|----------|
| Front-matter + module body                    | 0.75 day |
| Idempotency probe wrapper                     | 0.25 day |
| Eval cases (4)                                | 0.5 day  |
| **Total**                                     | **1.5 day** |
