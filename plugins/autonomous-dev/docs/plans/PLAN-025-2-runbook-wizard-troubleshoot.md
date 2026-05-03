# PLAN-025-2: Cred-Proxy Runbook + Setup-Wizard Phases 11-12 + Troubleshoot Scenarios

## Metadata
- **Parent TDD**: TDD-025-assist-cloud-credproxy-surface
- **Estimated effort**: 4 days
- **Dependencies**: [PLAN-025-1]
- **Blocked by**: [PLAN-025-1]
- **Priority**: P0

## Objective
Deliver the operator-workflow content for cloud-backend and cred-proxy onboarding: the new `instructions/cred-proxy-runbook.md` (FR-1529) covering bootstrap, scoper installation, common failures, recovery, TTL tuning, audit verification, and emergency revoke; the two new troubleshoot scenarios in `skills/troubleshoot/SKILL.md` (FR-1513 cred-proxy portion) for permission-denied and TTL-expired-mid-deploy; and the two new setup-wizard phases in `skills/setup-wizard/SKILL.md` (FR-1515 cloud + cred-proxy portion) — Phase 11 (cloud backend selection) and Phase 12 (cred-proxy bootstrap), both marked optional per FR-1516. Documentation surface (SKILL sections, config-guide, assist.md classification) must already be in place from PLAN-025-1; the eval suite that gates these workflows ships in PLAN-025-3.

## Scope
### In Scope
- `instructions/cred-proxy-runbook.md` per TDD §6.8 with nine sections: (1) Overview — architecture (SCM_RIGHTS, scopers, TTL, audit log); (2) Bootstrap — `cred-proxy start`, `cred-proxy doctor`, audit-key env-var setup; (3) Scoper installation per cloud — four mini-procedures, one each for AWS/GCP/Azure/K8s; (4) Common failures — permission denied, scoper missing, TTL expired mid-deploy, audit-hash mismatch; (5) Recovery — for each failure with explicit "do not rotate root" + "do not chown root" + "do not delete audit log" warnings; (6) TTL tuning — when to raise (long deploys), when to lower (security-tightened envs), upper bound, interaction with cap; (7) Audit-hash verification — `cred-proxy doctor --verify-audit`, mismatch interpretation; (8) Emergency revoke — `cred-proxy revoke <token-id>`, when to use; (9) Escalation — audit-hash mismatch is *always* escalation; never recover unilaterally.
- AWS scoper subsection (§3.1) is the canonical detailed walkthrough per TDD §11.3 trade-off; GCP/Azure/K8s subsections (§3.2-§3.4) are brief notes with pointers to TDD-024 §8.
- `skills/troubleshoot/SKILL.md` two new scenarios per TDD §6.4: (a) "`cred-proxy: permission denied on Unix socket`" with diagnosis path (`ls -l socket`, `stat`, `cred-proxy status`, `cred-proxy doctor`) and recovery (chmod 0600 / restart as deploying user / `cred-proxy start`) plus the explicit **"Do not chown to root"** warning; (b) "My deploy died at the 15-minute mark with an auth error" with diagnosis (`cred-proxy audit.log | tail` to confirm TTL) and recovery (raise `default_ttl_seconds` or restructure deploy) plus the explicit **"Do not rotate root credentials"** warning.
- `skills/setup-wizard/SKILL.md` Phase 11 (cloud backend selection) per TDD §6.7: prompt operator for cloud(s); per-cloud plugin-install check (`ls plugins/autonomous-dev-deploy-<cloud>/`) emitting install command if missing; cloud-CLI presence check (`command -v gcloud / aws / az / kubectl`); root-credential reachability check (`gcloud auth list`, `aws sts get-caller-identity`, etc.) without storing output. Phase header marked **optional** per FR-1516.
- `skills/setup-wizard/SKILL.md` Phase 12 (cred-proxy bootstrap) per TDD §6.7: per-cloud scoper-plugin install check; walk through `cred-proxy start` and `cred-proxy doctor`; auto-verify socket permissions; set `audit_key_env` if not already set with shell-rc instructions and explicit **never-echo-the-key-value** rule (`read -s` or env-var-set instructions only); test issuance with `cred-proxy issue <cloud> <minimal-scope>` and verify the audit-log entry appears. Phase header marked **optional** per FR-1516.
- Phase numbering integration: phases 11-12 extend cleanly from the existing 10-phase wizard. Operators not passing `--with-cloud` see no change. Phases 13 (firewall, TDD-028) and 14 (dry-run deploy, TDD-026) are *not* added by this plan; the section explicitly documents that this plan introduces phases 11 and 12 only.
- Wizard secret-handling: every cred-proxy interaction uses the FR-1539 never-echo-secrets rule. Audit-key generation example uses `read -s` or `openssl rand -hex 32 | install-into-shell-rc-without-printing`; no command echoes the key value to stdout.
- Cross-references: runbook §3 K8s subsection includes the explicit cred-proxy-TTL-vs-K8s-SA-token-TTL distinction per TDD §3.3 failure-mode table and TDD R-4. The runbook §3.4 K8s scope is intentionally shallow (mention only) per NG-07.

### Out of Scope
- `help/SKILL.md` cloud-backends + credential-proxy sections -- PLAN-025-1
- `config-guide/SKILL.md` `cred_proxy` section -- PLAN-025-1
- `commands/assist.md` classification + Glob + Bash updates -- PLAN-025-1
- `troubleshooter.md` file-locations rows -- PLAN-025-1
- `evals/test-cases/cred-proxy-eval.yaml` -- PLAN-025-3
- Wizard phase 13 (firewall) -- TDD-028 / sibling plan
- Wizard phase 14 (dry-run deploy) outer shell -- TDD-026 / sibling plan
- `--with-cloud` flag wiring in `quickstart.md` -- TDD-026
- Modifying TDD-024 cred-proxy semantics, scoper logic, or socket transport (TDD-025 NG-01)
- Wrapping `cred-proxy doctor` as a slash command (TDD-025 NG-06)
- Deep K8s service-account-token-projection coverage (TDD-025 NG-07)
- Live integration tests against a running cred-proxy (TDD-025 NG-04)

## Tasks

1. **Author `cred-proxy-runbook.md` §1 Overview and §2 Bootstrap** -- New file. §1 mirrors the architecture diagram from TDD §3.2 in ASCII (or references the TDD if rendering ASCII is infeasible) and explains, in operator terms, why the scoper exists (root creds never reach the deploy worker). §2 walks bootstrap: `cred-proxy start`, `cred-proxy doctor`, generate-and-export the audit key (using `read -s` or `openssl rand -hex 32 > ~/.autonomous-dev/cred-proxy/audit-key && chmod 0600` then `export CRED_PROXY_AUDIT_KEY="$(cat ~/.autonomous-dev/cred-proxy/audit-key)"` in shell rc; the file approach is recommended over command-line arg per the never-echo-secrets rule).
   - Files to create: `plugins/autonomous-dev-assist/instructions/cred-proxy-runbook.md` (initial sections only)
   - Acceptance criteria: §1 explains the scoper-as-isolation-layer concept in operator language. §2 walks bootstrap end-to-end with copy-pasteable commands. Audit-key generation never echoes the key to stdout in any documented command.
   - Estimated effort: 4h

2. **Author `cred-proxy-runbook.md` §3 Scoper installation per cloud** -- Four subsections. §3.1 AWS is the canonical detailed walkthrough per TDD §11.3: `claude plugin install cred-proxy-scoper-aws`, configure with the IAM role/profile that the proxy uses to mint STS short-term creds, document the minimum IAM-policy snippet needed to mint scoped sessions. §3.2 GCP, §3.3 Azure, §3.4 K8s are each a 5-10 line procedure with a "see TDD-024 §8 for full detail" pointer. §3.4 K8s explicitly distinguishes cred-proxy TTL (15-min default) from K8s SA-token-projection TTL (cluster-controlled, typically 1h+) per TDD §3.3 R-4.
   - Files to modify: `plugins/autonomous-dev-assist/instructions/cred-proxy-runbook.md`
   - Acceptance criteria: All four scoper subsections present. AWS subsection has an example IAM policy snippet (or a clear pointer to one in TDD-024). GCP/Azure subsections are brief but each lists the install command. K8s subsection contains the cred-proxy-TTL-vs-SA-token-TTL distinction explicitly. No subsection asks the operator to paste root credentials anywhere.
   - Estimated effort: 5h

3. **Author `cred-proxy-runbook.md` §4 Common failures and §5 Recovery** -- §4 enumerates four failure modes (permission denied; scoper missing; TTL expired mid-deploy; audit-hash mismatch) with a sentence each on detection signals. §5 provides recovery steps for each. Each recovery step has explicit prohibitions: **do not rotate root credentials** (TTL expiry); **do not chown the socket to root** (permission denied); **do not delete the audit log** (audit-hash mismatch). The audit-hash-mismatch recovery says "escalate; do not attempt unilateral recovery" (matches §9 escalation guidance).
   - Files to modify: `plugins/autonomous-dev-assist/instructions/cred-proxy-runbook.md`
   - Acceptance criteria: All four failure modes documented in §4 with detection signals. All four have recovery steps in §5. The three explicit prohibitions appear verbatim ("do not rotate root credentials", "do not chown the socket to root", "do not delete the audit log") so PLAN-025-3's eval `must_not_mention` patterns line up. Audit-hash-mismatch recovery is "escalate" per TDD §6.8 §9.
   - Estimated effort: 4h

4. **Author `cred-proxy-runbook.md` §6 TTL tuning, §7 Audit verification, §8 Emergency revoke, §9 Escalation** -- §6 walks the trade-off: raising `default_ttl_seconds` for long deploys (cite the upstream cap from TDD-024 §10; AWS STS chained-role 4-hour practical max documented as the recommended ceiling); lowering for security-tightened environments. §7 documents `cred-proxy doctor --verify-audit`, what a mismatch looks like, and the immediate response (do not delete; escalate). §8 documents emergency revoke (`cred-proxy revoke <token-id>`) with the "use when token-id is suspected compromised, e.g., a process that should not have it"-style guidance. §9 codifies the escalation contract: audit-hash mismatch is *always* escalation; never recover unilaterally.
   - Files to modify: `plugins/autonomous-dev-assist/instructions/cred-proxy-runbook.md`
   - Acceptance criteria: §6 documents both raise and lower directions with rationale. §7 explicitly says do-not-delete-the-audit-log under "audit-hash mismatch." §8 has an example revoke command. §9 is the final section; explicit escalation contract present. Open question OQ-1 (SIGHUP vs restart for config reload) is documented as "assume restart" per the TDD's recommended-default; flagged with a "verify against TDD-024 §10" pointer.
   - Estimated effort: 3h

5. **Author troubleshoot scenario 1: permission-denied on Unix socket** -- New scenario in `skills/troubleshoot/SKILL.md` per TDD §6.4 (1). Title: "`cred-proxy: permission denied on Unix socket`". Diagnosis path: (a) `ls -l ~/.autonomous-dev/cred-proxy/socket` to verify mode 0600; (b) `stat` (platform-aware) to verify ownership matches running user; (c) `cred-proxy status` to verify daemon is running; (d) `cred-proxy doctor` for full diagnostic. Recovery: if perms wrong, `chmod 0600`; if ownership wrong, restart cred-proxy as the deploying user (not root); if daemon not running, `cred-proxy start`. Explicit warning: **"Do not chown the socket to root."** in bold.
   - Files to modify: `plugins/autonomous-dev-assist/skills/troubleshoot/SKILL.md`
   - Acceptance criteria: Scenario heading matches the title verbatim (used as eval `expected_topic`). All four diagnostic steps present in order. All three recovery branches present. The "Do not chown to root" warning appears in bold and uses verbatim phrasing for eval `must_not_mention: chown root` to line up. Existing scenarios untouched.
   - Estimated effort: 2h

6. **Author troubleshoot scenario 2: TTL expired mid-deploy** -- New scenario per TDD §6.4 (2). Title: "My deploy died at the 15-minute mark with an auth error." Diagnosis: TTL expiry mid-deploy is the most common explanation; verify by `cred-proxy audit.log | tail` to find the issuance entry and confirm TTL. Recovery: this is *expected* for long-running deploys; either (a) raise `default_ttl_seconds` in cred-proxy config (cite the upper bound from runbook §6) and restart the proxy; or (b) restructure the deploy into shorter steps. Explicit warning: **"Do not rotate root credentials. The auth failure is a TTL expiry, not a credential compromise."**
   - Files to modify: `plugins/autonomous-dev-assist/skills/troubleshoot/SKILL.md`
   - Acceptance criteria: Scenario heading uses the "15-minute mark" phrasing (eval cases reference this language). Diagnosis explicitly cites `audit.log | tail`. Recovery has both branches (raise TTL, restructure). The "Do not rotate root credentials" warning appears in bold and is phrased so the eval `must_not_mention: rotate-root` / `aws iam create-access-key` / `gcloud iam service-accounts keys create` patterns are not triggered by the recovery text itself.
   - Estimated effort: 2h

7. **Author setup-wizard Phase 11 (cloud backend selection)** -- Append to `skills/setup-wizard/SKILL.md` after the existing 10 phases. Header marks Phase 11 as **optional** (FR-1516); intro text says "Run only if you passed `--with-cloud` to `quickstart` (the flag itself is owned by TDD-026)." Phase content: (a) prompt the operator with a checkbox-style list of clouds (gcp/aws/azure/k8s); (b) for each chosen cloud, check `ls plugins/autonomous-dev-deploy-<cloud>/` — if missing, emit `claude plugin install autonomous-dev-deploy-<cloud>` and exit cleanly (PRD-015 R-3); (c) check cloud-CLI presence with `command -v <tool>`; (d) check root-credential reachability with the per-cloud command (`gcloud auth list`, `aws sts get-caller-identity`, `az account show`, `kubectl auth can-i get pods --all-namespaces`) without storing the output.
   - Files to modify: `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md`
   - Acceptance criteria: Phase 11 header is `### Phase 11: Cloud backend selection (optional)`. All three checks present. Each per-cloud command listed correctly. PRD-015 R-3 (check, don't install) followed: the wizard surfaces the install command but does not run it. No reachability-check command stores or echoes credential material. Existing 10 phases untouched.
   - Estimated effort: 3h

8. **Author setup-wizard Phase 12 (cred-proxy bootstrap)** -- Append after Phase 11. Header marks Phase 12 as **optional** (FR-1516); intro text says "Required only if you completed Phase 11." Phase content: (a) for each cloud chosen in Phase 11, check `ls plugins/cred-proxy-scoper-<cloud>/` — if missing, emit install command and exit cleanly; (b) walk operator through `cred-proxy start` and `cred-proxy doctor`; (c) auto-verify socket permissions (mode 0600, owner-only) using the platform-aware `stat` from PLAN-025-1; (d) if `audit_key_env` is unset, walk the operator through generating and storing the audit key without echoing the value (write to `~/.autonomous-dev/cred-proxy/audit-key`, chmod 0600, export from shell rc); (e) test issuance with `cred-proxy issue <cloud> <minimal-scope>` (use `--dry-run` if available per OQ-5; otherwise document the live-issuance caveat) and verify the audit-log entry appears with `cred-proxy doctor --verify-audit`.
   - Files to modify: `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md`
   - Acceptance criteria: Phase 12 header is `### Phase 12: Credential proxy bootstrap (optional)`. All five sub-steps present. Audit-key step never echoes the key value (FR-1539). Per-cloud scoper-plugin install gating present. Test-issuance step verifies the audit-log entry. Phase exit criterion: `cred-proxy doctor --verify-audit` returns success.
   - Estimated effort: 3h

9. **Phase-numbering integration test (manual)** -- Walk the entire `setup-wizard/SKILL.md` end-to-end after tasks 7-8 land. Verify: existing phases 1-10 unchanged; Phase 11 and 12 are last; cross-references between phases resolve; "optional" markers are consistent with FR-1516. If a `setup-wizard-questions.yaml` regression suite exists (per TDD §11.4 trade-off), confirm it still passes; if it does not yet exist, document this as a follow-up and a forward dependency on its eventual creation.
   - Files to modify: None (verification only; may produce a small follow-up commit fixing inconsistencies)
   - Acceptance criteria: Phases 1-10 byte-for-byte unchanged from `main`. Phase 11 and 12 use consistent header style. "Optional" markers are uniform. If the regression suite exists, it passes.
   - Estimated effort: 1h

## Dependencies & Integration Points

**Exposes to other plans:**
- The `cred-proxy-runbook.md` is the source-of-truth deep reference linked from PLAN-025-1's SKILL "see also" pointers. PLAN-025-3 eval cases use it as the assist agent's primary deep-context source.
- The two new troubleshoot scenarios are the surface PLAN-025-3 evaluates against for the permission-denied and TTL-expired-mid-deploy negative cases.
- Setup-wizard phases 11-12 are the surface PLAN-025-3 (or a sibling wizard-eval suite, if one exists) tests for end-to-end onboarding correctness.
- The verbatim-prohibition phrasing in runbook §5 ("do not rotate root credentials" / "do not chown to root" / "do not delete the audit log") is the canonical text PLAN-025-3 eval `must_not_mention` patterns assume.

**Consumes from other plans:**
- **PLAN-025-1** (sibling, hard dependency): the SKILL "Credential Proxy" section provides the operator-facing intro text this runbook expands; the `cred_proxy` config-guide section is the schema source the wizard's audit-key step references; `commands/assist.md` classification routes operators to this runbook. PLAN-025-1 must merge first.
- **TDD-024 §7-§10** for cred-proxy semantics, TTL bounds, scoper interface, audit-log format.
- **TDD-024 §8** for per-cloud scoper detail (referenced from runbook §3 with pointers).
- **TDD-026 / sibling plan** for the `--with-cloud` flag (Phase 11's intro references this; the flag itself is not delivered by this plan).
- **FR-1539** for the never-echo-secrets rule used in Phase 12's audit-key step.
- **FR-1516** for the optional-phase marking convention.

## Testing Strategy

- **Markdown lint:** `markdownlint` must pass on all modified files. New runbook is a new file; existing `troubleshoot/SKILL.md` and `setup-wizard/SKILL.md` get appended to without rewrites.
- **Verbatim-phrase audit:** The three prohibition phrases (do not rotate root, do not chown to root, do not delete the audit log) appear at least once each in the runbook and in the corresponding troubleshoot scenarios. PLAN-025-3 eval cases will fail if these phrases drift.
- **No-secrets-echoed audit (manual):** Walk every documented command in the runbook and the wizard phases. Confirm none of them echoes the audit key, root credentials, or scoper-issued tokens to stdout. Use of `read -s`, file-based key storage, `2>/dev/null`, and indirect env-var references are the acceptable patterns.
- **Phase-numbering audit (task 9):** Manual walkthrough of `setup-wizard/SKILL.md` confirms phases 1-10 unchanged.
- **No code-path tests:** Documentation only. Behavioural validation lives in PLAN-025-3.
- **Regression:** Existing assist regression suite must continue to pass; no behavioural changes outside the new sections.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Wizard Phase 12 audit-key step accidentally documents an `echo "$CRED_PROXY_AUDIT_KEY"` somewhere (e.g., in a verification step) and FR-1539 is violated | Medium | High -- credential leak in operator scrollback | Task 8 acceptance criterion explicitly forbids echoing the key. The "no-secrets-echoed audit" testing-strategy step is a manual review-time gate. Reviewer hand-checks every documented command for stdout-bound secret material. |
| Operator on K8s confuses cred-proxy TTL (15 min) with K8s SA-token-projection TTL (1h+) and applies wrong remediation | Medium | Medium -- deploys into wrong tier of mitigation | Runbook §3.4 K8s subsection has the explicit distinction per TDD §3.3 R-4. Troubleshoot scenario 2 (15-minute-mark) calls out this distinction in the diagnosis path. PLAN-025-3 will add an eval case for this exact confusion. |
| Operator reads the runbook §5 "do not rotate root" warning and asks "but what *should* I rotate?" — answer is unclear in the documentation | Low | Medium -- support escalation | Runbook §5 explicitly says "raise the TTL or restructure the deploy." Troubleshoot scenario 2 mirrors the same recovery branches. The non-action of "do nothing on root creds" is documented as the correct action, not as a missing answer. |
| Phase 11/12 numbering collides with phases 13/14 from sibling TDDs (TDD-026, TDD-028) when those plans land | Medium | Low -- phase-number renumbering in a follow-up | Task 9 verifies clean append. If TDD-026/028 plans land first or out-of-order, the wizard's regression suite (if it exists by then) will catch numbering drift. The plan-coordination contract in TDD-025 §11.4 trade-off and §13.1 sibling-references is the agreement; orchestrator owns the merge order. |
| Wizard Phase 12 step (e) test-issuance with `cred-proxy issue --dry-run` is documented, but `--dry-run` does not exist in the actual cred-proxy CLI (per OQ-5 open question) | Medium | Low -- wizard fallback to live issuance | Task 8 documents both branches: dry-run if available, live with caveat if not. PR-time author re-reads TDD-024 §10 to verify the actual CLI surface. If `--dry-run` is missing, the live-issuance branch is the documented default; OQ-5 is closed in this plan's PR. |
| Runbook §3 AWS subsection's example IAM policy snippet is wrong and operators copy-paste a non-working policy | Low | Medium -- bootstrap fails | Task 2 acceptance criterion calls for either an example policy or a clear pointer to one in TDD-024 §8. The pointer-only path is the safer default; if a snippet is included, it is reviewed against TDD-024 §8 verbatim before merge. |
| Two new troubleshoot scenarios use phrasing that the existing `troubleshoot/SKILL.md` agent retrieval logic does not match well (e.g., the scenario heading is not the canonical question form) | Medium | Medium -- assist misses these scenarios at retrieval time | Task 5/6 acceptance criteria use scenario titles that mirror what an operator would type. PLAN-025-3 eval cases use those titles as the expected topics; if retrieval misses, eval scoring catches it. Iterate during PLAN-025-3's eval-tuning loop. |

## Definition of Done

- [ ] `cred-proxy-runbook.md` exists with all nine sections per TDD §6.8
- [ ] AWS scoper subsection (§3.1) is the canonical detailed walkthrough; GCP/Azure/K8s (§3.2-§3.4) are brief notes
- [ ] K8s subsection (§3.4) explicitly distinguishes cred-proxy TTL from K8s SA-token-projection TTL
- [ ] Three prohibition phrases appear verbatim in the runbook §5 and the corresponding troubleshoot scenarios: "do not rotate root credentials", "do not chown to root", "do not delete the audit log"
- [ ] Audit-hash-mismatch recovery says "escalate; do not attempt unilateral recovery" per §9
- [ ] `troubleshoot/SKILL.md` has two new scenarios: permission-denied on Unix socket; deploy died at 15-minute mark
- [ ] Both troubleshoot scenarios have a clear diagnosis path and recovery branches
- [ ] `setup-wizard/SKILL.md` has Phase 11 (cloud backend selection, optional) and Phase 12 (cred-proxy bootstrap, optional) per TDD §6.7
- [ ] Phase 11 follows PRD-015 R-3 (check, don't install)
- [ ] Phase 12 follows FR-1539 (never echoes the audit key)
- [ ] Existing wizard phases 1-10 byte-for-byte unchanged
- [ ] All audit-key handling uses file-based or `read -s`-based patterns; no echo-to-stdout commands
- [ ] `markdownlint` passes on all modified files
- [ ] All new sections/phases are additive; no rewrites of existing content
- [ ] Forward references to PLAN-025-3 eval cases use canonical filenames agreed in PLAN-025-3
