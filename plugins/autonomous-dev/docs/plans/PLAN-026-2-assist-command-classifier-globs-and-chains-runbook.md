# PLAN-026-2: Assist Command Classifier + Glob Expansion + chains-runbook

## Metadata
- **Parent TDD**: TDD-026-assist-chains-deploy-cli-surfaces
- **Estimated effort**: 3 days
- **Dependencies**: [PLAN-026-1]
- **Blocked by**: [PLAN-026-1]
- **Priority**: P1

## Objective
Wire the assist command's routing surface to the new SKILL content from PLAN-026-1, then deliver the chains operator deep-dive (`instructions/chains-runbook.md`). This plan extends `commands/assist.md` Step-1 classifier with three new categories (`chains`, `deploy`, `security`) per FR-1523, expands the Step-2 Glob list to reach the chains/deploy/cred-proxy/firewall intake directories and the four cloud-backend plugin trees per FR-1522, adds the `--with-cloud` argument plumbing to `commands/quickstart.md` per FR-1524, and authors the ~320-line `chains-runbook.md` with the eight sections defined in TDD-026 §7.1. The deploy-runbook, the eval suites, and the existing `runbook.md` "See also" index update are out of scope -- they land in PLAN-026-3.

## Scope
### In Scope
- Step-1 classifier extension in `plugins/autonomous-dev-assist/commands/assist.md` per TDD-026 §6.1 and §4.2: append three category bullets (`chains`, `deploy`, `security`) below the existing three (`help`, `troubleshoot`, `config`). Embed the canonical keyword bag inline (per OQ-6 closed answer: embedded, not externalized) so the classifier prompt itself documents the trigger words.
- Step-2 Glob expansion in `commands/assist.md` per TDD-026 §4.3 and §6.2: append nine `Glob:` lines (chains intake, deploy intake, cred-proxy intake, firewall intake, four cloud-backend plugin trees, the new `instructions/*-runbook.md` glob). Append-only: the existing globs are not removed.
- Step-3 answer-instruction tweak so multi-category classifications correctly load context from all matched buckets (the "classifier widens search, not narrows answer" tenet from TDD-026 §4.2). The default-fallback to `help` for zero-category questions remains.
- `commands/quickstart.md` `--with-cloud` argument per TDD-026 §6.3 (FR-1524): parse the flag at the top, after Step 4 (start the daemon) insert the deferred-bridge line "For cloud deploy onboarding, run `/autonomous-dev-assist:setup-wizard --with-cloud`." Detect when cloud plugins are not installed and print a friendly install pointer. The full setup-wizard cloud content is owned by TDD-027; this plan implements only the entry point.
- `instructions/chains-runbook.md` per TDD-026 §7.1 with all eight sections at the line targets specified: §1 Bootstrap (~30 lines), §2 Dependency-graph troubleshooting (~60 lines), §3 Audit verification (~80 lines including the **explicit "do NOT delete the audit log" passage and recovery-via-shadow-log path**), §4 Manifest-v2 migration (~50 lines with the v1→v2 cookbook), §5 Approval flow (~30 lines covering `chains approve|reject REQ-NNNNNN`), §6 Common errors (~40 lines with six error-message-to-action mappings), §7 Escalation (~20 lines), §8 See also (~10 lines linking deploy-runbook §§, TDD-022, help/SKILL.md Plugin Chains).
- Anchor-convention compliance per TDD-026 §8 across all new content. SHA-pin regex finds zero hits.
- Six error-message-to-action mappings in §6 covering: cycle detected, HMAC mismatch on `chains audit verify`, manifest-v2 schema error, missing `produces`/`consumes` declaration, approval-gate timeout, and unknown plugin in `chains list`. Each mapping has an exact error string (matchable with `Grep`) and the recovery procedure.
- A doc-only smoke test for the new runbook and command-file changes (analogous to PLAN-026-1 task 7).
- markdownlint and markdown-link-check passing on all modified and created files.

### Out of Scope
- `instructions/deploy-runbook.md` -- PLAN-026-3.
- `instructions/runbook.md` "See also" index update -- PLAN-026-3 (the four cross-links land together with the deploy-runbook so all targets exist when the index is added).
- `evals/test-cases/chains-eval.yaml` and `deploy-eval.yaml` -- PLAN-026-3.
- The actual setup-wizard `--with-cloud` extension content (cred-proxy bootstrap, firewall backend choice, dry-run cloud deploy) -- TDD-027 §5.
- Cloud-backend-plugin SKILL or runbook content -- TDD-025.
- `commands/deploy-doctor.md` -- deferred per TDD-026 NG-05.
- Changes to the rule-set-enforcement-reviewer or any reviewer agent -- not in TDD-026 scope.
- Modifying TDD-022 chain semantics (this plan documents shipped behavior only -- TDD-026 NG-01).
- The two new SKILL.md sections themselves -- delivered by PLAN-026-1 (this plan depends on those H2 anchors existing).

## Tasks

1. **Read `commands/assist.md` baseline and extract current classifier + Glob list** -- Read `plugins/autonomous-dev-assist/commands/assist.md` (87 lines per TDD-026 §3.3). Identify the Step-1 classifier section, the Step-2 Glob list, the Step-3 answer instructions, and any existing argument parsing. Note the exact bullet format and indentation for the classifier so the extension is consistent.
   - Files to read: `plugins/autonomous-dev-assist/commands/assist.md`
   - Acceptance criteria: PR description records the current classifier bullet count (3), the current Glob count, and the exact line ranges of each step. No file changes.
   - Estimated effort: 1h

2. **Extend Step-1 classifier with `chains`, `deploy`, `security` categories** -- Append three bullets per TDD-026 §6.1 verbatim: `**chains** -- Questions about plugin chains, the manifest-v2 schema, the chain audit log, or chains CLI.` followed by the deploy and security bullets. Then add a multi-line "Trigger keywords" block per TDD-026 §4.2 listing the seven chains keywords (`chain`, `chains`, `produces`, `consumes`, `manifest-v2`, `audit.log`, `egress_allowlist`), eight deploy keywords (`deploy`, `backend`, `approval`, `approve`, `ledger`, `cost cap`, `estimate`, `rollout`), and seven security keywords (`HMAC`, `key rotation`, `audit`, `denied`, `permission denied`, `credentials`, `scoper`). Multi-match is allowed and intentional.
   - Files to modify: `plugins/autonomous-dev-assist/commands/assist.md`
   - Acceptance criteria: The classifier section now lists six categories. Each new bullet uses the exact wording from TDD-026 §6.1. The keyword bag is present inline (OQ-6: embedded). The Step-3 answer instruction explicitly states "if the question matches multiple categories, load context from all matched categories" so the prompt cannot silently narrow to one.
   - Estimated effort: 2h

3. **Append nine `Glob:` patterns to Step-2** -- Append (do not replace) the nine globs from TDD-026 §4.3: `plugins/autonomous-dev/intake/chains/*`, `plugins/autonomous-dev/intake/deploy/*`, `plugins/autonomous-dev/intake/cred-proxy/*`, `plugins/autonomous-dev/intake/firewall/*`, `plugins/autonomous-dev-deploy-{gcp,aws,azure,k8s}/**` (four lines), and `plugins/autonomous-dev-assist/instructions/*-runbook.md`. Verify each pattern is reachable from the repo root (the four cloud-plugin paths return empty when the plugins are not installed -- expected behavior per TDD-026 §12.2).
   - Files to modify: `plugins/autonomous-dev-assist/commands/assist.md`
   - Acceptance criteria: The Glob list is append-only -- existing globs preserved verbatim. Total Glob count after this task = original + 9. The runbook glob `*-runbook.md` is intentional (matches both `chains-runbook.md` from this plan and `deploy-runbook.md` from PLAN-026-3 once it lands). PR description notes which globs return empty today (the four cloud-plugin paths are expected empty until TDD-025 plugins ship).
   - Estimated effort: 1.5h

4. **Add `--with-cloud` argument to `commands/quickstart.md`** -- Per TDD-026 §6.3 / FR-1524: at the top of the prompt, document the optional `--with-cloud` argument. After Step 4 (start the daemon), insert a single conditional line: "If `--with-cloud` is present: For cloud deploy onboarding, run `/autonomous-dev-assist:setup-wizard --with-cloud`." Add a guard sentence: "If the autonomous-dev-deploy-{gcp,aws,azure,k8s} plugins are not installed, the setup-wizard will offer to install them; see TDD-027 §5 (when published) for the full flow." This plan delivers the entry point only; the wizard's cloud-specific phase content is TDD-027 territory.
   - Files to modify: `plugins/autonomous-dev-assist/commands/quickstart.md`
   - Acceptance criteria: The argument is documented in the file's argument table or top section. The bridge line is inserted at the correct point (after Step 4, before Step 5 if present). The reference to TDD-027 §5 uses the section-anchor form (no SHA pin). The flag is optional and the existing local-only quickstart flow still works when omitted.
   - Estimated effort: 2h

5. **Author `chains-runbook.md` §1 Bootstrap and §2 Dependency-graph troubleshooting** -- Create `plugins/autonomous-dev-assist/instructions/chains-runbook.md` and write the first two sections per TDD-026 §7.1: §1 covers first-time setup (env-var creation `export CHAINS_AUDIT_KEY=$(openssl rand -hex 32)` shown as illustrative -- not a real key), key generation, manifest-v2 migration entry-point. §2 covers cycle detection (output of `chains graph` showing a cycle, the recovery: identify the offending plugin pair, file a bug or bisect by removing one plugin), missing `produces` declaration (error message verbatim, fix is to add the field to the upstream plugin's manifest), missing `consumes` declaration (likewise), interpretation of the DAG ASCII output.
   - Files to create: `plugins/autonomous-dev-assist/instructions/chains-runbook.md`
   - Acceptance criteria: §1 ≈30 lines; §2 ≈60 lines. The file opens with the standard runbook front-matter (mirror `instructions/runbook.md` style). The bootstrap section names the env-var `CHAINS_AUDIT_KEY` correctly. §2 uses placeholder plugin names (`example-plugin-a`, `example-plugin-b`) per TDD-026 §10.2 privacy rule.
   - Estimated effort: 4h

6. **Author chains-runbook.md §3 Audit verification (the safety-critical section)** -- Per TDD-026 §7.1 (~80 lines): explain the HMAC chain (each entry's HMAC depends on the previous entry's), document `chains audit verify` (exit codes, output format), and the **explicit "what to do on mismatch" guidance**: do NOT delete the audit log, do NOT manually edit it, do NOT rotate the HMAC key (no rotation command exists per TDD-022 §13). Document the supported recovery: if a shadow log exists at `~/.autonomous-dev/chains/audit.log.shadow`, `chains audit verify --shadow` cross-checks it; otherwise file a TDD-022 issue. Include three error patterns: "HMAC mismatch at entry N" (action: do NOT delete; investigate via shadow log), "audit log truncated" (action: investigate; do NOT regenerate), "audit key not set" (action: set `CHAINS_AUDIT_KEY`; do NOT generate a new key if entries already exist).
   - Files to modify: `plugins/autonomous-dev-assist/instructions/chains-runbook.md`
   - Acceptance criteria: §3 ≈80 lines. The verbatim phrase "do NOT delete the audit log" appears at least twice (once at the section opening, once in the recovery procedure). The verbatim phrase "do NOT rotate the HMAC key" appears at least once. No SHA-pin references. The negative-eval guards from TDD-026 §9.1 are pre-empted: the section does NOT contain `chains rotate-key` or `audit.json`. Cross-link to TDD-022 §13 uses the section-anchor form.
   - Estimated effort: 5h

7. **Author chains-runbook.md §4 Manifest-v2 migration** -- Per TDD-026 §7.1 (~50 lines): the v1→v2 cookbook. Walk through migrating an example plugin: read the existing `plugin.json`, identify what artifact types it emits and consumes (in narrative -- "a SQL-injection scanner emits `findings/security` artifacts"), add `produces: ["findings/security"]` and `consumes: ["source/code"]` to the manifest, validate with `chains list` (expects the upgraded plugin to appear), commit. Include the negative case: do NOT skip the v2 migration and expect chains to work -- the executor rejects v1 manifests with a clear error per TDD-022 §5.
   - Files to modify: `plugins/autonomous-dev-assist/instructions/chains-runbook.md`
   - Acceptance criteria: §4 ≈50 lines. The cookbook uses `example-scanner-plugin` placeholder. The verbatim string `manifest-v1` is NOT used as a current term (the negative-eval guard from TDD-026 §9.1 -- it should appear only inside a "do NOT..." sentence if at all).
   - Estimated effort: 3h

8. **Author chains-runbook.md §5 Approval flow, §6 Common errors, §7 Escalation, §8 See also** -- Per TDD-026 §7.1: §5 (~30 lines) walks through `chains approve REQ-NNNNNN` and `chains reject REQ-NNNNNN`, the REQ-NNNNNN format, and what causes the gate (the `approval.required_for_prod_egress: true` config plus an egress hit on a prod host). §6 (~40 lines) documents six error-message-to-action mappings beyond §3's HMAC mappings: cycle detected, manifest-v2 schema error, missing produces, missing consumes, approval-gate timeout, unknown plugin. §7 (~20 lines) describes when to file a TDD-022 issue (HMAC bug, schema bug, executor bug) vs. when to recover locally (missing declaration, cycle, approval timeout). §8 (~10 lines) links deploy-runbook (will exist after PLAN-026-3 lands), TDD-022 §5 + §13, and `help/SKILL.md` Plugin Chains.
   - Files to modify: `plugins/autonomous-dev-assist/instructions/chains-runbook.md`
   - Acceptance criteria: All four sections present at target line counts. Total runbook size ≈320 lines (TDD-026 §7.1 target). §6 has exactly six mappings. §8's "See also" cites at least two TDD-022 anchors. The deploy-runbook link in §8 will be a dead link until PLAN-026-3 merges -- this is acceptable because the two plans land sequentially and the link checker runs on the merged PR. Document this dependency in the PR description.
   - Estimated effort: 4h

9. **Doc-only smoke + anchor-convention scan** -- Author `tests/docs/test-classifier-and-chains-runbook-026-2.test.sh` that asserts: `commands/assist.md` contains six classifier categories (count `^- \*\*[a-z]+\*\* --` matches in the classifier section); the nine new Glob patterns are present; `commands/quickstart.md` documents the `--with-cloud` argument; `chains-runbook.md` exists and contains all eight `## ` H2 headings; the safety strings "do NOT delete the audit log", "do NOT rotate the HMAC key" appear; the SHA-pin regex finds zero hits across all modified files; the negative chains strings (`chains rotate-key`, `manifest-v1` outside "do NOT..." context, `audit.json`) appear zero times. Run `markdown-link-check` against the new and modified files and confirm all links except the deploy-runbook cross-link resolve (the deploy-runbook link is documented as expected-broken until PLAN-026-3 lands).
   - Files to create: `plugins/autonomous-dev-assist/tests/docs/test-classifier-and-chains-runbook-026-2.test.sh`
   - Acceptance criteria: Script exits 0 with all assertions met. The deploy-runbook dead-link is whitelisted via a comment in the script with an `XFAIL: PLAN-026-3 lands the target` marker. After PLAN-026-3 merges, the whitelist line is removed (captured as a follow-up in PLAN-026-3's task list).
   - Estimated effort: 2h

## Dependencies & Integration Points

**Exposes to other plans:**
- The extended classifier in `commands/assist.md` is the routing surface that PLAN-026-3's eval suites exercise: each chains-eval question is expected to classify into `chains` (and possibly `security`) and load the SKILL section from PLAN-026-1.
- `chains-runbook.md` is the link target for PLAN-026-3's deploy-runbook §8 cross-reference and for the `instructions/runbook.md` See-also index update (PLAN-026-3 task).
- The `--with-cloud` entry point is the hook that TDD-027's setup-wizard extension consumes when it lands.
- The Glob list expansion is the "address book" for all six PRD-015 plans -- TDD-025/027/028 will rely on the same file existing in the right shape; this plan establishes it.

**Consumes from other plans:**
- **PLAN-026-1** (blocking): the `## Plugin Chains` H2 in `help/SKILL.md` and the `## Section 19: chains` H2 in `config-guide/SKILL.md` must exist as link targets before this plan's runbook §8 "See also" block can resolve. The classifier change in this plan is independent of PLAN-026-1 (the categories work even if the SKILL sections are empty), but the operator experience requires both to land in the same merge train.
- **PLAN-021-3** / `standards-meta-reviewer` (existing on main): reviews the new content for SHA pinning and "See also" anchor compliance.
- **PLAN-019-1/2/3/4** / hook engine, plugin discovery, trust gates (existing on main): the runtime that the chains content describes. This plan does NOT modify any of it.
- **TDD-022** §5, §13: the upstream surface this plan documents. Section anchors must remain stable.
- **PRD-010** markdown-link-check CI: catches dead links except the documented PLAN-026-3 cross-link.

## Testing Strategy

- **Doc smoke (task 9):** Asserts classifier category count, Glob count, runbook H2 count, safety strings, anchor convention, negative content. Runs in CI on every PR touching `plugins/autonomous-dev-assist/commands/` or `plugins/autonomous-dev-assist/instructions/`.
- **Manual classifier walk:** Run `/autonomous-dev-assist:assist "how do I verify the chain audit log?"` against the local daemon (post-merge) and confirm the answer cites `chains audit verify` and the "do NOT delete" string. This is a pre-test for the formal eval suite in PLAN-026-3 -- not a CI gate.
- **Manual `--with-cloud` walk:** Run `/autonomous-dev-assist:quickstart --with-cloud` and verify the bridge line appears after the daemon starts. Without the flag, the bridge line is absent.
- **Glob reachability check:** Bash one-liner that resolves each of the nine globs against the repo root and counts file matches. The four cloud-plugin globs return zero (expected). The four intake globs return non-zero (those directories ship in main today). The runbook glob returns one (chains-runbook.md just authored).
- **markdownlint:** Existing config catches H2/H3 hierarchy regressions and table errors.
- **markdown-link-check:** Catches dead links except the whitelisted deploy-runbook cross-link in §8.
- **Standards-meta-reviewer pre-flight:** Before merge, the meta-reviewer (PLAN-021-3) confirms the anchor-convention is intact and no SHA pinning sneaked in.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Adding three new classifier categories causes the classifier prompt to over-classify "what is autonomous-dev?" into the new buckets, regressing the existing 90-case eval suite | Medium | Medium -- existing answers degrade | The Step-3 instruction explicitly says "if no category matches, default to `help`" (TDD-026 §12.2). The existing 90-case suite is re-run as a regression gate per TDD-026 §15.2 (PRD-015 §8.6 quality gate). If the existing suite drops below 95%, the classifier prompt is tuned (e.g., require a keyword match, not just substring overlap). |
| The four cloud-plugin globs return empty today and stay empty until TDD-025 plugins ship; operators see the empty result and assume the assist is broken | Medium | Low -- false-alarm operator concern | TDD-026 §12.2 specifies the runtime behavior: "Glob target missing (cloud plugin not installed) -> assist proceeds with what it has and surfaces 'for cloud deploy install autonomous-dev-deploy-{cloud}'". This plan's Step-3 answer instruction includes that fallback message verbatim. |
| The §8 "See also" cross-link to deploy-runbook §§ is dead until PLAN-026-3 merges, breaking markdown-link-check on this plan's PR | Medium | Medium -- CI red on otherwise good PR | Whitelist the link in the smoke test (task 9) with an XFAIL marker. PLAN-026-3 task list explicitly removes the whitelist as part of its DoD. The two PRs are intended to land in sequence; the dead link exists for at most one merge cycle. |
| `--with-cloud` flag is parsed but the conditional bridge line fires for both true and false (a markdown rendering bug where the conditional becomes literal text) | Low | Low -- minor confusing UX | The argument-parse pattern mirrors the existing `commands/assist.md` argument handling (no new pattern introduced). Manual smoke in testing-strategy catches it. |
| Operator follows the §3 audit-verification recovery procedure on a system without a shadow log and finds no recovery path, gets frustrated, deletes the log anyway | Medium | High -- R-7 from PRD-015 audit destruction | §3 explicitly says "if no shadow log exists, file a TDD-022 issue -- do NOT delete the log; the file's irrecoverable security record is more valuable than the inconvenience". The escalation section §7 reinforces. The negative-eval `rm.*audit\.log` in PLAN-026-3 catches any answer that suggests deletion. |
| Six error-message-to-action mappings in §6 use exact strings that drift from the actual TDD-022 executor output as TDD-022 evolves | Medium | Medium -- mappings stop matching | Each mapping is anchored to TDD-022 §M.X (the section that defines the error). When TDD-022 changes the message, the anchor remains valid; the mapping in this runbook is updated as a follow-up patch. The eval suite in PLAN-026-3 has at least one case per mapping that fails if the expected string is wrong, alerting maintainers. |

## Definition of Done

- [ ] `commands/assist.md` Step-1 classifier lists six categories (`help`, `troubleshoot`, `config`, `chains`, `deploy`, `security`)
- [ ] The keyword bag for the three new categories is embedded inline in the classifier section
- [ ] `commands/assist.md` Step-2 Glob list contains the nine new patterns from TDD-026 §4.3 (append-only)
- [ ] `commands/assist.md` Step-3 answer instructions handle multi-match and no-match cases per TDD-026 §12.2
- [ ] `commands/quickstart.md` documents and parses `--with-cloud`; the bridge line appears only when the flag is present
- [ ] `instructions/chains-runbook.md` exists with all eight H2 sections at the target line counts (~320 lines total)
- [ ] §3 contains the verbatim safety strings "do NOT delete the audit log" and "do NOT rotate the HMAC key"
- [ ] §6 contains exactly six error-message-to-action mappings (beyond the three HMAC mappings in §3)
- [ ] No SHA-pin regex matches across all new and modified files
- [ ] Negative chains strings (`chains rotate-key`, `audit.json`, `manifest-v1` as a current term) appear zero times
- [ ] Task 9 doc-smoke script exits 0 with the deploy-runbook XFAIL whitelisted
- [ ] markdown-link-check passes (with the documented XFAIL)
- [ ] markdownlint passes
- [ ] Standards-meta-reviewer (PLAN-021-3) approves the diff
- [ ] PR description records the baseline classifier/Glob counts and the four cloud-plugin globs that intentionally return empty
- [ ] PR description includes a manual smoke-test transcript: one chains question and one `--with-cloud` quickstart run
