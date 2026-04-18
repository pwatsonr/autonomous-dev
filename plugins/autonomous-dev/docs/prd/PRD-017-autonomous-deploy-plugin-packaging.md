# PRD-017: autonomous-deploy Plugin Packaging & Tier Gating

| Field | Value |
|-------|-------|
| PRD ID | PRD-017 |
| Version | 0.1.0 |
| Date | 2026-04-18 |
| Author | Patrick Watson |
| Status | Draft |
| Plugin | autonomous-deploy (NEW) |

---

## 1. Problem

Deployment capabilities introduced in PRDs 014 through 016 carry a materially different risk and audit profile than the core autonomous-dev plugin. Bundling them forces every user—regardless of role, org policy, or maturity level—to opt into deployment risk simply by installing the core product. A separate `autonomous-deploy` plugin solves this cleanly: org-admins can gate tier activation at the plugin level, the core plugin remains minimal and broadly adoptable, and each surface can evolve independently without cross-cutting breakage.

The split also satisfies security reviewers who require explicit approval workflows before production deployment capabilities are accessible, and it gives the marketplace a distinct installation surface with its own versioning cadence, documentation, and audit record.

---

## 2. Goals

| ID | Goal |
|----|------|
| G-1 | Ship `autonomous-deploy` as a second plugin in the marketplace, independently installable |
| G-2 | Plugin manifest declares a `tier` capability field covering dev, qa, and prod, each with a per-tier enable flag |
| G-3 | The prod tier is gated via an org-admin approval workflow—not DRM, not license enforcement |
| G-4 | Plugin bundles specialist agents: deploy-executor (extended), kubernetes-deploy-executor, aws-deploy-executor, gcp-deploy-executor, onprem-deploy-executor |
| G-5 | Plugin bundles slash commands: `/deploy:status`, `/deploy:promote`, `/deploy:rollback`, `/deploy:kill`, `/deploy:config` |
| G-6 | Plugin depends on PRD-014/015/016 interfaces and never duplicates core config structures |
| G-7 | Plugin is installable standalone (without core) OR in integrated mode alongside core |
| G-8 | Marketplace entry, `plugin.json`, and `.mcp.json` all conform to Claude Code plugin conventions |
| G-9 | Tier approval records store admin identity, timestamp, justification text, and a hash for tamper detection |
| G-10 | Tier enablement UX is compatible with the PRD-024 setup wizard's deployment section |

---

## 3. Non-Goals

| ID | Non-Goal |
|----|----------|
| NG-1 | This is not a license or DRM system; no cryptographic entitlement checks |
| NG-2 | Azure cloud adapter is not in scope for Phase 1 |
| NG-3 | This plugin does not replace or subsume the core autonomous-dev plugin |
| NG-4 | Cloud abstraction logic belongs to PRD-015; this plugin consumes those adapters |
| NG-5 | Plugin hosting infrastructure is out of scope |

---

## 4. Personas

**Org Admin** — Installs and configures the plugin; approves tier activations; owns audit accountability.

**Platform Operator** — Day-to-day deployment operations; uses `/deploy:*` commands; may hold second-approver role for two-person rule.

**Release Engineer** — Triggers deploys through Claude Code sessions; observes status; initiates rollbacks.

**Security Reviewer** — Validates that security review is complete before prod tier is enabled; may hold blocking veto.

**Plugin Maintainer** — Owns versioning, changelog, and schema compatibility across plugin updates.

---

## 5. User Stories

| ID | Story | Priority |
|----|-------|----------|
| US-01 | As an org admin, I can install `autonomous-deploy` from the marketplace with a single command | P0 |
| US-02 | After installation, dev and qa tiers are automatically enabled; prod is disabled by default | P0 |
| US-03 | Running `/deploy:config enable-prod` requires that security review (PRD-022) is marked complete before proceeding | P0 |
| US-04 | Every tier-enable action records the admin identity, UTC timestamp, and justification text in `audit.jsonl` | P0 |
| US-05 | Enabling prod requires a second distinct admin to confirm within 24 hours | P0 |
| US-06 | A kill switch can disable all active deployment operations without requiring a plugin update | P0 |
| US-07 | Specialist agents registered by the plugin are available to the PRD-014 pipeline orchestrator | P0 |
| US-08 | Uninstalling the plugin refuses if a deployment is in flight; `--force` is available with an explicit warning | P0 |
| US-09 | Plugin config is written under the `deployment.*` key space and is accessible to core via the shared config surface | P0 |
| US-10 | A non-admin user attempting to enable the prod tier receives a clear denial with instructions for escalation | P0 |
| US-11 | The marketplace entry displays tier-gate metadata so admins understand what they are installing | P1 |
| US-12 | Plugin follows semver; each release has a changelog entry and a machine-readable version field | P0 |
| US-13 | In standalone mode (core not installed), the plugin provides a minimal self-contained deployment surface | P1 |
| US-14 | Audit events are exportable to JSONL or a structured log target | P1 |
| US-15 | An MCP server bundled with the plugin exposes deploy-specific tools to Claude Code | P1 |
| US-16 | A major version bump triggers a prod tier re-approval flow on next session start | P1 |

---

## 6. Functional Requirements

### 6.1 Marketplace Registration (FR-100s)

**FR-100** The plugin SHALL be added to `.claude-plugin/marketplace.json` as a distinct entry alongside the core plugin and the context-aggregator plugin.

**FR-101** The marketplace category SHALL be `deployment`.

**FR-102** Keywords SHALL include: `deploy`, `canary`, `gitops`, `argocd`, `flux`, `kubernetes`, `aws`, `gcp`.

**FR-103** Marketplace metadata SHALL list the three supported tiers (`dev`, `qa`, `prod`) with a human-readable description of what each tier enables and what approval is required.

**FR-104** The marketplace entry SHALL include a `risk_level` field set to `high` for the `prod` tier, `medium` for `qa`, and `low` for `dev`.

---

### 6.2 Plugin Manifest (FR-200s)

**FR-200** The plugin manifest SHALL exist at `plugins/autonomous-deploy/.claude-plugin/plugin.json` and SHALL include at minimum: `name`, `version` (semver), `description`, `author`, `license`, `keywords`, `min_core_version`, `tier`.

**FR-201** An `.mcp.json` file SHALL be present in the plugin root, declaring MCP server connections for Argo CD, Kubernetes, and Terraform integrations.

**FR-202** The manifest SHALL declare a soft dependency on `autonomous-dev >= 0.2.0`. In integrated mode this version constraint is enforced at install time. In standalone mode it is advisory only.

**FR-203** The `tier` field in `plugin.json` SHALL be an object with keys `dev`, `qa`, `prod`, each containing a `default_enabled` boolean and an `approval_required` boolean. Initial values: dev `{default_enabled: true, approval_required: false}`, qa `{default_enabled: true, approval_required: false}`, prod `{default_enabled: false, approval_required: true}`.

**FR-204** The manifest SHALL declare a `hooks` array listing the lifecycle hooks the plugin registers: `SessionStart`, `PreToolUse`, `Stop`.

---

### 6.3 Bundled Agents (FR-300s)

**FR-300** `deploy-executor` — an extended version of the core deploy-executor that adds plugin-specific state tracking and audit emission. Shares the same agent factory as core to prevent drift.

**FR-301** `kubernetes-deploy-executor` — specialist agent for Kubernetes rollout strategies including rolling update, blue-green, and canary via Argo Rollouts or Flux.

**FR-302** `aws-deploy-executor`, `gcp-deploy-executor`, and `onprem-deploy-executor` — cloud-specific specialist agents that consume PRD-015 adapter interfaces. Each agent registers its supported environment tags so the PRD-014 pipeline orchestrator can route correctly.

**FR-303** `deploy-reviewer` — reads ADRs and applies deployment guardrails defined in PRD-014. Blocks promotes that violate declared constraints.

**FR-304** `migration-safety-reviewer` — evaluates schema-change safety for database migrations accompanying a deploy. Flags destructive migrations and requires explicit override.

**FR-305** All agents SHALL be discoverable via the core agent registry when running in integrated mode. In standalone mode they register with the plugin's local registry.

---

### 6.4 Bundled Commands (FR-400s)

**FR-400** `/deploy:status [--env <name>]` — returns current deployment state for the specified environment or all environments. Reads from live GitOps state when available.

**FR-401** `/deploy:promote --env <target>` — promotes the current artifact to the target environment. Enforces the two-person rule for prod promotes: requester and approver must be distinct identities.

**FR-402** `/deploy:rollback --target <revision|tag>` — initiates a rollback to the specified revision or tag. Logs rollback reason to audit trail. Requires active tier to be enabled for the target environment.

**FR-403** `/deploy:kill [--env <name> | --all]` — immediately halts deployment operations in the specified environment or all environments. Does not require prod approval because it is a safety action.

**FR-404** `/deploy:config` — invokes the PRD-024 wizard deployment section. Supports sub-commands including `enable-prod`, `disable-prod`, `show-audit`, `export-audit`, and `set-approver`.

**FR-405** All commands SHALL be defined in `plugins/autonomous-deploy/.claude-plugin/commands/` following Claude Code command file conventions, with a `description`, `usage`, and `tier_required` field.

---

### 6.5 Tier Gating (FR-500s)

**FR-500** On installation, dev and qa tiers SHALL be enabled automatically with no additional input required.

**FR-501** The prod tier SHALL be disabled by default and SHALL NOT be enabled automatically under any circumstance, including upgrades or reinstalls.

**FR-502** Enabling the prod tier requires ALL of the following conditions to be satisfied before the enable is committed:
  (a) Security review (PRD-022) is marked complete in the shared config surface.
  (b) The requesting user is verified as an org-admin via the identity provider configured in core.
  (c) A justification string of at minimum 100 characters has been provided.
  (d) A second distinct org-admin has confirmed via `/deploy:config enable-prod --confirm` within 24 hours of the initial request.

**FR-503** Every tier enable and disable event SHALL be appended to `audit.jsonl` in the plugin state directory. Each record SHALL include: `event_type`, `tier`, `admin_identity`, `timestamp_utc`, `justification_hash` (SHA-256 of justification text), `confirmer_identity` (for prod), `plugin_version`.

**FR-504** The `deployment.tiers.prod.approved_by` config key SHALL be preserved across plugin updates and SHALL NOT be cleared by a minor or patch version upgrade. A major version upgrade SHALL set a `re_approval_required` flag and prevent prod deployments until re-approval is complete.

**FR-505** A kill switch at `deployment.tiers.prod.kill_switch_active` SHALL, when set to `true`, immediately disable prod deploy operations without requiring a plugin update or session restart.

---

### 6.6 Standalone and Integrated Modes (FR-600s)

**FR-600** On session start, the plugin SHALL detect whether `autonomous-dev` core is installed and set an internal `integration_mode` flag accordingly.

**FR-601** In integrated mode, the plugin SHALL: register all agents with the core agent registry, share the core config surface under the `deployment.*` namespace, and emit lifecycle events to the core event bus.

**FR-602** In standalone mode, the plugin SHALL: maintain its own minimal agent registry, manage its own config file at `~/.config/autonomous-deploy/config.json`, and operate without emitting to any core event bus.

**FR-603** The plugin SHALL surface a `MODE` environment variable or config key that operators can use to explicitly force one mode over the detected default.

---

### 6.7 Shared Config Surface (FR-700s)

**FR-700** The plugin SHALL read and write exclusively under the `deployment.*` key namespace. It SHALL NOT modify any key outside this namespace.

**FR-701** The plugin SHALL NOT duplicate config keys that are owned by core (e.g., `project.*`, `agents.*`, `sessions.*`). It reads those keys but never writes them.

**FR-702** The plugin SHALL contribute a JSON Schema fragment for the `deployment.*` namespace to the PRD-024 wizard section registry so the wizard can render and validate deployment config interactively.

**FR-703** Config migrations between plugin versions SHALL be additive only for minor and patch versions. Breaking config changes require a major version bump and a documented migration path.

---

### 6.8 MCP Servers (FR-800s)

**FR-800** The plugin SHALL bundle or declare an MCP server that exposes the following tools to Claude Code: `list_environments`, `get_deployment_status`, `propose_canary`, `check_slo_budget`, `get_runbook`.

**FR-801** The MCP server SHALL auto-register with Claude Code when the plugin is enabled, using the connection definition in `.mcp.json`.

**FR-802** MCP tools that perform write operations (e.g., `propose_canary`) SHALL enforce tier-gate checks before executing. A call targeting a disabled tier SHALL return a structured error with a resolution hint.

**FR-803** MCP server responses SHALL include an `audit_ref` field containing a UUID that links the tool invocation to the corresponding `audit.jsonl` record.

---

### 6.9 Installation and Updates (FR-900s)

**FR-900** The plugin SHALL be installable via `claude plugin install autonomous-deploy`. The install command SHALL complete within 30 seconds on a standard connection.

**FR-901** Plugin versioning SHALL follow strict semver. The CHANGELOG SHALL be machine-readable (Keep a Changelog format). A major version bump SHALL trigger prod tier re-approval on next session start.

**FR-902** Uninstall (`claude plugin uninstall autonomous-deploy`) SHALL refuse if any deployment tracked in plugin state is currently in an active or pending state. The `--force` flag SHALL override with an explicit acknowledgment prompt and SHALL record the forced uninstall in `audit.jsonl`.

**FR-903** Plugin updates SHALL preserve all `deployment.tiers.*` config keys and all `audit.jsonl` records. They SHALL NOT wipe state as part of a normal upgrade.

---

### 6.10 Lifecycle Hooks (FR-1000s)

**FR-1000** The `SessionStart` hook SHALL load and validate deploy config, set `integration_mode`, check for pending re-approval requirements, and surface any blocking conditions to the user before the session proceeds.

**FR-1001** The `PreToolUse` hook SHALL intercept any tool invocation whose declared `tier_required` field matches a tier that is currently disabled, and SHALL return a structured denial before the tool executes. This applies to both plugin-native tools and MCP tools.

**FR-1002** The `Stop` hook SHALL append a session-end record to `audit.jsonl` capturing the session duration, the list of deploy-related tool invocations, and whether any in-flight deployments remain active.

---

## 7. Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NFR-01 | Plugin install completes in under 30 seconds on a standard broadband connection |
| NFR-02 | The interactive prod tier-enable flow, including second-admin confirmation prompt, completes in under 2 minutes of wall-clock interaction time |
| NFR-03 | Zero silent prod tier enablements — every activation must produce a visible audit record and user-facing confirmation |
| NFR-04 | Every deploy-related tool invocation is audit-logged; gaps in the audit trail are treated as integrity failures |
| NFR-05 | `plugin.json` schema conforms to the Claude Code plugin manifest specification without extensions |
| NFR-06 | MCP tool response p95 latency is under 200 milliseconds for read-only tools under normal load |
| NFR-07 | Minor and patch version upgrades maintain backwards compatibility for all config keys and command signatures |
| NFR-08 | Plugin documentation (usage, tier gating flow, command reference) is bundled within the plugin and accessible offline |
| NFR-09 | Installed plugin footprint is under 50 MB including all bundled agent definitions and MCP server code |
| NFR-10 | A major version bump triggers mandatory prod tier re-approval before prod deploys are permitted |

---

## 8. Architecture

```
Claude Code
    │
    ▼
autonomous-deploy plugin
 ├── .claude-plugin/
 │    ├── plugin.json          (manifest, tier field, hooks)
 │    ├── marketplace.json     (category, keywords, tier metadata)
 │    └── .mcp.json            (Argo CD, K8s, Terraform MCP connections)
 ├── commands/
 │    ├── deploy-status.md
 │    ├── deploy-promote.md
 │    ├── deploy-rollback.md
 │    ├── deploy-kill.md
 │    └── deploy-config.md
 ├── agents/
 │    ├── deploy-executor/
 │    ├── kubernetes-deploy-executor/
 │    ├── aws-deploy-executor/
 │    ├── gcp-deploy-executor/
 │    ├── onprem-deploy-executor/
 │    ├── deploy-reviewer/
 │    └── migration-safety-reviewer/
 ├── mcp-server/              (list_environments, get_deployment_status,
 │                             propose_canary, check_slo_budget, get_runbook)
 ├── hooks/
 │    ├── session-start.js
 │    ├── pre-tool-use.js
 │    └── stop.js
 └── state/
      ├── audit.jsonl
      └── tier-config.json

         │
         ▼ (integrated mode)
 autonomous-dev core
  └── agent registry + shared config surface
         │
         ▼
 deployment.tiers.* config
  ├── dev  (default: enabled)
  ├── qa   (default: enabled)
  └── prod (default: disabled, approval required)
         │
         ▼
 PRD-014 pipeline orchestrator
         │
         ▼
 PRD-015 cloud adapters (K8s / AWS / GCP / on-prem)
         │
         ▼
 GitOps repository → target infrastructure
```

**Config Key Ownership**

The plugin owns the `deployment.*` namespace exclusively. Core owns `project.*`, `agents.*`, and `sessions.*`. The plugin reads but never writes outside its namespace. The PRD-024 wizard section registry mediates access.

**Audit Chain**

Every tier-enable event, tool invocation, and session-end record is appended to `audit.jsonl`. Records include a `prev_hash` field linking each record to its predecessor. Gaps or hash mismatches are detected by the `Stop` hook and flagged as integrity violations.

---

## 9. Testing Strategy

| Area | Tests |
|------|-------|
| Marketplace | Install smoke test; verify category, keywords, tier metadata present |
| Standalone mode | Install without core; verify self-contained operation; verify config isolation |
| Integrated mode | Install alongside core >= 0.2.0; verify agent registration; verify shared config access |
| Prod tier gate | Negative: non-admin denied; single-admin denied without confirmer; justification < 100 chars rejected; security review not complete rejected |
| Prod tier gate | Positive: full flow with two admins, complete security review, valid justification |
| Two-person rule | Confirmer identity must differ from requester; 24h window enforced; expired window requires restart |
| Audit integrity | Verify hash chain on each record; inject a tampered record; verify detection |
| MCP contract | Each MCP tool returns expected schema; write tools enforce tier gate; `audit_ref` present |
| Uninstall safety | Attempt uninstall with active deploy; verify refusal; verify `--force` with acknowledgment |
| Version upgrade | Minor upgrade preserves config and audit; major upgrade sets re-approval flag |
| Kill switch | Set `deployment.tiers.prod.kill_switch_active = true`; verify immediate halt without restart |

---

## 10. Migration and Rollout

**Phase 1 — Weeks 1 through 2: Foundation**
Plugin scaffold with `plugin.json`, marketplace entry, and `.mcp.json` stubs. Dev and qa tiers enabled. Core `deploy-executor` extended and bundled. Command file stubs for all five `/deploy:*` commands with no-op implementations. Lifecycle hooks registered. Standalone mode functional.

**Phase 2 — Weeks 3 through 5: Prod Tier Gate**
Prod tier gate implemented end-to-end including identity check, security review gate, 100-char justification, two-person confirmation, 24h window enforcement, and hash-chained `audit.jsonl`. `/deploy:config enable-prod` fully functional. Kill switch operational. Audit export via `/deploy:config export-audit`. Integration with PRD-022 security review status. PRD-024 wizard section contributed.

**Phase 3 — Weeks 6 through 8: Cloud Specialists and Full Integration**
`kubernetes-deploy-executor`, `aws-deploy-executor`, `gcp-deploy-executor`, `onprem-deploy-executor` agents implemented and routing registered with PRD-014 pipeline. `migration-safety-reviewer` agent implemented. Full MCP server with all five tools. `/deploy:promote` two-person rule enforced for prod. Major-version re-approval flow. Load and latency testing against NFR-01/NFR-02/NFR-06.

---

## 11. Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|----|------|------------|--------|------------|
| R-1 | Tier gate bypassed via direct config file tamper | Medium | Critical | Hash-chained audit records detect tampering; `PreToolUse` hook validates tier state at invocation time |
| R-2 | Plugin split increases support surface complexity | Medium | Medium | Shared documentation site; core and plugin reference each other; unified issue tracker |
| R-3 | Version skew between autonomous-deploy and autonomous-dev core | Medium | High | Manifest soft-dependency enforced at install; session start warns on skew |
| R-4 | Organizational pressure to enable prod before security review is complete | High | Critical | Hard gate; cannot be bypassed by config; requires PRD-022 status field to be set externally |
| R-5 | Standalone mode config conflicts with later core installation | Low | Medium | Namespace isolation under `deployment.*`; migration utility on core install |
| R-6 | Plugin update inadvertently breaks core integration | Medium | High | Schema compatibility tests in CI; minor/patch versions are additive only |
| R-7 | MCP server exposes sensitive deploy operations to unintended callers | Low | High | MCP tools are registered as `trusted-only`; tier gate enforced on write tools |
| R-8 | Orphaned deployment state after forced uninstall | Low | Medium | `--force` uninstall writes cleanup record to audit; cleanup command available post-uninstall |
| R-9 | Plugin is invisible in marketplace due to category or keyword mismatch | Low | Low | Category `deployment` is explicit; keywords cover primary search terms |
| R-10 | Social engineering of an org admin to approve prod without genuine review | Medium | Critical | Justification text + identity + second-admin confirmation creates a three-factor barrier |
| R-11 | Two-person 24h confirmation window creates operational bottleneck | High | Medium | Window can be reviewed in OQ-1; escalation path documented |
| R-12 | Specialist agents diverge from core deploy-executor over time | Medium | Medium | Shared agent factory; integration tests compare behavior across agents |

---

## 12. Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Prod tier enables with complete security review | 100% | Audit log cross-reference with PRD-022 status |
| Unauthorized prod tier activations over 12 months | 0 | Audit log review |
| Plugin install success rate | > 99% | Marketplace telemetry |
| Prod tier-enable flow completion rate (when attempted) | >= 90% | Funnel telemetry through wizard |
| Audit trail integrity (no gaps or hash failures) | 100% | Automated integrity check on session start |
| Uninstall-during-active-deploy incidents | 0 | Incident tracker |
| MCP tool p95 latency (read-only tools) | < 200ms | MCP server metrics |

---

## 13. Open Questions

| ID | Question | Owner |
|----|----------|-------|
| OQ-1 | Is the 24-hour window for second-admin confirmation appropriate for all org sizes? Some large orgs may have longer approval cycles. Should this be configurable? | Patrick Watson |
| OQ-2 | Should `migration-safety-reviewer` live in the core plugin or in autonomous-deploy? It is useful without deployment context. | TBD |
| OQ-3 | What is the intended versioning cadence for autonomous-deploy relative to core? Should they share a release cycle? | Plugin Maintainer |
| OQ-4 | Should the core dependency be a hard requirement (fails to install without core) or remain soft (degrades to standalone)? | Platform Operator |
| OQ-5 | Should dev and qa tiers also require explicit enable actions, or is default-enabled the right posture for all non-prod tiers? | Security Reviewer |
| OQ-6 | Should cloud specialists be packaged as sub-plugins or remain bundled agents? Sub-plugins would allow independent updates but add install complexity. | Platform Operator |

---

## 14. References

**Internal PRDs**
- PRD-014: Autonomous Deploy Pipeline
- PRD-015: Cloud Adapter Interfaces
- PRD-016: GitOps Integration
- PRD-018: Deploy Observability
- PRD-020: Rollback Safety Framework
- PRD-022: Security Review Gate
- PRD-024: Setup Wizard and Config Surface

**External References**
- Claude Code Plugin Marketplace Documentation: https://code.claude.com/docs/en/plugin-marketplaces
- Official Claude Plugins Repository: https://github.com/anthropics/claude-plugins-official
- Argo CD: https://argoproj.github.io/
- Model Context Protocol: https://modelcontextprotocol.io

---

**END PRD-017**
