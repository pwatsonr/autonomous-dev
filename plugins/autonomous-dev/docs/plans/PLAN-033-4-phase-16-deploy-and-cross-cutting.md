# PLAN-033-4: Phase Module 16 (Deployment Backends) + Cross-Cutting Closeout

## Metadata
- **Parent TDD**: TDD-033-setup-wizard-phase-modules
- **Parent PRD**: AMENDMENT-002 (extends AMENDMENT-001)
- **Estimated effort**: 6 days (phase 16 is L per TDD-033 §13; cross-cutting is S)
- **Dependencies**: [PLAN-033-1, PLAN-033-2, PLAN-033-3]
- **Blocked by**: [PLAN-033-1, PLAN-033-2, PLAN-033-3]
- **Priority**: P0 (this is the closeout plan; AMENDMENT-002 acceptance criteria AC-06, AC-07, AC-08 land here)
- **Stage**: Rollout Stage 4 (deploy -- most sensitive) per TDD-033 §8.2

## Objective

Land the most sensitive phase module (phase 16) and the cross-cutting
closeout work that brings TDD-033 to acceptance:

1. **Phase 16** -- Deployment backends. Per environment (dev/staging/prod):
   choose a backend (`local`/`aws`/`gcp`/`azure`/`k8s`), install the
   corresponding plugin, route credentials through TDD-024's cred-proxy
   (NEVER copying the credential into wizard process or any file), apply
   the egress firewall allowlist, run the cost-cap-enforcer dry-run, and
   verify via `autonomous-dev deploy --dry-run`. The wizard MUST reject
   any operator input matching credential heuristics (`AKIA[0-9A-Z]{16}`,
   `ya29\.`, etc.) per TDD-033 §6.7 critical security invariant.
2. **Cred-proxy bridge real implementation** -- replaces the stub from
   PLAN-033-1 with the full TDD-024 integration.
3. **Phases 17-19 deferral notice** -- static text block per TDD-033 §6.8,
   inserted between phase 16 verification and the existing inline phase 20.
   AMENDMENT-002 AC-06 anchor.
4. **Phase 20 summary table extension** -- enumerate per-phase outcome
   (complete / skipped / failed) for every new phase module per TDD-033 §10.5.
5. **Full-flow extended E2E** -- single eval case running all phases
   against a fresh checkout with operator-skip on 11/12/16 and operator-yes
   on 8/13/14/15, asserting reach-phase-20-with-correct-state-summary per
   TDD-033 §9.2 and AMENDMENT-002 AC-07.
6. **Composition + idempotency closeout tests** -- prove no phase module
   corrupts state when re-run; no inter-phase ordering invariant is
   violated; full wizard rollback (`autonomous-dev wizard rollback --phase NN`)
   restores pre-phase config snapshot per TDD-033 §12.2.

## Scope

### In Scope
- `phases/phase-16-deploy-backends.md` per TDD-033 §6.7 covering:
  - Per-env (dev/staging/prod) backend choice (`local`/`aws`/`gcp`/`azure`/`k8s`).
  - For each non-`local` backend: invoke `autonomous-dev cred-proxy provision --backend <name> --env <env>` (per TDD-024); the wizard NEVER asks for, displays, or logs the credential. The cred-proxy returns an opaque handle.
  - Per-cloud backend: `autonomous-dev plugin install autonomous-dev-deploy-{aws|gcp|azure|k8s}`; verify post-install probe.
  - Egress firewall: `autonomous-dev firewall apply --allowlist-template <provider>-default --env <env>` (per TDD-024).
  - Cost estimate: `autonomous-dev deploy --dry-run --env <env> --estimate-only`; verify cost-cap-enforcer reports a bounded number (per PRD-017 FR-1701-1705).
  - Final dry-run: `autonomous-dev deploy --dry-run --env dev` exit 0 with structured plan output.
  - **Critical security invariant** (TDD-033 §6.7): credential-pattern scanner runs against every operator input. Patterns: `AKIA[0-9A-Z]{16}` (AWS access key), `ya29\.` (Google OAuth), `xoxb-...` (Slack -- shouldn't appear here but caught anyway), `-----BEGIN .* PRIVATE KEY-----`, generic `[A-Za-z0-9_-]{40,}` for high-entropy strings near `password`/`secret`/`key` keywords. Match → wizard exits with error before any write.
  - Skip-with-consequence: "only `local` backend configured; daemon cannot deploy to dev/staging/prod."
  - Idempotency: plugin install upsert (skip if already installed at matching version); cred-proxy provisioning keyed by `(backend, env)` (re-provision rotates handle with operator confirmation); firewall apply is declarative (re-apply with same template is no-op); dry-run deploy always idempotent.
- `lib/cred-proxy-bridge.sh` **full implementation** (replaces PLAN-033-1's stub) per TDD-024 invocation contract. Functions: `cred_proxy_provision <backend> <env>` (returns opaque handle on stdout, never prints credential), `cred_proxy_validate_handle <handle>` (existence + non-expired check), `cred_proxy_revoke <handle>` (for rollback). Header documents the security invariant: "this script's stdout MUST NOT contain credential material under any code path".
- Phase 17-19 deferral notice per TDD-033 §6.8 -- static text block emitted between phase 16 verification and the entry to existing inline phase 20. Includes link to `pwatsonr/autonomous-dev-homelab`. Not a phase module (no front-matter, no skip predicate).
- Phase 20 summary table extension per TDD-033 §10.5 -- existing inline phase 20 is updated to enumerate every new phase module (8, 11, 12, 13, 14, 15, 16) with status badge (complete / skipped / failed / unavailable). Operators on legacy 10-phase config see "phase NN: not run; run wizard --phase NN" hint.
- `evals/test-cases/setup-wizard/full-flow-extended.md` per TDD-033 §9.2 and AMENDMENT-002 AC-07 -- one E2E case running every phase against a fresh checkout with the documented skip/yes mix.
- `evals/test-cases/setup-wizard/phase-16-deploy-backends/{happy-path,skip-with-consequence,error-recovery,idempotency-resume,linked-prd-no-duplication,credential-leak}.md` -- six cases (the credential-leak case is an extension of TDD-033 §9.4 specific to phase 16).
- Wizard rollback CLI: `autonomous-dev wizard rollback --phase NN` per TDD-033 §12.2 -- reverts the config keys listed in the phase's `output_state.config_keys_written` to pre-phase values from the snapshot taken at phase start.
- Composition + idempotency closeout test suite under `tests/setup-wizard/composition.bats`.
- Feature flag `wizard.phase_16_module_enabled` (default `true` after Stage 4 canary; ships as `false` initially per TDD-033 §8.2 Stage 4 gate).

### Out of Scope
- Phase modules 8, 11, 12, 13, 14, 15 (PLAN-033-1, PLAN-033-2, PLAN-033-3).
- Phases 17-19 actual implementation -- deferred to `pwatsonr/autonomous-dev-homelab` (NG-01).
- Authoring new cloud backend plugins (NG-04 of AMENDMENT-002).
- Modifying TDD-024's cred-proxy CLI (NG-05 of TDD-033).
- Plugin-uninstall path (TDD-033 §16 open question 3 -- explicitly out-of-wizard).
- Multi-account / multi-org cloud setups -- one backend per env per operator.

## Tasks

1. **Implement `lib/cred-proxy-bridge.sh` full version.** Replace the PLAN-033-1 stub with TDD-024 integration. Functions: `cred_proxy_provision`, `cred_proxy_validate_handle`, `cred_proxy_revoke`. Header banner: "credentials NEVER appear on stdout from this script".
   - Files to modify: `plugins/autonomous-dev-assist/skills/setup-wizard/lib/cred-proxy-bridge.sh`.
   - Acceptance: Every code path in this file is asserted credential-free via the credential-pattern scanner running against the script's stdout for fuzzed inputs. The CI lint that fails on `cred_proxy_read_handle` calls in non-phase-16 modules is now enforceable (the function exists). bats tests for each function with mocked TDD-024 backend.
   - Effort: 1 day.

2. **Implement credential-pattern scanner helper.** `lib/credential-scanner.sh` with `scan_for_credential <input>` returning exit 0 (clean) / 1 (match found, with reason). Patterns documented in TDD-033 §6.7. Used by phase 16 inline AND by the eval framework as a regression gate.
   - Files to create: `plugins/autonomous-dev-assist/skills/setup-wizard/lib/credential-scanner.sh`, `plugins/autonomous-dev-assist/tests/setup-wizard/credential-scanner.bats`.
   - Acceptance: Scanner catches all six pattern families from TDD-033 §6.7. False-positive rate <5% on a corpus of 100 non-credential inputs (port numbers, URLs, hashes, env-var names). bats tests.
   - Effort: 0.5 day.

3. **Author `phases/phase-16-deploy-backends.md`.** Per TDD-033 §6.7 + AMENDMENT-002 §4.7. Front-matter `prd_links: [PRD-015]`. Operator-facing flow: per-env backend → plugin install → cred-proxy provision (handle-only) → firewall apply → cost-cap dry-run → final dry-run deploy → state write.
   - Files to create: `plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-16-deploy-backends.md`.
   - Acceptance: All twelve front-matter keys validate. Credential-pattern scanner runs against EVERY operator input field; first match aborts the phase. Cred-proxy is invoked as a subprocess with the credential entry happening in the cred-proxy's own TTY interaction (NOT the wizard's). The wizard receives only the opaque handle. PRD-015 cross-reference banner emits BEFORE plugin/firewall/deploy chain steps. Skip-with-consequence text matches TDD-033 §6.7.
   - Effort: 1.5 days.

4. **Author phase-16 eval set (six cases).**
   - `happy-path.md`: aws backend chosen for dev → plugin install → cred-proxy returns handle (handle-only assertion: handle is opaque, no credential characters) → firewall apply with `aws-default` template → cost-cap dry-run reports bounded number → final `deploy --dry-run` exit 0 with structured plan → state written → no cloud resources actually created.
   - `skip-with-consequence.md`: skip → consequence text "only `local` backend configured; daemon cannot deploy to dev/staging/prod" → only local backend in state.
   - `error-recovery.md`: plugin install fails (network or version mismatch) → wizard exits with diagnostic + pointer to troubleshoot; partial state recoverable on re-run. Cred-proxy provision fails → handle not written; phase exits without firewall or deploy steps.
   - `idempotency-resume.md`: plugin already installed at matching version → skip; cred-proxy handle exists → operator confirms keep vs rotate; firewall already applied with same template → no-op; final dry-run is always idempotent.
   - `linked-prd-no-duplication.md`: regex-scan rendered phase 16 output for ≥40 char verbatim sentences also appearing in PRD-015 chain content. Zero matches per AMENDMENT-002 AC-05.
   - `credential-leak.md`: AMENDMENT-002 AC-08 anchor. Inject candidate credentials into operator inputs (`AKIA...`, `ya29...`, etc.); assert phase exits with credential-pattern-scanner error BEFORE any write; assert no credential appears in stdout, wizard.log, eval transcript. Also assert: across the entire happy-path eval, no credential pattern appears in any wizard-emitted line (sweep of cred-proxy bridge stdout per task 1).
   - Files to create: `plugins/autonomous-dev-assist/evals/test-cases/setup-wizard/phase-16-deploy-backends/*.md`.
   - Acceptance: ≥90% pass on the eval set. `credential-leak.md` is mandatory and auto-fails the suite on any leak.
   - Effort: 1.5 days.

5. **Author phases 17-19 deferral notice.** Per TDD-033 §6.8 -- static text block (banner + 3-line body + link to homelab repo) inserted between phase 16 verification and the entry to existing inline phase 20. Not a phase module (no front-matter, no skip predicate, no eval cases).
   - Files to modify: `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md` (insert between orchestrator loop's phase-16 exit and the inline phase-20 entry).
   - Acceptance: Banner emitted exactly once, exactly between phase 16 and phase 20. Link to `pwatsonr/autonomous-dev-homelab` is correct. Not skippable; not interactive. Satisfies AMENDMENT-002 AC-06.
   - Effort: 0.25 day.

6. **Extend phase 20 summary table.** Per TDD-033 §10.5 -- update existing inline phase 20 to enumerate every new phase module (8, 11, 12, 13, 14, 15, 16) with status (complete / skipped / failed / unavailable). For each "not run" status (legacy 10-phase upgraders), print "run `wizard --phase NN`" hint.
   - Files to modify: `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md` (the existing inline phase 20 block only -- touch nothing else).
   - Acceptance: Phase 20 reads `~/.autonomous-dev/wizard-state.json` and emits one row per new phase. Legacy operators see hints; first-time operators see the actual outcomes. Existing phase 20 inline content is preserved (additive change).
   - Effort: 0.5 day.

7. **Author full-flow extended E2E.** Per TDD-033 §9.2 and AMENDMENT-002 AC-07 -- single eval case running all phases against a fresh checkout with operator-skip on 11, 12, 16 and operator-yes on 8, 13, 14, 15. Assert reach-phase-20-with-correct-state-summary.
   - Files to create: `plugins/autonomous-dev-assist/evals/test-cases/setup-wizard/full-flow-extended.md`.
   - Acceptance: E2E passes deterministically. Phase 20 summary correctly enumerates skipped vs complete states. No regressions on inline phases 1-7, 9, 10. AMENDMENT-002 AC-07 is satisfied.
   - Effort: 0.5 day.

8. **Implement `autonomous-dev wizard rollback --phase NN`.** Per TDD-033 §12.2 -- reverts config keys in the phase's `output_state.config_keys_written` to pre-phase snapshot. Snapshot is taken automatically at phase start at `~/.autonomous-dev/wizard-snapshots/phase-NN-pre.json`. Rollback is keyed per phase per attempt; multi-attempt rollback walks the snapshot stack.
   - Files to create or modify: `plugins/autonomous-dev/src/cli/commands/wizard-rollback.ts` (or wherever wizard CLI lives), tests under `plugins/autonomous-dev/tests/cli/`.
   - Acceptance: `wizard rollback --phase 16` restores `deploy.envs.*` config keys to pre-phase-16 values. Cred-proxy handles created during phase 16 are revoked via `cred_proxy_revoke` during rollback. Tests cover happy + multi-attempt + corrupt-snapshot edge cases.
   - Effort: 0.75 day.

9. **Composition + idempotency closeout tests.** `tests/setup-wizard/composition.bats` covering: (a) PLAN-033-1 + PLAN-033-2 + PLAN-033-3 + PLAN-033-4 modules all loaded together produce a coherent wizard run; (b) re-running any phase against fully-completed state is a no-op; (c) re-running any phase against partial state resumes correctly; (d) inter-phase ordering invariant (phase 12 must come after phase 7; phase 15 must come after phase 14) is enforced; (e) rollback walks back through phases without corrupting state.
   - Files to create: `plugins/autonomous-dev-assist/tests/setup-wizard/composition.bats`.
   - Acceptance: All five composition cases pass. Inter-phase ordering invariant violations are detected and surface a clear error (not silent corruption).
   - Effort: 0.5 day.

10. **Stage 4 canary criteria + feature-flag default flip.** Document Stage 4 gate in `STAGE-4-CANARY.md` (extends PLAN-033-2's STAGE-3): security review of cred-proxy bridge sign-off; ≥90% eval pass; zero credential leaks in transcripts. After gate satisfied, flip `wizard.phase_16_module_enabled` default from `false` to `true` in `config_defaults.json`.
    - Files to create: `plugins/autonomous-dev-assist/skills/setup-wizard/STAGE-4-CANARY.md`. Files to modify: `config_defaults.json`.
    - Acceptance: Gate is checkable. Default flip is the last commit in this plan (so PRs through the canary period see `false` until security sign-off recorded in PR description).
    - Effort: 0.25 day.

## Dependencies & Integration Points

**Exposes to other plans (final closeout):**
- `lib/cred-proxy-bridge.sh` full implementation -- consumed by future plans needing TDD-024 cred-proxy invocation.
- `lib/credential-scanner.sh` -- reusable as a CI lint or pre-commit hook for any project adopting autonomous-dev.
- `wizard rollback` CLI pattern -- reusable for any future per-phase mutation that needs reversal.
- Phase 20 summary table format -- consumed by any future phase module added to the wizard.

**Consumes from other plans:**
- **PLAN-033-1** (blocking): orchestrator loop, `_phase-contract.md`, `lib/cred-proxy-bridge.sh` stub (replaced here).
- **PLAN-033-2** (blocking): PRD-015 cross-link pattern (front-matter + banner + duplication eval); reused for phase 16.
- **PLAN-033-3** (blocking): completes the dependency chain so the full-flow E2E in task 7 can run all phases.
- TDD-023 -- deployment-backend framework.
- TDD-024 -- cred-proxy + egress firewall + cost estimation primitives.
- PRD-014 -- bundled vs plugin-based backend split, multi-env model, `local` backend default per FR-1419.
- PRD-015 / TDD-025 -- chain-level guidance for deploy / cred-proxy / firewall (linked, never inlined).
- PRD-017 -- cost-cap-enforcer outcome (FR-1701-1705).

## Testing Strategy

- **Per-phase eval set** (task 4) at ≥90% pass; the `credential-leak.md` case is an auto-fail.
- **Full-flow extended E2E** (task 7) is the AMENDMENT-002 AC-07 gate.
- **Composition test suite** (task 9) is the regression gate for inter-plan integration.
- **Credential-leak regression sweep**: across the entire phase-16 eval suite (all six cases), assert zero matches of any pattern from TDD-033 §6.7. Run as a single grep against the combined transcripts.
- **Cred-proxy invocation isolation**: verify cred-proxy subprocess runs in its own TTY context; the wizard process never has the credential in any descriptor (asserted via `lsof` / process FD inspection in a Linux-only test).
- **Rollback round-trip**: phase 16 forward → rollback → forward again produces identical state (within timestamp tolerance for the dated snapshot file).
- **Phase 17-19 deferral idempotency**: re-running the wizard end-to-end emits the deferral banner exactly once (between phase 16 and phase 20), no duplication on resumes.
- **Phase 20 summary correctness**: state file with mixed completion/skip/failed values produces the correctly-labeled summary table.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Credential string slips into wizard process despite all guards | Medium (subtle) | Critical -- credential disclosure | Defense in depth: stdin no-echo + credential-pattern scanner BEFORE write + cred-proxy as separate process + post-phase scanner sweep against transcripts. `credential-leak.md` eval is the regression gate. Manual security review of `cred-proxy-bridge.sh` is the Stage 4 canary gate per TDD-033 §8.2. |
| Cost-cap dry-run reports unbounded estimate (cost-cap-enforcer regression) | Low | Medium -- operator runs blind | Eval `happy-path.md` asserts the estimate is a finite number under a documented ceiling. If cost-cap-enforcer regresses (PRD-017 FR-1701-1705), phase 16 eval fails. |
| Each cloud-backend plugin enabled in phase 16 expands future deploy infra cost | Medium | Medium -- operator surprise | Pre-install cost projection step (per TDD-024 + PRD-017); explicit opt-in per backend; documented in phase prompt. |
| Cred-proxy returns handle but it's actually invalid (race on token expiry) | Medium | Medium -- deploy fails post-wizard | `cred_proxy_validate_handle` runs after provisioning; phase fails fast if invalid. Documented expiry: handles inherit cred-proxy's TTL. |
| Egress firewall misconfiguration locks legitimate traffic | Medium | Medium -- post-deploy outage | Default to provider's official-API allowlist (TDD-024); dry-run mode prints firewall diff before apply; rollback command revokes firewall via `autonomous-dev firewall rollback`. |
| Plugin install upsert misdetects matching version → skips upgrade an operator wanted | Low | Low -- operator re-runs with `--force` | Idempotency probe surfaces "currently installed: X.Y.Z; available: X.Y.Z+1; install? [y/N]". |
| Phase 17-19 deferral banner emitted in wrong place after some future phase reorder | Low | Low -- UX papercut | Banner is placed by anchor (between orchestrator-loop-end and inline-phase-20-start), not by line number. Composition test `composition.bats` asserts banner appears exactly between those anchors. |
| Phase 20 summary reads stale wizard-state.json (race with daemon SIGHUP) | Low | Low -- operator sees flicker | Phase 20 reads state under file lock; daemon SIGHUP doesn't write to wizard-state.json. |
| Wizard rollback restores config but external resources (cred-proxy handles, firewall rules) drift | Medium | Medium -- ghost resources | Rollback explicitly invokes `cred_proxy_revoke` and `autonomous-dev firewall rollback` for each external resource listed in `output_state.external_resources_created`. Tests cover the round-trip. |
| Full-flow extended E2E flakes on slow CI (probe-PR step from phase 12) | Medium | Low -- CI noise | Phase 12's probe-PR poll has a 5-min bound (TDD-033 §10.3 scalability). E2E pins CI to a runner with stable GitHub Actions latency. |

## Definition of Done

- [ ] `lib/cred-proxy-bridge.sh` full implementation lands; bats tests pass; CI lint catches non-phase-16 callers.
- [ ] `lib/credential-scanner.sh` lands with bats coverage of all six pattern families; <5% false-positive rate.
- [ ] `phases/phase-16-deploy-backends.md` ships with valid front-matter; eval set (six cases) scores ≥90% pass.
- [ ] `credential-leak.md` eval auto-fails on any credential pattern in stdout / wizard.log / transcripts (AMENDMENT-002 AC-08).
- [ ] `linked-prd-no-duplication.md` eval passes for phase 16 (AMENDMENT-002 AC-05).
- [ ] Cred-proxy invocation runs in a separate process; wizard process never holds the credential in any FD.
- [ ] Phases 17-19 deferral banner emits exactly once between phase 16 and phase 20 with correct link (AMENDMENT-002 AC-06).
- [ ] Phase 20 summary table enumerates every new phase module with status badge; legacy operators see "run wizard --phase NN" hints.
- [ ] `evals/test-cases/setup-wizard/full-flow-extended.md` passes deterministically with the documented skip/yes mix (AMENDMENT-002 AC-07).
- [ ] `autonomous-dev wizard rollback --phase NN` reverts config keys AND revokes external resources (cred-proxy handles, firewall rules); rollback round-trip test passes.
- [ ] Composition test suite passes: all four PLAN-033-N plans' modules load coherently; re-running phases is no-op; partial-state resume works; inter-phase ordering invariant enforced; rollback walks back without state corruption.
- [ ] `STAGE-4-CANARY.md` documents the Stage 4 gate (security review sign-off, ≥95% eval pass, zero credential leaks).
- [ ] `wizard.phase_16_module_enabled` default flip from `false` to `true` is the final commit, gated on Stage 4 canary criteria recorded in PR description.
- [ ] All AMENDMENT-002 acceptance criteria (AC-01 through AC-08) are demonstrably satisfied by this plan + the prior PLAN-033-N plans.
- [ ] Idempotency invariant holds across all four plans (TDD-033 G-04).
- [ ] Eval pass bar ≥90% per phase (TDD-033 G-05 / AMENDMENT-002 AC-03) is met by every new phase module.
