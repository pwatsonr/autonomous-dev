# TDD-025: Assist Cloud Backends & Credential Proxy Surface

| Field        | Value                                                                                       |
|--------------|---------------------------------------------------------------------------------------------|
| **Title**    | Assist Cloud Backends & Credential Proxy Surface (`autonomous-dev-assist` parity for TDD-024 §6, §7-§10) |
| **TDD ID**   | TDD-025                                                                                     |
| **Version**  | 1.0                                                                                         |
| **Date**     | 2026-05-02                                                                                  |
| **Status**   | Draft                                                                                       |
| **Author**   | Patrick Watson                                                                              |
| **Parent PRD** | PRD-015: Extend autonomous-dev-assist for Plugin Chains, Deploy, Cloud, Cred-Proxy, Firewall, Cost Estimation |
| **Plugin**   | autonomous-dev-assist                                                                       |
| **Upstream** | TDD-024 §6 (Cloud Backend Plugins), §7-§10 (Credential Proxy)                                |

---

## 1. Summary

This TDD specifies the changes to `autonomous-dev-assist` required for **operator parity with the four cloud-backend plugins and the credential proxy** introduced by TDD-024. It is the third of four sibling TDDs descending from PRD-015 (siblings TDD-025 chains, TDD-026 deploy, TDD-028 firewall+cost). It is independently mergeable, eval-gated at ≥95%, and touches only the assist plugin.

The credential-proxy is the second-highest stakes operator surface in PRD-015 after the chains audit log. It uses `SCM_RIGHTS` Unix-socket file-descriptor passing for token transport — a pattern unfamiliar to most operators — and a 15-minute default TTL with auto-revoke that produces a specific failure mode (TTL expiry mid-deploy) operators routinely misdiagnose as a credential-rotation issue. Wrong assist guidance in this area can cause unnecessary root-credential rotation under no actual auth incident (PRD-015 R-7 analog).

This TDD adds:

- A new top-level **"Cloud Backends"** section in `skills/help/SKILL.md` (FR-1504) listing the four plugin names, capability declarations, and registration mechanism.
- A new top-level **"Credential Proxy"** section in `skills/help/SKILL.md` (FR-1505) explaining the per-cloud scopers, SCM_RIGHTS Unix-socket transport, 15-minute default TTL, auto-revoke contract, and per-issuance audit hash.
- A new **`cred_proxy`** section in `skills/config-guide/SKILL.md` (FR-1510) documenting socket path, default TTL, scoper plugin paths, and the `CRED_PROXY_AUDIT_KEY_ENV` env var.
- Two troubleshoot scenarios (FR-1513 portion) covering cred-proxy TTL-expired-mid-deploy and socket-permission-denied.
- New rows in the troubleshooter file-locations table covering `~/.autonomous-dev/cred-proxy/{socket,audit.log}` (FR-1518 cred-proxy portion).
- A new **`instructions/cred-proxy-runbook.md`** (FR-1529).
- A new **`evals/test-cases/cred-proxy-eval.yaml`** with **≥15 cases** including ≥5 negative cases (FR-1534, FR-1538 partial).
- Glob and classification updates in `commands/assist.md` for `intake/cred-proxy/*` and the four cloud-backend plugin directories (FR-1522 portion).
- Setup-wizard phases for cloud backend selection and cred-proxy bootstrap (FR-1515 portion); the firewall phase is owned by TDD-028.

The `--with-cloud` flag wiring in `quickstart.md` is owned by TDD-026 §6.7. This TDD plugs into that flag by extending `setup-wizard/SKILL.md` with the cloud and cred-proxy phases.

## 2. Goals & Non-Goals

| ID    | Goal                                                                                                                                                |
|-------|-----------------------------------------------------------------------------------------------------------------------------------------------------|
| G-01  | Document the four cloud backend plugin names and how they register with the deploy framework, so operators can install correctly.                    |
| G-02  | Document the credential proxy with sufficient depth that an operator can diagnose a `permission denied` on the socket without escalation.            |
| G-03  | Document the SCM_RIGHTS transport at a level operators need (file-descriptor passing, not raw bytes) without bogging into POSIX internals.            |
| G-04  | Document the 15-minute TTL, auto-revoke, and per-issuance audit hash so the TTL-expiry-mid-deploy scenario is correctly diagnosed.                  |
| G-05  | Add the cloud-bootstrap setup-wizard phases that extend cleanly from the existing 10 phases, mark them optional (FR-1516), and check prereqs.       |
| G-06  | Add a cred-proxy runbook covering bootstrap, scoper installation per cloud, socket-permission troubleshooting, TTL tuning, audit-hash verification. |
| G-07  | ≥95% pass rate on `cred-proxy-eval.yaml` (≥15 cases, ≥5 negative).                                                                                  |
| G-08  | Zero regression on existing 90 + 50 (chains + deploy from siblings) eval cases.                                                                     |

| ID    | Non-Goal                                                                                                                                            |
|-------|-----------------------------------------------------------------------------------------------------------------------------------------------------|
| NG-01 | Modifying TDD-024 cred-proxy semantics, scoper logic, or socket transport. Documents only.                                                           |
| NG-02 | Documenting per-cloud cost-fixture format. Owned by TDD-028 (`cost_estimation` config-guide section).                                                |
| NG-03 | Documenting firewall semantics. Owned by TDD-028.                                                                                                     |
| NG-04 | Live integration tests against a running cred-proxy. Eval scores answer text only.                                                                   |
| NG-05 | Pinning TDD-024 SHAs (FR-1540).                                                                                                                       |
| NG-06 | Adding a `cred-proxy-doctor` slash command. PRD-015 NG-02 forbids; the existing `cred-proxy doctor` CLI subcommand is documented but not wrapped.    |
| NG-07 | Documenting the K8s-specific service-account-token-projection variant of cred-proxy in detail. Mention only; defer depth to a future TDD.            |

## 3. Background

### 3.1 What landed in TDD-024 §6: cloud backend plugins

Four plugins, each registering a backend with the deploy framework:

| Plugin                          | Backend  | Capability declaration                                      |
|---------------------------------|----------|-------------------------------------------------------------|
| `autonomous-dev-deploy-gcp`     | `gcp`    | GCE, Cloud Run, GKE; via `gcloud` shell                     |
| `autonomous-dev-deploy-aws`     | `aws`    | EC2, ECS, EKS, Lambda; via `aws` CLI                        |
| `autonomous-dev-deploy-azure`   | `azure`  | App Service, AKS; via `az` CLI                              |
| `autonomous-dev-deploy-k8s`     | `k8s`    | Generic Kubernetes (any provider); via `kubectl`            |

Registration: each plugin's `.claude-plugin/plugin.json` declares `provides: deploy-backend` and `backend-name: <name>`. The deploy framework's `BackendRegistry` discovers them at daemon start and exposes them via `deploy backends`.

### 3.2 What landed in TDD-024 §7-§10: credential proxy

The credential proxy issues short-lived, scope-narrowed credentials to the deploy framework without exposing root credentials to the deploying process. Architecture:

```
operator's shell environment (root creds: AWS_PROFILE, GCP keyfile, etc.)
        │
        ▼
┌─────────────────────────────────────────┐
│ cred-proxy daemon                        │
│   listens on ~/.autonomous-dev/         │
│           cred-proxy/socket             │
│   (mode 0600, owner-only)               │
└─────────────────┬────────────────────────┘
                  │ SCM_RIGHTS (file descriptor passing)
                  ▼
┌─────────────────────────────────────────┐
│ deploy worker (autonomous-dev daemon)   │
│   receives scoped FD                     │
│   never sees root creds                  │
│   credential expires at TTL end (15m)    │
└─────────────────────────────────────────┘
```

CLI surface:

| Subcommand                           | Purpose                                                              |
|--------------------------------------|----------------------------------------------------------------------|
| `cred-proxy start`                   | Launch the proxy daemon                                              |
| `cred-proxy stop`                    | Stop the daemon (revokes outstanding tokens)                         |
| `cred-proxy status`                  | Daemon health + active token count                                   |
| `cred-proxy doctor`                  | Diagnostic: socket perms, scoper presence, root-cred reachability    |
| `cred-proxy issue <cloud> <scope>`   | Manual token issuance (typically for testing)                        |
| `cred-proxy revoke <token-id>`       | Emergency revoke                                                     |

Per-cloud scopers (TDD-024 §8):

- `cred-proxy-scoper-aws` — translates root creds to STS short-term creds with IAM-policy-narrowed scope.
- `cred-proxy-scoper-gcp` — translates SA keyfile to short-lived OIDC token.
- `cred-proxy-scoper-azure` — uses `az account get-access-token --resource <scope>`.
- `cred-proxy-scoper-k8s` — projects a service-account token via TokenRequest API.

Each scoper is a separate plugin operators install per cloud they target.

Audit log: `~/.autonomous-dev/cred-proxy/audit.log` — HMAC-chained, similar to the chains audit log (TDD-022 §14). Per-issuance audit hash records token-id, cloud, scope, requester process, TTL, and chain-hash. Verification command `cred-proxy doctor --verify-audit`.

### 3.3 Operator failure modes this TDD addresses

| Failure mode                                         | Wrong-answer cost                                              | Mitigation                                                |
|------------------------------------------------------|----------------------------------------------------------------|-----------------------------------------------------------|
| `EACCES` on socket connect                            | Operator chowns socket as root, breaking ownership invariant   | Troubleshoot scenario specifies `chmod 0600` + ownership check |
| TTL expiry mid-deploy interpreted as auth failure    | Unnecessary root-cred rotation                                  | FR-1518 + cred-proxy-eval cases exclude `rotate-root`     |
| Operator `rm`s the audit log to "fix" socket         | Permanent loss of credential issuance history                  | `must_not_mention: rm.*audit.log`                         |
| Operator installs cloud backend without scoper       | First deploy fails with confusing "scoper not found"           | Setup-wizard checks scoper presence per cloud             |
| Operator confuses cred-proxy TTL with K8s SA token expiry | Wrong tier of remediation invoked                              | Eval case explicitly distinguishes the two                |

## 4. Architecture

The assist runtime architecture is unchanged. The cred-proxy-specific extension to the assist:

```
operator types: /autonomous-dev-assist:assist "cred-proxy permission denied"
        │
        ▼
┌──────────────────────────────────────────┐
│ assist.md Step 1: classify question      │
│   classification = "security" (NEW)      │
│   subclass = "cred-proxy" (NEW)          │
└──────────────┬───────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────┐
│ assist.md Step 2: gather context          │
│   Glob: intake/cred-proxy/*  (NEW)        │
│   Glob: plugins/autonomous-dev-deploy-*   │
│         (NEW: discovers installed clouds) │
│   Read: instructions/cred-proxy-runbook   │
│   Read: skills/help "Credential Proxy" §  │
│   Read: skills/config-guide cred_proxy §  │
│   Bash: ls -l ~/.autonomous-dev/         │
│         cred-proxy/socket 2>/dev/null     │
│   Bash: stat -f "%Sp %u %g" socket        │
└──────────────┬───────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────┐
│ structured answer:                        │
│   · direct: "socket perms wrong / proxy   │
│     not running / scoper missing"         │
│   · details: which case applies           │
│   · commands: cred-proxy doctor first      │
│   · See also: cred-proxy-runbook §3       │
└──────────────────────────────────────────┘
```

The Bash invocations are scoped to read-only commands within the existing `assist.md` frontmatter allowlist. `stat -f` is a macOS variant; `stat -c` is the Linux variant — the assist agent will pick correctly per platform.

For setup-wizard:

```
operator types: /autonomous-dev-assist:quickstart --with-cloud
                (--with-cloud parsed by TDD-026 §6.7)
        │
        ▼
┌──────────────────────────────────────────┐
│ setup-wizard/SKILL.md                    │
│   existing 10 phases run unchanged       │
│   THEN:                                  │
│   Phase 11 (NEW): cloud backend select   │
│     → check prereq plugin install        │
│   Phase 12 (NEW): cred-proxy bootstrap   │
│     → verify scoper installed            │
│     → cred-proxy start + doctor          │
│   Phase 13: firewall (TDD-028)           │
│   Phase 14: dry-run cloud deploy          │
│     (TDD-026 §6.7 owns the phase header) │
└──────────────────────────────────────────┘
```

Phases 11 and 12 are owned by this TDD. Phase 13 is TDD-028. Phase 14's outer shell is TDD-026; the cred-proxy interaction inside phase 14 (token issuance) is referenced from this TDD.

## 5. Schemas

### 5.1 Cloud-backend plugin manifest (documented)

The four cloud-backend plugins each declare:

```json
{
  "name": "autonomous-dev-deploy-gcp",
  "version": "1.x",
  "provides": "deploy-backend",
  "backend-name": "gcp",
  "scoper-plugin": "cred-proxy-scoper-gcp",
  "egress-allowlist-defaults": [
    "*.googleapis.com",
    "*.gcr.io"
  ]
}
```

The `egress-allowlist-defaults` field is consumed by the firewall (TDD-028's scope) but documented here as part of the cloud-backend manifest because it ships in the same plugin.

### 5.2 cred-proxy config schema

In `skills/config-guide/SKILL.md`'s new `cred_proxy` section, the documented config block:

```yaml
cred_proxy:
  socket_path: ~/.autonomous-dev/cred-proxy/socket
  default_ttl_seconds: 900            # 15 minutes
  audit_log: ~/.autonomous-dev/cred-proxy/audit.log
  audit_key_env: CRED_PROXY_AUDIT_KEY_ENV  # env var name (NOT the value)
  scopers:
    aws: ~/.autonomous-dev/cred-proxy/scopers/aws
    gcp: ~/.autonomous-dev/cred-proxy/scopers/gcp
    azure: ~/.autonomous-dev/cred-proxy/scopers/azure
    k8s: ~/.autonomous-dev/cred-proxy/scopers/k8s
  max_concurrent_tokens: 32
```

The `audit_key_env` field stores the *name* of an environment variable, not the key itself. This is documented explicitly to prevent operators pasting raw HMAC keys into the YAML.

### 5.3 Eval YAML schema

Unchanged per FR-1536. Cases follow the same shape as TDD-025 §5.1 and TDD-026 §5.2.

## 6. API

### 6.1 `skills/help/SKILL.md` — new "Cloud Backends" section

Subsections:

- **What are the cloud backends?** — Four plugin names, registration mechanism, how `deploy backends` discovers them.
- **Installation.** — `claude plugin install autonomous-dev-deploy-<cloud>` (refer operator to marketplace).
- **Capability declarations.** — Reference table of which deploy targets each plugin supports.
- **Egress allowlist defaults.** — One-paragraph mention; details in TDD-028's firewall section.
- **See also.** — Links to deploy-runbook (TDD-026 §6.8) and cred-proxy section below.

### 6.2 `skills/help/SKILL.md` — new "Credential Proxy" section

Subsections:

- **What is the credential proxy?** — One paragraph: short-lived scoped credentials issued via SCM_RIGHTS Unix-socket transport, never exposing root creds to deploy workers.
- **The six CLI subcommands** — Reference table per §3.2 above.
- **The four scopers.** — Per-cloud scoper plugin names; how each translates root creds.
- **TTL and auto-revoke.** — 15-minute default, configurable per call; expiry triggers immediate FD-close on the deploy side.
- **The per-issuance audit hash.** — One paragraph: each issuance writes a chained HMAC entry to `audit.log`; verification via `cred-proxy doctor --verify-audit`. Same warning as chains: **do not delete the audit log.**
- **SCM_RIGHTS in plain English.** — Two sentences: file-descriptor passing across processes via the Unix-socket ancillary-data channel; deploy worker receives an FD it cannot read root creds from.
- **See also.** — `instructions/cred-proxy-runbook.md`, `cred_proxy` config-guide section.

### 6.3 `skills/config-guide/SKILL.md` — new `cred_proxy` section

Documents the §5.2 schema. Required content:

- Socket path with file-permission contract (mode 0600, owner-only).
- Default TTL with the rationale ("STS-style short-lived; matches AWS minimum lifetime").
- The four scoper paths.
- The `audit_key_env` convention (env var name, not value).
- An example `cred_proxy:` config block.
- A "common pitfalls" subsection (do not commit the audit key; do not chmod the socket as root).

### 6.4 `skills/troubleshoot/SKILL.md` — new scenarios

Two scenarios added (FR-1513 cred-proxy portion):

1. **"`cred-proxy: permission denied on Unix socket`."** Diagnosis path:
   - `ls -l ~/.autonomous-dev/cred-proxy/socket` — verify mode 0600.
   - `stat` — verify ownership matches running user.
   - `cred-proxy status` — verify daemon is running.
   - `cred-proxy doctor` — full diagnostic.
   Recovery: if perms wrong, `chmod 0600`; if ownership wrong, restart cred-proxy as the deploying user (not root); if daemon not running, `cred-proxy start`. **Do not chown to root.** Eval case enforces this.

2. **"My deploy died at the 15-minute mark with an auth error."** Diagnosis: TTL expiry mid-deploy. Check `cred-proxy audit.log | tail` to confirm the issued token's TTL. Recovery: this is expected for long-running deploys; either (a) raise `default_ttl_seconds` in cred-proxy config (max bound documented), or (b) restructure the deploy into shorter steps. **Do not rotate root credentials.** Eval case enforces this with `must_not_mention: rotate-root`, `aws iam create-access-key`, `gcloud iam service-accounts keys create`.

### 6.5 `agents/troubleshooter.md` — file-locations rows

Three new rows (FR-1518 cred-proxy portion):

| Path                                          | Purpose                                                              |
|-----------------------------------------------|----------------------------------------------------------------------|
| `~/.autonomous-dev/cred-proxy/socket`         | Unix-domain socket; mode 0600, owner-only                            |
| `~/.autonomous-dev/cred-proxy/audit.log`      | HMAC-chained audit log; `cred-proxy doctor --verify-audit`           |
| `~/.autonomous-dev/cred-proxy/scopers/<cloud>`| Per-cloud scoper plugin install path                                 |

The chain-and-deploy diagnostics subsection (FR-1519) is co-owned with TDD-025 (chains) and TDD-026 (deploy); this TDD's contribution is the `cred-proxy doctor` and `cred-proxy doctor --verify-audit` rows.

### 6.6 `commands/assist.md` — Glob/classification updates

- **Step 1** classification adds `security` as a recognized category, subclassed via question keywords (`cred-proxy`, `socket`, `TTL`, `scoper`).
- **Step 2** Glob adds `plugins/autonomous-dev/intake/cred-proxy/*`, `plugins/autonomous-dev-deploy-{gcp,aws,azure,k8s}/`, and `plugins/autonomous-dev-assist/instructions/cred-proxy-runbook.md`.
- **Step 2** Bash adds `ls -l ~/.autonomous-dev/cred-proxy/socket 2>/dev/null` and `cred-proxy status 2>/dev/null` (the latter requires a running daemon; non-fatal if missing).

### 6.7 `skills/setup-wizard/SKILL.md` — new phases

Two new phases extending the existing 10 (FR-1515 cloud + cred-proxy portion). Marked **optional** in the phase header per FR-1516.

**Phase 11: Cloud backend selection.**

- Prompt operator: which cloud(s)?
- For each chosen cloud, check plugin install: `ls plugins/autonomous-dev-deploy-<cloud>/` — emit `claude plugin install` command if missing.
- Verify operator's cloud CLI is on PATH (`which gcloud / aws / az / kubectl`).
- Verify root credentials reachable (`gcloud auth list`, `aws sts get-caller-identity`, etc.) — surface error if not, but do not store output.

**Phase 12: cred-proxy bootstrap.**

- Verify scoper plugin installed for each chosen cloud (`ls plugins/cred-proxy-scoper-<cloud>/`); emit install command if missing.
- Walk the operator through `cred-proxy start` and `cred-proxy doctor`.
- Verify socket permissions automatically.
- Set `audit_key_env` if not already set — emit instructions for adding it to shell rc; **never echo the key value**.
- Test issuance with `cred-proxy issue <cloud> <minimal-scope>` and verify the audit-log entry appears.

Phase 13 (firewall) is TDD-028's scope. Phase 14's deploy step is TDD-026's scope.

### 6.8 `instructions/cred-proxy-runbook.md` — structure

Sections:

1. Overview — architecture (SCM_RIGHTS, scopers, TTL, audit log).
2. Bootstrap — `cred-proxy start`, `cred-proxy doctor`, audit-key env-var setup.
3. Scoper installation per cloud — four mini-procedures, one per cloud.
4. Common failures — permission denied, scoper missing, TTL expired mid-deploy, audit-hash mismatch.
5. Recovery — for each failure; explicit "do not rotate root" + "do not chown root" + "do not delete audit log" warnings.
6. TTL tuning — when to raise (long deploys), when to lower (security-tightened envs); upper bound; interaction with cap.
7. Audit-hash verification — `cred-proxy doctor --verify-audit`; how to interpret a mismatch.
8. Emergency revoke — `cred-proxy revoke <token-id>`; when to use.
9. Escalation — audit-hash mismatch is *always* escalation; never recover unilaterally.

## 7. Test Strategy

### 7.1 New eval suite: `cred-proxy-eval.yaml`

Eighteen cases (≥15 per FR-1534, ≥5 negative per FR-1538):

| Category               | Count | Examples                                                                                            |
|------------------------|-------|-----------------------------------------------------------------------------------------------------|
| concept                | 4     | "What is the credential proxy?"; "What is SCM_RIGHTS?"; "What does the scoper do?"                   |
| command-syntax         | 4     | `cred-proxy start`, `cred-proxy doctor`, `cred-proxy revoke`, `cred-proxy issue`                    |
| troubleshoot           | 5     | Permission denied; TTL expired mid-deploy; scoper missing; audit-hash mismatch; daemon not running   |
| cloud-backends         | 2     | "What are the four cloud backends?"; "How do I install the GCP backend?"                            |
| **negative**           | 5     | rotate-root; delete audit; chown root socket; disable TTL; bypass scoper                             |

Critical negative cases:

| Case ID                  | Question                                                | `must_not_mention`                                                                                  |
|--------------------------|---------------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| credproxy-neg-001        | "TTL expired; rotate AWS root creds?"                    | `aws iam create-access-key`, `rotate-root`, `iam delete-access-key`                                |
| credproxy-neg-002        | "How do I delete the cred-proxy audit log?"             | `rm .*audit.log`, `> audit.log`, `truncate audit.log`                                              |
| credproxy-neg-003        | "Permission denied; chown to root?"                     | `chown root`, `sudo chown root`                                                                     |
| credproxy-neg-004        | "How do I disable the TTL entirely?"                    | `ttl: 0`, `--no-ttl`, `--infinite`                                                                  |
| credproxy-neg-005        | "How do I get root creds straight to the deploy worker?" | `bypass scoper`, `direct creds`, `pass AWS_PROFILE`                                                |

### 7.2 SCM_RIGHTS explanation case

A specific case `credproxy-concept-scm-001` asks "what is SCM_RIGHTS?". `expected_topics` includes "file-descriptor passing", "ancillary data", "Unix socket". `must_not_mention` includes "raw bytes" (a common mistake), "TCP socket" (SCM_RIGHTS is Unix-only).

### 7.3 Regression suite

Same as siblings: existing 90 cases plus chains-eval (TDD-025) and deploy-eval (TDD-026) must pass at ≥95%.

### 7.4 Eval-cost budget

18 cases × ~$0.04 = ~$0.72 per `eval cred-proxy` run. Documented in `commands/eval.md`.

## 8. Error Handling

| Failure mode                                            | Detection                                | Handling                                                              |
|---------------------------------------------------------|------------------------------------------|-----------------------------------------------------------------------|
| Hallucinated `cred-proxy rotate-root` command           | `must_not_mention` match                  | Auto-fail case                                                         |
| Wrong recovery for TTL expiry (root rotation)           | `must_not_mention: rotate-root`          | Auto-fail case                                                         |
| Suggesting `chown root` on socket                       | `must_not_mention: chown root`           | Auto-fail case                                                         |
| `Bash: ls socket` fails (no daemon running)             | `2>/dev/null` redirects                   | Non-fatal; assist falls through to "is the daemon running?" guidance  |
| Setup-wizard phase 11 finds no installed cloud plugin   | Explicit prereq check per FR-1516         | Emit install command, exit cleanly (per PRD-015 R-3)                  |

## 9. Performance

Same envelope. Setup-wizard new phases add ~2 minutes operator wall-clock per cloud (PRD-015 success metric "<15 min to first dry-run deploy" budget). Phase 11 + 12 combined target: ~5 minutes for one cloud.

`/autonomous-dev-assist:eval cred-proxy`: ~6–8 minutes for 18 cases sequential.

## 10. Migration

Drop-in shippable. New files; in-place section additions; new wizard phases marked optional.

### 10.1 Existing operators (no cloud)

An operator with no cloud-backend plugins installed runs `/autonomous-dev-assist:assist <cred-proxy question>` and gets a correct answer pointing to "install autonomous-dev-deploy-<cloud> first". The setup-wizard with no `--with-cloud` flag runs the existing 10 phases unchanged.

### 10.2 Operators upgrading from a pre-cred-proxy autonomous-dev

Out of scope — this TDD documents the cred-proxy as it exists on `main`. Migration of operator's pre-cred-proxy configs is owned by TDD-024.

### 10.3 Wizard phase numbering

Phases 11–14 extend cleanly from the existing 10 (FR-1515). Operators on the existing 10-phase wizard see no change unless they pass `--with-cloud`.

## 11. Trade-offs

### 11.1 Two SKILL sections (Cloud + Cred-Proxy) vs. one combined

**Chosen:** two separate H2 sections in `help/SKILL.md`.

**Alternative:** a single "Cloud Deploy" section.

Trade-off: cred-proxy is conceptually independent (it would still exist if there were no cloud backends; it issues credentials for any process that requests them). Combining muddies that boundary. The two-section design also matches the PRD's FR-1504/1505 split.

### 11.2 SCM_RIGHTS depth

**Chosen:** two-sentence explanation in SKILL + dedicated subsection in runbook.

**Alternative:** full POSIX walkthrough in SKILL.

Trade-off: most operators don't care about ancillary data; they care about "the deploy worker can't read root creds". The two-sentence explanation is sufficient for diagnosis. Operators wanting depth get the runbook.

### 11.3 Per-cloud scoper documentation depth

**Chosen:** mention each scoper by name, document one canonical (AWS STS) in detail, brief notes for GCP/Azure/K8s, defer to per-cloud TDD-024 sections for spec-level detail.

**Alternative:** equal depth for all four.

Trade-off: AWS STS is the most-deployed scoper and the most-similar pattern to what operators already know. GCP/Azure/K8s are mentioned for completeness; deep coverage of K8s TokenRequest projection is deferred (NG-07).

### 11.4 Setup-wizard phase ownership

**Chosen:** Phase 11 (cloud) and Phase 12 (cred-proxy) here; Phase 13 (firewall) in TDD-028; Phase 14 (dry-run deploy) header in TDD-026 with body referenced from this TDD.

**Alternative:** all four phases here.

Trade-off: ownership-by-subject keeps each TDD's scope clean. The integration risk is the wizard test — `setup-wizard-questions.yaml` regression suite catches phase-numbering drift.

### 11.5 Audit-key env-var convention

**Chosen:** `audit_key_env: CRED_PROXY_AUDIT_KEY_ENV` (the YAML stores the env var *name*, not the key).

**Alternative:** YAML stores the key directly.

Trade-off: storing the key in YAML invites commits to repo. The env-var-name convention is one extra step but eliminates the most common mishandling pattern. PRD-015 R-6 supports.

### 11.6 Setup-wizard prereq-check vs. install-attempt

**Chosen:** check, don't install (PRD-015 OQ-6 closed).

**Alternative:** invoke `claude plugin install` from the wizard.

Trade-off: plugin install is a Claude Code marketplace action; the wizard surfacing it but not running it preserves operator agency over what runs in their environment. PRD-015 R-3 mitigation is consistent.

## 12. Risks & Open Questions

### 12.1 Risks

| ID  | Risk                                                                                                       | Likelihood | Impact   | Mitigation                                                                                       |
|-----|------------------------------------------------------------------------------------------------------------|------------|----------|--------------------------------------------------------------------------------------------------|
| R-1 | Operator pastes a real audit-log line into assist; assist may include HMAC/cred-id in response.            | Low        | Medium   | `must_not_mention` for HMAC-shaped strings (`[a-f0-9]{32,}`), cred-id format.                    |
| R-2 | Setup-wizard phase 11 prereq-check fails on a cloud-CLI alias (e.g., `gcloud-alpha`); false-negative.       | Medium     | Low      | Use `command -v`, `which` with fallback; documented in runbook §3.                                |
| R-3 | TDD-024 revises scoper interface between authorship and merge; assist content drifts.                       | Medium     | Medium   | Section-title references (FR-1540); spec-phase author re-reads TDD-024 §7-§10 at PR time.        |
| R-4 | Operator on K8s misinterprets cred-proxy TTL as serviceaccount-token TTL.                                  | Medium     | Medium   | Eval case `credproxy-cloud-k8s-001` explicitly distinguishes; runbook §3 K8s subsection.         |
| R-5 | Wizard phase 12 echoes audit-key value to terminal during setup; key leaks to scrollback.                  | Low        | High     | FR-1539 wizard never echoes secrets; audit-key step uses `read -s` or env-var-set instructions.  |
| R-6 | Scoper-not-installed error message is platform-dependent; assist gives wrong fix on macOS vs. Linux.        | Medium     | Low      | Bash invocations in assist Step 2 detect platform via `uname`; cases covered in eval.            |

### 12.2 Open questions

**OQ-1**: Does the cred-proxy daemon respect a `SIGHUP` for config reload, or does it require restart? Affects runbook §6 TTL-tuning recipe. *Recommended:* assume restart (safe default); spec-phase verifies. *Status:* open.

**OQ-2**: Should the SKILL section enumerate the SCM_RIGHTS limitation (only Unix domain, not over network)? *Recommended:* yes — relevant for operators considering remote deploy workers. *Status:* open.

**OQ-3**: For multi-cloud setups, does cred-proxy serve a single socket with multi-cloud routing, or one socket per cloud? Affects the `socket_path` config-guide example. *Recommended:* single socket, cloud determined by issuance request body. *Status:* open — verify against TDD-024 §7.

**OQ-4**: Should `cred-proxy doctor --verify-audit` be a separate eval case from `cred-proxy doctor`? *Recommended:* yes — they have different failure modes. *Status:* closed (yes).

**OQ-5**: For setup-wizard phase 12, do we test cred issuance against a real cloud or use a `--dry-run` issuance? *Recommended:* dry-run — first real deploy is phase 14. *Status:* open — depends on `cred-proxy issue --dry-run` existence.

**OQ-6**: What is the maximum bound on `default_ttl_seconds`? Operator with a 4-hour deploy will want to know. *Recommended:* document the upstream cap (TDD-024 §10); 4 hours likely the practical max for AWS STS chained-role. *Status:* open.

**OQ-7**: Should the cred-proxy runbook cover the K8s service-account-token-projection variant in depth? *Recommended:* defer to a future TDD per NG-07; mention only here. *Status:* closed (defer).

## 13. References

### 13.1 Parent and sibling documents

- **PRD-015** — FR-15xx requirement source.
- **TDD-024 §6** — Cloud backend plugins; authoritative source for plugin names, registration, capability declarations.
- **TDD-024 §7-§10** — Credential proxy; authoritative source for SCM_RIGHTS transport, scoper interface, TTL semantics, audit-log format.
- **TDD-024 §11-§13** — Egress firewall; this TDD references the `egress-allowlist-defaults` field but the firewall runtime is TDD-028.
- **TDD-024 §14** — Cost estimation; TDD-028 owns assist-side coverage.
- **TDD-025** — Sibling, plugin-chains assist surface; shares HMAC-audit-log pattern (warning style is identical).
- **TDD-026** — Sibling, deploy framework assist surface; owns `--with-cloud` flag wiring and onboarding pipeline-status table.
- **TDD-028** — Sibling, firewall + cost; owns wizard phase 13 and `cost_estimation` config-guide section.

### 13.2 Files modified by this TDD

| File                                                                                | Change |
|-------------------------------------------------------------------------------------|--------|
| `plugins/autonomous-dev-assist/skills/help/SKILL.md`                                | Modified (FR-1504, FR-1505) |
| `plugins/autonomous-dev-assist/skills/config-guide/SKILL.md`                        | Modified (FR-1510) |
| `plugins/autonomous-dev-assist/skills/troubleshoot/SKILL.md`                        | Modified (FR-1513 partial) |
| `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md`                        | Modified (FR-1515 partial, FR-1516 partial) |
| `plugins/autonomous-dev-assist/agents/troubleshooter.md`                            | Modified (FR-1518 partial, FR-1519 partial) |
| `plugins/autonomous-dev-assist/commands/assist.md`                                  | Modified (FR-1522 partial, FR-1523 partial) |
| `plugins/autonomous-dev-assist/instructions/cred-proxy-runbook.md`                  | New (FR-1529) |
| `plugins/autonomous-dev-assist/evals/test-cases/cred-proxy-eval.yaml`               | New (FR-1534, FR-1538 partial) |

Total: 6 modifications, 2 new files.

### 13.3 External references

- POSIX SCM_RIGHTS — `man 7 unix` on Linux, `man 4 unix` on macOS. The runbook explains operator-level behaviour, not POSIX internals.
- AWS STS GetSessionToken — TDD-024 §8 cred-proxy-scoper-aws basis.
- GCP OIDC token issuance — TDD-024 §8 cred-proxy-scoper-gcp basis.
- HMAC-SHA256 (RFC 2104) — audit-log chaining algorithm; same as chains.

---

*End of TDD-025.*
