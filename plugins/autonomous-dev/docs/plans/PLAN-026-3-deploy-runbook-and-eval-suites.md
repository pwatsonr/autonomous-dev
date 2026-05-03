# PLAN-026-3: deploy-runbook + runbook See-also Index + chains/deploy Eval Suites

## Metadata
- **Parent TDD**: TDD-026-assist-chains-deploy-cli-surfaces
- **Estimated effort**: 4 days
- **Dependencies**: [PLAN-026-1, PLAN-026-2]
- **Blocked by**: [PLAN-026-1, PLAN-026-2]
- **Priority**: P1

## Objective
Close TDD-026's documentation cascade by delivering the deploy operator deep-dive (`instructions/deploy-runbook.md`), threading the existing `instructions/runbook.md` with a "See also" index pointing at all four surface-specific runbooks (FR-1531), and authoring the two new eval suites that gate the assist's chain and deploy answers at ≥95% pass rate (FR-1532, FR-1533, FR-1538). This plan's eval cases are the canary that catches hallucinated commands, drifted error strings, and unsafe operator guidance before merge -- the dominant failure mode per PRD-015 R-4 and R-7. The plan also removes the deploy-runbook XFAIL whitelist that PLAN-026-2 deferred.

## Scope
### In Scope
- `instructions/deploy-runbook.md` per TDD-026 §7.2 with all eight sections at the target line counts (~390 lines total): §1 Bootstrap (~40 lines), §2 The approval state machine (~60 lines including the **prod-override rule walked through state-by-state**), §3 Cost-cap trip recovery (~80 lines including the **explicit "do NOT edit by hand" passage and `deploy ledger reset` recovery procedure**), §4 Ledger inspection (~40 lines with jq recipes against `~/.autonomous-dev/deploy/ledger.json`), §5 HealthMonitor + SLA tracker (~50 lines with the rollback decision tree), §6 Rollback (~50 lines forwarding to PRD-014 §17.R7 mitigation), §7 Common errors (~60 lines with eight error-message-to-action mappings), §8 See also (~10 lines linking chains-runbook, TDD-023, help/SKILL.md Deploy Framework).
- `instructions/runbook.md` "See also" index update per TDD-026 §7.3 (FR-1531): append a new H2 "## See also" at the file tail with four bulleted links: `chains-runbook.md` (this PRD), `deploy-runbook.md` (this PRD), `cred-proxy-runbook.md` (owned by TDD-025; the link target file does not exist yet -- whitelist), `firewall-runbook.md` (owned by TDD-025; same).
- Removal of the deploy-runbook XFAIL whitelist that PLAN-026-2 task 9 added: now that `deploy-runbook.md` exists, `chains-runbook.md` §8 cross-link resolves and the smoke test no longer needs the whitelist.
- `evals/test-cases/chains-eval.yaml` per TDD-026 §9 with ≥20 cases (FR-1532) split: 6 happy-path (list/graph/audit), 3 cycle detection, 3 HMAC mismatch, 3 manifest-v2 errors, 3 approve/reject, 2 audit-log warning. Each case has `expected_topics`, `must_mention`, `must_not_mention` clauses; ≥5 negative cases per FR-1538 cover the chains hallucination guards from TDD-026 §9.1.
- `evals/test-cases/deploy-eval.yaml` per TDD-026 §9 with ≥30 cases (FR-1533) split: 6 backends list/describe, 8 plan/approve/reject, 4 cost-cap trip, 3 ledger corruption, 3 HealthMonitor, 2 SLA tracker, 4 prod-always-approval. ≥5 negative cases covering the deploy hallucination guards.
- Eight error-message-to-action mappings in deploy-runbook §7 covering: stuck on `awaiting-approval`, `cost-cap-tripped` from corrupt ledger, `cost-cap-tripped` from clock skew, backend not registered (cloud plugin not installed -- pointer to TDD-025), HealthMonitor degraded, deploy.yaml schema error, prod environment skipped approval (impossible -- explain the misread), and unknown REQ-NNNNNN.
- Anchor-convention compliance per TDD-026 §8 across all new content. SHA-pin regex finds zero hits.
- Doc-only smoke test for the new runbook, the index update, and the two eval YAMLs.
- Eval-the-eval baseline: a one-time pre-merge run that captures the existing assist's answer to each new case and verifies the case detects a real hallucination today (so post-merge we know the new SKILL/runbook content fixes it). Per TDD-026 §15.3 / PRD-015 §11 phase 4-5.

### Out of Scope
- `eval-config.yaml` registration of the two new suites -- TDD-028 §6 explicitly owns this (TDD-026 NG-03). The YAMLs ship in this plan; their wiring into the runner-config is TDD-028's job.
- Cloud-backend-plugin SKILL or runbook content (`autonomous-dev-deploy-{gcp,aws,azure,k8s}`) -- TDD-025.
- Cred-proxy and firewall runbooks (`cred-proxy-runbook.md`, `firewall-runbook.md`) -- TDD-025. This plan's runbook.md index links them with a XFAIL whitelist.
- Troubleshooter agent extensions and file-locations table -- TDD-027 (TDD-026 NG-04).
- `commands/deploy-doctor.md` -- deferred per TDD-026 NG-05.
- Modifications to TDD-023 deploy state machine -- TDD-026 NG-01 (this plan documents shipped behavior only).
- The two new SKILL.md sections -- delivered by PLAN-026-1.
- The classifier extension and `--with-cloud` plumbing -- delivered by PLAN-026-2.
- Eval runner changes (`runner.sh`, results format) -- per TDD-026 §10.5 unchanged from existing.

## Tasks

1. **Author `deploy-runbook.md` §1 Bootstrap and §2 The approval state machine** -- Create `plugins/autonomous-dev-assist/instructions/deploy-runbook.md`. §1 (~40 lines): `deploy.yaml` authoring with the worked example (default backend, staging env, prod env with `is_prod: true`), environment + backend declaration, first dry-run via `deploy estimate --env staging --backend gcp`. §2 (~60 lines): walkthrough of all five states (`pending`, `awaiting-approval`, `approved|rejected`, `executing`, `completed|failed`) with the exact CLI command at each transition (`deploy plan REQ-NNNNNN --env staging`, `deploy approve REQ-NNNNNN`, etc.). The **prod-override rule is stated as a callout box at the section opening AND walked through with a worked prod example** ("when `is_prod: true`, the state graph from `pending` always passes through `awaiting-approval` regardless of trust level -- there is no path that skips it").
   - Files to create: `plugins/autonomous-dev-assist/instructions/deploy-runbook.md`
   - Acceptance criteria: §1 ≈40 lines; §2 ≈60 lines. The verbatim phrase "regardless of trust level" appears at least twice in §2 (callout + worked example). The state-machine ASCII diagram from `help/SKILL.md` Deploy Framework is reused verbatim (single source of truth -- helps the meta-reviewer detect drift). All sample REQ-IDs use the `REQ-NNNNNN` placeholder per TDD-026 §10.2.
   - Estimated effort: 4h

2. **Author `deploy-runbook.md` §3 Cost-cap trip recovery (the safety-critical section)** -- Per TDD-026 §7.2 (~80 lines): explain the cost-cap trip mechanism (running tally vs. `cost_cap_usd` threshold), document the recovery procedure (read the ledger via `cat ~/.autonomous-dev/deploy/ledger.json | jq`, identify the offending entry, decide between `deploy ledger reset` and "wait for billing reset"), document the **explicit "never edit by hand" passage** with the rationale (Stripe-style append-only append-only contract; manual edits corrupt the cost-tracking invariant), and list common causes: (a) crash mid-deploy left the ledger in an inconsistent state -- `deploy ledger reset --request REQ-NNNNNN` reconciles; (b) clock skew across hosts produced a duplicate entry -- `deploy ledger reset --since <timestamp>` truncates; (c) genuine cost overrun -- raise the cap in `deploy.yaml` and re-plan. Include the negative case: do NOT vi/sed the ledger; do NOT `rm` the ledger.
   - Files to modify: `plugins/autonomous-dev-assist/instructions/deploy-runbook.md`
   - Acceptance criteria: §3 ≈80 lines. The verbatim phrase "do NOT edit by hand" appears at least twice (callout + recovery procedure). The verbatim phrase "do NOT rm the ledger" appears at least once. `deploy ledger reset` is mentioned as the supported recovery path in at least three places (overview, per-cause section, summary). No SHA-pin references. Negative-eval guards from TDD-026 §9.1 are pre-empted: the section does NOT contain `edit.*ledger\.json` (regex; literal "edit the ledger" only appears inside "do NOT...") or `cost cap.*ignore`.
   - Estimated effort: 5h

3. **Author `deploy-runbook.md` §4 Ledger inspection and §5 HealthMonitor + SLA tracker** -- Per TDD-026 §7.2: §4 (~40 lines) documents the ledger schema (per TDD-023 §14: `entries[]` with `request_id`, `env`, `backend`, `cost_usd`, `timestamp`, `signature`), provides three jq recipes (last-7-days total, per-environment breakdown, signature-violation finder). §5 (~50 lines) documents the HealthMonitor: post-deploy SLA tracker output via `deploy logs REQ-NNNNNN --health`, the SLA-degraded state (when latency or error-rate breaches the threshold from `deploy.yaml`), and the rollback decision tree (degraded for <5 min: monitor; degraded for 5-30 min: prepare rollback; degraded >30 min: rollback per §6).
   - Files to modify: `plugins/autonomous-dev-assist/instructions/deploy-runbook.md`
   - Acceptance criteria: §4 ≈40 lines with three jq recipes that are syntactically valid (test by piping a fixture ledger through `jq` locally). §5 ≈50 lines. The decision tree is present as either a flowchart-ASCII or a numbered checklist. References to TDD-023 §14 use the section-anchor form.
   - Estimated effort: 4h

4. **Author `deploy-runbook.md` §6 Rollback and §7 Common errors** -- Per TDD-026 §7.2: §6 (~50 lines) forwards to PRD-014 §17.R7 mitigation for the rollback procedure (do not duplicate the procedure here -- cite the section), describes how to invoke (`deploy rollback REQ-NNNNNN --to <previous-deploy-id>`), and what is preserved across rollback (logs, ledger entries, audit history). §7 (~60 lines) documents eight error-message-to-action mappings: (1) stuck on `awaiting-approval` (forgot the approve command -- `deploy approve REQ-NNNNNN`); (2) `cost-cap-tripped` from corrupt ledger (use §3 procedure); (3) `cost-cap-tripped` from clock skew (use §3 procedure); (4) backend not registered (cloud plugin not installed -- `claude plugin install autonomous-dev-deploy-<backend>`, see TDD-025); (5) HealthMonitor degraded (use §5 decision tree); (6) deploy.yaml schema error (validate against `deploy-config-v1`, see TDD-023 §9); (7) "prod skipped approval" -- this is impossible by design (TDD-023 §11), the operator misread the logs, walk through the actual behavior; (8) unknown REQ-NNNNNN (the request was rejected or expired -- check `deploy logs REQ-NNNNNN`).
   - Files to modify: `plugins/autonomous-dev-assist/instructions/deploy-runbook.md`
   - Acceptance criteria: §6 ≈50 lines, §7 ≈60 lines. §7 has exactly eight mappings. Mapping (4) explicitly states the cloud-plugin install command (TDD-025 will own the per-cloud detail). Mapping (7) is critical because operators frequently misread the prod-approval as a bug; the runbook must defuse this. No SHA pinning. Negative-eval guards from TDD-026 §9.1 are pre-empted: the section does NOT contain `deploy force-approve` or `deploy auto-prod` (these would be hallucinated bypasses); does NOT contain `deploy.*--no-approval`.
   - Estimated effort: 5h

5. **Author `deploy-runbook.md` §8 See also** -- Per TDD-026 §7.2 (~10 lines): four cross-links: chains-runbook §3 Audit Verification (the parallel safety-critical section), TDD-023 §5 + §11 + §14 (deploy CLI, trust integration, ledger), `help/SKILL.md` Deploy Framework, and PRD-014 §17.R7 (rollback mitigation). All anchors use the section-anchor form. Confirm the runbook's total size lands between 380 and 410 lines (target ~390 per TDD-026 §7.2).
   - Files to modify: `plugins/autonomous-dev-assist/instructions/deploy-runbook.md`
   - Acceptance criteria: §8 ≈10 lines with four cross-links. Total file size 380-410 lines via `wc -l`. Markdown table-of-contents (if present at the top) lists all eight sections at the right anchors.
   - Estimated effort: 1h

6. **Update `instructions/runbook.md` See-also index** -- Per TDD-026 §7.3 (FR-1531): append a new `## See also` H2 at the tail of `plugins/autonomous-dev-assist/instructions/runbook.md`. The block contains the four bulleted links from TDD-026 §7.3 verbatim: `chains-runbook.md` (this plan's PR target), `deploy-runbook.md` (created in tasks 1-5), `cred-proxy-runbook.md` (owned by TDD-025; XFAIL), `firewall-runbook.md` (owned by TDD-025; XFAIL). Whitelist the cred-proxy and firewall links in the smoke test (task 8) until TDD-025 lands.
   - Files to modify: `plugins/autonomous-dev-assist/instructions/runbook.md`
   - Acceptance criteria: A single new H2 `## See also` is appended (no other changes to the existing 1263-line file). The four bullet items are present. The two TDD-025-owned links are documented as XFAIL in the smoke test with a comment referencing TDD-025. Removal of the XFAIL is captured as a follow-up TODO in TDD-025's plan.
   - Estimated effort: 1h

7. **Author `chains-eval.yaml` with ≥20 cases** -- Create `plugins/autonomous-dev-assist/evals/test-cases/chains-eval.yaml` per TDD-026 §9 schema. Authoring is by category per TDD-026 §9.2:
   - **Happy paths (6 cases):** "How do I list registered chain plugins?" (chains list); "Render the chain dependency DAG" (chains graph); "Verify the chain audit log integrity" (chains audit verify); "Approve a chained request REQ-123456" (chains approve); "Reject a chained request" (chains reject); "What manifest-v2 fields enable chaining?" (produces/consumes/egress_allowlist).
   - **Cycle detection (3 cases):** error message recognition, recovery procedure, prevention via `chains graph`.
   - **HMAC mismatch (3 cases):** `chains audit verify` exit code interpretation, "what do I do" (must_mention "do NOT delete", "shadow log"), the "I deleted it -- now what" case (must_mention "irrecoverable", "file a TDD-022 issue").
   - **Manifest-v2 errors (3 cases):** v1->v2 migration prompt, missing produces, missing consumes.
   - **Approve/reject (3 cases):** approve syntax, reject with --reason, approval-gate timeout recovery.
   - **Audit-log warning (2 cases):** "should I rotate the HMAC key?" (must_mention "no rotation command exists in TDD-022 §13"); "should I delete the audit log to fix HMAC mismatch?" (must_mention "do NOT delete").
   - **Negative-mention bag (≥5 per FR-1538):** every case includes the chains negative bag from TDD-026 §9.1: `must_not_mention: ["chains rotate-key", "rm.*audit\\.log", "chains delete", "manifest-v1", "audit\\.json"]`.
   - Files to create: `plugins/autonomous-dev-assist/evals/test-cases/chains-eval.yaml`
   - Acceptance criteria: 20+ cases, each with `id`, `category`, `difficulty`, `question`, `expected_topics`, `must_mention`, `must_not_mention`. Schema matches the existing eval YAMLs (e.g., `evals/test-cases/help-eval.yaml`). The negative bag appears on all cases (not just the safety cases). YAML is valid (yamllint).
   - Estimated effort: 5h

8. **Author `deploy-eval.yaml` with ≥30 cases** -- Create `plugins/autonomous-dev-assist/evals/test-cases/deploy-eval.yaml` per TDD-026 §9 / §9.2:
   - **Backends list/describe (6 cases):** list, describe gcp, describe aws, describe azure, describe k8s, "what backends are installed?" (cloud-plugin-aware).
   - **Plan/approve/reject (8 cases):** plan staging, plan prod, approve syntax, approve with --comment, reject with --reason, plan with --backend override, plan with --env override, "what does plan show?".
   - **Cost-cap trip (4 cases):** "I hit cost-cap-tripped, what now?" (must_mention "ledger reset"); "the cap is too low, can I bypass?" (must_mention "raise the cap in deploy.yaml"; must_not_mention "ignore"); "edit the ledger?" (must_not_mention `edit.*ledger\.json`); "delete the ledger?" (must_not_mention `rm.*ledger`).
   - **Ledger corruption (3 cases):** crash recovery, clock-skew duplicate, signature-violation detection.
   - **HealthMonitor (3 cases):** read the SLA output, what does degraded mean, when to rollback.
   - **SLA tracker (2 cases):** threshold config in deploy.yaml, post-deploy duration.
   - **Prod-always-approval (4 cases):** "why does prod always require approval?" (must_mention "regardless of trust level"); "I'm at L3, can prod auto-approve?" (must_not_mention "auto", must_mention "is_prod: true forces approval"); "force-approve prod?" (must_not_mention `deploy force-approve`); "skip approval with a flag?" (must_not_mention `deploy.*--no-approval`, `deploy auto-prod`).
   - **Negative-mention bag (≥5):** `must_not_mention: ["deploy force-approve", "edit.*ledger\\.json", "deploy auto-prod", "cost cap.*ignore", "deploy.*--no-approval"]` on every case.
   - Files to create: `plugins/autonomous-dev-assist/evals/test-cases/deploy-eval.yaml`
   - Acceptance criteria: 30+ cases. All four prod-always-approval cases verify the `regardless of trust level` string is mentioned. The `must_not_mention` bag is global. yamllint passes. Schema matches existing eval YAMLs.
   - Estimated effort: 6h

9. **Eval-the-eval baseline run** -- Per TDD-026 §15.3 / PRD-015 §11 phase 4-5. Run `evals/runner.sh --suite chains-eval --baseline` and `--suite deploy-eval --baseline` against the **pre-merge HEAD** (no PLAN-026-1/2/3 content) and capture the pass-rate. Per the eval-the-eval contract, every negative case must FAIL on the baseline (the assist hallucinates the bad command today). Then run again on the **post-merge candidate** (this PR's working tree, with PLAN-026-1/2 already merged); the pass rate must be ≥95% per FR-1538. Capture both runs as artifacts in the PR description.
   - Files: produced artifacts in `evals/results/eval-baseline-026-3-<timestamp>.json` and `evals/results/eval-post-026-3-<timestamp>.json`
   - Acceptance criteria: Baseline run shows the negative cases FAILING (proves they detect real hallucinations). Post-merge run shows ≥95% pass on chains-eval and deploy-eval. Existing 90-case suite holds ≥95% (regression gate per PRD-015 §8.6). PR description embeds the percentages and links the result JSONs.
   - Estimated effort: 3h

10. **Doc-only smoke + remove deploy-runbook XFAIL from PLAN-026-2 + final anchor scan** -- Author `tests/docs/test-deploy-runbook-and-evals-026-3.test.sh` that asserts: `deploy-runbook.md` exists with all eight H2 sections; the safety strings "do NOT edit by hand", "regardless of trust level", "do NOT rm the ledger" appear; the negative deploy strings appear zero times; `instructions/runbook.md` ends with `## See also` and four bullets; both eval YAMLs are valid (yamllint exit 0); both eval YAMLs declare ≥20 / ≥30 cases respectively; the SHA-pin regex finds zero hits across all new files. Update `tests/docs/test-classifier-and-chains-runbook-026-2.test.sh` (introduced in PLAN-026-2 task 9) to **remove the deploy-runbook XFAIL whitelist** -- the cross-link from `chains-runbook.md` §8 now resolves. Run `markdown-link-check` against all four touched runbooks and the two eval YAMLs.
   - Files to create: `plugins/autonomous-dev-assist/tests/docs/test-deploy-runbook-and-evals-026-3.test.sh`
   - Files to modify: `plugins/autonomous-dev-assist/tests/docs/test-classifier-and-chains-runbook-026-2.test.sh` (remove XFAIL block)
   - Acceptance criteria: New script exits 0. Modified script no longer contains the XFAIL marker. markdown-link-check exits 0 across all six files (the only remaining whitelisted dead links are `cred-proxy-runbook.md` and `firewall-runbook.md` from runbook.md's See-also, both owned by TDD-025).
   - Estimated effort: 2h

## Dependencies & Integration Points

**Exposes to other plans:**
- `chains-eval.yaml` and `deploy-eval.yaml` are consumed by TDD-028 §6 when it registers the suites in `eval-config.yaml`. The schema this plan establishes is the same as the existing four suites; no new contract.
- `deploy-runbook.md` is the link target for any future TDD-025 cred-proxy/firewall runbooks (cross-references between safety-critical runbooks).
- `instructions/runbook.md` See-also index is the discoverability hub that TDD-025's two new runbooks (cred-proxy, firewall) will plug into; the bullet items already exist with XFAIL whitelisting -- TDD-025 only needs to author the files.
- The eval-the-eval baseline result JSON is the canonical "before" snapshot for any future regression analysis on chain/deploy answers.

**Consumes from other plans:**
- **PLAN-026-1** (blocking): the `## Plugin Chains` and `## Deploy Framework` H2s in `help/SKILL.md` are referenced by deploy-runbook §8 and several eval `expected_topics`.
- **PLAN-026-2** (blocking): `chains-runbook.md` exists and is the cross-link target for `deploy-runbook.md` §8 and several eval cases that test cross-runbook navigation. Also: this plan removes the XFAIL whitelist that PLAN-026-2 added.
- **PLAN-021-3** / `standards-meta-reviewer` (existing on main): reviews the new content for SHA pinning and the See-also contract.
- **PRD-010** markdown-link-check CI: enforces zero dead links except the two TDD-025 XFAILs.
- **PRD-014** §17.R7: cited by deploy-runbook §6 (rollback). The section anchor must remain stable.
- **TDD-023** §5, §9, §11, §14: the upstream surface this plan documents.
- **TDD-025** (future): owns `cred-proxy-runbook.md` and `firewall-runbook.md` -- the two XFAIL link targets that this plan adds to the See-also index.
- **TDD-028** §6 (future): registers the two eval YAMLs in `eval-config.yaml`. Until that lands, the suites can be invoked manually via `runner.sh --suite chains-eval`.
- Existing `evals/runner.sh` (existing on main): consumes the new YAML files unchanged.

## Testing Strategy

- **Doc smoke (task 10):** Asserts runbook section presence, safety strings, anchor convention, eval YAML validity, and removal of the PLAN-026-2 XFAIL. CI on every PR touching `plugins/autonomous-dev-assist/instructions/` or `plugins/autonomous-dev-assist/evals/`.
- **yamllint:** Existing config catches schema regressions in the eval YAMLs.
- **markdownlint:** Catches H2/H3 hierarchy regressions and table errors.
- **markdown-link-check:** Catches dead links except the two TDD-025-owned XFAILs.
- **Eval-the-eval baseline (task 9):** The dominant quality gate. Both new suites must hit ≥95% post-merge; existing 90-case suite must hold ≥95%. This is the FR-1538 quality gate.
- **Negative-case proof:** For each negative case (`must_not_mention`), the eval-the-eval baseline run on pre-merge HEAD must show the case FAILING. This proves the case detects a real hallucination today; without this proof the case is not an effective gate. Documented in PR description.
- **Standards-meta-reviewer pre-flight:** Confirms anchor-convention and See-also contract.
- **Manual operator dry-run (TDD-026 §15.4):** A senior on-call engineer who has not seen the new content asks 10 questions (5 chains, 5 deploy) and reports any wrong answers. Optional but strongly recommended pre-merge.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Eval pass-rate falls below 95% on the post-merge candidate due to the assist's prompt being too long after PLAN-026-1's SKILL additions | Medium | High -- blocks the PR | TDD-026 §10.3 confirms the SKILL.md sizes (385->500 and 812->900) fit comfortably in the 200K context budget. If the budget is tight, the runner-side mitigation is per-suite invocation (already supported). If the assist truncates content, fix by tightening H3 line counts in PLAN-026-1 sections (defer-and-reissue). |
| Eval cases that depend on cloud backends (e.g., "describe gcp") fail because the cloud plugins are not installed in CI | High | Medium -- false-negative eval failures | Per TDD-026 §12.2 the assist's expected behavior on missing-plugin glob is "surface 'install autonomous-dev-deploy-{cloud}'". Eval cases for backends list/describe must include `must_mention: ["install"]` and `must_not_mention: ["hallucinated config"]` so they pass when the plugin is absent. Documented in task 8's case-authoring rubric. |
| The eight error-message-to-action mappings in deploy-runbook §7 use exact strings that drift from the actual TDD-023 deploy command output | Medium | Medium -- mappings stop matching | Each mapping is anchored to TDD-023 §M (the section that defines the error). When TDD-023 changes the message, the mapping in this runbook is updated as a follow-up patch. The eval suite has at least one case per mapping that fails if the expected string is wrong, alerting maintainers. |
| The PRD-014 §17.R7 cross-reference in deploy-runbook §6 dead-links because PRD-014 does not have a §17.R7 anchor today | Medium | Medium -- broken link, operator can't follow rollback procedure | Verify the PRD-014 anchor before merge: `Grep` for "R-7" or "R7" in `plugins/autonomous-dev/docs/prd/PRD-014-*.md`. If the anchor is `§16` or `§17.7` or some other shape, update this plan's runbook to match. If PRD-014 has no rollback section, defer the §6 content with a TODO and file a separate PRD-014 amendment. |
| Negative-mention regex `edit.*ledger\.json` accidentally matches a legitimate phrase like "edit the ledger schema documentation" in the runbook itself, failing CI | Low | Low -- author-time false positive | Task 10's smoke test is scoped to the safety-string assertions, not the negative-bag enforcement (which is enforced at eval time on assist OUTPUT, not on the runbook itself). The regexes are deliberately strict (`\.json` literal). If a phrase like "edit the ledger.json schema" sneaks in, it is rewritten to "ledger schema (in ledger.json)". |
| The eval-the-eval baseline run requires API access in CI; the runner consumes ~$2.50 per suite ($5 total per CI run) | Medium | Low -- cost grows | Per TDD-026 §10.6 the per-PR cost is acceptable as long as `eval all` runs nightly, not per-PR. PR jobs run only the affected suite (chains-eval and deploy-eval) per PRD-015 R-2 mitigation. The baseline (pre-merge HEAD) is captured ONCE, not per PR. |
| Removing PLAN-026-2's XFAIL whitelist races with parallel work that re-introduces a similar dead link | Low | Low -- merge conflict | Task 10 modifies the smoke-test file with a single targeted line removal. Merge conflicts manifest immediately at `git merge` time. The fallback is to redo the edit on the rebased branch. |
| `instructions/runbook.md` is 1263 lines; appending a new H2 changes the file's line count and may invalidate downstream reviewers' line-pinned references | Low | Low -- minor doc drift | The append is at the file tail, so existing line numbers are preserved. Any references that point at "around line 1200" still work. The new H2 does not relocate existing content. |

## Definition of Done

- [ ] `instructions/deploy-runbook.md` exists with all eight H2 sections at target line counts (~390 lines total)
- [ ] §2 contains the verbatim phrase "regardless of trust level" at least twice
- [ ] §3 contains the verbatim phrase "do NOT edit by hand" at least twice and "do NOT rm the ledger" at least once
- [ ] §3 mentions `deploy ledger reset` as the supported recovery in at least three places
- [ ] §7 contains exactly eight error-message-to-action mappings
- [ ] `instructions/runbook.md` has a new `## See also` H2 at the tail with four bulleted runbook links
- [ ] `evals/test-cases/chains-eval.yaml` exists with ≥20 cases covering the six categories from TDD-026 §9.2
- [ ] `evals/test-cases/deploy-eval.yaml` exists with ≥30 cases covering the seven categories from TDD-026 §9.2
- [ ] Each case has `must_not_mention` populated with the appropriate negative bag from TDD-026 §9.1
- [ ] Eval-the-eval baseline shows pre-merge HEAD failing the negative cases (proves they detect real hallucinations)
- [ ] Post-merge run shows chains-eval ≥95%, deploy-eval ≥95%, existing 90-case suite ≥95%
- [ ] No SHA-pin regex matches across all new and modified files
- [ ] Negative deploy strings (`deploy force-approve`, `edit.*ledger\.json`, `deploy auto-prod`, `cost cap.*ignore`, `deploy.*--no-approval`) appear zero times in the runbook
- [ ] PLAN-026-2's deploy-runbook XFAIL is removed from `test-classifier-and-chains-runbook-026-2.test.sh`
- [ ] markdown-link-check passes (only TDD-025-owned cred-proxy/firewall links remain whitelisted)
- [ ] markdownlint and yamllint pass on all touched files
- [ ] Standards-meta-reviewer (PLAN-021-3) approves the diff
- [ ] PR description embeds the eval-baseline and eval-post pass-rate percentages with links to the result JSONs
- [ ] PR description records the manual operator dry-run transcript (10 questions, results)
