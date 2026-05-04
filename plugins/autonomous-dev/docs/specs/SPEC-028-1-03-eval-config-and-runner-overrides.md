# SPEC-028-1-03: Eval-Config Registration, Runner Overrides, and Commands/Eval.md Update

## Metadata
- **Parent Plan**: PLAN-028-1
- **Parent TDD**: TDD-028 §6.1, §6.2, §6.3, §6.4
- **Tasks Covered**: Task 4 (eval-config extensions), Task 5 (runner.sh per_suite_overrides), Task 7 (commands/eval.md)
- **Estimated effort**: 5 hours (1.5 config + 2.5 runner + 1 prompt)
- **Status**: Draft

## Summary
Extend `plugins/autonomous-dev-assist/evals/eval-config.yaml` to register the four new eval suites (`chains`, `deploy`, `cred-proxy`, `firewall`) with `enabled: true`, per-suite case minima (20/30/15/15), `negative_minimum: 5`, the 95% per-suite threshold override (FR-1538), and a `default_invocation_order` listing all eight suites. If `runner.sh` does not already honor `per_suite_overrides`, apply a minimum patch (≤5 lines) to read the override. Update `commands/eval.md` to document the four new suite arguments and the per-PR-vs-nightly invocation policy.

## Functional Requirements

| ID | Requirement | Task |
|----|-------------|------|
| FR-1 | `eval-config.yaml` MUST register four new entries under `suites:` with the exact shape from TDD-028 §6.1 (chains/deploy/cred-proxy/firewall). | T4 |
| FR-2 | Each new suite registration MUST set `enabled: true`, `case_minimum` per FR-1532-1535 (20/30/15/15), `negative_minimum: 5`, and `file: test-cases/<suite>-eval.yaml`. | T4 |
| FR-3 | A new `per_suite_overrides:` block MUST be added under `thresholds:` setting all four new suites to `95`. | T4 |
| FR-4 | A new `default_invocation_order:` top-level block MUST list all eight suites in order: `help, troubleshoot, config, onboarding, chains, deploy, cred-proxy, firewall`. | T4 |
| FR-5 | All existing keys (`per_case`, `per_suite`, `global_minimum`, `max_case_failure_pct`, the four existing suite registrations) MUST remain bit-identical. | T4 |
| FR-6 | `runner.sh` MUST read `thresholds.per_suite_overrides[<suite>]` if present and apply it as the per-suite pass threshold for that suite. | T5 |
| FR-7 | If `per_suite_overrides[<suite>]` is absent for a given suite, `runner.sh` MUST fall back to `thresholds.per_suite` (existing behavior). | T5 |
| FR-8 | If `runner.sh` already honors `per_suite_overrides`, no code change is needed and the spec is satisfied with a one-line note in the PR. | T5 |
| FR-9 | `runner.sh` SHOULD honor `default_invocation_order` for `--suite all`. If the runner does not currently support an order field, accept alphabetical for v1 and document in PR (per TDD-028 OQ-2). | T5 |
| FR-10 | `commands/eval.md` MUST document four new suite arguments (`chains`, `deploy`, `cred-proxy`, `firewall`) under the existing argument list. | T7 |
| FR-11 | `commands/eval.md` MUST update the `all` argument description to "all eight suites in invocation order". | T7 |
| FR-12 | `commands/eval.md` MUST append a per-PR-vs-nightly invocation block: per-PR ≈ $1.50/suite; nightly `--suite all` ≈ $8.50. | T7 |

## Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| YAML validity | `yq` parses `eval-config.yaml` without error | `yq . eval-config.yaml >/dev/null; echo $?` returns 0 |
| Existing-key bit-identity | 100% of pre-existing keys identical | `diff <(yq -o=json eval-config.yaml.before) <(yq -o=json eval-config.yaml.after | jq 'del(.suites.chains, .suites.deploy, .suites["cred-proxy"], .suites.firewall, .thresholds.per_suite_overrides, .default_invocation_order)')` returns empty |
| Runner patch size | ≤ 5 lines added to `runner.sh` (if needed) | `git diff runner.sh | grep '^+' | wc -l` |
| `commands/eval.md` diff size | +15 lines, ±2 | `git diff commands/eval.md` |
| Threshold verification | A fixture eval run scoring 90% on chains FAILS; a run scoring 96% PASSES | Manual fixture-run test |
| Markdown lint on `commands/eval.md` | 0 violations | `markdownlint commands/eval.md` |

## Files to Modify

- **Path**: `plugins/autonomous-dev-assist/evals/eval-config.yaml`
  - **Action**: Modify (additive only)
  - **Description**: Append four new suite registrations under `suites:`. Add `per_suite_overrides` block under `thresholds:`. Add new top-level `default_invocation_order` list. Existing keys untouched.
- **Path**: `plugins/autonomous-dev-assist/evals/runner.sh`
  - **Action**: Modify (only if needed; ≤5 lines)
  - **Description**: If runner.sh does not already honor `per_suite_overrides`, add a minimal patch that reads `thresholds.per_suite_overrides[<suite-name>]` via `yq` and uses it instead of `thresholds.per_suite` when present. If already honored, this file is unchanged and the PR notes "verified runner.sh honors per_suite_overrides at line N".
- **Path**: `plugins/autonomous-dev-assist/commands/eval.md`
  - **Action**: Modify (additive)
  - **Description**: Add four new suite-argument bullets; update `all` description; append per-PR/nightly cost block.

## Technical Approach

### eval-config.yaml extensions (T4)
1. Locate the existing `suites:` block. After the last existing entry (`onboarding:` or equivalent), append four new entries verbatim from TDD-028 §6.1 (chains/deploy/cred-proxy/firewall).
2. Locate the existing `thresholds:` block. Append a `per_suite_overrides:` sub-key with four entries: `chains: 95`, `deploy: 95`, `cred-proxy: 95`, `firewall: 95`. Indentation MUST match siblings under `thresholds:`.
3. At the top level (peer of `suites:` and `thresholds:`), append a new `default_invocation_order:` list of all eight suite names in the order from TDD-028 §6.3.
4. Run `yq . eval-config.yaml >/dev/null` to confirm valid YAML.
5. Diff the file before/after; confirm only additive changes (no existing key modified).

### runner.sh investigation and patch (T5)
1. Read `runner.sh` end-to-end. Search for any reference to `per_suite_overrides` or per-suite-specific threshold logic.
2. If found and functional: document in PR (`runner.sh:N already reads per_suite_overrides`); skip code edits.
3. If not found: add a minimal patch in the threshold-comparison block. Pseudocode:
   ```bash
   # In the per-suite threshold lookup:
   override=$(yq ".thresholds.per_suite_overrides.\"$suite_name\" // .thresholds.per_suite" "$CONFIG")
   ```
   Replace the existing `per_suite_threshold` lookup with this expression. Total lines added ≤5.
4. Test fixture-run: stub a chains eval result at 90% pass-rate; run `runner.sh --suite chains`; confirm overall result is FAIL because 90 < 95. Re-run with a 96% result; confirm PASS.
5. Investigate `default_invocation_order` similarly. If runner enumerates `suites` keys directly, this is a v1-acceptable alphabetical fallback (per OQ-2); document in PR. If runner accepts a list parameter, wire through.

### commands/eval.md update (T7)
1. Locate the existing argument-list section. After the existing `config` bullet, insert four new bullets verbatim from TDD-028 §6.4:
   ```markdown
   - `chains` -- Run only the chain-surface evals (TDD-022)
   - `deploy` -- Run only the deploy-surface evals (TDD-023)
   - `cred-proxy` -- Run only the credential-proxy evals (TDD-024 §7-§10)
   - `firewall` -- Run only the egress-firewall evals (TDD-024 §11-§13)
   ```
2. Edit the `all` bullet to: `- \`all\` or no argument -- Run all eight suites in invocation order`.
3. Below the bullet list, append the per-PR/nightly block from TDD-028 §6.4.

## Acceptance Criteria

```
Given the modified eval-config.yaml
When yq is invoked to parse it
Then exit code is 0
And the resulting JSON has eight entries under .suites
And four of those entries have enabled: true and case_minimum matching FR-1532-1535
```

```
Given the modified eval-config.yaml
When the existing keys (per_case, per_suite, global_minimum, max_case_failure_pct, the four existing suite registrations) are extracted
Then they are bit-identical to the pre-modification values
```

```
Given the new per_suite_overrides block
When yq queries .thresholds.per_suite_overrides
Then it returns {chains: 95, deploy: 95, cred-proxy: 95, firewall: 95}
```

```
Given the new default_invocation_order block
When yq queries .default_invocation_order
Then it returns ["help", "troubleshoot", "config", "onboarding", "chains", "deploy", "cred-proxy", "firewall"]
```

```
Given runner.sh has been patched (or already honored overrides)
When a fixture chains-eval run scores 90% pass-rate
Then runner.sh marks the chains suite as FAIL
And the failure message references the 95% threshold
```

```
Given runner.sh has been patched (or already honored overrides)
When a fixture chains-eval run scores 96% pass-rate
Then runner.sh marks the chains suite as PASS
```

```
Given runner.sh has been patched
When a fixture help-eval run scores 82% pass-rate (above default 80%)
Then runner.sh marks the help suite as PASS
And the per_suite_overrides for chains/deploy/cred-proxy/firewall do NOT affect help's threshold
```

```
Given the modified commands/eval.md
When markdownlint is invoked
Then exit code is 0
And the document contains all eight suite-argument bullets
And the "all" bullet text equals "Run all eight suites in invocation order"
And a per-PR-vs-nightly invocation block follows the bullet list
```

```
Given the runner.sh patch (if applied)
When shellcheck is invoked on runner.sh
Then exit code is 0
And no new shellcheck warnings appear (warnings present pre-patch are out of scope)
```

```
Given runner.sh does NOT support default_invocation_order natively
When --suite all is requested
Then runner.sh enumerates all eight suites (alphabetical fallback acceptable for v1)
And the PR description documents the limitation per OQ-2
```

## Test Requirements

- **YAML validation**: `yq . eval-config.yaml` returns 0; resulting JSON conforms to expected shape.
- **Bit-identity test**: existing keys diff produces empty output.
- **Fixture eval runs**: 2 runs (90% and 96% chains scores) verify the override is honored.
- **Cross-suite isolation test**: 1 run on the help suite confirms it still uses the default 80% threshold.
- **Markdown lint**: `markdownlint commands/eval.md` returns 0.
- **Shellcheck on runner.sh**: clean if patched.

## Implementation Notes

- This spec is bounded ADDITIVE. Do NOT refactor any existing logic in eval-config.yaml or runner.sh beyond the per_suite_overrides read.
- If `runner.sh` requires a structural change >5 lines to honor `per_suite_overrides`, STOP and file a blocker against TDD-028 OQ-1. Do not silently accept the 80% degradation — that violates FR-1538.
- The `cred-proxy` key in YAML must be quoted (`"cred-proxy"`) when accessed via `yq` because of the hyphen, OR use `.thresholds.per_suite_overrides["cred-proxy"]` indexing.
- The four new suite YAMLs do not yet exist when this spec lands. `enabled: true` will cause `runner.sh` to attempt loading them; the runner must already handle missing suite files gracefully (verify and document). If not, the temporary fix is `enabled: false` per-suite until SPEC-028-2-* and SPEC-028-3-* land — but this defeats the merge-baseline gate. PREFER: leave `enabled: true` and ensure SPEC-028-2-* / SPEC-028-3-* land in the same merge train.

## Rollout Considerations

- Behavior-preserving for the existing four suites (their thresholds unchanged).
- The new four suites are `enabled: true` but their YAMLs may not exist on `main` until SPEC-028-2-* / SPEC-028-3-* land. Coordination via merge train.
- Rollback: revert config additions; revert runner patch (if any).

## Dependencies

- **Blocked by**: SPEC-028-1-01 (schema), SPEC-028-1-02 (meta-lint, since meta-lint reads eval-config to walk suites).
- **Exposes to**: SPEC-028-2-* and SPEC-028-3-* (they consume the registration), SPEC-028-4-* (commands/eval.md content referenced by README rewrite).

## Out of Scope

- Authoring the four new suite YAMLs — owned by PLAN-028-2 and PLAN-028-3.
- Modifying `scorer.sh` — out of scope per TDD-028 NG-03 unless scorer.sh also requires patching to honor `per_suite_overrides` (in which case a separate spec is filed; this spec stays runner-only).
- Modifying any of the existing 90 reviewer-eval cases — regression-stable per NG-07.
- Cost-tracking instrumentation for eval runs.
