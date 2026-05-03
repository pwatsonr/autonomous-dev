# PLAN-027-1: Troubleshooter Agent Extensions (Chains / Deploy / Cred-Proxy / Firewall)

## Metadata
- **Parent TDD**: TDD-027-assist-agents-wizard-handoff
- **Estimated effort**: 3 days
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P1

## Objective
Bring the `autonomous-dev-assist` troubleshooter agent to parity with the six capability streams that landed between TDD-019 and `main` (chains, deploy, cred-proxy, firewall, cost-cap ledger, audit log). This plan extends `agents/troubleshooter.md` per TDD-027 §5.1 with 9 new file-locations rows, 4 new diagnostic-procedure subsections (Chain / Deploy / Credential-Proxy / Firewall), and 4 new tool-allowlist entries; and adds ≥6 troubleshooter eval cases to `troubleshoot-scenarios.yaml` per TDD-027 §7.1. All changes are append-only per the agent-prompt extension pattern (TDD-027 §4.2 / G-08). Onboarding-agent extensions and the setup-wizard phase-16 boundary contract are handled by PLAN-027-2.

## Scope

### In Scope
- `agents/troubleshooter.md` file-locations table additions per TDD-027 §5.1.1: 9 rows covering `~/.autonomous-dev/chains/audit.log`, `chains/manifest.lock`, `deploy/plans/`, `deploy/ledger.json`, `deploy/logs/`, `cred-proxy/socket`, `cred-proxy/audit.log`, `firewall/allowlist`, `firewall/denied.log`. Append after the existing `~/.config/systemd/user/autonomous-dev.service` row. Column schema unchanged.
- `agents/troubleshooter.md` diagnostic-procedure subsections per TDD-027 §5.1.2 (4 new H4 subsections appended after "Configuration Issues"):
  - **Chain Diagnostics** — `chains list`, `chains graph`, `chains audit verify` (HMAC mismatch handling: do NOT delete audit log), cycle detection, `chains approve/reject`
  - **Deploy Diagnostics** — `deploy backends list`, plan inspection, ledger inspection (do NOT hand-edit; use `deploy ledger reset --env`), `deploy logs`, approval-state enumeration, prod-always-requires-approval reminder
  - **Credential-Proxy Diagnostics** — `cred-proxy doctor`, socket-permissions check (`stat`, must be `0600`), TTL-expired re-bootstrap (do NOT rotate root creds), pointer to `cred-proxy-runbook.md`
  - **Firewall Diagnostics** — `firewall test`, `denied.log` tailing, allowlist inspection, DNS-refresh-lag handling, pointer to `firewall-runbook.md`
- `agents/troubleshooter.md` frontmatter `tools` allowlist additions per TDD-027 §5.1.3: append `Bash(chains *)`, `Bash(deploy *)`, `Bash(cred-proxy *)`, `Bash(firewall *)`. No removals; no other changes.
- ≥6 troubleshooter eval cases appended to `plugins/autonomous-dev-assist/evals/test-cases/troubleshoot-scenarios.yaml` per TDD-027 §7.1: `tshoot-chains-001`, `tshoot-deploy-001`, `tshoot-deploy-002`, `tshoot-credp-001`, `tshoot-firewall-001`, `tshoot-credp-002`. Each case includes `must_mention` and `must_not_mention` lists matching the TDD §7.1 table.
- Reviewer-pattern verification: a static check (script or manual diff) confirms append-only semantics — no existing rows reordered, no existing H2/H4 sections moved, no tool-allowlist entries removed. The check runs locally before commit; long-term enforcement lives in the standards-meta-reviewer (TDD-020 / PLAN-021-3).

### Out of Scope
- `agents/onboarding.md` extensions (pause-state subsection, first-cloud-deploy appendix) — PLAN-027-2
- `skills/setup-wizard/SKILL.md` phase-16 boundary marker — PLAN-027-2
- `instructions/cloud-prompt-tree.md` authoring — PLAN-027-2
- `onboarding-questions.yaml` suite activation and ≥4 onboarding eval cases — PLAN-027-2
- Setup-wizard phase-16 runtime (plugin-presence check, branch routing, fail-closed handler) — TDD-033 / its plans
- SKILL.md content for chains, deploy, cloud, cred-proxy, firewall — TDD-025 / TDD-026 plans
- `chains-runbook.md` / `deploy-runbook.md` / `cred-proxy-runbook.md` / `firewall-runbook.md` instruction documents — owned by TDD-025 / TDD-026
- Adding new agents (NG-04 in TDD-027): the assist plugin still has exactly two agents
- Modifying any pre-TDD-022 diagnostic subsection ("Daemon Not Starting", "Cost Problems", etc.)

## Tasks

1. **Extend troubleshooter file-locations table (9 new rows)** — Append the 9 rows from TDD-027 §5.1.1 verbatim after the existing `~/.config/systemd/user/autonomous-dev.service` row. Preserve column schema (File / Directory | Purpose). Each Purpose cell cites the source TDD anchor (e.g., "TDD-022 §13", "TDD-024 §8") per TDD-027's anchor convention.
   - Files to modify: `plugins/autonomous-dev-assist/agents/troubleshooter.md`
   - Acceptance criteria: Existing 15 rows unchanged in order and content. 9 new rows appended in the order specified by TDD-027 §5.1.1. Each new row references a TDD anchor for its source. Markdown table renders without column-count mismatch. `git diff` shows insertions only (no row deletions / reorderings).
   - Estimated effort: 1.5h

2. **Append Chain Diagnostics subsection** — Append a new `#### Chain Diagnostics` H4 subsection after "Configuration Issues" with the 5 numbered steps from TDD-027 §5.1.2 (chain list / graph / audit verify / cycle detection / approval pending). Includes the explicit "DO NOT delete the audit log" warning required by TDD-027 §8.1 and tested by eval case `tshoot-chains-001`.
   - Files to modify: `plugins/autonomous-dev-assist/agents/troubleshooter.md`
   - Acceptance criteria: New H4 subsection inserted in document order after "Configuration Issues" and before any subsequent existing subsection (e.g., "Emergency Procedures"). All 5 numbered steps present. The "DO NOT delete" mandatory text appears verbatim. Pointer to `chains-runbook.md` §3 (TDD-026 ownership) is present.
   - Estimated effort: 1h

3. **Append Deploy Diagnostics subsection** — Append `#### Deploy Diagnostics` H4 with 6 numbered steps per TDD-027 §5.1.2, including the approval-state enumeration (`pending`, `awaiting-approval`, `approved`, `rejected`, `executing`, `completed`, `failed`) and the prod-always-requires-approval reminder citing TDD-023 §11. Includes "do NOT hand-edit" mandatory text for the ledger.
   - Files to modify: `plugins/autonomous-dev-assist/agents/troubleshooter.md`
   - Acceptance criteria: All 6 numbered steps present in order. All 7 approval-state values listed. Prod-approval reminder cites TDD-023 §11. "do NOT hand-edit" mandatory text appears for the ledger and is matched by eval case `tshoot-deploy-002`.
   - Estimated effort: 1h

4. **Append Credential-Proxy Diagnostics subsection** — Append `#### Credential-Proxy Diagnostics` H4 with 4 numbered steps per TDD-027 §5.1.2: `cred-proxy doctor`, socket-permission check, TTL-expired re-bootstrap, runbook pointer. Includes "do NOT rotate root credentials" mandatory text matched by eval `tshoot-credp-002`.
   - Files to modify: `plugins/autonomous-dev-assist/agents/troubleshooter.md`
   - Acceptance criteria: All 4 numbered steps present. The `0600` socket-permission requirement is explicit. The "do NOT rotate root credentials" warning is verbatim. Pointer to `cred-proxy-runbook.md` (TDD-025 ownership) is present.
   - Estimated effort: 0.5h

5. **Append Firewall Diagnostics subsection** — Append `#### Firewall Diagnostics` H4 with 5 numbered steps per TDD-027 §5.1.2: `firewall test`, denied-log inspection, allowlist inspection, DNS-refresh-lag handling, runbook pointer. Includes the default 60s refresh interval and `firewall refresh-dns` workaround.
   - Files to modify: `plugins/autonomous-dev-assist/agents/troubleshooter.md`
   - Acceptance criteria: All 5 numbered steps present. Default 60s refresh interval mentioned. Pointer to `firewall-runbook.md` (TDD-025 ownership) is present.
   - Estimated effort: 0.5h

6. **Extend frontmatter tool allowlist** — Append `Bash(chains *)`, `Bash(deploy *)`, `Bash(cred-proxy *)`, `Bash(firewall *)` to the agent's frontmatter `tools:` list per TDD-027 §5.1.3. Preserve all existing entries (`Read`, `Glob`, `Grep`, `Bash(cat *)`, `Bash(jq *)`, `Bash(ls *)`, `Bash(head *)`, `Bash(tail *)`, `Bash(wc *)`, `Bash(find *)`, `Bash(stat *)`, `Bash(git *)`) in their existing order. Principle of least privilege: NO blanket `Bash(*)` (per TDD-027 OQ-1 closed answer).
   - Files to modify: `plugins/autonomous-dev-assist/agents/troubleshooter.md`
   - Acceptance criteria: Frontmatter parses as valid YAML. Existing tool entries unchanged. 4 new entries appended in the order specified. No `Bash(*)` wildcard. `git diff` shows additions only.
   - Estimated effort: 0.5h

7. **Author 6 troubleshooter eval cases** — Append 6 cases to `plugins/autonomous-dev-assist/evals/test-cases/troubleshoot-scenarios.yaml` per TDD-027 §7.1, using the existing schema shared with TDD-026 / TDD-028 (FR-1536). Each case includes `id`, `difficulty`, `question`, `must_mention[]`, `must_not_mention[]`. Cases: `tshoot-chains-001` (HMAC mismatch), `tshoot-deploy-001` (awaiting-approval), `tshoot-deploy-002` (cost-cap-tripped), `tshoot-credp-001` (socket permission), `tshoot-firewall-001` (denied request), `tshoot-credp-002` (TTL expired mid-deploy).
   - Files to modify: `plugins/autonomous-dev-assist/evals/test-cases/troubleshoot-scenarios.yaml`
   - Acceptance criteria: 6 new cases append to the file (existing cases unchanged). Each case's `must_mention` matches the TDD-027 §7.1 table verbatim (e.g., `tshoot-chains-001` mentions `chains audit` and `do NOT delete`). Each case's `must_not_mention` matches verbatim (e.g., `tshoot-chains-001` forbids `rm.*audit.log`, `chains rotate-key`). YAML validates against the existing eval-case schema.
   - Estimated effort: 2h

8. **Append-only verification (local)** — Run a local diff check confirming all changes follow the agent-prompt extension pattern from TDD-027 §4.2: no existing rows reordered, no existing H2 or H4 sections reordered, no allowlist entries removed, frontmatter `name`/`description` unchanged. Output a one-line summary suitable for the PR description.
   - Files to create: none (validation-only step)
   - Acceptance criteria: `git diff main -- plugins/autonomous-dev-assist/agents/troubleshooter.md` shows only insertions (`+` lines) within the file body, with no reordering of preserved sections. Frontmatter `name` and `description` keys are byte-identical to `main`. The verification result is recorded in the PR description.
   - Estimated effort: 0.5h

9. **Smoke-run the new eval cases (manual)** — Run the 6 new troubleshooter cases against the updated agent prompt via the existing assist eval runner (PLAN-017-3). Spot-check that the agent's responses satisfy `must_mention` and avoid `must_not_mention` for at least 5 of 6 cases (≥83% pass on this micro-sample). Failing cases are noted as risks but do not block merge — the regression baseline is set by PLAN-017-3 / TDD-028.
   - Files to create: none (smoke run only); results captured in the PR body
   - Acceptance criteria: 5 of 6 cases pass on first run, OR failing cases are documented with prompt-tuning notes for follow-up. Existing 84+ troubleshoot cases continue to pass (no regression).
   - Estimated effort: 1h

## Dependencies & Integration Points

**Exposes to other plans:**
- The extended `troubleshooter.md` is the agent surface that operators reach via `/autonomous-dev-assist:troubleshooter`. Its file-locations table and diagnostic procedures are referenced by `instructions/chains-runbook.md`, `instructions/deploy-runbook.md`, `instructions/cred-proxy-runbook.md`, `instructions/firewall-runbook.md` (owned by TDD-025 / TDD-026 plans).
- The 6 new eval cases extend the regression baseline that PLAN-017-3's assist-evals workflow gates on (per FR-1538).
- The agent-prompt extension pattern documented in TDD-027 §4.2 / G-08 is exercised here first; future TDDs reuse the same pattern.

**Consumes from other plans:**
- TDD-022 / its plans: `chains` CLI surface (`chains list`, `chains graph`, `chains audit verify`, `chains approve`).
- TDD-023 / its plans: `deploy` CLI surface (`deploy backends list`, `deploy logs`, `deploy ledger reset`, approval-state enum), ledger format (`~/.autonomous-dev/deploy/ledger.json`).
- TDD-024 / its plans: `cred-proxy` CLI (`cred-proxy doctor`, `cred-proxy bootstrap`), `firewall` CLI (`firewall test`, `firewall refresh-dns`), socket-permission contract (`0600`), allowlist / denied-log paths.
- TDD-020 / PLAN-021-3 (standards-meta-reviewer): performs the long-term append-only diff check on the agent prompt.
- PLAN-017-3 (assist-evals workflow): runs the full troubleshoot-scenarios suite (existing 84+ plus the 6 new) on PR + nightly cron.

## Testing Strategy

- **Static / structural validation (task 8):** `git diff` confirms append-only semantics on `troubleshooter.md` and `troubleshoot-scenarios.yaml`. Frontmatter `name` / `description` byte-identical to `main`. No section reordering.
- **YAML-schema validation:** `troubleshoot-scenarios.yaml` validates against the existing eval-case schema after the 6 cases are appended. Required keys (`id`, `question`, `must_mention`, `must_not_mention`) present on every new case.
- **Eval suite smoke (task 9):** Run the 6 new cases manually via PLAN-017-3's runner; expect ≥5/6 pass, with any failures triaged.
- **Regression:** All existing troubleshoot-scenarios cases continue to pass (≥95% threshold per PLAN-017-3's gate).
- **Manual review:** A reviewer reads the new H4 subsections aloud and confirms each mandatory "do NOT" warning is present and worded as TDD-027 specifies.
- **Pre-merge meta-review:** Run the standards-meta-reviewer (PLAN-021-3) against the agent diff to verify the append-only pattern from TDD-027 §4.2 / G-08.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| A subtle reordering of existing H2/H4 sections sneaks in during edits, breaking the append-only contract | Medium | High — eval regressions, meta-reviewer auto-fail | Task 8's local diff check runs before commit; standards-meta-reviewer enforces in CI; reviewer eyeballs the rendered table-of-contents. |
| New diagnostic subsections inflate the troubleshooter prompt past a soft token budget, slowing first-token latency | Low | Low — TDD-027 §8.3 budgets +800 tokens, well within headroom | The added content is ~70 lines / ~800 tokens; verified against TDD-027's per-call budget. If observed latency drifts, future TDD can split the agent into role-scoped sub-prompts. |
| A "do NOT" warning is rephrased and an eval case's `must_mention` no longer matches, producing a false fail | Medium | Medium — eval gate flaps | Tasks 2–5 quote the warnings verbatim from TDD-027 §5.1.2; eval `must_mention` strings are taken from the same TDD §7.1 table; both rooted in the same source means edits propagate together. |
| Tool-allowlist additions allow an unintended command surface (e.g., `Bash(deploy *)` invokes a not-yet-shipped subcommand) | Low | Medium — agent reports a misleading error | Allowlists are append-only and scoped per command name; principle-of-least-privilege per TDD-027 §8.1 / OQ-1; standards-meta-reviewer audits the diff. |
| The 6 new eval cases are too brittle (depend on exact prompt phrasing) and regress when TDD-026 plans tune wording | Medium | Medium — eval flaps without behavior change | `must_mention` / `must_not_mention` use substring matching, not exact strings; cases pin to capability anchors (e.g., `chains audit`, `deploy approve`) that TDD-026 plans cannot move without coordination. |
| `cred-proxy` or `firewall` CLI surface drifts before TDD-025 plans land, leaving the troubleshooter pointing at non-existent commands | Low | Low — operators see "command not found", recover via runbook | The troubleshooter content is forward-compatible: every new diagnostic includes a runbook pointer, so operators have a fallback even if the CLI is missing. Coordination via TDD-027 §15-style cross-references. |

## Definition of Done

- [ ] 9 new file-locations rows present in `agents/troubleshooter.md`, appended in order, schema unchanged
- [ ] 4 new diagnostic-procedure H4 subsections (Chain / Deploy / Credential-Proxy / Firewall) appended after "Configuration Issues"
- [ ] All 4 mandatory "do NOT" warnings present verbatim (audit-log delete, ledger hand-edit, root-credential rotate, firewall disable-all suppression in eval forbid-list)
- [ ] 4 new tool-allowlist entries (`Bash(chains *)`, `Bash(deploy *)`, `Bash(cred-proxy *)`, `Bash(firewall *)`) appended; existing entries unchanged
- [ ] No blanket `Bash(*)` granted (TDD-027 OQ-1)
- [ ] 6 new eval cases appended to `troubleshoot-scenarios.yaml` matching TDD-027 §7.1 ids and content
- [ ] Append-only verification (task 8) passes locally and is recorded in the PR description
- [ ] Smoke run of the 6 new cases (task 9) passes ≥5/6, or failures triaged
- [ ] Existing troubleshoot-scenarios suite continues to pass (no regression)
- [ ] Frontmatter `name` and `description` byte-identical to `main`
- [ ] PR description cross-links TDD-027 §5.1, §7.1, §8.1
