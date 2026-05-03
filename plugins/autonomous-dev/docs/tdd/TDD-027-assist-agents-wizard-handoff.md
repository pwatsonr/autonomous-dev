# TDD-027: Assist Agents & Setup-Wizard Phase 16 Hand-off

| Field          | Value                                                         |
|----------------|---------------------------------------------------------------|
| **Title**      | Assist Agents & Setup-Wizard Phase 16 Hand-off                |
| **TDD ID**     | TDD-027                                                       |
| **Version**    | 1.0                                                           |
| **Date**       | 2026-05-02                                                    |
| **Status**     | Draft                                                         |
| **Author**     | Patrick Watson                                                |
| **Parent PRD** | PRD-015: Extend autonomous-dev-assist for Chains/Deploy/Cloud |
| **Plugin**     | autonomous-dev-assist                                         |
| **Sibling TDDs** | TDD-025 (cloud + cred-proxy SKILLs), TDD-026 (chains + deploy SKILLs), TDD-028 (evals + README) |
| **Coordinated TDD** | TDD-033 (setup-wizard phase modules — owns the wizard runtime) |

---

## 1. Summary

This TDD specifies the **agent-surface and onboarding-flow extensions** in the `autonomous-dev-assist` plugin so that the troubleshooter and onboarding agents have parity with the six capability streams that landed between TDD-019 and `main`. It is the third sibling in the four-TDD decomposition of PRD-015 (with TDD-025 owning cloud + cred-proxy SKILL content, TDD-026 owning chains + deploy SKILL content, and TDD-028 owning evals + cross-cutting). It also specifies the **phase-16 boundary** of the setup wizard — the contract between this assist-plugin TDD (which authors the prompt that introduces phase 16) and TDD-033 (which authors the runtime that executes phase 16).

The agent surfaces in scope are:

1. **`agents/troubleshooter.md`** — the on-call diagnostic agent. Today its file-locations table stops at TDD-019 paths. Operators hitting any of the new failure modes (`chains audit verify` HMAC mismatch, deploy `awaiting-approval`, cred-proxy TTL expiry mid-deploy, firewall `denied.log` entries, ledger corruption) get told "I don't recognize that path." This TDD adds 9 new file-location rows and 4 new diagnostic procedure subsections per FR-1517, FR-1518, FR-1519.
2. **`agents/onboarding.md`** — the first-run guided setup agent. Today it walks 7 steps and ends at "you're done." This TDD adds (a) 4 new pipeline-status rows for `awaiting-approval`, `cost-cap-tripped`, `firewall-denied`, `cred-proxy-ttl-expired` per FR-1520; and (b) a "first cloud deploy" appendix that points operators at the new wizard phases per FR-1521.
3. **`skills/setup-wizard/SKILL.md`** — the comprehensive interactive walkthrough. Today it has 10 phases ending at extension hooks. This TDD specifies **what the assist plugin contributes to phase 16** (the deploy-backend phase) but explicitly **does not** specify the phase-16 runtime — that is owned by TDD-033's setup-wizard phase-module work.

The design tension this TDD resolves: phase 16 has two natural owners. The runtime (the prompt that walks the operator through the steps, the validation logic, the bootstrap commands invoked) is part of the cross-plugin setup-wizard refactor that TDD-033 owns. The **content** that goes into phase 16 — which cloud backend prompts to ask, which cred-proxy bootstrap commands to surface, which firewall backend selection logic to apply — is part of the assist-plugin parity work this PRD-015 demands. Splitting between two TDDs would lose context; merging into one would force this TDD to become a setup-wizard runtime TDD. The chosen resolution: **TDD-027 specifies the phase-16 boundary** (an explicit contract section, §6 below) describing what the assist plugin contributes; TDD-033 consumes that contract and authors the runtime. Both TDDs reference each other.

In-scope FR coverage from PRD-015: FR-1512, FR-1513, FR-1514, FR-1515, FR-1516, FR-1517, FR-1518, FR-1519, FR-1520, FR-1521 (per the dispatch prompt's "FR-1512-1515 (agents), FR-1516-1517 (onboarding flow), FR-1535 (setup-wizard hand-off)" mapping; the dispatch prompt's FR numbering aligns with the agent-surface and onboarding-flow FRs in PRD-015 §6.1-§6.2). Out-of-scope: SKILL.md content for chains/deploy/cloud (siblings TDD-025/026), eval suites (TDD-028).

---

## 2. Goals & Non-Goals

### 2.1 Goals

| ID   | Goal                                                                                                                                            |
|------|-------------------------------------------------------------------------------------------------------------------------------------------------|
| G-01 | Extend `agents/troubleshooter.md` file-locations table with 9 new rows covering chains, deploy, cred-proxy, firewall paths (FR-1517, FR-1518). |
| G-02 | Add a "Chain & deploy diagnostics" subsection to `agents/troubleshooter.md` covering `chains audit verify`, `deploy logs`, `cred-proxy doctor`, `firewall test` (FR-1519). |
| G-03 | Extend `agents/onboarding.md` pipeline-status table with 4 new rows for new pause states (FR-1520).                                            |
| G-04 | Add a "First cloud deploy" appendix to `agents/onboarding.md` that bridges into the cloud-onboarding wizard phases (FR-1521).                  |
| G-05 | Specify the phase-16 boundary contract: what the assist plugin contributes vs. what TDD-033 (setup-wizard phase modules) consumes.             |
| G-06 | Specify ≥10 eval cases that exercise the troubleshooter and onboarding agent extensions (per dispatch test-strategy guidance).                  |
| G-07 | Preserve the existing 7-step onboarding flow's local-only path: cloud-onboarding additions are **opt-in** (FR-1516).                            |
| G-08 | Establish the **agent-prompt extension pattern** that future TDDs reuse: append-only sections, frontmatter-tool-allowlist additions, no breaking changes to existing rows. |

### 2.2 Non-Goals

| ID    | Non-Goal                                                                                                                       |
|-------|---------------------------------------------------------------------------------------------------------------------------------|
| NG-01 | **Authoring `skills/setup-wizard/SKILL.md` phase-16 runtime.** That is TDD-033 §5. This TDD specifies the boundary, not the runtime. |
| NG-02 | **Authoring SKILL.md content for chains/deploy/cloud/cred-proxy/firewall.** Owned by TDD-025 (cloud + cred-proxy + firewall + cost) and TDD-026 (chains + deploy). |
| NG-03 | **Modifying the troubleshooter agent's tool allowlist beyond the minimum needed for the new diagnostics.** The agent already has `Bash(cat *)`, `Bash(jq *)`, etc.; we add only `Bash(chains *)`, `Bash(deploy *)`, `Bash(cred-proxy *)`, `Bash(firewall *)` in the frontmatter. |
| NG-04 | **Adding new agents.** PRD-015 §3 NG-02 forbids new top-level surfaces. The assist plugin still has exactly two agents: onboarding and troubleshooter. |
| NG-05 | **Implementing the wizard's plugin-presence check.** TDD-033 owns the runtime check; this TDD provides the static content (the prompts to display when plugins are missing). |
| NG-06 | **Pinning specific TDD commit SHAs.** PRD-015 FR-1540 forbids it. The agent prompts use the same anchor convention as TDD-026 §8. |

### 2.3 Tenets

1. **Agent prompts are append-only.** Existing rows, steps, sections never change shape. New rows append; new sections append; new tool allowlist entries append. Every existing eval case must continue to pass.
2. **The boundary, not the runtime.** Where two TDDs share a phase, this TDD documents **what** is contributed; the consuming TDD documents **how** it is executed. Crossing the line breaks the decomposition.
3. **Cloud is opt-in.** A local-only operator must be able to onboard without ever seeing a cloud prompt. A cloud-using operator must be able to opt in with one flag.
4. **Diagnostics over prescriptions.** Troubleshooter procedures gather state first, propose fixes second. Never suggest a destructive command without first showing the operator the state that justifies it.

---

## 3. Background

### 3.1 The current troubleshooter surface

`agents/troubleshooter.md` (224 lines, last meaningful update at TDD-019) has three operator-facing structures:

- **File-locations table** (15 rows): the canonical "where do I look" reference. All rows are TDD-001..TDD-019 paths.
- **Diagnostic procedures** (5 sub-sections): "Daemon Not Starting", "Request Stuck in a Phase", "Review Gate Failures", "Cost Problems", "Circuit Breaker Tripped", "Configuration Issues". All are pre-TDD-022.
- **Emergency procedures**: kill-switch, circuit-breaker reset, force cleanup, full recovery — independent of new surfaces.

The agent's frontmatter tool allowlist (`Bash(cat *)`, `Bash(jq *)`, `Bash(ls *)`, `Bash(head *)`, `Bash(tail *)`, `Bash(wc *)`, `Bash(find *)`, `Bash(stat *)`, `Bash(git *)`) does not include the new top-level commands (`chains`, `deploy`, `cred-proxy`, `firewall`). Diagnostic procedures that need to invoke them silently fail.

### 3.2 The current onboarding surface

`agents/onboarding.md` (293 lines) walks 7 steps for a local-only first run:

1. Check prerequisites (bash, jq, git, claude)
2. Verify plugin registration
3. Initialize configuration
4. Add repositories to allowlist
5. Install and start daemon
6. Submit a test request
7. Verify it is working

It does not mention cloud deploy, cred-proxy bootstrap, firewall backend selection, or any of the four new pause states. An operator who completed onboarding and then ran `/autonomous-dev:deploy plan` got a `pending → awaiting-approval` state with no guidance on what `awaiting-approval` means.

### 3.3 The current setup-wizard surface

`skills/setup-wizard/SKILL.md` (809 lines) has 10 phases ending at extension hooks (TDD-019). It is the comprehensive companion to `agents/onboarding.md` — same content, deeper coverage. Phase numbering today: 1 prerequisites, 2 plugin install, 3 config init, 4 repos allowlist, 5 trust levels, 6 cost budgets, 7 daemon install, 8 first request, 9 notifications, 10 production intelligence + extension hooks.

PRD-015 FR-1515 demands at least 4 new phases for cloud onboarding: cloud backend selection, cred-proxy bootstrap, firewall backend choice, dry-run cloud deploy. AMENDMENT-002 (the May 3 PRD-017 amendment) extends this with phases 8, 11-15, 16; phase 16 is "deploy backends" and is the cloud-deploy entry point. That AMENDMENT is owned by TDD-033 (the setup-wizard phase-module refactor).

The boundary problem: phase 16's content depends on (a) which cloud plugins are installed, (b) which firewall backend the OS supports, (c) whether a cred-proxy is already bootstrapped. The decision logic for (a)/(b)/(c) is **runtime**; the prompts shown to the operator at each branch are **content**. This TDD authors the content side and specifies the contract that TDD-033's runtime consumes.

### 3.4 The four new pipeline-pause states

TDD-022 and TDD-023 added pause semantics that the existing onboarding flow does not document:

| Pause state             | Source                | Operator action                                            |
|-------------------------|-----------------------|-------------------------------------------------------------|
| `awaiting-approval`     | TDD-023 §11           | Run `deploy approve REQ-NNNNNN` (or chain equivalent).      |
| `cost-cap-tripped`      | TDD-023 §14           | Inspect ledger; raise cap or revert; run `deploy ledger reset` only after fix. |
| `firewall-denied`       | TDD-024 §11 (sibling) | Inspect `~/.autonomous-dev/firewall/denied.log`; update allowlist or accept. |
| `cred-proxy-ttl-expired`| TDD-024 §10 (sibling) | Re-bootstrap with `cred-proxy bootstrap`; do not rotate root credentials. |

The first two are owned by this TDD's content scope. The last two are owned by TDD-025's SKILL content but referenced from `agents/onboarding.md` here.

---

## 4. Architecture

### 4.1 Component map

```
                Operator (first run or on-call)
                            │
            ┌───────────────┴───────────────┐
            ▼                                ▼
┌───────────────────────┐         ┌───────────────────────┐
│ agents/onboarding.md  │         │ agents/troubleshooter │
│   7 steps + appendix  │         │     .md               │
│   (this TDD §5.2)     │         │  file-locs + procs    │
└───────────┬───────────┘         │  (this TDD §5.1)      │
            │                     └───────────┬───────────┘
            │ "first cloud deploy"            │
            │  appendix bridges               │
            ▼                                  │
┌───────────────────────┐                      │
│ skills/setup-wizard/  │                      │
│   SKILL.md            │                      │
│   phases 1-10 + 16    │                      │
│   (TDD-033 owns 16)   │                      │
│   (this TDD §6 owns   │                      │
│    the boundary)      │                      │
└───────────┬───────────┘                      │
            │                                  │
            ▼                                  ▼
┌─────────────────────────────────────────────────────┐
│  Upstream surfaces (cited by TDD-XXX §M anchors)    │
│   TDD-022 chains, TDD-023 deploy, TDD-024 cloud     │
└─────────────────────────────────────────────────────┘
```

### 4.2 The agent-prompt extension pattern (G-08)

Both agents are Claude prompts authored as Markdown with a frontmatter block. The extension pattern this TDD establishes:

| Element                          | Extension rule                                                                                          |
|----------------------------------|----------------------------------------------------------------------------------------------------------|
| Frontmatter `name`               | Never change. Existing eval cases reference it.                                                          |
| Frontmatter `tools` allowlist    | Append-only. Add `Bash(chains *)`, `Bash(deploy *)`, etc., never remove existing entries.                 |
| H2 sections                      | Append after the existing tail. Never reorder existing H2s.                                               |
| Tables                           | Append rows after existing rows. Never reorder. Column schema is frozen.                                 |
| Behavior guidelines              | Append, don't replace. New guideline must not contradict an existing one (reviewer agent enforces).      |

The reviewer agent (`standards-meta-reviewer`, TDD-020) checks a diff against this pattern; any violation auto-fails review.

### 4.3 The boundary contract (G-05)

The phase-16 boundary contract is a structured document that lives in `skills/setup-wizard/SKILL.md` as a marker comment block. Its shape:

```markdown
<!-- BEGIN PHASE-16 CONTRACT (TDD-027 §6 ↔ TDD-033 §5) -->
provides:
  - cloud-prompt-tree.md   # static prompts authored by TDD-027
  - phase-16-content.md    # static content authored by TDD-027
consumes:
  - runtime check: are autonomous-dev-deploy-* plugins installed?
  - runtime check: which firewall backend does this OS support?
  - runtime check: is cred-proxy already bootstrapped?
runtime owner: TDD-033
content owner: TDD-027
<!-- END PHASE-16 CONTRACT -->
```

The contract is authored by this TDD; the runtime is implemented by TDD-033. The reviewer agent verifies (a) the contract block exists, (b) both `provides` and `consumes` lists are non-empty, (c) both owner anchors resolve.

---

## 5. Detailed design — Agent extensions

### 5.1 `agents/troubleshooter.md` extensions

#### 5.1.1 File-locations table additions (FR-1517, FR-1518)

Append after row `~/.config/systemd/user/autonomous-dev.service`:

| File / Directory                                     | Purpose                                                                                          |
|------------------------------------------------------|---------------------------------------------------------------------------------------------------|
| `~/.autonomous-dev/chains/audit.log`                 | HMAC-chained chain-execution audit log (TDD-022 §13). Do NOT edit or delete; verify-only.        |
| `~/.autonomous-dev/chains/manifest.lock`             | Resolved chain-DAG snapshot from the last successful chain run.                                  |
| `~/.autonomous-dev/deploy/plans/`                    | Per-request `deploy plan` outputs awaiting approval.                                             |
| `~/.autonomous-dev/deploy/ledger.json`               | Cost-cap ledger (TDD-023 §14). Append-only; do NOT hand-edit.                                    |
| `~/.autonomous-dev/deploy/logs/`                     | Per-request `deploy logs` JSONL output, one file per REQ-NNNNNN.                                  |
| `~/.autonomous-dev/cred-proxy/socket`                | SCM_RIGHTS Unix socket (TDD-024 §8). Permissions must be `0600`; check with `stat`.              |
| `~/.autonomous-dev/cred-proxy/audit.log`             | Per-issuance audit hash log (TDD-024 §10).                                                        |
| `~/.autonomous-dev/firewall/allowlist`               | Resolved per-plugin egress allowlist (TDD-024 §11).                                              |
| `~/.autonomous-dev/firewall/denied.log`              | Per-deny event log; `tail` for live denials.                                                       |

These rows append to the existing 15-row table, taking it to 24 rows. The table column schema is unchanged.

#### 5.1.2 New diagnostic-procedure subsections (FR-1519)

Append after the existing "Configuration Issues" subsection:

```markdown
#### Chain Diagnostics

1. List all registered chain plugins: `chains list`
2. Render the dependency DAG: `chains graph`
3. Verify the audit log: `chains audit verify`
   - HMAC mismatch: **DO NOT delete the audit log.** Inspect `~/.autonomous-dev/chains/manifest.lock` for divergence; the recovery path is in `instructions/chains-runbook.md` §3 (owned by TDD-026).
4. Cycle detected: identify the offending edge with `chains graph --highlight-cycles`. The fix is in the offending plugin's `produces`/`consumes` declaration.
5. Approval pending: list pending approvals with `chains list --status awaiting-approval`; approve with `chains approve REQ-NNNNNN` or reject with `chains reject REQ-NNNNNN --reason "..."`.

#### Deploy Diagnostics

1. List backends: `deploy backends list`. If the expected backend is missing, the corresponding cloud plugin (`autonomous-dev-deploy-{cloud}`) is not installed.
2. Inspect the plan: `cat ~/.autonomous-dev/deploy/plans/REQ-NNNNNN.json | jq .`
3. Inspect the ledger: `cat ~/.autonomous-dev/deploy/ledger.json | jq '.environments.<env>'`. Do NOT hand-edit; if corrupted, use `deploy ledger reset --env <env>`.
4. Read deploy logs: `deploy logs REQ-NNNNNN` (or `tail -f ~/.autonomous-dev/deploy/logs/REQ-NNNNNN.jsonl | jq .`)
5. Check the approval state: `cat ~/.autonomous-dev/deploy/plans/REQ-NNNNNN.json | jq .approval_state`. Valid states: `pending`, `awaiting-approval`, `approved`, `rejected`, `executing`, `completed`, `failed`.
6. Prod deploys ALWAYS require human approval regardless of trust level (TDD-023 §11). If stuck on `awaiting-approval` for a prod env, run `deploy approve REQ-NNNNNN`.

#### Credential-Proxy Diagnostics

1. Health check: `cred-proxy doctor`. Reports socket permissions, scoper plugins, last issuance, and TTL.
2. Permission denied on socket: check `stat ~/.autonomous-dev/cred-proxy/socket` for `0600`. If wrong, restart cred-proxy.
3. TTL expired mid-deploy: do NOT rotate root credentials. Re-bootstrap with `cred-proxy bootstrap --cloud <cloud>`.
4. Detail in `instructions/cred-proxy-runbook.md` (owned by TDD-025).

#### Firewall Diagnostics

1. Test a host: `firewall test https://example.com:443`
2. Read denied events: `tail -50 ~/.autonomous-dev/firewall/denied.log | jq .`
3. Inspect resolved allowlist: `cat ~/.autonomous-dev/firewall/allowlist | jq .`
4. DNS-refresh lag (an allowed host appears denied): wait for the next refresh interval (default 60s) or force one with `firewall refresh-dns`.
5. Detail in `instructions/firewall-runbook.md` (owned by TDD-025).
```

These four new subsections add ~70 lines to the troubleshooter (224 → ~295). The pattern matches the existing "Daemon Not Starting" / "Cost Problems" subsection style.

#### 5.1.3 Frontmatter tool-allowlist additions

```yaml
tools:
  - Read
  - Glob
  - Grep
  - Bash(cat *)
  - Bash(jq *)
  - Bash(ls *)
  - Bash(head *)
  - Bash(tail *)
  - Bash(wc *)
  - Bash(find *)
  - Bash(stat *)
  - Bash(git *)
  - Bash(chains *)        # NEW
  - Bash(deploy *)        # NEW
  - Bash(cred-proxy *)    # NEW
  - Bash(firewall *)      # NEW
```

Append-only. Existing entries unchanged.

### 5.2 `agents/onboarding.md` extensions

#### 5.2.1 Pipeline-status table additions (FR-1520)

The existing onboarding agent has a "What success looks like" section in Step 7 that refers to "the status is advancing through the pipeline" but does not enumerate pause states. We append a new H3 "Pause states" subsection after Step 7 (and before "After Onboarding"):

```markdown
### Pipeline Pause States

When a request pauses, the `status` field will indicate why. The four most common pause states for a fresh installation:

| Pause state               | What it means                                                                | Operator action                                                                          |
|---------------------------|------------------------------------------------------------------------------|------------------------------------------------------------------------------------------|
| `awaiting-approval`       | A deploy plan or chain run is waiting for a human approval gate.             | `deploy approve REQ-NNNNNN` (or `chains approve`); for prod environments this is mandatory. |
| `cost-cap-tripped`        | The cumulative cost would exceed the per-environment cap.                    | Inspect `~/.autonomous-dev/deploy/ledger.json`; raise the cap in `deploy.yaml` or revert. |
| `firewall-denied`         | The egress firewall denied an outbound connection a backend tried to make.    | Inspect `~/.autonomous-dev/firewall/denied.log`; update the per-plugin allowlist.        |
| `cred-proxy-ttl-expired`  | The credential proxy's STS token (default 15 min) expired mid-deploy.        | Run `cred-proxy bootstrap --cloud <cloud>` to refresh; do NOT rotate root credentials.   |

Each of these has a deeper troubleshooting walkthrough in the corresponding instruction runbook (`deploy-runbook.md`, `firewall-runbook.md`, `cred-proxy-runbook.md`).
```

This adds ~25 lines to the onboarding agent.

#### 5.2.2 First-cloud-deploy appendix (FR-1521)

Append after "After Onboarding" as a new H2 section:

```markdown
## Appendix: First Cloud Deploy

If you intend to use autonomous-dev with a cloud target (GCP, AWS, Azure, or Kubernetes), the local-only steps above are not sufficient. The cloud deploy path requires:

1. The matching cloud plugin (`autonomous-dev-deploy-gcp`, `-aws`, `-azure`, or `-k8s`) to be installed.
2. A bootstrapped credential proxy (`cred-proxy bootstrap --cloud <cloud>`).
3. A configured egress firewall backend (`firewall init` on Linux/macOS; or explicit opt-out for development).
4. A dry-run deploy to confirm end-to-end connectivity.

For a guided walkthrough of all four prerequisites, run:

```
/autonomous-dev-assist:setup-wizard --with-cloud
```

The wizard's phase 16 ("Deploy Backends") covers cloud-plugin selection, cred-proxy bootstrap, firewall configuration, and a dry-run deploy. It is **opt-in**: the local-only path you completed in steps 1-7 above is unaffected.

For the underlying surfaces:
- Plugin chains and deploy: see `instructions/chains-runbook.md`, `instructions/deploy-runbook.md` (owned by TDD-026).
- Credential proxy and firewall: see `instructions/cred-proxy-runbook.md`, `instructions/firewall-runbook.md` (owned by TDD-025).
```

This adds ~30 lines to the onboarding agent (293 → ~325 with the pause-state subsection).

#### 5.2.3 Frontmatter tool-allowlist

The onboarding agent does not invoke `chains`, `deploy`, `cred-proxy`, or `firewall` directly; it only points operators at the wizard. No tool-allowlist changes.

---

## 6. Phase-16 boundary contract (G-05)

This is the contract section TDD-033 consumes.

### 6.1 What this TDD provides

The assist plugin contributes to phase 16 of the setup wizard:

| Artifact                                    | Owned by      | Loaded at runtime by    |
|---------------------------------------------|---------------|--------------------------|
| `cloud-prompt-tree.md`                      | TDD-027 (this) | TDD-033 phase-16 module  |
| Cloud-plugin enumeration table              | TDD-027 (this) | TDD-033 phase-16 module  |
| `cred-proxy bootstrap` invocation snippet   | TDD-027 (this) | TDD-033 phase-16 module  |
| Firewall-backend-selection branch logic    | TDD-027 (this) | TDD-033 phase-16 module  |
| Dry-run deploy command snippet              | TDD-027 (this) | TDD-033 phase-16 module  |

The `cloud-prompt-tree.md` is a static document with this shape:

```markdown
# Phase-16 prompt tree

## Branch A: Cloud plugin choice
Q: Which cloud do you intend to deploy to?
  → gcp:    autonomous-dev-deploy-gcp
  → aws:    autonomous-dev-deploy-aws
  → azure:  autonomous-dev-deploy-azure
  → k8s:    autonomous-dev-deploy-k8s
  → none:   abort phase 16, return to phase 11.

If the chosen cloud's plugin is NOT installed, surface the install command and EXIT phase 16 cleanly.

## Branch B: Cred-proxy bootstrap
If `cred-proxy doctor` reports unhealthy:
  → run `cred-proxy bootstrap --cloud <chosen>`
Else: skip Branch B.

## Branch C: Firewall backend
On Linux: backend = nftables (require sudo)
On macOS: backend = pfctl (require sudo)
On other / opt-out: backend = disabled (warn the operator)

## Branch D: Dry-run deploy
Run `deploy plan REQ-WIZARD-DRYRUN --env staging --dry-run`
Inspect output; if successful, phase 16 complete.
```

Total ~80 lines authored by this TDD.

### 6.2 What this TDD does NOT provide

- The runtime check that determines plugin presence (TDD-033 §5).
- The wizard prompt loop and validation (TDD-033 §5).
- The phase-16 fail-closed handler (TDD-033 §5).
- The integration of phase 16 with phases 8 and 11-15 (TDD-033 §3).

### 6.3 The boundary marker

In `skills/setup-wizard/SKILL.md`, between phase 10 and the new phase 11 (owned by TDD-033), the boundary marker block from §4.3 is inserted:

```markdown
<!-- BEGIN PHASE-16 CONTRACT (TDD-027 §6 ↔ TDD-033 §5) -->
... (block per §4.3) ...
<!-- END PHASE-16 CONTRACT -->
```

The marker is invisible in rendered Markdown but mechanically detectable by the reviewer agent.

---

## 7. Eval cases (G-06)

This TDD authors ≥10 eval cases for the agent surfaces. They are split between the existing `troubleshoot-scenarios.yaml` and a new `onboarding-questions.yaml` (which currently exists in `eval-config.yaml` as `enabled: false` placeholder; this TDD activates it).

### 7.1 Troubleshooter cases (≥6)

| ID                       | Difficulty | Question                                                          | Must mention                                          | Must NOT mention                                |
|--------------------------|------------|--------------------------------------------------------------------|--------------------------------------------------------|--------------------------------------------------|
| `tshoot-chains-001`      | medium     | "chains audit verify says HMAC mismatch — what do I do?"          | `chains audit`, do NOT delete                          | `rm.*audit.log`, `chains rotate-key`             |
| `tshoot-deploy-001`      | medium     | "my deploy is stuck on awaiting-approval"                          | `deploy approve REQ-NNNNNN`, prod always               | `--no-approval`, `deploy auto-prod`              |
| `tshoot-deploy-002`      | hard       | "deploy aborted with cost-cap-tripped"                              | `deploy ledger reset`, do NOT hand-edit                | `edit.*ledger.json`                              |
| `tshoot-credp-001`       | medium     | "cred-proxy says permission denied on socket"                      | `stat`, `0600`, `cred-proxy doctor`                    | `chmod 777`                                       |
| `tshoot-firewall-001`    | medium     | "firewall denied my backend's HTTPS request"                       | `denied.log`, `firewall test`, allowlist                | `firewall disable-all`                           |
| `tshoot-credp-002`       | hard       | "cred-proxy TTL expired in middle of deploy"                       | `cred-proxy bootstrap`, do NOT rotate root             | `aws iam update-access-key`                       |

### 7.2 Onboarding cases (≥4)

| ID                       | Difficulty | Question                                                          | Must mention                                          | Must NOT mention                                |
|--------------------------|------------|--------------------------------------------------------------------|--------------------------------------------------------|--------------------------------------------------|
| `onboard-cloud-001`      | easy       | "how do I onboard a new cloud backend?"                            | `setup-wizard --with-cloud`, phase 16                   | `pip install autonomous-dev-deploy`              |
| `onboard-pause-001`      | medium     | "what does cost-cap-tripped mean during onboarding?"               | `ledger.json`, raise cap, do NOT hand-edit              | `set --cost-cap 0`                               |
| `onboard-pause-002`      | medium     | "pipeline paused on awaiting-approval — is something broken?"       | `deploy approve`, expected for prod                     | `force-approve`                                   |
| `onboard-pause-003`      | medium     | "what is firewall-denied? did I install something wrong?"          | `denied.log`, allowlist, expected for new plugins       | `disable firewall`                               |

Total: ≥10 cases authored here. The cases are added to existing files (`troubleshoot-scenarios.yaml` and `onboarding-questions.yaml`); the schema is shared with TDD-026 and TDD-028 (per FR-1536).

---

## 8. Cross-cutting concerns

### 8.1 Security

- **Tool-allowlist principle of least privilege.** The troubleshooter gains exactly four new `Bash(<command> *)` entries. It does not gain blanket `Bash(*)`. Any future invocation of a non-allowlisted command surfaces as "tool not allowed" rather than executing.
- **No destructive prescriptions without state.** Every diagnostic procedure begins with a state-gathering step (`stat`, `cat`, `tail`). The `do NOT delete` warnings on chains audit log and ledger are mandatory text in both the agent and the negative eval cases.
- **Onboarding cred-proxy guidance.** The "first cloud deploy" appendix never instructs the operator to paste credentials into the wizard; it only references the `cred-proxy bootstrap` command.
- **Wizard-phase-16 contract.** The runtime (TDD-033) is responsible for not echoing secrets back to the operator. This TDD's content is constructed so a typical bootstrap value never appears verbatim in the `cloud-prompt-tree.md`.

### 8.2 Privacy

- All sample log queries use placeholder REQ-NNNNNN.
- The "first cloud deploy" appendix uses cloud-name placeholders (`<cloud>`) rather than real tenant IDs.
- Eval cases use synthetic question text; no operator-provided text is ever recorded.

### 8.3 Scalability

- Troubleshooter prompt size: 224 lines → ~295 lines (~31% increase). Token cost per invocation: ~+800 tokens on a 200K-budget session. Well within the per-call budget.
- Onboarding prompt size: 293 lines → ~330 lines (~13% increase). Same budget headroom.
- Phase-16 contract block: ~15 lines in `setup-wizard/SKILL.md`. Negligible.
- Eval cases: +10 to the existing 90. Per-suite eval runtime grows ~15s (proportional). Total `eval all` budget impact: <1 minute.

### 8.4 Reliability

- **Append-only pattern (G-08).** All extensions are append-only at agent prompts, table rows, and tool-allowlists. The existing 90 eval cases cannot regress because their inputs target unchanged surfaces.
- **Boundary contract (§6).** The marker block is verified by the reviewer agent; if either side breaks the contract, the next CI run flags it before merge.
- **Cloud-opt-in (G-07, FR-1516).** The local-only onboarding path is not changed. Operators who never see `--with-cloud` continue with the 7-step flow.
- **Tool-allowlist failure mode.** If a new `Bash(<command> *)` entry is missing on the next agent run, the diagnostic procedure surfaces "tool not allowed" — visible failure, not silent miss.

### 8.5 Observability

- Each new diagnostic subsection begins with an explicit state-gathering step. The state queried is logged by the assist's `Bash` tool calls (existing instrumentation).
- Eval results write to `evals/results/eval-<timestamp>.json`. The new cases have unique IDs (`tshoot-chains-001`, etc.) so per-case pass/fail is trackable across runs.
- The phase-16 contract block is self-documenting: a `grep "PHASE-16 CONTRACT"` returns its location.

### 8.6 Cost

- One-time authoring: troubleshooter extension ~6 hours, onboarding extension ~3 hours, phase-16 contract ~3 hours, eval cases ~2 hours = ~14 hours.
- Per-PR CI eval cost increase: ~$0.50 per `eval all` (+10 cases at ~$0.05).
- Long-term cost reduction: most operator-support tickets on "I don't understand this pause state" or "what is awaiting-approval?" are absorbed by the onboarding appendix.

---

## 9. APIs & interfaces

### 9.1 Phase-16 contract API

| Field            | Type            | Source         |
|------------------|-----------------|-----------------|
| `provides`       | string array    | TDD-027 (this) |
| `consumes`       | string array    | TDD-033        |
| `runtime owner`  | TDD anchor      | TDD-033        |
| `content owner`  | TDD anchor      | TDD-027 (this) |

The contract block lives in `skills/setup-wizard/SKILL.md`. Its presence and well-formedness is checked by the reviewer agent.

### 9.2 Agent-prompt schema

| Element                | Mutability                               |
|------------------------|------------------------------------------|
| Frontmatter `name`     | Frozen                                    |
| Frontmatter `description` | Frozen at minor; bump major to change |
| Frontmatter `tools`    | Append-only (this TDD adds 4 entries)    |
| H2 section ordering    | Frozen                                    |
| Existing tables        | Frozen schema; rows append-only          |

---

## 10. Error handling

### 10.1 Author-time

| Error                                                         | Detection                  | Action                                                                  |
|---------------------------------------------------------------|----------------------------|--------------------------------------------------------------------------|
| Reordering existing H2 sections in agent prompts              | Reviewer agent diff check   | Auto-fail.                                                                |
| Removing rows from existing tables                            | Reviewer agent diff check   | Auto-fail.                                                                |
| Missing phase-16 contract markers                             | Reviewer agent grep         | Auto-fail.                                                                |
| Phase-16 `provides` / `consumes` block empty                  | Reviewer agent parse        | Auto-fail.                                                                |
| Tool-allowlist removal                                        | Reviewer agent diff check   | Auto-fail.                                                                |

### 10.2 Runtime (operator using agent)

| Error                                                              | Behavior                                                                                |
|--------------------------------------------------------------------|------------------------------------------------------------------------------------------|
| Operator runs `--with-cloud` without cloud plugins installed       | Wizard phase 16's plugin-presence check (TDD-033 §5) surfaces the install command and exits. |
| Operator on unsupported OS chooses firewall                        | Phase-16 Branch C falls through to "disabled" with a warning.                              |
| Troubleshooter invokes `chains list` but the chain executor is down | The Bash tool returns a non-zero exit; agent reports the exit code with diagnostic context. |

---

## 11. Performance

| Metric                                                      | Target           | Notes                                                              |
|-------------------------------------------------------------|------------------|---------------------------------------------------------------------|
| Troubleshooter agent response p95                          | <15 s            | Adds 1 Bash call per new diagnostic; net effect <2 s.               |
| Onboarding agent response p95                              | <12 s            | No new Bash calls; new content is read-only Markdown.               |
| Phase-16 contract parse time                               | <50 ms            | Plain Markdown parse; no schema validation overhead.                |

---

## 12. Migration & rollout

| Phase | Activity                                                                            | Exit criterion                                  |
|-------|--------------------------------------------------------------------------------------|--------------------------------------------------|
| 1     | Append troubleshooter file-locations rows + diagnostic subsections.                  | Reviewer-agent diff check passes.                |
| 2     | Append troubleshooter tool-allowlist entries.                                         | Tool-allowlist parser passes.                    |
| 3     | Append onboarding pause-state subsection + first-cloud-deploy appendix.              | Onboarding eval cases ≥95% pass.                 |
| 4     | Insert phase-16 contract marker block in `setup-wizard/SKILL.md`.                    | Marker grep passes; contract parse passes.       |
| 5     | Add ≥10 eval cases (6 troubleshooter, 4 onboarding).                                  | All ≥95% pass; existing 90 hold.                 |
| 6     | Coordinate with TDD-033 to consume the contract.                                      | TDD-033 PR references this TDD's anchor.         |

Rollback: revert the PR. The previous behavior (no chain/deploy guidance in agents) returns. No data loss.

---

## 13. Test strategy

### 13.1 Unit-level

- Reviewer-agent regex tests for the append-only pattern (10 cases).
- Phase-16 contract parser tests (5 cases).
- Tool-allowlist parser tests (3 cases).

### 13.2 Integration-level

- Run the troubleshooter cases (≥6) end-to-end; ≥95% pass.
- Run the onboarding cases (≥4) end-to-end; ≥95% pass.
- Run the existing 90-case suite; ≥95% (no regression).

### 13.3 Coordination test

- Before merging this TDD's PR, confirm TDD-033's draft phase-16 module satisfies the `consumes` list. (A static check; no runtime execution.)

### 13.4 Manual review

- An on-call engineer who has never seen the new content runs through the cloud-onboarding path (`/autonomous-dev-assist:setup-wizard --with-cloud`) on a fresh laptop and reports any wrong answers.

---

## 14. Operational readiness

- **Deployment.** Markdown-only PR. No daemon restart, no service migration.
- **Feature flag.** None. The new content is loaded lazily by the agent prompts; questions that don't match never exercise it.
- **Canary.** Eval suite at ≥95% gates merge.
- **Rollback.** Revert the PR.

---

## 15. Coordination with TDD-033

TDD-033 is the setup-wizard phase-module refactor. It owns the runtime for phases 8, 11-15, and 16. The coordination contract:

| Item                           | TDD-027 (this)                                                | TDD-033                                              |
|--------------------------------|----------------------------------------------------------------|-------------------------------------------------------|
| Phase-16 prompt tree           | Authors `cloud-prompt-tree.md`.                                 | Loads it at runtime.                                  |
| Phase-16 plugin presence check | Specifies the static "install missing plugin" message.          | Implements the check itself.                          |
| Phase-16 firewall branch logic | Specifies the branch table (Linux→nftables, macOS→pfctl, …).    | Implements the OS detection and branch routing.       |
| Phase-16 boundary marker       | Inserts the marker in `setup-wizard/SKILL.md`.                  | Verifies the marker before invoking phase 16.         |

The two TDDs land as independent PRs. Either can land first. The marker block is forward-compatible: TDD-033 can ship without phase 16's content if this TDD is delayed; this TDD can ship without phase 16's runtime if TDD-033 is delayed (operators see the static prompt tree and no runtime, which is acceptable).

---

## 16. Open questions

| ID    | Question                                                                                                          | Recommended answer                                                                                  | Status |
|-------|-------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------|--------|
| OQ-1  | Should the troubleshooter agent gain `Bash(*)` blanket allowlist for "unknown future commands"?                   | **No.** Principle of least privilege; explicit additions only.                                       | Closed |
| OQ-2  | Should the phase-16 prompt tree be authored as a Mermaid diagram for visual rendering?                            | **Defer.** Markdown text is sufficient for TDD-033 to consume; visual rendering is operator-facing. | Open   |
| OQ-3  | Should the onboarding "first cloud deploy" appendix be omitted entirely if no cloud plugins are detected at runtime? | **No.** The appendix is static text in the agent prompt; runtime detection happens in the wizard.   | Closed |
| OQ-4  | If TDD-033 lands first and phase 16 has no content, what does the runtime show?                                    | **An "under construction" message pointing back to this TDD's open work.** Specified in TDD-033.    | Open   |
| OQ-5  | Should the tool-allowlist additions be guarded by a config flag in case operators don't trust the new commands?    | **No.** Trust the upstream commands; allowlist is the trust gate, not a config flag.                 | Open   |
| OQ-6  | Should the boundary contract block be in machine-parseable YAML inside an HTML comment (current) or in a separate .yaml file? | **HTML comment block.** Avoids a second parse step; keeps the contract co-located with content. | Closed |
| OQ-7  | Should we add a "common mistakes I have seen" callout to the troubleshooter file-locations table for paths that operators frequently confuse? | **Defer.** Style decision; not required for parity.                                              | Open   |

---

## 17. References

| Document                                                                              | Relationship                                  |
|---------------------------------------------------------------------------------------|------------------------------------------------|
| `plugins/autonomous-dev/docs/prd/PRD-015-assist-extension-for-chains-deploy-cloud.md` | Parent PRD                                    |
| `plugins/autonomous-dev/docs/tdd/TDD-022-plugin-chaining-engine.md`                   | Upstream surface (chains)                     |
| `plugins/autonomous-dev/docs/tdd/TDD-023-deployment-backend-framework-core.md`        | Upstream surface (deploy)                     |
| `plugins/autonomous-dev/docs/tdd/TDD-024-cloud-backends-credential-proxy.md`          | Upstream surface (cred-proxy + firewall)      |
| `plugins/autonomous-dev/docs/tdd/TDD-025-assist-cloud-credproxy-surface.md`           | Sibling — cloud + cred-proxy SKILL content    |
| `plugins/autonomous-dev/docs/tdd/TDD-026-assist-chains-deploy-cli-surfaces.md`        | Sibling — chains + deploy SKILL content       |
| `plugins/autonomous-dev/docs/tdd/TDD-028-assist-evals-readme-cross-cutting.md`        | Sibling — eval-config registration + README   |
| `plugins/autonomous-dev/docs/tdd/TDD-033-setup-wizard-phase-modules.md`               | Coordinated TDD — owns phase-16 runtime       |
| `plugins/autonomous-dev-assist/agents/troubleshooter.md`                              | Surface modified by FR-1517, FR-1518, FR-1519 |
| `plugins/autonomous-dev-assist/agents/onboarding.md`                                  | Surface modified by FR-1520, FR-1521          |
| `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md`                          | Surface modified (phase-16 boundary marker)   |
| `plugins/autonomous-dev-assist/evals/test-cases/troubleshoot-scenarios.yaml`          | Surface modified (≥6 cases appended)          |
| `plugins/autonomous-dev-assist/evals/test-cases/onboarding-questions.yaml`            | Surface modified (≥4 cases authored; suite activated) |

---

## 18. Appendix: file-by-file change inventory

| File                                                                              | Change   | Lines added (approx.) | FR coverage          |
|-----------------------------------------------------------------------------------|----------|------------------------|----------------------|
| `plugins/autonomous-dev-assist/agents/troubleshooter.md`                          | Modified | +95                    | FR-1517, 1518, 1519  |
| `plugins/autonomous-dev-assist/agents/onboarding.md`                              | Modified | +55                    | FR-1520, 1521        |
| `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md`                      | Modified | +15 (boundary marker) + cloud-prompt-tree references | FR-1515 hand-off |
| `plugins/autonomous-dev-assist/instructions/cloud-prompt-tree.md`                 | New      | ~80                    | FR-1515 hand-off     |
| `plugins/autonomous-dev-assist/evals/test-cases/troubleshoot-scenarios.yaml`      | Modified | +6 cases               | FR-1538              |
| `plugins/autonomous-dev-assist/evals/test-cases/onboarding-questions.yaml`        | Modified | +4 cases (suite activate) | FR-1538           |

**Total**: 4 modified, 1 new = **5 file changes**.

---

*End of TDD-027.*
