# SPEC-033-1-03: Master SKILL.md Orchestrator Loop + Feature Flags

## Metadata
- **Parent Plan**: PLAN-033-1
- **Parent TDD**: TDD-033-setup-wizard-phase-modules
- **Tasks Covered**: PLAN-033-1 Task 5 (orchestrator loop), Task 10 (feature flags)
- **Estimated effort**: 1.25 days
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-02

## 1. Summary

Extend the master `setup-wizard/SKILL.md` with a generic phase-module
orchestration loop placed strictly between the existing inline phase 7
exit and inline phase 9 entry. The loop iterates the registered set
`{08, 11, 12, 13, 14, 15, 16}`, parses each module's YAML front-matter,
verifies required inputs, evaluates the skip predicate, evaluates the
idempotency probe, runs the module body when applicable, and writes the
result to `~/.autonomous-dev/wizard-state.json`. Feature flags
`wizard.phase_NN_module_enabled` (default `true`) gate execution per
TDD-033 §8.3.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                                              | Task |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | The master file `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md` MUST gain an orchestrator section titled "Phase Modules (8, 11–16)" inserted between the existing inline phase 7 closing marker and the inline phase 9 opening marker. | T5   |
| FR-2  | The orchestrator MUST iterate the registry `[08, 11, 12, 13, 14, 15, 16]` in that order.                                                                                  | T5   |
| FR-3  | For each phase NN, the orchestrator MUST locate the file `phases/phase-NN-*.md`. Missing file → emit `phase NN module not found; skipping` and continue (forward-compat for staged shipping). | T5   |
| FR-4  | For each phase NN, the orchestrator MUST first check the feature flag `wizard.phase_NN_module_enabled`. If false → emit "Phase NN unavailable; will be re-enabled in next release" and continue. | T5   |
| FR-5  | The orchestrator MUST parse the YAML front-matter using a single canonical parser: `yq -r` if available; else a documented bash shim that reads only the front-matter delimited by `---`/`---`. | T5   |
| FR-6  | The orchestrator MUST verify `required_inputs.phases_complete`: for each listed phase NN, the wizard-state file MUST report status=complete; otherwise emit "Cannot enter phase NN: requires phase MM to be complete" and abort the phase (continue to next). | T5   |
| FR-7  | The orchestrator MUST verify `required_inputs.config_keys`: for each listed key, `has_config_key` from SPEC-033-1-01 MUST return 0; else abort the phase as in FR-6.       | T5   |
| FR-8  | The orchestrator MUST evaluate `skip_predicate` (a bash command string from the front-matter): exit 0 → skip the phase, emit `skip_consequence` text verbatim, mark phase status=skipped, continue. | T5   |
| FR-9  | The orchestrator MUST evaluate `idempotency_probe`: stdout `already-complete` → mark phase complete and continue (no-op); `resume-from:<step>` → enter the module starting at the named step; `start-fresh` → enter from step 1. | T5   |
| FR-10 | Before entering a phase, the orchestrator MUST snapshot the keys listed in `output_state.config_keys_written` to `~/.autonomous-dev/wizard-snapshots/phase-NN-pre.json`. | T5   |
| FR-11 | The orchestrator MUST transclude the module body (everything after the closing `---`) into the operator-facing prose stream, with the module's `title` rendered as a banner. | T5   |
| FR-12 | After successful completion, the orchestrator MUST write to `~/.autonomous-dev/wizard-state.json`: `phases.NN = {status: "complete"|"skipped"|"failed", started_at, completed_at, config_keys_written: [...]}`. | T5   |
| FR-13 | The orchestrator MUST emit one structured log line per phase transition to `~/.autonomous-dev/logs/wizard.log` matching `{"phase": NN, "step": "<name>", "status": "<state>", "duration_ms": N}` per TDD-033 §10.5. | T5   |
| FR-14 | A migration banner MUST be emitted on first orchestrator entry for legacy 10-phase configs: "phases 8, 11–16 are new in AMENDMENT-002; you may run any individual phase via `wizard --phase NN`". The banner is suppressed once any new phase has status≠"not-run". | T5   |
| FR-15 | The configuration defaults file (`plugins/autonomous-dev-assist/config_defaults.json` — create if missing) MUST contain `wizard.phase_NN_module_enabled: true` for NN ∈ {08, 11}. Phases 12, 13, 14, 15, 16 default flags ship in their own SPECs. | T10  |
| FR-16 | Existing inline phases 1–7, 9, 10, 20 MUST be unchanged. A `git diff` against the prior `SKILL.md` MUST show modifications only inside the inserted orchestrator block plus the registry ordering anchor. | T5   |

## 3. Non-Functional Requirements

| Requirement                          | Target                                                                | Measurement Method                                                |
|--------------------------------------|-----------------------------------------------------------------------|-------------------------------------------------------------------|
| Orchestrator overhead per phase      | < 500ms (front-matter parse + skip eval + idempotency probe + state write) | bats wrapper times the orchestrator stub against fixtures        |
| Existing-eval regression             | 0 failing test cases in the legacy phase-1–7/9/10/20 eval suites      | run prior eval suite as a regression gate                         |
| Log line schema                       | 100% of phase transitions emit a parseable JSON line per TDD-033 §10.5 | jq -e per line of wizard.log                                     |
| Front-matter parser determinism       | yq output and bash-shim output identical on the 12-key TDD-033 §5.1 fixture | parametrized bats test with both backends                        |
| Migration banner suppression          | Banner appears at most once per wizard run                            | eval test asserts banner emitted iff first new-phase entry        |

## 4. Technical Approach

**File: `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md`**

The orchestrator block is mostly operator-facing prose plus embedded bash blocks. Structure:

1. **Anchor markers** — wrap the new block with HTML comments `<!-- BEGIN: phase-module orchestrator (TDD-033) -->` and `<!-- END: phase-module orchestrator -->` so future SPECs (and reviewer assertions per FR-16) can diff them surgically.
2. **Library sourcing** — the module begins with:
   ```bash
   source "$PLUGIN_DIR/skills/setup-wizard/lib/skip-predicates.sh"
   source "$PLUGIN_DIR/skills/setup-wizard/lib/idempotency-checks.sh"
   source "$PLUGIN_DIR/skills/setup-wizard/lib/cred-proxy-bridge.sh"
   ```
3. **Registry** — `PHASE_REGISTRY=(08 11 12 13 14 15 16)` (literal order; fixed).
4. **For-loop** — for each NN, run the per-phase pipeline:
   - locate module file
   - feature-flag check
   - parse front-matter (yq or bash shim)
   - verify required_inputs
   - eval skip_predicate
   - eval idempotency_probe
   - snapshot config keys
   - transclude module body
   - run verification block
   - write state
   - emit structured log
5. **Migration banner** — printed before the loop on first run if no phases.NN status ≠ "not-run".

**Front-matter parser (bash shim fallback)**
```bash
parse_front_matter() {
  local file="$1" key="$2"
  awk -v k="$key" '
    /^---$/ { f++; next }
    f == 1 { print }
    f == 2 { exit }
  ' "$file" | grep -E "^${key}:" | sed -E "s/^${key}:[[:space:]]*//; s/^\"(.*)\"\$/\1/"
}
```
For nested keys (e.g. `output_state.config_keys_written`), prefer `yq`; the shim handles only flat top-level keys.

**Snapshot mechanism (FR-10)**
Before entering phase NN, read each key listed in `output_state.config_keys_written`, write the (key, value) pairs to `~/.autonomous-dev/wizard-snapshots/phase-NN-pre.json`. Existing snapshots are overwritten only if the prior phase status was not "complete" (otherwise rollback CLI in SPEC-033-4-05 needs them).

**State schema (FR-12)**
```json
{
  "schema_version": 1,
  "phases": {
    "08": {
      "status": "complete",
      "started_at": "2026-05-02T14:00:00Z",
      "completed_at": "2026-05-02T14:03:21Z",
      "config_keys_written": ["intake.discord.enabled", "intake.discord.webhook_env"]
    }
  }
}
```

**Feature-flag defaults (FR-15)**
Edit/create `plugins/autonomous-dev-assist/config_defaults.json`:
```json
{
  "wizard": {
    "phase_08_module_enabled": true,
    "phase_11_module_enabled": true
  }
}
```
Existing inline phases load this file via the daemon's standard config-merge path; the new orchestrator MUST also honor `~/.autonomous-dev/config.json` overrides.

## 5. Interfaces and Dependencies

**Consumed:**
- `lib/skip-predicates.sh`, `lib/idempotency-checks.sh`, `lib/cred-proxy-bridge.sh` (SPEC-033-1-01, SPEC-033-1-02).
- `phases/phase-NN-*.md` files (created by SPEC-033-1-04, -1-05, and downstream specs).
- `phases/_phase-contract.md` — reviewer rubric reference.
- `yq` (>= 4.x) optional; bash shim is fallback.
- `~/.autonomous-dev/config.json` (existing inline-phase-1 output).

**Produced:**
- `~/.autonomous-dev/wizard-state.json` (new file; orchestrator owns).
- `~/.autonomous-dev/wizard-snapshots/phase-NN-pre.json` (per-phase pre-snapshots).
- `~/.autonomous-dev/logs/wizard.log` (append-only structured log).

**No external services.**

## 6. Acceptance Criteria

### Insertion location (FR-1, FR-16)

```
Given the prior SKILL.md (pre-TDD-033)
When the post-spec SKILL.md is diffed against the prior version
Then the only modifications are between the markers
     <!-- BEGIN: phase-module orchestrator (TDD-033) --> and
     <!-- END: phase-module orchestrator -->
And the orchestrator markers are placed strictly after the inline phase 7
     "Phase 7 complete" marker and strictly before the inline phase 9
     "Phase 9 — ..." heading
And no character of inline phases 1, 2, 3, 4, 5, 6, 7, 9, 10, 20 has changed
```

### Registry order (FR-2)

```
Given the orchestrator loop runs against fixtures for all seven new modules
When the structured log entries are sorted by `started_at`
Then the phase numbers in order are exactly 08, 11, 12, 13, 14, 15, 16
```

### Missing module forward-compat (FR-3)

```
Given the phases/ directory contains only phase-08 and phase-11 modules
When the orchestrator runs
Then for NN ∈ {12, 13, 14, 15, 16}: a log line "phase NN module not found; skipping" is emitted
And the orchestrator does not abort
And phases.NN.status in wizard-state.json is "not-run"
```

### Feature flag off (FR-4)

```
Given config.json sets wizard.phase_11_module_enabled to false
When the orchestrator reaches phase 11
Then the operator sees "Phase 11 unavailable; will be re-enabled in next release"
And phases.11.status in wizard-state.json is "unavailable"
And phase 12 is still attempted next
```

### Required-input gating (FR-6, FR-7)

```
Given a phase 12 module declaring required_inputs.phases_complete = [1,2,3,4,5,6,7]
And wizard-state.json reports phase 7 as in-progress
When the orchestrator enters phase 12
Then it emits "Cannot enter phase 12: requires phase 7 to be complete"
And does not run the module body
And phases.12.status is "blocked"

Given a phase declaring required_inputs.config_keys = [".repositories.allowlist"]
And config.json lacks that key
When the orchestrator enters the phase
Then it emits a similar gating error and aborts the phase
```

### Skip predicate (FR-8)

```
Given a phase whose skip_predicate is "skip-predicates.sh is_cli_only_mode"
And config.json has wizard.cli_only=true
When the orchestrator evaluates the predicate
Then exit 0 indicates skip
And the operator sees the phase's skip_consequence text verbatim
And phases.NN.status is "skipped"
```

### Idempotency probe (FR-9)

```
Given a phase whose idempotency_probe outputs "already-complete"
When the orchestrator evaluates the probe
Then the module body is not transcluded
And phases.NN.status is "complete"
And the structured log entry has duration_ms < 500

Given an idempotency_probe outputting "resume-from:configure-protection"
When the orchestrator evaluates the probe
Then the module body is entered with the env var WIZARD_RESUME_STEP=configure-protection
And the module's per-step dispatch jumps to that step
```

### Pre-snapshot (FR-10)

```
Given a phase with output_state.config_keys_written = ["intake.discord.enabled"]
And config.json has intake.discord.enabled = false
When the orchestrator enters the phase
Then ~/.autonomous-dev/wizard-snapshots/phase-NN-pre.json contains
     {"intake.discord.enabled": false}
```

### State write (FR-12)

```
Given a phase that completes successfully
When the orchestrator finishes the phase
Then wizard-state.json gains an entry phases.NN with status="complete",
     started_at and completed_at as ISO-8601 UTC timestamps,
     and config_keys_written populated from the front-matter
```

### Structured log (FR-13)

```
Given a phase that runs to completion
When wizard.log is parsed
Then there is at least one line with {"phase":NN,"step":"start","status":"started"}
And one line with {"phase":NN,"step":"verify","status":"completed","duration_ms":<number>}
And every line is valid JSON (jq -e .)
```

### Migration banner (FR-14)

```
Given a fresh wizard-state.json with no NN ∈ {08,11,12,13,14,15,16} set
When the orchestrator block is entered for the first time
Then the operator sees the banner exactly once
And on a re-entry where any NN has status ≠ "not-run", the banner is suppressed
```

### Front-matter parser determinism (NFR)

```
Given the canonical 12-key TDD-033 §5.1 front-matter fixture
When parsed with yq AND with the bash shim
Then both parsers return the identical (key, value) set for the 12 keys
```

## 7. Test Requirements

**bats — `tests/setup-wizard/orchestrator-loop.bats`:**

| Test ID | Scenario                                          | Assert                                                                  |
|---------|---------------------------------------------------|-------------------------------------------------------------------------|
| O-001   | Insertion-anchor diff                              | `git diff` outside markers is empty                                     |
| O-002   | Registry order                                    | log lines NN sequence == 08,11,12,13,14,15,16                            |
| O-101   | Missing module                                    | "module not found" log; orchestrator continues                           |
| O-201   | Flag off                                          | "unavailable" message; status="unavailable"                              |
| O-301   | required_inputs.phases_complete unmet              | "Cannot enter" emitted; status="blocked"                                 |
| O-302   | required_inputs.config_keys unmet                  | "Cannot enter" emitted; status="blocked"                                 |
| O-401   | skip_predicate exit 0                              | consequence text emitted; status="skipped"                               |
| O-501   | idempotency_probe = already-complete               | body not transcluded; status="complete"                                  |
| O-502   | idempotency_probe = resume-from:X                  | WIZARD_RESUME_STEP=X exported                                            |
| O-601   | pre-snapshot                                      | snapshot file matches expected keys                                      |
| O-701   | state write                                       | wizard-state.json schema valid; jq fields present                        |
| O-801   | structured log                                    | every line jq -e . OK; required keys present                             |
| O-901   | migration banner first-run                         | banner present                                                          |
| O-902   | migration banner suppressed                       | banner absent on re-entry                                               |
| O-911   | parser determinism                                 | yq vs shim identical                                                    |

**Eval — `evals/test-cases/setup-wizard/orchestrator-loop-smoke.md`:**
- flag-disabled-phase shows "unavailable"
- skip-predicate-true shows consequence
- idempotency-already-complete shows no-op
- legacy-10-phase config sees migration banner once

**Regression — run the existing setup-wizard eval suite end-to-end after the SKILL.md edit; assert zero failures.**

## 8. Implementation Notes

- `set -e` inside the orchestrator block is dangerous (exit codes are part of the API). Use explicit `if`-`then`-`else`.
- `yq` v4 syntax: `yq '.phase' file.md` — but front-matter is YAML embedded in markdown; pre-extract with awk before piping to yq.
- The `required_inputs.phases_complete` list in TDD-033 fixtures uses bare integers (`[1,2,3,4,5,6,7]`); the bash shim must handle both `[1,2]` and `[01,02]`.
- The migration banner comparison uses `jq` to detect "any NN in registry has status ≠ not-run".
- Per FR-16, do NOT touch the legacy phase content even for indentation. Reviewers will diff strictly.
- `wizard-state.json` writes MUST be atomic: write to `.tmp`, then `mv`. Do not partial-write under SIGINT.

## 9. Rollout Considerations

- Feature flags `phase_08` and `phase_11` ship `true`; phases 12, 13, 14, 15 ship `true` in their own specs; phase 16 ships `false` initially (SPEC-033-4-05 flips after Stage 4 canary).
- Rollback: setting any flag to `false` returns the orchestrator to the safe "unavailable; subsequent phases continue" path.
- The migration banner is the only operator-visible change for legacy 10-phase setups until they opt into a new phase.

## 10. Effort Estimate

| Activity                                           | Estimate |
|----------------------------------------------------|----------|
| Author orchestrator block in SKILL.md              | 0.75 day |
| Front-matter shim + parser determinism tests       | 0.25 day |
| State / snapshot / log instrumentation             | 0.25 day |
| **Total**                                          | **1.25 day** |
