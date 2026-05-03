# AMENDMENT-002: Setup-Wizard Phase Coverage Extension

**Status**: Draft.
**Date**: 2026-05-03.
**Author**: Patrick Watson.
**Amends**: AMENDMENT-001 (Unified Setup-Wizard Phase Registry).
**Applies to**: `autonomous-dev-assist/skills/setup-wizard/SKILL.md`.

---

## 1. Summary

AMENDMENT-001 established a unified 20-phase setup-wizard registry as the single source of truth, mandating that every subsystem onboard operators through a numbered phase. The `setup-wizard` skill (under the `autonomous-dev-assist` plugin) was authored before TDDs 011-024 landed and currently covers only phases 1-10 (mapping roughly to AMENDMENT-001 phases 1-7, 9, 10, and 20). The intermediate phases 8 and 11-19 — every phase that maps to a TDD-011-through-024-era subsystem — are absent from the wizard skill, even though all underlying subsystems EXCEPT phases 17-19 (homelab) are landed and operator-ready.

AMENDMENT-002 extends the wizard skill to cover phases 8 and 11-16 (the phases whose subsystems are landed in this repo), and explicitly **defers** phases 17-19 (homelab discovery, connection, backup) to a future amendment that will track `pwatsonr/autonomous-dev-homelab` separately.

| Phase span | Status after AMENDMENT-002 | Owner                                                  |
|------------|----------------------------|--------------------------------------------------------|
| 1-7, 9, 10, 20 | Already shipped        | autonomous-dev-assist                                   |
| 8              | NEW — chat channels    | autonomous-dev-assist (this amendment)                  |
| 11             | NEW — portal install   | autonomous-dev-assist (this amendment)                  |
| 12             | NEW — CI workflows     | autonomous-dev-assist (this amendment)                  |
| 13             | NEW — request types & extension hooks | autonomous-dev-assist (this amendment)   |
| 14             | NEW — eng standards    | autonomous-dev-assist (this amendment)                  |
| 15             | NEW — specialist reviewer chains | autonomous-dev-assist (this amendment)        |
| 16             | NEW — deployment backends | autonomous-dev-assist (this amendment)                |
| 17-19          | DEFERRED — homelab     | `pwatsonr/autonomous-dev-homelab` (separate repo)       |

---

## 2. Goals

| ID    | Goal                                                                                                                                                                                                                       |
|-------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| G-01  | Extend the `autonomous-dev-assist/skills/setup-wizard/SKILL.md` wizard to cover phases 8 and 11-16 of the AMENDMENT-001 phase registry, achieving full coverage for every phase whose subsystem ships in this repo.        |
| G-02  | Each new phase walks the operator from a clean (post-phase-7) state to a verified working state for the corresponding subsystem (e.g., a Discord webhook actually receiving an event for phase 8, a CI run passing on a probe PR for phase 12). |
| G-03  | Each phase is independently skippable per AMENDMENT-001 §"Phase Skipping" rules; the wizard explicitly surfaces "skip this phase" with the consequence of skipping it (e.g., "you will not receive chat notifications").    |
| G-04  | Each new phase passes the assist eval suite at ≥90% on the corresponding eval set, matching the bar AMENDMENT-001 implied for the registry as a whole.                                                                     |
| G-05  | Phase 12 (CI) and phase 16 (deployment backends) explicitly cross-reference PRD-015's coverage of the assist-extension surface (chains, deploy, cred-proxy, firewall) so operators don't get duplicated or contradictory guidance. |

---

## 3. Non-Goals

| ID     | Non-Goal                                                                                                                                                                                                |
|--------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| NG-01  | Not authoring phases 17-19 (homelab discovery, homelab connection, homelab backup). Those phases require the `plugins/autonomous-dev-homelab` plugin which lives in the separate repo `pwatsonr/autonomous-dev-homelab` and ships under its own PRD. |
| NG-02  | Not re-authoring phases 1-7, 9, 10, or 20. Those phases are already shipped; AMENDMENT-002 does not touch them except to insert phase 8 between phase 7 and phase 9 in the wizard's flow control.       |
| NG-03  | Not changing the underlying subsystems. Phases 8 and 11-16 onboard operators THROUGH already-shipped surfaces (TDDs 008, 011, 013-019, 021, 023, 024). If a phase reveals a usability gap, it is filed as a follow-up — the wizard does not patch the subsystem. |
| NG-04  | Not adding new chat providers, CI providers, request types, standards, reviewer chains, or deploy backends in this amendment. The wizard onboards what exists.                                          |
| NG-05  | Not introducing a "wizard SDK" abstraction. Each phase remains a sequence of skill steps in the existing `SKILL.md` format. Refactoring the wizard architecture is a separate, larger initiative.       |

---

## 4. Phase-by-Phase Requirements

Each phase below specifies (a) what the operator starts with, (b) what the wizard walks them through, (c) what they end with, and (d) the eval anchor.

### 4.1 Phase 8 — Enable chat channels (Discord/Slack)

**TDD anchors**: TDD-008 (intake-communication), TDD-011 (chat onboarding follow-up).

**Operator start state**: Phase 7 complete (CLI submission works); no chat channels configured.

**Wizard walkthrough**:
1. Detect whether the operator has a Discord and/or Slack workspace (prompt yes/no/both).
2. For Discord: walk through creating an application, adding a bot, generating a webhook URL, and writing it to `.autonomous-dev/intake.yaml` under `intake.discord.webhook_env`.
3. For Slack: walk through creating an app, requesting `chat:write` scope, installing to workspace, copying the bot token, and configuring `intake.slack.token_env`.
4. Verify by submitting a test request via the chat channel and observing the daemon's acknowledgement.
5. Walk operator through unit-disabling either channel if they regret enabling it.

**Operator end state**: At least one chat channel can submit requests AND receives status notifications.

**Eval anchor**: `eval/setup-wizard/phase-08-chat-channels/*.md` — assert wizard names the correct config keys, verifies via a test request, surfaces skip option with consequence text.

### 4.2 Phase 11 — Web portal install (optional)

**TDD anchors**: TDD-013 (portal scaffolding), TDD-014 (portal auth + sessions), TDD-015 (portal pipeline view).

**Operator start state**: Phases 1-10 complete; no portal running.

**Wizard walkthrough**:
1. Confirm the operator wants the portal (default: skip; many operators prefer CLI-only).
2. Run the bundled portal installer (`autonomous-dev portal install`) which scaffolds `server/portal/...` config and creates the first admin account.
3. Configure portal port, base URL, and session secret via the wizard's prompts.
4. Start the portal as a managed daemon child; verify by curling `/healthz` and opening the browser to the configured base URL.
5. Walk operator through creating an additional non-admin operator account.

**Operator end state**: Portal accessible at the configured URL; one admin and one non-admin account exist; portal correctly displays in-flight pipelines from the daemon.

**Eval anchor**: `eval/setup-wizard/phase-11-portal-install/*.md` — assert wizard offers skip, scaffolds config in correct location (per PRD-017's path-drift sweep, this is `server/portal/...`), and verifies via `/healthz`.

### 4.3 Phase 12 — CI workflows + secrets + branch protection

**TDD anchors**: TDD-016 (CI workflow scaffolds), TDD-017 (secrets and branch protection setup).

**Operator start state**: A repo where autonomous-dev will operate but with no `.github/workflows/autonomous-dev-*.yml` files and no branch protection on `main`.

**Wizard walkthrough**:
1. Detect whether the target repo is on GitHub (skip phase otherwise with explicit consequence text).
2. Scaffold the CI workflow files (`autonomous-dev-ci.yml`, `autonomous-dev-cd.yml`, plus `observe.yml.example` per PRD-017 FR-1711-1714) into `.github/workflows/`.
3. Walk operator through configuring required secrets (`AUTONOMOUS_DEV_TOKEN`, plus per-cloud secrets if applicable per phase 16).
4. Walk operator through enabling branch protection on `main` with required-status-checks for each scaffolded workflow.
5. Verify by opening a probe PR (auto-generated whitespace diff) and observing the workflows run green AND the branch protection report.

**Coordination note**: This phase **must reference PRD-015**'s coverage of the assist extension's CI guidance (chains, cred-proxy guidance, firewall scaffolding). The wizard SHALL NOT duplicate PRD-015's content — it links into the assist-extension's chain documentation for any specialized chain a downstream phase will register.

**Operator end state**: Workflows exist, secrets are configured, branch protection is on, and a probe PR has merged green.

**Eval anchor**: `eval/setup-wizard/phase-12-ci-setup/*.md` — assert wizard scaffolds correct files, configures correct secrets (token-env pattern from PRD-008), and verifies via probe-PR run.

### 4.4 Phase 13 — Request types & extension hooks

**TDD anchors**: TDD-018 (request-type framework), TDD-019 (extension hooks API).

**Operator start state**: Phases 1-12 complete; only the default request type ("standard") is active.

**Wizard walkthrough**:
1. List available request types bundled with autonomous-dev (default, hotfix, exploration, refactor — exact list per TDD-018 catalog).
2. For each type the operator wants to enable, configure type-specific defaults (cost cap, trust threshold, default reviewers).
3. Walk operator through registering a custom extension hook if they want one (via the `autonomous-dev hooks add` CLI per TDD-019).
4. Verify by submitting one request of each enabled type and observing it transition through the type-specific pipeline.

**Operator end state**: At least the default request type is verified working; any optional types are enabled and verified.

**Eval anchor**: `eval/setup-wizard/phase-13-request-types/*.md` — assert wizard enumerates the correct catalog, walks the registration CLI, verifies via end-to-end request.

### 4.5 Phase 14 — Engineering standards bootstrap

**TDD anchors**: TDD-021 (standards-meta-reviewer + prompt renderer + fix-recipe).

**Operator start state**: Phases 1-13 complete; no standards configured.

**Wizard walkthrough**:
1. Detect the repo's primary language (TypeScript/JavaScript/Python/Go) via the project-detection logic from PRD-014.
2. Offer the bundled standard packs that match (e.g., `typescript-strict`, `python-pep8`).
3. Write the chosen standards into `.autonomous-dev/standards.yaml`.
4. Walk operator through running the standards-meta-reviewer in dry-run mode against an existing PR or commit to demonstrate findings.
5. Optionally enable two-person-approval for fix-recipe applications per the contract added in SPEC-021-3-02.

**Operator end state**: Standards file exists; meta-reviewer dry-run executed successfully; two-person-approval mode is on or off explicitly.

**Eval anchor**: `eval/setup-wizard/phase-14-eng-standards/*.md` — assert wizard offers the right pack per detected language, writes the standards file in the correct location, and exercises the prompt renderer at least once.

### 4.6 Phase 15 — Specialist reviewer chains

**TDD anchors**: TDD-020 (reviewer chain runtime), TDD-021 (standards reviewer surfaces).

**Operator start state**: Phases 1-14 complete; only the generic reviewer is active.

**Wizard walkthrough**:
1. Enumerate the bundled specialist reviewers (security, performance, accessibility, db-migration, dependency-update — exact catalog per TDD-020).
2. For each specialist the operator wants to enable, configure the chain order and any specialist-specific thresholds.
3. Verify by running the chain against a probe PR and observing each specialist post a finding.

**Coordination note**: Phase 15 enables specialist reviewers; phase 12's CI step actually runs them. The wizard SHALL forward-reference phase 12's verification for the live run and use a dry-run for phase 15's standalone verification.

**Operator end state**: At least one specialist chain is configured and dry-run-verified.

**Eval anchor**: `eval/setup-wizard/phase-15-reviewer-chains/*.md` — assert wizard enumerates the catalog, configures chain order, and dry-runs successfully.

### 4.7 Phase 16 — Deployment backends

**TDD anchors**: TDD-023 (deployment-backends framework — see PRD-014), TDD-024 (cred-proxy + egress firewall + cost estimation).

**Operator start state**: Phases 1-15 complete; only the `local` backend is configured (default per PRD-014 FR-1419).

**Wizard walkthrough**:
1. Ask operator which target environments they want (dev/staging/prod and which backend per env).
2. For each chosen backend, install the corresponding plugin (`autonomous-dev-deploy-{aws,gcp,azure,k8s}`) and walk through credential setup using the cred-proxy from TDD-024 (NEVER copying credentials into config).
3. Configure the egress firewall allowlist (per TDD-024) for each enabled cloud backend, defaulting to the cloud provider's official API endpoints only.
4. Walk operator through cost estimation for a dummy deployment to verify the cost-cap-enforcer (per PRD-017 FR-1701-1705 outcome) reports a bounded estimate.
5. Verify by running a dry-run deploy via `autonomous-dev deploy --dry-run --env dev`.

**Coordination note**: This phase **must reference PRD-015** for the assist-extension's deploy chain, cred-proxy chain, and firewall chain content. PRD-015 owns the chain-level guidance; AMENDMENT-002 owns the wizard step-by-step that orchestrates calls into those chains. The wizard SHALL NOT inline PRD-015's content; it SHALL link.

**Operator end state**: Per chosen backend, credentials wired through cred-proxy, egress firewall configured, dry-run deploy passes.

**Eval anchor**: `eval/setup-wizard/phase-16-deployment-backends/*.md` — assert wizard correctly installs the chosen plugin, walks cred-proxy setup (NEVER prints credentials), configures egress allowlist, and performs dry-run.

### 4.8 Phases 17, 18, 19 — DEFERRED

These phases (homelab platform discovery, homelab platform connection via MCP/SSH, homelab backup configuration) require the `plugins/autonomous-dev-homelab` plugin which lives in the separate repository `pwatsonr/autonomous-dev-homelab`. AMENDMENT-002 explicitly defers these phases to a future amendment authored against that repo.

The wizard SHALL surface a "Phases 17-19 require the autonomous-dev-homelab plugin (separate install)" note at the appropriate point in the flow, with a link to the homelab repo's README, but SHALL NOT walk operators through the homelab steps from this repo's wizard.

---

## 5. Acceptance Criteria

| ID    | Criterion                                                                                                                                          |
|-------|----------------------------------------------------------------------------------------------------------------------------------------------------|
| AC-01 | `autonomous-dev-assist/skills/setup-wizard/SKILL.md` includes step-by-step content for phases 8 and 11-16 in the order matching AMENDMENT-001's registry. |
| AC-02 | Each new phase explicitly identifies itself by phase number from AMENDMENT-001 and links the corresponding TDD(s) for traceability.                 |
| AC-03 | The assist eval suite gains one eval set per new phase (`eval/setup-wizard/phase-{08,11,12,13,14,15,16}-*/`) and each set passes at ≥90%.            |
| AC-04 | Each new phase surfaces an explicit "skip this phase" option with consequence text, per AMENDMENT-001 §"Phase Skipping".                            |
| AC-05 | Phase 12 and phase 16 reference PRD-015's chain-level guidance (chains/deploy/cred-proxy/firewall) without duplicating its content; reviewer confirms via diff. |
| AC-06 | The wizard's phase-17-19 deferral note appears at the correct place in the flow with a link to `pwatsonr/autonomous-dev-homelab`.                   |
| AC-07 | An end-to-end dry run of the extended wizard against a fresh checkout reaches phase 20 (verification & summary) without error, with phases 11-16 skipped or completed at the operator's choice. |
| AC-08 | The wizard's phase-by-phase walkthroughs use the cred-proxy from TDD-024 for any credential operation in phase 16 and NEVER print credentials to terminal or logs. |

---

## 6. Coordination with PRD-015

PRD-015 ("assist extension") owns the chain-level surfaces that phases 12 and 16 reach into:
- Chain definitions for CI workflows.
- Chain definitions for deployment via the backends framework.
- Cred-proxy invocation patterns for cloud credentials.
- Egress firewall configuration patterns.

AMENDMENT-002 owns the operator-facing wizard that orchestrates calls into those chains. The boundary is:

| Concern                                       | Owner          |
|-----------------------------------------------|----------------|
| Chain definitions, prompts, fix-recipes       | PRD-015        |
| Wizard step-by-step that invokes chains       | AMENDMENT-002  |
| Eval sets for chain output quality            | PRD-015        |
| Eval sets for wizard step completion          | AMENDMENT-002  |
| Cred-proxy and egress firewall implementations| TDD-024 (already shipped) |
| Wizard guidance on how to use them            | AMENDMENT-002 (forwards to PRD-015 for chain-level advice) |

Any duplication of guidance between PRD-015 and AMENDMENT-002 is a defect and SHALL be resolved by linking, not copying.

---

## 7. References

| Document                                                                                                                                       | Relationship                | Notes                                                                                          |
|------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------|------------------------------------------------------------------------------------------------|
| **AMENDMENT-001: Unified Setup-Wizard Phase Registry** (`plugins/autonomous-dev/docs/prd/AMENDMENT-001-setup-wizard-phase-registry.md`)         | Base amendment              | Defines the phase registry that AMENDMENT-002 extends coverage for.                            |
| **TDD-008: Intake & Communication**                                                                                                             | Phase 8 anchor              | Discord/Slack scaffolding the wizard onboards.                                                 |
| **TDD-011: Chat onboarding follow-up**                                                                                                          | Phase 8 anchor              | Refines TDD-008's chat surfaces.                                                               |
| **TDD-013: Portal scaffolding**                                                                                                                 | Phase 11 anchor             | Portal install entry point.                                                                    |
| **TDD-014: Portal auth + sessions**                                                                                                             | Phase 11 anchor             | Account creation flows the wizard walks.                                                       |
| **TDD-015: Portal pipeline view**                                                                                                               | Phase 11 anchor             | Verification target for `/healthz` and pipeline display.                                       |
| **TDD-016: CI workflow scaffolds**                                                                                                              | Phase 12 anchor             | Source of `.github/workflows/autonomous-dev-*.yml` content.                                    |
| **TDD-017: Secrets and branch protection**                                                                                                      | Phase 12 anchor             | Secrets configuration and branch-protection guidance.                                          |
| **TDD-018: Request-type framework**                                                                                                             | Phase 13 anchor             | Catalog of request types.                                                                      |
| **TDD-019: Extension hooks API**                                                                                                                | Phase 13 anchor             | Custom hook registration.                                                                      |
| **TDD-020: Reviewer chain runtime**                                                                                                             | Phase 15 anchor             | Specialist reviewer enumeration and chain runtime.                                             |
| **TDD-021: Engineering standards plugin chaining**                                                                                              | Phase 14 + 15 anchor        | Standards-meta-reviewer, prompt renderer, fix-recipe, two-person-approval contract.            |
| **TDD-023: Deployment-backends framework** (see PRD-014)                                                                                        | Phase 16 anchor             | Framework the wizard configures backends against.                                              |
| **TDD-024: Cred-proxy + egress firewall + cost estimation**                                                                                     | Phase 16 anchor             | Credential and egress security primitives the wizard wires.                                    |
| **PRD-014: Deployment Backends Framework** (`plugins/autonomous-dev/docs/prd/PRD-014-deployment-backends-framework.md`)                         | Phase 16 reference          | Bundled vs. plugin-based backend split, multi-env model.                                       |
| **PRD-015: Assist Extension** (forthcoming)                                                                                                     | Phase 12 + 16 coordination  | Chain-level guidance for chains/deploy/cred-proxy/firewall — wizard links rather than inlines. |
| **PRD-017: Cleanup, Hygiene, and Operational Closeout** (this branch)                                                                            | Sibling, prerequisite       | `observe.yml.example` (phase 12) and cost-cap-enforcer outcome (phase 16) depend on PRD-017 closeout. |
| **`pwatsonr/autonomous-dev-homelab`**                                                                                                            | Deferred phases owner       | Phases 17-19 ship from that separate repo.                                                     |

---

*End of AMENDMENT-002: Setup-Wizard Phase Coverage Extension*
