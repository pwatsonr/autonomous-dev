# SPEC-027-1-02: Troubleshooter — Chain + Deploy Diagnostic Subsections

## Metadata
- **Parent Plan**: PLAN-027-1
- **Parent TDD**: TDD-027 §5.1.2 (Chain + Deploy diagnostics), §8.1 (least-privilege, do-NOT guards), §4.2 (append-only)
- **Tasks Covered**: PLAN-027-1 Task 2 (Chain Diagnostics), Task 3 (Deploy Diagnostics)
- **Estimated effort**: 2.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-027-1-02-troubleshooter-chain-and-deploy-diagnostics.md`
- **Depends on**: SPEC-027-1-01 (file-locations rows + tool allowlist must land first; the diagnostic steps invoke `chains *` and `deploy *` Bash patterns added there).

## Summary
Append two new H4 diagnostic-procedure subsections — **Chain Diagnostics** and **Deploy Diagnostics** — to `agents/troubleshooter.md`, immediately after the existing "Configuration Issues" subsection. Both subsections are authored verbatim from TDD-027 §5.1.2 and contain the mandatory operator-protective "do NOT" guards exercised by the eval cases in SPEC-027-1-04. The Chain subsection covers `chains list / graph / audit verify`, cycle detection, and approval pending. The Deploy subsection covers `deploy backends list`, plan / ledger inspection, `deploy logs`, the seven-state approval enumeration, and the prod-always-requires-approval reminder citing TDD-023 §11. All edits are append-only per TDD-027 §4.2 / G-08.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-assist/agents/troubleshooter.md` | Modify | Append two new H4 subsections (`#### Chain Diagnostics`, `#### Deploy Diagnostics`) after the existing "Configuration Issues" H4. No deletions, no reorderings. |

## Functional Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| FR-1 | Insert a new H4 `#### Chain Diagnostics` after the existing `#### Configuration Issues` H4 (and before any subsequent existing H2/H3 such as "Emergency Procedures"). | TDD-027 §5.1.2 |
| FR-2 | The Chain Diagnostics subsection MUST contain exactly 5 numbered steps in the order: (1) `chains list`, (2) `chains graph`, (3) `chains audit verify` with HMAC-mismatch handling, (4) cycle detection via `chains graph --highlight-cycles`, (5) approval pending via `chains list --status awaiting-approval` + `chains approve` / `chains reject`. | TDD-027 §5.1.2 |
| FR-3 | The Chain Diagnostics step 3 MUST contain the verbatim text "**DO NOT delete the audit log.**" (exact case, exact bolding) and a pointer to `instructions/chains-runbook.md` §3 (TDD-026 ownership). | TDD-027 §5.1.2, §8.1; PLAN-027-1 Task 2 |
| FR-4 | Insert a new H4 `#### Deploy Diagnostics` immediately after the new Chain Diagnostics subsection. | TDD-027 §5.1.2 |
| FR-5 | The Deploy Diagnostics subsection MUST contain exactly 6 numbered steps in the order: (1) `deploy backends list`, (2) plan inspection (`cat .../plans/REQ-NNNNNN.json | jq .`), (3) ledger inspection with "do NOT hand-edit" warning + `deploy ledger reset --env` recovery path, (4) read deploy logs via `deploy logs REQ-NNNNNN` or tail+jq, (5) approval-state inspection enumerating all seven states, (6) prod-always-requires-approval reminder citing TDD-023 §11. | TDD-027 §5.1.2 |
| FR-6 | The Deploy Diagnostics step 5 MUST list these seven approval states in this exact order: `pending`, `awaiting-approval`, `approved`, `rejected`, `executing`, `completed`, `failed`. | TDD-027 §5.1.2 |
| FR-7 | The Deploy Diagnostics step 3 MUST contain the verbatim text "do NOT hand-edit" and the recovery command `deploy ledger reset --env <env>`. | TDD-027 §5.1.2, §8.1; matched by eval `tshoot-deploy-002` (SPEC-027-1-04) |
| FR-8 | The Deploy Diagnostics step 6 MUST contain the substring "TDD-023 §11" and a sentence explaining that prod deploys ALWAYS require human approval regardless of trust level. | TDD-027 §5.1.2 |
| FR-9 | Both new subsections MUST appear in the order: Chain Diagnostics first, Deploy Diagnostics second (matching TDD-027 §5.1.2 document order). | TDD-027 §5.1.2 |
| FR-10 | All existing H2/H3/H4 sections MUST remain unchanged in order, content, and heading level. The "Configuration Issues" H4 and the next existing structural element MUST sandwich the two new H4s. | TDD-027 §4.2 (G-08) |

## Non-Functional Requirements

| Requirement | Target | Measurement Method |
|------------|--------|--------------------|
| Combined prompt-token impact (this spec) | < 500 net additional tokens | Diff line count: ~30 lines for Chain Diagnostics + ~25 lines for Deploy Diagnostics ≈ 450–500 tokens; verified against TDD-027 §8.3 (`+800` total budget across PLAN-027-1) |
| Markdown lint | Zero errors at default strictness | Run `markdownlint plugins/autonomous-dev-assist/agents/troubleshooter.md` (or equivalent) and confirm exit 0 |
| Rendered subsection ordering | Configuration Issues → Chain Diagnostics → Deploy Diagnostics → next existing H2/H3 | Visual inspection of rendered table-of-contents |
| Append-only | 100% of changed lines are insertions | `git diff main -- plugins/autonomous-dev-assist/agents/troubleshooter.md` shows only `+` lines in body |
| First-token latency on agent invocation | < 15 s p95 | TDD-027 §11; smoke check via PLAN-017-3 eval runner |

## Technical Approach

### Insertion strategy
1. Read the post-SPEC-027-1-01 state of `troubleshooter.md`.
2. Locate the existing `#### Configuration Issues` H4 subsection (or its current heading text — preserve byte-for-byte).
3. Find the end of that subsection (the next heading at H4 or shallower, or the next H2/H3 boundary). The two new H4s are inserted at that boundary.
4. The new content order: existing "Configuration Issues" body → blank line → `#### Chain Diagnostics` + body → blank line → `#### Deploy Diagnostics` + body → blank line → existing next section.

### Chain Diagnostics body (verbatim from TDD-027 §5.1.2)

```markdown
#### Chain Diagnostics

1. List all registered chain plugins: `chains list`
2. Render the dependency DAG: `chains graph`
3. Verify the audit log: `chains audit verify`
   - HMAC mismatch: **DO NOT delete the audit log.** Inspect `~/.autonomous-dev/chains/manifest.lock` for divergence; the recovery path is in `instructions/chains-runbook.md` §3 (owned by TDD-026).
4. Cycle detected: identify the offending edge with `chains graph --highlight-cycles`. The fix is in the offending plugin's `produces`/`consumes` declaration.
5. Approval pending: list pending approvals with `chains list --status awaiting-approval`; approve with `chains approve REQ-NNNNNN` or reject with `chains reject REQ-NNNNNN --reason "..."`.
```

### Deploy Diagnostics body (verbatim from TDD-027 §5.1.2)

```markdown
#### Deploy Diagnostics

1. List backends: `deploy backends list`. If the expected backend is missing, the corresponding cloud plugin (`autonomous-dev-deploy-{cloud}`) is not installed.
2. Inspect the plan: `cat ~/.autonomous-dev/deploy/plans/REQ-NNNNNN.json | jq .`
3. Inspect the ledger: `cat ~/.autonomous-dev/deploy/ledger.json | jq '.environments.<env>'`. Do NOT hand-edit; if corrupted, use `deploy ledger reset --env <env>`.
4. Read deploy logs: `deploy logs REQ-NNNNNN` (or `tail -f ~/.autonomous-dev/deploy/logs/REQ-NNNNNN.jsonl | jq .`)
5. Check the approval state: `cat ~/.autonomous-dev/deploy/plans/REQ-NNNNNN.json | jq .approval_state`. Valid states: `pending`, `awaiting-approval`, `approved`, `rejected`, `executing`, `completed`, `failed`.
6. Prod deploys ALWAYS require human approval regardless of trust level (TDD-023 §11). If stuck on `awaiting-approval` for a prod env, run `deploy approve REQ-NNNNNN`.
```

### Error handling at edit time
- If `#### Configuration Issues` H4 is not present, abort with an explicit error. Do NOT guess an insertion point.
- If a previous spec or external edit already inserted a `#### Chain Diagnostics` heading, abort and surface the conflict; do NOT silently overwrite.
- Preserve the exact backtick and emphasis (`**...**`) characters from the TDD when copying — these are matched by the eval cases.

## Acceptance Criteria

```
Given the troubleshooter.md file post-SPEC-027-1-01
When this spec's edits are applied
Then exactly two new H4 headings exist with text "Chain Diagnostics" and "Deploy Diagnostics"
And both appear after the existing "Configuration Issues" H4
And both appear before the next existing H2/H3 heading
```

```
Given the modified troubleshooter.md
When the Chain Diagnostics subsection body is read
Then the body contains exactly 5 numbered list items in order: chains list, chains graph, chains audit verify (with DO NOT delete), cycle detection, approval pending
And the body contains the verbatim substring "**DO NOT delete the audit log.**"
And the body contains the substring "instructions/chains-runbook.md"
And the body contains the substring "TDD-026"
```

```
Given the modified troubleshooter.md
When the Deploy Diagnostics subsection body is read
Then the body contains exactly 6 numbered list items in order
And the body contains the substring "deploy backends list"
And the body contains the substring "deploy ledger reset --env"
And the body contains the verbatim substring "do NOT hand-edit"
And the body contains the substring "TDD-023 §11"
And the body lists exactly these seven approval states in order: pending, awaiting-approval, approved, rejected, executing, completed, failed
```

```
Given the modified troubleshooter.md
When `git diff main -- plugins/autonomous-dev-assist/agents/troubleshooter.md` is run
Then the diff contains zero deletion lines (no '-' lines outside diff headers)
And the change is purely additive
```

```
Given the modified troubleshooter.md
When the document's H2/H3 ordering on main vs. the modified file is compared
Then every existing H2 and H3 heading appears in the same relative order on both files
```

### Edge cases / sad paths
```
Given a corrupt source where the existing "Configuration Issues" H4 has been renamed
When the implementer attempts to apply the edit
Then the implementer aborts with "anchor not found"
And does NOT insert at a guessed location
```

```
Given that SPEC-027-1-01 has not yet been applied (tool-allowlist missing)
When the implementer attempts to apply this spec
Then the implementer surfaces a dependency warning
And may proceed (the prompt-text edits are independent of the allowlist)
But notes in the PR that runtime invocations of `chains *` / `deploy *` will fail until SPEC-027-1-01 lands
```

```
Given an operator hits the prod-always-requires-approval guidance
When they attempt to suggest "deploy auto-prod" or "--no-approval"
Then the eval `tshoot-deploy-001` (SPEC-027-1-04) MUST flag any agent response that emits those forbidden phrases
```

## Test Requirements

### Static
- `grep -c "^#### Chain Diagnostics$" troubleshooter.md` returns 1
- `grep -c "^#### Deploy Diagnostics$" troubleshooter.md` returns 1
- `grep -c "DO NOT delete the audit log" troubleshooter.md` returns 1
- `grep -c "do NOT hand-edit" troubleshooter.md` returns ≥ 1
- `grep -c "TDD-023 §11" troubleshooter.md` returns ≥ 1
- The seven-state ordering check: a regex or scripted test confirms the order `pending, awaiting-approval, approved, rejected, executing, completed, failed` appears as a single comma-separated list in step 5.

### Integration / regression
- The existing troubleshoot-scenarios suite continues to pass at the established threshold (PLAN-017-3 gate).
- The new eval cases authored in SPEC-027-1-04 (`tshoot-chains-001`, `tshoot-deploy-001`, `tshoot-deploy-002`) MUST pass when run against the agent post-this-spec; this is the smoke run in PLAN-027-1 Task 9.

### Manual review
- Reviewer reads each new H4 subsection aloud and confirms the mandatory "do NOT" warnings are intact and worded as TDD-027 §5.1.2 specifies.

## Implementation Notes

- The two subsections are independent; they may be inserted in either order programmatically as long as the on-disk order matches FR-9 (Chain first, Deploy second).
- The TDD's verbatim text uses ASCII section markers (`§`) and angle-bracket placeholders (`<env>`, `REQ-NNNNNN`). Preserve them exactly — eval `must_mention` strings target these.
- Follow the exact emphasis style of the existing diagnostic procedures (e.g., "Daemon Not Starting" uses bold and inline code for command names).
- Do NOT add a "Prerequisites" or "Background" sub-block to either H4 — the procedures are flat numbered lists per the existing style.

## Rollout Considerations

- **Rollout**: Markdown-only PR; agent prompt is reloaded on every invocation.
- **Feature flag**: None.
- **Rollback**: Revert the commit; the troubleshooter loses Chain + Deploy diagnostic guidance but no operator data is affected.
- **Coordination**: This spec depends on SPEC-027-1-01 to make the diagnostics actually invocable. Both can land in the same PR (single commit per spec, sequenced commits).

## Effort Estimate

| Activity | Hours |
|----------|-------|
| Insert Chain Diagnostics subsection (~30 lines, verbatim copy + anchor) | 1.0 |
| Insert Deploy Diagnostics subsection (~25 lines, verbatim copy + anchor) | 1.0 |
| Static checks + regression smoke | 0.5 |
| **Total** | **2.5** |
