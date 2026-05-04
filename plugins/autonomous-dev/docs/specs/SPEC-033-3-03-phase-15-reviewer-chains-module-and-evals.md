# SPEC-033-3-03: Phase 15 Module — Specialist Reviewer Chains + Eval Set + Feature Flag Defaults

## Metadata
- **Parent Plan**: PLAN-033-3
- **Parent TDD**: TDD-033 §6.6
- **Parent PRD**: AMENDMENT-002 §4.6, AC-03
- **Tasks Covered**: PLAN-033-3 Tasks 4, 5, 6
- **Estimated effort**: 2 days
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-02

## 1. Summary

Author the phase 15 module that configures specialist reviewer chains
(security, performance, accessibility, db-migration,
dependency-update, etc.). The phase enumerates the bundled catalog
data-driven from `specialist-reviewers.json`, lets the operator
enable/disable each specialist with chain-order weight + threshold,
writes `<repo>/.autonomous-dev/reviewer-chains.yaml`, and verifies via
`autonomous-dev reviewer-chain dry-run`. A forward-reference banner
points to phase 12 (CI) for live-run verification per TDD-033 §6.6.
Also adds the phase 14 / phase 15 feature-flag defaults to
`config_defaults.json`.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                            | Task |
|-------|--------------------------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | A markdown file at `plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-15-reviewer-chains.md` MUST exist with valid front-matter per `_phase-contract.md`. | T4   |
| FR-2  | Front-matter MUST set `phase: 15`, `title: "Specialist reviewer chains"`, `amendment_001_phase: 15`, `tdd_anchors: [TDD-020, TDD-021]`, `required_inputs.phases_complete: [1,2,3,4,5,6,7]`, `required_inputs.config_keys: ["standards.path"]` (phase 14 must have run if standards-aware specialists are enabled; if not, the phase still runs but warns). | T4   |
| FR-3  | Front-matter MUST set `skip_predicate: "skip-predicates.sh phase_15_skip_predicate"` where the wrapper exits 0 only when `wizard.skip_phase_15=true` (default false). | T4   |
| FR-4  | `skip_consequence` MUST contain the verbatim text "Only the generic reviewer will run; security/performance/accessibility findings will not be surfaced automatically." | T4   |
| FR-5  | Front-matter MUST set `idempotency_probe: "idempotency-checks.sh phase-15-probe"` (wrapper documented in §4). | T4   |
| FR-6  | Front-matter MUST set `output_state.config_keys_written: ["reviewer_chains.path", "reviewer_chains.last_dry_run_at", "reviewer_chains.specialists_enabled_count"]` and `output_state.files_created: ["<repo>/.autonomous-dev/reviewer-chains.yaml"]`. | T4   |
| FR-7  | The module MUST enumerate the catalog from `plugins/autonomous-dev/config/specialist-reviewers.json`. The file is expected to be a JSON array of `{id, description, default_weight, default_threshold, requires_standards}`. The phase MUST iterate every entry and prompt the operator. | T4   |
| FR-8  | Per-specialist prompt MUST collect: enable y/N; on y, weight (integer; default = `default_weight`) and threshold (numeric; default = `default_threshold`). The operator-facing UI presents weight as a numeric chain-position hint ("lower = earlier in chain"); the rendered chain is sorted by weight before write. | T4   |
| FR-9  | The module MUST write `<repo>/.autonomous-dev/reviewer-chains.yaml` with stable, deterministic ordering: specialists sorted by `weight` ascending, ties broken by `id` lexicographically. The schema is documented inline in the module body and matches TDD-020. | T4   |
| FR-10 | The module MUST verify via `autonomous-dev reviewer-chain dry-run --against HEAD~1..HEAD --json`. Each enabled specialist MUST be observed in the dry-run output as either posting a finding OR explicitly returning "no findings" — proving the runtime can dispatch the chain. The dry-run MUST NOT invoke any underlying LLM. | T4   |
| FR-11 | The dry-run MUST be read-only: a fs-snapshot diff before/after MUST show 0 changes outside the documented allow-list (the chain.yaml itself, plus orchestrator state files). Confirmed via `lsof`-style FD inspection in CI as well. | T4   |
| FR-12 | A forward-reference banner MUST be emitted at phase start (before any per-specialist prompts) explicitly stating: "Live-run verification of this chain happens in phase 12 (CI). Run phase 12 to gate PRs on these findings. See PRD-015 for the live-run path." | T4   |
| FR-13 | If `<repo>/.autonomous-dev/reviewer-chains.yaml` already exists: probe `reviewer_chain_yaml_matches` (SPEC-033-3-01). On `already-complete` → skip prompts (operator confirms re-run is unnecessary). On `resume-with-diff` → operator chooses keep/replace; merging is NOT supported (chain order is operator-determined, conflict resolution is non-trivial). | T4   |
| FR-14 | The module MUST write to a temp file `reviewer-chains.yaml.tmp` and atomic-rename to `reviewer-chains.yaml` only after writing completes successfully (per PLAN-033-3 risk row "Existing reviewer-chains.yaml is corrupted by half-written re-run on Ctrl-C"). | T4   |
| FR-15 | The module MUST issue exactly one SIGHUP to the daemon at phase end (skipped in headless eval). | T4   |
| FR-16 | The module MUST NOT post comments, MUST NOT create PRs, MUST NOT invoke any cloud-hosted LLM during dry-run. The eval set's `happy-path.md` asserts this via cost-counter (TDD-020 dry-run contract: 0 model invocations). | T4   |
| FR-17 | An eval directory at `plugins/autonomous-dev-assist/evals/test-cases/setup-wizard/phase-15-reviewer-chains/` MUST contain four cases: `happy-path.md`, `skip-with-consequence.md`, `error-recovery.md`, `idempotency-resume.md`. | T5   |
| FR-18 | `happy-path.md` MUST: enable security (weight=1) and performance (weight=2); write chain.yaml; dry-run dispatches both; each posts a finding or "no findings"; forward-reference banner asserted in transcript; state written. | T5   |
| FR-19 | `happy-path.md` MUST also assert: cost-counter==0 (TDD-020 dry-run no-LLM contract); fs-snapshot diff allow-list (FR-11); chain.yaml ordering deterministic (security before performance in serialized form). | T5   |
| FR-20 | `skip-with-consequence.md` MUST set `wizard.skip_phase_15=true` and assert: verbatim consequence text emitted; no chain.yaml written; phases.15.status="skipped"; daemon SIGHUPs delta=0. | T5   |
| FR-21 | `error-recovery.md` MUST cover three sub-cases: (a) catalog file missing or malformed → diagnostic + abort; (b) operator-supplied weight non-numeric → re-prompt up to 3 times; (c) existing chain.yaml is malformed YAML → operator chooses replace (overwrite) or aborts. | T5   |
| FR-22 | `idempotency-resume.md` MUST cover four sub-cases: (a) chain.yaml hash matches → already-complete; (b) chain.yaml exists with different hash → operator picks keep → no rewrite, dry-run still runs; (c) operator picks replace → overwrite → dry-run; (d) phase killed mid-enumeration → re-run resumes at next un-prompted specialist; no partial chain.yaml written. | T5   |
| FR-23 | The four-case suite MUST achieve ≥ 90% pass rate per TDD-033 §9.3. | T5   |
| FR-24 | `plugins/autonomous-dev-assist/config_defaults.json` MUST contain `wizard.phase_14_module_enabled: true` and `wizard.phase_15_module_enabled: true`. | T6   |
| FR-25 | Toggling either flag to `false` MUST cause the orchestrator to emit "Phase NN unavailable" and continue (per SPEC-033-1-03 FR-4). | T6   |

## 3. Non-Functional Requirements

| Requirement                       | Target                                                                  | Measurement Method                                                |
|-----------------------------------|-------------------------------------------------------------------------|-------------------------------------------------------------------|
| Eval pass rate                    | ≥ 90%                                                                    | eval framework score                                              |
| Dry-run no-LLM                    | 0 model API calls during dry-run                                         | cost-counter via TDD-020 instrumentation                          |
| Dry-run isolation                 | 0 fs writes outside allow-list                                           | fs-snapshot diff per case                                         |
| Chain ordering determinism        | Same operator inputs → byte-identical chain.yaml across runs             | bats hash equality test                                           |
| Atomic write                      | Ctrl-C mid-write leaves either old chain.yaml intact OR new file complete; never half-written | kill-mid-write bats test                |
| Catalog drift resilience          | New catalog entries land without eval re-author                          | synthetic catalog injection bats test                             |
| Forward-reference banner emitted  | Banner appears exactly once before any per-specialist prompts            | transcript regex assertion                                        |
| Phase total runtime (happy)       | < 90 s wall clock                                                        | eval framework duration                                            |

## 4. Technical Approach

**File: `plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-15-reviewer-chains.md`**

```yaml
---
phase: 15
title: "Specialist reviewer chains"
amendment_001_phase: 15
tdd_anchors: [TDD-020, TDD-021]
prd_links: [PRD-015]
required_inputs:
  phases_complete: [1,2,3,4,5,6,7]
  config_keys:
    - standards.path  # soft requirement; phase warns but does not abort if missing
optional_inputs:
  existing_chain_yaml: true
skip_predicate: "skip-predicates.sh phase_15_skip_predicate"
skip_consequence: |
  Only the generic reviewer will run; security/performance/accessibility findings will not be surfaced automatically.
idempotency_probe: "idempotency-checks.sh phase-15-probe"
output_state:
  config_keys_written:
    - reviewer_chains.path
    - reviewer_chains.last_dry_run_at
    - reviewer_chains.specialists_enabled_count
  files_created:
    - "<repo>/.autonomous-dev/reviewer-chains.yaml"
  external_resources_created: []
verification:
  - "reviewer-chains.yaml exists and parses"
  - "Each enabled specialist appears in dry-run dispatch output"
  - "Cost counter == 0 (no LLM invocations)"
  - "Forward-reference to phase 12 emitted"
  - "Daemon SIGHUP issued"
eval_set: "evals/test-cases/setup-wizard/phase-15-reviewer-chains/"
---
```

**Idempotency probe wrapper** (`idempotency-checks.sh phase-15-probe`):
```
1. Compute current expected hash from catalog enumeration + operator-confirmed config (if no operator-confirmed yet, treat as start-fresh)
2. result=$(reviewer_chain_yaml_matches <repo>/.autonomous-dev/reviewer-chains.yaml <expected>)
3. If start-fresh → emit start-fresh
4. If resume-with-diff → emit resume-from:enumerate
5. If already-complete → also check `reviewer_chains.last_dry_run_at` is within last 7 days; if stale → emit resume-from:dry-run; else already-complete
```

(The "expected hash" computation requires re-enumerating the catalog and re-applying default weights/thresholds; in practice, the probe uses a simpler heuristic — file-exists + config keys present + recent dry-run — to avoid re-prompting before knowing operator intent.)

**Module body steps:**

| Step name              | Behavior                                                                                                                  |
|------------------------|---------------------------------------------------------------------------------------------------------------------------|
| `intro-and-fwdref`     | Banner including the FR-12 forward-reference text. Emitted exactly once.                                                   |
| `read-catalog`         | Load `specialist-reviewers.json`; abort with diagnostic if missing/malformed.                                              |
| `existing-decision`    | If chain.yaml exists → keep/replace prompt (no merge for FR-13).                                                           |
| `enumerate`            | For each catalog entry (ordered by id): y/N enable; on y → weight (numeric, retry on non-numeric ≤3) + threshold prompts.  |
| `sort-and-render`      | Sort enabled specialists by weight asc, id asc. Render YAML to `reviewer-chains.yaml.tmp`.                                 |
| `atomic-rename`        | `mv reviewer-chains.yaml.tmp reviewer-chains.yaml`.                                                                         |
| `dry-run-verify`       | `autonomous-dev reviewer-chain dry-run --against HEAD~1..HEAD --json`. Parse output; assert each enabled specialist is dispatched (finding or "no findings"). |
| `cost-counter-check`   | Read TDD-020's cost-counter instrumentation (a sidecar log or stdout marker); assert == 0.                                 |
| `write-config`         | Write the three config keys (path, last_dry_run_at=now, specialists_enabled_count).                                        |
| `sighup`               | SIGHUP daemon (skipped in headless eval).                                                                                  |
| `summary`              | Verification line per TDD-033 §10.5.                                                                                        |

**Forward-reference banner shape (FR-12):**
```
================================================================
NOTE: This phase configures specialist reviewer chains for DRY-RUN
verification only. Live-run verification — where these specialists
gate PR merges — happens in phase 12 (CI workflows + branch
protection).

If you have not yet run phase 12, your chain configuration here
will be saved but will not affect actual PRs until you do.

  Run phase 12:        autonomous-dev wizard --phase 12
  Live-run reference:  docs/prds/PRD-015-ci-cd-pipeline-and-chain-orchestration.md
================================================================
```

The eval `happy-path.md` regex-asserts this banner appears in the transcript.

**Eval set design:**

`happy-path.md`:
- Inputs: enable security (weight=1, threshold=high), performance (weight=2, threshold=medium); skip others.
- Assertions: chain.yaml exists; sorted security-then-performance; both specialists in dry-run output; cost-counter==0; fs-snapshot diff allow-list; forward-reference banner regex matched; SIGHUP delta=1; phases.15.status==complete.

`skip-with-consequence.md`:
- Input: `wizard.skip_phase_15=true`.
- Assertions: verbatim consequence text; no chain.yaml; SIGHUP delta=0; status=skipped.

`error-recovery.md`:
- Sub-A: catalog file removed → phase exits at read-catalog with diagnostic.
- Sub-B: operator types non-numeric weight → re-prompt; on 3rd failure → abort with diagnostic.
- Sub-C: existing chain.yaml is YAML-malformed → operator picks replace → overwrite + dry-run.

`idempotency-resume.md`:
- Sub-A: hash matches + recent dry-run → already-complete.
- Sub-B: existing different-hash → operator picks keep → no rewrite; dry-run still runs against existing chain.
- Sub-C: existing different-hash → operator picks replace → overwrite + dry-run.
- Sub-D: SIGTERM mid-enumerate (after 2 of 5 specialists prompted) → re-run resumes at specialist #3; no partial chain.yaml on disk (only chain.yaml.tmp from the prior run, which is unlinked on resume).

**Atomic-write proof (FR-14):**

The `mv reviewer-chains.yaml.tmp reviewer-chains.yaml` is atomic on POSIX filesystems. The bats kill-mid-write test (`P15-A01`) confirms by SIGKILL during the YAML render step (before `mv`); the test asserts that `reviewer-chains.yaml` is either the prior version or absent (never partially written), and any orphan `.tmp` file is unlinked on the next phase entry.

**Catalog drift resilience (NFR catalog drift):**
- A bats test injects a synthetic `specialist-reviewers.json` containing a new entry (e.g., `experimental-supply-chain`).
- Runs the phase; asserts the new entry is prompted; asserts the phase module file is unchanged (no entry-specific code paths).

## 5. Interfaces and Dependencies

**Consumed:**
- SPEC-033-1-01/02/03: orchestrator + state + helpers.
- SPEC-033-3-01: `reviewer_chain_yaml_matches` helper.
- TDD-020: specialist reviewer catalog + chain runtime + `reviewer-chain dry-run` CLI + cost-counter instrumentation.
- TDD-021: standards reference (some specialists are standards-aware).
- PRD-015: live-run path (forward-reference target).
- `plugins/autonomous-dev/config/specialist-reviewers.json` — catalog.

**Produced:**
- `phases/phase-15-reviewer-chains.md`.
- `phase_15_skip_predicate` helper (≤ 10 LOC).
- `phase-15-probe` idempotency wrapper (≤ 50 LOC).
- Four eval case files.
- `wizard.phase_14_module_enabled: true` and `wizard.phase_15_module_enabled: true` in `config_defaults.json`.

## 6. Acceptance Criteria

### Front-matter contract (FR-1, FR-2)

```
Given phases/phase-15-reviewer-chains.md
When parsed by yq
Then phase=15 and tdd_anchors == ["TDD-020","TDD-021"]
And prd_links == ["PRD-015"]
And output_state.files_created == ["<repo>/.autonomous-dev/reviewer-chains.yaml"]
```

### Skip-with-consequence (FR-3, FR-4, FR-20)

```
Given wizard.skip_phase_15 == true
When phase 15 enters
Then predicate exits 0
And FR-4 verbatim consequence text emitted
And phases.15.status == "skipped"
And no chain.yaml written
And SIGHUP delta == 0
```

### Catalog data-drivenness (FR-7, NFR catalog drift)

```
Given specialist-reviewers.json contains [security, performance, accessibility]
When enumerate runs
Then operator is prompted for each in catalog order

Given a synthetic catalog with extra entry "experimental-supply-chain"
Then the new entry is prompted
And the phase module file is unchanged
```

### Chain ordering determinism (FR-9, NFR ordering)

```
Given operator enables [security@weight=2, performance@weight=1, accessibility@weight=2]
When sort-and-render runs
Then the serialized YAML lists "performance" first, then "accessibility" then "security"
(weight asc; ties broken by id asc: accessibility < security alphabetically)

Given the same inputs replayed in a separate run
Then the resulting chain.yaml is byte-identical to the prior run
```

### Forward-reference banner (FR-12)

```
Given any execution path that does not skip the phase
When the transcript is captured
Then the FR-12 verbatim banner text appears exactly once
And the banner appears before any per-specialist prompt
```

### Dry-run dispatches each specialist (FR-10, FR-19)

```
Given chain.yaml has [security, performance]
When dry-run-verify runs
Then `autonomous-dev reviewer-chain dry-run --against HEAD~1..HEAD --json` is invoked
And the output JSON's `dispatched_specialists` field contains both "security" and "performance"
And each appears with status="finding" or status="no-findings"
```

### Dry-run no-LLM (FR-16, NFR no-LLM)

```
Given the cost-counter is reset before dry-run-verify
When dry-run-verify runs
Then the post-counter value is 0 (no model API calls recorded)
```

### Dry-run isolation (FR-11, NFR isolation)

```
Given fs-snapshot taken before phase 15 runs
When the phase completes
Then post-snapshot diff shows only the documented allow-list changed:
  - <repo>/.autonomous-dev/reviewer-chains.yaml
  - ~/.autonomous-dev/wizard-state.json
  - ~/.autonomous-dev/wizard-checkpoint.json
  - ~/.autonomous-dev/logs/wizard.log
```

### Atomic write (FR-14, NFR atomic write)

```
Given phase 15 is mid-render writing reviewer-chains.yaml.tmp
When SIGKILL is sent
Then reviewer-chains.yaml is either absent OR the prior version intact
And reviewer-chains.yaml.tmp may exist but is unlinked on next phase entry
```

### Existing-yaml decision (FR-13)

```
Given chain.yaml exists with a hash != current expected
When existing-decision step runs
Then operator is prompted keep/replace (NO merge option)
And on keep: no rewrite; dry-run still runs against existing
And on replace: overwrite via tmp+atomic-rename
```

### Eval pass + four cases (FR-17–FR-23)

```
Given the four eval cases run via the eval framework
Then per-case pass rate ≥ 90%
And happy-path covers all 6 happy-path assertions
And idempotency-resume covers all four sub-cases
```

### Feature flag defaults (FR-24, FR-25)

```
Given config_defaults.json
Then wizard.phase_14_module_enabled == true
And wizard.phase_15_module_enabled == true

Given operator config wizard.phase_15_module_enabled = false
When orchestrator reaches phase 15
Then it emits "Phase 15 unavailable; will be re-enabled in next release"
And continues without crashing
```

## 7. Test Requirements

**bats — `tests/setup-wizard/phase-15.bats`:**

| Test ID  | Scenario                                  | Assert                                                |
|----------|-------------------------------------------|-------------------------------------------------------|
| P15-101  | Front-matter parse                         | yq returns expected values                            |
| P15-201  | Skip via flag                              | predicate true; consequence emitted                   |
| P15-301  | Catalog data-driven                        | synthetic entry produces a prompt                     |
| P15-401  | Sort determinism                           | byte-identical chain.yaml across replays              |
| P15-501  | Forward-reference banner                   | regex matched once, before prompts                    |
| P15-601  | Dry-run dispatches each enabled specialist | JSON parse asserts list                               |
| P15-602  | Dry-run cost-counter == 0                  | counter delta == 0                                    |
| P15-701  | Dry-run isolation                          | fs-snapshot diff allow-list only                      |
| P15-801  | Atomic-write SIGKILL                       | no half-written file                                  |
| P15-901  | Existing-yaml keep                         | no rewrite                                            |
| P15-902  | Existing-yaml replace                      | overwrite via tmp+rename                              |
| P15-A01  | Mid-enumerate resume                       | resumes at next specialist; no partial chain.yaml     |
| P15-B01  | Already-complete                           | probe emits already-complete                          |
| P15-C01  | Feature flag default true                  | config_defaults.json has both flags true              |
| P15-C02  | Feature flag override false works          | "unavailable" message; no crash                       |

**Eval cases:** four files as outlined.

**Mocking:**
- `autonomous-dev reviewer-chain dry-run` shim that emits canned JSON listing the dispatched specialists with finding/no-findings status.
- A cost-counter instrumentation hook (sidecar log) controllable by the eval framework.
- Synthetic catalog fixtures.

## 8. Implementation Notes

- The `requires_standards` flag in catalog entries is informational only at this phase. If a specialist requires standards but `standards.path` is unset (phase 14 not run), the phase emits a warning ("Specialist '<id>' requires standards.yaml; you may want to run phase 14 first") but does NOT block enabling.
- Chain ordering uses ascending weight; if operators want a specialist to run last they assign a high weight. Document this in the module body.
- The cost-counter instrumentation is contracted by TDD-020. If TDD-020 changes the instrumentation surface (e.g., from sidecar log to stdout marker), this SPEC's `cost-counter-check` step adapts; the contract is "phase 15 can read a 0-or-positive integer count after dry-run".
- The `reviewer-chain dry-run --json` CLI surface is assumed to exist per TDD-020. If the surface differs (e.g., dry-run output is text not JSON), the parser in dry-run-verify adapts; document in Implementation Notes.
- The forward-reference banner is operator-facing prose; reviewer should validate clarity in addition to mechanical FR-12 / `P15-501` checks.

## 9. Rollout Considerations

- Feature flag `wizard.phase_15_module_enabled` (default `true`). Stage 1 rollout per TDD-033 §8.2.
- Rollback: `autonomous-dev wizard rollback --phase 15` (SPEC-033-4-05) restores the three config keys and prompts before deleting `<repo>/.autonomous-dev/reviewer-chains.yaml`.
- The phase 14 / phase 15 default flags ship via this SPEC (FR-24); the corresponding phase 16 flag is added in SPEC-033-4-05 as part of Stage 4 canary.

## 10. Effort Estimate

| Activity                                      | Estimate |
|-----------------------------------------------|----------|
| Front-matter + module body                    | 0.75 day |
| Idempotency wrapper + skip wrapper + atomic-write logic | 0.25 day |
| Eval cases (4)                                | 0.5 day  |
| Unit tests (bats)                             | 0.25 day |
| Feature flag defaults edit + bats             | 0.1 day  |
| Forward-reference banner copy review           | 0.15 day |
| **Total**                                     | **2 day** |
