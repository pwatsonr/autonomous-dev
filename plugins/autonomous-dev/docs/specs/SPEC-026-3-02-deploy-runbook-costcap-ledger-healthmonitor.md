# SPEC-026-3-02: deploy-runbook §3 Cost-Cap Recovery + §4 Ledger Inspection + §5 HealthMonitor

## Metadata
- **Parent Plan**: PLAN-026-3
- **Parent TDD**: TDD-026
- **Tasks Covered**: PLAN-026-3 Task 2 (§3 Cost-cap trip recovery — the safety-critical section), Task 3 (§4 Ledger inspection + §5 HealthMonitor + SLA tracker)
- **Estimated effort**: 9 hours
- **Status**: Draft
- **Author**: Specification Author (TDD-026 cascade)
- **Date**: 2026-05-02
- **Depends on**: SPEC-026-3-01 (deploy-runbook.md exists with §1 + §2)

## Summary
Append three sections to `instructions/deploy-runbook.md`: §3 Cost-cap trip recovery (~80 lines, safety-critical — the "do NOT edit by hand" passage), §4 Ledger inspection (~40 lines with three syntactically valid `jq` recipes), and §5 HealthMonitor + SLA tracker (~50 lines with the rollback decision tree). §3 is the dominant operator-safety section: it is the runbook authority that matters when an operator hits `cost-cap-tripped` in the middle of an incident. The verbatim phrases "do NOT edit by hand" (≥ 2x) and "do NOT rm the ledger" (≥ 1x) MUST appear, and `deploy ledger reset` MUST be cited as the supported recovery in ≥ 3 places. The negative-eval guards from TDD-026 §9.1 are pre-empted in §3: regex `edit.*ledger\.json` is permitted ONLY inside lines that ALSO contain `do NOT`, and `cost cap.*ignore` is forbidden outright.

## Functional Requirements

### §3 Cost-cap trip recovery (~80 lines, safety-critical)

| ID    | Requirement |
|-------|-------------|
| FR-1  | An H2 `## 3. Cost-cap trip recovery` MUST be appended immediately after §2. |
| FR-2  | §3 MUST OPEN with a callout/blockquote containing the verbatim phrase `do NOT edit by hand` (referring to `~/.autonomous-dev/deploy/ledger.json`). |
| FR-3  | §3 MUST explain the cost-cap trip mechanism: a running tally maintained in the append-only ledger is compared against `cost_cap_usd` from `deploy.yaml`; when the next deploy would exceed the cap, the request enters `cost-cap-tripped` state instead of `executing`. |
| FR-4  | §3 MUST document the recovery procedure as a numbered list of FOUR steps: (1) read the ledger via `cat ~/.autonomous-dev/deploy/ledger.json | jq` (or equivalent), (2) identify the offending entry, (3) decide between `deploy ledger reset` and "wait for the billing reset", (4) re-run `deploy plan REQ-NNNNNN`. |
| FR-5  | §3 MUST list THREE common causes with their per-cause recovery: (a) crash mid-deploy left the ledger in an inconsistent state — recovery: `deploy ledger reset --request REQ-NNNNNN`; (b) clock skew across hosts produced a duplicate entry — recovery: `deploy ledger reset --since <timestamp>`; (c) genuine cost overrun — recovery: raise the cap in `deploy.yaml` and re-plan. |
| FR-6  | §3 MUST contain a SECOND occurrence of the verbatim phrase `do NOT edit by hand` inside the recovery procedure (not just the opening callout). The "Stripe-style append-only contract" rationale MUST appear nearby ("manual edits corrupt the cost-tracking invariant" or equivalent). |
| FR-7  | §3 MUST contain at least one occurrence of the verbatim phrase `do NOT rm the ledger` (or `do NOT delete the ledger` — but the smoke test in SPEC-026-3-05 will check for the literal `do NOT rm the ledger`, so use that exact wording). |
| FR-8  | §3 MUST cite `deploy ledger reset` as the supported recovery path in AT LEAST THREE places (e.g., overview paragraph, per-cause section, summary line). |
| FR-9  | §3 MUST NOT contain the regex `edit.*ledger\.json` outside of `do NOT` context. Concretely: every line that matches `edit.*ledger\.json` MUST also contain `do NOT`. |
| FR-10 | §3 MUST NOT contain the regex `cost cap.*ignore` (no occurrences anywhere). |
| FR-11 | §3 MUST NOT contain SHA pinning. |
| FR-12 | §3 line count MUST be between 70 and 90 (target ~80). |

### §4 Ledger inspection (~40 lines)

| ID    | Requirement |
|-------|-------------|
| FR-13 | An H2 `## 4. Ledger inspection` MUST be appended immediately after §3. |
| FR-14 | §4 MUST document the ledger schema per TDD-023 §14: `entries[]` with the fields `request_id`, `env`, `backend`, `cost_usd`, `timestamp`, `signature`. The schema MUST be presented as a fenced JSON block illustrating one example entry. |
| FR-15 | §4 MUST include EXACTLY THREE `jq` recipes, each in its own fenced bash block: (a) last-7-days total cost across all entries, (b) per-environment cost breakdown, (c) signature-violation finder (entries whose `signature` field is empty / missing / malformed). |
| FR-16 | Each `jq` recipe MUST be syntactically valid: it parses cleanly under `jq -n 'null | <recipe>'` or against a fixture ledger. The implementer MUST verify locally by piping a dummy fixture through the recipe. |
| FR-17 | §4 MUST cite TDD-023 §14 (Ledger Reset / Ledger schema) using section-anchor form. |
| FR-18 | §4 line count MUST be between 35 and 50 (target ~40). |

### §5 HealthMonitor + SLA tracker (~50 lines)

| ID    | Requirement |
|-------|-------------|
| FR-19 | An H2 `## 5. HealthMonitor + SLA tracker` MUST be appended immediately after §4. |
| FR-20 | §5 MUST document the post-deploy SLA tracker via the literal command `deploy logs REQ-NNNNNN --health` and explain its output (latency p50/p95, error-rate, SLA window). |
| FR-21 | §5 MUST define the SLA-degraded state: when latency or error-rate breaches the threshold from `deploy.yaml`, HealthMonitor reports `degraded` and starts a timer. |
| FR-22 | §5 MUST present the rollback decision tree as EITHER an ASCII flowchart OR a numbered checklist with three branches: (a) degraded for < 5 minutes → monitor (no action); (b) degraded for 5–30 minutes → prepare rollback (alert on-call, capture metrics, dry-run `deploy rollback`); (c) degraded for > 30 minutes → rollback per §6. |
| FR-23 | §5 MUST forward to §6 for the actual rollback procedure (do not duplicate). |
| FR-24 | §5 line count MUST be between 45 and 60 (target ~50). |

## Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| `do NOT edit by hand` count in §3 | ≥ 2 | `awk '/^## 3\./, /^## 4\./' deploy-runbook.md \| grep -c 'do NOT edit by hand'` |
| `do NOT rm the ledger` count in §3 | ≥ 1 | `awk '/^## 3\./, /^## 4\./' deploy-runbook.md \| grep -c 'do NOT rm the ledger'` |
| `deploy ledger reset` mentions in §3 | ≥ 3 | `awk '/^## 3\./, /^## 4\./' deploy-runbook.md \| grep -c 'deploy ledger reset'` |
| `edit.*ledger\.json` matches outside `do NOT` context in §3 | 0 | `awk '/^## 3\./, /^## 4\./' deploy-runbook.md \| grep -E 'edit.*ledger\.json' \| grep -vc 'do NOT'` |
| `cost cap.*ignore` matches in §3 | 0 | `awk '/^## 3\./, /^## 4\./' deploy-runbook.md \| grep -cE 'cost cap.*ignore'` |
| §3 + §4 + §5 combined line count | 145 – 200 | `awk '/^## 3\./, /^## 6\./' deploy-runbook.md \| wc -l` (or `/EOF/` if §6 not yet present) |
| `jq` recipe validity (each of the three) | each parses | `jq -n 'null | <recipe>'` exits 0 for each, OR pipe a fixture: `echo '{"entries":[]}' \| jq '<recipe>'` exits 0 |
| markdownlint pass | 0 errors | `markdownlint deploy-runbook.md` |
| SHA-pin regex matches | 0 | `grep -cE '(commit[[:space:]]+[a-f0-9]{7,40}\|as of [a-f0-9]{7,40}\|fixed in [a-f0-9]{7,40})' deploy-runbook.md` |
| Idempotent re-render | identical 5x | 5 consecutive `sha256sum deploy-runbook.md` produce the same hash |

## Technical Approach

### Files modified
- `plugins/autonomous-dev-assist/instructions/deploy-runbook.md` (append §3, §4, §5)

### Procedure
1. **Read** the current `deploy-runbook.md` (post-SPEC-026-3-01: §1 + §2 only).
2. **Identify** the closing line of §2 (the last line before EOF, or a sentinel comment if SPEC-026-3-01 added one). Use it as the unique `old_string` for the §3 `Edit`.
3. **Append §3** via `Edit`. Author the callout, the trip-mechanism explanation, the four-step recovery procedure, the three causes with per-cause recovery, and the closing summary that reiterates `do NOT edit by hand` + `deploy ledger reset` + `do NOT rm the ledger`.
4. **Append §4** via `Edit` with the closing line of §3 as the unique `old_string`. Author the schema JSON block + three jq recipes.
5. **Append §5** via `Edit` with the closing line of §4 as the unique `old_string`. Author the SLA explanation + decision tree.
6. **Validate locally**:
   - `awk '/^## 3\./, /^## 4\./' deploy-runbook.md | grep -c 'do NOT edit by hand'` ≥ 2.
   - `awk '/^## 3\./, /^## 4\./' deploy-runbook.md | grep -c 'do NOT rm the ledger'` ≥ 1.
   - `awk '/^## 3\./, /^## 4\./' deploy-runbook.md | grep -c 'deploy ledger reset'` ≥ 3.
   - `awk '/^## 3\./, /^## 4\./' deploy-runbook.md | grep -E 'edit.*ledger\.json' | grep -v 'do NOT' | wc -l` == 0.
   - For each jq recipe: `echo '{"entries":[]}' | jq '<recipe>'` exits 0.
   - `markdownlint deploy-runbook.md` exits 0.

### §3 template (illustrative — annotated to show every safety string)

```markdown
## 3. Cost-cap trip recovery

> **Safety:** `~/.autonomous-dev/deploy/ledger.json` is the cost-tracking
> invariant. **do NOT edit by hand**. **do NOT rm the ledger**. The supported
> recovery is `deploy ledger reset` — see below.

### How the cost cap works

The deploy executor maintains a running per-environment tally in the
append-only `ledger.json`. Each completed deploy appends one entry. When the
NEXT planned deploy's estimated cost would push the tally past
`cost_cap_usd` (from `deploy.yaml`), the executor refuses to enter
`executing` and emits `cost-cap-tripped`.

The ledger is a Stripe-style append-only contract. Manual edits corrupt the
cost-tracking invariant — **do NOT edit by hand**. Use `deploy ledger reset`.

### Recovery procedure

1. Read the ledger:
   ```bash
   cat ~/.autonomous-dev/deploy/ledger.json | jq '.entries[-5:]'
   ```
2. Identify the offending entry (the most recent `cost-cap-tripped` request,
   or any duplicate / impossible entry).
3. Decide between:
   - `deploy ledger reset --request REQ-NNNNNN` — reconcile a single entry.
   - `deploy ledger reset --since <ISO-timestamp>` — truncate from a point.
   - Wait for the billing-period reset (the cap is per-period; check
     `deploy.yaml`).
4. Re-run `deploy plan REQ-NNNNNN --env <env>`.

### Common causes

#### (a) Crash mid-deploy

The executor crashed between writing the ledger entry and completing the
deploy, leaving the tally inconsistent. Use:

```bash
deploy ledger reset --request REQ-NNNNNN
```

#### (b) Clock skew across hosts

A duplicate entry appears with a near-identical timestamp. Truncate from the
earliest skewed entry:

```bash
deploy ledger reset --since 2026-05-02T14:00:00Z
```

#### (c) Genuine cost overrun

The deploys are landing as planned; the cap is too low. Edit `deploy.yaml` to
raise `cost_cap_usd`, commit, and re-plan. **do NOT** silently bypass the
cap — every change to `cost_cap_usd` is reviewable in version control.

### What NOT to do

- **do NOT edit by hand** any field in `ledger.json` (signatures break, tally
  diverges, audit trail loses integrity).
- **do NOT rm the ledger** — there is no recovery from a deleted ledger; the
  cost tally is irrecoverable.
- Do NOT use `vi`, `sed`, or any in-place editor. The supported recovery is
  always `deploy ledger reset`.
```

### §4 template (illustrative)

```markdown
## 4. Ledger inspection

The ledger schema (per TDD-023 §14):

```json
{
  "entries": [
    {
      "request_id": "REQ-NNNNNN",
      "env": "staging",
      "backend": "gcp",
      "cost_usd": 12.40,
      "timestamp": "2026-05-02T14:32:11Z",
      "signature": "<HMAC>"
    }
  ]
}
```

### Recipe 1 — last-7-days total cost

```bash
jq '[.entries[]
     | select((.timestamp | fromdateiso8601) > (now - 604800))
     | .cost_usd] | add' ~/.autonomous-dev/deploy/ledger.json
```

### Recipe 2 — per-environment breakdown

```bash
jq '.entries | group_by(.env) | map({env: .[0].env, total: (map(.cost_usd) | add)})' \
  ~/.autonomous-dev/deploy/ledger.json
```

### Recipe 3 — signature-violation finder

```bash
jq '.entries[] | select(.signature == null or .signature == "")' \
  ~/.autonomous-dev/deploy/ledger.json
```

If any signature-violation entry appears, file a TDD-023 issue — do NOT
delete the entry; do NOT edit by hand.
```

### §5 template (illustrative)

```markdown
## 5. HealthMonitor + SLA tracker

After a deploy enters `completed`, HealthMonitor watches the post-deploy SLA
window. Inspect the live state:

```bash
deploy logs REQ-NNNNNN --health
```

Output includes latency p50/p95, error-rate, and the SLA window remaining.
The `degraded` state activates when latency or error-rate breaches the
threshold from `deploy.yaml` (see TDD-023 §11 for thresholds).

### Rollback decision tree

When HealthMonitor reports `degraded`, decide based on duration:

1. **Degraded for < 5 minutes:** monitor; transient blips are common during
   warm-up. Do nothing yet.
2. **Degraded for 5–30 minutes:** prepare for rollback. Alert on-call.
   Capture metrics (`deploy logs REQ-NNNNNN --health > /tmp/health.txt`).
   Run a dry-run rollback (`deploy rollback REQ-NNNNNN --dry-run --to <prev>`).
3. **Degraded for > 30 minutes:** execute rollback per §6.

The thresholds are advisory — if the failure mode is unambiguous (e.g.,
5xx-rate at 100%), skip directly to step 3.
```

## Interfaces and Dependencies
- **Consumes**: `deploy-runbook.md` from SPEC-026-3-01 (file with §1 + §2). Must merge first.
- **Produces**: §3, §4, §5 of `deploy-runbook.md`. Anchors `#3-cost-cap-trip-recovery`, `#4-ledger-inspection`, `#5-healthmonitor--sla-tracker` are stable from this point.
- **Cross-references**: §3 forwards to §4 (jq recipes); §5 forwards to §6 (rollback, lands in SPEC-026-3-03).
- **Eval consumers**: `deploy-eval.yaml` (SPEC-026-3-04) cost-cap-trip cases reference the §3 strings; ledger-corruption cases reference §3/§4 procedures; HealthMonitor cases reference §5.

## Acceptance Criteria

### §3 safety-string presence (the dominant assertion)
```
Given §3 of deploy-runbook.md
When `awk '/^## 3\./, /^## 4\./' deploy-runbook.md | grep -c 'do NOT edit by hand'` is run
Then count >= 2

Given §3 of deploy-runbook.md
When `awk '/^## 3\./, /^## 4\./' deploy-runbook.md | grep -c 'do NOT rm the ledger'` is run
Then count >= 1

Given §3 of deploy-runbook.md
When `awk '/^## 3\./, /^## 4\./' deploy-runbook.md | grep -c 'deploy ledger reset'` is run
Then count >= 3
```

### §3 negative-bag absence
```
Given §3 of deploy-runbook.md
When `awk '/^## 3\./, /^## 4\./' deploy-runbook.md | grep -E 'edit.*ledger\.json' | grep -v 'do NOT'` is run
Then 0 lines

Given §3 of deploy-runbook.md
When `awk '/^## 3\./, /^## 4\./' deploy-runbook.md | grep -cE 'cost cap.*ignore'` is run
Then 0
```

### §3 structure
```
Given §3
When the body is parsed
Then it contains a numbered four-step recovery procedure
And it lists three named causes (crash mid-deploy, clock skew, genuine cost overrun)
And §3 line count is in [70, 90]
```

### §4 jq recipes valid
```
Given §4 of deploy-runbook.md
When the three jq recipes are extracted from fenced bash blocks
Then exactly 3 recipes are present
And for each recipe `echo '{"entries":[]}' | jq '<recipe>'` exits 0 (syntactic validity)
And §4 line count is in [35, 50]
```

### §5 rollback decision tree
```
Given §5
When the body is parsed
Then it contains the literal command `deploy logs REQ-NNNNNN --health`
And it contains a three-branch decision tree (< 5 min, 5–30 min, > 30 min)
And it forwards to §6 for the rollback procedure
And §5 line count is in [45, 60]
```

### File-wide invariants
```
Given deploy-runbook.md
When `markdownlint` is run
Then exit 0

Given deploy-runbook.md
When the SHA-pin regex is grepped
Then 0 matches
```

### Idempotency
```
Given the post-spec tree
When `cat deploy-runbook.md | sha256sum` is run 5 times
Then the same hash appears 5 times
```

## Test Requirements
- For each `jq` recipe in §4, verify syntactic validity locally via `echo '<fixture>' | jq '<recipe>'` (exit 0).
- `awk '/^## 3\./, /^## 4\./' deploy-runbook.md | grep -c 'do NOT edit by hand'` returns ≥ 2.
- `markdownlint deploy-runbook.md` exits 0.
- Manual: render in a Markdown viewer; confirm the three numbered sub-sections of §3 (Recovery procedure, Common causes (a)/(b)/(c), What NOT to do) render legibly; the three jq blocks in §4 render as bash code; the three-branch decision tree in §5 is scannable.

## Implementation Notes
- The `do NOT edit by hand` and `do NOT rm the ledger` strings are enforced by SPEC-026-3-05's smoke test AND by `deploy-eval.yaml` (SPEC-026-3-04) `must_mention` clauses on cost-cap-trip cases. Drift is caught at multiple layers.
- The negative regex `edit.*ledger\.json` is intentionally strict: a phrase like "edit the ledger schema doc" would match. If the runbook author needs to discuss schema documentation, rephrase as "the ledger schema (defined in `ledger.json`)" or "schema documentation for `ledger.json`" — without the verb `edit` near the file token. The smoke test allows the regex match ONLY when `do NOT` is on the same line.
- The third jq recipe (signature-violation finder) is the operator's first signal that the audit trail is compromised. The recipe should NOT include `--remove` or any mutation — read-only inspection only.
- §3's "do NOT" callout at the top is duplicated in the "What NOT to do" closing block on purpose — operators in incident mode skim, and the duplication ensures the safety string is in the eyeline regardless of where they enter the section.
- Use the SAME `deploy ledger reset` syntax as TDD-023 §14 documents (`--request`, `--since`). Do NOT invent flags; the eval suite tests for the exact syntax.

## Rollout Considerations
- Pure documentation. No runtime impact.
- Rollback: `git revert` removes §3, §4, §5; the file falls back to §1 + §2 only. Subsequent specs (SPEC-026-3-03) that append §6 onward will conflict if applied without §3–§5 — sequential merge order is required.

## Effort Estimate
- §3 (safety-critical, ~80 lines, careful authoring + cross-checks): 5 hours
- §4 (~40 lines + three jq recipes + fixture validation): 2 hours
- §5 (~50 lines + decision tree): 1.5 hours
- markdownlint + local validation: 0.5 hour
- **Total: 9 hours**
