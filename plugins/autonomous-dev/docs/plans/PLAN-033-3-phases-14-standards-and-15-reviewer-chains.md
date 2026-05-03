# PLAN-033-3: Phase Modules 14 (Engineering Standards) & 15 (Specialist Reviewer Chains)

## Metadata
- **Parent TDD**: TDD-033-setup-wizard-phase-modules
- **Parent PRD**: AMENDMENT-002 (extends AMENDMENT-001)
- **Estimated effort**: 4 days (both phases are M per TDD-033 §13)
- **Dependencies**: [PLAN-033-1]
- **Blocked by**: [PLAN-033-1]
- **Priority**: P1
- **Stage**: Rollout Stage 1 per TDD-033 §8.2 (lowest-risk; ships alongside PLAN-033-1's phase 8)

## Objective

Land the two reviewer-side phase modules:

1. **Phase 14** -- Engineering standards bootstrap. Detects the repo's
   primary language, offers a bundled standards pack (or "author your own"),
   writes `<repo>/.autonomous-dev/standards.yaml`, exercises the prompt
   renderer (SPEC-021-3-01), runs the standards-meta-reviewer in dry-run
   mode (SPEC-021-3-02), and optionally enables two-person-approval for
   fix-recipe applications.
2. **Phase 15** -- Specialist reviewer chains. Enumerates bundled
   specialists (security, performance, accessibility, db-migration,
   dependency-update), lets the operator configure chain order and
   per-specialist thresholds, writes `<repo>/.autonomous-dev/reviewer-chains.yaml`,
   and verifies via `autonomous-dev reviewer-chain dry-run`.

Both phases are read/dry-run only on the operator's repo (no PR creation, no
CI invocation). Live-run verification of the chain happens in phase 12 (CI);
phase 15 carries a forward-reference per TDD-033 §6.6.

## Scope

### In Scope
- `phases/phase-14-eng-standards.md` per TDD-033 §6.5 covering:
  - Auto-detect primary language (TS/JS/Python/Go) via `autonomous-dev detect-language --repo <path>`; surface result for operator confirmation/override.
  - Offer matching bundled pack (`typescript-strict`, `python-pep8`, etc.) or "author your own".
  - Write `<repo>/.autonomous-dev/standards.yaml` from chosen pack template.
  - Validate via `autonomous-dev standards validate --repo <path>` (TDD-021 schema validator).
  - Run `autonomous-dev standards-meta-reviewer --dry-run --against HEAD~5..HEAD`; capture findings JSON to `<repo>/.autonomous-dev/standards-dry-run-$(date).json`.
  - Exercise prompt renderer at least once: `autonomous-dev standards render-prompt --rule-id <pack>:<sample-rule>` returns formatted STANDARDS_SECTION (per SPEC-021-3-01).
  - Optional two-person-approval flag (per SPEC-021-3-02 contract): `standards.two_person_approval_enabled`.
  - Skip-with-consequence: "author agents will not be standards-aware; code may violate team conventions silently."
  - Idempotency: existing `standards.yaml` triggers diff offer (merge vs replace); two-person-approval flag is a single key (re-set is no-op); dry-run findings file is dated (one per day, no accumulation).
- `phases/phase-15-reviewer-chains.md` per TDD-033 §6.6 covering:
  - Enumerate `plugins/autonomous-dev/config/specialist-reviewers.json` catalog.
  - Per-specialist enable + chain-order weight + threshold override (operator-facing UI is a numeric weight; rendered as a sorted list before write).
  - Write `<repo>/.autonomous-dev/reviewer-chains.yaml`.
  - Dry-run verify via `autonomous-dev reviewer-chain dry-run --against HEAD~1..HEAD`; assert each enabled specialist posts a finding (or "no findings") proving runtime can dispatch.
  - Forward-reference banner: "live-run verification of this chain happens in phase 12 (CI). Run phase 12 to gate PRs on these findings."
  - Skip-with-consequence: "only the generic reviewer will run; security/performance/accessibility findings will not be surfaced automatically."
  - Idempotency: chain YAML fully replaced on re-run after operator confirms diff; dry-run is read-only.
- Per-phase eval sets (four cases each per TDD-033 §9.1):
  - `evals/test-cases/setup-wizard/phase-14-eng-standards/{happy-path,skip-with-consequence,error-recovery,idempotency-resume}.md`.
  - `evals/test-cases/setup-wizard/phase-15-reviewer-chains/{happy-path,skip-with-consequence,error-recovery,idempotency-resume}.md`.
- Feature flags `wizard.phase_14_module_enabled` and `wizard.phase_15_module_enabled` (defaults `true`).
- Helper additions to `lib/idempotency-checks.sh`: `standards_yaml_exists_at <path>`, `reviewer_chain_yaml_matches <path> <expected-hash>`.

### Out of Scope
- Phase modules 8, 11, 12, 13, 16 (other PLAN-033-N).
- Authoring new standards packs or new specialist reviewers (AMENDMENT-002 NG-04).
- Modifying TDD-021 prompt renderer / fix-recipe / meta-reviewer surfaces (TDD-033 NG-05).
- Live PR-gated specialist runs -- phase 12 owns that path; phase 15 only proves dry-run dispatchability.
- Custom-pack authoring UX -- phase 14 supports "author your own" but does not embed a YAML editor; operator edits the file post-phase.

## Tasks

1. **Extend `lib/idempotency-checks.sh` with phase-14/15 helpers.** Add `standards_yaml_exists_at <path>` (returns `start-fresh` | `resume-with-diff` | `already-complete`); `reviewer_chain_yaml_matches <path> <hash>` (same return shape).
   - Files to modify: `plugins/autonomous-dev-assist/skills/setup-wizard/lib/idempotency-checks.sh`. Tests: extend bats from PLAN-033-1.
   - Acceptance: Both helpers are read-only (fs-snapshot diff invariant). Truth table covers missing / outdated / matching states.
   - Effort: 0.25 day.

2. **Author `phases/phase-14-eng-standards.md`.** Per TDD-033 §6.5 + AMENDMENT-002 §4.5. Front-matter `tdd_anchors: [TDD-021]`. Operator-facing flow: detect language → confirm → offer pack → write standards.yaml → validate → dry-run meta-reviewer → render-prompt smoke → optional two-person-approval → SIGHUP daemon if config touched.
   - Files to create: `plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-14-eng-standards.md`.
   - Acceptance: All twelve front-matter keys validate. Detection result surfaced for operator confirmation (override allowed) per TDD-033 §6.5. The prompt renderer is exercised at least once (AMENDMENT-002 AC-03 anchor: "exercises the prompt renderer at least once"). Dry-run findings written to dated file (one per day). Two-person-approval flag is wired to SPEC-021-3-02's contract.
   - Effort: 1 day.

3. **Author phase-14 eval set (four cases).**
   - `happy-path.md`: detection returns TS → operator confirms → offers `typescript-strict` pack → writes `standards.yaml` → `standards validate` exit 0 → meta-reviewer dry-run returns findings JSON without crash → prompt-renderer returns non-empty STANDARDS_SECTION → two-person-approval enabled.
   - `skip-with-consequence.md`: operator skips → consequence text "author agents will not be standards-aware..." emitted → no `standards.yaml` written → phase exits.
   - `error-recovery.md`: detection returns "unknown" → wizard prompts manual override; if operator picks `python-pep8` against a TS repo, validate step fails with diagnostic and offers re-pick. Bad-pack-template case: pack file missing → phase exits with pointer to `/autonomous-dev-assist:troubleshoot`.
   - `idempotency-resume.md`: existing `standards.yaml` present → wizard offers diff → operator picks "merge" → merged file validates → re-run a third time with no changes is a no-op (`standards_yaml_exists_at` returns `already-complete`).
   - Files to create: `plugins/autonomous-dev-assist/evals/test-cases/setup-wizard/phase-14-eng-standards/*.md`.
   - Acceptance: ≥90% pass. Prompt-renderer exercise asserted in `happy-path.md`. Dry-run findings file matches the dated pattern.
   - Effort: 0.75 day.

4. **Author `phases/phase-15-reviewer-chains.md`.** Per TDD-033 §6.6 + AMENDMENT-002 §4.6. Front-matter `tdd_anchors: [TDD-020, TDD-021]`. Operator-facing flow: enumerate catalog → per-specialist enable + weight + threshold → write `reviewer-chains.yaml` → dry-run verify → forward-reference banner to phase 12.
   - Files to create: `plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-15-reviewer-chains.md`.
   - Acceptance: Front-matter validates. Catalog read is data-driven from `specialist-reviewers.json`. Chain order is preserved across re-runs (sorted by weight, stable). Forward-reference banner explicitly names "phase 12 (CI)" and links to PRD-015 for the live-run path. Dry-run is read-only.
   - Effort: 1 day.

5. **Author phase-15 eval set (four cases).**
   - `happy-path.md`: enable security + performance with weights 1, 2 → write chain.yaml → dry-run dispatches both → each posts a finding (or "no findings") → forward-reference banner emitted → state written.
   - `skip-with-consequence.md`: skip → consequence text "only generic reviewer will run; security/performance/accessibility findings will not be surfaced automatically" → phase exits.
   - `error-recovery.md`: catalog file missing OR malformed → wizard exits with diagnostic; partial-write case (chain.yaml exists but malformed YAML) → diff offer + operator chooses "replace" or aborts.
   - `idempotency-resume.md`: existing `reviewer-chains.yaml` matching current hash → `already-complete`; mismatched hash → diff offer + operator confirms replace; resume after kill mid-enumeration writes no partial chain.yaml.
   - Files to create: `plugins/autonomous-dev-assist/evals/test-cases/setup-wizard/phase-15-reviewer-chains/*.md`.
   - Acceptance: ≥90% pass. Forward-reference banner asserted in `happy-path.md`. Dry-run is read-only (fs-snapshot diff invariant).
   - Effort: 0.75 day.

6. **Add feature-flag defaults.** `wizard.phase_14_module_enabled: true`, `wizard.phase_15_module_enabled: true`.
   - Files to modify: `config_defaults.json`.
   - Acceptance: Toggling to `false` produces "unavailable" path; subsequent phases continue.
   - Effort: 0.25 day.

## Dependencies & Integration Points

**Exposes to other plans:**
- `phases/phase-15-reviewer-chains.md`'s forward-reference pattern (banner pointing to a later phase for live-run verification) -- reusable if future phases gain a similar split between dry-run-here / live-run-elsewhere.
- The "diff-offer on existing config file" idempotency UX -- pattern reused by PLAN-033-4 phase 16 plugin install.

**Consumes from other plans:**
- **PLAN-033-1** (blocking): orchestrator loop, `_phase-contract.md`, `lib/*.sh` baseline.
- TDD-021 -- standards schema validator, prompt renderer (SPEC-021-3-01), meta-reviewer (SPEC-021-3-02), fix-recipe (SPEC-021-3-03).
- TDD-020 -- specialist reviewer catalog and chain runtime.
- PRD-014 -- project-detection logic for language auto-detect.

**Coordination boundary**: Phase 14 exercises TDD-021's surfaces; if SPEC-021-3-02's two-person-approval contract evolves, phase 14's flag wiring updates with it (eval-set asserts the flag's effect via the meta-reviewer's behavior on a fix-recipe-application probe).

## Testing Strategy

- **Per-phase eval sets** at ≥90% pass per AMENDMENT-002 AC-03.
- **Prompt-renderer exercise gate**: phase 14 happy-path eval asserts the renderer returned a non-empty STANDARDS_SECTION matching the SPEC-021-3-01 schema. If the renderer regresses, phase 14 eval fails.
- **Dry-run isolation invariant**: fs-snapshot diff before/after phase 14's meta-reviewer invocation and phase 15's reviewer-chain dry-run. The only allowed writes are: `standards.yaml`, dated `standards-dry-run-*.json`, `reviewer-chains.yaml`. Any other write fails the eval.
- **Idempotency probe correctness**: `standards_yaml_exists_at` and `reviewer_chain_yaml_matches` truth-table assertions (missing / outdated / matching).
- **Catalog drift resilience**: phase 15 eval asserts structure (≥1 specialist enabled with weight + threshold), not specific names; new bundled specialists land without phase-15 eval re-author.
- **Cross-phase composition**: smoke test that running PLAN-033-1 (orchestrator + phase 8) + PLAN-033-3 (phases 14, 15) end-to-end produces a fresh-checkout state where the daemon picks up the new standards + reviewer chain after SIGHUP.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Standards pack disagrees with operator's existing conventions; phase 14 silently overwrites their style | Medium | Medium -- operator productivity hit | Idempotency probe surfaces existing `standards.yaml` and offers diff before any write. Operator can edit the file post-phase; phase 20 summary reminds them. Per TDD-033 §15 risk row "phase 14 standards pack disagrees with operator's existing conventions". |
| Language auto-detect returns wrong language for polyglot repos | Medium | Low -- operator just overrides | Detection result is presented for confirmation (not auto-accepted). Operator override is one-key acceptance. Documented in `error-recovery.md` eval. |
| Specialist catalog growth makes the per-specialist prompt loop tedious | Low | Low -- UX papercut | Loop supports "enable all defaults" shortcut. Eval asserts shortcut behavior matches per-specialist explicit enables. |
| TDD-021 prompt renderer regression breaks phase 14 silently | Low | Medium -- standards file written but renderer broken | Phase 14 eval `happy-path.md` MUST assert renderer returns non-empty STANDARDS_SECTION; failure mode is "phase 14 eval fails", not "phase 14 silently skips". |
| Two-person-approval flag set but the contract isn't enforced downstream | Low | Medium -- operator thinks they have approval gating but don't | Eval asserts a fix-recipe-application probe with the flag set produces the expected meta-reviewer interception. If SPEC-021-3-02 contract is broken, the eval fails. |
| Reviewer chain dry-run actually runs the specialist agents (model calls), incurring cost | Medium | Low -- token spend | TDD-020's `dry-run` flag is contract-checked: dry-run dispatches the chain runtime but specialists return a stub finding without invoking the underlying LLM. If a specialist's dry-run path invokes a real model, the eval surfaces the cost line and fails the regression. |
| Existing `reviewer-chains.yaml` is corrupted by half-written re-run on Ctrl-C | Low | Medium -- operator re-config required | Wizard writes to `reviewer-chains.yaml.tmp` then atomic-renames after validation. Checkpoint file at `~/.autonomous-dev/wizard-checkpoint.json` records the half-written state for recovery. |

## Definition of Done

- [ ] `phases/phase-14-eng-standards.md` ships with valid front-matter; eval set scores ≥90% pass.
- [ ] `phases/phase-15-reviewer-chains.md` ships with valid front-matter; eval set scores ≥90% pass.
- [ ] Phase 14 happy-path eval asserts the prompt renderer returned a non-empty STANDARDS_SECTION (SPEC-021-3-01 surface exercised at least once per AMENDMENT-002 AC-03).
- [ ] Phase 14 happy-path eval asserts the meta-reviewer dry-run returned findings JSON without crashing (SPEC-021-3-02 surface exercised).
- [ ] Phase 14 two-person-approval flag is wired to SPEC-021-3-02's contract; eval probes the fix-recipe-application interception.
- [ ] Phase 15 happy-path eval asserts the reviewer-chain dry-run dispatches each enabled specialist (or "no findings" return).
- [ ] Phase 15 forward-reference banner explicitly names "phase 12 (CI)" as the live-run path.
- [ ] Both phases' dry-run paths are read-only (fs-snapshot diff invariant; only allowed writes are the documented config files).
- [ ] Idempotency: re-running either phase against existing config triggers a diff offer, not a silent overwrite (TDD-033 §6.5/§6.6 idempotency clauses).
- [ ] Feature flags default to `true`; toggling to `false` produces "unavailable" path.
- [ ] Catalog reads are data-driven (eval cases assert structure, not specific names).
- [ ] No regressions in PLAN-033-1's phase 8 / phase 11 evals.
- [ ] Idempotency invariant holds (TDD-033 G-04).
