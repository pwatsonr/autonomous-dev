# PRD-015: Extend autonomous-dev-assist for Plugin Chains, Deploy Framework, Cloud Backends, Credential Proxy, Egress Firewall, and Cost Estimation

| Field        | Value                                                                                              |
|--------------|----------------------------------------------------------------------------------------------------|
| **Title**    | Extend autonomous-dev-assist for Chains / Deploy / Cloud / Cred-Proxy / Firewall / Cost Estimation |
| **PRD ID**   | PRD-015                                                                                            |
| **Version**  | 1.0                                                                                                |
| **Date**     | 2026-05-03                                                                                         |
| **Author**   | Patrick Watson                                                                                     |
| **Status**   | Draft                                                                                              |
| **Plugin**   | autonomous-dev-assist                                                                              |
| **Upstream** | TDD-019, TDD-020, TDD-021, TDD-022, TDD-023, TDD-024 (all landed on `main` HEAD `6134de9`)         |

---

## 1. Summary

The `autonomous-dev-assist` plugin (`skills/{help,config-guide,troubleshoot,setup-wizard}`, `agents/{onboarding,troubleshooter}`, `commands/{assist,quickstart,eval}`, `instructions/runbook.md`, `evals/test-cases/*`) is the operator-facing surface that answers questions like "why did my pipeline pause?", "what skill should I configure?", and "how do I onboard a new cloud backend?". It was last extended for TDD-019 (extension hooks) and reflects the system as it existed at that point. Since then, six major capability surfaces have landed on `main` and ship with the core plugin: plugin chains (TDD-022), the deploy framework with approval state machine and cost cap enforcement (TDD-023), four cloud backend plugins (TDD-024 §6), a credential proxy with per-cloud scopers and SCM_RIGHTS Unix-socket transport (TDD-024 §7-§10), a Linux/macOS egress firewall with DNS refresh (TDD-024 §11-§13), and per-cloud cost estimation with pricing fixtures (TDD-024 §14). In addition, TDD-020 added five new quality reviewer agents bringing the total to 18. None of these are referenced in the assist plugin today, which means operators receive incomplete or wrong guidance for the most security- and cost-sensitive surfaces of the system. This PRD specifies the work required to bring the assist plugin to parity with `main`: five SKILL.md updates, two agent updates, four command updates, four new instruction runbooks, four new eval suites totaling roughly 80 cases on top of the existing 90, and a README refresh.

---

## 2. Goals

| ID    | Goal                                                                                                                                        |
|-------|---------------------------------------------------------------------------------------------------------------------------------------------|
| G-01  | Restore content parity between `autonomous-dev-assist` and the `autonomous-dev` plugin as of `main` HEAD, covering TDD-020/021/022/023/024. |
| G-02  | Ensure operators receive correct, actionable answers for the six new surfaces (chains, deploy, cloud backends, cred-proxy, firewall, cost). |
| G-03  | Reduce "assist gave wrong answer" incidents on security- and cost-critical surfaces (HMAC keys, approval gates, cost-cap trips) to zero.    |
| G-04  | Add measurable eval coverage for each new surface, with at least 95% pass rate as the merge gate for this PRD's downstream TDD/Plan/Specs.  |
| G-05  | Preserve the existing assist UX: same skills, same commands, same eval harness — only the content broadens.                                 |
| G-06  | Document each new operator workflow as a runbook so the troubleshooter agent has a single canonical source to point to.                     |
| G-07  | Keep the plugin shippable as a drop-in upgrade — no breaking changes to skill names, command names, or eval YAML structure.                 |

---

## 3. Non-Goals

| ID     | Non-Goal                                                                                                                                                                                                                                                                                          |
|--------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| NG-01  | **Not modifying core behavior of any TDD-022/023/024 surface.** This PRD only documents and assists; it does not change chain semantics, deploy approval rules, cred-proxy TTLs, firewall backends, or cost estimator pricing fixtures. Why: all those surfaces are already shipped and tested.  |
| NG-02  | **Not adding new top-level commands** (e.g., a `deploy-doctor` command). The existing `assist`, `quickstart`, `eval` set is sufficient. Why: scope control — adding a new command surface requires its own PRD and would delay parity. (Open Question OQ-3 revisits this.)                       |
| NG-03  | **Not implementing live integration tests** that actually call cred-proxy, fire deploy approvals, or invoke firewall backends. Eval cases score the assist's *answers*, not the system's behavior. Why: integration tests are owned by the upstream TDDs (021/022/023/024) and already exist.    |
| NG-04  | **Not migrating to an SDK-based assist** (vector-store retrieval, embedding-based context). The current Glob/Grep/Read pattern is sufficient and matches the existing eval harness. Why: out of scope; would invalidate the existing 90 eval cases.                                              |
| NG-05  | **Not updating the `autonomous-dev` core plugin's documentation.** This PRD is scoped to `autonomous-dev-assist`. Why: the core plugin's READMEs were updated in PR #50 (commit `6134de9`); duplication would risk drift.                                                                          |
| NG-06  | **Not pinning specific TDD SHAs into assist content.** Skill content references concepts and command names, not commit SHAs. Why: the assist plugin must remain readable as the underlying TDDs evolve; SHA pinning would force a content update on every TDD revision.                          |

---

## 4. Background

### 4.1 Why this gap exists

The `autonomous-dev-assist` plugin was created in PRD-006 (intake & communication) as the operator-facing companion to the autonomous-dev daemon. Its content is curated by hand: the SKILL.md files contain reference tables, command syntaxes, error patterns, and FAQ-style entries. Each table was last extended in PLAN-019 to reflect TDD-019's extension-hook surface (intake adapters, observation collectors, escalation routes).

Between TDD-019 and `main` HEAD `6134de9`, six independent feature streams landed:

1. **TDD-022 (Plugin Chains)** introduced a manifest schema (`plugin-manifest-v2`) with `produces` / `consumes` / `egress_allowlist` fields, a chains-graph topological resolver, an HMAC chain audit log (`~/.autonomous-dev/chains/audit.log`), and four CLI commands: `chains list`, `chains graph`, `chains audit`, `chains approve|reject`.
2. **TDD-023 (Deploy Framework)** introduced `deploy backends` discovery, the `deploy plan|approve|reject` approval state machine, `deploy logs|cost|estimate` observability, `deploy-config-v1` YAML schema, the cost-cap-enforcer subsystem with persistent ledger, the HealthMonitor with SLA tracker, and the DeployLogger.
3. **TDD-024 §6 (Cloud Backends)** shipped four separate plugins: `autonomous-dev-deploy-{gcp,aws,azure,k8s}`, each registering a backend with the deploy framework.
4. **TDD-024 §7-§10 (Credential Proxy)** introduced the `cred-proxy` CLI, per-cloud scopers (aws/gcp/azure/k8s), Unix-socket SCM_RIGHTS server transport, TTL with auto-revoke, and a per-issuance audit hash.
5. **TDD-024 §11-§13 (Egress Firewall)** introduced two backends — `nftables` (Linux) and `pfctl` (macOS) — plus a DNS-refresh loop and per-plugin allowlist resolution.
6. **TDD-024 §14 (Cost Estimation)** introduced per-cloud cost-estimators backed by pricing fixtures, surfaced through `deploy estimate`.

Independently, **TDD-020 (Quality Reviewer Suite)** added five new reviewer agents — `standards-meta-reviewer`, `qa-edge-case-reviewer`, `ux-ui-reviewer`, `accessibility-reviewer`, `rule-set-enforcement-reviewer` — bringing the canonical agent count to 18.

### 4.2 Operator-impact gap

The current assist content is stale in concrete, measurable ways:

| Asset                                  | Current state                                                                | Real state on `main`                                                                  |
|----------------------------------------|------------------------------------------------------------------------------|---------------------------------------------------------------------------------------|
| `skills/help/SKILL.md`                 | Lists 13 agents                                                              | 18 agents on `main`                                                                   |
| `skills/help/SKILL.md`                 | Zero references to chains, deploy, cred-proxy, firewall                      | All four are top-level operator-facing surfaces                                       |
| `skills/config-guide/SKILL.md`         | 20 sections                                                                  | Missing: chains, deploy, cred_proxy, firewall, cost_estimation (5 new sections)       |
| `skills/troubleshoot/SKILL.md`         | Zero scenarios for the new surfaces                                          | Operators hit chain-cycle / approval-stuck / cost-cap-trip / TTL-expired regularly    |
| `skills/setup-wizard/SKILL.md`         | 10 phases ending at extension hooks                                          | Cloud-deploy onboarding (cred-proxy bootstrap, firewall backend selection) absent     |
| `agents/troubleshooter.md`             | File-locations table stops at TDD-019 paths                                  | Misses `~/.autonomous-dev/chains/`, `~/.autonomous-dev/deploy/{plans,ledger,logs}/`   |
| `agents/onboarding.md`                 | Pipeline-status table stops at TDD-019                                       | No mention of approval gates, cost ceilings, or egress allowlist                      |
| `commands/assist.md`                   | Glob targets miss `intake/{chains,deploy,cred-proxy,firewall}`               | Assist cannot find chain or deploy intake docs in its search step                     |
| `evals/test-cases/`                    | 4 reviewer-eval suites (90 cases) for TDD-020/021                            | No suites for chains / deploy / cred-proxy / firewall                                 |

### 4.3 Risk if we ship as-is

The assist plugin is the first place an operator goes when something breaks in the surfaces this PRD covers. The blast radius of stale content is highest exactly where stakes are highest:

- **HMAC key custody (chains audit).** If an operator asks "why does `chains audit verify` say HMAC mismatch?" and the assist hallucinates a non-existent rotation command, the operator may delete the audit log to "fix" it, destroying an irreplaceable security record.
- **Approval gates (deploy).** If assist tells an operator "deploy phase auto-proceeds at trust L2" without mentioning the `prod always requires approval` override, the operator may wait indefinitely on a gate they need to manually approve.
- **Cost-cap trip (deploy).** If assist cannot explain why a deploy aborted, the operator cannot diagnose whether the cap was hit, whether the ledger is corrupt, or whether the cap value is wrong.
- **Firewall denial (egress).** If assist cannot explain `EHOSTUNREACH` from a backend plugin, the operator may attribute it to a network outage rather than a missing entry in `egress_allowlist`.
- **Cred-proxy TTL (cloud).** If assist cannot explain a 15-minute STS expiry mid-deploy, the operator may rotate root credentials unnecessarily.

In each case, the cost of a wrong answer is higher than the cost of writing the documentation.

---

## 5. User Stories

| ID    | As a…    | I want to…                                                                       | So that…                                                                                                                |
|-------|----------|----------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------|
| US-01 | operator | ask assist "why did my chain pause?"                                             | I get a correct explanation of approval-gate semantics and a pointer to `chains audit verify`.                          |
| US-02 | operator | ask assist "what does `chains audit` show?"                                      | I learn it is an HMAC-chained log, where the key lives, and how rotation works (or that it does not).                   |
| US-03 | operator | ask assist "my deploy is stuck on `awaiting-approval`"                           | I get the exact `deploy approve REQ-NNNNNN` command and the prod-override rule.                                          |
| US-04 | operator | ask assist "deploy aborted: cost cap exceeded"                                   | I get the cap location, ledger location, and `deploy estimate` workflow before retry.                                    |
| US-05 | operator | ask assist "how do I install the GCP backend?"                                   | I get the plugin name, install command, cred-proxy bootstrap, and egress-allowlist defaults in one answer.               |
| US-06 | operator | ask assist "cred-proxy says permission denied on Unix socket"                    | I learn about SCM_RIGHTS, socket file permissions, and the `cred-proxy doctor` command.                                  |
| US-07 | operator | ask assist "firewall denied my backend's HTTPS request"                          | I get the allowlist file location, the DNS-refresh interval, and the `firewall test` command.                            |
| US-08 | operator | run `/autonomous-dev-assist:quickstart` on a fresh laptop with cloud deploy goal | the wizard walks me through cred-proxy bootstrap, firewall backend selection, and a dry-run deploy.                      |
| US-09 | operator | ask assist "what reviewer agents exist?"                                         | I get the full 18-agent list including the five TDD-020 additions.                                                       |
| US-10 | operator | run `/autonomous-dev-assist:eval all`                                            | all four new suites (chains, deploy, cred-proxy, firewall) execute and report pass rates.                                |
| US-11 | operator | grep `~/.autonomous-dev/` for any subsystem from the assist plugin              | the troubleshooter agent's file-locations table includes chain audit, deploy ledger, deploy plans, and firewall logs.    |
| US-12 | operator | configure `cost_estimation.fixture_path` in their config                         | the config-guide skill explains the schema, default fixtures, and how to override per-cloud pricing.                     |

---

## 6. Functional Requirements

### 6.1 Skill content updates (5 SKILLs)

| ID       | Priority | Requirement                                                                                                                                                                                                                                                          |
|----------|----------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1501  | P0       | `skills/help/SKILL.md` SHALL list **18 agents** (the existing 13 + the 5 added by TDD-020). Each new agent SHALL have a one-line description and a "fires during" pipeline phase.                                                                                |
| FR-1502  | P0       | `skills/help/SKILL.md` SHALL add a top-level section **"Plugin Chains"** describing `produces`/`consumes`/`egress_allowlist` manifest fields, the topological resolver, and the four `chains` CLI subcommands.                                                    |
| FR-1503  | P0       | `skills/help/SKILL.md` SHALL add a top-level section **"Deploy Framework"** covering backends discovery, `deploy plan|approve|reject` state machine, `deploy logs|cost|estimate`, and the prod-always-approval rule.                                              |
| FR-1504  | P0       | `skills/help/SKILL.md` SHALL add a top-level section **"Cloud Backends"** listing the four plugin names (`autonomous-dev-deploy-{gcp,aws,azure,k8s}`), their capability declarations, and how they register with the framework.                                   |
| FR-1505  | P0       | `skills/help/SKILL.md` SHALL add a top-level section **"Credential Proxy"** explaining the per-cloud scopers, the SCM_RIGHTS Unix-socket transport, the 15-minute default TTL, the auto-revoke contract, and the per-issuance audit hash.                          |
| FR-1506  | P0       | `skills/help/SKILL.md` SHALL add a top-level section **"Egress Firewall"** explaining the nftables (Linux) / pfctl (macOS) backends, the DNS-refresh loop, the per-plugin allowlist, and how to test with `firewall test`.                                       |
| FR-1507  | P1       | `skills/help/SKILL.md` SHALL add a top-level section **"Cost Estimation"** explaining the per-cloud estimators, pricing fixture format, override path, and the `deploy estimate` CLI.                                                                            |
| FR-1508  | P0       | `skills/config-guide/SKILL.md` SHALL add a section **`chains`** documenting the manifest-v2 fields, the audit log path, HMAC key location, and the `chains.audit.key_env` env-var override.                                                                       |
| FR-1509  | P0       | `skills/config-guide/SKILL.md` SHALL add a section **`deploy`** documenting `deploy.yaml` schema, environment inheritance rules, approval gates, and per-environment `cost_cap_usd`.                                                                              |
| FR-1510  | P0       | `skills/config-guide/SKILL.md` SHALL add a section **`cred_proxy`** documenting socket path, default TTL, scoper plugin paths, and the `CRED_PROXY_AUDIT_KEY_ENV` env var.                                                                                       |
| FR-1511  | P0       | `skills/config-guide/SKILL.md` SHALL add a section **`firewall`** documenting backend selection (`nftables`|`pfctl`|`disabled`), DNS-refresh interval, and per-plugin allowlist file path.                                                                       |
| FR-1512  | P1       | `skills/config-guide/SKILL.md` SHALL add a section **`cost_estimation`** documenting pricing fixture override path, fixture schema (per-cloud, per-resource), and per-environment cap interaction.                                                                |
| FR-1513  | P0       | `skills/troubleshoot/SKILL.md` SHALL add at least **5 new scenarios**: chain cycle detected, deploy approval stuck, cost cap trip, cred-proxy TTL expired mid-deploy, firewall denial of allowed-looking host (DNS-refresh lag).                                  |
| FR-1514  | P1       | `skills/troubleshoot/SKILL.md` SHALL add a scenario for HMAC mismatch in `chains audit verify` with explicit warning **"do not delete the audit log"**.                                                                                                          |
| FR-1515  | P0       | `skills/setup-wizard/SKILL.md` SHALL add **at least 4 new phases**: cloud backend selection, cred-proxy bootstrap, firewall backend choice, dry-run cloud deploy. Phase numbering SHALL extend cleanly from the existing 10 phases.                              |
| FR-1516  | P1       | `skills/setup-wizard/SKILL.md` SHALL clearly mark the new phases as **optional** for operators who do not use cloud deploy, so the local-only path is unchanged.                                                                                                  |

### 6.2 Agent updates (2 agents)

| ID       | Priority | Requirement                                                                                                                                                                                                                                                                  |
|----------|----------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1517  | P0       | `agents/troubleshooter.md` file-locations table SHALL include rows for `~/.autonomous-dev/chains/audit.log`, `~/.autonomous-dev/chains/manifest.lock`, `~/.autonomous-dev/deploy/plans/`, `~/.autonomous-dev/deploy/ledger.json`, `~/.autonomous-dev/deploy/logs/`. |
| FR-1518  | P0       | `agents/troubleshooter.md` SHALL include rows for `~/.autonomous-dev/cred-proxy/socket`, `~/.autonomous-dev/cred-proxy/audit.log`, and `~/.autonomous-dev/firewall/{allowlist,denied.log}`.                                                                              |
| FR-1519  | P0       | `agents/troubleshooter.md` SHALL gain a **"chain & deploy diagnostics"** subsection describing how to run `chains audit verify`, `deploy logs REQ-NNNNNN`, `cred-proxy doctor`, and `firewall test`.                                                                       |
| FR-1520  | P0       | `agents/onboarding.md` pipeline-status table SHALL include rows for `awaiting-approval`, `cost-cap-tripped`, `firewall-denied`, and `cred-proxy-ttl-expired` states.                                                                                                       |
| FR-1521  | P1       | `agents/onboarding.md` SHALL gain a "first cloud deploy" appendix that points operators at the cloud-deploy quickstart phases added by FR-1515.                                                                                                                              |

### 6.3 Command updates (4 commands incl. README)

| ID       | Priority | Requirement                                                                                                                                                                                       |
|----------|----------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1522  | P0       | `commands/assist.md` Glob targets in Step 2 SHALL include `intake/chains/*`, `intake/deploy/*`, `intake/cred-proxy/*`, `intake/firewall/*`, plus the four cloud-backend plugin directories.       |
| FR-1523  | P0       | `commands/assist.md` SHALL update the question-classification list (Step 1) to add **"deploy"**, **"chains"**, and **"security"** as recognized categories that route into the new content.       |
| FR-1524  | P1       | `commands/quickstart.md` SHALL gain an optional flag `--with-cloud` (or equivalent prompt) that triggers the new cloud-deploy phases from FR-1515.                                                |
| FR-1525  | P0       | `commands/eval.md` SHALL list the four new suites (`chains`, `deploy`, `cred-proxy`, `firewall`) as valid arguments and update the `all` behavior to include them.                                |
| FR-1526  | P0       | `README.md` SHALL update the "Available commands" and "Project structure" sections to reflect the new instruction runbooks and eval suites added by this PRD.                                     |

### 6.4 New instruction runbooks (4 runbooks)

| ID       | Priority | Requirement                                                                                                                                                                                                                                                              |
|----------|----------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1527  | P0       | A new file `instructions/chains-runbook.md` SHALL be created covering: dependency graph troubleshooting, HMAC audit verification, broken-chain recovery, manifest-v2 migration. It SHALL link back to the help and troubleshoot SKILLs.                              |
| FR-1528  | P0       | A new file `instructions/deploy-runbook.md` SHALL be created covering: approval state machine walkthrough, cost-cap trip recovery, ledger inspection, rollback (forward to PRD-014 §17.R7 mitigation), HealthMonitor + SLA tracker output.                            |
| FR-1529  | P0       | A new file `instructions/cred-proxy-runbook.md` SHALL be created covering: bootstrap, scoper installation per cloud, socket-permission troubleshooting, TTL tuning, audit-hash chain verification, emergency revoke.                                                  |
| FR-1530  | P0       | A new file `instructions/firewall-runbook.md` SHALL be created covering: backend selection (Linux vs macOS), DNS-refresh tuning, allowlist authoring, simulating a deny, reading `denied.log`, "fail-open" disabled mode for development only.                       |
| FR-1531  | P1       | The existing `instructions/runbook.md` SHALL gain a **"See also"** index pointing to the four new runbooks.                                                                                                                                                          |

### 6.5 New eval suites (4 suites, ~80 cases)

| ID       | Priority | Requirement                                                                                                                                                                                                                                                          |
|----------|----------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1532  | P0       | A new file `evals/test-cases/chains-eval.yaml` SHALL contain **at least 20 cases** spanning: list/graph/audit happy paths, cycle detection, HMAC mismatch, manifest-v2 schema errors, approve/reject semantics, "did the assist mention the audit log path?".  |
| FR-1533  | P0       | A new file `evals/test-cases/deploy-eval.yaml` SHALL contain **at least 30 cases** spanning: backends list/describe, plan/approve/reject, cost-cap trip, ledger corruption, HealthMonitor failure, SLA tracker degraded state, prod-always-approval enforcement.  |
| FR-1534  | P0       | A new file `evals/test-cases/cred-proxy-eval.yaml` SHALL contain **at least 15 cases** spanning: scoper missing, socket permission denied, TTL expiry mid-deploy, audit-hash mismatch, emergency revoke, per-cloud scoper boundary cases.                            |
| FR-1535  | P0       | A new file `evals/test-cases/firewall-eval.yaml` SHALL contain **at least 15 cases** spanning: nftables vs pfctl backend selection, allowlist syntax errors, DNS-refresh lag denial, fail-open misconfiguration, missing-backend on unsupported OS, `firewall test` interpretation. |
| FR-1536  | P0       | All new eval YAMLs SHALL conform to the existing schema (`id`, `suite`, `input`, `expected`, `must_not_contain`) so the existing `runner.sh` and `scorer.sh` need no modification.                                                                                |
| FR-1537  | P1       | `evals/eval-config.yaml` SHALL register the four new suites and define their default invocation order.                                                                                                                                                          |
| FR-1538  | P1       | `evals/test-cases/` SHALL include at least 5 **negative cases per suite** (`must_not_contain` clauses for hallucinated commands like `cred-proxy rotate-root` or `firewall disable-all`).                                                                       |

### 6.6 Cross-cutting

| ID       | Priority | Requirement                                                                                                                                                                                            |
|----------|----------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1539  | P0       | All new content SHALL use the **same tone, heading hierarchy, and table style** as the existing assist content (sentence case, GitHub-flavored markdown, `Bash` fences for commands).                |
| FR-1540  | P0       | All new content SHALL **avoid pinning specific TDD commit SHAs**; references SHALL be by feature name (TDD-022 plugin chains, TDD-024 §11 firewall) so content remains valid as TDDs evolve.        |
| FR-1541  | P1       | All new content SHALL be cross-linked from `skills/help/SKILL.md` "See also" sections to the new instruction runbooks for navigability.                                                              |
| FR-1542  | P0       | The downstream Plan/Spec SHALL split this PRD into **at least 4 TDDs** along surface boundaries (chains, deploy, cloud+cred-proxy, firewall+cost) so each can land as an independent, reviewable PR. |

---

## 7. Success Metrics

| Metric                                                                                       | Baseline                       | Target                       | Timeframe                     |
|----------------------------------------------------------------------------------------------|--------------------------------|------------------------------|-------------------------------|
| Eval pass rate on **all four new suites** (chains, deploy, cred-proxy, firewall)             | N/A (suites do not exist)      | ≥ 95%                        | Before merge of downstream Plan |
| Eval pass rate on the **existing 90 cases** after PR lands                                   | ≥ 95%                          | ≥ 95% (no regression)        | At merge                      |
| Number of agents listed in `skills/help/SKILL.md`                                            | 13                             | 18                           | At merge                      |
| Number of sections in `skills/config-guide/SKILL.md`                                         | 20                             | 25                           | At merge                      |
| Operator support tickets categorized as "assist gave wrong answer" on chain/deploy surfaces  | TBD — instrument before launch | 0                            | First 30 days post-merge      |
| Operator support tickets on cred-proxy / firewall surfaces resolved by quoting a runbook     | TBD — instrument before launch | ≥ 80%                        | First 30 days post-merge      |
| Time from `/autonomous-dev-assist:quickstart --with-cloud` start to first dry-run deploy     | N/A                            | < 15 minutes (operator wall) | First 30 days post-merge      |

Note: support-ticket baselines are TBD because the categorization scheme does not yet split by surface. Instrumentation (a `category` field on the ticket form) is added to the launch plan in §11.

---

## 8. Acceptance Criteria

The PR resulting from this PRD's downstream Plan/Spec is acceptance-eligible when **all** of the following hold:

### 8.1 Skills (5 SKILL.md files)
- [ ] `help/SKILL.md` lists 18 agents and adds the 6 new top-level sections (chains, deploy, cloud, cred-proxy, firewall, cost).
- [ ] `config-guide/SKILL.md` adds 5 new sections (chains, deploy, cred_proxy, firewall, cost_estimation).
- [ ] `troubleshoot/SKILL.md` adds ≥ 5 new scenarios covering chain cycle, deploy approval stuck, cost cap trip, cred-proxy TTL, firewall denial, plus the HMAC-mismatch warning scenario.
- [ ] `setup-wizard/SKILL.md` adds ≥ 4 new (optional) phases for cloud onboarding.

### 8.2 Agents (2 agents)
- [ ] `troubleshooter.md` file-locations table covers chains/deploy/cred-proxy/firewall paths.
- [ ] `onboarding.md` pipeline-status table covers the 4 new states.

### 8.3 Commands (4 commands incl. README)
- [ ] `assist.md` Glob targets and classification categories include the new surfaces.
- [ ] `quickstart.md` exposes `--with-cloud` (or equivalent).
- [ ] `eval.md` lists the new suites.
- [ ] `README.md` reflects the new runbooks and suites.

### 8.4 Instruction runbooks (4 new files)
- [ ] `chains-runbook.md`, `deploy-runbook.md`, `cred-proxy-runbook.md`, `firewall-runbook.md` exist and follow the structure of the existing `runbook.md`.
- [ ] Each runbook has at least: bootstrap, common failures, recovery, audit/inspection commands, escalation guidance.

### 8.5 Eval suites (4 new files, ~80 cases)
- [ ] `chains-eval.yaml` ≥ 20 cases.
- [ ] `deploy-eval.yaml` ≥ 30 cases.
- [ ] `cred-proxy-eval.yaml` ≥ 15 cases.
- [ ] `firewall-eval.yaml` ≥ 15 cases.
- [ ] Each suite has ≥ 5 negative cases (`must_not_contain`).
- [ ] All suites pass at ≥ 95% under `runner.sh` against the assist command.

### 8.6 Quality gates
- [ ] Existing 90 eval cases continue to pass at ≥ 95% (no regression).
- [ ] All new files pass markdown lint (heading hierarchy, fenced blocks, no broken links).
- [ ] All cross-links resolve.
- [ ] No file references commit SHAs of TDD-022/023/024 (per FR-1540).

---

## 9. Risks & Mitigations

| ID  | Risk                                                                                                                       | Likelihood | Impact | Mitigation                                                                                                                                                                |
|-----|----------------------------------------------------------------------------------------------------------------------------|------------|--------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| R-1 | TDDs 022–024 evolve before this PRD's downstream Plan lands; assist content drifts out of date again.                      | Medium     | Medium | Decompose into ≥ 4 TDDs (FR-1542); each lands independently. Reference TDDs by name and section, not by SHA (FR-1540). Set a Slack reminder to re-review at PRD-016 time. |
| R-2 | Each new eval case is a real Claude API call; running 80 new + 90 existing = 170 cases per `eval all` invocation.          | High       | Low    | Score eval cost in the downstream Plan. Add a `--suite` filter (already exists). Document expected runtime and rough $/run in `commands/eval.md`.                          |
| R-3 | Operators run `--with-cloud` quickstart without the cloud plugins installed; wizard fails confusingly.                     | Medium     | Medium | Wizard prerequisites step (FR-1515) checks for plugin presence before phases run; emits a clear "install autonomous-dev-deploy-{cloud}" message and exits cleanly.        |
| R-4 | Authors of new SKILL content describe behavior the system does not actually have (hallucination from older PRD reads).     | Medium     | High   | Each new section MUST cite the TDD section it documents in a footer. Reviewer agent rejects sections without TDD anchors.                                                  |
| R-5 | Eval false positives: assist gives correct answer that does not happen to match the YAML's `expected` substring.           | Medium     | Low    | Use multiple `expected` alternatives per case where applicable; lean on `must_not_contain` for hard-fail conditions; prefer behavioral over wording assertions.            |
| R-6 | The `--with-cloud` quickstart leaks credentials into transcripts when operators paste tokens into the wizard.              | Low        | High   | Wizard never echoes secrets; uses env-var names (`AWS_PROFILE`, `GCP_CREDS_PATH`) consistent with PRD-008 / PRD-014 §5.5. Runbooks include "do not paste secrets" warning. |
| R-7 | HMAC-key guidance in assist is incorrect (e.g., suggests rotation when none exists), leading operator to destroy audit log. | Low        | Critical | FR-1514 mandates an explicit "do not delete the audit log" warning in the troubleshoot scenario. Eval suite includes a `must_not_contain` for `rm.*audit.log`.            |
| R-8 | Markdown drift between assist content and source-of-truth READMEs in core plugin causes operator confusion.                | Medium     | Low    | All new SKILL sections include a "Canonical reference" footer linking the corresponding TDD or core README, so operators can reach upstream truth in one click.            |

---

## 10. Dependencies

| Dependency                                                                     | Status                                          |
|--------------------------------------------------------------------------------|-------------------------------------------------|
| TDD-019 (extension hooks) — already documented in current assist content       | Done                                            |
| TDD-020 (5 new reviewer agents)                                                | Landed on `main` (commit `f07ab40`, `b447bce`)  |
| TDD-021 (standards plugin chaining)                                            | Landed on `main` (commit `ce44d2c`)             |
| TDD-022 (plugin chains + manifest-v2)                                          | Landed on `main`                                |
| TDD-023 (deploy framework + cost cap + HealthMonitor)                          | Landed on `main`                                |
| TDD-024 §6 (cloud backend plugins)                                             | Landed on `main`                                |
| TDD-024 §7-§10 (credential proxy)                                              | Landed on `main`                                |
| TDD-024 §11-§13 (egress firewall)                                              | Landed on `main`                                |
| TDD-024 §14 (cost estimation)                                                  | Landed on `main`                                |
| Existing assist eval harness (`runner.sh`, `scorer.sh`)                        | Stable since PRD-006                            |

**Net dependency status: zero blocking dependencies.** All upstream surfaces are merged. This PRD can begin TDD/Plan/Spec immediately.

---

## 11. Launch Plan

| Phase | Activity                                                                                                                              | Exit criterion                                       |
|-------|---------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------|
| 1     | TDD authoring: split into ≥ 4 TDDs per FR-1542.                                                                                       | All TDDs reviewed at ≥ 85.                           |
| 2     | Plan + Spec: estimate eval cost (R-2), confirm content authors per TDD.                                                               | Plan reviewed at ≥ 80; Specs reviewed at ≥ 80.       |
| 3     | Implementation: SKILL updates → agent updates → command updates → runbooks → evals (in that order, since later items reference earlier). | All FR-15xx items checked off.                       |
| 4     | Eval-baseline run on `main` before merge: capture pass rate on existing 90 cases.                                                     | Pass rate captured.                                  |
| 5     | Eval-post run after PR: compare pass rates; require no regression on existing + ≥ 95% on new.                                         | Both gates green.                                    |
| 6     | Instrumentation: add `category: chains|deploy|cred-proxy|firewall|cost|other` field to the operator support-ticket form.              | First ticket received with new field set.            |
| 7     | Soak: 30-day post-merge observation of ticket volume per category.                                                                    | Success metrics §7 evaluated; PRD-016 scoped if needed. |

---

## 12. Open Questions

| ID    | Question                                                                                                                                                                  | Recommended answer                                                                                                                              | Status |
|-------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------|--------|
| OQ-1  | Should this PRD gate on TDD-024 SHA placeholders being pinned in the upstream READMEs?                                                                                    | **No.** FR-1540 explicitly forbids SHA pinning; gating would create circular dependency. Reference upstream by section title.                   | Open   |
| OQ-2  | Should we add a `deploy-doctor` command that wraps `deploy logs|cost|estimate|backends list` into a single triage flow, similar to `troubleshooter`?                       | **Defer to PRD-016.** Out of scope per NG-02. If operator-ticket data in §11 phase 7 shows deploy is the dominant bucket, propose then.         | Open   |
| OQ-3  | Should new eval cases include "negative" prompts (e.g., "tell me how to disable the firewall in prod") to verify the assist refuses?                                      | **Yes.** Already covered by FR-1538's negative cases via `must_not_contain` for `firewall.*disable-all`, etc.                                   | Closed |
| OQ-4  | Should `cost_estimation` content live in `help/SKILL.md` (per FR-1507) or in `config-guide/SKILL.md` (per FR-1512), or both?                                              | **Both.** Help has a conceptual section; config-guide has the schema. Cross-link both via FR-1541.                                              | Closed |
| OQ-5  | Should the assist surface the actual contents of `~/.autonomous-dev/chains/audit.log` or only document the verification command?                                          | **Document only.** Surfacing log contents risks leaking HMAC plaintext; verification command (`chains audit verify`) is sufficient.             | Open   |
| OQ-6  | Does the `--with-cloud` quickstart try to install missing cloud plugins, or only check?                                                                                   | **Check, don't install.** Plugin installation is a Claude Code marketplace action; assist should surface it but not perform it.                  | Open   |
| OQ-7  | Should we increase the help-question reviewer threshold from current default to 90, given the security stakes on chain/deploy answers?                                    | **Yes for the four new suites; keep existing 90 cases at current threshold.** Document in `evals/eval-config.yaml`.                              | Open   |
| OQ-8  | Should the four new runbooks each get their own `instructions/*.md` file (per FR-1527..1530) or be sub-sections of the existing `runbook.md`?                             | **Separate files.** Existing `runbook.md` is already 1263 lines; further bloat hurts navigability and CI lint times.                            | Closed |

---

## 13. References

| Document                                                                                                          | Relationship           |
|-------------------------------------------------------------------------------------------------------------------|------------------------|
| `plugins/autonomous-dev/docs/prd/PRD-006-intake-communication.md`                                                  | Defines original assist |
| `plugins/autonomous-dev/docs/prd/PRD-011-pipeline-variants-extension-hooks.md`                                     | Last assist extension  |
| `plugins/autonomous-dev/docs/prd/PRD-012-quality-reviewer-suite.md`                                                | TDD-020 source         |
| `plugins/autonomous-dev/docs/prd/PRD-013-engineering-standards-plugin-chaining.md`                                 | TDD-021 source         |
| `plugins/autonomous-dev/docs/prd/PRD-014-deployment-backends-framework.md`                                         | TDD-023/024 source     |
| `plugins/autonomous-dev-assist/skills/{help,config-guide,troubleshoot,setup-wizard}/SKILL.md`                     | Surfaces being updated |
| `plugins/autonomous-dev-assist/agents/{onboarding,troubleshooter}.md`                                              | Surfaces being updated |
| `plugins/autonomous-dev-assist/commands/{assist,quickstart,eval}.md`                                               | Surfaces being updated |
| `plugins/autonomous-dev-assist/instructions/runbook.md`                                                            | Cross-linked from new runbooks |
| `plugins/autonomous-dev-assist/evals/test-cases/`                                                                  | Suites being added     |
| `plugins/autonomous-dev-assist/README.md`                                                                          | Updated index          |

---

## 14. Appendix: File-by-file change inventory

| File                                                                                  | Change type | FR-IDs                  |
|---------------------------------------------------------------------------------------|-------------|-------------------------|
| `plugins/autonomous-dev-assist/skills/help/SKILL.md`                                  | Modified    | FR-1501..FR-1507        |
| `plugins/autonomous-dev-assist/skills/config-guide/SKILL.md`                          | Modified    | FR-1508..FR-1512        |
| `plugins/autonomous-dev-assist/skills/troubleshoot/SKILL.md`                          | Modified    | FR-1513, FR-1514        |
| `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md`                          | Modified    | FR-1515, FR-1516        |
| `plugins/autonomous-dev-assist/agents/troubleshooter.md`                              | Modified    | FR-1517..FR-1519        |
| `plugins/autonomous-dev-assist/agents/onboarding.md`                                  | Modified    | FR-1520, FR-1521        |
| `plugins/autonomous-dev-assist/commands/assist.md`                                    | Modified    | FR-1522, FR-1523        |
| `plugins/autonomous-dev-assist/commands/quickstart.md`                                | Modified    | FR-1524                 |
| `plugins/autonomous-dev-assist/commands/eval.md`                                      | Modified    | FR-1525                 |
| `plugins/autonomous-dev-assist/README.md`                                             | Modified    | FR-1526                 |
| `plugins/autonomous-dev-assist/instructions/chains-runbook.md`                        | New         | FR-1527                 |
| `plugins/autonomous-dev-assist/instructions/deploy-runbook.md`                        | New         | FR-1528                 |
| `plugins/autonomous-dev-assist/instructions/cred-proxy-runbook.md`                    | New         | FR-1529                 |
| `plugins/autonomous-dev-assist/instructions/firewall-runbook.md`                      | New         | FR-1530                 |
| `plugins/autonomous-dev-assist/instructions/runbook.md`                               | Modified    | FR-1531                 |
| `plugins/autonomous-dev-assist/evals/test-cases/chains-eval.yaml`                     | New         | FR-1532, FR-1536, FR-1538 |
| `plugins/autonomous-dev-assist/evals/test-cases/deploy-eval.yaml`                     | New         | FR-1533, FR-1536, FR-1538 |
| `plugins/autonomous-dev-assist/evals/test-cases/cred-proxy-eval.yaml`                 | New         | FR-1534, FR-1536, FR-1538 |
| `plugins/autonomous-dev-assist/evals/test-cases/firewall-eval.yaml`                   | New         | FR-1535, FR-1536, FR-1538 |
| `plugins/autonomous-dev-assist/evals/eval-config.yaml`                                | Modified    | FR-1537                 |

**Total**: 5 SKILL.md updates, 2 agent updates, 4 command/README updates, 4 new runbooks + 1 modified, 4 new eval suites + 1 modified config = **20 file changes**.

---

*End of PRD-015.*
