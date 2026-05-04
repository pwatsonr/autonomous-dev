# SPEC-027-1-04: Troubleshooter Eval Cases (6 cases — chains, deploy, cred-proxy, firewall)

## Metadata
- **Parent Plan**: PLAN-027-1
- **Parent TDD**: TDD-027 §7.1 (case table), §13 (test strategy), §8.4 (regression policy), FR-1536 (shared schema), FR-1538 (regression baseline)
- **Tasks Covered**: PLAN-027-1 Task 7 (author 6 eval cases), Task 8 (append-only verification of YAML), Task 9 (smoke run)
- **Estimated effort**: 3.0 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-027-1-04-troubleshooter-eval-cases.md`
- **Depends on**: SPEC-027-1-01 + SPEC-027-1-02 + SPEC-027-1-03 (the agent must be capable of producing the responses these cases assert; smoke-run targets the post-modification agent prompt).

## Summary
Append exactly 6 new eval cases to `plugins/autonomous-dev-assist/evals/test-cases/troubleshoot-scenarios.yaml`, matching TDD-027 §7.1 verbatim in `id`, `difficulty`, `question`, `must_mention[]`, and `must_not_mention[]`. The cases exercise the four new diagnostic subsections added by SPEC-027-1-02 / SPEC-027-1-03 (chains HMAC mismatch, deploy awaiting-approval, deploy cost-cap-tripped, cred-proxy socket permission, firewall denied request, cred-proxy TTL expired). The schema follows the per-case shape used by the existing `troubleshoot-scenarios.yaml` — augmented with the `must_mention` / `must_not_mention` keys defined by FR-1536 and consumed by the eval scoring logic in `eval-config.yaml` (`scoring.accuracy.method: topic_and_mention_match`).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-assist/evals/test-cases/troubleshoot-scenarios.yaml` | Modify | Append 6 cases to the existing `cases:` list. No deletions; no edits to existing cases. |

## Functional Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| FR-1 | Append exactly 6 cases with these `id` values, in this order: `tshoot-chains-001`, `tshoot-deploy-001`, `tshoot-deploy-002`, `tshoot-credp-001`, `tshoot-firewall-001`, `tshoot-credp-002`. | TDD-027 §7.1 |
| FR-2 | Each new case MUST have these top-level keys (matching FR-1536 shared schema): `id` (string), `difficulty` (enum: `easy`, `medium`, `hard`), `question` (string), `must_mention` (list of strings), `must_not_mention` (list of strings). The legacy `category`, `severity`, `scenario`, `symptoms`, `expected_diagnosis`, `expected_commands`, `expected_fix` keys MAY be present for compatibility with the existing eval runner if the runner enforces them; per FR-1536 only the 5 keys above are normative. | TDD-027 §7.1, FR-1536 |
| FR-3 | `tshoot-chains-001`: difficulty `medium`, question `chains audit verify says HMAC mismatch — what do I do?`, must_mention contains `chains audit` and `do NOT delete`, must_not_mention contains `rm.*audit.log` and `chains rotate-key`. | TDD-027 §7.1 |
| FR-4 | `tshoot-deploy-001`: difficulty `medium`, question `my deploy is stuck on awaiting-approval`, must_mention contains `deploy approve REQ-NNNNNN` and `prod always`, must_not_mention contains `--no-approval` and `deploy auto-prod`. | TDD-027 §7.1 |
| FR-5 | `tshoot-deploy-002`: difficulty `hard`, question `deploy aborted with cost-cap-tripped`, must_mention contains `deploy ledger reset` and `do NOT hand-edit`, must_not_mention contains `edit.*ledger.json`. | TDD-027 §7.1 |
| FR-6 | `tshoot-credp-001`: difficulty `medium`, question `cred-proxy says permission denied on socket`, must_mention contains `stat`, `0600`, `cred-proxy doctor`, must_not_mention contains `chmod 777`. | TDD-027 §7.1 |
| FR-7 | `tshoot-firewall-001`: difficulty `medium`, question `firewall denied my backend's HTTPS request`, must_mention contains `denied.log`, `firewall test`, `allowlist`, must_not_mention contains `firewall disable-all`. | TDD-027 §7.1 |
| FR-8 | `tshoot-credp-002`: difficulty `hard`, question `cred-proxy TTL expired in middle of deploy`, must_mention contains `cred-proxy bootstrap` and `do NOT rotate root`, must_not_mention contains `aws iam update-access-key`. | TDD-027 §7.1 |
| FR-9 | YAML MUST validate against the existing eval-case schema after append (consumed by the PLAN-017-3 eval runner). The file remains parseable as a single YAML document with a `cases:` list. | PLAN-027-1 Task 7 |
| FR-10 | All existing cases MUST remain unchanged in id, content, and order. | TDD-027 §4.2 (G-08) |

## Non-Functional Requirements

| Requirement | Target | Measurement Method |
|------------|--------|--------------------|
| YAML parse time | < 100 ms for the full file | `python -c "import yaml; yaml.safe_load(open(p))"` on full file |
| Per-case smoke-pass rate (PLAN-027-1 Task 9) | ≥ 5 of 6 cases pass first run | Run the 6 new cases via the PLAN-017-3 eval runner against the SPEC-027-1-{01,02,03}-modified agent; record per-case pass/fail in PR body |
| Existing troubleshoot suite regression | 0 cases regress | Run full `troubleshoot-scenarios.yaml` suite via PLAN-017-3 runner; compare pass-list to `main` baseline |
| Eval runtime impact (per `eval all` invocation) | < 30 s additional wall-clock | Measured by PLAN-017-3 runner; budget is `+15s` per TDD-027 §8.3 (proportional growth) |
| Per-case API cost increase | < $0.50 total for `eval all` | Per TDD-027 §8.6 |

## Technical Approach

### Schema-shape decision
TDD-027 §7.1 uses the lightweight `must_mention` / `must_not_mention` schema mandated by FR-1536. The existing `troubleshoot-scenarios.yaml` uses a richer legacy schema (`scenario`, `symptoms`, `expected_diagnosis`, `expected_commands`, `expected_fix`). The eval-runner scoring (`eval-config.yaml`: `scoring.accuracy.method: topic_and_mention_match`) reads `must_mention`. Reconciliation:

- **Authoritative keys** (per FR-1536, normative): `id`, `difficulty`, `question`, `must_mention`, `must_not_mention`.
- **Optional bridge keys** (for backward compatibility with the existing legacy reader): the new cases MAY supply minimal stub values for `category` / `severity` / `scenario` so a legacy reader does not error; if the existing reader iterates by index without strict-key enforcement, the bridge keys may be omitted. The implementer must inspect the runner to decide; default to including the bridge keys to be safe.
- **No edits to existing cases.**

### Insertion strategy
1. Read `plugins/autonomous-dev-assist/evals/test-cases/troubleshoot-scenarios.yaml`.
2. Locate the end of the existing `cases:` list (the last `- id: …` block, followed by EOF or trailing blank lines).
3. Append 6 new case entries at that location, preserving 2-space indentation and the `- id:` block style used by the existing cases.

### Case bodies (verbatim from TDD-027 §7.1)

```yaml
  - id: tshoot-chains-001
    difficulty: medium
    category: chains            # bridge (see schema-shape decision)
    severity: medium            # bridge
    scenario: "chains audit verify says HMAC mismatch — what do I do?"  # bridge
    question: "chains audit verify says HMAC mismatch — what do I do?"
    must_mention:
      - "chains audit"
      - "do NOT delete"
    must_not_mention:
      - "rm.*audit.log"
      - "chains rotate-key"

  - id: tshoot-deploy-001
    difficulty: medium
    category: deploy
    severity: medium
    scenario: "my deploy is stuck on awaiting-approval"
    question: "my deploy is stuck on awaiting-approval"
    must_mention:
      - "deploy approve REQ-NNNNNN"
      - "prod always"
    must_not_mention:
      - "--no-approval"
      - "deploy auto-prod"

  - id: tshoot-deploy-002
    difficulty: hard
    category: deploy
    severity: high
    scenario: "deploy aborted with cost-cap-tripped"
    question: "deploy aborted with cost-cap-tripped"
    must_mention:
      - "deploy ledger reset"
      - "do NOT hand-edit"
    must_not_mention:
      - "edit.*ledger.json"

  - id: tshoot-credp-001
    difficulty: medium
    category: cred-proxy
    severity: medium
    scenario: "cred-proxy says permission denied on socket"
    question: "cred-proxy says permission denied on socket"
    must_mention:
      - "stat"
      - "0600"
      - "cred-proxy doctor"
    must_not_mention:
      - "chmod 777"

  - id: tshoot-firewall-001
    difficulty: medium
    category: firewall
    severity: medium
    scenario: "firewall denied my backend's HTTPS request"
    question: "firewall denied my backend's HTTPS request"
    must_mention:
      - "denied.log"
      - "firewall test"
      - "allowlist"
    must_not_mention:
      - "firewall disable-all"

  - id: tshoot-credp-002
    difficulty: hard
    category: cred-proxy
    severity: high
    scenario: "cred-proxy TTL expired in middle of deploy"
    question: "cred-proxy TTL expired in middle of deploy"
    must_mention:
      - "cred-proxy bootstrap"
      - "do NOT rotate root"
    must_not_mention:
      - "aws iam update-access-key"
```

The `must_mention` / `must_not_mention` strings use substring-matching semantics (per the existing `eval-config.yaml` scoring). Strings beginning with `rm.*` or `edit.*` look regex-like but are matched as substrings unless the runner explicitly upgrades them — the implementer MUST verify the runner's matching mode and document the decision in the PR body. If substring-matching produces a false negative (e.g., `rm.*audit.log` never literally matches "rm -f audit.log"), the implementer SHOULD adjust the forbidden string to a literal substring (`rm` and `audit.log` as two separate forbidden entries) and call out the change in the PR body.

### Error handling at edit time
- If `troubleshoot-scenarios.yaml` does not parse as YAML, abort and surface the error.
- If any of the 6 ids already exists in the file, abort and surface the conflict; do NOT silently overwrite.
- If `eval-config.yaml` does not list `troubleshoot` as `enabled: true`, surface a warning (it should be — the suite is the production gate).

## Acceptance Criteria

```
Given the troubleshoot-scenarios.yaml file before edit
When this spec's edits are applied
Then the file contains 6 additional cases beyond the main baseline
And the new cases' ids are exactly: tshoot-chains-001, tshoot-deploy-001, tshoot-deploy-002, tshoot-credp-001, tshoot-firewall-001, tshoot-credp-002
And no pre-existing case is modified or removed
```

```
Given the modified troubleshoot-scenarios.yaml
When the file is parsed via `python -c "import yaml; yaml.safe_load(open(p))"`
Then the parser exits 0
And the parsed object's `cases` list length equals the main baseline length plus 6
```

```
Given the case `tshoot-chains-001` in the modified YAML
When its keys are inspected
Then `id` equals "tshoot-chains-001"
And `difficulty` equals "medium"
And `question` equals "chains audit verify says HMAC mismatch — what do I do?"
And `must_mention` contains exactly the strings "chains audit" and "do NOT delete"
And `must_not_mention` contains exactly the strings "rm.*audit.log" and "chains rotate-key"
```

```
Given the case `tshoot-credp-002` in the modified YAML
When its keys are inspected
Then `id` equals "tshoot-credp-002"
And `difficulty` equals "hard"
And `must_mention` contains "cred-proxy bootstrap" and "do NOT rotate root"
And `must_not_mention` contains "aws iam update-access-key"
```

```
Given the modified troubleshoot-scenarios.yaml and a SPEC-027-1-{01,02,03}-modified troubleshooter.md agent
When the 6 new cases are run via the PLAN-017-3 eval runner
Then at least 5 of 6 cases pass on first run
Or any failing cases are documented in the PR body with prompt-tuning notes for follow-up
```

```
Given the modified troubleshoot-scenarios.yaml
When the full pre-existing suite is re-run via the PLAN-017-3 runner
Then no pre-existing case regresses (pass-list on this branch is a superset of the pass-list on main)
```

### Edge cases / sad paths
```
Given the eval runner uses substring matching (not regex) for must_not_mention
When the agent's response contains "rm -f ~/.autonomous-dev/chains/audit.log"
Then the literal substring "rm.*audit.log" does NOT match
And the case may pass even though the agent suggested deletion
And the implementer MUST audit this case during smoke-run (Task 9) and adjust the forbidden string to a literal-substring form if needed
```

```
Given a future TDD that renames `cred-proxy` to `cred-broker`
When this spec's case `tshoot-credp-001` continues to require "cred-proxy doctor"
Then the case will fail until coordinated rename happens
And the rename TDD MUST update the must_mention strings via a follow-up spec
```

```
Given the runner enforces a strict-keys policy
When a new case lacks a required legacy key (e.g., `expected_diagnosis`)
Then the runner errors
And the implementer MUST add the bridge keys (the `category`, `severity`, `scenario` shown in Technical Approach) to satisfy the runner
```

## Test Requirements

### Static
- YAML parses with `python -c "import yaml; yaml.safe_load(open(p))"` (exit 0).
- `grep -c "^  - id: tshoot-" troubleshoot-scenarios.yaml` increases by exactly 6.
- For each of the 6 new ids, a scripted check confirms the `must_mention` and `must_not_mention` lists match the FR-3..FR-8 tables exactly.
- `grep -c "do NOT delete" troubleshoot-scenarios.yaml` returns ≥ 1 (in the new chains case).
- `grep -c "do NOT hand-edit" troubleshoot-scenarios.yaml` returns ≥ 1.
- `grep -c "do NOT rotate root" troubleshoot-scenarios.yaml` returns ≥ 1.

### Integration / regression
- All pre-existing cases continue to pass at the established threshold (PLAN-017-3 gate; ≥ 95 % composite per `eval-config.yaml`).
- Smoke-run of the 6 new cases via the eval runner: ≥ 5 of 6 pass on first run; document any failures.

### Manual review
- Reviewer cross-references each case against TDD-027 §7.1 and confirms the `must_mention` / `must_not_mention` strings are byte-identical to the TDD's table cells.

## Implementation Notes

- The bridge-keys (category / severity / scenario) decision is a runtime concern; the implementer MUST inspect the PLAN-017-3 runner before deciding to omit them. Default to including them.
- Substring vs regex matching is the highest-likelihood source of false positives/negatives. Verify the runner's mode; if it is substring-only, treat all `must_not_mention` entries containing `.*` as literal substrings and consider whether to file a follow-up against the runner to add regex support.
- The 6 cases together with the pre-existing suite take per-case ≈ $0.05; the `eval all` cost grows by < $0.50 (TDD-027 §8.6).
- This spec is the LAST in PLAN-027-1's chain. After it lands, PLAN-027-1's Definition of Done can be re-checked.

## Rollout Considerations

- **Rollout**: YAML-only PR; no code changes. The eval runner picks up the new cases on the next CI run.
- **Feature flag**: None. The cases are opt-out via `eval-config.yaml`'s `enabled: false` (which is `true` for `troubleshoot`, so they run).
- **Rollback**: Revert the commit. The 6 cases disappear; no operator impact.
- **Coordination**: The smoke run depends on SPEC-027-1-{01,02,03} being applied to the agent. Land the four PLAN-027-1 specs in PR order: 01 → 02 → 03 → 04.

## Effort Estimate

| Activity | Hours |
|----------|-------|
| Author 6 case YAML blocks (verbatim copy + bridge keys) | 1.5 |
| Schema validation + per-case scripted checks | 0.5 |
| Smoke run via PLAN-017-3 runner + PR-body capture | 1.0 |
| **Total** | **3.0** |
