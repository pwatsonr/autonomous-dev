# PLAN-025-1: Help + Config-Guide + Assist Surface for Cloud Backends and Cred-Proxy

## Metadata
- **Parent TDD**: TDD-025-assist-cloud-credproxy-surface
- **Estimated effort**: 4 days
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P0

## Objective
Deliver the foundational documentation surface in `autonomous-dev-assist` that operators query first when they encounter a cred-proxy or cloud-backend question: the new "Cloud Backends" and "Credential Proxy" H2 sections in `skills/help/SKILL.md` (FR-1504, FR-1505), the new `cred_proxy` section in `skills/config-guide/SKILL.md` (FR-1510), and the classification + Glob + Bash extensions in `commands/assist.md` (FR-1522 partial, FR-1523 partial) that route security-class questions to the new content. Also adds the three `troubleshooter.md` file-locations rows for `~/.autonomous-dev/cred-proxy/{socket,audit.log,scopers}` (FR-1518 cred-proxy portion). Setup-wizard phases, the cred-proxy runbook, the troubleshoot scenario authoring, and the eval suite are layered in by sibling plans.

## Scope
### In Scope
- `skills/help/SKILL.md` new H2 **"Cloud Backends"** section per TDD §6.1 with five subsections: "What are the cloud backends?", "Installation", "Capability declarations" (reference table for the four plugin names + backends + tooling), "Egress allowlist defaults" (one-paragraph mention with pointer to TDD-028), and "See also" linking to deploy-runbook and the Credential Proxy section.
- `skills/help/SKILL.md` new H2 **"Credential Proxy"** section per TDD §6.2 with seven subsections: "What is the credential proxy?", "The six CLI subcommands" (reference table per TDD §3.2), "The four scopers" (per-cloud scoper plugin names and what each translates), "TTL and auto-revoke" (15-min default, FD-close on expiry), "The per-issuance audit hash" (chained HMAC; do-not-delete warning matching the chains warning style), "SCM_RIGHTS in plain English" (two-sentence FD-passing explanation), and "See also" linking to `cred-proxy-runbook` and `cred_proxy` config-guide.
- `skills/config-guide/SKILL.md` new `cred_proxy` H2 section per TDD §5.2 + §6.3 documenting socket path with mode-0600 contract, `default_ttl_seconds: 900`, `audit_log` path, `audit_key_env` env-var-name convention (explicit warning that this is the env var *name*, not the key), per-cloud scoper paths, `max_concurrent_tokens`, a complete YAML example block, and a "common pitfalls" subsection (do not commit the audit key; do not chmod the socket as root).
- `commands/assist.md` Step 1 classification updates per TDD §6.6: add `security` as a recognized top-level category with `cred-proxy`, `socket`, `TTL`, `scoper` keyword subclassing.
- `commands/assist.md` Step 2 Glob updates per TDD §6.6: add `plugins/autonomous-dev/intake/cred-proxy/*`, `plugins/autonomous-dev-deploy-{gcp,aws,azure,k8s}/`, and `plugins/autonomous-dev-assist/instructions/cred-proxy-runbook.md` to the discovery glob set.
- `commands/assist.md` Step 2 Bash additions: `ls -l ~/.autonomous-dev/cred-proxy/socket 2>/dev/null` and `cred-proxy status 2>/dev/null` (both non-fatal if missing). Platform-aware `stat` invocation: `stat -f "%Sp %u %g"` on macOS, `stat -c "%a %u %g"` on Linux, selected via `uname` detection.
- `agents/troubleshooter.md` file-locations table additions per TDD §6.5: three rows for `~/.autonomous-dev/cred-proxy/socket`, `~/.autonomous-dev/cred-proxy/audit.log`, `~/.autonomous-dev/cred-proxy/scopers/<cloud>` plus the `cred-proxy doctor` and `cred-proxy doctor --verify-audit` rows in the chain-and-deploy diagnostics subsection.
- All section additions are **additive** (no rewrites of existing text). Existing operators reading `help/SKILL.md` see new H2 sections appended; existing `config-guide/SKILL.md` sections are unchanged.
- Cross-references audited: every "see also" link points to a file that exists either on `main` or in a sibling plan's deliverable; broken links fail the plan's review.

### Out of Scope
- `instructions/cred-proxy-runbook.md` authoring -- PLAN-025-2 (the runbook body is referenced from the SKILL "see also" link, but creation belongs to the runbook plan)
- `skills/setup-wizard/SKILL.md` phases 11 and 12 -- PLAN-025-2
- `skills/troubleshoot/SKILL.md` scenario authoring (permission-denied + TTL-expired-mid-deploy) -- PLAN-025-2
- `evals/test-cases/cred-proxy-eval.yaml` authoring and the regression run -- PLAN-025-3
- Firewall and cost-estimation surface -- TDD-028 / PLAN-028-*
- `--with-cloud` flag wiring in `quickstart.md` -- TDD-026 / PLAN-026-*
- Pinning TDD-024 SHAs (FR-1540 NG-05)
- Wrapping `cred-proxy doctor` as a slash command (PRD-015 NG-02; TDD-025 NG-06)
- Deep K8s service-account-token-projection coverage (TDD-025 NG-07)
- Modifying TDD-024 cred-proxy semantics, scoper logic, or socket transport (TDD-025 NG-01)

## Tasks

1. **Author the "Cloud Backends" H2 section in `help/SKILL.md`** -- Append a new H2 section after the last existing top-level section. Five subsections per TDD §6.1. The capability-declarations table covers all four plugins (`autonomous-dev-deploy-gcp/aws/azure/k8s`) with backend name, services supported (GCE/Cloud Run/GKE; EC2/ECS/EKS/Lambda; App Service/AKS; generic K8s), and tool dependency (`gcloud`, `aws`, `az`, `kubectl`).
   - Files to modify: `plugins/autonomous-dev-assist/skills/help/SKILL.md`
   - Acceptance criteria: New H2 "Cloud Backends" exists. All four plugin names appear with correct backend metadata. Installation subsection uses `claude plugin install autonomous-dev-deploy-<cloud>` syntax. Egress-allowlist mention is one paragraph with a TDD-028 pointer. Existing sections unchanged. Markdown lints (existing `markdownlint` config) pass.
   - Estimated effort: 4h

2. **Author the "Credential Proxy" H2 section in `help/SKILL.md`** -- Append after task 1's section. Seven subsections per TDD §6.2. The six-CLI-subcommands table mirrors TDD §3.2 exactly: `start`, `stop`, `status`, `doctor`, `issue <cloud> <scope>`, `revoke <token-id>`. The audit-hash subsection includes the matching warning style used in the chains audit-log section: **"do not delete the audit log."** in bold. The SCM_RIGHTS subsection is exactly two sentences and explains FD-passing without bogging into POSIX internals (per TDD §11.2 trade-off).
   - Files to modify: `plugins/autonomous-dev-assist/skills/help/SKILL.md`
   - Acceptance criteria: New H2 "Credential Proxy" exists. All six subcommands listed correctly. All four scopers (`cred-proxy-scoper-{aws,gcp,azure,k8s}`) named. TTL of 15 minutes (`900` seconds) called out explicitly. Audit-hash warning text matches the chains-audit warning style verbatim. SCM_RIGHTS subsection is 2 sentences and uses the phrases "file-descriptor passing" and "Unix socket" (these phrases are eval-asserted in PLAN-025-3 case `credproxy-concept-scm-001`). "See also" links resolve.
   - Estimated effort: 4h

3. **Author the `cred_proxy` section in `config-guide/SKILL.md`** -- New H2 section per TDD §5.2 + §6.3. Includes the full YAML example block from TDD §5.2 (socket_path, default_ttl_seconds, audit_log, audit_key_env, scopers map, max_concurrent_tokens). Documents the env-var-name convention with a worked example: `export CRED_PROXY_AUDIT_KEY="$(openssl rand -hex 32)"` then `audit_key_env: CRED_PROXY_AUDIT_KEY`. "Common pitfalls" subsection covers: do not commit the audit key (with `.gitignore` recommendation); do not chmod the socket as root; do not run `cred-proxy start` as root.
   - Files to modify: `plugins/autonomous-dev-assist/skills/config-guide/SKILL.md`
   - Acceptance criteria: YAML example validates against the schema described in TDD §5.2. Default TTL is `900` (not `15m` or another format). `audit_key_env` documentation explicitly says "stores the *name* of an environment variable, not the key itself" verbatim per TDD §5.2. Socket-path mode-0600 contract called out. All four scoper paths listed. Common-pitfalls subsection has at least three bullets.
   - Estimated effort: 4h

4. **Extend `commands/assist.md` Step 1 with `security` classification** -- Add `security` as a recognized classification category alongside the existing categories. Document the keyword-subclassing rule: questions containing `cred-proxy`, `socket`, `TTL`, or `scoper` route to security/cred-proxy. Update any classification-decision lookup table or worked example.
   - Files to modify: `plugins/autonomous-dev-assist/commands/assist.md`
   - Acceptance criteria: New `security` category appears in Step 1's category list. Subclassing keywords documented exactly per TDD §6.6. Existing classification rules unchanged. The classification example (if one exists) shows a security-class routing.
   - Estimated effort: 2h

5. **Extend `commands/assist.md` Step 2 Glob discovery** -- Add three glob entries: `plugins/autonomous-dev/intake/cred-proxy/*`, `plugins/autonomous-dev-deploy-{gcp,aws,azure,k8s}/`, `plugins/autonomous-dev-assist/instructions/cred-proxy-runbook.md`. The deploy-plugin glob doubles as an installed-clouds discovery probe (assist will know which clouds the operator has by the presence of these directories).
   - Files to modify: `plugins/autonomous-dev-assist/commands/assist.md`
   - Acceptance criteria: All three globs added to the Step 2 Glob list. Brace-expansion `{gcp,aws,azure,k8s}` syntax validated against the assist agent's glob library (existing assist agent uses the same syntax for other multi-target globs). Order in the list groups them logically with the existing intake globs.
   - Estimated effort: 1.5h

6. **Extend `commands/assist.md` Step 2 Bash with platform-aware probes** -- Add `ls -l ~/.autonomous-dev/cred-proxy/socket 2>/dev/null` and `cred-proxy status 2>/dev/null` to the Step 2 Bash list. Document the platform-aware `stat` invocation using the `uname` detection pattern: `[[ "$(uname)" == "Darwin" ]] && stat -f "%Sp %u %g" "$socket" || stat -c "%a %u %g" "$socket"`. Both probes are explicitly non-fatal (the `2>/dev/null` redirect is required) so a missing daemon does not break the assist flow.
   - Files to modify: `plugins/autonomous-dev-assist/commands/assist.md`
   - Acceptance criteria: Both new Bash invocations listed. Platform detection documented as a single-line idiom. The non-fatal contract called out so future authors do not strip the redirect. The Bash invocations stay within the existing assist.md frontmatter allowlist (no new tool grants needed; `ls`, `stat`, and `cred-proxy` should already be permitted via the read-only-shell allowlist).
   - Estimated effort: 1.5h

7. **Extend `troubleshooter.md` file-locations table** -- Add three rows per TDD §6.5: `~/.autonomous-dev/cred-proxy/socket` (Unix-domain socket; mode 0600, owner-only); `~/.autonomous-dev/cred-proxy/audit.log` (HMAC-chained audit log; verify with `cred-proxy doctor --verify-audit`); `~/.autonomous-dev/cred-proxy/scopers/<cloud>` (per-cloud scoper plugin install path). Also add `cred-proxy doctor` and `cred-proxy doctor --verify-audit` to the chain-and-deploy diagnostics subsection (FR-1519 portion).
   - Files to modify: `plugins/autonomous-dev-assist/agents/troubleshooter.md`
   - Acceptance criteria: All three file-location rows present with the canonical paths. Mode 0600 called out for the socket. The diagnostics subsection lists both `cred-proxy doctor` (full diagnostic) and `cred-proxy doctor --verify-audit` (audit-hash verification) as separate entries. Existing file-locations rows untouched.
   - Estimated effort: 2h

8. **Cross-reference and link audit** -- After tasks 1-7 land, walk every "see also" pointer in the new sections and verify the target exists either on `main` or in a sibling plan's contract. Targets that depend on PLAN-025-2 (cred-proxy-runbook) and PLAN-025-3 (eval cases) are flagged as forward references — link text uses the canonical filename so the link will resolve once the sibling plan ships.
   - Files to modify: None (verification only; may produce a small follow-up commit fixing typos)
   - Acceptance criteria: All in-plan cross-references resolve to extant content. Forward references to PLAN-025-2/3 deliverables use canonical filenames listed in those plans. No broken `[text](path)` links in the rendered Markdown.
   - Estimated effort: 1h

## Dependencies & Integration Points

**Exposes to other plans:**
- The "Credential Proxy" SKILL section provides the canonical operator-facing descriptions of TTL, scopers, audit hash, and SCM_RIGHTS that PLAN-025-2's runbook expands and PLAN-025-3's eval cases assert against.
- The `cred_proxy` config-guide section is the source-of-truth schema reference; PLAN-025-2's setup-wizard phase 12 verifies operators against this schema.
- Classification + Glob updates in `commands/assist.md` enable PLAN-025-3's eval cases to actually retrieve the new content during their runs (without these glob additions, the eval cases would silently miss the new SKILL sections and degrade in scoring).
- `troubleshooter.md` file-locations table is the canonical surface for any future sibling plan that adds new `~/.autonomous-dev/` paths.

**Consumes from other plans:**
- **TDD-024 §6** for the cloud backend plugin metadata (names, services, tool dependencies).
- **TDD-024 §7-§10** for cred-proxy semantics (TTL, scopers, audit log, SCM_RIGHTS).
- **TDD-022 §14** (chains audit-log) for the warning-style template that is reused verbatim for the cred-proxy audit-log warning.
- **TDD-025 §6.6** for the assist.md classification + Glob + Bash extension specification.

## Testing Strategy

- **Markdown lint:** `markdownlint` (existing config) must pass on all modified files. Catches duplicate heading IDs and broken-link patterns.
- **Schema validation:** The YAML example in the new `cred_proxy` config-guide section is parsed and validated against the documented schema. A small fixture-based test (or manual verification in the PR) confirms the YAML round-trips through `js-yaml` (or the equivalent existing YAML parser used by autonomous-dev tests) without errors.
- **Cross-reference audit (task 8):** Every `[text](path)` link in the new sections is checked against the filesystem (or against sibling-plan contracts for forward references). This is a manual review-time check.
- **No code-path tests:** This plan ships only documentation. Behavioural validation lives in PLAN-025-3's eval suite, which exercises the assist agent against the new content end-to-end.
- **Regression:** No regression tests required at this layer — the existing 90-case assist regression suite (run by sibling plans 025/026 + this TDD's 028 sibling) will fail if these documentation changes break classification or retrieval.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Markdown linter rejects new H2 headings due to a duplicate-slug collision with an existing section (e.g., a different "See also" anchor) | Low | Low -- author fixes during review | The existing `help/SKILL.md` and `config-guide/SKILL.md` already have multiple "See also" subsections; the linter config has been validated against these. New sections follow the same heading style. |
| The `audit_key_env: CRED_PROXY_AUDIT_KEY` documentation is misread by an operator who pastes the raw HMAC key into the YAML | Medium | High -- credential leak in repo | Task 3 explicitly says "stores the *name* of an environment variable, not the key itself" verbatim per TDD §5.2. Common-pitfalls subsection repeats this. PLAN-025-3 eval case `credproxy-concept-audit-key-001` (defined in that plan) tests the assist agent's response on this exact misconception. |
| Glob `plugins/autonomous-dev-deploy-{gcp,aws,azure,k8s}/` matches before any of the four plugins are installed; assist returns "no clouds installed" when the operator has only one cloud | Medium | Low -- operator confusion | The glob is non-fatal (matches zero or more directories). Assist's response logic should treat the missing-directory case as "operator has not installed this cloud" rather than "no clouds." Task 5 calls this out in the Glob comment. PLAN-025-3 eval case for "I only installed GCP, why does assist mention AWS?" covers this. |
| TDD-024's actual scoper plugin names diverge from `cred-proxy-scoper-<cloud>` between TDD-025 authorship and PR-time | Medium | Medium -- doc drift | Task 2 acceptance criteria explicitly cites TDD §3.2 names. Spec-phase author re-reads TDD-024 §8 at PR time per TDD-025 R-3. If names diverge, this plan's PR is updated before merge. |
| Platform-aware `stat` invocation in task 6 is wrong on a third platform (e.g., FreeBSD operator) | Low | Low -- assist falls through | The `2>/dev/null` redirect ensures a non-Darwin/non-Linux platform fails silently rather than crashing. The assist response logic still works (no socket info, but other diagnostics run). FreeBSD support is not committed by PRD-015. |
| Forward references to `cred-proxy-runbook.md` (delivered by PLAN-025-2) appear as broken links if PLAN-025-2 slips | Medium | Low -- linter warning, not failure | The link target uses the canonical filename agreed in PLAN-025-2's contract. Markdown linter is configured to allow forward references in this repo (existing pattern). If PLAN-025-2 slips materially, this plan's PR is held until the runbook lands. |

## Definition of Done

- [ ] `help/SKILL.md` has a new "Cloud Backends" H2 with five subsections per TDD §6.1
- [ ] `help/SKILL.md` has a new "Credential Proxy" H2 with seven subsections per TDD §6.2
- [ ] `config-guide/SKILL.md` has a new `cred_proxy` H2 section per TDD §5.2 + §6.3 with a complete YAML example block
- [ ] `commands/assist.md` Step 1 recognizes `security` as a classification category with `cred-proxy`/`socket`/`TTL`/`scoper` keyword subclassing
- [ ] `commands/assist.md` Step 2 includes the three new Glob entries and the two new Bash probes (with platform-aware `stat`)
- [ ] `troubleshooter.md` file-locations table has three new cred-proxy rows plus `cred-proxy doctor` + `cred-proxy doctor --verify-audit` diagnostics rows
- [ ] All new sections include "See also" links and every link resolves (or is documented as a forward reference)
- [ ] `audit_key_env` field documented as the *name* of an env var, not the value (per TDD §5.2)
- [ ] All four scopers named: `cred-proxy-scoper-{aws,gcp,azure,k8s}`
- [ ] All four cloud-backend plugins named: `autonomous-dev-deploy-{gcp,aws,azure,k8s}`
- [ ] Audit-log warning text in the SKILL "Credential Proxy" section matches the chains audit-log warning style verbatim
- [ ] `markdownlint` passes on all modified files
- [ ] No existing sections rewritten; all changes are additive
