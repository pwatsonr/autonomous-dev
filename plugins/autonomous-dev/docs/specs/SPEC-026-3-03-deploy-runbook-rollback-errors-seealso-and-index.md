# SPEC-026-3-03: deploy-runbook §6 Rollback + §7 Common Errors + §8 See Also + runbook.md See-Also Index

## Metadata
- **Parent Plan**: PLAN-026-3
- **Parent TDD**: TDD-026
- **Tasks Covered**: PLAN-026-3 Task 4 (§6 Rollback + §7 Common errors), Task 5 (§8 See also), Task 6 (`instructions/runbook.md` See-also index)
- **Estimated effort**: 7 hours
- **Status**: Draft
- **Author**: Specification Author (TDD-026 cascade)
- **Date**: 2026-05-02
- **Depends on**: SPEC-026-3-01 (file + §1, §2), SPEC-026-3-02 (§3, §4, §5)

## Summary
Append the final three sections of `instructions/deploy-runbook.md` and update `instructions/runbook.md` with the cross-runbook See-also index. §6 Rollback (~50 lines) forwards to PRD-014 §17.R7 for the rollback procedure (do not duplicate), describes invocation via `deploy rollback`, and what is preserved. §7 Common errors (~60 lines) MUST contain EXACTLY EIGHT error-message-to-action mappings, with mapping (7) — the impossible "prod skipped approval" misread — explicitly defused. §8 See also (~10 lines) cross-links chains-runbook §3, TDD-023 §5/§11/§14, `help/SKILL.md` Deploy Framework, and PRD-014 §17.R7. The runbook.md update appends a new `## See also` H2 at the file tail with four bulleted runbook links — two of which (`cred-proxy-runbook.md`, `firewall-runbook.md`) are owned by TDD-025 and intentionally dead at merge time (XFAIL whitelisted in SPEC-026-3-05's smoke). Total deploy-runbook.md size lands at 380–410 lines after this spec.

## Functional Requirements

### §6 Rollback (~50 lines)

| ID    | Requirement |
|-------|-------------|
| FR-1  | An H2 `## 6. Rollback` MUST be appended immediately after §5. |
| FR-2  | §6 MUST forward to PRD-014 §17.R7 mitigation for the actual rollback procedure (do NOT duplicate the procedure). The cross-link MUST use section-anchor form (e.g., `PRD-014 §17.R7` or a Markdown link with anchor `#17-r7`). |
| FR-3  | §6 MUST document the invocation command verbatim: `deploy rollback REQ-NNNNNN --to <previous-deploy-id>`. The `<previous-deploy-id>` placeholder MUST be the literal angle-bracketed token, not a real ID. |
| FR-4  | §6 MUST list what is preserved across rollback: logs (`deploy logs REQ-NNNNNN`), ledger entries (rollback APPENDS a new entry, never deletes), and audit-history continuity. |
| FR-5  | §6 MUST cite the §3 ledger discipline ("rollback appends to the ledger; **do NOT edit by hand**") to reinforce the safety contract. |
| FR-6  | §6 MUST NOT contain SHA pinning. |
| FR-7  | §6 line count MUST be between 40 and 60 (target ~50). |

### §7 Common errors (~60 lines, exactly 8 mappings)

| ID    | Requirement |
|-------|-------------|
| FR-8  | An H2 `## 7. Common errors` MUST be appended immediately after §6. |
| FR-9  | §7 MUST contain EXACTLY EIGHT error-message-to-action mappings. Format: a Markdown table with 8 data rows OR 8 H3-or-bullet items. |
| FR-10 | The eight mappings MUST cover (in any order): (1) stuck on `awaiting-approval` (action: forgot the approve command — `deploy approve REQ-NNNNNN`); (2) `cost-cap-tripped` from corrupt ledger (action: §3 procedure); (3) `cost-cap-tripped` from clock skew (action: §3 procedure with `--since`); (4) backend not registered (action: install the cloud plugin — `claude plugin install autonomous-dev-deploy-<backend>`, see TDD-025); (5) HealthMonitor degraded (action: §5 decision tree); (6) `deploy.yaml` schema error (action: validate against `deploy-config-v1`, see TDD-023 §9); (7) "prod skipped approval" — IMPOSSIBLE BY DESIGN (action: explain TDD-023 §11; the operator misread the logs; walk through actual behavior); (8) unknown REQ-NNNNNN (action: request was rejected or expired — check `deploy logs REQ-NNNNNN`). |
| FR-11 | Mapping (4) MUST cite TDD-025 explicitly (the cloud-backend plugins owned by TDD-025) AND include the literal command pattern `claude plugin install autonomous-dev-deploy-`. |
| FR-12 | Mapping (7) MUST contain the verbatim phrase `regardless of trust level` (reinforcing the §2 callout) AND the verbatim phrase `is_prod: true` (so an operator searching for "is_prod" finds the explanation). |
| FR-13 | §7 MUST NOT contain any of the deploy negative-bag strings: `deploy force-approve`, `deploy auto-prod`, `deploy.*--no-approval`, `cost cap.*ignore`. The negative-bag strings appearing here would teach the operator the wrong recovery; their absence is enforced by SPEC-026-3-05's smoke. |
| FR-14 | §7 MUST NOT contain SHA pinning. |
| FR-15 | §7 line count MUST be between 50 and 70 (target ~60). |

### §8 See also (~10 lines)

| ID    | Requirement |
|-------|-------------|
| FR-16 | An H2 `## 8. See also` MUST be appended immediately after §7. |
| FR-17 | §8 MUST contain EXACTLY FOUR cross-links (Markdown bullets): (a) `chains-runbook.md` §3 Audit Verification (the parallel safety-critical section), (b) TDD-023 §5 + §11 + §14 (one entry citing all three), (c) `help/SKILL.md` Deploy Framework, (d) PRD-014 §17.R7 mitigation. |
| FR-18 | Every link in §8 MUST use section-anchor form (no SHA pinning). |
| FR-19 | §8 line count MUST be between 8 and 15 (target ~10). |

### Total deploy-runbook.md size

| ID    | Requirement |
|-------|-------------|
| FR-20 | After §6, §7, §8 are appended, total `wc -l` on `deploy-runbook.md` MUST be in [380, 410] (target ~390 per TDD-026 §7.2). |

### `instructions/runbook.md` See-also index (Task 6)

| ID    | Requirement |
|-------|-------------|
| FR-21 | A new H2 `## See also` MUST be appended at the TAIL of `plugins/autonomous-dev-assist/instructions/runbook.md`. |
| FR-22 | The block MUST contain EXACTLY FOUR bulleted links: (a) `chains-runbook.md` (created by PLAN-026-2), (b) `deploy-runbook.md` (created by PLAN-026-3, this PR), (c) `cred-proxy-runbook.md` (owned by TDD-025; FILE DOES NOT EXIST YET — XFAIL), (d) `firewall-runbook.md` (owned by TDD-025; FILE DOES NOT EXIST YET — XFAIL). |
| FR-23 | The append MUST be the ONLY change to `runbook.md`. The existing 1263 lines MUST remain byte-identical (verify with `git diff --stat` showing only insertions, no deletions in the existing range). |
| FR-24 | The two TDD-025-owned links MUST be tagged with an HTML comment in the source identifying them as XFAIL until TDD-025 lands: `<!-- XFAIL: TDD-025 ships this runbook -->` placed adjacent to each of those bullets. |

## Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| `deploy-runbook.md` total lines after this spec | 380 – 410 | `wc -l deploy-runbook.md` |
| §7 mapping count | exactly 8 | count of table data rows OR H3 items in §7 |
| `regardless of trust level` in §7 mapping (7) | ≥ 1 | `awk '/^## 7\./, /^## 8\./' deploy-runbook.md \| grep -c 'regardless of trust level'` |
| Deploy negative-bag matches in §6 + §7 | 0 | `awk '/^## 6\./, /^## 8\./' deploy-runbook.md \| grep -cE 'deploy force-approve\|deploy auto-prod\|deploy.*--no-approval\|cost cap.*ignore'` |
| `runbook.md` line-count delta | +6 to +12 | `wc -l before` vs. `wc -l after` (one H2 + four bullets + blank lines + comments) |
| `runbook.md` existing 1263 lines unmodified | byte-identical | `git diff --stat` shows only additions; no `-` lines in the first 1263 |
| markdownlint pass on deploy-runbook | 0 errors | `markdownlint deploy-runbook.md` |
| markdownlint pass on runbook | 0 errors | `markdownlint runbook.md` |
| SHA-pin regex matches | 0 in both | `grep -cE '<regex>' deploy-runbook.md runbook.md` |
| Idempotent re-render | identical 5x | 5 consecutive `sha256sum deploy-runbook.md runbook.md` produce same hashes |

## Technical Approach

### Files modified
- `plugins/autonomous-dev-assist/instructions/deploy-runbook.md` (append §6, §7, §8)
- `plugins/autonomous-dev-assist/instructions/runbook.md` (append `## See also` block at tail)

### Procedure
1. **Read** `deploy-runbook.md` (post SPEC-026-3-02: §1–§5).
2. **Append §6** via `Edit` with the closing line of §5 as the unique `old_string`.
3. **Append §7** via `Edit` with the closing line of §6 as the unique `old_string`. Author exactly 8 mappings using a Markdown table. Validate count by `awk '/^## 7\./, /^## 8\./' | grep -c '^|.*|.*|'` ≥ 9 (header + separator + 8 data rows = 10 total `|`-lines).
4. **Append §8** via `Edit` with the closing line of §7 as the unique `old_string`.
5. **Verify** total `wc -l deploy-runbook.md` is in [380, 410]. If under: expand the worked example in mapping (7) (the most narrative mapping). If over: trim §6 forwarding language.
6. **Read** `runbook.md` last 30 lines.
7. **Append** the `## See also` H2 + four bullets at the file tail via `Edit` (use the existing last non-empty line as `old_string`, then append after it). Tag the cred-proxy and firewall bullets with HTML comments per FR-24.
8. **Validate**:
   - `git diff --stat runbook.md` shows ~10 lines inserted, 0 deleted.
   - `markdownlint` on both files exits 0.
   - SHA-pin grep on both files: 0 matches.

### §6 template (illustrative)

```markdown
## 6. Rollback

When HealthMonitor's degraded state crosses the > 30-minute threshold (see
§5), execute a rollback. The detailed mitigation procedure lives in
PRD-014 §17.R7 — follow it. This section documents the invocation surface
and what the runtime preserves.

### Invocation

```bash
deploy rollback REQ-NNNNNN --to <previous-deploy-id>
```

The `<previous-deploy-id>` is the request ID of the last `completed` deploy
in the same env (find it via `deploy logs --env <env> --status completed`).

### What rollback preserves

- **Logs.** `deploy logs REQ-NNNNNN` continues to return the failed deploy's
  history. Rollback does NOT redact.
- **Ledger entries.** Rollback APPENDS a new entry to
  `~/.autonomous-dev/deploy/ledger.json` describing the rollback action; the
  cost is recorded. **do NOT edit by hand** to suppress the entry — see §3.
- **Audit history.** Both the failed deploy and the rollback are visible via
  `deploy logs --request REQ-NNNNNN`.

The full mitigation playbook (pre-flight checks, communication template,
post-mortem template) is in PRD-014 §17.R7.
```

### §7 template (illustrative — exactly 8 mappings)

```markdown
## 7. Common errors

| Error / symptom                                | Cause                                                | Action                                                                                       |
|------------------------------------------------|------------------------------------------------------|----------------------------------------------------------------------------------------------|
| Stuck on `awaiting-approval`                   | `deploy approve` was never run                       | `deploy approve REQ-NNNNNN` (or `deploy reject REQ-NNNNNN --reason ...`)                     |
| `cost-cap-tripped` after a crash               | Inconsistent ledger entry                            | See §3 — `deploy ledger reset --request REQ-NNNNNN`; **do NOT edit by hand**                 |
| `cost-cap-tripped` from duplicate entries      | Clock skew across hosts                              | See §3 — `deploy ledger reset --since <ISO-timestamp>`                                       |
| `backend not registered: gcp` (or aws/azure/k8s) | The cloud-backend plugin isn't installed             | `claude plugin install autonomous-dev-deploy-gcp` (substitute the backend); see TDD-025      |
| HealthMonitor reports `degraded`               | Latency / error-rate breach post-deploy              | See §5 decision tree                                                                         |
| `deploy.yaml: schema error`                    | Config does not validate against `deploy-config-v1`  | Validate per TDD-023 §9; common: `is_prod` typo, missing `cost_cap_usd`                      |
| "Prod skipped approval" — operator concern     | Misread of logs; this is **impossible by design**     | Every env with `is_prod: true` requires approval **regardless of trust level**; see §2 + TDD-023 §11. Walk back through `deploy logs REQ-NNNNNN` — the `awaiting-approval` event IS there. |
| Unknown `REQ-NNNNNN`                           | Request was rejected, expired, or never existed     | `deploy logs REQ-NNNNNN` returns the historical state; if absent, the ID is invalid          |
```

### §8 template (illustrative)

```markdown
## 8. See also

- [chains-runbook.md §3 Audit verification](./chains-runbook.md#3-audit-verification) — parallel safety-critical section
- TDD-023 §5 (Deploy CLI), §11 (Trust integration), §14 (Ledger reset)
- [help/SKILL.md Deploy Framework](../skills/help/SKILL.md#deploy-framework)
- PRD-014 §17.R7 — Rollback mitigation playbook
```

### `runbook.md` See-also append template

```markdown
## See also

- [chains-runbook.md](./chains-runbook.md) — plugin chain operator runbook
- [deploy-runbook.md](./deploy-runbook.md) — deploy framework operator runbook
- [cred-proxy-runbook.md](./cred-proxy-runbook.md) — credential proxy runbook <!-- XFAIL: TDD-025 ships this runbook -->
- [firewall-runbook.md](./firewall-runbook.md) — egress firewall runbook <!-- XFAIL: TDD-025 ships this runbook -->
```

## Interfaces and Dependencies
- **Consumes**: `deploy-runbook.md` from SPEC-026-3-02 (file with §1–§5).
- **Produces**: §6, §7, §8 of `deploy-runbook.md`; `## See also` block at tail of `runbook.md`.
- **Cross-references**: deploy-runbook §8 cross-links chains-runbook (PLAN-026-2 product, on main); the link target file exists. The runbook.md See-also has two XFAIL links (cred-proxy, firewall) owned by TDD-025.
- **Eval consumers**: `deploy-eval.yaml` (SPEC-026-3-04) common-errors cases reference §7's eight mappings; rollback cases reference §6.

## Acceptance Criteria

### §6 forwarding to PRD-014 §17.R7
```
Given §6 of deploy-runbook.md
When the body is parsed
Then it cites PRD-014 §17.R7 in section-anchor form (string `PRD-014 §17.R7` OR a Markdown link with `#17-r7`)
And it does NOT duplicate the procedure (the section is < 60 lines)
And it contains the literal command `deploy rollback REQ-NNNNNN --to <previous-deploy-id>`
And §6 line count is in [40, 60]
```

### §7 exactly 8 mappings
```
Given §7 of deploy-runbook.md
When the data rows of the §7 table are counted
Then count = 8

Given the eight mappings
When their topics are extracted
Then they cover (in any order): awaiting-approval stuck, cost-cap from crash,
  cost-cap from clock skew, backend not registered, HealthMonitor degraded,
  deploy.yaml schema error, prod skipped approval (impossible), unknown REQ-NNNNNN
```

### §7 mapping (7) defuses the prod-approval misread
```
Given mapping (7) "prod skipped approval"
When the row's "Action" cell is parsed
Then it contains `regardless of trust level`
And it contains `is_prod: true`
And it cites §2 + TDD-023 §11
```

### §7 negative-bag absence
```
Given §6 + §7 of deploy-runbook.md
When `awk '/^## 6\./, /^## 8\./' deploy-runbook.md | grep -cE 'deploy force-approve|deploy auto-prod|deploy.*--no-approval|cost cap.*ignore'` is run
Then 0
```

### §7 mapping (4) cites TDD-025
```
Given mapping (4) "backend not registered"
When the row's "Action" cell is parsed
Then it contains the literal `claude plugin install autonomous-dev-deploy-`
And it references TDD-025
```

### §8 See-also four links
```
Given §8
When the bulleted Markdown links are counted
Then count >= 4
And one targets chains-runbook.md (the §3 anchor)
And at least one cites TDD-023 with §5/§11/§14 anchors
And one targets help/SKILL.md anchor "#deploy-framework"
And one cites PRD-014 §17.R7
```

### Total file size
```
Given deploy-runbook.md
When `wc -l deploy-runbook.md` is run
Then result is in [380, 410]
```

### runbook.md See-also index
```
Given the post-spec tree
When `tail -20 plugins/autonomous-dev-assist/instructions/runbook.md` is read
Then the file ends with a `## See also` H2 and four bulleted links
And exactly two of those bullets carry the HTML comment `<!-- XFAIL: TDD-025 ships this runbook -->`
And the four link targets are: chains-runbook.md, deploy-runbook.md, cred-proxy-runbook.md, firewall-runbook.md
And `git diff --stat plugins/autonomous-dev-assist/instructions/runbook.md` shows only additions, zero deletions
```

### markdownlint and SHA-pin
```
Given deploy-runbook.md
When `markdownlint` is run
Then exit 0

Given runbook.md
When `markdownlint` is run
Then exit 0

Given both files
When the SHA-pin regex is grepped
Then 0 matches in both files
```

### Idempotency
```
Given the post-spec tree
When `cat deploy-runbook.md runbook.md | sha256sum` is run 5 times
Then the same hash appears 5 times
```

## Test Requirements
- `awk '/^## 7\./, /^## 8\./' deploy-runbook.md | grep -c '^|.*|.*|'` returns 10 (1 header + 1 separator + 8 data rows).
- `grep -c 'regardless of trust level' deploy-runbook.md` returns ≥ 3 across the file (≥ 2 in §2, ≥ 1 in §7 mapping (7)).
- `wc -l deploy-runbook.md` returns a value in [380, 410].
- `markdownlint` on both files exits 0.
- `git diff plugins/autonomous-dev-assist/instructions/runbook.md` confirms only additions (no in-place edits to the existing 1263 lines).
- Manual: render `deploy-runbook.md` end-to-end; verify all eight §7 mappings render in a single readable table, and the §8 cross-links resolve (deploy-runbook → chains-runbook works on the post-merge tree).

## Implementation Notes
- The §7 table format vs. H3+bullet format: the deploy-eval.yaml (SPEC-026-3-04) has cases that ask "what does the runbook say to do when X?" — a table with consistent columns scans much faster than per-error H3s. Use the table format. If the existing chains-runbook §6 uses H3s for parity, that is acceptable, but the table is preferred here for the eval suite's benefit.
- Mapping (7) is the most authored mapping in §7 because operators frequently arrive at the runbook after misreading prod logs. The action cell can run 4–6 lines if needed; that's the only mapping with an oversized action. The eval suite has at least one case ("why does prod always require approval?") that scores higher when this mapping is well-written.
- The runbook.md See-also append is intentionally minimal — a new H2 + four bullets, no commentary. Adding a paragraph above the bullets would shift the file's existing line numbers (all references to "around line 1200" still work because the append is at the tail). Keep it surgical.
- The XFAIL HTML comments in runbook.md are NOT removed by SPEC-026-3-05's smoke (the smoke only whitelists the dead links at link-check time). They are removed by TDD-025 when those runbooks ship — captured as a follow-up TODO in TDD-025's plan, NOT this spec's DoD.
- The PRD-014 §17.R7 cross-reference: verify the anchor exists before merging (plan task 0 or risks list — `Grep -rn 'R-7\|R7\|17.R7' plugins/autonomous-dev/docs/prd/PRD-014-*.md`). If the anchor's actual shape is `§16` or `§17.7`, update both §6 and §8 to match. If PRD-014 has no rollback section AT ALL, defer §6 with a TODO + file a separate PRD-014 amendment (this is the plan's documented escape hatch).
- §8's TDD-023 entry combines §5/§11/§14 onto one bullet to keep the See-also at exactly four bullets (per FR-17). If the project style prefers one anchor per bullet, split into three bullets and accept the higher count; document the deviation in the PR description.

## Rollout Considerations
- Pure documentation. No runtime impact.
- Rollback: `git revert` removes §6/§7/§8 from deploy-runbook.md AND the runbook.md See-also append. Subsequent specs (SPEC-026-3-04 eval, SPEC-026-3-05 smoke) cross-reference these sections; reverting this spec without reverting downstream specs leaves dead anchors.
- The two XFAIL links in runbook.md remain dead until TDD-025 lands. SPEC-026-3-05's smoke whitelists them; before TDD-025 ships, attempting to remove the whitelist will fail link-check.

## Effort Estimate
- §6 Rollback (~50 lines, careful forwarding language): 1.5 hours
- §7 Common errors (8 mappings, careful authoring of mapping (7)): 3 hours
- §8 See also (~10 lines): 0.5 hour
- runbook.md See-also append: 0.5 hour
- Size + markdownlint validation + cross-anchor verification: 1.5 hours
- **Total: 7 hours**
