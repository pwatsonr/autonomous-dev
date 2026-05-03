# PLAN-033-1: Wizard Orchestrator + Phase Modules 8 (Chat) & 11 (Portal)

## Metadata
- **Parent TDD**: TDD-033-setup-wizard-phase-modules
- **Parent PRD**: AMENDMENT-002 (extends AMENDMENT-001)
- **Estimated effort**: 5 days
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P0 (foundational; gates the other PLAN-033-N plans)
- **Stage**: Rollout Stage 1 per TDD-033 §8.2 (lowest-risk phases)

## Objective

Land the phase-module substrate that all of TDD-033 depends on, then ship the two
lowest-risk operator-facing modules (phase 8 chat channels, phase 11 web portal)
on top of it. Concretely this plan delivers:

1. The master `SKILL.md` orchestrator extension that locates, transcludes, skip-evaluates, and idempotency-probes phase-module fragments per TDD-033 §5.1 / §5.2.
2. The shared bash helper library (`lib/skip-predicates.sh`, `lib/idempotency-checks.sh`, `lib/cred-proxy-bridge.sh` stub).
3. The `phases/_phase-contract.md` shared spec referenced by every phase module.
4. The `phases/phase-08-chat-channels.md` module per TDD-033 §6.1.
5. The `phases/phase-11-portal-install.md` module per TDD-033 §6.2.
6. The per-phase eval sets for phases 8 and 11 (happy / skip-with-consequence / error-recovery / idempotency-resume cases) per TDD-033 §9.1.

This is Stage 1 of the TDD-033 §8.2 rollout: phases 8, 14, 15 ship with
the orchestrator. (14 + 15 land in PLAN-033-3; we ship phase 8 here together
with phase 11 because phase 11 is the next lowest-risk phase and shares the
"opt-in user-facing service" shape with phase 8.)

## Scope

### In Scope
- `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md` extension to add the **phase-module orchestration loop** described in TDD-033 §5.2 between the existing inline phase 7 and the existing inline phase 9 (and again later for phases 12-16, though those modules ship in subsequent plans). The orchestrator MUST:
  - Locate `phases/phase-NN-*.md` and parse YAML front-matter per TDD-033 §5.1.
  - Verify `required_inputs` (config keys & prior-phase-complete markers).
  - Evaluate `skip_predicate` (bash exit code 0 = skip).
  - Evaluate `idempotency_probe` (returns `start-fresh` | `resume-from:<step>` | `already-complete`).
  - Run the transcluded module steps.
  - Run the per-phase verification block.
  - Write `output_state.config_keys_written` to `~/.autonomous-dev/wizard-state.json`.
- `plugins/autonomous-dev-assist/skills/setup-wizard/phases/_phase-contract.md` shared contract spec (front-matter schema, naming conventions, idempotency expectations) so every phase module is reviewed against the same rubric.
- `plugins/autonomous-dev-assist/skills/setup-wizard/lib/skip-predicates.sh` -- bash helpers for common skip checks (`is-github-origin`, `has-config-key`, `is-cli-only-mode`, etc.).
- `plugins/autonomous-dev-assist/skills/setup-wizard/lib/idempotency-checks.sh` -- bash helpers for state probes (`config-key-equals`, `file-hash-matches`, `endpoint-responds`, `gh-api-200`).
- `plugins/autonomous-dev-assist/skills/setup-wizard/lib/cred-proxy-bridge.sh` -- **stub only** in this plan: signature + "not implemented; see PLAN-033-4" stub. The full implementation lives in PLAN-033-4 (phase 16). The stub is shipped here so phase 8's `secrets.env` writes go through a single sourceable helper from day one.
- `phases/phase-08-chat-channels.md` per TDD-033 §6.1 covering Discord + Slack onboarding, `auth.test`/`users.@me` validation, `secrets.env` write (mode 0600), env-var-name pointer config keys, daemon SIGHUP, skip-with-consequence, idempotency probe of existing intake config.
- `phases/phase-11-portal-install.md` per TDD-033 §6.2 covering portal binary check, `autonomous-dev portal install`, `/healthz` poll, account upsert, default-skip flow, port-bind safety (default `127.0.0.1`).
- Per-phase eval directories `evals/test-cases/setup-wizard/phase-08-chat-channels/` and `phase-11-portal-install/` with the four cases from TDD-033 §9.1 (happy, skip-with-consequence, error-recovery, idempotency-resume).
- Feature flags `wizard.phase_08_module_enabled` and `wizard.phase_11_module_enabled` in `config_defaults.json` (default `true` for phase 8, `true` for phase 11).
- A migration note in `SKILL.md` that the new orchestrator loop is additive: operators on the legacy 10-phase config see "phase 8: not run" and may invoke `--phase 8` to onboard.

### Out of Scope
- Phase modules 12, 13, 14, 15, 16 -- separate PLAN-033-N plans.
- Full cred-proxy bridge implementation -- PLAN-033-4 (phase 16).
- Phase 17-19 deferral notice -- PLAN-033-4 (sits between phase 16 and existing phase 20 inline).
- Phase 20 summary table extension -- PLAN-033-4 (E2E touches it last).
- Re-authoring inline phases 1-7, 9, 10, 20 (TDD-033 NG-04).
- Wizard SDK / CLI subcommand-per-phase (TDD-033 §11 Alternative B, rejected).
- New chat providers, new portal features (NG-04 of AMENDMENT-002).

## Tasks

1. **Author `phases/_phase-contract.md` shared contract spec.** Document the YAML front-matter schema (verbatim from TDD-033 §5.1: `phase`, `title`, `amendment_001_phase`, `tdd_anchors`, `prd_links`, `required_inputs`, `optional_inputs`, `skip_predicate`, `skip_consequence`, `idempotency_probe`, `output_state`, `verification`, `eval_set`). Document the per-step checkpoint contract (`~/.autonomous-dev/wizard-checkpoint.json`). Document naming conventions for skip-predicate/idempotency-probe scripts. List the four mandatory eval cases.
   - Files to create: `plugins/autonomous-dev-assist/skills/setup-wizard/phases/_phase-contract.md`.
   - Acceptance criteria: All twelve front-matter keys documented with type + example. Reviewer can match each new phase module's front-matter against this spec line-by-line. Operator-facing prose is read-only reference (not an executable skill).
   - Effort: 0.5 day.

2. **Implement `lib/skip-predicates.sh` bash helpers.** Pure-bash functions, no node/jq except where unavoidable. Each helper exits 0 (predicate true → skip phase) or 1 (predicate false → run phase). Helpers needed for Stage 1 + later: `is_github_origin`, `has_config_key <key>`, `config_key_equals <key> <value>`, `is_cli_only_mode`, `is_macos`, `is_linux`. Add unit tests via `bats`.
   - Files to create: `plugins/autonomous-dev-assist/skills/setup-wizard/lib/skip-predicates.sh`, `plugins/autonomous-dev-assist/tests/setup-wizard/skip-predicates.bats`.
   - Acceptance criteria: Each helper has a docstring with examples. `bats tests/setup-wizard/skip-predicates.bats` passes on both bash 4 (Linux) and bash 5 (macOS Homebrew). Helpers are pure (no I/O beyond config-file read).
   - Effort: 0.5 day.

3. **Implement `lib/idempotency-checks.sh` bash helpers.** Helpers needed: `config_key_equals`, `file_exists_with_hash <path> <sha256>`, `endpoint_responds_2xx <url>` (with 5x 2s polls per TDD-033 §6.2), `gh_api_returns_200 <path>`, `wizard_state_phase_complete <NN>`. Each returns `start-fresh` | `resume-from:<step>` | `already-complete` on stdout. Add bats tests.
   - Files to create: `plugins/autonomous-dev-assist/skills/setup-wizard/lib/idempotency-checks.sh`, `plugins/autonomous-dev-assist/tests/setup-wizard/idempotency-checks.bats`.
   - Acceptance criteria: Each helper has a docstring + truth table. bats tests cover happy/missing/partial-state for each helper. No helper writes to disk (read-only probes per TDD-033 §15 Risks: "idempotency probe is wrong; re-running corrupts state").
   - Effort: 0.5 day.

4. **Stub `lib/cred-proxy-bridge.sh`.** Provide function signatures (`cred_proxy_write_env <name> <env-var-name>`, `cred_proxy_read_handle <env> <backend>`) that for now write to `secrets.env` with mode 0600 (sufficient for phase 8) and emit "not implemented for cloud backends; see PLAN-033-4" for cloud-bound calls. Document this in the file header.
   - Files to create: `plugins/autonomous-dev-assist/skills/setup-wizard/lib/cred-proxy-bridge.sh`.
   - Acceptance criteria: Phase 8's secret-write goes through `cred_proxy_write_env` exclusively. The cloud-handle reader stub is invoked only by tests until PLAN-033-4 lands. Header explicitly states the contract gap.
   - Effort: 0.25 day.

5. **Extend master `SKILL.md` with the phase-module orchestration loop.** Insert (between existing phase 7 and phase 9) a generic loop "for each module in `phases/phase-{08,11,12,13,14,15,16}-*.md`": parse front-matter, verify `required_inputs`, evaluate skip_predicate, evaluate idempotency_probe, transclude module body, run verification, write state. Use the operator-facing prose pattern from existing inline phases (banners, numbered steps, summaries). Add the feature-flag gate (`wizard.phase_NN_module_enabled`) per TDD-033 §8.3.
   - Files to modify: `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md`.
   - Acceptance criteria: SKILL.md grows by the orchestration loop only (no inline phase content for 8/11/12/13/14/15/16; those are transcluded). The loop is well-commented so a future reviewer can map it back to TDD-033 §5.2 Composition Flow. Existing inline phases 1-7, 9, 10, 20 are unchanged. Feature-flag gate works (`wizard.phase_NN_module_enabled: false` → "phase NN unavailable" message).
   - Effort: 1 day.

6. **Author `phases/phase-08-chat-channels.md`.** Per TDD-033 §6.1: detect Discord/Slack preference, collect tokens via `read -s` (no echo), validate via `auth.test` / `users.@me`, send a "wizard verification" probe message, write env-var-name pointers to `intake.discord.*` / `intake.slack.*` config keys, write tokens to `secrets.env` via the bridge stub, SIGHUP daemon. Skip-with-consequence: "CLI-only; terminal notifications only." Idempotency: reuse existing tokens if `auth.test` still passes; force re-entry on rotation.
   - Files to create: `plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-08-chat-channels.md`.
   - Acceptance criteria: All twelve front-matter keys present and validate against `_phase-contract.md`. **At least one chat channel must be configured to proceed** OR operator explicitly skips with consequence text shown. No token ever appears on stdout or in any log line. SIGHUP is issued exactly once at phase end.
   - Effort: 1 day.

7. **Author `phases/phase-11-portal-install.md`.** Per TDD-033 §6.2: confirm intent (default skip), collect port/base-url/session-secret/admin-creds (passwords via `read -s` + bcrypt before write), invoke `autonomous-dev portal install`, register portal as managed daemon child, poll `/healthz`, verify both accounts via `/api/auth/login`. Default port-bind to `127.0.0.1`. Skip-with-consequence: "no browser pipeline view; CLI status remains." Idempotency: reuse existing `portal.db` (operator chooses keep vs wipe); skip install entirely if `/healthz` is already responding.
   - Files to create: `plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-11-portal-install.md`.
   - Acceptance criteria: Default flow is skip (per TDD-033 §6.2 "default: skip"). Port defaults to 8788 bound to `127.0.0.1` per TDD-033 §15 Risk "portal exposed publicly". Account creation is upsert (re-run with same username updates hash). Front-matter validates against `_phase-contract.md`.
   - Effort: 1 day.

8. **Author phase-08 eval set.** Four cases per TDD-033 §9.1:
   - `happy-path.md`: Discord-only enabled with valid token → `auth.test` succeeds → config keys present → SIGHUP sent → ≥90% pass bar.
   - `skip-with-consequence.md`: operator declines both → exact consequence text "CLI-only; terminal notifications only." emitted → phase exits clean → next phase begins.
   - `error-recovery.md`: bad Discord token → `auth.test` returns 401 → wizard prompts re-entry with "your existing token failed validation" text (TDD-033 §6.1 idempotency clause) → recovers or exits with diagnostic.
   - `idempotency-resume.md`: phase started, killed mid-token-collection, re-run → resumes at re-collection step; if already complete, idempotency probe returns `already-complete` and phase is no-op.
   - Files to create: `plugins/autonomous-dev-assist/evals/test-cases/setup-wizard/phase-08-chat-channels/{happy-path,skip-with-consequence,error-recovery,idempotency-resume}.md`.
   - Acceptance criteria: Eval set scores ≥90% pass per TDD-033 §9.3 (matching AMENDMENT-002 AC-03). Each case asserts the structured log lines from TDD-033 §10.5. Webhook-leak test: assert webhook URL appears in `secrets.env` only (per §9.4 phase-8 security check).
   - Effort: 0.5 day.

9. **Author phase-11 eval set.** Same four cases:
   - `happy-path.md`: portal install confirmed, port 8788, admin + non-admin accounts created, `/healthz` 200 within 10s, both `/api/auth/login` succeed.
   - `skip-with-consequence.md`: default skip → exact consequence text "no browser pipeline view; CLI status remains." → phase exits.
   - `error-recovery.md`: portal binary missing OR `/healthz` never responds within 10s → wizard exits with actionable diagnostic pointing at `/autonomous-dev-assist:troubleshoot`.
   - `idempotency-resume.md`: existing `portal.db` present → operator chooses "keep existing accounts" → phase skips install, only verifies; or chooses "wipe and restart" → phase rebuilds.
   - Files to create: `plugins/autonomous-dev-assist/evals/test-cases/setup-wizard/phase-11-portal-install/{happy-path,skip-with-consequence,error-recovery,idempotency-resume}.md`.
   - Acceptance criteria: Eval set scores ≥90% pass. Default-skip path is the dominant happy case (operators are CLI-only by default). Bind-address assertion: `0.0.0.0` requires explicit opt-in.
   - Effort: 0.5 day.

10. **Add feature-flag defaults.** `config_defaults.json`: `wizard.phase_08_module_enabled: true`, `wizard.phase_11_module_enabled: true`. Document in `_phase-contract.md` how to toggle.
    - Files to modify: `plugins/autonomous-dev-assist/config_defaults.json` (or wherever defaults live).
    - Acceptance criteria: Flags ship as `true` (Stage 1 phases). Toggling to `false` in operator config makes the orchestrator emit "phase NN unavailable" and continue.
    - Effort: 0.25 day.

## Dependencies & Integration Points

**Exposes to other plans:**
- The orchestrator loop in `SKILL.md` -- consumed unchanged by PLAN-033-2/3/4 (each just adds its phase modules to the `phases/` directory).
- `_phase-contract.md` -- the schema every subsequent plan's phase modules MUST conform to.
- `lib/skip-predicates.sh` and `lib/idempotency-checks.sh` -- helpers reused by phases 12-16.
- `lib/cred-proxy-bridge.sh` stub -- PLAN-033-4 replaces the cloud-handle reader stub with the real implementation.

**Consumes from other plans:**
- Existing `setup-wizard/SKILL.md` inline phases 1-7, 9, 10, 20 (unchanged but orchestrator loop is inserted between 7 and 9).
- TDD-008 / TDD-011 intake-adapter contracts -- phase 8 calls `auth.test` / `users.@me` per their published API.
- TDD-013 / TDD-014 / TDD-015 portal contracts -- phase 11 calls `autonomous-dev portal install`, `/healthz`, `/api/auth/login`.
- PRD-017's path-drift sweep -- phase 11 expects portal at `server/portal/...`.

## Testing Strategy

- **bats unit tests** for `lib/skip-predicates.sh` and `lib/idempotency-checks.sh` (tasks 2-3). Run on bash 4 + bash 5; cover all helpers + truth tables.
- **Per-phase eval sets** (tasks 8-9) hit ≥90% pass per TDD-033 §9.3 / AMENDMENT-002 AC-03. Each set covers the four mandatory cases.
- **Orchestration smoke test** in `evals/test-cases/setup-wizard/orchestrator-loop-smoke.md`: feature-flag-disabled phase → "unavailable" message; feature-flag-enabled phase with skip predicate true → skip with consequence; feature-flag-enabled phase with idempotency `already-complete` → no-op.
- **Security tests** per TDD-033 §9.4: phase 8 webhook-leak scanner asserts webhook URL never appears in stdout/transcripts; only in `secrets.env`. Phase 11 password never echoed; bcrypt hash written to `portal.db` only.
- **Idempotency probe correctness**: each helper in `idempotency-checks.sh` is asserted read-only via a fs-snapshot diff before/after invocation.
- **No regressions**: existing inline phases 1-7, 9, 10, 20 must pass their existing eval cases unchanged after orchestrator loop insertion. Run the existing wizard eval suite as a regression gate.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Orchestrator loop subtly changes inline-phase behavior (e.g., reorders config writes) | Medium | High -- existing operator setups break | Insert orchestrator strictly between existing phase 7 and phase 9 markers; touch nothing else in the existing inline content. Existing eval suite is the regression gate. Reviewer assertion: diff `SKILL.md` and confirm zero changes outside the inserted block. |
| Phase 8 token leaks via `set -x` or unguarded log statement | High (easy mistake) | Critical -- credential in logs | Phase 8 module wraps token-handling steps with `set +x` and explicit `>/dev/null` redirects. Eval-set webhook-leak case is mandatory. Pre-commit hook: grep for token-shaped strings in any `wizard.log`. |
| Portal `/healthz` poll false-positives on stale process | Medium | Medium -- operator thinks portal is up but it's the old build | `/healthz` response includes a build-id that the install step records; phase 11 verification asserts the build-id matches the just-installed binary. |
| `lib/cred-proxy-bridge.sh` stub gets used by future plan author who assumes cloud support works | Medium | High -- silent failure in phase 16 | File header: bold "STUB; cloud handles unimplemented" warning. PLAN-033-4 replaces the stub and removes the warning in the same diff. CI lint: grep for `cred_proxy_read_handle` calls in any phase module other than phase 16 -- fails the build. |
| YAML front-matter parser inconsistency between bash and node (orchestrator vs. eval framework) | Medium | Medium -- false skip / false idempotency | Use a single canonical parser (`yq` if available, else a 30-line bash shim documented in `_phase-contract.md`). All twelve keys are flat (no nested maps beyond two levels). bats test harness uses the same parser as the orchestrator. |
| Operator on legacy 10-phase config sees confusing "phase 8: not run" warnings | Low | Low -- UX papercut | Migration note in `SKILL.md` explicitly addresses this; phase 20 summary table (extended in PLAN-033-4) prints "run wizard --phase 08 to onboard chat" hint. |

## Definition of Done

- [ ] `_phase-contract.md` documents all twelve front-matter keys with examples; reviewer rubric is checkable.
- [ ] `lib/skip-predicates.sh` + bats tests pass on bash 4 and bash 5.
- [ ] `lib/idempotency-checks.sh` + bats tests pass; each helper proven read-only via fs-snapshot diff.
- [ ] `lib/cred-proxy-bridge.sh` stub ships with explicit "cloud handles unimplemented" header.
- [ ] `SKILL.md` orchestrator loop inserted between inline phase 7 and inline phase 9; existing eval suite passes unchanged (no regressions on inline phases).
- [ ] `phases/phase-08-chat-channels.md` ships with valid front-matter; eval set scores ≥90% pass; webhook-leak scanner shows zero leaks.
- [ ] `phases/phase-11-portal-install.md` ships with valid front-matter; eval set scores ≥90% pass; default-bind is `127.0.0.1`.
- [ ] Feature flags `wizard.phase_08_module_enabled` and `wizard.phase_11_module_enabled` default to `true`; toggling to `false` produces "unavailable" path.
- [ ] Both phases pass their four mandatory eval cases (happy / skip-with-consequence / error-recovery / idempotency-resume) per TDD-033 §9.1.
- [ ] No regressions in inline phases 1-7, 9, 10, 20.
- [ ] Operator inputs are collected via stdin no-echo for any credential-bearing field (TDD-033 §10.1).
- [ ] Idempotency invariant holds: re-running mid-phase against partial state never corrupts config or duplicates resources (TDD-033 G-04).
