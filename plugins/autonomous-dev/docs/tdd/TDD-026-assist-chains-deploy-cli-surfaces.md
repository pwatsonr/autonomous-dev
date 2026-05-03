# TDD-026: Assist Plugin Chains & Deploy CLI Surfaces

| Field          | Value                                                         |
|----------------|---------------------------------------------------------------|
| **Title**      | Assist Plugin Chains & Deploy CLI Surfaces                    |
| **TDD ID**     | TDD-026                                                       |
| **Version**    | 1.0                                                           |
| **Date**       | 2026-05-02                                                    |
| **Status**     | Draft                                                         |
| **Author**     | Patrick Watson                                                |
| **Parent PRD** | PRD-015: Extend autonomous-dev-assist for Chains/Deploy/Cloud |
| **Plugin**     | autonomous-dev-assist                                         |
| **Sibling TDDs** | TDD-025 (cloud + cred-proxy), TDD-027 (agents + wizard hand-off), TDD-028 (evals + cross-cutting) |

---

## 1. Summary

This TDD specifies the operator-facing documentation surface for two of the six capability streams that landed between TDD-019 and `main` HEAD: **plugin chains** (owned by TDD-022) and the **deploy framework** (owned by TDD-023). Both are fully shipped in the `autonomous-dev` core plugin but have zero presence in the `autonomous-dev-assist` companion that operators consult first when something breaks.

The work in this TDD is documentation-shaped — no executable behavior changes — but it is documentation against a moving target. TDD-022 introduced four CLI subcommands (`chains list|graph|audit|approve|reject`), an HMAC-chained audit log under `~/.autonomous-dev/chains/audit.log`, and a manifest-v2 schema with `produces`/`consumes`/`egress_allowlist` fields. TDD-023 introduced the `deploy` command tree (`backends`, `plan`, `approve`, `reject`, `logs`, `cost`, `estimate`), a four-state approval state machine (`pending → awaiting-approval → approved|rejected → executing → completed|failed`), a persistent cost-cap ledger at `~/.autonomous-dev/deploy/ledger.json`, and a per-environment `cost_cap_usd` enforcement rule that always requires human approval for `prod` regardless of trust level. Operators encountering either surface today get hallucinated commands, missing file paths, and absent runbooks.

This TDD covers the SKILL.md updates (`help`, `config-guide`), the `assist.md` Glob expansion and classifier extension, the new `commands/deploy-doctor.md` (deferred — see §17 OQ-2), and two new instruction runbooks (`chains-runbook.md`, `deploy-runbook.md`). It defines the **content boundary** between assist (operator quick-reference) and runbook (operator deep-dive), the **anchor convention** that lets reviewer agents detect SHA pinning violations (FR-1540), and the **classifier extension** to `commands/assist.md` that routes `deploy:`/`chains:`/`security:` keywords into the new content. It also specifies ≥30 eval cases per surface (split between `chains-eval.yaml` and `deploy-eval.yaml`) sufficient to gate ≥95% pass rate per FR-1538-1540 and PRD-015 §7.

The design choice that drives the structure of this TDD is **section-anchored cross-references**: all assist content cites the upstream TDD by section title (e.g., "TDD-022 §5 Plugin Manifest Extensions"), never by commit SHA, so the assist content remains valid as the underlying TDDs evolve under PRD-015 §6.6 FR-1540 and risk R-1.

In-scope FR coverage from PRD-015: FR-1502, FR-1503, FR-1505, FR-1506, FR-1510, FR-1511, FR-1521, FR-1522, FR-1523, FR-1524, FR-1531, FR-1532. Out-of-scope (covered by sibling TDDs): cloud backend listing (TDD-025), cred-proxy SCM_RIGHTS detail (TDD-025), troubleshooter file-locations table extension (TDD-027), eval-config registration (TDD-028).

---

## 2. Goals & Non-Goals

### 2.1 Goals

| ID   | Goal                                                                                                                                  |
|------|---------------------------------------------------------------------------------------------------------------------------------------|
| G-01 | Update `skills/help/SKILL.md` to include the **Plugin Chains** and **Deploy Framework** top-level sections per FR-1502 and FR-1503.   |
| G-02 | Update `skills/config-guide/SKILL.md` to add the `chains` and `deploy` configuration sections per FR-1510 and FR-1511.                |
| G-03 | Update `commands/assist.md` Step-1 classifier and Step-2 Glob targets to recognize and route deploy/chain/security questions (FR-1522, FR-1523). |
| G-04 | Author `instructions/chains-runbook.md` (FR-1531) and `instructions/deploy-runbook.md` (FR-1532) as the operator deep-dive companions to the SKILL surfaces. |
| G-05 | Update `commands/quickstart.md` with a `--with-cloud` toggle that surfaces the chains+deploy phases (FR-1524). The cloud-specific phase content is owned by TDD-025/027; this TDD only adds the toggle plumbing. |
| G-06 | Define ≥20 chain eval cases and ≥30 deploy eval cases that exercise the new content end-to-end (FR-1532, FR-1533). |
| G-07 | Establish the **anchor convention** (TDD-XXX §N Section-Title) so reviewer agents can mechanically detect SHA-pinned references and flag them as violations of FR-1540. |
| G-08 | Establish the **content boundary** between SKILL.md (5–20 line operator quick-reference) and instruction runbook (200+ line deep-dive) so future authors do not collapse the layers. |

### 2.2 Non-Goals

| ID    | Non-Goal                                                                                                                          |
|-------|------------------------------------------------------------------------------------------------------------------------------------|
| NG-01 | **Modifying TDD-022 chain semantics or TDD-023 deploy state machine.** This TDD documents shipped behavior; it does not change it. PRD-015 NG-01. |
| NG-02 | **Authoring cloud-specific deploy content.** `autonomous-dev-deploy-{gcp,aws,azure,k8s}` plugin documentation is owned by TDD-025. |
| NG-03 | **Wiring eval-config.yaml registration.** That is owned by TDD-028 (`eval-config.yaml` is a single shared file across all four new suites). |
| NG-04 | **Extending the troubleshooter file-locations table.** Owned by TDD-027 (the agent surface and the wizard hand-off form one cohesive PR). |
| NG-05 | **Authoring a `commands/deploy-doctor.md`.** Per PRD-015 NG-02 and OQ-2 this is deferred to a subsequent PRD. The optional FR-1542 mention in the dispatch prompt is acknowledged in §17 but not implemented. |
| NG-06 | **Pinning specific TDD commit SHAs.** PRD-015 FR-1540 forbids it. This TDD enforces it via the anchor convention. |

### 2.3 Tenets (apply throughout)

1. **Cite by section, not by SHA.** Cross-reference upstream TDDs with `TDD-022 §5` style anchors so content survives upstream revision.
2. **SKILL.md is reference; runbook is procedure.** A SKILL.md entry answers "what is X?" in 1–10 lines. A runbook answers "I just hit X — what do I do?" in 50–500 lines.
3. **Negative information is critical.** For HMAC keys, audit logs, and cost-cap state, what operators must NOT do (delete the audit log, edit the ledger by hand, rotate keys mid-deploy) is at least as important as what they should do.
4. **Every command in assist must exist in `main`.** Hallucinated commands are the dominant failure mode (PRD-015 R-4, R-7); the eval suite enforces this with `must_not_contain` clauses.

---

## 3. Background

### 3.1 The chains surface (from TDD-022)

TDD-022 introduced plugin chains: a graph of plugins where each declares `produces` (artifact types it emits) and `consumes` (artifact types it ingests), and the chain executor topologically orders them and runs each in a sandboxed worker. Three operator-facing artifacts emerged:

1. **The `chains` CLI tree.** Four subcommands: `chains list` (enumerate registered plugins), `chains graph` (render the dependency DAG), `chains audit verify` (HMAC-validate the chain audit log), `chains approve REQ-NNNNNN` and `chains reject REQ-NNNNNN` (state-machine transitions for chains gated on human approval).
2. **The HMAC-chained audit log.** `~/.autonomous-dev/chains/audit.log` is append-only and HMAC-chained so any tampered entry breaks verification of all subsequent entries. The HMAC key is supplied via the env var named in `chains.audit.key_env` (default: `CHAINS_AUDIT_KEY`); there is **no rotation command** in TDD-022 §13. Operators who hallucinate a rotation command and try to "fix" an HMAC mismatch by deleting the log destroy an irreplaceable security record (PRD-015 R-7).
3. **Manifest-v2 schema.** Each plugin's `.claude-plugin/plugin.json` adds three optional fields: `produces` (string array), `consumes` (string array), `egress_allowlist` (string array of host:port). The chain executor reads these to build the DAG and to drive the egress firewall (TDD-024 §11, owned in assist content by TDD-025).

The chain executor's failure modes that surface to operators are: cycle detected (an upgrade introduced a loop), HMAC mismatch on `chains audit verify`, manifest-v2 schema error (a plugin upgraded without rebasing), missing `produces`/`consumes` declaration when another plugin chains to it, and approval-gate timeout.

### 3.2 The deploy surface (from TDD-023)

TDD-023 introduced the deploy framework as a separate command tree from the existing daemon pipeline. Where the daemon pipeline produces and reviews documents, the deploy framework consumes a built artifact and ships it to a backend (cloud or k8s). Four operator-facing artifacts:

1. **The `deploy` CLI tree.** Seven subcommands: `deploy backends list|describe`, `deploy plan REQ-NNNNNN [--env <env>]`, `deploy approve REQ-NNNNNN`, `deploy reject REQ-NNNNNN [--reason]`, `deploy logs REQ-NNNNNN`, `deploy cost REQ-NNNNNN`, `deploy estimate --env <env> --backend <backend>`.
2. **The four-state approval state machine.** `pending → awaiting-approval → approved|rejected → executing → completed|failed`. Every `prod` environment (configured via `deploy.environments.<name>.is_prod: true`) requires human approval **regardless of trust level**, per TDD-023 §11 Trust Integration. This is the single most-violated assumption: operators at L3 expect prod to auto-proceed and it does not.
3. **The cost-cap ledger.** `~/.autonomous-dev/deploy/ledger.json` is a per-environment running tally. When a `deploy plan` would push the running tally over `deploy.environments.<name>.cost_cap_usd`, the plan aborts with status `cost-cap-tripped`. The ledger is recovered from Stripe-style append-only entries; **never edit by hand** — the `deploy ledger reset` command (TDD-023 §14) is the supported recovery path.
4. **`deploy.yaml`.** Per-repo `deploy/deploy.yaml` defines environments, backends, cost caps, and approval rules. Schema is `deploy-config-v1`. Inheritance: per-environment values override the top-level defaults; CLI flags override per-environment values.

Failure modes that surface to operators: stuck on `awaiting-approval` (operator forgot the approve command or did not realize prod always requires it), `cost-cap-tripped` (most often a stale or corrupt ledger after a crash), backend not registered (cloud plugin not installed — owned by TDD-025), HealthMonitor degraded (post-deploy SLA tracker reports a regression), and `deploy.yaml` schema errors.

### 3.3 The current state of the assist plugin

The assist plugin's content was last extended for TDD-019 (extension hooks). Its surfaces relevant to this TDD:

| Surface                                | Lines | Last extended | Coverage of chains/deploy           |
|----------------------------------------|-------|---------------|--------------------------------------|
| `skills/help/SKILL.md`                 | 385   | TDD-019       | Zero                                 |
| `skills/config-guide/SKILL.md`         | 812   | TDD-019       | Zero                                 |
| `commands/assist.md`                   | 87    | TDD-006       | Globs target only `autonomous-dev/`  |
| `commands/quickstart.md`               | 124   | TDD-019       | No `--with-cloud`                    |
| `instructions/runbook.md`              | 1263  | TDD-019       | Zero "see also" for new runbooks     |
| `evals/test-cases/`                    | 4 files | TDD-020/021 | No chains/deploy suites              |

The 1263-line `runbook.md` is the canonical operator runbook today. Per OQ-8 in PRD-015, the new runbooks are separate files (not appendices) because further extending `runbook.md` would push it past the markdown-link-checker pass-rate threshold and would buryyields the chain/deploy procedures inside an already-too-long document.

### 3.4 Why cross-cutting concerns still apply

Even though this TDD describes documentation, six cross-cutting concerns still apply:

- **Security.** Documenting HMAC behavior incorrectly causes audit-log destruction (R-7).
- **Privacy.** Sample commands and ledger snippets must not include real tenant IDs or hashes.
- **Scalability.** Eval suites grow from 90 to 170+ cases; `runner.sh` must remain useful at that scale.
- **Reliability.** The classifier in `commands/assist.md` must degrade gracefully when keywords overlap (e.g., "deploy security review").
- **Observability.** Each new SKILL section must be discoverable by `Grep` at runtime (no Markdown obscurity that hides keywords).
- **Cost.** Each eval case is a real Claude API call; 170 cases at ~$0.05 each ≈ $8.50/run × CI-per-PR adds up. R-2 in PRD-015 sets the budget context.

---

## 4. Architecture

### 4.1 Component map

```
                  /autonomous-dev-assist:assist <question>
                                  │
                                  ▼
                ┌─────────────────────────────┐
                │ commands/assist.md          │
                │   Step 1: classify          │  ← FR-1523 extends classifier
                │   Step 2: Glob context      │  ← FR-1522 extends Glob targets
                │   Step 3: answer            │
                └─────────────┬───────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌──────────────────┐  ┌──────────────────┐
│ help/SKILL.md │    │ config-guide/    │  │ instructions/    │
│ (FR-1502/3)   │    │   SKILL.md       │  │   chains-runbook │
│               │    │ (FR-1510/11)     │  │   deploy-runbook │
└───────┬───────┘    └────────┬─────────┘  │ (FR-1531/2)      │
        │                     │            └────────┬─────────┘
        └──── "See also" ─────┴──────────────────────┘
                              │
                              ▼
              ┌─────────────────────────────┐
              │ Upstream TDDs (cited by §)  │
              │ TDD-022 / TDD-023           │
              └─────────────────────────────┘
```

The assist command stays the only operator entry point. Its classifier widens; its Glob targets widen; the SKILL.md surfaces it loads gain new top-level sections; the SKILL.md sections "See also"-link the new runbooks. The runbooks themselves are reachable via `Read` from the assist command's Step 3 when the question pattern matches a procedural ask.

### 4.2 The classifier extension

Today `commands/assist.md` Step 1 classifies into three buckets: `help`, `troubleshoot`, `config`. Per FR-1523, three new categories are added: `deploy`, `chains`, `security`. The classification logic is keyword-based (the assist command is a Claude prompt, not a parser), and the TDD specifies the canonical keyword bag:

| Category    | Trigger keywords                                                                   |
|-------------|-------------------------------------------------------------------------------------|
| `chains`    | "chain", "chains", "produces", "consumes", "manifest-v2", "audit.log", "egress_allowlist" |
| `deploy`    | "deploy", "backend", "approval", "approve", "ledger", "cost cap", "estimate", "rollout" |
| `security`  | "HMAC", "key rotation", "audit", "denied", "permission denied", "credentials", "scoper" |

Overlap is intentional: a question like "deploy is denied by firewall" classifies as both `deploy` and `security` and the assist loads both contexts. The design tenet: **classifier widens search, not narrows answer**.

### 4.3 The Glob expansion

Today `commands/assist.md` Step 2 globs only `plugins/autonomous-dev/**`. Per FR-1522, the Glob list adds:

```
Glob: plugins/autonomous-dev/intake/chains/*
Glob: plugins/autonomous-dev/intake/deploy/*
Glob: plugins/autonomous-dev/intake/cred-proxy/*
Glob: plugins/autonomous-dev/intake/firewall/*
Glob: plugins/autonomous-dev-deploy-gcp/**
Glob: plugins/autonomous-dev-deploy-aws/**
Glob: plugins/autonomous-dev-deploy-azure/**
Glob: plugins/autonomous-dev-deploy-k8s/**
Glob: plugins/autonomous-dev-assist/instructions/*-runbook.md
```

The cloud-backend-plugin globs are listed in this TDD because the Glob list lives in `commands/assist.md` (a single shared file). The corresponding plugin content is authored by TDD-025; the path declaration is here.

### 4.4 The "See also" cross-link contract (FR-1541)

Every new SKILL.md section ends with a "See also" block that links the corresponding runbook section. The format:

```markdown
**See also:** [chains-runbook §3 Audit Verification](../../instructions/chains-runbook.md#3-audit-verification) · [TDD-022 §13 Audit Log](../../../autonomous-dev/docs/tdd/TDD-022-plugin-chaining-engine.md#13-audit-log)
```

The link checker invoked by CI (existing markdown-link-check action from PRD-010) enforces that every link resolves. The reviewer agent invoked by `standards-meta-reviewer` (TDD-020) enforces that every "See also" cites at least one upstream TDD § anchor.

---

## 5. Skill content schemas

### 5.1 `skills/help/SKILL.md` — Plugin Chains section (FR-1502)

The new section sits between the existing "Pipeline Phases" section and the existing "Trust Levels" section. Heading hierarchy: `## Plugin Chains` (H2) with H3 subsections.

Required H3 subsections (each ≤ 30 lines):

| Subsection                    | Required content                                                                                  |
|-------------------------------|---------------------------------------------------------------------------------------------------|
| `### What chains are`         | One-paragraph conceptual definition; cites TDD-022 §1.                                            |
| `### The four chain commands` | Table: `chains list`, `chains graph`, `chains audit verify`, `chains approve|reject REQ-NNNNNN`. |
| `### The audit log`           | File path, HMAC behavior (no rotation), env-var key (`CHAINS_AUDIT_KEY`), **explicit "do not delete" warning**. |
| `### Manifest-v2 fields`      | Three fields (`produces`, `consumes`, `egress_allowlist`), JSON example.                           |
| `### When chains pause`       | Three pause causes (cycle, HMAC mismatch, approval pending) and the next-step command for each.   |
| `### See also`                | Links to `chains-runbook.md` and TDD-022 §5, §13.                                                  |

### 5.2 `skills/help/SKILL.md` — Deploy Framework section (FR-1503)

Heading hierarchy: `## Deploy Framework` (H2) with H3 subsections.

Required H3 subsections:

| Subsection                       | Required content                                                                                    |
|----------------------------------|------------------------------------------------------------------------------------------------------|
| `### What the deploy framework is` | Conceptual definition; positions it as the post-pipeline ship phase distinct from the daemon pipeline. |
| `### The seven deploy commands`  | Table: `backends list|describe`, `plan`, `approve`, `reject`, `logs`, `cost`, `estimate`.            |
| `### The approval state machine` | The five-state diagram; **the prod-always-approval rule with explicit warning**.                     |
| `### The cost-cap ledger`        | File path, append-only contract, **"do not edit by hand"** warning, `deploy ledger reset` mention.   |
| `### The HealthMonitor`           | Brief mention that post-deploy SLA tracking happens; pointer to `deploy logs` for output.            |
| `### When deploys stall`         | Three stall causes (`awaiting-approval`, `cost-cap-tripped`, backend not registered) and recovery.    |
| `### See also`                   | Links to `deploy-runbook.md` and TDD-023 §5, §11, §14.                                                |

### 5.3 `skills/config-guide/SKILL.md` — `chains` section (FR-1510)

A new section between the existing "Section 18: extensions" and the existing "Section 19: production_intelligence" (numbering becomes 18.5, or shifts the rest by one — chosen approach: insert as new Section 19, shift existing 19/20 to 20/21). The full numbering becomes 25 sections (per PRD-015 §7 success metric).

Required content:

```yaml
chains:
  enabled: true
  audit:
    key_env: CHAINS_AUDIT_KEY     # env var holding HMAC key
    log_path: ~/.autonomous-dev/chains/audit.log
  approval:
    required_for_prod_egress: true  # forces approve|reject when egress_allowlist hits prod hosts
```

Section content includes:
- Parameter table (4 params: `enabled`, `audit.key_env`, `audit.log_path`, `approval.required_for_prod_egress`).
- A worked example showing a manifest-v2 declaration and the resulting graph.
- HMAC key custody guidance: where to store it (env var, not config), what happens if rotated naively (cannot verify any prior entries), and the "rotation is a TDD-022 future-work item — see TDD-022 OQ-3."

### 5.4 `skills/config-guide/SKILL.md` — `deploy` section (FR-1511)

Sibling of §5.3 above; sits as Section 20 in the new numbering.

Required content:

```yaml
deploy:
  default_backend: gcp
  environments:
    staging:
      backend: gcp
      cost_cap_usd: 50.00
      approval:
        required: false       # auto-approve at L2+
    prod:
      backend: gcp
      is_prod: true            # forces human approval regardless of trust
      cost_cap_usd: 500.00
      approval:
        required: true
```

Section content includes:
- Schema reference link to TDD-023 §9 (`deploy-config-v1`).
- The approval rules table: per trust level × per `is_prod` flag → resulting behavior.
- The cost-cap interaction with `cost_estimation` (cross-reference to the section owned by TDD-025).

---

## 6. Command surface schemas

### 6.1 `commands/assist.md` Step-1 classifier extension (FR-1523)

The classifier section currently reads:

```markdown
- **help** -- General usage questions...
- **troubleshoot** -- Something is broken...
- **config** -- Questions about configuration...
```

It is extended (in document order) to:

```markdown
- **help** -- General usage questions about commands, agents, pipeline phases, concepts, or features.
- **troubleshoot** -- Something is broken, failing, or behaving unexpectedly.
- **config** -- Questions about configuration, settings, environment variables, or customization.
- **chains** -- Questions about plugin chains, the manifest-v2 schema, the chain audit log, or `chains` CLI.
- **deploy** -- Questions about the deploy framework, backends, the approval state machine, the ledger, cost caps, or `deploy` CLI.
- **security** -- Questions about HMAC keys, audit logs, credential proxy, egress firewall, or denied-permission errors.
```

A question may match multiple categories; the assist loads context from all matched categories. The keyword bag is in §4.2 of this TDD.

### 6.2 `commands/assist.md` Step-2 Glob extension (FR-1522)

See §4.3 of this TDD. The Glob list is appended (not replaced) so existing question routes still work.

### 6.3 `commands/quickstart.md` `--with-cloud` flag (FR-1524)

Today the quickstart command is sequential and assumes local-only. The flag is parsed at the top of the prompt:

```markdown
**Argument:** `--with-cloud` (optional)

If `--with-cloud` is present, after Step 4 (start the daemon), the quickstart inserts a deferred bridge to the cloud-onboarding phases owned by `skills/setup-wizard/SKILL.md` (see TDD-027). The bridge is a single line: "For cloud deploy onboarding, run `/autonomous-dev-assist:setup-wizard --with-cloud`."
```

The full `setup-wizard` extension content (cred-proxy bootstrap, firewall backend choice, dry-run cloud deploy) is owned by TDD-027 §5. This TDD only adds the entry-point and the gate that detects when the cloud plugins are not installed.

### 6.4 (Deferred) `commands/deploy-doctor.md`

Per PRD-015 NG-02, OQ-2: deferred. This TDD acknowledges the FR-1542 mention in the dispatch prompt and confirms it is **not** authored. If a future PRD authorizes it, this TDD's §17 captures the open question.

---

## 7. Runbook content schemas

### 7.1 `instructions/chains-runbook.md`

Structure (mirrors existing `runbook.md`):

| Section                        | Lines (target) | Content                                                                                     |
|--------------------------------|----------------|---------------------------------------------------------------------------------------------|
| `## 1. Bootstrap`              | 30             | First-time setup: env-var creation, key generation, manifest-v2 migration.                  |
| `## 2. Dependency-graph troubleshooting` | 60   | Cycle detection, missing `produces`, missing `consumes`, `chains graph` interpretation.     |
| `## 3. Audit verification`     | 80             | The HMAC chain, `chains audit verify`, **what to do on mismatch (do NOT delete)**, recovery using log shadow if present. |
| `## 4. Manifest-v2 migration` | 50             | Migrating a plugin from v1 to v2; the `produces`/`consumes` declaration cookbook.           |
| `## 5. Approval flow`          | 30             | `chains approve`/`chains reject` with the REQ-NNNNNN format; what causes the gate.           |
| `## 6. Common errors`          | 40             | Six error-message-to-action mappings.                                                        |
| `## 7. Escalation`             | 20             | When to file a TDD-022 issue vs. when to recover locally.                                    |
| `## 8. See also`               | 10             | Cross-links to `deploy-runbook.md`, TDD-022, `help/SKILL.md` Plugin Chains.                   |

Total: ~320 lines.

### 7.2 `instructions/deploy-runbook.md`

Structure:

| Section                                  | Lines (target) | Content                                                                                                       |
|------------------------------------------|----------------|----------------------------------------------------------------------------------------------------------------|
| `## 1. Bootstrap`                        | 40             | `deploy.yaml` authoring; environment + backend declaration; first dry-run.                                     |
| `## 2. The approval state machine`       | 60             | Walkthrough of all five states with the exact CLI command at each transition; the prod-override rule.          |
| `## 3. Cost-cap trip recovery`           | 80             | Reading the ledger; `deploy ledger reset`; **never edit by hand**; common causes (crash mid-deploy, clock skew). |
| `## 4. Ledger inspection`                | 40             | Schema of `~/.autonomous-dev/deploy/ledger.json`; jq recipes.                                                  |
| `## 5. HealthMonitor + SLA tracker`      | 50             | Reading `deploy logs`; the SLA-degraded state; rollback decision tree.                                         |
| `## 6. Rollback`                         | 50             | Forward to PRD-014 §17.R7 mitigation; how to invoke; what is preserved (logs, ledger).                         |
| `## 7. Common errors`                    | 60             | Eight error-message-to-action mappings.                                                                        |
| `## 8. See also`                         | 10             | Cross-links to `chains-runbook.md`, TDD-023, `help/SKILL.md` Deploy Framework.                                  |

Total: ~390 lines.

### 7.3 The "See also" index update in existing `instructions/runbook.md` (FR-1531)

A new H2 "See also" section appended after the existing tail:

```markdown
## See also

For chain- and deploy-specific procedures, see the surface-specific runbooks:

- [chains-runbook.md](./chains-runbook.md) — plugin chains, manifest-v2, audit log
- [deploy-runbook.md](./deploy-runbook.md) — deploy framework, approval gate, cost ledger
- [cred-proxy-runbook.md](./cred-proxy-runbook.md) — credential proxy (owned by TDD-025)
- [firewall-runbook.md](./firewall-runbook.md) — egress firewall (owned by TDD-025)
```

This TDD authors the cross-link; the `cred-proxy-runbook.md` and `firewall-runbook.md` files themselves are owned by TDD-025.

---

## 8. The anchor convention (FR-1540 enforcement mechanism)

Every cross-reference to an upstream TDD uses the form `TDD-NNN §M Section-Title`. The reviewer agent (`standards-meta-reviewer`, TDD-020) checks each new file with this pattern:

```
# Allowed: section anchors
TDD-022 §5 Plugin Manifest Extensions
TDD-023 §11 Trust Integration
TDD-024 §11-§13 (Egress Firewall)

# Disallowed: SHA pinning
TDD-022 (commit b447bce)
"as of c1884eb"
fixed in 5819359
```

The detection regex is `(commit\s+[a-f0-9]{7,40}|as of [a-f0-9]{7,40}|fixed in [a-f0-9]{7,40})` against any new content under `plugins/autonomous-dev-assist/`. A match is a critical reviewer finding and auto-fails the standards review.

The convention covers: SKILL.md section bodies, runbook prose, eval-case `expected_topics` strings, README updates. Code samples (manifest-v2 examples, deploy.yaml examples) are exempt because they may legitimately reference example commit SHAs in non-prescriptive contexts.

---

## 9. Eval suite design (FR-1532, FR-1533)

### 9.1 Schema (shared with TDD-028)

All four new suites use the same schema (existing `runner.sh` reads it):

```yaml
suite: chains
skill: assist
description: Validates assist answers chain questions correctly.

cases:
  - id: chains-list-001
    category: command-syntax
    difficulty: easy
    question: "How do I list registered chain plugins?"
    expected_topics:
      - chains list
      - registered plugins
      - DAG
    must_mention:
      - "chains list"
    must_not_mention:
      - "chains ls"      # hallucination guard
      - "rm.*audit.log"  # security guard
```

Per FR-1538 each suite has ≥5 negative cases (`must_not_mention` clauses). The negative bag for chains:

| Hallucination guard            | Why it matters                                                                                  |
|--------------------------------|--------------------------------------------------------------------------------------------------|
| `chains rotate-key`            | No such command exists in TDD-022; suggesting it triggers R-7 (audit-log destruction).           |
| `rm.*audit\.log`               | Catastrophic; the audit log is irrecoverable (TDD-022 §13).                                      |
| `chains delete`                | No such command.                                                                                  |
| `manifest-v1`                  | Confusing operators stuck on v2 by suggesting v1 is current.                                     |
| `audit\.json`                  | The file is `audit.log`; the JSON suggestion misroutes operators.                                 |

The negative bag for deploy:

| Hallucination guard               | Why it matters                                                                                |
|-----------------------------------|------------------------------------------------------------------------------------------------|
| `deploy force-approve`            | No such command; TDD-023 §11 mandates explicit approval.                                       |
| `edit.*ledger\.json`              | Editing the ledger by hand corrupts cost tracking.                                              |
| `deploy auto-prod`                | No bypass for prod-always-approval exists (TDD-023 §11).                                       |
| `cost cap.*ignore`                | Setting cap to 0 is allowed; "ignore" suggests a non-existent flag.                            |
| `deploy.*--no-approval`           | Not a real flag.                                                                                |

### 9.2 Case counts

| Suite         | Min cases (PRD-015 FR) | Categories                                                                                       |
|---------------|------------------------|---------------------------------------------------------------------------------------------------|
| `chains-eval` | 20 (FR-1532)           | list/graph/audit happy paths (6), cycle detection (3), HMAC mismatch (3), manifest-v2 errors (3), approve/reject (3), audit-log warning (2). |
| `deploy-eval` | 30 (FR-1533)           | backends list/describe (6), plan/approve/reject (8), cost-cap trip (4), ledger corruption (3), HealthMonitor (3), SLA tracker (2), prod-always-approval (4). |

Total cases authored by this TDD: ≥50.

### 9.3 Baseline and regression

The new suites must hit ≥95% pass rate (PRD-015 FR-1538-1540, success metrics §7). The existing 90 cases must hold ≥95% (PRD-015 §8.6 quality gate). The eval-config.yaml registration is owned by TDD-028 §6.

---

## 10. Cross-cutting concerns

### 10.1 Security

- **HMAC key custody.** Documenting the env-var name `CHAINS_AUDIT_KEY` is correct; documenting a rotation command (which does not exist) is incorrect. Negative case `chains rotate-key` enforces this.
- **Audit-log integrity.** Every chain-related SKILL section and runbook contains the explicit phrase "do NOT delete the audit log" (FR-1514). Negative case `rm.*audit\.log` enforces this.
- **Approval-bypass guard.** No documented or hallucinated path bypasses prod-always-approval. Negative case `deploy auto-prod` enforces this.
- **Ledger immutability.** The runbook's §3 explicitly forbids hand-editing the ledger; negative case `edit.*ledger\.json` enforces this.

### 10.2 Privacy

- All sample commands use placeholder REQ-NNNNNN, never real request IDs.
- All sample HMAC keys are obvious placeholders (`<HMAC_KEY_HERE>`).
- All sample tenants and project IDs are `example-tenant-id`, `example-project-id`.
- The audit-log inspection runbook §3 documents `chains audit verify` only; **does not** document a "tail the log" command, since log entries may contain plaintext request titles (PRD-015 OQ-5 recommended answer).

### 10.3 Scalability

- Eval count grows from 90 → ≥140 (this TDD adds ≥50). At ≥0.05/case, an `eval all` run is ~$7. The runner already supports `--suite` for selective runs; this TDD does not change that.
- SKILL.md sizes grow: `help/SKILL.md` 385 → ~500 lines, `config-guide/SKILL.md` 812 → ~900 lines. The Claude prompt fits comfortably (the assist command's session has 200K token budget; current SKILLs use ~5K).
- The classifier has 6 categories, not 3. Multi-match is allowed; in the worst case all 6 categories load context, which adds ~3K tokens to the assist's working context.

### 10.4 Reliability

- The classifier degrades gracefully: a question matching no category falls into `help` (the existing default). The eval suite has at least 3 cases that test ambiguous questions (e.g., "what is autonomous-dev?" must classify as `help` and not as `chains` despite the word "deploy" appearing in adjacent SKILL content).
- The Glob list is append-only across releases; existing question routes never break.
- Markdown link checker (PRD-010 CI) catches dead "See also" links before merge; FR-1541 cross-link contract is mechanically enforced.

### 10.5 Observability

- Each new SKILL section opens with a one-line `*Topic:* <surface>` marker so `Grep` against the SKILL files works as a discoverability tool.
- Every runbook section is independently anchorable via Markdown auto-anchors (`#3-audit-verification`); the anchor convention check (§8) verifies these resolve.
- Eval results are written to `evals/results/eval-<timestamp>.json` (existing path); this TDD does not change the result format.

### 10.6 Cost

- Per-PR CI eval cost: ~$8.50 if `eval all` runs. R-2 in PRD-015 acknowledges this; the recommended mitigation is per-suite invocation in PR jobs.
- One-time authoring cost: ~50 eval cases × 5 min each = 4 hours of authoring time. SKILL.md additions: ~6 hours. Runbooks: ~12 hours. Total: ~22 hours of human authoring (delivered as the implementation Plan/Spec for this TDD).
- Long-term cost reduction: every hallucinated-command incident costs operator time and trust. The PRD-015 §7 success metric (zero "wrong answer" incidents on chain/deploy) is the dominant value.

---

## 11. APIs and interfaces

### 11.1 Classifier API (informal — it is a Claude prompt)

| Input                  | Output                                                            |
|------------------------|-------------------------------------------------------------------|
| User question (string) | Set of category labels in {help, troubleshoot, config, chains, deploy, security} |

Multi-label classification; default to `help` if no category matches.

### 11.2 Glob target list contract

| Field      | Value                                                              |
|------------|--------------------------------------------------------------------|
| Listed in  | `commands/assist.md` Step 2                                        |
| Format     | One `Glob: <pattern>` line per target                              |
| Append-only | Existing targets are never removed; only added.                    |
| Validated by | The eval-case `expected_topics` matches that exercise each Glob path. |

### 11.3 SKILL.md section contract

Each new SKILL.md section follows:

```markdown
## <Title> {#<anchor>}

*Topic:* <surface>

<one-paragraph definition>

### <H3 subsection>

...

### See also

- [runbook.md](path) — operator deep-dive
- [TDD-NNN §M Section-Title](path) — upstream design
```

The reviewer agent verifies the `*Topic:*` marker, the H3 hierarchy, and the See-also block.

---

## 12. Error handling

### 12.1 Author-time errors (CI)

| Error                                                            | Detection                                | Action                                       |
|------------------------------------------------------------------|-------------------------------------------|-----------------------------------------------|
| SHA pinning in new content                                       | Regex check (TDD §8)                       | Reviewer auto-fail.                           |
| Missing `*Topic:*` marker in a new SKILL section                 | Reviewer agent grep                        | Reviewer auto-fail.                           |
| Dead "See also" link                                             | markdown-link-check (PRD-010 CI)           | CI fail.                                      |
| Missing `must_not_mention` in eval case for hallucination-prone topic | Eval-suite linter                       | CI fail.                                      |
| Section heading hierarchy regression (H2 with no H3 subsections) | markdownlint (existing config)             | CI fail.                                      |

### 12.2 Runtime errors (operator using assist)

| Error                                                | Behavior                                                                                       |
|------------------------------------------------------|-------------------------------------------------------------------------------------------------|
| Question matches no category                         | Default to `help`; load `help/SKILL.md` only.                                                   |
| Glob target missing (cloud plugin not installed)     | Glob returns empty; assist proceeds with what it has and surfaces "for cloud deploy install autonomous-dev-deploy-{cloud}". |
| Question contradicts a `must_not_mention` clause     | At eval time, the case fails. At runtime, the operator may still see a hallucinated answer; the eval gate catches it pre-merge. |

---

## 13. Performance

| Metric                                       | Target              | Notes                                                                      |
|----------------------------------------------|---------------------|----------------------------------------------------------------------------|
| Assist response latency p95                  | <12 s end-to-end    | Unchanged from baseline; new SKILL content adds ≤1 s in `Read` time.       |
| Eval suite runtime (single suite, 30 cases)  | <8 min               | Single-threaded; matches existing `runner.sh` budget.                       |
| Eval suite runtime (`eval all`, 170 cases)   | <50 min              | Acceptable for nightly CI; not for per-PR CI without per-suite filtering.   |
| `Glob` step latency contribution             | <500 ms              | The 4 cloud-plugin globs return empty when plugins not installed.           |
| `Read` step latency for new runbooks         | <1 s                 | Each runbook ≤500 lines (~50 KB).                                           |

---

## 14. Migration & rollout

| Phase | Activity                                                                                          | Exit criterion                            |
|-------|---------------------------------------------------------------------------------------------------|--------------------------------------------|
| 1     | Author SKILL.md sections (FR-1502, 1503, 1510, 1511).                                             | All four sections merged in a single PR.   |
| 2     | Author runbooks (FR-1531, 1532).                                                                  | Both runbooks pass markdown-link-check.    |
| 3     | Wire `commands/assist.md` Glob and classifier (FR-1522, 1523).                                    | Eval suite cases that depend on new Globs hit ≥95%. |
| 4     | Wire `commands/quickstart.md` `--with-cloud` flag (FR-1524).                                       | The flag prints the cloud-onboarding bridge line. |
| 5     | Author eval cases (FR-1532, 1533).                                                                | Both suites ≥95% pass; existing suites hold. |
| 6     | Cross-link from existing `instructions/runbook.md` (FR-1531).                                      | Link checker passes.                       |

Rollback: each phase is its own commit; revert is a single `git revert`.

---

## 15. Test strategy

### 15.1 Unit-level

- Reviewer-agent regex tests for the SHA-pinning detector (10 cases — 5 violation, 5 clean).
- Eval-case linter tests for the schema (5 cases).
- Markdown-link-checker run against the new files (CI).

### 15.2 Integration-level

- Run `chains-eval.yaml` against `/autonomous-dev-assist:assist` end-to-end; require ≥95% pass.
- Run `deploy-eval.yaml` end-to-end; require ≥95% pass.
- Run the existing 90-case suite (regression); require ≥95% pass.

### 15.3 Eval-the-eval

- For each negative case, validate that the assist's existing behavior pre-PR fails the case (proves the case detects a real hallucination), and post-PR passes (proves the new SKILL content fixes it). This is "eval-baseline / eval-post" per PRD-015 §11 launch plan phase 4-5.

### 15.4 Manual review

- Operator dry-run: a senior on-call engineer who has not seen the new content asks 10 questions and reports any wrong answers.

---

## 16. Operational readiness

- **Deployment.** This TDD ships as a single PR (alongside its Plan/Spec). No daemon restart, no service migration. Markdown-only.
- **Feature flag.** None. The new SKILL content is loaded lazily by the assist command; questions that don't match the new categories don't exercise it.
- **Canary.** The eval suite is the canary. If `eval all` passes pre-merge, the content is canary-safe.
- **Rollback.** Revert the PR. The previous behavior (no chain/deploy answers) returns. No data loss.

---

## 17. Open questions

| ID    | Question                                                                                                                  | Recommended answer                                                                                            | Status |
|-------|---------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------|--------|
| OQ-1  | Should `commands/deploy-doctor.md` be authored as part of this TDD?                                                       | **No.** PRD-015 NG-02. Defer to a subsequent PRD if operator-ticket data justifies it.                          | Closed |
| OQ-2  | Should the new SKILL sections be top-level or nested under "Pipeline & subsystems"?                                       | **Top-level.** Discoverability for operators who scan H2 headings outweighs nesting cleanliness.                | Open   |
| OQ-3  | Should the runbooks include a "common-mistakes I have personally made" appendix to humanize the on-call experience?       | **Defer.** Style decision; out of scope for the documentation parity goal.                                       | Open   |
| OQ-4  | Should the eval cases be regenerated automatically from the SKILL section content?                                        | **No.** Manual authoring catches gaps that auto-generation misses (R-4 hallucination risk).                      | Open   |
| OQ-5  | If TDD-022 adds a `chains rotate-key` command later, how does this TDD's `must_not_mention` regress?                      | **Update the negative case in lockstep with the upstream TDD.** Add the rotation command as a positive-mention case. | Open |
| OQ-6  | Should the classifier's keyword bag (§4.2) be embedded in `commands/assist.md` or sourced from a shared YAML?              | **Embedded in `commands/assist.md`.** A separate YAML adds a load step without operator value.                   | Closed |
| OQ-7  | Should the prod-always-approval rule be repeated in BOTH `help/SKILL.md` AND `deploy-runbook.md`, or sourced once?         | **Repeat.** Operators may land on either surface; redundancy is a feature for safety-critical info.              | Closed |

---

## 18. References

| Document                                                                              | Relationship                                  |
|---------------------------------------------------------------------------------------|------------------------------------------------|
| `plugins/autonomous-dev/docs/prd/PRD-015-assist-extension-for-chains-deploy-cloud.md` | Parent PRD                                    |
| `plugins/autonomous-dev/docs/tdd/TDD-022-plugin-chaining-engine.md`                   | Upstream surface (chains)                     |
| `plugins/autonomous-dev/docs/tdd/TDD-023-deployment-backend-framework-core.md`        | Upstream surface (deploy)                     |
| `plugins/autonomous-dev/docs/tdd/TDD-025-assist-cloud-credproxy-surface.md`           | Sibling — cloud + cred-proxy assist content   |
| `plugins/autonomous-dev/docs/tdd/TDD-027-assist-agents-wizard-handoff.md`             | Sibling — agents + wizard hand-off            |
| `plugins/autonomous-dev/docs/tdd/TDD-028-assist-evals-readme-cross-cutting.md`        | Sibling — eval suites + README                |
| `plugins/autonomous-dev-assist/skills/help/SKILL.md`                                  | Surface modified by FR-1502, FR-1503          |
| `plugins/autonomous-dev-assist/skills/config-guide/SKILL.md`                          | Surface modified by FR-1510, FR-1511          |
| `plugins/autonomous-dev-assist/commands/assist.md`                                    | Surface modified by FR-1522, FR-1523          |
| `plugins/autonomous-dev-assist/commands/quickstart.md`                                | Surface modified by FR-1524                   |
| `plugins/autonomous-dev-assist/instructions/runbook.md`                               | Surface modified by FR-1531 (See also index)  |
| `plugins/autonomous-dev-assist/instructions/chains-runbook.md`                        | New file (FR-1531)                            |
| `plugins/autonomous-dev-assist/instructions/deploy-runbook.md`                        | New file (FR-1532)                            |
| `plugins/autonomous-dev-assist/evals/test-cases/chains-eval.yaml`                     | New file (FR-1532, FR-1538)                   |
| `plugins/autonomous-dev-assist/evals/test-cases/deploy-eval.yaml`                     | New file (FR-1533, FR-1538)                   |

---

*End of TDD-026.*
