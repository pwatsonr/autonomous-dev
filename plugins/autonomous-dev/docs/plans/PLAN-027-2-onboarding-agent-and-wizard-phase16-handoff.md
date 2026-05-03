# PLAN-027-2: Onboarding Agent Extensions + Setup-Wizard Phase-16 Boundary

## Metadata
- **Parent TDD**: TDD-027-assist-agents-wizard-handoff
- **Estimated effort**: 3 days
- **Dependencies**: []
- **Blocked by**: []
- **Coordinated with**: TDD-033 (setup-wizard phase-module runtime; this plan provides the content side of the phase-16 boundary contract)
- **Priority**: P1

## Objective
Extend the `autonomous-dev-assist` onboarding agent for the four new pipeline pause states and the cloud-deploy bridge, author the static phase-16 content the setup wizard will load at runtime, and insert the phase-16 boundary marker into `skills/setup-wizard/SKILL.md`. Activate the `onboarding-questions.yaml` eval suite (currently disabled in `eval-config.yaml`) and seed it with the 4 onboarding cases from TDD-027 §7.2. All agent-prompt edits follow the append-only extension pattern from TDD-027 §4.2 / G-08, preserving the local-only 7-step onboarding path (G-07 / FR-1516). Troubleshooter agent extensions and the 6 troubleshooter eval cases are handled by PLAN-027-1.

## Scope

### In Scope
- `agents/onboarding.md` "Pipeline Pause States" subsection per TDD-027 §5.2.1: an H3 appended after Step 7 and before "After Onboarding". Table with 4 rows: `awaiting-approval`, `cost-cap-tripped`, `firewall-denied`, `cred-proxy-ttl-expired`. Each row cites the corresponding runbook file (owned by TDD-025 / TDD-026) and a verbatim "do NOT" guard where applicable (e.g., "do NOT hand-edit ledger", "do NOT rotate root credentials").
- `agents/onboarding.md` "Appendix: First Cloud Deploy" H2 per TDD-027 §5.2.2 appended after the existing "After Onboarding" section. Lists the 4 prerequisites (cloud plugin, cred-proxy, firewall, dry-run), shows the `/autonomous-dev-assist:setup-wizard --with-cloud` invocation, and explicitly notes that the local-only path remains unchanged.
- No frontmatter `tools` changes to the onboarding agent (TDD-027 §5.2.3): the agent does not invoke `chains` / `deploy` / `cred-proxy` / `firewall` directly; it only points operators at the wizard.
- `instructions/cloud-prompt-tree.md` (new file, ~80 lines) authored per TDD-027 §6.1: the static prompt tree consumed at runtime by the TDD-033 phase-16 module. Sections: Branch A (cloud plugin choice — gcp/aws/azure/k8s/none), Branch B (cred-proxy bootstrap), Branch C (firewall backend selection — Linux→nftables, macOS→pfctl, other→disabled), Branch D (dry-run deploy).
- `skills/setup-wizard/SKILL.md` phase-16 boundary marker per TDD-027 §4.3 / §6.3: an HTML-comment block with the structured `provides` / `consumes` / `runtime owner` / `content owner` keys. Inserted between phase 10 and phase 11 (TDD-033 owns phases 11+). Existing 10 phases of `SKILL.md` unchanged.
- `evals/test-cases/onboarding-questions.yaml` activation: today this file is referenced as `enabled: false` in `eval-config.yaml`. This plan creates the file (or unsuppresses it) and flips the suite to `enabled: true`.
- 4 onboarding eval cases per TDD-027 §7.2 appended to `onboarding-questions.yaml`: `onboard-cloud-001`, `onboard-pause-001`, `onboard-pause-002`, `onboard-pause-003`. Each case has `id`, `difficulty`, `question`, `must_mention`, `must_not_mention` matching the TDD §7.2 table.
- Phase-16 contract self-consistency check (local): grep the boundary marker, parse the `provides` / `consumes` lists, confirm both are non-empty and that `runtime owner: TDD-033` and `content owner: TDD-027` are present per TDD-027 §10.1.

### Out of Scope
- `agents/troubleshooter.md` extensions (file-locations, diagnostic subsections, tool-allowlist additions) — PLAN-027-1
- Troubleshooter eval cases (6 cases) — PLAN-027-1
- The setup-wizard phase-16 runtime: plugin-presence check, OS-detection routing, fail-closed handler, integration with phases 8 / 11-15 — TDD-033 / its plans (NG-01, NG-05 in TDD-027)
- SKILL.md content for chains / deploy / cloud / cred-proxy / firewall — TDD-025 / TDD-026 plans (NG-02 in TDD-027)
- The `chains-runbook.md`, `deploy-runbook.md`, `cred-proxy-runbook.md`, `firewall-runbook.md` instruction files referenced from the new onboarding sections — owned by TDD-025 / TDD-026
- Modifying any of the existing 7 onboarding steps or the existing 10 setup-wizard phases (preservation is mandatory per G-07 / FR-1516)
- Adding new agents (NG-04 in TDD-027)
- Mermaid rendering of the cloud prompt tree (deferred per OQ-2)

## Tasks

1. **Append "Pipeline Pause States" subsection to onboarding.md** — Insert an H3 after Step 7's "What success looks like" section and before "After Onboarding" with the 4-row pause-state table from TDD-027 §5.2.1. Each row's "Operator action" cell quotes the action from TDD-027 verbatim, including the "do NOT hand-edit" / "do NOT rotate root credentials" guards. Closing paragraph points operators at the four runbooks (`deploy-runbook.md`, `firewall-runbook.md`, `cred-proxy-runbook.md`).
   - Files to modify: `plugins/autonomous-dev-assist/agents/onboarding.md`
   - Acceptance criteria: New H3 inserted in document order between Step 7 and "After Onboarding"; existing 7 steps unchanged in order, content, and heading levels. All 4 pause states present with the operator-action wording from TDD-027 §5.2.1. Mandatory guards ("do NOT hand-edit ledger", "do NOT rotate root credentials") appear verbatim. Runbook pointers present.
   - Estimated effort: 1.5h

2. **Append "First Cloud Deploy" H2 appendix to onboarding.md** — Append the H2 after "After Onboarding" per TDD-027 §5.2.2. Lists the 4 prerequisites (cloud plugin install, cred-proxy bootstrap, firewall init, dry-run), shows the `/autonomous-dev-assist:setup-wizard --with-cloud` invocation, and includes the explicit "the local-only path you completed in steps 1-7 is unaffected" reassurance per G-07 / FR-1516.
   - Files to modify: `plugins/autonomous-dev-assist/agents/onboarding.md`
   - Acceptance criteria: New H2 appended at end-of-file (or before any existing trailing reference block). The 4 prerequisites listed in order. The wizard invocation `/autonomous-dev-assist:setup-wizard --with-cloud` is verbatim. Local-only-unaffected reassurance present. Pointers to all 4 runbooks present (chains, deploy, cred-proxy, firewall) citing the owning TDD anchors.
   - Estimated effort: 1h

3. **Append-only verification of onboarding.md** — Local diff check confirms: existing 7 steps unchanged, frontmatter `name`/`description`/`tools` byte-identical to `main`, "After Onboarding" section preserved, no H2 reordering. Records the result in the PR description.
   - Files to create: none (validation-only)
   - Acceptance criteria: `git diff main -- plugins/autonomous-dev-assist/agents/onboarding.md` shows only insertions in the body. Frontmatter is byte-identical. No section reordering. Result recorded in PR.
   - Estimated effort: 0.5h

4. **Author `instructions/cloud-prompt-tree.md`** — Create a new file at `plugins/autonomous-dev-assist/instructions/cloud-prompt-tree.md` with the prompt tree from TDD-027 §6.1 verbatim. Sections: H1 title, Branch A (cloud plugin choice + 5 options + plugin-not-installed handling), Branch B (cred-proxy bootstrap conditional on `cred-proxy doctor` health), Branch C (firewall backend by OS: Linux=nftables, macOS=pfctl, other=disabled+warn), Branch D (dry-run `deploy plan REQ-WIZARD-DRYRUN --env staging --dry-run`).
   - Files to create: `plugins/autonomous-dev-assist/instructions/cloud-prompt-tree.md`
   - Acceptance criteria: File exists and matches TDD-027 §6.1 content. All 4 branches present with the specified options and OS-detection table. ~80 lines total. Markdown renders without lint errors. No verbatim cloud secrets, tenant IDs, or example credentials (per TDD-027 §8.1 / §8.2).
   - Estimated effort: 1.5h

5. **Insert phase-16 boundary marker into setup-wizard/SKILL.md** — Add the HTML-comment marker block per TDD-027 §4.3 / §6.3 between phase 10 and the (TDD-033-owned) phase 11. The block contains: `BEGIN PHASE-16 CONTRACT (TDD-027 §6 ↔ TDD-033 §5)`, structured `provides:` list (`cloud-prompt-tree.md`, `phase-16-content.md`), structured `consumes:` list (3 runtime checks), `runtime owner: TDD-033`, `content owner: TDD-027`, and `END PHASE-16 CONTRACT`. Phases 1–10 unchanged.
   - Files to modify: `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md`
   - Acceptance criteria: The marker block is inserted exactly once at the boundary between phase 10 and the next phase. All 4 fields (`provides`, `consumes`, runtime owner, content owner) present and non-empty. Existing phases 1–10 byte-identical to `main`. The marker is invisible in rendered Markdown (HTML comment), but `grep "PHASE-16 CONTRACT"` returns exactly 2 lines (BEGIN + END).
   - Estimated effort: 1h

6. **Phase-16 contract self-consistency check (local)** — Run a small local script or manual walk: `grep -n "PHASE-16 CONTRACT" SKILL.md` returns BEGIN/END pair; the block parses with non-empty `provides` and `consumes` lists; `runtime owner: TDD-033` and `content owner: TDD-027` are present. Records the check output in the PR description.
   - Files to create: none (validation-only; optionally a one-shot `scripts/check-phase-16-contract.sh` for re-use, but not required for this plan)
   - Acceptance criteria: All 4 contract assertions pass. Result recorded in the PR description. Future enforcement is delegated to the reviewer agent (TDD-027 §10.1) without blocking this plan.
   - Estimated effort: 0.5h

7. **Activate `onboarding-questions.yaml` suite + author 4 cases** — Create or unsuppress `plugins/autonomous-dev-assist/evals/test-cases/onboarding-questions.yaml` and flip the corresponding `eval-config.yaml` entry from `enabled: false` to `enabled: true`. Append the 4 cases from TDD-027 §7.2 (`onboard-cloud-001`, `onboard-pause-001`, `onboard-pause-002`, `onboard-pause-003`), each with `id`, `difficulty`, `question`, `must_mention`, `must_not_mention` matching the table verbatim. Schema is the same as `troubleshoot-scenarios.yaml` (FR-1536).
   - Files to create / modify: `plugins/autonomous-dev-assist/evals/test-cases/onboarding-questions.yaml`, `plugins/autonomous-dev-assist/evals/eval-config.yaml`
   - Acceptance criteria: `eval-config.yaml` shows the suite as `enabled: true`. The YAML file contains exactly 4 cases with the specified ids. Each case's `must_mention` / `must_not_mention` matches TDD-027 §7.2 verbatim (e.g., `onboard-pause-002` mentions `deploy approve` and `expected for prod`, forbids `force-approve`). YAML validates against the existing eval-case schema.
   - Estimated effort: 2h

8. **Smoke-run new onboarding cases (manual)** — Run the 4 new onboarding cases against the updated `agents/onboarding.md` via PLAN-017-3's eval runner. Spot-check ≥3/4 pass (≥75% on this micro-sample). Failing cases noted as risks; regression baseline is set by PLAN-017-3 / TDD-028.
   - Files to create: none (smoke run only); results in PR body
   - Acceptance criteria: 3 of 4 cases pass first run, OR failures triaged with prompt-tuning notes for follow-up. No regression on existing assist-evals suites.
   - Estimated effort: 1h

9. **Coordination note for TDD-033** — In the PR description, link to the new `cloud-prompt-tree.md` and the SKILL.md marker block; flag that TDD-033's phase-16 runtime can now consume them. No code coordination needed (per TDD-027 §15: either TDD can land first; the marker block is forward-compatible).
   - Files to create: none (PR-description content only)
   - Acceptance criteria: PR description contains: (a) absolute path to `cloud-prompt-tree.md`, (b) line-anchor for the SKILL.md marker block, (c) explicit statement "TDD-033 may consume" with anchor reference. Open questions OQ-2 (Mermaid) and OQ-4 (TDD-033-first ordering) are noted as deferred.
   - Estimated effort: 0.25h

## Dependencies & Integration Points

**Exposes to other plans:**
- `instructions/cloud-prompt-tree.md` — consumed at runtime by TDD-033 phase-16 module (per TDD-027 §6.1 / §15).
- `skills/setup-wizard/SKILL.md` phase-16 marker — verified by TDD-033's runtime before invoking phase 16; verified by the standards-meta-reviewer (PLAN-021-3) for well-formedness.
- The 4 new onboarding eval cases extend the regression baseline that PLAN-017-3's assist-evals workflow gates on.
- The "Pipeline Pause States" subsection's runbook pointers create back-links that TDD-025 / TDD-026 plans satisfy when they ship the runbook files.

**Consumes from other plans:**
- TDD-022 / its plans: pause-state semantics for `awaiting-approval` (chains).
- TDD-023 / its plans: pause-state semantics for `awaiting-approval` (deploy) and `cost-cap-tripped`; ledger format reference.
- TDD-024 / its plans: pause-state semantics for `firewall-denied` and `cred-proxy-ttl-expired`; firewall-backend / OS-routing matrix consumed by Branch C.
- TDD-025 / its plans: `cred-proxy bootstrap`, `firewall init`, runbook files (`cred-proxy-runbook.md`, `firewall-runbook.md`).
- TDD-026 / its plans: runbook files (`chains-runbook.md`, `deploy-runbook.md`).
- TDD-033 / its plans: phase-16 runtime that loads `cloud-prompt-tree.md` and verifies the boundary marker.
- PLAN-017-3 (assist-evals workflow): runs the activated `onboarding-questions.yaml` suite on PR + nightly cron.
- PLAN-021-3 (standards-meta-reviewer): enforces append-only on `onboarding.md` and well-formedness of the phase-16 marker.

## Testing Strategy

- **Static / structural validation (tasks 3, 6):** `git diff` confirms append-only on `onboarding.md`; existing 10 wizard phases byte-identical; phase-16 marker block well-formed (BEGIN/END pair, non-empty `provides` / `consumes`, both owners cited).
- **YAML-schema validation:** `onboarding-questions.yaml` validates against the existing eval-case schema. `eval-config.yaml` continues to validate after the `enabled: true` flip.
- **Eval suite smoke (task 8):** Run the 4 new onboarding cases via PLAN-017-3's runner; expect ≥3/4 pass on first run, with any failures triaged.
- **Regression:** All existing assist-evals suites (config-questions, help-questions, setup-wizard-questions, troubleshoot-scenarios, the four reviewer-eval suites) continue to pass at the existing thresholds.
- **Local-only path preservation:** Manual walk of the 7-step onboarding flow (steps 1–7 only, ignoring the new pause-states subsection and cloud-deploy appendix) confirms no behavior change for the operator who never touches cloud features.
- **Phase-16 contract grep test:** `grep -c "PHASE-16 CONTRACT" SKILL.md` returns 2; both lines parse cleanly.
- **Pre-merge meta-review:** Run the standards-meta-reviewer (PLAN-021-3) against `onboarding.md` and `SKILL.md` diffs to verify the append-only pattern (TDD-027 §4.2 / G-08) and the contract block (TDD-027 §10.1).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| The "Pipeline Pause States" subsection inserts at the wrong location, splitting Step 7 from "After Onboarding" with mismatched heading levels | Low | Medium — onboarding flow looks broken | Task 3's diff check confirms "After Onboarding" still follows the new H3 (not before). Reviewer eyeballs the rendered table-of-contents. |
| The phase-16 marker block syntax drifts from what TDD-033's runtime parses, causing runtime to fail the contract check | Medium | High — runtime aborts phase 16 even when content is present | Task 5 quotes the marker syntax verbatim from TDD-027 §4.3. Task 6 runs the parse check locally. TDD-033 plans cite TDD-027 §6 as their input contract; coordination via the per-TDD anchor pattern. |
| `cloud-prompt-tree.md` content goes stale when cloud plugin set changes (e.g., Oracle Cloud added) | Medium | Low — prompt tree is missing an option but not broken | The prompt tree's Branch A explicitly lists 4 plugins + a `none` escape. Adding a new cloud is a one-line append in a future plan, no schema change required. |
| Activating `onboarding-questions.yaml` exposes a previously-hidden eval-runner bug (suite was disabled for a reason) | Low | Medium — assist-evals workflow flaps on first run | Task 7 coordinates with PLAN-017-3's runner. Task 8 smoke-runs the cases before merge. If the runner has a bug, file a follow-up against PLAN-017-3 rather than blocking this plan. |
| The "First Cloud Deploy" appendix's `--with-cloud` flag does not exist yet (TDD-033 owns the runtime) — operators who try it before TDD-033 lands see a "no such flag" error | Medium | Low — onboarding text references a forward command | Per TDD-027 §15, the two TDDs land independently; the appendix is forward-compatible documentation. Until TDD-033 ships, the operator hitting `--with-cloud` sees a clear error and can fall back to the runbook pointers. Acceptable per OQ-3 (closed). |
| The "do NOT" guards in the pause-state table are softened during editing, regressing eval `onboard-pause-001` (which forbids `set --cost-cap 0`) | Low | Medium — eval flap | Task 1 quotes operator actions verbatim from TDD-027 §5.2.1; eval `must_not_mention` strings are taken from TDD §7.2; both rooted in the same TDD source. Standards-meta-reviewer audits the diff. |
| Phase-16 boundary marker conflicts with another marker convention introduced later (e.g., a different TDD adds a different `<!-- BEGIN ... -->` block) | Low | Low — grep ambiguity | Marker uses fully-qualified label `PHASE-16 CONTRACT (TDD-027 §6 ↔ TDD-033 §5)` per TDD-027 §4.3, which uniquely identifies it. Reviewer agent enforces uniqueness. |

## Definition of Done

- [ ] `agents/onboarding.md` "Pipeline Pause States" H3 appended with all 4 rows and verbatim guards
- [ ] `agents/onboarding.md` "Appendix: First Cloud Deploy" H2 appended with 4 prerequisites, wizard invocation, and local-only-unaffected reassurance
- [ ] `agents/onboarding.md` frontmatter unchanged (no tool-allowlist additions per TDD-027 §5.2.3)
- [ ] Existing 7 onboarding steps and "After Onboarding" section byte-identical to `main`
- [ ] `instructions/cloud-prompt-tree.md` exists with all 4 branches per TDD-027 §6.1
- [ ] `skills/setup-wizard/SKILL.md` phase-16 marker block inserted between phase 10 and phase 11; existing phases 1–10 byte-identical to `main`
- [ ] Marker block contains non-empty `provides` and `consumes` lists, plus `runtime owner: TDD-033` and `content owner: TDD-027`
- [ ] `grep -c "PHASE-16 CONTRACT" SKILL.md` returns 2
- [ ] `evals/test-cases/onboarding-questions.yaml` exists with 4 cases matching TDD-027 §7.2 ids and content
- [ ] `eval-config.yaml` shows `onboarding-questions` suite as `enabled: true`
- [ ] Smoke run of the 4 new cases (task 8) passes ≥3/4, or failures triaged
- [ ] Existing assist-evals suites (config / help / setup-wizard / troubleshoot / reviewer) continue to pass
- [ ] PR description records the phase-16 contract self-check output and the TDD-033 coordination note
- [ ] PR description cross-links TDD-027 §5.2, §6, §7.2, §10.1, §15
