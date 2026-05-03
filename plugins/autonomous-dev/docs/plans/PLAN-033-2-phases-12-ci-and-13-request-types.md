# PLAN-033-2: Phase Modules 12 (CI Workflows) & 13 (Request Types + Hooks)

## Metadata
- **Parent TDD**: TDD-033-setup-wizard-phase-modules
- **Parent PRD**: AMENDMENT-002 (extends AMENDMENT-001)
- **Estimated effort**: 6 days (phase 12 is L per TDD-033 §13; phase 13 is M)
- **Dependencies**: [PLAN-033-1]
- **Blocked by**: [PLAN-033-1]
- **Priority**: P0
- **Stage**: Rollout Stage 2 (phase 13) + Stage 3 (phase 12, sensitive) per TDD-033 §8.2

## Objective

Land the two CI/request-pipeline phase modules:

1. **Phase 12** -- CI workflows + repo secrets + branch protection. The most
   sensitive operator-facing module so far: it handles a GitHub PAT, writes
   `.github/workflows/*.yml` files into the operator's repo, configures
   branch protection on `main`, and verifies the whole stack via a probe PR
   that must be created and cleaned up without leaving garbage.
2. **Phase 13** -- Request types + extension hooks. Configures the type
   catalog (default/hotfix/exploration/refactor) and registers any custom
   extension hook the operator wants, then verifies via a `--dry-run`
   request submission.

Phase 12 cross-references PRD-015 / TDD-025 for chain-level guidance and
**MUST NOT inline** any chain definition (per TDD-033 §7 boundary, AMENDMENT-002
AC-05). The eval set has a dedicated `linked-prd-no-duplication.md` case
asserting this with a regex check.

## Scope

### In Scope
- `phases/phase-12-ci-setup.md` per TDD-033 §6.3 covering:
  - GitHub origin detection (`git remote -v | grep github.com`); auto-skip on non-GitHub remotes with consequence text per TDD-033 §6.3 skip clause.
  - GitHub PAT collection via `read -s` (`repo` + `workflow` scopes); written exclusively to `secrets.env` (mode 0600); referenced in config by env-var name only.
  - Token-scope check via `curl -s -H "Authorization: token $TOKEN" https://api.github.com/repos/$REPO` asserting `permissions.admin: true` BEFORE any write.
  - Workflow scaffold: `.github/workflows/autonomous-dev-ci.yml`, `autonomous-dev-cd.yml`, `observe.yml.example` from `plugins/autonomous-dev/templates/workflows/` (PRD-017 FR-1711-1714).
  - Repo secret configuration via `gh secret set AUTONOMOUS_DEV_TOKEN`.
  - Branch protection on `main` via `gh api -X PUT repos/$REPO/branches/main/protection` with required-status-checks contexts for each scaffolded workflow.
  - **Probe-PR verification**: unique branch name `autonomous-dev-wizard-probe-$(date +%s)` so each invocation is idempotent; `gh pr create`; poll runs ≤5 min; close (do NOT merge) the probe PR; delete the branch unconditionally via `trap`.
  - Skip-with-consequence and operator-skip-on-GitHub paths both supported.
  - Idempotency: probe `gh api .../protection` for existing config; probe template-hash to skip rescaffold; reuse stored token if `gh auth status` passes.
  - PRD-015 cross-reference printed BEFORE phase steps with explicit link, and a reviewer assertion that no chain content is duplicated.
- `phases/phase-13-request-types.md` per TDD-033 §6.4 covering:
  - Catalog enumeration from `plugins/autonomous-dev/config/request-types.json`.
  - Per-type config (cost cap inheriting from `governance.per_request_cost_cap_usd`, trust threshold, default reviewer set).
  - Optional custom extension-hook registration via `autonomous-dev hooks add`; handler-path allowlist confirmation.
  - End-to-end probe via `autonomous-dev request submit --type hotfix --dry-run` observing `request_type=hotfix` in the first state transition.
  - Daemon SIGHUP at phase end to pick up new types and hooks.
  - Skip-with-consequence: only default request type active.
  - Idempotency: per-type config is upsert; hook registration keyed by `(hook_point, handler_path)` with update-or-skip on duplicates; probe is `--dry-run` (no real work).
- Per-phase eval sets:
  - `evals/test-cases/setup-wizard/phase-12-ci-setup/{happy-path,skip-with-consequence,error-recovery,idempotency-resume,linked-prd-no-duplication}.md` (five cases including the AC-05 cross-doc-duplication assertion).
  - `evals/test-cases/setup-wizard/phase-13-request-types/{happy-path,skip-with-consequence,error-recovery,idempotency-resume}.md` (four cases).
- Feature flags `wizard.phase_12_module_enabled` and `wizard.phase_13_module_enabled` (defaults `true`).
- Helper additions to `lib/skip-predicates.sh`: `is_github_origin`, `gh_token_has_admin_scope`. To `lib/idempotency-checks.sh`: `gh_branch_protection_configured`, `workflow_template_hash_matches`.

### Out of Scope
- Phase modules 8, 11, 14, 15, 16 (other PLAN-033-N).
- Cred-proxy bridge (PLAN-033-4 phase 16); phase 12 uses GitHub PAT in `secrets.env`, not cred-proxy.
- Authoring new request types or new extension hook points (AMENDMENT-002 NG-04).
- Modifying `request-types.json` catalog or `autonomous-dev hooks add` CLI surface (TDD-033 NG-05).
- TDD-025 / PRD-015 chain content -- this phase LINKS to it, never inlines.
- Probe-PR cleanup automation across operator-managed forks (the probe runs on the operator's primary remote only).

## Tasks

1. **Extend `lib/skip-predicates.sh` and `lib/idempotency-checks.sh` with phase-12 helpers.** Add `is_github_origin`, `gh_token_has_admin_scope <token> <repo>` (predicate), `gh_branch_protection_configured <repo>` (idempotency probe), `workflow_template_hash_matches <path> <expected-sha>` (idempotency probe).
   - Files to modify: `plugins/autonomous-dev-assist/skills/setup-wizard/lib/skip-predicates.sh`, `lib/idempotency-checks.sh`. Tests: extend the bats files from PLAN-033-1.
   - Acceptance: Each helper has a docstring + truth-table test. `gh_token_has_admin_scope` and `gh_branch_protection_configured` use bounded `gh api` calls (≤5 per probe per TDD-033 §10.3) with exponential backoff. All helpers remain read-only.
   - Effort: 0.5 day.

2. **Author `phases/phase-12-ci-setup.md`.** Per TDD-033 §6.3 + AMENDMENT-002 §4.3. Front-matter `prd_links: [PRD-015]`. Operator-facing flow: detect → collect token → scope-check → scaffold → secrets → branch protection → probe-PR → verify → close-not-merge → cleanup. PRD-015 link banner emitted BEFORE the chain-related steps. Probe-PR uses unique timestamped branch and unconditional `trap` cleanup.
   - Files to create: `plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-12-ci-setup.md`.
   - Acceptance: All twelve front-matter keys validate. PAT never appears on stdout, in any log line, or in any committed file. Probe-PR branch is deleted whether the PR succeeds or fails (`trap ... EXIT`). Branch protection write is gated on `permissions.admin: true` from the scope-check. Auto-skip emits TDD-033 §6.3's exact consequence text on non-GitHub origin.
   - Effort: 1.5 days.

3. **Author phase-12 eval set (five cases including PRD-cross-link).** Cases:
   - `happy-path.md`: GitHub origin + scoped PAT + admin perms → workflows scaffolded → secrets set → branch protection on → probe PR runs green within 5 min → PR closed (not merged) → branch deleted → state written → verification line `{"phase":12,"step":"verify","status":"completed"}` emitted.
   - `skip-with-consequence.md`: non-GitHub origin → auto-skip with TDD-033 §6.3 consequence text "GitHub-only support; daemon will run but workflow validation must be done manually."
   - `error-recovery.md`: PAT lacks `admin` scope → wizard exits with explicit "your token needs `repo` + `workflow` scopes; current token has only `repo`" diagnostic; no partial state (workflows not scaffolded). Token-scope downgrade test per TDD-033 §9.4.
   - `idempotency-resume.md`: workflows already scaffolded matching current template hash → skip rescaffold; branch protection already configured → skip set; probe-PR step runs fresh (timestamped branch).
   - `linked-prd-no-duplication.md`: regex-scan the rendered phase output for any sentence longer than 40 chars that also appears verbatim in PRD-015's chain section. Assert zero matches per AMENDMENT-002 AC-05.
   - Files to create: `plugins/autonomous-dev-assist/evals/test-cases/setup-wizard/phase-12-ci-setup/*.md` (five files).
   - Acceptance: ≥90% pass on the eval set. The cross-link case is mandatory (auto-fail on duplication detection per TDD-033 §15 risk "coordination drift"). Token-leak scanner asserts no PAT pattern (`ghp_[A-Za-z0-9]{36}`) appears in stdout/wizard.log.
   - Effort: 1.5 days.

4. **Author `phases/phase-13-request-types.md`.** Per TDD-033 §6.4 + AMENDMENT-002 §4.4. Catalog read from `plugins/autonomous-dev/config/request-types.json`; per-type prompts loop; hook-add CLI invocation; dry-run probe. SIGHUP at end.
   - Files to create: `plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-13-request-types.md`.
   - Acceptance: Front-matter validates. Catalog enumeration is data-driven (re-runs pick up catalog changes without phase re-author). Hook registration is idempotent: `(hook_point, handler_path)` key collision converts to update-or-skip. Probe submission uses `--dry-run` (no real work created per TDD-033 §6.4). Skip-with-consequence: "only default request type active; hotfix/exploration/refactor unavailable until run."
   - Effort: 1 day.

5. **Author phase-13 eval set (four cases).**
   - `happy-path.md`: enable hotfix + exploration with cost caps → custom hook registered at `code-pre-write` → dry-run hotfix submission → state-machine first transition reports `request_type=hotfix` → state written → SIGHUP issued.
   - `skip-with-consequence.md`: operator declines all custom types → consequence text emitted → only default type active (config unchanged).
   - `error-recovery.md`: operator points hook handler at non-allowlisted path → wizard prompts to add to allowlist (with confirmation) OR exits with diagnostic. Bad-handler case: handler script not executable → `autonomous-dev hooks add` returns non-zero → wizard surfaces error and offers re-entry.
   - `idempotency-resume.md`: phase started, killed after enabling hotfix but before exploration → re-run resumes at exploration prompt; already-registered hook is detected and offered as update-or-skip.
   - Files to create: `plugins/autonomous-dev-assist/evals/test-cases/setup-wizard/phase-13-request-types/*.md`.
   - Acceptance: ≥90% pass. Idempotency-resume case proves no duplicate hook registration. Dry-run probe never creates real work.
   - Effort: 1 day.

6. **Add feature-flag defaults.** `wizard.phase_12_module_enabled: true`, `wizard.phase_13_module_enabled: true`.
   - Files to modify: `config_defaults.json`.
   - Acceptance: Toggling either to `false` produces "phase NN unavailable; see release notes" path; subsequent phases continue.
   - Effort: 0.25 day.

7. **Stage 3 canary criteria documentation.** Update TDD-033 §8.2 reference in `_phase-contract.md` or a sibling `STAGE-3-CANARY.md` so the rollout team knows: phase 12 ships to opt-in operators (`AUTONOMOUS_DEV_WIZARD_BETA=1`), then to all after 5+ operators successfully complete the probe-PR step with no leaked tokens.
   - Files to create or modify: `plugins/autonomous-dev-assist/skills/setup-wizard/STAGE-3-CANARY.md`.
   - Acceptance: Canary gate is checkable (eval pass ≥95%, ≥5 successful probe-PR completions, zero token leaks in transcripts).
   - Effort: 0.25 day.

## Dependencies & Integration Points

**Exposes to other plans:**
- `phases/phase-12-ci-setup.md`'s PRD-015 cross-link pattern (front-matter + banner + duplication eval case) -- reused verbatim by PLAN-033-4 phase 16.
- The probe-PR lifecycle pattern (unique-branch + `trap`-based cleanup) -- reusable for any future "verify by creating throwaway artifact in operator repo" need.
- Extended `lib/skip-predicates.sh` and `lib/idempotency-checks.sh` -- consumed by PLAN-033-3 / PLAN-033-4.

**Consumes from other plans:**
- **PLAN-033-1** (blocking): orchestrator loop, `_phase-contract.md`, `lib/*.sh` baseline, `secrets.env` write convention.
- TDD-016 / TDD-017 -- workflow templates and branch-protection guidance.
- PRD-015 -- chain-level guidance for CI (linked, never inlined).
- PRD-017 -- `observe.yml.example` template, FR-1711-1714.
- TDD-018 / TDD-019 -- request-types catalog and hook registration CLI.

**Coordination boundary with PRD-015 / TDD-025**: Phase 12 carries `prd_links: [PRD-015]` and the eval-set duplication scanner is the enforcement mechanism. If PRD-015 / TDD-025 evolve, the wizard MUST update its link, never copy content -- per TDD-033 §7 failure-mode guidance.

## Testing Strategy

- **Per-phase eval sets** (tasks 3, 5) at ≥90% pass per AMENDMENT-002 AC-03.
- **Probe-PR cleanup test**: kill the wizard mid-probe-PR (after `gh pr create`, before close); re-run; assert the prior probe-PR is detected and closed (or skipped if operator wants manual cleanup) AND a new timestamped probe branch is used.
- **Token-leak scanner** per TDD-033 §9.4: regex `ghp_[A-Za-z0-9]{36}` against stdout, `wizard.log`, eval transcripts; asserts zero matches across the entire phase 12 eval suite.
- **Token-scope downgrade test** per TDD-033 §9.4: simulate a token with `repo` only (no `admin`); assert phase exits before any write; no `.github/workflows/*` files appear.
- **PRD-cross-link duplication test**: the `linked-prd-no-duplication.md` eval is the regression gate; runs on every PR touching `phases/phase-12-ci-setup.md` OR PRD-015.
- **Idempotency probe correctness**: invoke `gh_branch_protection_configured` against (a) repo with no protection, (b) repo with partial protection (no required-status-checks), (c) repo with full protection. Assert truth-table.
- **Phase 13 dry-run isolation**: assert `request submit --dry-run` writes no entries to the daemon's request store and emits no notifications (per TDD-033 §6.4 idempotency clause).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Operator's PAT leaks into wizard.log via shell expansion in a `gh` invocation | Medium | Critical -- credential disclosure | Pass token as env var (`GH_TOKEN`), never as command-line arg. `gh` honors `GH_TOKEN`. Eval-set token-leak scanner is mandatory. Pre-commit hook on `wizard.log` greps for `ghp_` and fails. |
| Probe-PR cleanup fails (network glitch, gh-cli error) leaving garbage branch in operator repo | Medium | Medium -- repo noise | `trap "gh pr close ... && git push origin --delete <branch>" EXIT INT TERM` on the wizard process. Even on `kill -9` (which trap can't catch), the next phase 12 invocation detects the prior probe branch by name pattern and offers cleanup. |
| Branch protection set with wrong required-status-check contexts → CI runs but never satisfies protection → operator's main branch stuck | Medium | High -- operator productivity hit | Required-status-check contexts derived from the actual workflow filenames in `.github/workflows/autonomous-dev-*.yml`, not hard-coded. Probe PR verification asserts the protection is satisfied (otherwise `trap` aborts the phase). Rollback: `gh api -X PUT .../protection -f required_status_checks=null`. |
| GitHub Enterprise (GHES) detection misses non-`github.com` origins (TDD-033 §16 open question 2) | Medium | Medium -- GHES operators get auto-skip incorrectly | Phase 12 detects any `*.github.*` origin per TDD-033 §16's recommended answer. If GHES auth differs from PAT-based, phase exits with a documented diagnostic and link to a future GHES-specific phase. |
| PRD-015 / TDD-025 land content that conflicts with phase 12's link → duplication eval fires false-positive | Low | Medium -- noisy CI | The duplication eval uses a strict matching threshold (≥40 char verbatim sentence). PRD-015 / TDD-025 authors run the same eval before merging changes, surfacing conflicts pre-merge. |
| Phase 13 hook-handler-path allowlist confirmation accidentally adds attacker-controlled paths | Low | High -- privilege escalation via custom hook | Allowlist confirmation prompt shows full absolute path + handler script first 200 bytes; operator must type "yes" to add. Reuse PLAN-019-3 trust-validator if available; otherwise this phase defers handler trust to that subsystem. |
| Catalog drift: `request-types.json` adds a new bundled type, phase 13 eval still asserts old catalog | Low | Low -- eval flake | Catalog enumeration is data-driven; eval cases assert structure ("at least one type enabled, with cost cap and trust threshold") not specific type names. New types are picked up automatically. |

## Definition of Done

- [ ] `phases/phase-12-ci-setup.md` ships with valid front-matter; eval set (five cases incl. PRD-cross-link) scores ≥90% pass.
- [ ] `phases/phase-13-request-types.md` ships with valid front-matter; eval set (four cases) scores ≥90% pass.
- [ ] Probe-PR lifecycle is idempotent: unique-branch + `trap`-cleanup verified by kill-mid-phase test.
- [ ] No GitHub PAT (`ghp_*`) appears in stdout, wizard.log, or any eval transcript across the phase 12 suite.
- [ ] Token-scope downgrade test (no admin scope) exits cleanly with diagnostic and zero partial state.
- [ ] Branch protection write is gated on a successful scope-check; required-status-check contexts derive from actual scaffolded workflow filenames.
- [ ] PRD-015 cross-reference banner emits BEFORE the chain-related phase 12 steps.
- [ ] `linked-prd-no-duplication.md` eval passes (zero ≥40 char verbatim duplication between phase 12 output and PRD-015 chain content).
- [ ] Phase 13 dry-run probe creates no real work and issues no notifications.
- [ ] Phase 13 hook registration is idempotent: `(hook_point, handler_path)` key collisions convert to update-or-skip without duplicates.
- [ ] Feature flags default to `true`; toggling to `false` produces "unavailable" path without breaking subsequent phases.
- [ ] `STAGE-3-CANARY.md` documents the rollout gate (≥5 successful probe-PR completions, zero token leaks).
- [ ] Both phases pass their mandatory eval cases per TDD-033 §9.1 / AMENDMENT-002 AC-03.
- [ ] Idempotency invariant holds (TDD-033 G-04): re-running mid-phase against partial state never corrupts config or duplicates resources.
