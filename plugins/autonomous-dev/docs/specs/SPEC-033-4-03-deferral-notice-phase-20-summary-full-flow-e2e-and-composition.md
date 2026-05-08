# SPEC-033-4-03: Phases 17-19 Deferral Notice + Phase 20 Summary Extension + Full-Flow Extended E2E + Composition Tests

## Metadata
- **Parent Plan**: PLAN-033-4
- **Parent TDD**: TDD-033 §6.8, §9.2, §10.5, §12
- **Parent PRD**: AMENDMENT-002 §4.8, AC-06, AC-07
- **Tasks Covered**: PLAN-033-4 Tasks 5, 6, 7, 9
- **Estimated effort**: 1.75 days
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-02

## 1. Summary

This spec ships four cross-cutting closeout artifacts that together
satisfy AMENDMENT-002 AC-06 and AC-07 and the composition / inter-plan
integration gates from TDD-033:

1. A static deferral-notice text block for phases 17-19 emitted between
   phase 16 verification and the existing inline phase 20 (TDD-033 §6.8;
   AC-06 anchor).
2. An extension to the existing inline phase 20 summary table that
   enumerates every new phase module (8, 11, 12, 13, 14, 15, 16) with a
   per-row status badge (complete / skipped / failed / unavailable),
   plus a "run wizard --phase NN" hint for legacy 10-phase upgraders
   per TDD-033 §10.5.
3. A single full-flow extended E2E eval case running every phase
   against a fresh checkout with documented operator skip/yes mix
   (TDD-033 §9.2; AC-07 gate).
4. The composition + idempotency closeout test suite proving the four
   PLAN-033-N plans' modules load coherently, re-runs are no-ops,
   partial-state resumes work, inter-phase ordering invariants hold,
   and rollback walks back without state corruption.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                                            | Task |
|-------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | The static deferral-notice block MUST be inserted into `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md` between the orchestrator-loop's phase-16 exit anchor and the existing inline phase-20 entry anchor. The insertion MUST use named anchor comments (HTML comments `<!-- BEGIN-PHASE-17-19-DEFERRAL -->` / `<!-- END-PHASE-17-19-DEFERRAL -->`) so future reorders can be detected by grep. | T5   |
| FR-2  | The deferral-notice MUST contain (verbatim): a banner line of `=` (64 chars), the title "Phases 17-19 are deferred to the autonomous-dev-homelab repository.", a 3-line body explaining what's deferred (auth/identity, observability, internal portal advanced provisioning), and a final line "See: https://github.com/pwatsonr/autonomous-dev-homelab". | T5   |
| FR-3  | The deferral notice MUST NOT be a phase module: no front-matter, no skip predicate, no idempotency probe, no eval cases. It MUST NOT be skippable or interactive. It MUST be emitted exactly once per wizard run regardless of resume state. | T5   |
| FR-4  | The existing inline phase 20 section in `SKILL.md` MUST be extended (not rewritten) to enumerate phases 8, 11, 12, 13, 14, 15, 16 in a summary table with columns `phase | title | status | hint`. Status values: `complete` / `skipped` / `failed` / `unavailable` / `not-run`. | T6   |
| FR-5  | For each row with status `not-run`, the `hint` column MUST contain the literal string "Run: autonomous-dev wizard --phase NN" with NN replaced by the phase number. For `unavailable`, the hint MUST be "Re-enabled in next release; feature flag wizard.phase_NN_module_enabled is false." For `failed`, the hint MUST be "See ~/.autonomous-dev/logs/wizard.log; consider autonomous-dev wizard rollback --phase NN." For `complete`/`skipped`, the hint column MUST be empty. | T6   |
| FR-6  | Phase 20 MUST read `~/.autonomous-dev/wizard-state.json` under a file lock (`flock` on the state file) before rendering the summary, to avoid races with daemon SIGHUP writes. The lock MUST be released after rendering. | T6   |
| FR-7  | The existing inline phase 20 content (pre-AMENDMENT-002 sections about manual verification steps, etc.) MUST be preserved verbatim. The new summary table is ADDITIVE; it appears after a new subheading `### Per-phase module summary (AMENDMENT-002 phases)`. | T6   |
| FR-8  | A single eval case at `plugins/autonomous-dev-assist/evals/test-cases/setup-wizard/full-flow-extended.md` MUST exist. It runs the full wizard from phase 1 to phase 20 against a fresh checkout. | T7   |
| FR-9  | The full-flow E2E inputs MUST: skip phases 11, 12, 16 (via `wizard.skip_phase_NN=true`); accept phases 8, 13, 14, 15 with documented inputs (canonical sample answers from each phase's happy-path eval). Inline phases 1-7, 9, 10 use their pre-AMENDMENT defaults. | T7   |
| FR-10 | The full-flow E2E MUST assert: (a) wizard exits 0 at end of phase 20; (b) the deferral notice (FR-2) appears exactly once between phase 16 and phase 20 in the transcript; (c) the phase 20 summary table contains rows for phases 8 (complete), 11 (skipped), 12 (skipped), 13 (complete), 14 (complete), 15 (complete), 16 (skipped); (d) hint column matches FR-5 mapping; (e) no inline phase 1-7, 9, 10 regression: their existing assertions still pass. | T7   |
| FR-11 | The full-flow E2E MUST be deterministic: replays produce byte-identical state file modulo timestamp fields (excluded via `jq` field filter). | T7   |
| FR-12 | The full-flow E2E MUST run within the eval framework's wall-clock budget (≤ 12 min) using mocked external CLIs (no real GitHub API, no real cloud, no real Slack/Linear/Jira). | T7   |
| FR-13 | A bats suite at `plugins/autonomous-dev-assist/tests/setup-wizard/composition.bats` MUST contain 5 case groups: (a) all-modules-load-coherently; (b) re-run-is-noop; (c) partial-state-resume; (d) inter-phase-ordering-invariant; (e) rollback-walk-back. | T9   |
| FR-14 | Composition group (a): with all 7 new phase modules + the 4 PLAN-033-N batches' helpers loaded together, the orchestrator MUST start without error, MUST list every new phase in its phase-discovery output, and MUST report no duplicate front-matter `phase:` IDs. | T9   |
| FR-15 | Composition group (b): for EACH of phases 8, 11, 12, 13, 14, 15, 16, given a `wizard-state.json` showing the phase complete and all idempotency probes returning `already-complete`, re-running the wizard with `--phase NN` MUST exit 0 with no state mutation (`jq` diff before/after == empty). | T9   |
| FR-16 | Composition group (c): for EACH of the 7 phases, given a partial-state fixture (some output_state keys present, others absent), re-running MUST resume at the correct step (matching the phase's `idempotency_probe`'s `resume-from:<step>` output) and complete without re-prompting for already-collected inputs. | T9   |
| FR-17 | Composition group (d): inter-phase ordering invariants MUST be enforced and surface clear errors: (i) phase 12 MUST refuse to run if phase 7 has not completed (CI scaffolding requires repo bootstrap); (ii) phase 15 MUST emit a warning (not an error) if phase 14 has not run, but still proceed (per SPEC-033-3-03 implementation note); (iii) phase 16 MUST refuse to run if phases 1-7 have not completed. Refusal mode = exit 2 with diagnostic naming the missing prerequisite phase. | T9   |
| FR-18 | Composition group (e): for EACH of phases 8, 11, 12, 13, 14, 15, 16, after a successful run: invoke `autonomous-dev wizard rollback --phase NN` (SPEC-033-4-04); assert `output_state.config_keys_written` keys are reverted to pre-phase snapshot; assert any `external_resources_created` are revoked (cred-proxy handles `cred_proxy_revoke`'d, firewall rules rolled back); assert `phases.NN.status` is reset to `not-run`. Re-run the phase; assert it completes successfully a second time (forward → rollback → forward round-trip). | T9   |
| FR-19 | The composition suite MUST tolerate the cred-proxy mock (no real TDD-024 invocation in CI) per SPEC-033-4-01 implementation notes. Phase 16 invocation in groups (b)-(e) MUST use the mock fixtures. | T9   |
| FR-20 | The deferral notice MUST emit exactly once even when the wizard is resumed mid-flow (e.g. wizard killed during phase 14, restarted; deferral notice appears at the phase-16-to-phase-20 transition only on the run that reaches that transition). | T5   |

## 3. Non-Functional Requirements

| Requirement                                              | Target                                                          | Measurement Method                                       |
|----------------------------------------------------------|-----------------------------------------------------------------|----------------------------------------------------------|
| Full-flow E2E wall clock                                 | ≤ 12 min                                                        | eval framework duration                                  |
| Full-flow E2E determinism                                | byte-identical state across replays (modulo timestamps)         | `jq -S` + filter, diff between two runs                  |
| Phase 20 summary lock                                    | flock acquired and released; no orphan locks on crash           | bats kill-mid-render test                                |
| Composition group all-load latency                       | < 10s for orchestrator phase-discovery                          | bats `time` measurement                                  |
| Composition coverage                                     | each of phases 8, 11, 12, 13, 14, 15, 16 exercised in groups (b)-(e) | bats coverage manifest                              |
| Inter-phase ordering errors                              | exit 2 (not silent corruption) on every violation               | bats per-violation case                                  |
| Rollback round-trip                                      | post-rollback re-run completes and produces identical post-state | bats hash equality across forward → rollback → forward   |
| Deferral notice idempotency                              | regex match count == 1 across full-flow E2E transcript          | grep -c on transcript                                    |
| No PRD-content duplication in summary table              | 0 verbatim ≥40-char sentences from PRD-014/015/017               | regex sweep                                              |

## 4. Technical Approach

### 4.1 Deferral notice (Task 5)

**File modified:** `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md`.

Insert between the orchestrator's phase-16-exit anchor and the existing
inline phase-20 entry. Use HTML comment anchors so reorders can be
detected:

```markdown
<!-- BEGIN-PHASE-17-19-DEFERRAL -->
================================================================
Phases 17-19 are deferred to the autonomous-dev-homelab repository.

  - Phase 17 (auth/identity): identity provider integration.
  - Phase 18 (observability): metrics/traces/log shipping.
  - Phase 19 (internal portal advanced provisioning): tenant
    onboarding workflows.

These phases require infrastructure beyond what this wizard
provisions and are tracked separately.

See: https://github.com/pwatsonr/autonomous-dev-homelab
================================================================
<!-- END-PHASE-17-19-DEFERRAL -->
```

The orchestrator emits this block once during a single wizard run by
checking a session-scoped flag (`$WIZARD_DEFERRAL_EMITTED=1` set after
first emit; reset only when the wizard process restarts, NOT on
resume). Resume-from-checkpoint MUST re-emit if and only if the
checkpointed state shows phase 16 just completed and phase 20 has not
yet run.

### 4.2 Phase 20 summary table extension (Task 6)

**File modified:** same `SKILL.md`. Insert AFTER existing phase 20
content under a new heading. Pseudocode:

```bash
# In phase 20 module body:
exec 9>~/.autonomous-dev/wizard-state.json.lock
flock 9
state="$(cat ~/.autonomous-dev/wizard-state.json)"
flock -u 9

cat <<'EOF'
### Per-phase module summary (AMENDMENT-002 phases)

| phase | title | status | hint |
|-------|-------|--------|------|
EOF

for nn in 08 11 12 13 14 15 16; do
  status=$(jq -r ".phases.\"$nn\".status // \"not-run\"" <<<"$state")
  title=$(yq -r '.title' "phases/phase-${nn}-*.md")
  hint="$(_render_hint "$nn" "$status")"
  printf "| %s | %s | %s | %s |\n" "$nn" "$title" "$status" "$hint"
done
```

The `_render_hint` helper applies the FR-5 mapping. The lock release
is automatic on scope exit even on Ctrl-C (`flock -u 9` is paired with
`exec 9>&-` in cleanup trap).

### 4.3 Full-flow extended E2E (Task 7)

**File created:** `plugins/autonomous-dev-assist/evals/test-cases/setup-wizard/full-flow-extended.md`.

```yaml
---
case: full-flow-extended
description: |
  AMENDMENT-002 AC-07 gate. Run all phases 1..20 against a fresh
  checkout with operator-skip on 11/12/16 and operator-yes on
  8/13/14/15. Assert reach-phase-20 with correct state summary.
mocks:
  - autonomous-dev cred-proxy
  - autonomous-dev plugin install
  - autonomous-dev firewall apply
  - autonomous-dev deploy --dry-run
  - autonomous-dev reviewer-chain dry-run
  - gh (github CLI) — canned fixture responses
  - daemon SIGHUP — counter only, no real send
inputs:
  wizard.skip_phase_11: true
  wizard.skip_phase_12: true
  wizard.skip_phase_16: true
  # Phase 8 inputs (canonical from happy-path):
  chat.channels: [...]
  # Phase 13 inputs:
  request_types: [...]
  # Phase 14 inputs:
  standards.path: ".autonomous-dev/standards.yaml"
  # Phase 15 inputs:
  reviewer_chains.specialists: ["security@1", "performance@2"]
expected:
  exit_code: 0
  transcript_assertions:
    - "deferral-notice appears exactly once between phase 16 and phase 20"
    - "phase 20 summary table contains 7 rows for phases 8/11/12/13/14/15/16"
    - "phases 8, 13, 14, 15 status == complete"
    - "phases 11, 12, 16 status == skipped"
    - "hint column for skipped/complete is empty"
    - "no regression on inline phase 1-7 / 9 / 10 assertions"
  state_file_assertions:
    - phases.08.status == complete
    - phases.11.status == skipped
    - phases.12.status == skipped
    - phases.13.status == complete
    - phases.14.status == complete
    - phases.15.status == complete
    - phases.16.status == skipped
  determinism:
    - replay byte-identical modulo {timestamps, generated_handles}
---
```

The eval framework's mock harness ships canned fixtures for each mocked
CLI; this case wires them together. Determinism check: run the case
twice in clean sandboxes; `jq -S 'del(.. | .timestamp?, .last_dry_run_at?)'`
on both state files; diff is empty.

### 4.4 Composition test suite (Task 9)

**File created:** `plugins/autonomous-dev-assist/tests/setup-wizard/composition.bats`.

| Test ID  | Group | Scenario                                                 | Assert                                                                |
|----------|-------|----------------------------------------------------------|-----------------------------------------------------------------------|
| C-101    | (a)   | Orchestrator phase-discovery with all 7 modules          | exit 0; lists 8, 11, 12, 13, 14, 15, 16; no duplicate phase IDs       |
| C-102    | (a)   | Front-matter validation across all 7 modules             | every key listed in `_phase-contract.md` present                      |
| C-201    | (b)   | Phase 8 re-run on completed state                        | jq diff state pre/post == empty                                        |
| C-202    | (b)   | Phase 11 re-run on completed state                       | jq diff state pre/post == empty                                        |
| C-203    | (b)   | Phase 12 re-run on completed state                       | jq diff state pre/post == empty                                        |
| C-204    | (b)   | Phase 13 re-run on completed state                       | jq diff state pre/post == empty                                        |
| C-205    | (b)   | Phase 14 re-run on completed state                       | jq diff state pre/post == empty                                        |
| C-206    | (b)   | Phase 15 re-run on completed state                       | jq diff state pre/post == empty                                        |
| C-207    | (b)   | Phase 16 re-run on completed state (mocked)              | jq diff state pre/post == empty                                        |
| C-301    | (c)   | Phase 8 partial-state resume                             | resumes at correct step; no re-prompt for collected inputs            |
| C-302    | (c)   | Phase 11 partial-state resume                            | resumes correctly                                                     |
| C-303    | (c)   | Phase 12 partial-state resume                            | resumes correctly                                                     |
| C-304    | (c)   | Phase 13 partial-state resume                            | resumes correctly                                                     |
| C-305    | (c)   | Phase 14 partial-state resume                            | resumes correctly                                                     |
| C-306    | (c)   | Phase 15 partial-state resume                            | resumes correctly                                                     |
| C-307    | (c)   | Phase 16 partial-state resume (per-env atomicity)        | resumes at failed env; prior envs untouched                           |
| C-401    | (d)   | Phase 12 with phase 7 incomplete                         | exit 2; diagnostic names phase 7                                      |
| C-402    | (d)   | Phase 15 with phase 14 not run                           | warning emitted; phase still completes (status=complete)              |
| C-403    | (d)   | Phase 16 with phases 1-7 incomplete                      | exit 2; diagnostic names earliest missing prereq                      |
| C-501    | (e)   | Phase 8 forward → rollback → forward                     | post-state matches first forward-state hash; status=complete          |
| C-502    | (e)   | Phase 11 forward → rollback → forward                    | post-state hash equality                                              |
| C-503    | (e)   | Phase 12 forward → rollback → forward                    | post-state hash equality                                              |
| C-504    | (e)   | Phase 13 forward → rollback → forward                    | post-state hash equality                                              |
| C-505    | (e)   | Phase 14 forward → rollback → forward                    | post-state hash equality                                              |
| C-506    | (e)   | Phase 15 forward → rollback → forward                    | post-state hash equality                                              |
| C-507    | (e)   | Phase 16 forward → rollback → forward                    | cred-proxy revoke counter == 3; firewall rollback counter == 3; hash equality |

The harness uses fixtures for state at various stages and the
mocked-CLI registry from SPEC-033-4-01 / SPEC-033-4-02 fixtures. Each
group's setup creates a clean `~/.autonomous-dev/` sandbox; teardown
removes it.

## 5. Interfaces and Dependencies

**Consumed:**
- SPEC-033-1-01: orchestrator + phase contract + state schema.
- SPEC-033-1-03: orchestrator loop + feature flags.
- SPEC-033-1-04: phase 8.
- SPEC-033-1-05: phase 11.
- SPEC-033-2-02: phase 12 CI module.
- SPEC-033-2-04: phase 13 request types module.
- SPEC-033-3-02: phase 14 standards module.
- SPEC-033-3-03: phase 15 reviewer chains module.
- SPEC-033-4-01: cred-proxy bridge + credential scanner.
- SPEC-033-4-02: phase 16 module.
- SPEC-033-4-04: wizard rollback CLI (consumed by group (e)).

**Produced:**
- Modifications to `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md` (deferral block + phase 20 summary table).
- `plugins/autonomous-dev-assist/evals/test-cases/setup-wizard/full-flow-extended.md`.
- `plugins/autonomous-dev-assist/tests/setup-wizard/composition.bats`.
- A small helper `_render_hint` (≤ 30 LOC) inlined in phase 20 module.

## 6. Acceptance Criteria

### Deferral notice anchors (FR-1, FR-2, FR-3)

```
Given SKILL.md is parsed
When the BEGIN-PHASE-17-19-DEFERRAL anchor and END anchor are searched
Then both anchors exist exactly once
And between the anchors the verbatim text from FR-2 appears (banner + 3-line body + URL)
And the block is positioned after the orchestrator's phase-16 exit and before the inline phase 20 entry
```

### Deferral notice emit-once (FR-3, FR-20, NFR idempotency)

```
Given a wizard run that completes phases 1..20
When the transcript is captured
Then the deferral banner regex matches exactly once

Given a wizard killed during phase 14, then resumed
And the resumed run reaches the phase-16-to-phase-20 transition
Then the deferral banner regex matches exactly once across the resumed run's transcript
```

### Phase 20 summary table (FR-4, FR-5, FR-6, FR-7)

```
Given wizard-state.json has phases.08.status="complete", phases.11.status="skipped",
  phases.13.status="failed", phases.14.status="not-run", phases.16.status="unavailable"
When phase 20 renders the summary
Then the table contains exactly 7 rows (phases 08, 11, 12, 13, 14, 15, 16)
And phase 08 row has status="complete" and empty hint
And phase 11 row has status="skipped" and empty hint
And phase 13 row has status="failed" and hint contains "wizard rollback --phase 13"
And phase 14 row has status="not-run" and hint contains "wizard --phase 14"
And phase 16 row has status="unavailable" and hint contains "wizard.phase_16_module_enabled"

Given existing inline phase 20 content
When phase 20 emits
Then the existing content appears verbatim before the new "Per-phase module summary" subheading
```

### Phase 20 file lock (FR-6, NFR lock)

```
Given phase 20 is rendering the summary
When SIGKILL is sent
Then no orphan lock file remains on next wizard invocation
And the next invocation can acquire the lock without blocking longer than the OS lock-cleanup
```

### Full-flow E2E pass (FR-8 — FR-12, AC-07)

```
Given a fresh checkout with the documented mocks installed
When the full-flow-extended.md eval runs
Then the wizard exits 0 at end of phase 20
And the deferral banner appears exactly once between phase 16 and phase 20
And the phase 20 summary table contains the expected 7 rows with documented status mapping
And inline phase 1-7, 9, 10 baseline assertions pass

Given the eval is replayed in a fresh sandbox
When jq -S filtered state files are diffed (excluding timestamps and handles)
Then the diff is empty
```

### Composition group (a) — all-load (FR-13a, FR-14)

```
Given all 7 phase modules + the 4 PLAN-033-N batches' helpers loaded
When orchestrator phase-discovery runs
Then exit code is 0
And the discovered phase list contains 8, 11, 12, 13, 14, 15, 16 (no duplicates)
And every required front-matter key per _phase-contract.md is present in each module
```

### Composition group (b) — re-run no-op (FR-15)

```
For each phase NN in [8, 11, 12, 13, 14, 15, 16]:
Given wizard-state.json with phases.NN.status="complete" and idempotency probe → already-complete
When wizard --phase NN is run
Then exit code is 0
And jq diff of wizard-state.json before/after is empty (modulo last_seen_at if present)
```

### Composition group (c) — partial-state resume (FR-16)

```
For each phase NN in [8, 11, 12, 13, 14, 15, 16]:
Given a fixture with partial output_state keys
When wizard --phase NN is run
Then resume happens at the step matching the probe's resume-from output
And no already-collected operator input is re-prompted
And the phase completes with status=complete
```

### Composition group (d) — ordering invariants (FR-17)

```
Given phase 7 status != complete
When wizard --phase 12 is run
Then exit code is 2
And stderr contains "phase 12 requires phase 7 complete; current status: <X>"

Given phase 14 status == not-run
When wizard --phase 15 is run
Then a warning is emitted ("Specialist '<id>' requires standards.yaml; you may want to run phase 14 first")
And the phase still completes with status=complete

Given any of phases 1-7 status != complete
When wizard --phase 16 is run
Then exit code is 2
And stderr names the missing prereq phase
```

### Composition group (e) — rollback round-trip (FR-18, FR-19, NFR rollback)

```
For each phase NN in [8, 11, 12, 13, 14, 15, 16]:
Given phase NN was successfully run (status=complete, output_state populated)
When `autonomous-dev wizard rollback --phase NN` is invoked
Then output_state.config_keys_written are reverted to pre-phase snapshot
And output_state.external_resources_created entries are revoked (cred-proxy / firewall)
And phases.NN.status is reset to "not-run"

When wizard --phase NN is run again
Then it completes with status=complete
And the post-state hash equals the first forward-state hash (modulo timestamps and re-issued handle IDs)

Specifically for phase 16:
  - cred_proxy_revoke is invoked exactly 3 times (one per env with non-local backend)
  - firewall rollback is invoked exactly 3 times
```

## 7. Test Requirements

- bats `tests/setup-wizard/composition.bats` — see C-101 through C-507 above.
- bats `tests/setup-wizard/deferral-notice.bats` — emit-once, anchor positions, verbatim text.
- bats `tests/setup-wizard/phase-20-summary.bats` — table rendering for each status; lock acquisition; existing-content preservation.
- Eval `evals/test-cases/setup-wizard/full-flow-extended.md` — see FR-8 through FR-12.
- Determinism harness: replay-twice + `jq -S` filter diff.
- Mock CLIs from SPEC-033-4-01 / SPEC-033-4-02; reused.

## 8. Implementation Notes

- The deferral notice's "emit exactly once" semantics are tricky for
  resume cases. The simplest implementation: track in
  `~/.autonomous-dev/wizard-state.json` a top-level
  `deferral_notice_emitted: true` flag, set the first time the block
  is emitted, never reset. This survives resumes correctly.
- The phase 20 summary table reads phase titles from the phase
  modules' YAML front-matter via `yq`. If that lookup is too slow,
  cache the title strings in a constant. Don't hardcode them
  separately — keep front-matter as the source of truth.
- The flock pattern requires bash 4+ and util-linux's `flock` binary
  (Linux). On macOS, `shlock` is the substitute; document a fallback
  comment but the primary CI target is Linux.
- The full-flow E2E is deliberately mock-heavy. The intent is to prove
  module composition and state-machine behavior, NOT to validate
  external integrations. Real-integration tests live in each phase's
  own eval suite (which the eval framework runs separately).
- The composition `forward → rollback → forward` round-trip for phase
  16 requires the mock cred-proxy to issue distinct handles on each
  provision call (the first forward-run handle is revoked; the second
  forward-run handle is fresh). The state hash equality check filters
  out the handle ID specifically.
- Inter-phase ordering invariants (FR-17) are enforced at orchestrator
  entry, NOT inside each phase module. Add the check in
  `lib/orchestrator-entry.sh` (extending SPEC-033-1-03's loop) — but
  make this change minimally invasive and gate it behind feature flag
  `wizard.ordering_invariants_enforced` (default true).
- The full-flow E2E's wall-clock budget (≤ 12 min) accounts for phase
  12's probe-PR poll (5 min ceiling per TDD-033 §10.3 even when
  mocked, because the polling sleep cannot be fully eliminated
  without changing the production code path). If under-budget on
  CI, fine; if over-budget, the case is auto-failed and the cause
  triaged.

## 9. Rollout Considerations

- Deferral notice and phase 20 summary table ship together with phase
  16; they are gated by `wizard.phase_16_module_enabled` only insofar
  as the phase 20 table's "phase 16" row appears as `unavailable`
  when the flag is false. The deferral notice itself emits regardless
  of phase 16 status (it's about phases 17-19, not 16).
- The full-flow E2E becomes the AC-07 gate: PRs that touch any phase
  module must keep this case green or document the regression.
- Composition tests run on every PR via the standard bats harness.

## 10. Effort Estimate

| Activity                                                      | Estimate |
|---------------------------------------------------------------|----------|
| Deferral notice + emit-once flag + anchors                    | 0.25 day |
| Phase 20 summary table extension + flock + hint helper        | 0.5 day  |
| Full-flow extended E2E eval case + determinism harness        | 0.5 day  |
| Composition bats suite (5 groups × ~6 cases avg)              | 0.5 day  |
| **Total**                                                     | **1.75 day** |
