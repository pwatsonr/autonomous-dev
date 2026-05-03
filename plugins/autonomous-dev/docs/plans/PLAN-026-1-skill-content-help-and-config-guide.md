# PLAN-026-1: Skill Content Updates -- help/SKILL.md and config-guide/SKILL.md

## Metadata
- **Parent TDD**: TDD-026-assist-chains-deploy-cli-surfaces
- **Estimated effort**: 2.5 days
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P1

## Objective
Land the operator-facing reference surface for plugin chains and the deploy framework in the two SKILL.md files that the assist command loads first. This plan delivers the `## Plugin Chains` and `## Deploy Framework` top-level sections in `help/SKILL.md` (FR-1502, FR-1503) and the new `chains` and `deploy` configuration sections in `config-guide/SKILL.md` (FR-1510, FR-1511). Both SKILL files are operator quick-reference, not deep-dive: each H3 subsection stays at or below the line budget specified in TDD-026 §5 so the assist's `Read` step latency target (§13) is preserved. This plan does NOT touch the assist command surface, the runbooks, or the eval suite -- those are PLAN-026-2 and PLAN-026-3 respectively.

## Scope
### In Scope
- `## Plugin Chains` section in `plugins/autonomous-dev-assist/skills/help/SKILL.md` per TDD-026 §5.1, with six H3 subsections: `### What chains are`, `### The four chain commands`, `### The audit log`, `### Manifest-v2 fields`, `### When chains pause`, `### See also`. Each subsection is ≤30 lines and opens with the `*Topic:* chains` marker per the SKILL.md section contract (TDD-026 §11.3).
- `## Deploy Framework` section in `help/SKILL.md` per TDD-026 §5.2, with seven H3 subsections covering the seven deploy commands, the five-state approval state machine including the **prod-always-approval rule with explicit warning** (TDD-023 §11), the cost-cap ledger with the **"do not edit by hand"** warning, the HealthMonitor pointer, and the stall-causes table.
- New section `## Section 19: chains` in `plugins/autonomous-dev-assist/skills/config-guide/SKILL.md` per TDD-026 §5.3. Renumbers existing sections 19/20 to 20/21. Includes the four-parameter table (`enabled`, `audit.key_env`, `audit.log_path`, `approval.required_for_prod_egress`), worked manifest-v2 example, and the HMAC-key custody guidance (env var only, no rotation command, "rotation is TDD-022 OQ-3 future work").
- New section `## Section 20: deploy` in `config-guide/SKILL.md` per TDD-026 §5.4. Includes the schema reference link to TDD-023 §9 (`deploy-config-v1`), a worked `deploy.yaml` example covering staging + prod with `is_prod: true`, the approval-rules table (per trust level × per `is_prod` flag), and the cost-cap interaction note.
- Cross-link "See also" blocks at the end of every new section per the FR-1541 contract (TDD-026 §4.4): each block names the corresponding runbook section AND at least one upstream TDD § anchor.
- Anchor-convention compliance per TDD-026 §8: every cross-reference uses `TDD-NNN §M Section-Title` form. No SHA pinning. The reviewer-agent regex `(commit\s+[a-f0-9]{7,40}|as of [a-f0-9]{7,40}|fixed in [a-f0-9]{7,40})` finds zero hits in the new content.
- The classifier keyword bag from TDD-026 §4.2 is **referenced but not authored here** -- the keyword bag itself lives in `commands/assist.md` (PLAN-026-2). This plan's SKILL sections use the same keywords inline so `Grep` discovery from the classifier resolves into the right SKILL section.
- markdownlint compliance for the two modified SKILL files (existing repo config; no new rules).
- A doc-only smoke test that re-renders `help/SKILL.md` and `config-guide/SKILL.md` line counts and confirms the new sections exist and contain the required `*Topic:*` markers.

### Out of Scope
- `commands/assist.md` Step-1 classifier and Step-2 Glob expansion -- PLAN-026-2.
- `commands/quickstart.md` `--with-cloud` flag -- PLAN-026-2.
- `instructions/chains-runbook.md` and `instructions/deploy-runbook.md` -- PLAN-026-2 and PLAN-026-3.
- `instructions/runbook.md` "See also" index update -- PLAN-026-3 (lands with the deploy runbook so all four cross-links resolve in one commit).
- `evals/test-cases/chains-eval.yaml` and `deploy-eval.yaml` -- PLAN-026-3.
- Cloud-backend-plugin SKILL content (`autonomous-dev-deploy-{gcp,aws,azure,k8s}`) -- TDD-025 (out of TDD-026 scope per TDD-026 NG-02).
- Setup-wizard `--with-cloud` extension content -- TDD-027 (TDD-026 §6.3 only adds the entry-point, owned by PLAN-026-2).
- `commands/deploy-doctor.md` -- deferred per PRD-015 NG-02 / TDD-026 OQ-1.
- Troubleshooter file-locations table extension -- TDD-027 (TDD-026 NG-04).

## Tasks

1. **Read `help/SKILL.md` baseline and identify insertion point** -- Read the current `plugins/autonomous-dev-assist/skills/help/SKILL.md` (baseline 385 lines per TDD-026 §3.3). Locate the existing "Pipeline Phases" H2 and the existing "Trust Levels" H2. The new `## Plugin Chains` and `## Deploy Framework` sections insert between them in that order. Capture the current line count and heading anchors so the doc-only smoke test in task 7 has a known baseline.
   - Files to read: `plugins/autonomous-dev-assist/skills/help/SKILL.md`
   - Acceptance criteria: A short markdown note (in the PR description) records the baseline line count and the exact heading text on either side of the insertion point. No file changes in this task.
   - Estimated effort: 1h

2. **Author `## Plugin Chains` section in `help/SKILL.md`** -- Insert the six H3 subsections per TDD-026 §5.1 in order: `### What chains are` (one paragraph, cites TDD-022 §1), `### The four chain commands` (table with `chains list`, `chains graph`, `chains audit verify`, `chains approve|reject REQ-NNNNNN`), `### The audit log` (file path, HMAC behavior, env-var key `CHAINS_AUDIT_KEY`, **explicit "do NOT delete the audit log" warning** per TDD-026 §10.1), `### Manifest-v2 fields` (`produces`, `consumes`, `egress_allowlist` with a JSON example), `### When chains pause` (cycle, HMAC mismatch, approval pending), `### See also` (links to `chains-runbook.md` and TDD-022 §5, §13).
   - Files to modify: `plugins/autonomous-dev-assist/skills/help/SKILL.md`
   - Acceptance criteria: The H2 opens with the `*Topic:* chains` marker (TDD-026 §11.3). Each H3 ≤30 lines. The "do NOT delete" string appears verbatim in `### The audit log` (negative-eval guard from TDD-026 §9.1). The "See also" block links exactly the chains-runbook and the two TDD-022 anchors. No SHA pinning anywhere in the new content.
   - Estimated effort: 4h

3. **Author `## Deploy Framework` section in `help/SKILL.md`** -- Insert the seven H3 subsections per TDD-026 §5.2: `### What the deploy framework is`, `### The seven deploy commands` (table covering `backends list|describe`, `plan`, `approve`, `reject`, `logs`, `cost`, `estimate`), `### The approval state machine` (the five-state diagram `pending → awaiting-approval → approved|rejected → executing → completed|failed`, with the **prod-always-approval rule** stated as a callout: every environment with `is_prod: true` requires human approval regardless of trust level), `### The cost-cap ledger` (file path `~/.autonomous-dev/deploy/ledger.json`, append-only contract, **"do NOT edit by hand"** warning, `deploy ledger reset` mention), `### The HealthMonitor` (one-paragraph pointer to `deploy logs`), `### When deploys stall` (`awaiting-approval`, `cost-cap-tripped`, backend not registered), `### See also` (links to `deploy-runbook.md` and TDD-023 §5, §11, §14).
   - Files to modify: `plugins/autonomous-dev-assist/skills/help/SKILL.md`
   - Acceptance criteria: Section opens with `*Topic:* deploy`. Each H3 ≤30 lines. The strings "regardless of trust level" and "do NOT edit by hand" appear verbatim (eval guards from TDD-026 §9.1 and §10.1). The state-machine arrow diagram renders as ASCII per TDD-023 §11 (no Mermaid -- `Read` step constraint). "See also" cites three TDD-023 anchors. No SHA pinning.
   - Estimated effort: 5h

4. **Author `## Section 19: chains` in `config-guide/SKILL.md`** -- Insert as a new H2 between the existing "Section 18: extensions" and the existing "Section 19: production_intelligence". Renumber the existing Section 19 to Section 20 and existing Section 20 to Section 21 (chosen approach in TDD-026 §5.3). Section content includes: the YAML block from TDD-026 §5.3 (`chains.enabled`, `chains.audit.key_env`, `chains.audit.log_path`, `chains.approval.required_for_prod_egress`), a parameter table with default values and constraints, a worked example showing a manifest-v2 declaration and the resulting graph excerpt (3-4 lines), and the HMAC-key custody guidance ("env var only, no rotation command exists in TDD-022 §13 -- rotation is OQ-3 future work").
   - Files to modify: `plugins/autonomous-dev-assist/skills/config-guide/SKILL.md`
   - Acceptance criteria: All references to old Section 19/20 elsewhere in the file are updated to 20/21 (use `Grep` then `Edit replace_all` carefully). The new section opens with `*Topic:* chains`. The YAML block is syntactically valid (`yamllint` style). Negative guards: the file does NOT contain `chains rotate-key`, `manifest-v1`, or `audit.json` per TDD-026 §9.1. The "See also" block links chains-runbook §1 Bootstrap and TDD-022 §5 + §13.
   - Estimated effort: 4h

5. **Author `## Section 20: deploy` in `config-guide/SKILL.md`** -- Insert as a new H2 immediately after Section 19 (chains). Section content per TDD-026 §5.4: schema reference link to TDD-023 §9 (`deploy-config-v1`), worked YAML example showing `default_backend: gcp`, a `staging` env (cost cap $50, auto-approve at L2+), and a `prod` env with `is_prod: true` and `cost_cap_usd: 500.00`, the approval-rules table (Trust L0/L1/L2/L3 × `is_prod: true|false` → "approval required" / "auto-approved"), the cost-cap interaction note pointing to the `cost_estimation` section owned by TDD-025 (cite as "see TDD-025 §X Cost Estimation when published"), and the "See also" block.
   - Files to modify: `plugins/autonomous-dev-assist/skills/config-guide/SKILL.md`
   - Acceptance criteria: Section opens with `*Topic:* deploy`. The approval-rules table makes the prod-always-approval rule explicit (every row with `is_prod: true` says "approval required" -- no exceptions). Negative guards: the file does NOT contain `deploy force-approve`, `deploy auto-prod`, or `cost cap.*ignore`. "See also" links deploy-runbook §2 Approval State Machine and TDD-023 §9 + §11.
   - Estimated effort: 4h

6. **Renumber downstream sections in `config-guide/SKILL.md`** -- After tasks 4 and 5 insert at positions 19 and 20, the existing Section 19 (production_intelligence) becomes Section 21 and existing Section 20 becomes Section 22. Verify the table of contents at the top of the file (if any) is updated. Verify any cross-section references inside `config-guide/SKILL.md` are corrected. Verify the file's total section count matches the PRD-015 §7 success metric of 25 sections after all six PRD-015 plans land (this plan delivers 2 of 6).
   - Files to modify: `plugins/autonomous-dev-assist/skills/config-guide/SKILL.md`
   - Acceptance criteria: `Grep` for `Section 19` finds only the new chains section. `Grep` for `Section 20` finds only the new deploy section. `Grep` for the old section names (`production_intelligence`, etc.) confirms they exist at their new numbers. The TOC (if present) renders with the renumbered list.
   - Estimated effort: 2h

7. **Doc-only smoke + anchor-convention scan** -- Author `tests/docs/test-skill-sections-026-1.test.sh` (or the existing markdownlint hook config -- check `plugins/autonomous-dev-assist/.markdownlint.json`) that asserts: `help/SKILL.md` contains the strings "## Plugin Chains" and "## Deploy Framework"; `config-guide/SKILL.md` contains "## Section 19: chains" and "## Section 20: deploy"; both files contain `*Topic:* chains` and `*Topic:* deploy` markers; neither file contains the SHA-pinning regex from TDD-026 §8; both files contain the verbatim safety strings ("do NOT delete the audit log", "do NOT edit by hand", "regardless of trust level"). Run `markdown-link-check` against both files (existing PRD-010 CI tool) and confirm zero broken links.
   - Files to create: `plugins/autonomous-dev-assist/tests/docs/test-skill-sections-026-1.test.sh`
   - Acceptance criteria: Script exits 0 when all assertions pass. Script exits 1 with a clear message if any assertion fails. `markdown-link-check` reports zero dead links in the two files. Script is wired into the existing test runner (search for `test-*.sh` invocations in `package.json` or the daemon's CI config).
   - Estimated effort: 2h

## Dependencies & Integration Points

**Exposes to other plans:**
- The new `## Plugin Chains` and `## Deploy Framework` H2 sections in `help/SKILL.md` are the link targets for the "See also" blocks in PLAN-026-2's `chains-runbook.md` and PLAN-026-3's `deploy-runbook.md`. The H2 anchors must remain stable.
- The new `## Section 19: chains` and `## Section 20: deploy` H2 sections in `config-guide/SKILL.md` are the link targets for the runbook bootstrap sections.
- The `*Topic:*` markers established here are the discoverability hook that PLAN-026-2's classifier extension uses to decide which SKILL section to load.

**Consumes from other plans:**
- PLAN-021-3 / `standards-meta-reviewer` (existing on main): reviews the new SKILL content for the SHA-pinning rule and the "See also" cross-link contract before merge.
- PRD-010 markdown-link-check CI (existing): catches dead "See also" links in tasks 2, 3, 4, 5.
- TDD-022 §5 (Plugin Manifest Extensions) and §13 (Audit Log): cited by the chains content; must be reachable from the repo's TDD index.
- TDD-023 §9 (deploy-config-v1), §11 (Trust Integration), §14 (Ledger Reset): cited by the deploy content; same.

## Testing Strategy

- **Doc smoke (task 7):** Verify section presence, `*Topic:*` markers, safety-string verbatim presence, and SHA-pin absence. Runs in CI on every PR touching `plugins/autonomous-dev-assist/skills/`.
- **markdownlint:** Existing repo config catches H2/H3 hierarchy regressions, trailing whitespace, and broken tables.
- **markdown-link-check:** Existing PRD-010 CI catches dead "See also" links.
- **Negative-content scan:** Task 7's script greps for the five chains negative strings (`chains rotate-key`, `rm.*audit\.log`, `chains delete`, `manifest-v1`, `audit\.json`) and the five deploy negative strings (`deploy force-approve`, `edit.*ledger\.json`, `deploy auto-prod`, `cost cap.*ignore`, `deploy.*--no-approval`) and asserts zero matches in the modified files. (The eval suite enforces this at runtime in PLAN-026-3; this plan enforces it at author time.)
- **Standards-meta-reviewer pre-flight:** Before merging this plan's PR, the meta-reviewer (PLAN-021-3) runs against the diff and confirms the anchor-convention is intact.
- **Manual smoke:** A senior on-call engineer who has not seen the new content asks 3 chain questions and 3 deploy questions via `/autonomous-dev-assist:assist` and reports any wrong answers. (Pre-test for PLAN-026-3's eval baseline.)

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Renumbering Section 19/20 → 21/22 in `config-guide/SKILL.md` breaks cross-section references inside the file or in other repo docs | Medium | Medium -- broken links, operator confusion | Task 6 explicitly greps for old section numbers across the repo (`grep -rn "Section 19" plugins/`) and updates each hit. Task 7's link checker catches any miss. PR review checklist includes verifying TOC. |
| The "do NOT delete" / "do NOT edit by hand" / "regardless of trust level" safety strings drift from TDD-022/023 wording across maintenance | Low | High -- operator destroys audit log or ledger | Task 7's script asserts verbatim presence; any future edit that softens or removes the string fails the smoke. The strings are also enforced by PLAN-026-3's eval `must_mention` clauses. |
| Inserting two new H2 sections in `help/SKILL.md` pushes the file past a markdown-link-check size or render budget | Low | Low -- CI slow but not failing | Target line count after this plan: ~500 lines (TDD-026 §10.3). The link checker's per-file budget is 100 KB; we are at ~50 KB. No mitigation needed unless the file approaches 1000 lines. |
| HMAC-key custody guidance is interpreted by an operator as "you can rotate by editing the env var", causing audit-log destruction | Medium | High -- R-7 from PRD-015 | The chains-config section explicitly states "rotation is a TDD-022 OQ-3 future work item -- do NOT rotate the existing key, the audit log will be unverifiable". Negative eval `chains rotate-key` enforces this in PLAN-026-3. The chains-runbook §3 (PLAN-026-2) reinforces. |
| The classifier keyword bag in PLAN-026-2 drifts from the keywords actually present in this plan's SKILL content, causing classifier misses | Low | Medium -- classifier doesn't load the right SKILL section | The keyword bag in TDD-026 §4.2 is the source of truth for both plans. PLAN-026-2's classifier task uses the SAME bag. PLAN-026-3's eval suite has at least 5 cases per category whose questions use the keyword bag verbatim and assert the right SKILL section is loaded. |
| Operator reads the deploy section, sees `cost_cap_usd: 500.00`, and assumes the cap is enforced regardless of `is_prod` | Low | Medium -- operator surprised when prod blocks despite cap not tripped | Section 20's approval-rules table makes the two gates orthogonal: cost-cap and approval-required are independent. The state machine subsection in `help/SKILL.md` reinforces. The runbook §2 (PLAN-026-3) walks through both gates explicitly. |

## Definition of Done

- [ ] `help/SKILL.md` contains `## Plugin Chains` H2 with all six H3 subsections from TDD-026 §5.1
- [ ] `help/SKILL.md` contains `## Deploy Framework` H2 with all seven H3 subsections from TDD-026 §5.2
- [ ] `config-guide/SKILL.md` contains `## Section 19: chains` with the four-parameter table and worked example
- [ ] `config-guide/SKILL.md` contains `## Section 20: deploy` with the schema reference, approval-rules table, and worked YAML
- [ ] All four new sections open with the `*Topic:*` marker per TDD-026 §11.3
- [ ] Each new section ends with a "See also" block citing the corresponding runbook AND at least one TDD § anchor
- [ ] Verbatim safety strings present: "do NOT delete the audit log", "do NOT edit by hand", "regardless of trust level"
- [ ] No SHA-pinned references match the regex `(commit\s+[a-f0-9]{7,40}|as of [a-f0-9]{7,40}|fixed in [a-f0-9]{7,40})`
- [ ] Negative content strings absent: `chains rotate-key`, `rm.*audit\.log`, `chains delete`, `manifest-v1`, `audit\.json`, `deploy force-approve`, `edit.*ledger\.json`, `deploy auto-prod`, `cost cap.*ignore`, `deploy.*--no-approval`
- [ ] `config-guide/SKILL.md` section numbering is consistent (old 19/20 renumbered to 21/22; no orphan references)
- [ ] markdownlint passes on both files
- [ ] markdown-link-check reports zero dead links in both files
- [ ] Task 7 doc-smoke script exits 0
- [ ] Standards-meta-reviewer (PLAN-021-3) approves the diff
- [ ] PR description records baseline line counts before/after for both files
