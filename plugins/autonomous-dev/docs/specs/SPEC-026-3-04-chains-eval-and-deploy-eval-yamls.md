# SPEC-026-3-04: chains-eval.yaml (≥20 cases) + deploy-eval.yaml (≥30 cases)

## Metadata
- **Parent Plan**: PLAN-026-3
- **Parent TDD**: TDD-026
- **Tasks Covered**: PLAN-026-3 Task 7 (`chains-eval.yaml`), Task 8 (`deploy-eval.yaml`)
- **Estimated effort**: 11 hours
- **Status**: Draft
- **Author**: Specification Author (TDD-026 cascade)
- **Date**: 2026-05-02
- **Depends on**: PLAN-026-1 + PLAN-026-2 merged (so the SKILL/runbook content the cases reference exists); SPEC-026-3-01/-02/-03 merged (so deploy-runbook.md exists for cross-runbook eval cases). NOTE: `eval-config.yaml` registration is OUT OF SCOPE — owned by TDD-028 §6.

## Summary
Create the two eval suites that gate the assist's chain and deploy answers at ≥95% pass rate per FR-1532 / FR-1533 / FR-1538: `plugins/autonomous-dev-assist/evals/test-cases/chains-eval.yaml` (≥20 cases across six categories) and `plugins/autonomous-dev-assist/evals/test-cases/deploy-eval.yaml` (≥30 cases across seven categories). Both YAMLs follow the existing schema (see `evals/test-cases/help-questions.yaml` for the canonical shape: `suite`, `skill`, `description`, `cases[]` with `id`, `category`, `difficulty`, `question`, `expected_topics`, `must_mention`, `must_not_mention`). Every case carries the appropriate negative-mention bag from TDD-026 §9.1 (≥5 entries per case per FR-1538). The four prod-always-approval cases in deploy-eval verify the verbatim string `regardless of trust level` is mentioned. The eval-the-eval baseline + post-merge runs are owned by SPEC-026-3-05 (the next spec); this spec only authors the cases.

## Functional Requirements

### Shared schema (both files)

| ID    | Requirement |
|-------|-------------|
| FR-1  | Each YAML MUST conform to the existing eval schema used by `evals/runner.sh`: top-level `suite`, `skill`, `description`, `cases:`. Each case MUST have keys `id`, `category`, `difficulty` (`easy` | `medium` | `hard`), `question`, `expected_topics`, `must_mention`, `must_not_mention`. |
| FR-2  | The chosen schema's field semantics MUST match `evals/test-cases/help-questions.yaml` and other existing suites in `evals/test-cases/`. The implementer MUST `Read` an existing suite as the canonical reference before authoring. |
| FR-3  | Both YAMLs MUST pass `yamllint` with the existing repo config (or strict default if no config exists). |
| FR-4  | All `id` values within a single suite MUST be unique. The id pattern is `<suite>-<category>-NNN` (e.g., `chains-happy-001`, `deploy-cost-002`). |
| FR-5  | Neither YAML may contain SHA pinning in any string value. |

### `chains-eval.yaml` (≥20 cases)

| ID    | Requirement |
|-------|-------------|
| FR-6  | File path: `plugins/autonomous-dev-assist/evals/test-cases/chains-eval.yaml`. |
| FR-7  | `suite: chains` and `skill: help` (the assist routes chains questions to the help skill — confirm by reading the existing schema). The implementer MUST verify which skill key the runner expects by reading `evals/runner.sh` and one existing suite. If a different `skill` value is canonical (e.g., `assist`), use that. |
| FR-8  | Total case count MUST be ≥ 20. |
| FR-9  | Cases MUST cover the six categories per TDD-026 §9.2 with these minimums: 6 happy-path cases (list/graph/audit/manifest-v2 questions), 3 cycle-detection cases, 3 HMAC-mismatch cases, 3 manifest-v2-error cases, 3 approve/reject cases, 2 audit-log-warning cases. |
| FR-10 | The 6 happy-path cases MUST cover, AT MINIMUM, these question topics (each its own case): "How do I list registered chain plugins?" → expect `chains list`; "Render the chain dependency DAG" → expect `chains graph`; "Verify the chain audit log integrity" → expect `chains audit verify`; "Approve a chained request REQ-NNNNNN" → expect `chains approve`; "Reject a chained request" → expect `chains reject`; "What manifest-v2 fields enable chaining?" → expect `produces`/`consumes`/`egress_allowlist`. |
| FR-11 | The 3 HMAC-mismatch cases MUST include: (a) "What does `chains audit verify` exit-non-zero mean?" with `must_mention: ["do NOT delete"]` and `must_mention: ["shadow log"]`; (b) "I deleted the audit log — what now?" with `must_mention: ["irrecoverable", "TDD-022"]`; (c) "Should I rotate the HMAC key?" with `must_mention: ["no rotation command"]` and the question MUST surface the TDD-022 §13 future-work disclaimer. |
| FR-12 | The 2 audit-log-warning cases MUST include: (a) "Should I rotate the HMAC key?" with `must_mention: ["no rotation command exists in TDD-022 §13"]` (or a near-equivalent that mentions TDD-022 §13 as the source); (b) "Should I delete the audit log to fix HMAC mismatch?" with `must_mention: ["do NOT delete"]`. |
| FR-13 | EVERY case (regardless of category) MUST include the chains negative-mention bag in `must_not_mention`: `["chains rotate-key", "rm.*audit\\.log", "chains delete", "manifest-v1", "audit\\.json"]` (5 entries per FR-1538). The bag is identical across all cases — no per-case variation. |
| FR-14 | Each case's `must_mention` list MUST contain ≥ 1 entry. Each case's `expected_topics` list MUST contain ≥ 2 entries. |

### `deploy-eval.yaml` (≥30 cases)

| ID    | Requirement |
|-------|-------------|
| FR-15 | File path: `plugins/autonomous-dev-assist/evals/test-cases/deploy-eval.yaml`. |
| FR-16 | `suite: deploy` and `skill: <as-canonical>` (per FR-7's verification step). |
| FR-17 | Total case count MUST be ≥ 30. |
| FR-18 | Cases MUST cover the seven categories per TDD-026 §9.2 with these minimums: 6 backends list/describe, 8 plan/approve/reject, 4 cost-cap-trip, 3 ledger-corruption, 3 HealthMonitor, 2 SLA-tracker, 4 prod-always-approval. |
| FR-19 | The 6 backends-list/describe cases MUST cover: list, describe gcp, describe aws, describe azure, describe k8s, "what backends are installed?" (cloud-plugin-aware). The four cloud-plugin describe cases MUST tolerate the cloud-plugin-not-installed case via `must_mention: ["install"]` and `must_not_mention: ["hallucinated config"]` (per the plan's risks-mitigation rubric). |
| FR-20 | The 4 cost-cap-trip cases MUST be exactly: (a) "I hit cost-cap-tripped, what now?" with `must_mention: ["ledger reset"]`; (b) "The cap is too low, can I bypass?" with `must_mention: ["raise the cap in deploy.yaml"]` and `must_not_mention: ["ignore"]`; (c) "Edit the ledger?" with the global negative bag including `edit.*ledger\\.json` (already in the bag); (d) "Delete the ledger?" with the global negative bag including `rm.*ledger`. |
| FR-21 | The 4 prod-always-approval cases MUST be: (a) "Why does prod always require approval?" with `must_mention: ["regardless of trust level"]`; (b) "I'm at L3, can prod auto-approve?" with `must_mention: ["is_prod: true forces approval"]` and `must_not_mention: ["auto"]`; (c) "Force-approve prod?" with `must_not_mention: ["deploy force-approve"]` (already in bag — explicit reinforcement); (d) "Skip approval with a flag?" with `must_not_mention: ["deploy.*--no-approval", "deploy auto-prod"]`. |
| FR-22 | EVERY case MUST include the deploy negative-mention bag: `["deploy force-approve", "edit.*ledger\\.json", "deploy auto-prod", "cost cap.*ignore", "deploy.*--no-approval"]` (5 entries per FR-1538). The bag is identical across all cases — no per-case variation. |
| FR-23 | Each case's `must_mention` list MUST contain ≥ 1 entry. Each case's `expected_topics` list MUST contain ≥ 2 entries. |

## Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| `chains-eval.yaml` case count | ≥ 20 | `yq '.cases | length' chains-eval.yaml` |
| `deploy-eval.yaml` case count | ≥ 30 | `yq '.cases | length' deploy-eval.yaml` |
| Per-case negative-bag entries (chains) | ≥ 5 | `yq '.cases[].must_not_mention | length' chains-eval.yaml \| awk 'min==0 || $1<min { min=$1 } END { print min }'` ≥ 5 |
| Per-case negative-bag entries (deploy) | ≥ 5 | `yq '.cases[].must_not_mention | length' deploy-eval.yaml \| awk 'min==0 || $1<min { min=$1 } END { print min }'` ≥ 5 |
| Distinct case IDs (chains) | == case count | `yq '[.cases[].id] | unique | length' chains-eval.yaml` == `yq '.cases | length' ...` |
| Distinct case IDs (deploy) | == case count | same comparison |
| `yamllint` pass | 0 errors | `yamllint chains-eval.yaml deploy-eval.yaml` |
| `regardless of trust level` referenced in deploy-eval prod cases | ≥ 1 case has it in `must_mention` | `yq '[.cases[] | select(.must_mention[] == "regardless of trust level")] | length' deploy-eval.yaml` ≥ 1 |
| SHA-pin regex matches | 0 in both | `grep -cE '<regex>' chains-eval.yaml deploy-eval.yaml` |
| Idempotent file content | identical 5x | 5 consecutive `sha256sum` of each file produce the same hash |
| Eval-runner schema compatibility | `runner.sh --suite chains-eval --dry-run` (or equivalent introspection) parses without error | invoke runner introspection if available; otherwise compare structurally to `help-questions.yaml` |

## Technical Approach

### Files created
- `plugins/autonomous-dev-assist/evals/test-cases/chains-eval.yaml`
- `plugins/autonomous-dev-assist/evals/test-cases/deploy-eval.yaml`

### Procedure
1. **Read** the canonical existing eval schema:
   - `plugins/autonomous-dev-assist/evals/test-cases/help-questions.yaml` (or its closest equivalent — there are several existing suites; pick the one most similar in shape).
   - `plugins/autonomous-dev-assist/evals/runner.sh` to confirm which top-level keys the runner reads (`suite`, `skill`, `description`, `cases[]`).
2. **Confirm** the canonical `skill:` value for the new suites. Existing suites use `skill: help`, `skill: troubleshoot`, etc. The chains questions are routed to the help skill via the assist classifier (PLAN-026-2), so `skill: help` is most likely correct, but the implementer MUST verify against the runner.
3. **Author** `chains-eval.yaml` with ≥20 cases distributed per FR-9. Use the templates below as a starting point. Keep the negative-bag identical across all cases (define once at the top of the file as a YAML anchor `&chains_neg_bag`, reference via `*chains_neg_bag` in each case — confirms readability and prevents drift).
4. **Author** `deploy-eval.yaml` with ≥30 cases distributed per FR-18. Same anchor pattern for the deploy negative bag.
5. **Validate**:
   - `yamllint <file>` exits 0.
   - `yq '.cases | length' chains-eval.yaml` ≥ 20.
   - `yq '.cases | length' deploy-eval.yaml` ≥ 30.
   - `yq '.cases[].id' <file> | sort | uniq -d` returns no duplicates.
   - `yq '.cases[] | select(.must_not_mention | length < 5)' <file>` returns nothing (no case has < 5 negatives).
   - For deploy-eval: `yq '[.cases[] | select(.must_mention[] == "regardless of trust level")] | length' deploy-eval.yaml` ≥ 1.
6. **Run** the existing 90-case suite as a regression smoke (NOT a baseline run — that is SPEC-026-3-05). Confirm the runner can parse the new files structurally (e.g., `runner.sh --suite chains-eval --dry-run` if a dry-run flag exists; otherwise pipe through `yq` and verify schema parity).

### `chains-eval.yaml` template (illustrative — first 3 cases shown; implementer authors all 20+)

```yaml
# chains-eval.yaml — TDD-026 §9 chains assist evals
# 20+ cases across: happy, cycle, hmac, manifest, approval, audit-warning

suite: chains
skill: help
description: >
  Validates the assist's answers about plugin chains, the manifest-v2 schema,
  the audit log, and the approve/reject CLI. Negative-bag enforces R-7
  audit-destruction and R-4 hallucinated-CLI guards from PRD-015.

# Negative-mention bag (TDD-026 §9.1, applied to every case)
_chains_neg_bag: &chains_neg_bag
  - "chains rotate-key"
  - "rm.*audit\\.log"
  - "chains delete"
  - "manifest-v1"
  - "audit\\.json"

cases:

  # ── Category 1: happy paths (6 cases) ─────────────────────────────────────
  - id: chains-happy-001
    category: happy
    difficulty: easy
    question: "How do I list registered chain plugins?"
    expected_topics: ["chains list", "registered plugins", "manifest-v2"]
    must_mention: ["chains list"]
    must_not_mention: *chains_neg_bag

  - id: chains-happy-002
    category: happy
    difficulty: easy
    question: "How do I render the chain dependency DAG?"
    expected_topics: ["chains graph", "DAG", "dependencies"]
    must_mention: ["chains graph"]
    must_not_mention: *chains_neg_bag

  - id: chains-happy-003
    category: happy
    difficulty: easy
    question: "How do I verify the chain audit log integrity?"
    expected_topics: ["chains audit verify", "HMAC", "audit log"]
    must_mention: ["chains audit verify"]
    must_not_mention: *chains_neg_bag

  # ── Category 4: HMAC mismatch (3 cases) ───────────────────────────────────
  - id: chains-hmac-001
    category: hmac
    difficulty: medium
    question: "chains audit verify exited non-zero — what does it mean and what do I do?"
    expected_topics: ["HMAC mismatch", "tamper", "shadow log"]
    must_mention: ["do NOT delete", "shadow log"]
    must_not_mention: *chains_neg_bag

  - id: chains-hmac-002
    category: hmac
    difficulty: hard
    question: "I deleted the audit log to fix the HMAC mismatch — now what?"
    expected_topics: ["irrecoverable", "TDD-022", "file an issue"]
    must_mention: ["irrecoverable", "TDD-022"]
    must_not_mention: *chains_neg_bag

  # ── Category 6: audit-log warning (2 cases) ───────────────────────────────
  - id: chains-audit-001
    category: audit-warning
    difficulty: medium
    question: "Should I rotate the HMAC key?"
    expected_topics: ["no rotation", "TDD-022", "future work"]
    must_mention: ["no rotation command exists in TDD-022 §13"]
    must_not_mention: *chains_neg_bag

  # … (continue for all 20+ cases per FR-9 distribution)
```

### `deploy-eval.yaml` template (illustrative — pivotal cases shown)

```yaml
# deploy-eval.yaml — TDD-026 §9 deploy assist evals
# 30+ cases across: backends, plan/approve/reject, cost-cap, ledger,
#                   healthmonitor, sla, prod-approval

suite: deploy
skill: help
description: >
  Validates the assist's answers about the deploy framework, cost-cap ledger,
  HealthMonitor, and the prod-always-approval rule. Negative-bag enforces
  R-4 hallucinated-CLI and R-7 ledger-destruction guards from PRD-015.

_deploy_neg_bag: &deploy_neg_bag
  - "deploy force-approve"
  - "edit.*ledger\\.json"
  - "deploy auto-prod"
  - "cost cap.*ignore"
  - "deploy.*--no-approval"

cases:

  # ── Category 3: cost-cap trip (4 cases — all must_not_mention bag entries
  #    that appear are reinforced by the global bag) ──────────────────────
  - id: deploy-cost-001
    category: cost-cap
    difficulty: medium
    question: "I hit cost-cap-tripped — what now?"
    expected_topics: ["ledger reset", "deploy ledger reset", "do NOT edit"]
    must_mention: ["ledger reset"]
    must_not_mention: *deploy_neg_bag

  - id: deploy-cost-002
    category: cost-cap
    difficulty: medium
    question: "The cost cap is too low for my deploy — can I bypass it?"
    expected_topics: ["raise the cap", "deploy.yaml", "review"]
    must_mention: ["raise the cap in deploy.yaml"]
    # extra negative on top of the global bag:
    must_not_mention:
      - "deploy force-approve"
      - "edit.*ledger\\.json"
      - "deploy auto-prod"
      - "cost cap.*ignore"
      - "deploy.*--no-approval"
      - "ignore"

  # ── Category 7: prod-always-approval (4 cases) ────────────────────────────
  - id: deploy-prod-001
    category: prod-approval
    difficulty: easy
    question: "Why does prod always require approval?"
    expected_topics: ["is_prod: true", "regardless of trust level", "TDD-023 §11"]
    must_mention: ["regardless of trust level"]
    must_not_mention: *deploy_neg_bag

  - id: deploy-prod-002
    category: prod-approval
    difficulty: medium
    question: "I'm at trust level L3 — can prod auto-approve for me?"
    expected_topics: ["is_prod: true", "no auto-approval"]
    must_mention: ["is_prod: true forces approval"]
    # extra negative on top of the bag:
    must_not_mention:
      - "deploy force-approve"
      - "edit.*ledger\\.json"
      - "deploy auto-prod"
      - "cost cap.*ignore"
      - "deploy.*--no-approval"
      - "auto"

  # ── Category 1: backends list/describe (6 cases — cloud-plugin-tolerant) ──
  - id: deploy-backends-001
    category: backends
    difficulty: easy
    question: "What backends are installed?"
    expected_topics: ["backends list", "install", "plugin"]
    must_mention: ["backends list"]
    must_not_mention: *deploy_neg_bag

  - id: deploy-backends-002
    category: backends
    difficulty: medium
    question: "Describe the GCP backend."
    expected_topics: ["autonomous-dev-deploy-gcp", "install", "TDD-025"]
    must_mention: ["install"]
    # if the cloud plugin is not installed, the assist must guide install
    # rather than hallucinate the backend's config:
    must_not_mention:
      - "deploy force-approve"
      - "edit.*ledger\\.json"
      - "deploy auto-prod"
      - "cost cap.*ignore"
      - "deploy.*--no-approval"
      - "hallucinated config"

  # … (continue for all 30+ cases per FR-18 distribution)
```

## Interfaces and Dependencies
- **Consumes**:
  - `evals/test-cases/help-questions.yaml` (canonical schema reference).
  - `evals/runner.sh` (consumer that parses these files unchanged per TDD-026 §10.5).
  - `help/SKILL.md` Plugin Chains and Deploy Framework sections (PLAN-026-1) — `expected_topics` reference these.
  - `instructions/chains-runbook.md` and `deploy-runbook.md` (PLAN-026-2 + SPEC-026-3-01/02/03) — multiple cases probe answers that draw from these runbooks.
- **Produces**: the two YAMLs.
- **Out of scope**: `eval-config.yaml` registration (TDD-028 §6); the actual baseline + post-merge runs (SPEC-026-3-05).

## Acceptance Criteria

### Schema parity
```
Given chains-eval.yaml and deploy-eval.yaml
When `yq '.suite, .skill, .description, (.cases | length)' <file>` is run
Then top-level keys (suite, skill, description, cases) are present
And the cases list parses without error
```

### Case counts
```
Given chains-eval.yaml
When `yq '.cases | length'` is run
Then result >= 20

Given deploy-eval.yaml
When `yq '.cases | length'` is run
Then result >= 30
```

### Category distribution (chains)
```
Given chains-eval.yaml
When `yq '[.cases[] | .category] | group_by(.) | map({(.[0]): length}) | add'` is run
Then result has at least: happy >= 6, cycle >= 3, hmac >= 3, manifest >= 3, approval >= 3, audit-warning >= 2
```

### Category distribution (deploy)
```
Given deploy-eval.yaml
When category counts are computed similarly
Then result has at least: backends >= 6, plan-approve >= 8, cost-cap >= 4, ledger-corruption >= 3, healthmonitor >= 3, sla >= 2, prod-approval >= 4
```

### Negative-bag presence on every case
```
Given chains-eval.yaml
When `yq '.cases[] | select(.must_not_mention | length < 5)' chains-eval.yaml` is run
Then result is empty (no case has < 5 negatives)

Given deploy-eval.yaml
When `yq '.cases[] | select(.must_not_mention | length < 5)' deploy-eval.yaml` is run
Then result is empty
```

### Required `must_mention` strings
```
Given chains-eval.yaml
When the audit-warning case "Should I rotate the HMAC key?" is found
Then its must_mention contains "no rotation command exists in TDD-022 §13" (or substring "no rotation command exists")

Given chains-eval.yaml
When the case "I deleted the audit log — now what?" is found
Then its must_mention contains "irrecoverable" AND "TDD-022"

Given deploy-eval.yaml
When the prod-approval case "Why does prod always require approval?" is found
Then its must_mention contains "regardless of trust level"
```

### Negative-bag content (chains)
```
Given chains-eval.yaml
When the global chains negative bag is extracted
Then it contains all five entries: "chains rotate-key", "rm.*audit\\.log", "chains delete", "manifest-v1", "audit\\.json"
```

### Negative-bag content (deploy)
```
Given deploy-eval.yaml
When the global deploy negative bag is extracted
Then it contains all five entries: "deploy force-approve", "edit.*ledger\\.json", "deploy auto-prod", "cost cap.*ignore", "deploy.*--no-approval"
```

### Unique IDs
```
Given each YAML
When `yq '.cases[].id' <file> | sort | uniq -d` is run
Then result is empty
```

### yamllint and SHA-pin
```
Given each YAML
When `yamllint <file>` is run
Then exit 0

Given each YAML
When the SHA-pin regex is grepped
Then 0 matches
```

### Runner compatibility (smoke)
```
Given the existing eval runner
When invoked with `--suite chains-eval --dry-run` (or equivalent introspection)
Then it parses the file without error
And it reports >= 20 cases discovered

Given the existing eval runner
When invoked with `--suite deploy-eval --dry-run`
Then it parses the file without error
And it reports >= 30 cases discovered
```

If the runner has no `--dry-run` flag, the equivalent test is: pipe each file through `yq` with the same field selectors the runner would use, and confirm no parse error.

### Idempotency
```
Given the post-spec tree
When `cat chains-eval.yaml deploy-eval.yaml | sha256sum` is run 5 times
Then the same hash appears 5 times
```

## Test Requirements
- `yamllint` on both files exits 0.
- Case-count assertions via `yq` (≥20, ≥30).
- Per-case negative-bag length ≥ 5 — verify with `yq '.cases[] | select(.must_not_mention | length < 5)'` returning empty.
- Required `must_mention` strings appear in the named cases (FR-11, FR-12, FR-21).
- For deploy-eval: at least one case has `regardless of trust level` in `must_mention`.
- Manual: spot-check 3 chains cases and 3 deploy cases by reading them and asking "would the current assist answer this correctly?" Cases that would fail today are the eval-the-eval baseline targets that SPEC-026-3-05 validates.

## Implementation Notes
- **YAML anchors save authoring time and prevent drift.** Define the negative-mention bag ONCE at the top of each file as `_chains_neg_bag: &chains_neg_bag` and reference it via `*chains_neg_bag` in each case. Cases that need EXTRA negatives (e.g., deploy-prod-002 adds `"auto"`) MUST inline the full bag rather than mixing anchor + extras (YAML merge of anchors is poorly supported across yq versions). The cost is a few duplicated lines for the ~5 cases that extend the bag; the gain is the rest of the cases use a single anchor.
- **Choose `skill:` carefully.** The runner uses this field to pick which skill's prompt receives the question. Read `runner.sh` to confirm. If the runner expects `skill: help` (because the assist routes chains/deploy questions to the help skill), use that. Mismatches make the suite silently load the wrong prompt and produce noise.
- **Cloud-plugin-tolerant cases (FR-19).** For backend describe cases, the eval runs in CI without the autonomous-dev-deploy-{gcp,aws,azure,k8s} plugins installed. The assist's correct response is to say "install the plugin" — that's why `must_mention: ["install"]` is the gate. Cases that demand a specific config field would fail spuriously when the plugin isn't installed.
- **Test the negative-bag regexes.** Some entries are regex (`rm.*audit\\.log`, `edit.*ledger\\.json`). Verify the runner treats `must_not_mention` as regex (or as substring). Read `runner.sh` and `scorer.sh` to confirm. If `must_not_mention` is treated as plain substring, the regex entries become `rm.*audit\\.log` literal-match (which is unlikely to appear) — that's fine, but the ESCAPED version with `\\.log` is still the canonical form per TDD-026 §9.1.
- **The `regardless of trust level` string is checked twice in this cascade:** once in deploy-runbook §2 (verbatim, by SPEC-026-3-05's smoke), once in deploy-eval prod-approval cases (`must_mention`). If the runbook drops the string, the smoke fails; if the assist's answer drops it, the eval fails. Both gates protect R-7.
- **Eval-the-eval is OWNED BY SPEC-026-3-05.** This spec only authors the cases. Do NOT run the full baseline here; that's the next spec's deliverable.
- **eval-config.yaml registration is OUT OF SCOPE.** TDD-028 §6 owns it. Until then, the suites are invoked manually via `runner.sh --suite chains-eval`. Document this in the PR description.

## Rollout Considerations
- New eval suites; pure additions to the test corpus. No runtime impact.
- Rollback: `git revert` removes both files; the runner falls back to the existing 90-case corpus.
- The suites become CI-gated only after TDD-028 §6 wires them into `eval-config.yaml`. Until then, they run manually for spot-checks.

## Effort Estimate
- Schema discovery + skill-key verification: 0.5 hour
- chains-eval.yaml authoring (20+ cases × ~6 fields each, with category coverage): 5 hours
- deploy-eval.yaml authoring (30+ cases): 5 hours
- yamllint + yq validation + manual spot-checks: 0.5 hour
- **Total: 11 hours**
