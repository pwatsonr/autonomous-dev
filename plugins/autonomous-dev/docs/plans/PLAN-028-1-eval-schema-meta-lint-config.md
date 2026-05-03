# PLAN-028-1: Eval-Case Schema, Meta-Lint, and Eval-Config Registration

## Metadata
- **Parent TDD**: TDD-028-assist-evals-readme-cross-cutting
- **Estimated effort**: 3 days
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P1

## Objective
Author the foundational eval infrastructure that the four new assist eval suites (chains, deploy, cred-proxy, firewall) depend on: the shared JSON Schema (`evals/schema/eval-case-v1.json`) that locks the case shape across all eight suites; the `evals/meta-lint.sh` script that enforces schema conformance, per-suite case-count minima, and `must_not_mention` floors at CI time; the `evals/eval-config.yaml` extensions that register the four new suites with `enabled: true`, per-suite thresholds (≥95% per FR-1538), and a default invocation order; and the `commands/eval.md` prompt update that documents the four new suite arguments and per-PR-vs-nightly invocation policy. This plan owns the connective tissue. The four eval suite YAML frontmatter files are owned by PLAN-028-2 and PLAN-028-3; the README/agent-count/runbook See-also is owned by PLAN-028-4. By landing the schema and meta-lint first, every subsequent plan inherits a working CI lint gate that catches drift the moment it appears.

## Scope
### In Scope
- Author `plugins/autonomous-dev-assist/evals/schema/eval-case-v1.json` per TDD-028 §5.1: required fields (`id`, `category`, `difficulty`, `question`, `expected_topics`, `must_mention`, `must_not_mention`); `id` regex `^[a-z][a-z0-9_-]*-[a-z][a-z0-9_-]*-[0-9]{3}$`; closed `category` enum (10 values); `difficulty` enum (`easy`, `medium`, `hard`); `question` length 5-500.
- Author `plugins/autonomous-dev-assist/evals/meta-lint.sh` per TDD-028 §9: parse `eval-config.yaml`, walk every registered suite, validate top-level frontmatter (`suite`, `schema: eval-case-v1`, `case_minimum`, `negative_minimum`), validate each case against the JSON schema, count cases vs. `case_minimum`, count `must_not_mention` entries vs. `negative_minimum`, exit 0/1 with a Markdown summary; `--json` flag for CI consumption.
- Extend `plugins/autonomous-dev-assist/evals/eval-config.yaml` per TDD-028 §6.1-§6.3: register four new suites (`chains`, `deploy`, `cred-proxy`, `firewall`) under `suites:` with `file:`, `description:`, `enabled: true`, `case_minimum:` (20/30/15/15), `negative_minimum: 5`; add `per_suite_overrides` block setting all four new suites to `95`; add `default_invocation_order` listing all eight suites.
- If `runner.sh` does not honor `per_suite_overrides`, extend it with the minimum patch (≤5 lines) to read the override and apply it (per TDD-028 OQ-1 recommended answer: extend the runner). If `runner.sh` does not honor `default_invocation_order`, accept alphabetical order for v1 and document in OQ-2 follow-up. Any runner change is bounded to additive YAML reads; no schema breakage.
- Update `plugins/autonomous-dev-assist/commands/eval.md` per TDD-028 §6.4: document the four new suite arguments (`chains`, `deploy`, `cred-proxy`, `firewall`); update the `all` argument description to "all eight suites in invocation order"; add the per-PR-vs-nightly invocation guidance (one suite ≈ $1.50 per-PR; `--suite all` ≈ $8.50 nightly).
- Author meta-lint regression fixtures: 10 valid case fixtures and 10 invalid case fixtures (one per schema rule) under `plugins/autonomous-dev-assist/evals/schema/fixtures/` so the meta-lint can be unit-tested and so future contributors have a working example.
- Wire meta-lint into the existing CI workflow (PRD-010 / TDD-016): add a step that runs `bash plugins/autonomous-dev-assist/evals/meta-lint.sh` on any PR touching `plugins/autonomous-dev-assist/evals/**`. Output attaches to the PR as a Markdown summary.
- Validate the schema retroactively against the existing 90 reviewer-eval cases (`a11y-reviewer-eval.yaml`, `qa-reviewer-eval.yaml`, `standards-reviewer-eval.yaml`, `ux-reviewer-eval.yaml`) and the four existing assist suites (help, troubleshoot, config, onboarding). Any violation found is documented as a follow-up ticket (per TDD-028 OQ-5: legacy violations do not block this PR).

### Out of Scope
- Authoring the four new suite YAML files (`chains-eval.yaml`, `deploy-eval.yaml`, `cred-proxy-eval.yaml`, `firewall-eval.yaml`) — owned by PLAN-028-2 (chains, deploy) and PLAN-028-3 (cred-proxy, firewall).
- Authoring eval case bodies for any new suite — owned by sibling TDDs (TDD-025 for cred-proxy/firewall; TDD-026 for chains/deploy). This plan only defines the schema they will conform to.
- README, agent-count, and runbook See-also updates — owned by PLAN-028-4.
- Modifying `runner.sh` or `scorer.sh` beyond the bounded `per_suite_overrides` read (per TDD-028 NG-03).
- Modifying any of the existing 90 cases (per TDD-028 NG-07: regression-stable contract).
- Authoring new agents or SKILL sections (per TDD-028 NG-04, NG-05).
- Cost-tracking instrumentation for eval runs — covered separately by PLAN-017-3 / PLAN-017-4.

## Tasks

1. **Author `evals/schema/eval-case-v1.json`** — Write the JSON Schema per TDD-028 §5.1. Include `$id`, `type: object`, `required` array, full property definitions with `pattern` regex on `id`, `enum` on `category` and `difficulty`, length bounds on `question`, `minItems: 1` on `expected_topics`. Add a `description` field to each property explaining the constraint.
   - Files to create: `plugins/autonomous-dev-assist/evals/schema/eval-case-v1.json`
   - Acceptance criteria: Schema validates as a well-formed JSON Schema (Draft 2020-12). The 10 valid fixtures from task 6 all pass; the 10 invalid fixtures all fail with the expected violation. The schema is loadable by `ajv` (Node) and by `jsonschema` (Python) — both are commonly available CI tools.
   - Estimated effort: 3h

2. **Validate the schema against existing 90 + 4 suites** — Run a one-off validation script that loads every `plugins/autonomous-dev-assist/evals/test-cases/*.yaml`, transforms each case to JSON, and validates against `eval-case-v1.json`. Capture any violations.
   - Files to create: `plugins/autonomous-dev-assist/evals/schema/validate-existing.sh` (one-off; can be deleted after task 2 completes, or retained as a documentation example).
   - Acceptance criteria: Either zero violations (clean) or a documented list of violations filed as a follow-up ticket. The PR is not blocked by legacy violations (per TDD-028 OQ-5). The output is captured in the PR description so reviewers can see what was found.
   - Estimated effort: 2h

3. **Author `evals/meta-lint.sh`** — Implement the script per TDD-028 §9. Parse `eval-config.yaml` (use `yq` or a minimal-dependency YAML reader); for each `suites:` entry, load the file, validate frontmatter (`suite`, `schema: eval-case-v1`, `case_minimum`, `negative_minimum`), iterate cases and validate each against `eval-case-v1.json`, count cases vs. `case_minimum`, count `must_not_mention` entries vs. `negative_minimum`. Emit a per-suite line (`[OK] chains (22 cases, 6 negative)` or `[FAIL] deploy: ...`). Exit 0 if all pass; 1 otherwise. Support `--json` flag for CI consumption.
   - Files to create: `plugins/autonomous-dev-assist/evals/meta-lint.sh`
   - Acceptance criteria: Script runs on a fresh clone in <5 seconds (per TDD-028 §13 perf target). Pass/fail behavior matches TDD-028 §11.3 sample output. `--json` emits a structured report with `pass: bool`, `findings: []`, per-suite results. Script is `set -euo pipefail` and idempotent. Shellcheck clean.
   - Estimated effort: 4h

4. **Wire `eval-config.yaml` extensions** — Append the four new suite registrations under `suites:` per TDD-028 §6.1. Add the `per_suite_overrides:` block under `thresholds:` per §6.2. Add the `default_invocation_order:` block per §6.3. Preserve all existing keys verbatim (regression-stable).
   - Files to modify: `plugins/autonomous-dev-assist/evals/eval-config.yaml`
   - Acceptance criteria: Existing keys (`per_case`, `per_suite`, `global_minimum`, `max_case_failure_pct`, existing four suite registrations) are bit-identical. New keys added per TDD-028 §6. `runner.sh` enumerates all eight suites when `--suite all` is requested. YAML lint passes.
   - Estimated effort: 1.5h

5. **Verify `runner.sh` honors `per_suite_overrides`; extend if needed** — Read `runner.sh`. If it already reads per-suite thresholds, document that fact and skip code changes. If not, add a minimal patch (≤5 lines) that reads `per_suite_overrides[<suite>]` and uses it instead of `per_suite` when present. Same check for `default_invocation_order`: if not honored, document that v1 accepts alphabetical (per TDD-028 OQ-2).
   - Files to modify: `plugins/autonomous-dev-assist/evals/runner.sh` (only if needed)
   - Acceptance criteria: After this task, running `bash runner.sh --suite chains` applies the 95% threshold (verifiable via test fixture: a chains run that scores 90% is FAIL; a run that scores 96% is PASS). If runner already honors overrides, this task closes with a one-line note in the PR. Any runner change is shellcheck-clean and does not modify behavior for the existing four suites.
   - Estimated effort: 2.5h

6. **Author meta-lint fixtures** — Create `plugins/autonomous-dev-assist/evals/schema/fixtures/valid-*.yaml` (10 files: one per case category from the enum) and `invalid-*.yaml` (10 files: each violating exactly one schema rule — bad id pattern, missing required field, out-of-enum category, question too short, etc.). Each fixture has a comment header explaining what rule it exercises.
   - Files to create: 20 fixture YAMLs under `plugins/autonomous-dev-assist/evals/schema/fixtures/`
   - Acceptance criteria: All 10 valid fixtures pass schema validation; all 10 invalid fixtures fail with a deterministic, expected violation message. The fixture set is the canonical worked example for future contributors authoring new suites. Markdown index `fixtures/README.md` lists each fixture and the rule it covers.
   - Estimated effort: 3h

7. **Update `commands/eval.md`** — Add the four new suite arguments to the documented argument list per TDD-028 §6.4. Update the `all` description. Append the per-PR-vs-nightly invocation guidance block (one suite ≈ $1.50 per-PR; full ≈ $8.50 nightly; rationale: cost discipline + cross-suite drift detection).
   - Files to modify: `plugins/autonomous-dev-assist/commands/eval.md`
   - Acceptance criteria: Diff is +~15 lines. Existing prose for help/troubleshoot/config/onboarding suites unchanged. Markdown lint passes. The eval-the-eval (when run) recognizes the new arguments without errors.
   - Estimated effort: 1h

8. **Wire meta-lint into CI** — Add a step to the existing assist-eval CI workflow (or the closest equivalent under `.github/workflows/`) that runs `bash plugins/autonomous-dev-assist/evals/meta-lint.sh` on any PR touching `plugins/autonomous-dev-assist/evals/**`. The step uses the `--json` flag and posts the parsed result as a PR comment via `actions/github-script` if any finding is FAIL.
   - Files to modify: `.github/workflows/assist-evals.yml` (or equivalent), or new `.github/workflows/eval-meta-lint.yml`
   - Acceptance criteria: A PR that introduces a malformed case (e.g., missing `must_not_mention`) is blocked by CI with a clear PR comment. A PR that touches non-eval files does not trigger meta-lint. Workflow is `actionlint`-clean.
   - Estimated effort: 2h

9. **Smoke test the foundation** — Manually create a temporary suite YAML (`evals/test-cases/_smoke.yaml`) that conforms to the schema and has 5 negative cases; register it temporarily in `eval-config.yaml`; run meta-lint; confirm PASS. Then introduce a violation in each of the five enforced rules (missing schema field, below case_minimum, below negative_minimum, malformed id, unknown category) and confirm meta-lint FAILs with the right finding. Then revert.
   - Files to modify: None (test-only)
   - Acceptance criteria: Five smoke tests cover the five enforcement rules; each produces the expected pass/fail. Captured in the PR description as a verification log.
   - Estimated effort: 2h

## Dependencies & Integration Points

**Exposes to other plans:**
- **`evals/schema/eval-case-v1.json`** consumed by PLAN-028-2 (chains, deploy frontmatter), PLAN-028-3 (cred-proxy, firewall frontmatter), and any future eval-suite plan.
- **`evals/meta-lint.sh`** invoked by CI on every eval-touching PR; consumed by PLAN-028-4 (README's "How to run evals" section documents it).
- **`eval-config.yaml` registration** with `per_suite_overrides` reachable by both PLAN-028-2 and PLAN-028-3 (their suite frontmatter must declare `case_minimum` and `negative_minimum` matching this file).
- **`commands/eval.md` argument list** referenced by PLAN-028-4's README "How to run evals" rewrite.
- **Schema fixture set** consumed by sibling TDDs (TDD-025, TDD-026) authoring the case bodies — they should copy a valid fixture and edit.

**Consumes from other plans:**
- TDD-016 / PRD-010 CI infrastructure (existing): meta-lint workflow runs inside it.
- TDD-020: the 90-case reviewer eval suites that this plan validates retroactively.
- No PLAN-028 sibling plan dependencies — this plan is the foundation.

## Testing Strategy

- **Schema unit tests:** 10 valid + 10 invalid fixtures (task 6) cover every rule in the schema.
- **Meta-lint unit tests:** 5 scenarios per TDD-028 §15.1 — clean pass, missing schema field, below case_minimum, below negative_minimum, broken YAML. Driven from the smoke test in task 9.
- **Retroactive validation:** task 2 runs the schema against all 90 + 4 existing suite cases. Result captured in PR.
- **Runner behavior:** if task 5 modifies `runner.sh`, two fixture eval runs (one above, one below the 95% threshold for a hypothetical suite) verify the override is honored.
- **CI integration test:** task 8 creates a deliberately bad case in a draft PR; meta-lint blocks it. Then fixes the case; meta-lint passes.
- **Performance check:** meta-lint runtime ≤5 s per TDD-028 §13.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `runner.sh` cannot accept `per_suite_overrides` without a structural change | Low | High — degrades the new-suite gate from 95% to 80%, violating FR-1538 | Task 5 inspects `runner.sh` first. If a clean ≤5-line patch is not feasible, file a blocker against TDD-028 OQ-1 and pause this plan; do not silently accept the 80% degradation. |
| Existing 90 reviewer-eval cases fail the new schema | Medium | Medium — would force a follow-up cleanup PR | Task 2 captures violations as a separate ticket per TDD-028 OQ-5; legacy violations do not block this PR. The schema's `id` regex is permissive enough to match the existing `<suite>-<category>-<NNN>` convention used by the reviewer suites. |
| `yq` or other YAML tools not available in the CI runner | Medium | Low — meta-lint cannot run | Use `yq v4` (widely available `mikefarah/yq` GitHub Action) or fall back to `python3 -c "import yaml; ..."` (Python is always present). Document the dependency in `meta-lint.sh` header. |
| Schema is too strict and rejects legitimate edge-cases authored by sibling TDDs | Medium | Medium — siblings would need to negotiate schema changes mid-implementation | Schema mirrors the existing case shape exactly (no new constraints beyond what current cases already satisfy). The fixture set documents the contract. Any sibling-found edge case is a v1 → v2 migration, not a v1 amendment. |
| Meta-lint becomes a CI bottleneck on large suites | Low | Low — CI latency increase | Performance budget is 5 s for ~200 cases; static YAML+JSON validation is O(cases) and well under budget. Re-measure when suite count exceeds 20. |
| `eval-config.yaml` YAML extension breaks existing parsers downstream | Low | High — the 90-case existing suites stop running | Additive-only change; preserve every existing key bit-identical (verified in task 4 acceptance criteria). YAML lint runs in CI. |
| The `per_suite_overrides` block is honored by `runner.sh` but ignored by `scorer.sh`, producing inconsistent thresholds | Medium | Medium — false-pass on the new suites | Task 5 verifies both scripts. If only one honors overrides, the other gets the minimal patch in the same task. |

## Definition of Done

- [ ] `plugins/autonomous-dev-assist/evals/schema/eval-case-v1.json` exists, is well-formed JSON Schema, and validates the 10 valid + 10 invalid fixture set deterministically.
- [ ] `plugins/autonomous-dev-assist/evals/meta-lint.sh` exists, is shellcheck-clean, runs in <5 seconds, and supports both human and `--json` output.
- [ ] `evals/eval-config.yaml` registers all four new suites with `enabled: true`, correct `case_minimum` per FR-1532-1535, `negative_minimum: 5`, and 95% per-suite override.
- [ ] `default_invocation_order` lists all eight suites; `runner.sh` enumerates them in order (or alphabetical fallback documented).
- [ ] `runner.sh` honors `per_suite_overrides` (verified by fixture eval run); patch is ≤5 lines if needed.
- [ ] `commands/eval.md` documents the four new suite arguments and per-PR/nightly invocation policy.
- [ ] 10 valid + 10 invalid schema fixtures exist under `evals/schema/fixtures/` with a `README.md` index.
- [ ] Retroactive schema validation against the existing 90 + 4 suites is captured in the PR; any violations filed as separate tickets.
- [ ] CI workflow runs meta-lint on PRs touching `plugins/autonomous-dev-assist/evals/**` and posts a Markdown summary on failure.
- [ ] Smoke-test results from task 9 (five enforcement rules, each producing the expected pass/fail) are captured in the PR description.
- [ ] No existing eval-case file is modified (regression-stable contract preserved).
- [ ] All third-party actions (if any added) pinned to a major version.
