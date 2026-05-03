# TDD-030: Setup-Wizard Phase Modules (Phases 8 & 11-16)

| Field          | Value                                                              |
|----------------|--------------------------------------------------------------------|
| **Title**      | Setup-Wizard Phase Modules — Coverage Extension to Phases 8, 11-16 |
| **TDD ID**     | TDD-030                                                            |
| **Version**    | 1.0                                                                |
| **Date**       | 2026-05-02                                                         |
| **Status**     | Draft                                                              |
| **Author**     | Patrick Watson                                                     |
| **Parent PRD** | AMENDMENT-002 (extends AMENDMENT-001)                              |
| **Plugin**     | autonomous-dev-assist                                              |

---

## 1. Summary

This TDD specifies the technical design for extending `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md` from its current 10-phase coverage (mapping to AMENDMENT-001 phases 1-7, 9, 10, 20) to full coverage of every AMENDMENT-001 phase whose subsystem ships in this repository — namely phase 8 (chat channels) and phases 11-16 (portal, CI, request types, standards, reviewer chains, deploy backends).

The core architectural decision is that each new phase ships as a **modular SKILL fragment** under `plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-NN-<topic>.md`, transcluded into the master `SKILL.md` at orchestration time, rather than appended inline. This composes cleanly with the existing 10 phases (which remain inline for backward compatibility) and gives each new phase its own eval set, its own skip-condition evaluator, and its own idempotency contract without bloating the master skill past readable size.

Phases 17-19 (homelab) are explicitly out of scope per AMENDMENT-002 NG-01; the wizard surfaces a deferral pointer to `pwatsonr/autonomous-dev-homelab` between phase 16 and phase 20.

## 2. Goals & Non-Goals

| ID    | Goal                                                                                                              |
|-------|-------------------------------------------------------------------------------------------------------------------|
| G-01  | Each of phases 8, 11, 12, 13, 14, 15, 16 ships as a discrete, testable phase module with explicit I/O contract.   |
| G-02  | Phase modules compose into the existing 10-phase wizard without breaking the inline phases 1-7, 9, 10, 20.        |
| G-03  | Every phase is independently skippable with explicit consequence text per AMENDMENT-001 §"Phase Skipping".         |
| G-04  | Every phase is idempotent: re-running mid-phase against partial state never corrupts config or duplicates resources.|
| G-05  | Every phase is independently eval-tested at ≥90% pass per the AMENDMENT-002 acceptance bar.                       |
| G-06  | Phases 12 and 16 reach into PRD-015 / TDD-025 chain content via reference links, never via duplication.            |
| G-07  | Operators upgrading from the original 10-phase wizard run the new phases additively without re-running phases 1-7.|

| ID    | Non-Goal                                                                                                          |
|-------|-------------------------------------------------------------------------------------------------------------------|
| NG-01 | Phases 17-19 (homelab) — deferred to `pwatsonr/autonomous-dev-homelab` per AMENDMENT-002 NG-01.                    |
| NG-02 | A general-purpose "wizard SDK" abstraction — out of scope per AMENDMENT-002 NG-05.                                |
| NG-03 | New chain definitions, request types, standards, or deploy backends — wizard onboards what already exists (NG-04).|
| NG-04 | Re-authoring phases 1-7, 9, 10, 20 — those remain inline in the master skill (NG-02).                              |
| NG-05 | Modifying the underlying subsystems (TDDs 008-024) to fix usability gaps — gaps are filed as follow-ups (NG-03).  |

## 3. Tenets

| Tenet                                              | Implication                                                                                       |
|----------------------------------------------------|---------------------------------------------------------------------------------------------------|
| Verify, don't trust                                | Each phase ends with a live verification step (probe PR, test request, dry-run deploy) — never just config-write-and-trust. |
| Skip is a first-class outcome                      | "Skip with consequence text" is mandatory and tested in the eval set, not an afterthought.        |
| Credentials never touch the terminal               | Phase 16 routes every cloud secret through TDD-024 cred-proxy; the wizard never echoes a credential. |
| Link, don't inline                                 | PRD-015 / TDD-025 own the chain content for CI and deploy. The wizard step-by-step links to it.   |
| Idempotency before correctness                     | A re-run mid-phase must succeed where the prior attempt left off — even if the prior attempt was wrong. |

## 4. Background

The current wizard (read in full during design) is one monolithic `SKILL.md` with 10 inline phases authored before TDDs 011-024 landed. AMENDMENT-001 established a 20-phase registry; AMENDMENT-002 demands the wizard cover phases 8 and 11-16. A naive "append seven more phases inline" approach would push the SKILL past 1500 lines, mix in concerns the original phases never had (cred-proxy, GitHub APIs, plugin-install side-effects), and make eval-isolation per phase impossible because every eval would have to re-stub the entire preceding wizard state.

The phase-module pattern resolves this: each new phase is a self-contained markdown fragment with its own input contract (what state it inherits), output contract (what state it leaves), skip-condition predicate, and idempotency contract. The master `SKILL.md` becomes a phase orchestrator that transcludes phase modules in the registry order.

## 5. Architecture

```
plugins/autonomous-dev-assist/skills/setup-wizard/
├── SKILL.md                            (master orchestrator; phases 1-7,9,10,20 inline; phases 8,11-16 transcluded)
├── phases/
│   ├── phase-08-chat-channels.md       (NEW — Discord/Slack onboarding)
│   ├── phase-11-portal-install.md      (NEW — web portal)
│   ├── phase-12-ci-setup.md            (NEW — workflows + secrets + branch protection)
│   ├── phase-13-request-types.md       (NEW — request types & extension hooks)
│   ├── phase-14-eng-standards.md       (NEW — standards bootstrap)
│   ├── phase-15-reviewer-chains.md     (NEW — specialist reviewers)
│   ├── phase-16-deploy-backends.md     (NEW — cloud deploy backends)
│   └── _phase-contract.md              (NEW — shared contract spec referenced by every phase)
└── lib/
    ├── skip-predicates.sh              (NEW — bash helpers for skip-condition checks)
    ├── idempotency-checks.sh           (NEW — bash helpers for state probes)
    └── cred-proxy-bridge.sh            (NEW — wraps TDD-024 cred-proxy for wizard use)

plugins/autonomous-dev-assist/evals/test-cases/setup-wizard/
├── phase-08-chat-channels/             (NEW — happy/skip/error eval cases)
├── phase-11-portal-install/            (NEW)
├── phase-12-ci-setup/                  (NEW)
├── phase-13-request-types/             (NEW)
├── phase-14-eng-standards/             (NEW)
├── phase-15-reviewer-chains/           (NEW)
└── phase-16-deploy-backends/           (NEW)
```

### 5.1 Phase Module Contract

Every phase module MUST declare a YAML front-matter block:

```yaml
---
phase: 12
title: "CI workflows + secrets + branch protection"
amendment_001_phase: 12
tdd_anchors: [TDD-016, TDD-017]
prd_links: [PRD-015]
required_inputs:
  - phases_complete: [1,2,3,4,5,6,7]
  - config_keys: [".repositories.allowlist"]
optional_inputs:
  - github_token_present: true
skip_predicate: "scripts/skip-predicates.sh phase-12-ci-setup"
skip_consequence: |
  Without phase 12, autonomous-dev will not run in CI. PRs from the daemon
  will not have status checks; branch protection will not gate them.
idempotency_probe: "scripts/idempotency-checks.sh phase-12-ci-setup"
output_state:
  config_keys_written: [".ci.workflows_installed", ".ci.branch_protection_enabled"]
  files_created: [".github/workflows/autonomous-dev-ci.yml", ".github/workflows/autonomous-dev-cd.yml"]
  external_resources_created: ["GitHub branch protection rule on main"]
verification:
  - "Probe PR runs green"
  - "Branch protection report shows required checks"
eval_set: "evals/test-cases/setup-wizard/phase-12-ci-setup/"
---
```

The orchestrator reads this block, evaluates the `skip_predicate`, runs the `idempotency_probe`, and either skips, resumes, or starts fresh. The wizard never enters a phase whose `required_inputs` are unsatisfied.

### 5.2 Composition Flow

```
master SKILL.md execution
        │
        ▼
┌──────────────────────┐
│ Phase 1-7 (inline)   │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐    ┌────────────────────────┐
│ Read phase-08 front- │───►│ Eval skip_predicate    │
│ matter; check inputs │    │ (no chat env wanted?)  │
└──────────┬───────────┘    └────────┬───────────────┘
           │                          │ skip
           │ run                      ▼
           ▼                  emit consequence text
┌──────────────────────┐         continue to phase 9
│ Eval idempotency_    │
│ probe; resume or     │
│ start fresh          │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Execute phase steps  │
│ (transcluded MD)     │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Verify; write state; │
│ proceed to phase 9   │
└──────────────────────┘
```

The same flow runs for every transcluded phase (8, 11-16). The orchestrator is a thin fixed wrapper around the per-phase module.

## 6. Per-Phase Detailed Design

### 6.1 Phase 8 — Chat channels (Discord/Slack)

**TDD anchors**: TDD-008 (intake-communication), TDD-011 (multi-channel intake adapters).

**Operator inputs collected**:
- Boolean: enable Discord? Boolean: enable Slack? (at least one required to proceed; both may be enabled).
- For Discord: bot token (entered via stdin, never logged) and webhook URL.
- For Slack: bot token (`xoxb-...`) and target channel ID.

**Validation steps**:
- Discord: `curl -s -H "Authorization: Bot $TOKEN" https://discord.com/api/v10/users/@me` returns 200 with a JSON body containing `bot: true`.
- Slack: `curl -s -H "Authorization: Bearer $TOKEN" https://slack.com/api/auth.test` returns `ok: true`.
- Webhook test: send a small "autonomous-dev wizard verification" message and confirm 200/204.

**Output**:
- Config keys: `intake.discord.webhook_env` (env-var name pointer, not the literal token), `intake.slack.token_env` (likewise), `intake.slack.channel_id`, `intake.discord.enabled`, `intake.slack.enabled`.
- Env vars: tokens written to `~/.autonomous-dev/secrets.env` (mode 0600), referenced by env-var names in config — never inlined.
- Daemon restart: yes, to pick up new intake adapters.

**Skip condition**: operator declines both Discord and Slack. Consequence text: "You will only be able to submit requests via the CLI. Notifications will go to terminal only."

**Idempotency**:
- Probe checks `intake.discord.enabled` and `intake.slack.enabled` config keys.
- If already true for the chosen provider AND the auth.test/users.@me call still succeeds, skip the credential collection step and jump directly to verification.
- If config says enabled but the auth probe fails (rotated token), prompt for re-entry with explicit "your existing token failed validation" text.

### 6.2 Phase 11 — Web portal install

**TDD anchors**: TDD-013 (portal scaffolding), TDD-014 (portal auth + sessions), TDD-015 (portal pipeline view).

**Operator inputs collected**:
- Boolean: install portal? (default: skip — many operators are CLI-only).
- Port (default 8788), base URL, session secret (auto-generated if omitted; offer to reveal once for backup).
- Admin username + password (password entered via stdin, hashed with the portal's bcrypt cost factor before being written).
- Optional: second non-admin operator username + password.

**Validation steps**:
- Verify portal binary exists: `ls plugins/autonomous-dev/server/portal/bin/portal-server` (path per PRD-017 path-drift sweep).
- Run `autonomous-dev portal install --port $PORT --base-url $URL` and check exit 0.
- After daemon child start, `curl -sf http://127.0.0.1:$PORT/healthz` returns `{"status":"ok"}` within 10s (5x 2s polls).
- Open browser to `$URL/login` (best-effort; CI/headless skips this).
- Confirm both accounts can log in by issuing a `/api/auth/login` POST per account.

**Output**:
- Config keys: `portal.enabled`, `portal.port`, `portal.base_url`, `portal.session_secret_env`, `portal.scaffold_path` (= `server/portal/...` per PRD-017).
- Files created: `server/portal/portal.db` (SQLite for accounts), `server/portal/portal.config.json`.
- Daemon child: `portal-server` registered as a managed child of the autonomous-dev daemon (auto-restart on crash).

**Skip condition**: operator declines portal. Consequence text: "You will not be able to view in-flight pipelines in a browser. CLI status remains available."

**Idempotency**:
- Probe checks for existing `server/portal/portal.db`. If present, offer "keep existing accounts" vs. "wipe and restart" (default: keep).
- Probe `/healthz` first; if responding, skip install entirely and proceed to account verification.
- Account creation is upsert: re-running with the same username updates password hash rather than failing.

### 6.3 Phase 12 — CI workflows + secrets + branch protection

**TDD anchors**: TDD-016 (CI workflow scaffolds), TDD-017 (claude-workflows-release).
**PRD coordination**: PRD-015 owns the chain-level CI guidance; this phase forwards to PRD-015 for chain content and never inlines it.

**Operator inputs collected**:
- Detect if repo origin is GitHub (`git remote -v | grep github.com`); if not, skip phase.
- GitHub personal access token with `repo` and `workflow` scopes (entered via stdin, written to `secrets.env` only; never logged or echoed).
- Confirmation that operator wants branch protection enabled on `main` (default: yes).

**Validation steps**:
- Token scope check: `curl -s -H "Authorization: token $TOKEN" https://api.github.com/repos/$REPO` includes `permissions.admin: true` (required for branch protection write).
- Workflow file write: scaffold `.github/workflows/autonomous-dev-ci.yml`, `.github/workflows/autonomous-dev-cd.yml`, `.github/workflows/observe.yml.example` (per PRD-017 FR-1711-1714) using templates from `plugins/autonomous-dev/templates/workflows/`.
- Secrets configured via `gh secret set AUTONOMOUS_DEV_TOKEN -b "$TOKEN" --repo $REPO`.
- Branch protection set via `gh api -X PUT repos/$REPO/branches/main/protection -f required_status_checks[strict]=true -F required_status_checks[contexts][]="autonomous-dev/ci" ...`.
- **Probe PR verification**: `git checkout -b autonomous-dev-wizard-probe; echo "" >> .autonomous-dev/probe.touch; git commit -am "probe: wizard phase 12 verification"; gh pr create --title "Wizard phase 12 probe" --body "Auto-generated; safe to close."` and poll runs until green or timeout (5 minutes).
- After green, close (do not merge) the probe PR and delete the branch — no garbage left in operator's repo.

**Output**:
- Config keys: `.ci.workflows_installed = true`, `.ci.branch_protection_enabled = true`, `.ci.github_token_env = AUTONOMOUS_DEV_GH_TOKEN`.
- Files created: three workflow YAMLs in `.github/workflows/`.
- External resources: GitHub branch protection rule on `main`; `AUTONOMOUS_DEV_TOKEN` repo secret.

**Skip condition**:
- Auto-skip if `git remote -v` shows no `github.com` origin. Consequence text: "autonomous-dev CI integration currently only supports GitHub. Your daemon will run, but workflow validation must be done manually."
- Operator-skip available even on GitHub; consequence text: "Daemon-generated PRs will not be gated by required status checks. You should not enable trust level >= L2 without CI."

**Idempotency**:
- Probe `gh api repos/$REPO/branches/main/protection`; if it returns 200 with required_status_checks present, treat branch protection as already configured.
- Probe `.github/workflows/autonomous-dev-ci.yml` existence; if file matches the current template hash (stored in `.ci.scaffold_hash`), skip scaffold step.
- Probe PR step is idempotent because each invocation creates a unique branch name (`autonomous-dev-wizard-probe-$(date +%s)`).
- Token re-entry only happens if `gh auth status` fails for the stored token; otherwise reuse existing.

### 6.4 Phase 13 — Request types & extension hooks

**TDD anchors**: TDD-018 (request types), TDD-019 (extension hook system).

**Operator inputs collected**:
- For each bundled request type from TDD-018 catalog (default, hotfix, exploration, refactor): boolean enable + per-type cost cap (default inherited from `governance.per_request_cost_cap_usd`) + trust threshold + default reviewer set.
- Optional: register a custom extension hook? If yes, prompt for hook point name (from TDD-019 enumeration), handler script path (must be allowlisted in config or operator confirms add to allowlist), and timeout.

**Validation steps**:
- Catalog enumeration: read `plugins/autonomous-dev/config/request-types.json` and present to operator with descriptions.
- Per-type config write via `autonomous-dev config request-types enable --type hotfix --cost-cap 100 ...`.
- Hook registration: `autonomous-dev hooks add --point code-pre-write --handler /path/to/script.sh --timeout 30s`; verify exit 0.
- End-to-end probe: `autonomous-dev request submit --type hotfix --repo <allowlisted> --description "wizard phase 13 probe" --priority low --dry-run` and observe the request enters the type-specific pipeline (state machine reports `request_type=hotfix` in its first state transition).

**Output**:
- Config keys: `request_types.<name>.enabled`, `request_types.<name>.cost_cap_usd`, `request_types.<name>.trust_threshold`, `extensions.hooks[]`.
- No external resources.
- Daemon reload (SIGHUP) to pick up new request types and hooks.

**Skip condition**: operator skips. Consequence text: "Only the default request type will be active. You will not be able to submit hotfix/exploration/refactor variants until this phase is run."

**Idempotency**:
- Per-type config is upsert; re-running with same answers is a no-op.
- Hook registration is keyed by `(hook_point, handler_path)`; duplicate registration is detected and converted to update-or-skip.
- Probe submission uses `--dry-run` so re-running does not create real work.

### 6.5 Phase 14 — Engineering standards bootstrap

**TDD anchors**: TDD-021 (standards-meta-reviewer + prompt renderer + fix-recipe).

**Operator inputs collected**:
- Confirm or override auto-detected primary language (TS/JS/Python/Go) from PRD-014's project-detection scan.
- Choose bundled standard pack (e.g., `typescript-strict`, `python-pep8`) or "none, I'll author my own".
- Boolean: enable two-person-approval for fix-recipe applications? (per SPEC-021-3-02 contract).

**Validation steps**:
- Run project detection: `autonomous-dev detect-language --repo <path>`; surface result for operator confirmation.
- Write `<repo>/.autonomous-dev/standards.yaml` from chosen pack template.
- Validate via `autonomous-dev standards validate --repo <path>` (uses TDD-021 schema validator).
- Run `autonomous-dev standards-meta-reviewer --dry-run --against HEAD~5..HEAD`; observe it returns findings JSON without crashing.
- Exercise the prompt renderer at least once: `autonomous-dev standards render-prompt --rule-id <pack>:<sample-rule>` returns the formatted STANDARDS_SECTION.

**Output**:
- File: `<repo>/.autonomous-dev/standards.yaml`.
- Config keys: `standards.pack_id`, `standards.two_person_approval_enabled`.
- Logs: dry-run findings written to `<repo>/.autonomous-dev/standards-dry-run-$(date).json` for operator review.

**Skip condition**: operator skips. Consequence text: "Author agents will not be standards-aware. Code may violate your team's conventions silently. You can re-run this phase later."

**Idempotency**:
- If `standards.yaml` exists, offer diff vs. chosen pack and let operator merge or replace.
- Two-person-approval flag is a single config key; re-setting is a no-op.
- Dry-run findings overwrite the dated file (one per day) — no accumulation.

### 6.6 Phase 15 — Specialist reviewer chains

**TDD anchors**: TDD-020 (quality reviewer suite), TDD-021 (standards reviewer surfaces).

**Operator inputs collected**:
- For each bundled specialist from TDD-020 catalog (security, performance, accessibility, db-migration, dependency-update): boolean enable + chain order (drag-rank UI → numeric weight) + per-specialist threshold override.

**Validation steps**:
- Enumerate catalog from `plugins/autonomous-dev/config/specialist-reviewers.json`.
- Write chain config to `<repo>/.autonomous-dev/reviewer-chains.yaml`.
- Dry-run: `autonomous-dev reviewer-chain dry-run --against HEAD~1..HEAD`; observe each enabled specialist posts a finding (or "no findings"), proving the runtime can dispatch the chain.

**Output**:
- File: `<repo>/.autonomous-dev/reviewer-chains.yaml`.
- Config keys: `reviewers.specialist_chain_enabled`.

**Skip condition**: operator skips. Consequence text: "Only the generic reviewer will run on PRs. Security/performance/accessibility findings will not be surfaced automatically."

**Idempotency**:
- Chain YAML is fully replaced on re-run (operator confirms diff first).
- Dry-run is read-only.

**Forward reference**: live-run verification of the chain happens in phase 12 (CI). Phase 15 only proves the chain is configured and dry-runnable.

### 6.7 Phase 16 — Deployment backends

**TDD anchors**: TDD-023 (deployment-backend-framework-core), TDD-024 (cloud-backends-credential-proxy).
**PRD coordination**: PRD-015 / TDD-025 own the assist-extension's deploy chain, cred-proxy chain, and firewall chain content. This phase forwards to PRD-015 / TDD-025 for chain-level guidance and never inlines it.

**Operator inputs collected**:
- Per environment (dev/staging/prod): backend choice (`local` | `aws` | `gcp` | `azure` | `k8s`).
- For each non-`local` backend: the cred-proxy provisioning method (per TDD-024) — never the credential itself.
- For each cloud backend: egress firewall allowlist mode (default = cloud provider's official API endpoints only).
- Confirm cost-cap-enforcer threshold for dummy-deploy estimation step.

**Validation steps**:
- For each chosen non-`local` backend: `autonomous-dev plugin install autonomous-dev-deploy-{aws|gcp|azure|k8s}`; verify post-install probe.
- Cred-proxy setup: invoke `autonomous-dev cred-proxy provision --backend <name> --env <env>` (per TDD-024); the wizard NEVER asks for, displays, or logs the credential. The cred-proxy returns an opaque handle.
- Egress firewall: `autonomous-dev firewall apply --allowlist-template <provider>-default --env <env>` (per TDD-024).
- Cost estimate: `autonomous-dev deploy --dry-run --env <env> --estimate-only`; verify the cost-cap-enforcer (per PRD-017 FR-1701-1705) reports a bounded number.
- Final dry-run: `autonomous-dev deploy --dry-run --env dev`; verify exit 0 and a structured plan output.

**Output**:
- Config keys: `deploy.envs.<env>.backend`, `deploy.envs.<env>.cred_proxy_handle`, `deploy.envs.<env>.firewall_profile`, `deploy.envs.<env>.cost_cap_usd`.
- External resources: cred-proxy entry per env (in TDD-024's vault), firewall rules applied per env.
- No actual cloud resources created (all dry-run).

**Skip condition**: operator skips. Consequence text: "Only the `local` backend will be configured. The daemon will not be able to deploy to dev/staging/prod until this phase is run."

**Idempotency**:
- Plugin install is upsert (skip if already installed at matching version).
- Cred-proxy provisioning is keyed by `(backend, env)`; re-provisioning rotates the handle (operator must confirm).
- Firewall apply is declarative — re-apply with same template is a no-op.
- Dry-run deploy is always idempotent.

**Critical security invariant**: at no point in phase 16 does a credential touch the terminal, log, or any file outside TDD-024's cred-proxy. The wizard MUST exit with error if it detects a credential string (heuristic: anything matching `AKIA[0-9A-Z]{16}`, `ya29\\.`, etc.) in any operator input.

### 6.8 Phases 17-19 — Deferral notice

Between phase 16 verification and phase 20 (existing inline phase), the orchestrator emits:

```
====================================================================
   Phases 17-19 (Homelab) — Separate Plugin
====================================================================

If you want autonomous-dev to manage homelab infrastructure
(platform discovery, MCP/SSH connection, backup configuration),
install the homelab plugin from the separate repository:

  pwatsonr/autonomous-dev-homelab

That plugin ships its own setup-wizard extension covering
phases 17, 18, and 19. AMENDMENT-002 of this plugin explicitly
defers those phases to the homelab repo.

====================================================================
```

This is a static text block, not a phase module — there is no skip predicate, no input, no verification. It is purely informational.

## 7. Coordination Boundary with PRD-015 / TDD-025

| Concern                                       | Owner                       | Notes                                            |
|-----------------------------------------------|-----------------------------|--------------------------------------------------|
| Chain definitions (CI, deploy, cred-proxy, firewall) | PRD-015 / TDD-025  | Wizard never inlines. Wizard links to chain doc. |
| Wizard step-by-step that invokes chains       | TDD-030 (this)              | Owns the operator-facing flow.                   |
| Chain output quality eval sets                | PRD-015 / TDD-025           | Eval the chain itself.                           |
| Wizard-step completion eval sets              | TDD-030 (this)              | Eval the wizard correctly invokes the chain.     |
| Cred-proxy & firewall implementations         | TDD-024 (already shipped)   | Wizard calls `autonomous-dev cred-proxy ...`.    |
| Cred-proxy & firewall operator guidance       | PRD-015 / TDD-025           | Wizard forwards via doc link.                    |

**Cross-reference mechanism**: phase 12 and phase 16 modules each carry a `prd_links: [PRD-015]` front-matter entry. The orchestrator emits "For chain-level guidance, see: <PRD-015 link>" before the phase steps and a reviewer assertion confirms no phase 12/16 step duplicates a chain definition.

**Failure mode if TDD-025 lands content that conflicts**: discovered in eval (cross-doc duplication detector); resolved by editing the wizard phase to link rather than copy. Never by editing PRD-015.

## 8. Migration & Rollout

### 8.1 Operators on the existing 10-phase wizard

- The new phase modules are additive. Re-running `/autonomous-dev-assist:setup-wizard` after upgrade detects via idempotency probes that phases 1-7, 9, 10 are already complete (config keys present, daemon running, etc.) and offers "skip to phase 8" by default.
- Phase 20 (verification & summary) is updated to enumerate the new phases' state — operators on old setups see "phase 11: not run, phase 12: not run, ..." with an explicit "run wizard --phase 11 to start" hint.
- No data migration required. Re-running is voluntary; the daemon continues to work with the original 10-phase config.

### 8.2 Rollout phases

| Stage     | Scope                                             | Gate to next stage                                                |
|-----------|---------------------------------------------------|-------------------------------------------------------------------|
| Stage 1   | Phase modules 8 + 14 + 15 (lowest-risk)           | Eval pass ≥90% per phase; no operator regressions reported in 1w  |
| Stage 2   | Phase modules 11 + 13                              | Same bar; portal install verified on macOS + Linux                |
| Stage 3   | Phase module 12 (CI — sensitive)                   | Same bar; 5+ operators successfully complete probe-PR step         |
| Stage 4   | Phase module 16 (deploy — most sensitive)          | Same bar; security review of cred-proxy bridge sign-off            |

### 8.3 Rollback

Each phase module is gated by a feature flag (`wizard.phase_NN_module_enabled` in config defaults). If a phase module ships broken, set the flag to `false` and the orchestrator falls back to "this phase is currently unavailable; see release notes" with operator-skip behavior. No subsystem is broken by a wizard rollback because the underlying TDDs (008-024) remain operator-runnable directly via CLI.

## 9. Test Strategy

### 9.1 Per-phase eval set structure

For each phase NN, `evals/test-cases/setup-wizard/phase-NN-<topic>/` contains at minimum:

| Case                              | Asserts                                                                             |
|-----------------------------------|-------------------------------------------------------------------------------------|
| `happy-path.md`                   | All inputs valid; phase completes; correct config keys written; verification passes.|
| `skip-with-consequence.md`        | Operator chooses skip; correct consequence text emitted; phase exits cleanly.       |
| `error-recovery.md`               | A specific error injected (bad token, missing tool); phase recovers or exits with actionable diagnostic. |
| `idempotency-resume.md`           | Phase started, killed mid-way, re-run; resumes from correct point without duplicates.|
| `linked-prd-no-duplication.md` (12,16 only) | Phase output references PRD-015 by link, not by inlined content (regex check vs. PRD-015 chain content). |

### 9.2 End-to-end test

A single E2E case `evals/test-cases/setup-wizard/full-flow-extended.md` runs all phases against a fresh checkout with operator-skip on phases 11, 12, 16 (the optional/sensitive ones) and operator-yes on 8, 13, 14, 15. Asserts: reaches phase 20 with the correct state summary.

### 9.3 Acceptance bar

Per AMENDMENT-002 AC-03, each per-phase eval set must score ≥90% pass. The full-flow-extended E2E must pass.

### 9.4 Security tests

- Phase 16 credential-leak scanner: assert no credential pattern (AWS/GCP/Azure/SSH key forms) appears in any wizard log or eval transcript.
- Phase 12 token-scope downgrade: simulate a token without `admin` permission; assert phase exits with explicit error rather than partial config.
- Phase 8 webhook-leak check: assert webhook URL never appears in stdout or transcripts (only in `secrets.env`).

## 10. Cross-Cutting Concerns

### 10.1 Security

- Every credential-bearing input goes through stdin with no echo (`read -s` in bash) and is written only to `secrets.env` (mode 0600) or to TDD-024's cred-proxy. The wizard never echoes a credential to stdout, never logs one, and a unit test asserts this for each phase.
- Phase 12 GitHub token: scoped to single repo where possible (operator-confirmed). Operator is reminded of expiry-date setting.
- Phase 16: credentials NEVER touch the wizard process. The cred-proxy CLI invocation handles entry; the wizard receives only an opaque handle.
- Pre-commit safety: a wizard-internal hook runs before any git operation in phase 12 to confirm no `secrets.env` content has leaked into the staged diff.

### 10.2 Privacy

- No telemetry on operator inputs by default. If operator opts in to anonymous "wizard completion" reporting (off by default), only phase numbers and skip/complete states are sent — never config values, repo paths, or credentials.
- Operator's repo paths, GitHub repo names, cloud project identifiers all stay local.
- Eval transcripts (from CI runs) are scrubbed of operator-specific paths via existing scrubbing infrastructure.

### 10.3 Scalability

- Phase modules execute sequentially; concurrency is not a concern (single-operator interactive session).
- Idempotency probes for phases 12, 16 hit external APIs (GitHub, cloud providers); these are bounded to ≤5 calls per probe and use exponential backoff.
- Wizard total runtime target: phases 8 + 11 + 13 + 14 + 15 complete in <15 minutes operator-time on happy path. Phase 12 (probe-PR wait) bounded at 5 min. Phase 16 bounded at 10 min (plugin install + dry-run).

### 10.4 Reliability

- Each phase has a checkpoint file at `~/.autonomous-dev/wizard-checkpoint.json` recording last completed step within the phase. SIGINT mid-phase writes checkpoint; restart resumes from checkpoint.
- External-API steps (GitHub, cloud providers) wrap calls in retry-with-backoff (3 attempts, 2/4/8 second delays).
- If verification step fails, the phase exits with explicit diagnostic and pointer to `/autonomous-dev-assist:troubleshoot`. Phase state is checkpointed as `verification-failed` so resume can re-run just verification.

### 10.5 Observability

- Every phase emits structured log lines `{"phase": NN, "step": "<name>", "status": "started|completed|skipped|failed", "duration_ms": ...}` to `~/.autonomous-dev/logs/wizard.log`.
- Phase completion summary printed to operator at end of each phase.
- Final phase 20 summary table enumerates per-phase outcome (complete/skipped/failed).
- Eval framework consumes the structured log to assert correct phase ordering and skip behavior.

### 10.6 Cost

- Wizard itself is zero-marginal-cost (no model calls during the wizard run; everything is bash/CLI/curl).
- Phase 12 probe-PR triggers a CI run (negligible cost; ~1 minute of GitHub Actions).
- Phase 16 dry-run deploy: zero cloud cost (dry-run = no resource creation). The cost-cap-enforcer step validates that the cost-cap path itself works.
- Phase 16 plugin install (per chosen cloud): one-time cost of plugin download (tens of MB) and the cost-cap-enforcer's projection of future deploy costs — not a wizard-time cost.
- **Cost risk**: each cloud-backend plugin enabled in phase 16 increases the operator's eventual deploy infrastructure cost (TDD-024). The wizard surfaces an "estimated monthly cost ceiling per env" before plugin install and requires explicit opt-in.

## 11. Alternatives Considered

### 11.1 Alternative A: Append all seven phases inline to the existing master `SKILL.md`

**Approach**: Treat the master skill as a monolithic document; append phase 8, 11, 12, 13, 14, 15, 16 sections in order between the existing phase 7 and phase 8 (renumbered as 9), etc.

**Advantages**:
- Zero new file structure; matches existing pattern.
- Single file is easier to read top-to-bottom for a first-time operator.

**Disadvantages**:
- File grows past ~1500 lines, beyond comfortable single-skill territory.
- Per-phase eval isolation is impossible: every eval has to stub the entire preceding wizard.
- Skip predicates and idempotency probes have no natural place to live; bash blocks proliferate inline.
- A bug in (say) phase 12 forces a re-review of the entire skill rather than the offending module.

**Why rejected**: testability and review-blast-radius outweigh the convenience of a single file. The wizard already exceeds 800 lines; adding seven more phases inline crosses the threshold where modularity is the better choice.

### 11.2 Alternative B: A new "phase-runner" subcommand (`autonomous-dev wizard run-phase NN`) that owns each phase

**Approach**: Move each phase to executable bash/TS code under `plugins/autonomous-dev-assist/bin/wizard-phases/phase-NN.sh`, invoked by a slim master skill.

**Advantages**:
- Strong typing and testability via standard CLI testing tools.
- Phases can be invoked outside the wizard (useful for re-running just one phase).

**Disadvantages**:
- Loses the "skill author writes prose; operator reads prose" model that makes the existing wizard accessible. The operator-facing prose has to live somewhere — either duplicated in the script as heredocs or as separate markdown files (which is exactly what the chosen design proposes).
- Introduces a new execution surface (CLI subcommand) that needs its own auth, error-handling, and CI coverage.
- Crosses AMENDMENT-002 NG-05 ("not introducing a wizard SDK") in spirit.

**Why rejected**: the executable-CLI approach is the right answer for a future v2 wizard, but AMENDMENT-002 NG-05 explicitly rules out architecture refactoring in this amendment. The phase-module approach achieves modularity within the existing skill model.

### 11.3 Alternative C: One amendment phase per skill (seven separate skills)

**Approach**: Author `setup-wizard-phase-08`, `setup-wizard-phase-11`, ... `setup-wizard-phase-16` as seven entirely separate user-invocable skills.

**Advantages**:
- Maximum isolation; each phase is fully independent.
- Operator can invoke a single phase explicitly via slash command.

**Disadvantages**:
- Loses the orchestration story: the operator now has to know seven skill names and run them in order.
- Phase ordering invariants (phase 12 must come after phase 7, phase 15 must come after phase 14) are no longer enforced.
- Eight skills to discover, version, and maintain instead of one + seven fragments.

**Why rejected**: the wizard's orchestration (run all phases in order, with skip/idempotency built in) is its core value proposition. Splitting into seven invocable skills inverts the design.

### 11.4 Alternative D: Defer phase 12 + phase 16 entirely until PRD-015 / TDD-025 land

**Approach**: Ship phases 8, 11, 13, 14, 15 now; wait for TDD-025 to land before authoring phases 12 and 16.

**Advantages**:
- No coordination boundary risk; wizard authors PRD-015 / TDD-025 content in a single pass.
- Simpler scope for this TDD.

**Disadvantages**:
- Operators on AMENDMENT-002 trunk get a fragmented experience (5 of 7 new phases) until TDD-025 lands.
- AMENDMENT-002 explicitly demands phase 12 + 16; deferring violates AC-01.
- The boundary is well-defined ("link, don't inline"); deferral gains nothing the boundary cannot already enforce.

**Why rejected**: AC-01 is unconditional. The boundary mechanism (front-matter `prd_links` + reviewer cross-doc-duplication assertion) handles coordination cleanly without deferral.

## 12. Operational Readiness

### 12.1 Deployment

- Phase modules ship as part of the next `autonomous-dev-assist` plugin release.
- Feature flags per phase (default `true`); ops can toggle a phase off without a release.
- Eval suite runs in CI on every PR touching `plugins/autonomous-dev-assist/skills/setup-wizard/**`.

### 12.2 Rollback

- Toggle feature flag to `false` for the broken phase; orchestrator emits "phase NN unavailable; will be re-enabled in next release" and continues to next phase.
- If a phase corrupts operator state (e.g., bad config write), `autonomous-dev wizard rollback --phase NN` reverts the config keys listed in the phase's `output_state.config_keys_written` to their pre-phase values (snapshot taken at phase start).

### 12.3 Canary criteria

- Stage 1 ships to opt-in operators (env `AUTONOMOUS_DEV_WIZARD_BETA=1`); 1 week observation.
- If eval pass ≥95% AND zero opt-in operators report state corruption, stage 2 ships to all.

## 13. Implementation Plan (T-shirt Estimates)

| Plan candidate                                              | Estimate | Notes                                                          |
|-------------------------------------------------------------|----------|----------------------------------------------------------------|
| Wizard orchestrator + phase-module loader + shared lib      | M        | Master skill refactor + skip/idempotency helpers + lib scripts.|
| Phase modules 8, 14, 15 + their eval sets                    | M        | Lowest-complexity phases; mostly config and dry-run validation.|
| Phase modules 11, 13 + their eval sets                       | M        | Portal install adds OS-service interaction; request-types adds catalog enumeration. |
| Phase module 12 + eval set + GitHub probe-PR plumbing        | L        | Sensitive: token handling, branch protection API, probe-PR lifecycle. |
| Phase module 16 + eval set + cred-proxy bridge               | L        | Most sensitive: cred-proxy bridge, plugin install, firewall apply, dry-run deploy. |
| Phase 17-19 deferral notice + phase-20 summary update + E2E  | S        | Static text + table extension + full-flow E2E case.            |

## 14. Implementation Pointers

| Concern                                | Pointer                                                                            |
|----------------------------------------|------------------------------------------------------------------------------------|
| Master skill orchestrator              | `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md` (extend existing)     |
| Phase module home                      | `plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-NN-<topic>.md`     |
| Shared bash helpers                    | `plugins/autonomous-dev-assist/skills/setup-wizard/lib/*.sh`                       |
| Eval cases                             | `plugins/autonomous-dev-assist/evals/test-cases/setup-wizard/phase-NN-<topic>/`    |
| Workflow templates (phase 12)          | `plugins/autonomous-dev/templates/workflows/`                                       |
| Cred-proxy CLI (phase 16)              | `autonomous-dev cred-proxy` (TDD-024)                                              |
| Standards-meta-reviewer (phase 14)     | `autonomous-dev standards-meta-reviewer` (TDD-021)                                 |
| Reviewer chain runtime (phase 15)      | `autonomous-dev reviewer-chain` (TDD-020)                                          |
| Request-types catalog (phase 13)       | `plugins/autonomous-dev/config/request-types.json` (TDD-018)                       |
| Portal installer (phase 11)            | `autonomous-dev portal install` (TDD-013)                                          |
| Intake-adapter config (phase 8)        | `<repo>/.autonomous-dev/intake.yaml` (TDD-008/011)                                 |

## 15. Risks

| Risk                                                                  | Severity | Mitigation                                                                          |
|-----------------------------------------------------------------------|----------|-------------------------------------------------------------------------------------|
| Operator enters wrong GitHub token in phase 12; branch protection misconfigured. | High     | Token-scope check before any write; explicit "what permissions does this need" prompt; on failure, no partial state. |
| Operator accidentally pastes credential in phase 16; appears in history/log.    | Critical | Stdin no-echo; credential-pattern scanner asserts no leak in any wizard output; cred-proxy NEVER touches wizard process. |
| Each cloud-backend plugin enabled in phase 16 expands future deploy infra cost. | Medium   | Pre-install cost projection step; explicit opt-in per backend; cost-cap-enforcer dry-run validates the cap path.|
| Phase 12 probe-PR creates noise in operator's repo if cleanup fails.            | Medium   | Probe branch named `autonomous-dev-wizard-probe-<ts>`; cleanup is unconditional in `trap`; PR closed not merged. |
| Phase 16 firewall misconfiguration locks legitimate traffic.                    | Medium   | Default to provider's official-API allowlist; dry-run mode prints firewall diff before apply; rollback command available. |
| Phase 11 portal exposed on public interface accidentally.                       | Medium   | Default port-bind to `127.0.0.1`; explicit opt-in to `0.0.0.0`; reminder to put behind reverse proxy. |
| Phase 14 standards pack disagrees with operator's existing conventions.         | Low      | Dry-run + diff before apply; operator can edit before commit; meta-reviewer surfaces conflicts. |
| Coordination drift with PRD-015 / TDD-025 — wizard duplicates chain content.    | Medium   | Eval-set assertion `linked-prd-no-duplication.md` per phase; reviewer fails the PR if duplication detected. |
| Idempotency probe is wrong; re-running corrupts state.                          | High     | Probe writes nothing; only reads. Snapshot-and-rollback per phase available as safety net. |
| Operator interrupts wizard mid-phase; state inconsistent.                        | Medium   | Per-step checkpoint file; resume detects mid-phase state and offers recovery options. |

## 16. Open Questions

1. **Phase 16 boundary with TDD-025**: PRD-015 is approved but TDD-025 has not yet been authored. Should phase 16's `prd_links` reference TDD-025 by ID even though it does not exist yet, with the expectation that TDD-025 lands before phase 16 module implementation? Or should phase 16's chain-link guidance be a placeholder ("see PRD-015; TDD-025 forthcoming") that is patched when TDD-025 ships? Recommended answer: link to PRD-015 from day one (it exists), and leave a TODO marker for TDD-025 that the eval-set explicitly checks for resolution before stage 4 rollout.

2. **Phase 12 on GitHub Enterprise**: TDD-016/017 ship for github.com; does AMENDMENT-002's "GitHub" detection in phase 12 cover GHES instances (`github.mycompany.com`)? Recommended answer: yes — detect any `*.github.*` origin and pass through; if GHES auth differs from PAT-based, surface the difference with an actionable diagnostic.

3. **Phase 16 plugin uninstall**: if an operator enables `aws` deploy backend in phase 16 and later wants to remove it, does the wizard own that path or is it `autonomous-dev plugin uninstall`? Recommended answer: out-of-wizard. Wizard onboards; uninstall is a separate CLI surface.

4. **Phase 8 webhook-only Discord vs. bot Discord**: TDD-008 supports both webhook and bot modes for Discord; should phase 8 prompt for the choice or default to one? Recommended answer: default to webhook (simpler); operator can switch to bot post-wizard via `autonomous-dev intake reconfigure`.

5. **Stage 1 canary metric**: what specifically counts as a "successful operator completion" for the rollout gate? Recommended answer: full-flow-extended E2E pass for the operator's environment, captured via opt-in completion ping (anonymous, just "phase NN completed at <ts>").

## 17. References

| Document | Relationship |
|----------|--------------|
| AMENDMENT-002 (`plugins/autonomous-dev/docs/prd/AMENDMENT-002-setup-wizard-phase-coverage-extension.md`) | Parent PRD — this TDD descends from it. |
| AMENDMENT-001 (`plugins/autonomous-dev/docs/prd/AMENDMENT-001-setup-wizard-phase-registry.md`) | Phase registry that AMENDMENT-002 / this TDD extend coverage for. |
| TDD-008 (intake-layer) | Phase 8 anchor. |
| TDD-011 (multi-channel intake adapters) | Phase 8 anchor. |
| TDD-013 (portal-server-foundation) | Phase 11 anchor. |
| TDD-014 (portal-security-auth) | Phase 11 anchor. |
| TDD-015 (portal-live-data-settings) | Phase 11 anchor. |
| TDD-016 (baseline-ci-plugin-validation) | Phase 12 anchor. |
| TDD-017 (claude-workflows-release) | Phase 12 anchor. |
| TDD-018 (request-types-pipeline-variants) | Phase 13 anchor. |
| TDD-019 (extension-hook-system) | Phase 13 anchor. |
| TDD-020 (quality-reviewer-suite) | Phase 15 anchor. |
| TDD-021 (standards-dsl-auto-detection) | Phase 14 + 15 anchor. |
| TDD-023 (deployment-backend-framework-core) | Phase 16 anchor. |
| TDD-024 (cloud-backends-credential-proxy) | Phase 16 anchor. |
| PRD-015 (assist-extension) | Phase 12 + 16 chain-content owner; wizard links, never inlines. |
| TDD-025 (forthcoming, descends from PRD-015) | Chain-level technical design for chains/deploy/cred-proxy/firewall — coordinate boundary. |
| PRD-017 (cleanup-and-operational-closeout) | Source of `observe.yml.example` and cost-cap-enforcer outcome that phases 12 & 16 depend on. |
| `pwatsonr/autonomous-dev-homelab` | Owner of deferred phases 17-19. |

## 18. Design Review Log

_(To be populated by the reviewer agent.)_

---

*End of TDD-030.*
