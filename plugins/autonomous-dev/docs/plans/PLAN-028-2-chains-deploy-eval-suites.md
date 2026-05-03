# PLAN-028-2: Chains and Deploy Eval Suite Frontmatter

## Metadata
- **Parent TDD**: TDD-028-assist-evals-readme-cross-cutting
- **Estimated effort**: 2 days
- **Dependencies**: [PLAN-028-1]
- **Blocked by**: [PLAN-028-1]
- **Priority**: P1

## Objective
Author the `chains-eval.yaml` and `deploy-eval.yaml` suite files for the autonomous-dev-assist plugin: their frontmatter (per the schema-lock contract from PLAN-028-1), the canonical category set per surface, and the `must_not_mention` negative-pattern bag that targets the dominant hallucinations on each surface. The case bodies (the actual `question` / `expected_topics` / `must_mention` content) are owned by sibling TDD-026 (chains and deploy SKILLs). This plan is the **container and contract**: when TDD-026 lands its case bodies, they slot into these files without further structural change. The meta-lint authored in PLAN-028-1 will hard-fail if either suite has fewer cases than the FR minimum (chains ≥20 per FR-1532; deploy ≥30 per FR-1533) or fewer than 5 negative cases — so this plan ships an initial seed of negative cases derived from the catastrophic-command list in TDD-028 §10.1, which guarantees the negative floor is always met regardless of case-body progress on the sibling side.

## Scope
### In Scope
- Author `plugins/autonomous-dev-assist/evals/test-cases/chains-eval.yaml` with frontmatter per TDD-028 §5.2: `suite: chains`, `skill: assist`, `description:` one-sentence purpose, `schema: eval-case-v1`, `case_minimum: 20`, `negative_minimum: 5`. Cases section starts empty (sibling-populated) but with at least 5 seed **negative-only** cases (cases whose primary purpose is to assert a `must_not_mention` regex matches catastrophic-command hallucinations) so meta-lint passes immediately.
- Author `plugins/autonomous-dev-assist/evals/test-cases/deploy-eval.yaml` with the analogous frontmatter: `case_minimum: 30`, `negative_minimum: 5`, plus 5 seed negative cases.
- Negative-case content for chains: target hallucinations including `chains rotate-key` (no such command — would lose chain integrity), `chains.*delete-history`, `chains.*reset-audit`, `rm.*audit\.log`, `chains init --force-overwrite` (hallucinated flag).
- Negative-case content for deploy: target hallucinations including `deploy.*--skip-validation`, `deploy.*edit.*ledger\.json` (operators must never hand-edit the ledger), `deploy rollback --no-confirm`, `deploy.*--bypass-firewall`, `deploy.*reset-cred-cache` (hallucinated command).
- Each negative-case file uses category `negative` or `warning` from the enum; difficulty `medium` by default; `must_mention` empty array (the case is purely a hallucination guard); `must_not_mention` populated with the catastrophic-pattern regex set.
- Worked-example case (1 happy-path case per suite): the first non-negative case in each file is a worked example showing the expected pattern (`category: command-syntax` for chains; `category: happy-path` for deploy). This is a documentation aid for sibling authors and counts toward `case_minimum` once they author the rest.
- Cross-link in each file's header comment block to the owning sibling TDD: `# Cases authored by TDD-026 (chains-deploy-cli-surfaces). See sibling TDD §<N>.<N> for the case taxonomy.` so a future contributor reading the file knows where the canonical content list lives.
- Update `plugins/autonomous-dev-assist/evals/eval-config.yaml` only if PLAN-028-1's registration left the file paths blank or commented; otherwise no further config edits.
- Verify meta-lint passes on the seeded files: `case_minimum` is documented but not yet met (will fail until sibling TDD-026 lands case bodies) — **this is expected**. Per TDD-028 §15.4, the eval-baseline run before sibling content is "expected to fail"; the failure is the proof that the schema and lint are doing useful work. Capture this baseline failure in the PR description as evidence.
- Coordination note appended to the PR body listing the exact case-count gap (chains: 6 seeded / 20 required; deploy: 6 seeded / 30 required) so TDD-026 sibling owners know the precise scope of their populate task.

### Out of Scope
- The bulk of case bodies (questions, expected_topics, must_mention) for happy-path/concept-explanation/troubleshoot-scenario cases — owned by sibling TDD-026.
- The cred-proxy and firewall eval suites — owned by PLAN-028-3.
- Schema, meta-lint, eval-config registration, runner.sh changes — owned by PLAN-028-1.
- README, agent-count, runbook See-also — owned by PLAN-028-4.
- Modifying the existing 90 reviewer-eval cases or the four existing assist suites (regression-stable contract per TDD-028 NG-07).
- Authoring sibling TDD-026 SKILL content (TDD-026 §<N> sections about chains/deploy).
- Tuning the 95% per-suite threshold — locked at PLAN-028-1.

## Tasks

1. **Author `chains-eval.yaml` frontmatter and seed** — Create the file with the exact frontmatter shape from TDD-028 §5.2. `suite: chains`, `skill: assist`, `schema: eval-case-v1`, `case_minimum: 20`, `negative_minimum: 5`. The `description:` is "Validates that assist answers chain-related operator questions correctly without hallucinating destructive commands or non-existent flags." Add a header comment block linking to TDD-026 as the case-body owner.
   - Files to create: `plugins/autonomous-dev-assist/evals/test-cases/chains-eval.yaml`
   - Acceptance criteria: File is valid YAML; meta-lint frontmatter check passes (all four required frontmatter keys present and well-typed); meta-lint case-count check fails (0 cases < 20) — expected baseline failure documented in the PR.
   - Estimated effort: 1h

2. **Seed 5 chains negative cases** — Append 5 cases to `chains-eval.yaml`, each with `category: negative` or `warning`, `difficulty: medium`, an empty `must_mention: []`, and a `must_not_mention:` regex bag covering: (a) `chains rotate-key` (b) `delete-history` patterns (c) `reset-audit` patterns (d) `rm.*audit\.log` (e) `chains init --force-overwrite`. Each case has a question framed to elicit the hallucination (e.g., "How do I rotate the chain signing key?" — correct answer mentions there is no rotate-key command and references the runbook recovery procedure; hallucinated answer would invent `chains rotate-key`).
   - Files to modify: `plugins/autonomous-dev-assist/evals/test-cases/chains-eval.yaml`
   - Acceptance criteria: 5 cases pass JSON-schema validation. Each case has a unique `id` matching `chains-negative-001..005` or `chains-warning-001..005`. Negative regex bag covers the 5 catastrophic-command patterns from the task brief. Meta-lint `negative_minimum: 5` floor passes.
   - Estimated effort: 2h

3. **Seed 1 chains worked-example case** — Append 1 happy-path case with `category: command-syntax`, `difficulty: easy`, a real operator question ("How do I list the active chains?"), and a populated `must_mention:` ("chains list", "active") + `must_not_mention:` ("delete", "rotate-key"). This is the worked example sibling authors copy. id: `chains-command-syntax-001`.
   - Files to modify: `plugins/autonomous-dev-assist/evals/test-cases/chains-eval.yaml`
   - Acceptance criteria: Case passes JSON-schema validation. Comment immediately above the case block explicitly labels it as the worked example for TDD-026 authors. `assist help` against this question, run manually, produces a passing response.
   - Estimated effort: 1.5h

4. **Author `deploy-eval.yaml` frontmatter and seed** — Same shape as task 1 but for deploy: `suite: deploy`, `case_minimum: 30`, `negative_minimum: 5`. The `description:` is "Validates that assist answers deploy-related operator questions correctly without hallucinating destructive commands, ledger edits, or bypass flags." Header comment links to TDD-026.
   - Files to create: `plugins/autonomous-dev-assist/evals/test-cases/deploy-eval.yaml`
   - Acceptance criteria: File is valid YAML; meta-lint frontmatter check passes; case-count check fails (0 < 30) — expected.
   - Estimated effort: 1h

5. **Seed 5 deploy negative cases** — Append 5 cases targeting hallucinations: (a) `--skip-validation` flag (b) hand-editing `ledger.json` (c) `deploy rollback --no-confirm` (d) `--bypass-firewall` (e) `deploy reset-cred-cache`. Each case's question is framed to elicit the hallucination (e.g., "How can I skip validation when deploying urgently?"). Correct response: there is no skip flag; the runbook describes the emergency-override procedure.
   - Files to modify: `plugins/autonomous-dev-assist/evals/test-cases/deploy-eval.yaml`
   - Acceptance criteria: 5 cases pass JSON-schema validation. ids follow `deploy-negative-001..005` or `deploy-warning-001..005`. Negative regex bag covers all 5 catastrophic-command patterns.
   - Estimated effort: 2h

6. **Seed 1 deploy worked-example case** — Append 1 happy-path case with `category: happy-path`, `difficulty: easy`, question "What does `autonomous-dev deploy --target staging` do?", `must_mention:` ("staging", "ledger"), `must_not_mention:` ("rollback", "force"). id: `deploy-happy-path-001`. Same labelling convention as task 3.
   - Files to modify: `plugins/autonomous-dev-assist/evals/test-cases/deploy-eval.yaml`
   - Acceptance criteria: Case passes JSON-schema validation; `assist help` against the question manually produces a passing response.
   - Estimated effort: 1.5h

7. **Run meta-lint and capture baseline output** — Run `bash plugins/autonomous-dev-assist/evals/meta-lint.sh --json`. Capture the JSON output. Confirm: chains and deploy frontmatter checks PASS; chains negative_minimum PASS (5 ≥ 5); deploy negative_minimum PASS; chains case_minimum FAIL (6 < 20); deploy case_minimum FAIL (6 < 30). Document the gap in the PR.
   - Files to modify: None (verification only)
   - Acceptance criteria: meta-lint output matches the documented expected baseline. The JSON is attached to the PR description. Sibling TDD-026 owners have a concrete count of cases they need to add.
   - Estimated effort: 0.5h

8. **Validate negative regex against a synthetic hallucinated response** — For each of the 10 negative cases (5 chains + 5 deploy), construct a synthetic hallucinated response string that would match the regex (e.g., "Run `chains rotate-key` to rotate the signing key.") and confirm the existing `scorer.sh` would mark it as FAIL when matched against the case's `must_not_mention`. This proves the negative bag is enforceable, not just declared.
   - Files to create: `plugins/autonomous-dev-assist/evals/schema/fixtures/synthetic-hallucinations.md` (or inline in the PR body)
   - Acceptance criteria: 10/10 synthetic hallucinations are caught by the existing scorer's `must_not_mention` logic. If any pattern is too narrow to catch the synthetic case, refine the regex in tasks 2/5 and retest.
   - Estimated effort: 2h

9. **PR coordination note for sibling TDD-026** — Append a comment block to each of the two files listing the exact case-category breakdown sibling authors should aim for, sourced from TDD-028 §5.3 (chains: command-syntax, concept-explanation, troubleshoot-scenario, negative, warning; deploy: command-syntax, concept-explanation, happy-path, troubleshoot-scenario, negative). Open a tracking issue (or PR comment) referencing TDD-026's case-population task.
   - Files to modify: both eval YAMLs (comment additions only)
   - Acceptance criteria: Each file has a clear `# CASE-AUTHORING GUIDANCE FOR TDD-026:` block listing the recommended categories and minimum counts per category. Tracking comment cross-links the sibling TDD ticket so coordination is visible.
   - Estimated effort: 1h

## Dependencies & Integration Points

**Exposes to other plans:**
- **`chains-eval.yaml`** and **`deploy-eval.yaml`** as schema-conformant containers. Sibling TDD-026 authors fill in case bodies; their PR is mechanically a YAML insert with no schema-impact.
- **Negative-pattern regex bag for chains and deploy surfaces** establishes the catastrophic-command vocabulary. PLAN-028-3 (cred-proxy/firewall negatives) follows the same regex-pattern style for consistency.
- **Worked-example cases** serve as documentation for sibling authors across all four new suites.

**Consumes from other plans:**
- **PLAN-028-1** (blocking): the `eval-case-v1.json` schema, the `meta-lint.sh` script (used in task 7), the `eval-config.yaml` registration with `enabled: true` and the 95% override.
- **PLAN-028-1 fixture set**: copy a valid fixture as the base for each seeded case in tasks 2-3 and 5-6.
- TDD-026 (sibling TDD): authors the bulk case bodies after this plan lands the containers.

## Testing Strategy

- **Schema conformance:** every seeded case (12 total: 6 chains + 6 deploy) passes `eval-case-v1.json` validation via meta-lint.
- **Frontmatter checks:** meta-lint frontmatter validation passes on both files (verified in task 7).
- **Negative-floor checks:** meta-lint `negative_minimum` passes on both files (5 ≥ 5).
- **Case-minimum baseline failures:** documented in PR; not blocking for this plan, blocking for the sibling TDD-026 PR.
- **Negative-regex enforceability:** task 8 proves each `must_not_mention` regex catches a synthetic hallucination via the existing `scorer.sh` matching rules.
- **Manual happy-path runs:** the worked-example case in each file is run via `claude -p "<question>"` and the response manually graded against `must_mention` and `must_not_mention`. If the current assist plugin fails the worked example, file as a follow-up — that's a content gap, not a contract gap.
- **Integration with PLAN-028-1 meta-lint:** the CI gate from PLAN-028-1 task 8 runs against this PR; expected output is exactly the baseline failure documented in task 7. If meta-lint passes outright (zero violations), something is wrong with `case_minimum` enforcement.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Sibling TDD-026 lands case bodies that conflict with the worked-example case ids (e.g., reuses `chains-command-syntax-001`) | Medium | Medium — id collision blocks meta-lint | Worked-example ids reserve `001` for this plan's authors; coordination note in task 9 explicitly tells TDD-026 authors to start at `002`. |
| Negative regexes are too narrow and miss real hallucinations | Medium | High — false-pass on dangerous responses | Task 8 validates each regex against a synthetic hallucination; broaden patterns where needed. Negative patterns are reviewed by the same reviewer who reviews TDD-026's cases — defense in depth. |
| Negative regexes are too broad and false-positive on legitimate responses | Medium | Medium — false-fail on correct answers | Worked-example cases (tasks 3, 6) include `must_not_mention:` blocks that any correct response should satisfy; running the worked example confirms the negative bag does not over-match. |
| Meta-lint blocks this PR entirely (case_minimum failures stop merge) | High (expected) | Low — it is the documented baseline | The CI gate in PLAN-028-1 must distinguish "case_minimum violation on a freshly seeded suite" from "case_minimum violation after sibling cases land." Task 7 documents the expected failure; reviewers approve with a `[merge-with-baseline-failure]` label or equivalent. PLAN-028-1's meta-lint includes a `--allow-baseline-deficit` flag that this PR's CI invokes. |
| The current assist plugin fails the worked-example happy-path cases | Medium | Low — content gap, not contract gap | File a follow-up against the assist plugin; do not block this PR. The worked example is documentation; once TDD-026 ships SKILL content the cases are expected to pass. |
| Sibling TDD-026 authors choose categories outside the recommended bag from TDD-028 §5.3 | Low | Low — schema enum still constrains them | Schema enum (10 values) is the hard constraint; the per-suite recommendation in §5.3 is a guideline. Coordination note in task 9 reproduces the recommendation. |
| Catastrophic-command vocabulary missed something — a hallucinated dangerous command not in the negative bag | Medium | High — silent miss in production | Negative-bag review by the standards-reviewer agent during PR review (per TDD-020). Periodic refresh during nightly eval drift detection. Document the bag as v1 and explicitly invite contributions in the PR body. |

## Definition of Done

- [ ] `plugins/autonomous-dev-assist/evals/test-cases/chains-eval.yaml` exists with TDD-028 §5.2 frontmatter, 5 negative + 1 worked-example cases (6 total).
- [ ] `plugins/autonomous-dev-assist/evals/test-cases/deploy-eval.yaml` exists with TDD-028 §5.2 frontmatter, 5 negative + 1 worked-example cases (6 total).
- [ ] All 12 seeded cases pass `eval-case-v1.json` schema validation.
- [ ] Both files pass meta-lint frontmatter and `negative_minimum` checks.
- [ ] Both files fail meta-lint `case_minimum` (chains 6/20; deploy 6/30) — failure documented in PR description as expected baseline.
- [ ] Each of the 10 negative cases' `must_not_mention` regex catches a synthetic hallucinated response under the existing `scorer.sh` matching rules (task 8).
- [ ] Worked-example cases (tasks 3, 6) include sibling-author guidance comments.
- [ ] Each YAML file has a `# CASE-AUTHORING GUIDANCE FOR TDD-026:` comment block listing recommended categories and counts.
- [ ] PR description includes the meta-lint JSON output baseline and the precise case-count gap for sibling owners.
- [ ] No existing eval-case file is modified.
- [ ] CI meta-lint gate accepts this PR via the documented `[merge-with-baseline-failure]` path (or equivalent flag honored by PLAN-028-1's meta-lint).
