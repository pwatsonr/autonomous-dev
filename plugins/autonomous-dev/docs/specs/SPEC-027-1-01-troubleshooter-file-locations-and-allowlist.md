# SPEC-027-1-01: Troubleshooter File-Locations Table + Tool Allowlist Extensions

## Metadata
- **Parent Plan**: PLAN-027-1
- **Parent TDD**: TDD-027 §5.1.1, §5.1.3, §4.2 (append-only pattern), §8.1 (least-privilege)
- **Tasks Covered**: PLAN-027-1 Task 1 (file-locations 9 rows), Task 6 (tool-allowlist 4 entries), partial Task 8 (append-only verification of these surfaces)
- **Estimated effort**: 2.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-027-1-01-troubleshooter-file-locations-and-allowlist.md`

## Summary
Append nine new rows to the file-locations table in `agents/troubleshooter.md` covering the chains, deploy, cred-proxy, and firewall surfaces that landed between TDD-019 and `main`. Append four new entries to the agent's frontmatter `tools:` allowlist (`Bash(chains *)`, `Bash(deploy *)`, `Bash(cred-proxy *)`, `Bash(firewall *)`) so the diagnostic procedures specified in SPEC-027-1-02 and SPEC-027-1-03 can actually invoke the upstream commands. All edits are strictly append-only per TDD-027 §4.2 / G-08; existing rows, sections, frontmatter keys, and order are preserved byte-for-byte.

This spec is the structural-prerequisite spec for the other PLAN-027-1 specs: the diagnostic subsections (SPEC-027-1-02, SPEC-027-1-03) reference the file paths defined here, and they cannot execute the tool calls they specify without the allowlist entries added here.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-assist/agents/troubleshooter.md` | Modify | Append 9 file-locations rows (after the existing `~/.config/systemd/user/autonomous-dev.service` row); append 4 frontmatter `tools:` entries. No deletions, no reorderings. |

## Functional Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| FR-1 | Append exactly 9 new rows to the file-locations table after the existing `~/.config/systemd/user/autonomous-dev.service` row, in the order specified by TDD-027 §5.1.1. | PLAN-027-1 Task 1 |
| FR-2 | Each new row's "Purpose" cell MUST cite the source TDD anchor (e.g., `TDD-022 §13`, `TDD-023 §14`, `TDD-024 §8`, `TDD-024 §10`, `TDD-024 §11`) per TDD-027's anchor convention. | TDD-027 §5.1.1, §4.2 |
| FR-3 | Two of the new rows MUST contain explicit "do NOT" guards: the chains audit-log row ("Do NOT edit or delete; verify-only"), and the deploy ledger row ("Append-only; do NOT hand-edit"). | TDD-027 §5.1.1, §8.1 |
| FR-4 | The cred-proxy socket row MUST state the required permission mode (`0600`) and recommend `stat` for verification. | TDD-027 §5.1.1, §8.1 |
| FR-5 | Append exactly 4 new entries to the frontmatter `tools:` list, in this order: `Bash(chains *)`, `Bash(deploy *)`, `Bash(cred-proxy *)`, `Bash(firewall *)`. | PLAN-027-1 Task 6, TDD-027 §5.1.3 |
| FR-6 | The frontmatter MUST NOT contain a blanket `Bash(*)` entry. Principle of least privilege per TDD-027 OQ-1 (closed). | TDD-027 §8.1, OQ-1 |
| FR-7 | All existing 15 file-locations rows MUST remain unchanged in order, content, and column count. | TDD-027 §4.2 (G-08) |
| FR-8 | All existing 12 frontmatter `tools:` entries (`Read`, `Glob`, `Grep`, `Bash(cat *)`, `Bash(jq *)`, `Bash(ls *)`, `Bash(head *)`, `Bash(tail *)`, `Bash(wc *)`, `Bash(find *)`, `Bash(stat *)`, `Bash(git *)`) MUST remain in their existing relative order. | TDD-027 §4.2 (G-08) |
| FR-9 | Frontmatter `name` and `description` keys MUST be byte-identical to `main`. | TDD-027 §4.2, §10.1 |

## Non-Functional Requirements

| Requirement | Target | Measurement Method |
|------------|--------|--------------------|
| YAML frontmatter parse time | < 50 ms | Local YAML parser (`python -c "import yaml; yaml.safe_load(open(...))"`) on the modified file |
| Total prompt-token impact | < 250 net additional tokens | Diff line count: 9 table rows (~25 tokens each) + 4 allowlist entries (~6 tokens each) ≈ 250 tokens; verified against TDD-027 §8.3 budget (`+800` total across PLAN-027-1) |
| Markdown table renders cleanly | Zero column-mismatch errors | Render via standard CommonMark parser (e.g., `npx markdown-it`) and confirm 24 rows × 2 columns, no parser warnings |
| Append-only verification | 100% of changed lines are insertions in body | `git diff main -- plugins/autonomous-dev-assist/agents/troubleshooter.md` shows only `+` lines outside the frontmatter; frontmatter shows only insertions in `tools:` block |

## Technical Approach

### Locating the insertion point (file-locations table)
1. Read `plugins/autonomous-dev-assist/agents/troubleshooter.md`.
2. Locate the existing file-locations table. The terminal row is `| \`~/.config/systemd/user/autonomous-dev.service\` | systemd unit file (Linux) |` (or its current text — preserve byte-for-byte).
3. Insert the 9 new rows immediately after that row, before any blank line that terminates the table.

### File-locations rows (verbatim from TDD-027 §5.1.1)

| File / Directory | Purpose |
|------------------|---------|
| `~/.autonomous-dev/chains/audit.log` | HMAC-chained chain-execution audit log (TDD-022 §13). Do NOT edit or delete; verify-only. |
| `~/.autonomous-dev/chains/manifest.lock` | Resolved chain-DAG snapshot from the last successful chain run. |
| `~/.autonomous-dev/deploy/plans/` | Per-request `deploy plan` outputs awaiting approval. |
| `~/.autonomous-dev/deploy/ledger.json` | Cost-cap ledger (TDD-023 §14). Append-only; do NOT hand-edit. |
| `~/.autonomous-dev/deploy/logs/` | Per-request `deploy logs` JSONL output, one file per REQ-NNNNNN. |
| `~/.autonomous-dev/cred-proxy/socket` | SCM_RIGHTS Unix socket (TDD-024 §8). Permissions must be `0600`; check with `stat`. |
| `~/.autonomous-dev/cred-proxy/audit.log` | Per-issuance audit hash log (TDD-024 §10). |
| `~/.autonomous-dev/firewall/allowlist` | Resolved per-plugin egress allowlist (TDD-024 §11). |
| `~/.autonomous-dev/firewall/denied.log` | Per-deny event log; `tail` for live denials. |

### Locating the insertion point (frontmatter `tools:`)
1. The frontmatter is delimited by `---` at the very top of the file.
2. The existing `tools:` list is a YAML sequence; locate the last entry (`Bash(git *)` per TDD-027 §3.1).
3. Append the 4 new entries directly after `Bash(git *)`, preserving 2-space indentation and the `- ` list marker.

### Frontmatter `tools:` final state (post-edit)
```yaml
tools:
  - Read
  - Glob
  - Grep
  - Bash(cat *)
  - Bash(jq *)
  - Bash(ls *)
  - Bash(head *)
  - Bash(tail *)
  - Bash(wc *)
  - Bash(find *)
  - Bash(stat *)
  - Bash(git *)
  - Bash(chains *)        # NEW
  - Bash(deploy *)        # NEW
  - Bash(cred-proxy *)    # NEW
  - Bash(firewall *)      # NEW
```

The `# NEW` comments are illustrative; do NOT include them in the final file (the diff itself is the audit trail).

### Error handling at edit time
- If `tools:` is not present in frontmatter as a sequence, abort and surface the error; do NOT silently create one.
- If the file-locations table cannot be located by the anchor row, abort and surface the error; do NOT guess the location.
- If the existing terminal row of the file-locations table differs from TDD-027 §3.1's snapshot, prefer the on-disk text (the TDD anchor is informative, not normative).

## Acceptance Criteria

```
Given the troubleshooter.md file before edit (15 file-locations rows)
When this spec's edits are applied
Then the file-locations table contains exactly 24 rows
And the first 15 rows are byte-identical to main
And rows 16-24 match TDD-027 §5.1.1 in order and content
```

```
Given the troubleshooter.md file before edit (12 frontmatter tools entries)
When this spec's edits are applied
Then the frontmatter tools list contains exactly 16 entries
And the first 12 entries are byte-identical to main and in unchanged order
And entries 13-16 are exactly: Bash(chains *), Bash(deploy *), Bash(cred-proxy *), Bash(firewall *)
And no entry equals "Bash(*)" (verified by exact match)
```

```
Given the modified troubleshooter.md
When `python -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]).read().split('---')[1])" plugins/autonomous-dev-assist/agents/troubleshooter.md` is run
Then the parser exits 0
And the parsed object contains a 'tools' key with a list of length 16
```

```
Given the modified troubleshooter.md
When `git diff main -- plugins/autonomous-dev-assist/agents/troubleshooter.md` is run
Then the diff contains zero lines beginning with '-' (excluding the +++/--- diff headers)
And the diff contains only insertions
```

```
Given the modified troubleshooter.md
When the chains audit-log row is read
Then the cell contains the substring "Do NOT edit or delete"
And the cell contains the substring "TDD-022 §13"
```

```
Given the modified troubleshooter.md
When the cred-proxy socket row is read
Then the cell contains the substring "0600"
And the cell contains the substring "stat"
```

```
Given the modified troubleshooter.md
When `git log -p -- plugins/autonomous-dev-assist/agents/troubleshooter.md | head -1` is read
Then the frontmatter `name` value equals the value on `main`
And the frontmatter `description` value equals the value on `main`
```

### Edge cases / sad paths
```
Given the troubleshooter.md file with a missing or malformed frontmatter delimiter
When the implementer attempts to apply the edit
Then the implementer aborts with an explicit error
And does NOT attempt to fabricate a frontmatter block
```

```
Given the troubleshooter.md file where the systemd-service anchor row has been renamed in main since TDD-027 was authored
When the implementer attempts to apply the edit
Then the implementer locates the table's last row by structural position (last row before the table-terminating blank line)
And appends the 9 new rows after it
```

## Test Requirements

### Unit-equivalent (static)
- A shell-or-script check that confirms `grep -c "^| \`~/.autonomous-dev/" plugins/autonomous-dev-assist/agents/troubleshooter.md` returns ≥ 9 (the 9 new rows; existing rows do not match this prefix).
- A YAML-parse check on the frontmatter (parser exits 0).
- An exact-match check that `Bash(*)` does NOT appear in `tools:`.

### Integration / regression
- The existing troubleshoot-scenarios.yaml suite (84+ cases per PLAN-027-1) MUST continue to pass with no regression. The existing 15 file-locations rows are unchanged, so any existing eval that depends on them still resolves.
- The reviewer-agent diff check (TDD-020 / PLAN-021-3 standards-meta-reviewer) MUST flag this PR as conformant with TDD-027 §4.2 (append-only).

### Manual review
- A reviewer reads the rendered Markdown and confirms the 9 new rows are visually appended at the bottom of the file-locations table, with no formatting drift.

## Implementation Notes

- The TDD's text shows the new rows interleaved in document position; the actual edit is a clean append.
- Do NOT remove or rephrase the `# NEW` comments shown in TDD-027 §5.1.3 — those are illustrative annotations in the TDD only; the YAML file should contain plain entries with no inline comments (matches existing style).
- The standards-meta-reviewer (TDD-020 / PLAN-021-3) is the long-term enforcer of append-only semantics. A local pre-commit script is acceptable for this PR but not required if the reviewer agent is wired up.
- This spec deliberately stops short of authoring the diagnostic-procedure subsections that consume these rows. Those are SPEC-027-1-02 (Chain + Deploy) and SPEC-027-1-03 (Cred-Proxy + Firewall). Splitting the work this way keeps each spec ≤ ~250 lines and makes the structural-prerequisite spec independently mergeable.

## Rollout Considerations

- **Rollout**: Markdown-only PR; no daemon restart, no migration. The agent prompt is reloaded on every invocation.
- **Feature flag**: None. The new file-locations rows and allowlist entries are inert until SPEC-027-1-02 / SPEC-027-1-03's diagnostic subsections invoke them.
- **Rollback**: Revert the commit. Existing behavior (no new rows, no new tool entries) returns instantly.
- **Forward compatibility**: If the reviewer agent (PLAN-021-3) is not yet enforcing append-only when this spec lands, the local diff check (PLAN-027-1 Task 8) is the gate.

## Effort Estimate

| Activity | Hours |
|----------|-------|
| Edit file-locations table (9 rows, anchor + insert) | 1.0 |
| Edit frontmatter tools allowlist (4 entries) | 0.5 |
| Local diff check + YAML parse check | 0.5 |
| Manual reviewer eyeball + render check | 0.5 |
| **Total** | **2.5** |
