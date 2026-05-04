# SPEC-033-2-04: Phase 13 Module — Request Types Catalog + Hook Registration + Dry-Run Probe

## Metadata
- **Parent Plan**: PLAN-033-2
- **Parent TDD**: TDD-033 §6.4
- **Parent PRD**: AMENDMENT-002 §4.4
- **Tasks Covered**: PLAN-033-2 Task 4
- **Estimated effort**: 1 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-02

## 1. Summary

Author the phase 13 module that configures the request-type catalog
(default/hotfix/exploration/refactor) and registers operator-supplied
extension hooks via the TDD-019 `autonomous-dev hooks add` CLI. The
catalog is read data-driven from
`plugins/autonomous-dev/config/request-types.json` so new bundled
types are picked up without re-authoring the phase. Verification is
via `autonomous-dev request submit --type hotfix --dry-run` which
**MUST NOT** create real work, MUST NOT emit notifications, and MUST
observe `request_type=hotfix` in the first state-machine transition.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                            | Task |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | A markdown file at `plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-13-request-types.md` MUST exist with valid front-matter per `_phase-contract.md`. | T4   |
| FR-2  | Front-matter MUST set `phase: 13`, `title: "Request types + extension hooks"`, `amendment_001_phase: 13`, `tdd_anchors: [TDD-018, TDD-019]`, `required_inputs.phases_complete: [1,2,3,4,5,6,7]`, `required_inputs.config_keys: ["governance.per_request_cost_cap_usd"]`. | T4   |
| FR-3  | Front-matter MUST set `skip_predicate: "skip-predicates.sh phase_13_skip_predicate"` where the wrapper exits 0 (skip) only when the operator has explicitly set `wizard.skip_phase_13=true` (default: false → run). | T4   |
| FR-4  | `skip_consequence` MUST contain the verbatim text "Only the default request type is active; hotfix/exploration/refactor are unavailable until you run `wizard --phase 13`." | T4   |
| FR-5  | Front-matter MUST set `idempotency_probe: "idempotency-checks.sh phase-13-probe"` (wrapper documented in §4). | T4   |
| FR-6  | Front-matter MUST set `output_state.config_keys_written: ["request_types.<type>.enabled", "request_types.<type>.cost_cap_usd", "request_types.<type>.trust_threshold", "request_types.<type>.default_reviewers", "hooks.<hook_point>.<handler_id>"]` (templated for each type and registered hook). | T4   |
| FR-7  | The module MUST read the catalog from `plugins/autonomous-dev/config/request-types.json` at run time. The file is expected to be a JSON array of `{id, default_cost_cap_usd, default_trust_threshold, default_reviewers, description}`. The phase MUST iterate every entry and prompt the operator (enable y/N + per-field overrides). | T4   |
| FR-8  | Per-type cost-cap default MUST be `governance.per_request_cost_cap_usd` from operator config (TDD-033 §6.4 requirement: cost cap inherits from governance). The operator may override per type. | T4   |
| FR-9  | Per-type trust-threshold and default-reviewers MUST default to the catalog entry's `default_*` values; operator may override. | T4   |
| FR-10 | The module MUST offer custom-extension-hook registration. The flow: prompt "register a custom hook? [y/N]"; on y, collect `hook_point` (one of TDD-019's documented hook points: `code-pre-write`, `code-post-write`, `pr-pre-create`, etc.), `handler_path` (absolute path or repo-relative), and `handler_id` (free-form name). | T4   |
| FR-11 | Before invoking `autonomous-dev hooks add`, the module MUST display the full absolute path of `handler_path` AND the first 200 bytes of the handler script's contents to the operator, requiring an explicit "yes" string before adding to the allowlist (per PLAN-033-2 risk row "phase 13 hook-handler-path allowlist confirmation"). | T4   |
| FR-12 | The module MUST invoke `autonomous-dev hooks add --hook-point <point> --handler-path <path> --handler-id <id>` (per TDD-019 CLI contract). On exit 0 → record in config; on non-zero exit → surface stderr to operator, offer re-entry up to 3 times. | T4   |
| FR-13 | Hook registration MUST be idempotent against `(hook_point, handler_path)` collision: if the CLI returns "already registered with same handler_path", the module MUST treat as success and continue. If `(hook_point, handler_path)` collides with a different `handler_id`, the module MUST prompt update-or-skip. | T4   |
| FR-14 | The module MUST invoke a verification dry-run: `autonomous-dev request submit --type <first-non-default-enabled> --dry-run --observe-first-transition`. The probe MUST observe a state-machine emission containing `request_type=<that-type>`. | T4   |
| FR-15 | The dry-run probe MUST NOT write any entry to the daemon's request store, MUST NOT emit any chat/email notifications, and MUST NOT trigger any reviewer chain. (TDD-033 §6.4 idempotency clause.) Asserted via fs-snapshot diff + chat-channel mock recording 0 messages. | T4   |
| FR-16 | At phase end, the module MUST issue exactly one SIGHUP to the daemon to pick up new types and hooks. | T4   |
| FR-17 | If no non-default type is enabled (operator says no to all of hotfix/exploration/refactor), the dry-run probe step MUST be skipped (no first-non-default-enabled to probe with) and the verification step MUST instead assert that the default request type catalog entry remains usable via `autonomous-dev request types list` returning ≥ 1 entry. | T4   |
| FR-18 | The skip-with-consequence path (FR-3, FR-4) MUST mark phase status="skipped" and write no `request_types.*` or `hooks.*` config keys. | T4   |

## 3. Non-Functional Requirements

| Requirement                       | Target                                                                  | Measurement Method                                                |
|-----------------------------------|-------------------------------------------------------------------------|-------------------------------------------------------------------|
| Eval pass rate                    | ≥ 90% per TDD-033 §9.3 / AMENDMENT-002 AC-03                             | covered in SPEC-033-2-05                                           |
| Dry-run isolation: store writes   | 0 entries appended to daemon request store during dry-run                | fs-snapshot diff of daemon DB before/after probe                  |
| Dry-run isolation: notifications  | 0 messages to chat-channel mock during dry-run                           | mock chat-server message count                                    |
| Catalog data-drivenness           | Adding a new entry to request-types.json adds a new prompt without phase re-author | bats test injects a synthetic catalog row             |
| Hook idempotency                  | Re-registering same `(hook_point, handler_path)` is a no-op              | bats test asserts hooks-registry size unchanged                   |
| Phase total runtime (happy)       | < 60 s wall clock                                                        | eval framework duration                                            |
| Allowlist prompt: literal "yes"   | Any input other than "yes" rejects the handler add                       | bats test                                                          |

## 4. Technical Approach

**File: `plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-13-request-types.md`**

```yaml
---
phase: 13
title: "Request types + extension hooks"
amendment_001_phase: 13
tdd_anchors: [TDD-018, TDD-019]
prd_links: []
required_inputs:
  phases_complete: [1,2,3,4,5,6,7]
  config_keys:
    - governance.per_request_cost_cap_usd
optional_inputs:
  existing_request_types: true
  existing_hooks: true
skip_predicate: "skip-predicates.sh phase_13_skip_predicate"
skip_consequence: |
  Only the default request type is active; hotfix/exploration/refactor are unavailable until you run `wizard --phase 13`.
idempotency_probe: "idempotency-checks.sh phase-13-probe"
output_state:
  config_keys_written:
    - "request_types.<type>.enabled"
    - "request_types.<type>.cost_cap_usd"
    - "request_types.<type>.trust_threshold"
    - "request_types.<type>.default_reviewers"
    - "hooks.<hook_point>.<handler_id>"
  files_created: []
  external_resources_created: []
verification:
  - "request_types.<each-enabled>.enabled=true in config"
  - "autonomous-dev request types list returns the configured set"
  - "If any custom hook registered: autonomous-dev hooks list returns it"
  - "Dry-run submit observes request_type=<type> in first state transition"
  - "Daemon SIGHUP issued"
eval_set: "evals/test-cases/setup-wizard/phase-13-request-types/"
---
```

**Idempotency probe wrapper** (`idempotency-checks.sh phase-13-probe`):
```
1. Read existing request_types.* keys from config
2. Read catalog from request-types.json
3. For each catalog entry:
   - If enabled=true in config AND has matching cost_cap/trust_threshold/default_reviewers
     → mark "configured"
   - Else mark "needs-config"
4. If all catalog entries are either explicitly disabled (enabled=false) or fully configured → already-types-complete
5. Read hooks.* keys; if catalog of registered hooks matches stored config → already-hooks-complete
6. If both → already-complete; else emit resume-from:<earliest-step>
```

**Module body steps:**

| Step name             | Behavior                                                                                                                                |
|-----------------------|-----------------------------------------------------------------------------------------------------------------------------------------|
| `intro`               | Banner; phase enables non-default request types and lets operator register custom hooks.                                                |
| `read-catalog`        | Load `request-types.json`; abort with diagnostic if file missing or malformed.                                                          |
| `per-type-prompt`     | For each catalog entry: y/N enable; on y, prompt cost_cap (default = governance), trust_threshold (default = catalog), default_reviewers (default = catalog). |
| `prompt-custom-hook`  | "Register a custom extension hook? [y/N]". On y → enter `hook-add-loop`; on N → skip to `verify`.                                       |
| `hook-add-loop`       | Prompt hook_point (validated against TDD-019 documented points), handler_path (absolute or repo-relative; resolved to absolute), handler_id. Display path + first 200 bytes; require literal "yes". On confirm → invoke `autonomous-dev hooks add`. Loop "register another? [y/N]". |
| `dry-run-probe`       | Pick first non-default enabled type; if none → skip step. Else: run `autonomous-dev request submit --type <t> --dry-run --observe-first-transition`. Capture stdout JSON; assert `request_type==<t>`. |
| `verify-no-side-effects` | fs-snapshot diff of daemon request store; chat-mock message count == 0; reviewer-chain dispatch count == 0.                          |
| `write-config`        | Write request_types.* and hooks.* keys per FR-6.                                                                                         |
| `sighup`              | `kill -HUP $(cat ~/.autonomous-dev/daemon.pid)`. Skip in headless eval (fixture flag).                                                  |
| `summary`             | Emit verification line per TDD-033 §10.5.                                                                                                |

**Allowlist confirmation prompt (FR-11):**
```
================================================================
About to register a custom extension hook:

  hook_point:    code-pre-write
  handler_id:    my-org-policy-check
  handler_path:  /home/op/repos/policy/check.sh

First 200 bytes of /home/op/repos/policy/check.sh:
  #!/usr/bin/env bash
  # check.sh — enforce my-org policy on code writes
  set -euo pipefail
  ...

This handler will run with daemon-process privileges on every
code-pre-write event. To confirm, type the literal string "yes":
  >
================================================================
```

Any non-literal "yes" input → reject + re-prompt up to 3 times → abort hook add.

**Dry-run probe contract (FR-14, FR-15):**

The probe relies on `autonomous-dev request submit --dry-run --observe-first-transition` (TDD-018 CLI surface). Expected stdout shape (JSON):
```json
{
  "dry_run": true,
  "request_id": "<deterministic-fake-id>",
  "request_type": "hotfix",
  "first_state_transition": {
    "from": "init",
    "to": "triaged",
    "request_type": "hotfix"
  },
  "side_effects": {
    "store_writes": 0,
    "notifications_sent": 0,
    "reviewer_chain_dispatches": 0
  }
}
```

The verify-no-side-effects step parses `side_effects` AND independently verifies via fs-snapshot + chat-mock + chain-mock counters (defense in depth: don't trust the daemon's self-reported counts).

## 5. Interfaces and Dependencies

**Consumed:**
- SPEC-033-1-01 / SPEC-033-1-02: helper libraries.
- SPEC-033-1-03: orchestrator, feature flag, log/state infrastructure.
- TDD-018: `request-types.json` schema, `autonomous-dev request types list`, `autonomous-dev request submit --type ... --dry-run --observe-first-transition`.
- TDD-019: `autonomous-dev hooks add/list` CLI, hook-point allowlist, handler-path trust validation.
- `plugins/autonomous-dev/config/request-types.json` — catalog file (assumed to exist; phase 13 fails with diagnostic if missing).

**Produced:**
- `phases/phase-13-request-types.md`.
- `phase_13_skip_predicate` helper (≤ 10 LOC).
- `phase-13-probe` idempotency wrapper (≤ 50 LOC).

## 6. Acceptance Criteria

### Front-matter contract (FR-1, FR-2)

```
Given phases/phase-13-request-types.md
When parsed by yq
Then phase=13, tdd_anchors == ["TDD-018","TDD-019"]
And required_inputs.config_keys == ["governance.per_request_cost_cap_usd"]
And output_state.config_keys_written templates use "<type>" and "<hook_point>" / "<handler_id>" placeholders
```

### Default skip flag respects opt-out (FR-3, FR-18)

```
Given wizard.skip_phase_13 is unset or false
When phase 13 enters
Then phase_13_skip_predicate exits 1 (run)

Given wizard.skip_phase_13 == true
When phase 13 enters
Then phase_13_skip_predicate exits 0 (skip)
And the verbatim FR-4 consequence text is emitted
And phases.13.status == "skipped"
And no request_types.* or hooks.* keys are written
```

### Catalog enumeration is data-driven (FR-7, NFR data-drivenness)

```
Given request-types.json contains entries [hotfix, exploration, refactor, bespoke-emergency]
When the per-type-prompt step runs
Then the operator is prompted for each of the four entries in catalog order
And no entry is hard-coded in the phase module body

Given a synthetic catalog with a new entry "experimental-fast-path"
When phase 13 runs against it
Then the operator is prompted for "experimental-fast-path"
And the phase module file is unchanged
```

### Cost cap inherits governance default (FR-8)

```
Given governance.per_request_cost_cap_usd == 5
And the operator enables hotfix without entering a cost-cap override
When write-config runs
Then request_types.hotfix.cost_cap_usd == 5
```

### Allowlist confirmation requires literal "yes" (FR-11, NFR allowlist literal)

```
Given the operator is in the hook-add-loop with handler_path resolved
When the confirmation prompt asks for "yes"
And the operator types "y" or "Y" or "" or "ya"
Then the input is rejected and the prompt repeats (≤ 3 times)
And on exhaustion the hook add is aborted

Given the operator types exactly "yes"
Then `autonomous-dev hooks add` is invoked
```

### Hook registration idempotency (FR-13, NFR hook idempotency)

```
Given hooks.code-pre-write.my-org-policy-check is already registered with the same handler_path
When phase 13 re-runs and the operator re-registers the same hook
Then the CLI returns "already registered with same handler_path"
And the phase treats it as success
And hooks-registry size is unchanged

Given the same (hook_point, handler_path) is collided by a different handler_id
Then the operator is prompted update-or-skip
```

### Dry-run probe isolation (FR-14, FR-15, NFR dry-run isolation)

```
Given hotfix is enabled
When dry-run-probe runs
Then `autonomous-dev request submit --type hotfix --dry-run --observe-first-transition` is invoked
And stdout JSON contains "first_state_transition.request_type": "hotfix"
And fs-snapshot diff of the daemon request store shows 0 new entries
And the chat-channel mock recorded 0 messages
And the reviewer-chain mock recorded 0 dispatches
```

### No non-default enabled → skip probe (FR-17)

```
Given operator says No to hotfix, exploration, AND refactor
When dry-run-probe step is reached
Then the step is skipped (no submit invocation)
And the verify step instead asserts `autonomous-dev request types list` returns ≥1 entry (the default)
```

### Single SIGHUP at end (FR-16)

```
Given the phase reaches the sighup step
Then exactly one SIGHUP is sent to the daemon PID
And the daemon's hup-counter increments by 1
```

### Idempotency: full re-run is no-op (probe → already-complete)

```
Given all catalog entries are configured AND every registered hook matches stored config
When phase-13-probe runs
Then it emits "already-complete"
And the module body is not executed (orchestrator marks phases.13.status=complete)
```

## 7. Test Requirements

**Eval cases**: owned by SPEC-033-2-05.

**bats — `tests/setup-wizard/phase-13.bats`:**

| Test ID  | Scenario                              | Assert                                                  |
|----------|---------------------------------------|---------------------------------------------------------|
| P13-101  | Front-matter parse                     | yq returns expected values                              |
| P13-201  | Skip via flag                          | predicate true; consequence emitted; no writes          |
| P13-301  | Catalog data-drivenness                 | synthetic catalog row produces a prompt                 |
| P13-401  | Cost cap inherits governance default   | request_types.<type>.cost_cap_usd == governance value   |
| P13-501  | Allowlist requires literal "yes"        | non-literal inputs rejected; "yes" accepted             |
| P13-601  | Hook registration idempotent            | re-add same (point, path) is no-op; size unchanged      |
| P13-602  | Hook collision update-or-skip           | different handler_id same (point, path) prompts         |
| P13-701  | Dry-run probe: store writes 0           | fs-snapshot diff empty                                  |
| P13-702  | Dry-run probe: notifications 0          | chat-mock count == 0                                    |
| P13-703  | Dry-run probe: chain dispatches 0       | chain-mock count == 0                                   |
| P13-704  | Dry-run probe: request_type observed    | JSON parse passes assertion                             |
| P13-801  | No non-default enabled → probe skipped  | dry-run-probe not invoked; verify uses types-list       |
| P13-901  | Single SIGHUP                           | hup-count delta == 1                                    |
| P13-A01  | Already-complete probe                  | full-state probe emits already-complete                 |

**Mocking:**
- A daemon stub that exposes the `--dry-run --observe-first-transition` JSON output deterministically.
- A chat-channel mock with a message counter (re-uses phase 8's mock infrastructure from SPEC-033-1-04).
- A reviewer-chain mock with a dispatch counter.
- A synthetic `request-types.json` fixture for catalog-drivenness testing.

## 8. Implementation Notes

- Hook-handler-path validation: if TDD-019's `autonomous-dev hooks add` already enforces handler-path allowlist (PLAN-019-3 trust-validator), then the literal "yes" prompt in FR-11 is defense-in-depth (we confirm BEFORE invoking the CLI). If TDD-019 does not enforce, the wizard's prompt is the sole gate; this SPEC's contract is that the prompt MUST exist regardless.
- The `--observe-first-transition` flag may not yet exist in TDD-018; if not, fall back to `--dry-run --json` and inspect the response's state-machine init entry. Document the dependency in the phase module's Implementation Notes.
- Per-type `default_reviewers` is a list; collect via comma-separated input and split on commas, trimming whitespace per entry.
- The catalog file path is `plugins/autonomous-dev/config/request-types.json` relative to the install root. Document that operator-shipped overrides at `<repo>/.autonomous-dev/request-types-override.json` are honored if present (TDD-018 layered-config behavior).
- `request_types.<type>.default_reviewers` is written as a JSON array, not a CSV string; avoid round-trip ambiguity.

## 9. Rollout Considerations

- Feature flag `wizard.phase_13_module_enabled` (default `true`; ships in SPEC-033-2-05). Stage 2 rollout per TDD-033 §8.2.
- Rollback: `autonomous-dev wizard rollback --phase 13` (SPEC-033-4-05) deletes the `request_types.*` and `hooks.*` config keys created by this phase. Note: the underlying hook handler scripts on disk are NOT deleted (operator-owned files); rollback only removes the registration entries.

## 10. Effort Estimate

| Activity                                      | Estimate |
|-----------------------------------------------|----------|
| Front-matter + module body                    | 0.5 day  |
| Idempotency wrapper + skip wrapper            | 0.25 day |
| Unit tests (bats)                             | 0.25 day |
| **Total**                                     | **1 day** |
