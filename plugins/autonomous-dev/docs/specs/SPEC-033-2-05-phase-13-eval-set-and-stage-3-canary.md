# SPEC-033-2-05: Phase 13 Eval Set + Feature Flag Defaults + Stage 3 Canary Doc

## Metadata
- **Parent Plan**: PLAN-033-2
- **Parent TDD**: TDD-033 §8.2, §9.1
- **Parent PRD**: AMENDMENT-002 AC-03
- **Tasks Covered**: PLAN-033-2 Tasks 5, 6, 7
- **Estimated effort**: 1.5 days
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-02

## 1. Summary

Author the phase-13 eval set (four cases per TDD-033 §9.1), add the
phase 12 / phase 13 feature-flag defaults to `config_defaults.json`,
and create `STAGE-3-CANARY.md` documenting the rollout gate for the
sensitive phase 12 module: opt-in beta operators, ≥ 5 successful
probe-PR completions, ≥ 95% eval pass, zero token leaks.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                            | Task |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | An eval directory at `plugins/autonomous-dev-assist/evals/test-cases/setup-wizard/phase-13-request-types/` MUST contain four case files: `happy-path.md`, `skip-with-consequence.md`, `error-recovery.md`, `idempotency-resume.md`. | T5   |
| FR-2  | Each eval case MUST conform to the case schema (front-matter: phase, case_type, expected_outcome, fixtures, assertions). | T5   |
| FR-3  | `happy-path.md` MUST: enable hotfix + exploration (cost caps overridden to 10 USD each); register a custom hook at `code-pre-write` with handler `tests/fixtures/setup-wizard/handlers/policy-check.sh`; run dry-run probe; assert first state transition `request_type=hotfix` (or `exploration` whichever is first-non-default-enabled); assert daemon SIGHUP; assert state file written. | T5   |
| FR-4  | `skip-with-consequence.md` MUST set `wizard.skip_phase_13=true` and assert: verbatim consequence text emitted; phases.13.status="skipped"; no `request_types.*` or `hooks.*` config keys written; daemon receives 0 SIGHUPs from this phase. | T5   |
| FR-5  | `error-recovery.md` MUST cover three sub-cases: (a) handler script not executable (chmod 644) → `autonomous-dev hooks add` returns non-zero → wizard surfaces error and offers re-entry; (b) handler at non-allowlisted path → wizard prompts to add to allowlist with confirmation OR exits with diagnostic; (c) catalog file `request-types.json` missing → phase exits with diagnostic + pointer to `/autonomous-dev-assist:troubleshoot`. | T5   |
| FR-6  | `idempotency-resume.md` MUST cover: (a) phase started, killed after enabling hotfix but before exploration prompt → re-run resumes at exploration prompt with hotfix already enabled; (b) hook already registered with same `(hook_point, handler_path)` → re-add is no-op; (c) full re-run against complete state → `phase-13-probe` emits `already-complete`; module body not entered. | T5   |
| FR-7  | The four-case suite MUST achieve ≥ 90% pass rate per TDD-033 §9.3 / AMENDMENT-002 AC-03. | T5   |
| FR-8  | The dry-run isolation invariant (NFR from SPEC-033-2-04) MUST be asserted in `happy-path.md`: fs-snapshot diff of daemon request store empty; chat-channel mock 0 messages; reviewer-chain mock 0 dispatches. | T5   |
| FR-9  | `plugins/autonomous-dev-assist/config_defaults.json` MUST contain `wizard.phase_12_module_enabled: true` and `wizard.phase_13_module_enabled: true`. | T6   |
| FR-10 | Toggling either flag to `false` in operator config MUST cause the orchestrator to emit "Phase NN unavailable; will be re-enabled in next release" and continue (per FR-4 of SPEC-033-1-03). The defaults file change MUST NOT regress this behavior. | T6   |
| FR-11 | A new file `plugins/autonomous-dev-assist/skills/setup-wizard/STAGE-3-CANARY.md` MUST exist documenting the Stage 3 rollout gate per TDD-033 §8.2. | T7   |
| FR-12 | `STAGE-3-CANARY.md` MUST list the gate criteria: (a) `AUTONOMOUS_DEV_WIZARD_BETA=1` env-gate active for opt-in operators during canary; (b) ≥ 5 distinct operators successfully complete the phase 12 probe-PR step; (c) ≥ 95% eval pass on the phase-12 five-case suite over the canary window; (d) zero token leaks (`ghp_*` regex sweep) across all canary transcripts; (e) zero stale probe branches left on origin after canary. | T7   |
| FR-13 | `STAGE-3-CANARY.md` MUST document the canary procedure: how to flip the env gate, how to collect transcripts, how to verify the gate criteria, and the explicit "Stage 3 → Stage 4" promotion checklist. | T7   |
| FR-14 | `STAGE-3-CANARY.md` MUST extend (not duplicate) the existing rollout-stage doc references; if a sibling `STAGE-1-CANARY.md` or `STAGE-2-CANARY.md` exists from PLAN-033-1, the new doc cross-links to them. | T7   |

## 3. Non-Functional Requirements

| Requirement                       | Target                                                                  | Measurement Method                                                |
|-----------------------------------|-------------------------------------------------------------------------|-------------------------------------------------------------------|
| Suite pass rate                   | ≥ 90% per TDD-033 §9.3                                                   | eval framework score                                              |
| Suite runtime (CI)                | < 4 minutes wall clock                                                   | CI duration metric                                                |
| Eval determinism                  | 0 flakes across 10 consecutive runs                                      | nightly flake-detection job                                       |
| Canary gate checkability          | Each STAGE-3 criterion is mechanically verifiable                        | manual + scripted check enumerated in the doc                     |
| Default flag behavior             | Flipping a flag to false produces "unavailable" message; does NOT crash  | bats test                                                         |

## 4. Technical Approach

**Files created/modified:**

- Create: `plugins/autonomous-dev-assist/evals/test-cases/setup-wizard/phase-13-request-types/{happy-path,skip-with-consequence,error-recovery,idempotency-resume}.md`.
- Modify: `plugins/autonomous-dev-assist/config_defaults.json` (add the two flags).
- Create: `plugins/autonomous-dev-assist/skills/setup-wizard/STAGE-3-CANARY.md`.
- Create fixtures: `tests/fixtures/setup-wizard/handlers/policy-check.sh` (executable example handler), `tests/fixtures/setup-wizard/handlers/policy-check-non-exec.sh` (chmod 644 for error case), `tests/fixtures/setup-wizard/catalogs/synthetic-request-types.json`.

**`happy-path.md` outline:**

```markdown
---
phase: 13
case_type: happy-path
expected_outcome: complete
fixture_repo: tests/fixtures/setup-wizard/repos/local-only
fixture_catalog: plugins/autonomous-dev/config/request-types.json
fixture_handler: tests/fixtures/setup-wizard/handlers/policy-check.sh
governance_per_request_cost_cap_usd: 8
assertions:
  - id: A-1
    description: hotfix enabled with cost cap 10
    type: config-equals
    key: request_types.hotfix.cost_cap_usd
    expected: 10
  - id: A-2
    description: exploration enabled with cost cap 10
    type: config-equals
    key: request_types.exploration.cost_cap_usd
    expected: 10
  - id: A-3
    description: hook registered
    type: config-key-exists
    key: hooks.code-pre-write.policy-check
  - id: A-4
    description: dry-run first transition observed
    type: regex-match
    target: stdout
    pattern: '"first_state_transition"\s*:\s*\{[^}]*"request_type"\s*:\s*"hotfix"'
  - id: A-5
    description: store-writes 0
    type: scanner-count
    target: daemon-store-snapshot-diff
    expected: 0
  - id: A-6
    description: chat-mock messages 0
    type: scanner-count
    target: chat-mock-counter
    expected: 0
  - id: A-7
    description: chain dispatches 0
    type: scanner-count
    target: chain-mock-counter
    expected: 0
  - id: A-8
    description: SIGHUP delta 1
    type: counter-delta
    target: daemon-hup-counter
    expected: 1
  - id: A-9
    description: state file complete
    type: state-equals
    key: phases.13.status
    expected: complete
---

# Setup
- Operator config: governance.per_request_cost_cap_usd=8
- Operator inputs: hotfix=y (cost-cap=10), exploration=y (cost-cap=10), refactor=N, custom-hook=y (point=code-pre-write, path=<fixture-handler>, id=policy-check, confirmation="yes")

# Run
- `autonomous-dev wizard --phase 13` against the fixture

# Expected
- All 9 assertions pass.
```

**`skip-with-consequence.md` outline:**

- Operator config: `wizard.skip_phase_13=true`.
- Assertions:
  - A-1: stdout contains verbatim consequence text from SPEC-033-2-04 FR-4.
  - A-2: phases.13.status == "skipped".
  - A-3: no request_types.* or hooks.* config keys written.
  - A-4: daemon-hup-counter delta == 0.

**`error-recovery.md` outline:** three sub-cases.

Sub-case A (non-executable handler):
- Fixture: `policy-check-non-exec.sh` (chmod 644).
- Operator confirms "yes" at the allowlist prompt.
- `autonomous-dev hooks add` returns non-zero with stderr "handler not executable".
- Assertions: stderr surfaced; re-entry prompt offered; on operator decline, phase exits status=failed; no `hooks.*` keys written.

Sub-case B (non-allowlisted path):
- Fixture: handler at `/tmp/random-script.sh` (not in any standard allowlist).
- Wizard prompts to add to allowlist; operator types "yes"; CLI invocation succeeds.
- Assertion: hook registered.

Sub-case C (catalog file missing):
- Fixture: rename `request-types.json` to `request-types.json.bak`.
- Phase exits at `read-catalog` step with diagnostic referencing `/autonomous-dev-assist:troubleshoot`.
- Assertion: phases.13.status == "failed"; no per-type prompts shown.

**`idempotency-resume.md` outline:** three sub-cases.

Sub-case A (kill-mid-prompt resume):
- Run wizard --phase 13; SIGTERM after operator enables hotfix but before exploration prompt.
- Wizard-checkpoint records phases.13.in_progress with current step.
- Re-run; assert orchestrator emits resume marker; hotfix already enabled (not re-prompted); exploration prompt shown.

Sub-case B (hook re-add no-op):
- Fixture: hook already in config + registered with daemon.
- Operator chooses to add same hook.
- `autonomous-dev hooks add` returns "already registered with same handler_path".
- Assertions: hooks-registry size unchanged; phase continues; no error.

Sub-case C (already-complete):
- Fixture: full configuration already in place from a prior run.
- `phase-13-probe` emits "already-complete".
- Assertions: orchestrator marks phases.13.status=complete; module body not entered (no per-type prompts shown in transcript).

**Feature-flag defaults (`config_defaults.json` modification):**

```json
{
  "wizard": {
    "phase_08_module_enabled": true,
    "phase_11_module_enabled": true,
    "phase_12_module_enabled": true,
    "phase_13_module_enabled": true,
    ...
  }
}
```

(The first two flags ship in SPEC-033-1-03; SPEC-033-3-04 / SPEC-033-4-05 add later phases.)

**`STAGE-3-CANARY.md` outline:**

```markdown
# Stage 3 Canary — Phase 12 (CI Workflows + Branch Protection + PAT)

## Why this phase needs a canary
Phase 12 is the first wizard phase to handle a GitHub PAT, write into the
operator's repo (workflow files), modify GitHub repo configuration (secrets,
branch protection), and create + clean up a probe PR. Any of:
  - PAT leak in transcripts
  - Stale probe branches on origin
  - Branch protection misconfiguration
... is a critical operator-impacting failure. Stage 3 (TDD-033 §8.2) gates
broad rollout behind opt-in beta operators.

## Canary procedure
1. Operators flip env gate: `export AUTONOMOUS_DEV_WIZARD_BETA=1` then run
   `autonomous-dev wizard --phase 12`.
2. Operators report transcripts via `autonomous-dev wizard upload-transcript`
   (writes to a known canary collection bucket; PII-stripped per TDD-033 §9.4).
3. The release captain runs the gate-criteria checks weekly during canary.

## Stage 3 → Stage 4 promotion gate
- [ ] ≥ 5 distinct operators have successfully completed phase 12's probe-PR step.
- [ ] ≥ 95% eval pass rate across the phase-12 five-case suite over the canary window.
- [ ] Zero token leaks (`ghp_[A-Za-z0-9]{36}` and `github_pat_[A-Za-z0-9_]{82}`) across all collected transcripts.
- [ ] Zero stale probe branches (`autonomous-dev-wizard-probe-*`) remaining on any operator's origin after their wizard run completed.
- [ ] At least one operator on a GitHub Enterprise (GHES) origin has been observed receiving the FR-22 GHES-detected diagnostic without crash.

## Cross-references
- See [SPEC-033-1-03] for orchestrator feature-flag mechanics.
- See [SPEC-033-2-02] for phase 12 module surfaces.
- See [SPEC-033-2-03] for the phase-12 eval suite that this gate measures.
- TDD-033 §8.2 — overall rollout staging.
- AMENDMENT-002 AC-03, AC-05, AC-08 — acceptance criteria this canary protects.
```

## 5. Interfaces and Dependencies

**Consumed:**
- SPEC-033-2-04: `phases/phase-13-request-types.md` (rendered for evals).
- SPEC-033-2-02: phase 12 module (referenced by canary doc; not modified).
- SPEC-033-2-03: phase 12 eval suite (referenced by canary doc).
- SPEC-033-1-03: orchestrator feature-flag mechanics.
- TDD-033 §8.2: rollout staging.

**Produced:**
- Four eval case files for phase 13.
- Two-flag addition to `config_defaults.json`.
- `STAGE-3-CANARY.md`.
- Fixture handler scripts + synthetic catalog.

## 6. Acceptance Criteria

### Four eval files exist + schema-conformant (FR-1, FR-2)

```
Given the eval directory plugins/autonomous-dev-assist/evals/test-cases/setup-wizard/phase-13-request-types/
When ls is run
Then exactly four .md files are present

Given any of the four files
When parsed by the eval-case schema validator
Then validation succeeds
```

### Happy path (FR-3, FR-8)

```
Given the happy-path fixture (governance cap=8, hotfix=y at cap=10, exploration=y at cap=10, custom hook)
When the eval runs
Then all 9 assertions pass:
  - request_types.hotfix.cost_cap_usd == 10
  - request_types.exploration.cost_cap_usd == 10
  - hooks.code-pre-write.policy-check exists
  - dry-run stdout contains first_state_transition.request_type=="hotfix"
  - daemon store snapshot diff == 0
  - chat-mock count == 0
  - chain-mock count == 0
  - SIGHUP delta == 1
  - phases.13.status == "complete"
```

### Skip path (FR-4)

```
Given wizard.skip_phase_13 == true
When the eval runs
Then verbatim consequence text emitted
And phases.13.status == "skipped"
And no request_types.* or hooks.* keys written
And SIGHUP delta == 0
```

### Error recovery: three sub-cases (FR-5)

```
Given handler script with chmod 644
Then autonomous-dev hooks add returns non-zero
And wizard surfaces stderr
And on operator decline phase exits failed
And no hooks.* keys written

Given handler at non-allowlisted path
And operator confirms allowlist add
Then hook registered

Given request-types.json missing
Then phase exits at read-catalog with diagnostic
```

### Idempotency: three sub-cases (FR-6)

```
Given phase started, SIGTERM after enabling hotfix
When wizard re-runs
Then orchestrator resumes at exploration prompt
And hotfix is already enabled (no re-prompt)

Given hook already registered with same (point, path)
When operator re-adds
Then CLI returns "already registered"
And phase treats as success
And hooks-registry size unchanged

Given fully complete state
When phase-13-probe runs
Then it emits "already-complete"
And module body not entered
```

### Suite pass rate (FR-7)

```
Given the four-case suite is run
When scoring is computed
Then per-case pass rate is ≥ 90%
```

### Feature flag defaults (FR-9, FR-10)

```
Given config_defaults.json
When parsed
Then wizard.phase_12_module_enabled == true
And wizard.phase_13_module_enabled == true

Given operator config sets wizard.phase_12_module_enabled = false
When orchestrator reaches phase 12
Then it emits "Phase 12 unavailable; will be re-enabled in next release"
And continues to phase 13 without crashing
```

### STAGE-3-CANARY.md content (FR-11–FR-14)

```
Given STAGE-3-CANARY.md exists
When read
Then it contains the gate-criteria checklist with five items
And each item is mechanically verifiable (referenced commands or eval IDs)
And it cross-links to SPEC-033-1-03, SPEC-033-2-02, SPEC-033-2-03, TDD-033 §8.2, AMENDMENT-002 AC-03/AC-05/AC-08
```

## 7. Test Requirements

**bats — `tests/setup-wizard/phase-13-evals.bats`:**

| Test ID  | Scenario                          | Assert                                         |
|----------|-----------------------------------|------------------------------------------------|
| P13E-101 | Four files present                 | ls returns exactly the four names             |
| P13E-102 | Schema validates                   | each file passes the validator                 |
| P13E-201 | Happy-path runs                     | all 9 assertions pass                          |
| P13E-301 | Skip-path                           | consequence emitted; no writes; SIGHUP=0       |
| P13E-401 | Error-recovery sub-A                | non-exec handler → failed; no writes          |
| P13E-402 | Error-recovery sub-B                | non-allowlisted → confirmed → registered      |
| P13E-403 | Error-recovery sub-C                | catalog missing → failed at read-catalog      |
| P13E-501 | Idempotency sub-A                   | resume at exploration prompt                   |
| P13E-502 | Idempotency sub-B                   | hook re-add no-op                              |
| P13E-503 | Idempotency sub-C                   | probe → already-complete; body skipped         |
| P13E-601 | Suite pass rate                     | ≥ 90% over all four cases                      |
| P13E-701 | Feature flag default true           | config_defaults.json has both flags true       |
| P13E-702 | Feature flag override false works   | "unavailable" message emitted; no crash        |

**bats — `tests/setup-wizard/stage-3-canary-doc.bats`:**

| Test ID  | Scenario                          | Assert                                         |
|----------|-----------------------------------|------------------------------------------------|
| S3C-101  | Doc exists                         | file present at expected path                  |
| S3C-201  | Five gate criteria present         | grep -c "- \[ \]" >= 5                         |
| S3C-301  | Cross-links present                | grep for SPEC-033-1-03, -2-02, -2-03, TDD-033 §8.2, AMENDMENT-002 |

## 8. Implementation Notes

- The `daemon-store-snapshot-diff` scanner is implemented as `find $DAEMON_STORE -newer <marker> | wc -l` in the eval framework; the marker file is touched at the start of the dry-run-probe step.
- The `chat-mock-counter` and `chain-mock-counter` reuse the mock infrastructure introduced in SPEC-033-1-04 (phase 8 eval set); they expose a counter endpoint the eval framework polls.
- The fixture handler `policy-check.sh` should be a 5-line bash script that simply `echo`s "policy ok" and exits 0; minimal so it doesn't bloat the test fixture.
- `STAGE-3-CANARY.md` is operator-facing documentation; reviewer should validate prose clarity in addition to the mechanical FR-12 / FR-13 checks.
- Feature flag flips do NOT require a wizard re-run — operators can flip at any time; the next orchestrator pass picks up the new value. Document in the canary doc.

## 9. Rollout Considerations

- Stage 2 (phase 13) ships at default flag `true`; lower risk than phase 12 (no PAT, no GitHub writes).
- Stage 3 (phase 12) ships at default flag `true` BUT the canary doc gates "broad rollout" behind the FR-12 criteria. Operators can opt out via the feature flag if needed.
- The canary doc is a living artifact: as additional phases reach Stage 3 in future amendments, append (do not duplicate) gate criteria.

## 10. Effort Estimate

| Activity                                      | Estimate |
|-----------------------------------------------|----------|
| Four eval case files                          | 0.75 day |
| Fixtures (handlers, catalog, repos)           | 0.25 day |
| Config defaults change                        | 0.1 day  |
| STAGE-3-CANARY.md                              | 0.25 day |
| bats validation tests                         | 0.15 day |
| **Total**                                     | **1.5 day** |
