# SPEC-027-1-03: Troubleshooter — Credential-Proxy + Firewall Diagnostic Subsections

## Metadata
- **Parent Plan**: PLAN-027-1
- **Parent TDD**: TDD-027 §5.1.2 (Cred-Proxy + Firewall diagnostics), §8.1 (least-privilege, do-NOT guards), §4.2 (append-only)
- **Tasks Covered**: PLAN-027-1 Task 4 (Credential-Proxy Diagnostics), Task 5 (Firewall Diagnostics)
- **Estimated effort**: 2.0 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-027-1-03-troubleshooter-credproxy-and-firewall-diagnostics.md`
- **Depends on**: SPEC-027-1-01 (tool allowlist `Bash(cred-proxy *)` and `Bash(firewall *)` must be present); SPEC-027-1-02 (the two new H4s must already be in place; this spec inserts after them).

## Summary
Append two new H4 diagnostic-procedure subsections — **Credential-Proxy Diagnostics** and **Firewall Diagnostics** — to `agents/troubleshooter.md`, immediately after the Deploy Diagnostics subsection added by SPEC-027-1-02. Both subsections are authored verbatim from TDD-027 §5.1.2 and contain the mandatory operator-protective "do NOT rotate root credentials" guard exercised by eval `tshoot-credp-002` (SPEC-027-1-04). The Cred-Proxy subsection covers `cred-proxy doctor`, socket-permission check (`stat`, must be `0600`), TTL-expired re-bootstrap, and a runbook pointer. The Firewall subsection covers `firewall test`, `denied.log` tailing, allowlist inspection, DNS-refresh-lag handling (default 60 s; `firewall refresh-dns` workaround), and a runbook pointer. All edits are append-only per TDD-027 §4.2 / G-08.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-assist/agents/troubleshooter.md` | Modify | Append two new H4 subsections (`#### Credential-Proxy Diagnostics`, `#### Firewall Diagnostics`) after the Deploy Diagnostics subsection added by SPEC-027-1-02. No deletions, no reorderings. |

## Functional Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| FR-1 | Insert a new H4 `#### Credential-Proxy Diagnostics` immediately after the Deploy Diagnostics subsection. | TDD-027 §5.1.2 |
| FR-2 | The Credential-Proxy Diagnostics subsection MUST contain exactly 4 numbered steps in the order: (1) `cred-proxy doctor` health check (reports socket permissions, scoper plugins, last issuance, TTL); (2) socket permission-denied diagnosis using `stat`, requiring `0600`, with restart guidance; (3) TTL-expired mid-deploy guidance ("do NOT rotate root credentials"; `cred-proxy bootstrap --cloud <cloud>`); (4) pointer to `instructions/cred-proxy-runbook.md` (TDD-025 ownership). | TDD-027 §5.1.2 |
| FR-3 | The Cred-Proxy Diagnostics step 3 MUST contain the verbatim text "do NOT rotate root credentials" and the recovery command `cred-proxy bootstrap --cloud <cloud>`. Matched by eval `tshoot-credp-002`. | TDD-027 §5.1.2, §8.1 |
| FR-4 | The Cred-Proxy Diagnostics step 2 MUST contain the substring `0600` and the substring `stat`. Matched by eval `tshoot-credp-001`. | TDD-027 §5.1.2 |
| FR-5 | Insert a new H4 `#### Firewall Diagnostics` immediately after the Credential-Proxy Diagnostics subsection. | TDD-027 §5.1.2 |
| FR-6 | The Firewall Diagnostics subsection MUST contain exactly 5 numbered steps in the order: (1) `firewall test https://example.com:443`; (2) read denied events via `tail -50 ~/.autonomous-dev/firewall/denied.log | jq .`; (3) inspect resolved allowlist via `cat ~/.autonomous-dev/firewall/allowlist | jq .`; (4) DNS-refresh-lag handling — wait for next interval (default 60 s) or force with `firewall refresh-dns`; (5) pointer to `instructions/firewall-runbook.md` (TDD-025 ownership). | TDD-027 §5.1.2 |
| FR-7 | The Firewall Diagnostics step 4 MUST mention the default refresh interval value (`60s` or "60s" or "60 s" — preserve the TDD's wording verbatim) and the `firewall refresh-dns` command. | TDD-027 §5.1.2 |
| FR-8 | Both new subsections appear in the order: Credential-Proxy Diagnostics first, Firewall Diagnostics second (matching TDD-027 §5.1.2 document order). | TDD-027 §5.1.2 |
| FR-9 | All previously-existing H2/H3/H4 sections (including the Chain + Deploy subsections inserted by SPEC-027-1-02) MUST remain unchanged in order, content, and heading level. | TDD-027 §4.2 (G-08) |

## Non-Functional Requirements

| Requirement | Target | Measurement Method |
|------------|--------|--------------------|
| Combined prompt-token impact (this spec) | < 350 net additional tokens | Diff line count: ~15 lines for Cred-Proxy + ~15 lines for Firewall ≈ 300–350 tokens; verified against TDD-027 §8.3 (`+800` total budget across PLAN-027-1) |
| Markdown lint | Zero errors at default strictness | `markdownlint plugins/autonomous-dev-assist/agents/troubleshooter.md` exits 0 |
| Append-only | 100% of changed lines are insertions | `git diff main -- plugins/autonomous-dev-assist/agents/troubleshooter.md` shows only `+` lines in body |
| Subsection-ordering check | Configuration Issues → Chain → Deploy → Cred-Proxy → Firewall → next existing | Visual inspection + scripted heading-order extraction |

## Technical Approach

### Insertion strategy
1. Read the post-SPEC-027-1-02 state of `troubleshooter.md`.
2. Locate the `#### Deploy Diagnostics` H4 added by SPEC-027-1-02. Find its end (the next heading at H4 or shallower).
3. Insert the two new H4s and bodies at that boundary, preserving a single blank line between subsections.

### Credential-Proxy Diagnostics body (verbatim from TDD-027 §5.1.2)

```markdown
#### Credential-Proxy Diagnostics

1. Health check: `cred-proxy doctor`. Reports socket permissions, scoper plugins, last issuance, and TTL.
2. Permission denied on socket: check `stat ~/.autonomous-dev/cred-proxy/socket` for `0600`. If wrong, restart cred-proxy.
3. TTL expired mid-deploy: do NOT rotate root credentials. Re-bootstrap with `cred-proxy bootstrap --cloud <cloud>`.
4. Detail in `instructions/cred-proxy-runbook.md` (owned by TDD-025).
```

### Firewall Diagnostics body (verbatim from TDD-027 §5.1.2)

```markdown
#### Firewall Diagnostics

1. Test a host: `firewall test https://example.com:443`
2. Read denied events: `tail -50 ~/.autonomous-dev/firewall/denied.log | jq .`
3. Inspect resolved allowlist: `cat ~/.autonomous-dev/firewall/allowlist | jq .`
4. DNS-refresh lag (an allowed host appears denied): wait for the next refresh interval (default 60s) or force one with `firewall refresh-dns`.
5. Detail in `instructions/firewall-runbook.md` (owned by TDD-025).
```

### Error handling at edit time
- If `#### Deploy Diagnostics` H4 (anchor from SPEC-027-1-02) is not present, abort with an explicit error. Do NOT guess an insertion point or fall back to inserting before/after a different anchor.
- If a previous spec has already inserted `#### Credential-Proxy Diagnostics` or `#### Firewall Diagnostics`, abort and surface the conflict.
- Preserve exact backtick characters, angle-bracket placeholders (`<cloud>`), and `0600` (no quotes around the octal).

## Acceptance Criteria

```
Given the troubleshooter.md file post-SPEC-027-1-02
When this spec's edits are applied
Then exactly two new H4 headings exist with text "Credential-Proxy Diagnostics" and "Firewall Diagnostics"
And both appear after the "Deploy Diagnostics" H4
And both appear before the next existing H2/H3 heading
```

```
Given the modified troubleshooter.md
When the Credential-Proxy Diagnostics subsection body is read
Then the body contains exactly 4 numbered list items in order: doctor, socket perms (0600), TTL-expired (do NOT rotate), runbook pointer
And the body contains the verbatim substring "do NOT rotate root credentials"
And the body contains the substring "cred-proxy bootstrap --cloud <cloud>"
And the body contains the substring "0600"
And the body contains the substring "stat ~/.autonomous-dev/cred-proxy/socket"
And the body contains the substring "instructions/cred-proxy-runbook.md"
And the body contains the substring "TDD-025"
```

```
Given the modified troubleshooter.md
When the Firewall Diagnostics subsection body is read
Then the body contains exactly 5 numbered list items in order
And the body contains the substring "firewall test https://example.com:443"
And the body contains the substring "denied.log"
And the body contains the substring "default 60s"
And the body contains the substring "firewall refresh-dns"
And the body contains the substring "instructions/firewall-runbook.md"
```

```
Given the modified troubleshooter.md
When the document's H4 ordering under "Configuration Issues" downward is extracted
Then the order is: Configuration Issues, Chain Diagnostics, Deploy Diagnostics, Credential-Proxy Diagnostics, Firewall Diagnostics, then the next pre-existing structural element
```

```
Given the modified troubleshooter.md
When `git diff main -- plugins/autonomous-dev-assist/agents/troubleshooter.md` is run
Then the diff contains zero deletion lines outside diff headers
```

### Edge cases / sad paths
```
Given a future TDD that renames cred-proxy to credentials-broker
When this spec's content references "cred-proxy" and the runbook is renamed
Then the spec is intentionally pinned to the names used at TDD-027 authoring time (FR-1540 forbids commit-SHA pinning, but does not forbid name pinning); rename coordination happens via a follow-up TDD anchor
```

```
Given an operator on Windows where the firewall command does not exist
When the agent suggests `firewall test https://example.com:443`
Then the Bash tool returns "command not found"
And the operator sees a clear error
And the runbook pointer (step 5) gives them a fallback per TDD-027 §10.2
```

```
Given the TTL-expired sad path
When the eval `tshoot-credp-002` is run
Then the agent's response MUST contain "cred-proxy bootstrap" and MUST NOT contain "aws iam update-access-key"
```

## Test Requirements

### Static
- `grep -c "^#### Credential-Proxy Diagnostics$" troubleshooter.md` returns 1
- `grep -c "^#### Firewall Diagnostics$" troubleshooter.md` returns 1
- `grep -c "do NOT rotate root credentials" troubleshooter.md` returns 1
- `grep -c "0600" troubleshooter.md` returns ≥ 2 (one in cred-proxy diagnostic, one in the file-locations row added by SPEC-027-1-01)
- `grep -c "firewall refresh-dns" troubleshooter.md` returns ≥ 1
- `grep -c "default 60s" troubleshooter.md` returns ≥ 1

### Integration / regression
- Existing troubleshoot-scenarios suite continues to pass.
- New eval cases `tshoot-credp-001`, `tshoot-credp-002`, `tshoot-firewall-001` (SPEC-027-1-04) pass when run against the agent post-this-spec.

### Manual review
- Reviewer reads each new H4 aloud and confirms the mandatory guards are intact and worded as TDD-027 specifies.

## Implementation Notes

- The two subsections are short (~5 lines body each); they are independent edits but ordering matters per FR-8.
- Pointer to `instructions/cred-proxy-runbook.md` and `instructions/firewall-runbook.md` is forward-compatible: those runbooks are owned by TDD-025 and may not exist when this spec lands. The pointer itself is intentional documentation per TDD-027 §15.
- Do NOT add a "Common Mistakes" callout (per TDD-027 OQ-7, deferred).
- Do NOT introduce blanket `Bash(*)` (already enforced by SPEC-027-1-01 / TDD-027 OQ-1).

## Rollout Considerations

- **Rollout**: Markdown-only PR; agent prompt is reloaded on every invocation.
- **Feature flag**: None.
- **Rollback**: Revert the commit. Operators lose cred-proxy + firewall diagnostic guidance but no data is affected.
- **Forward-compat**: Runbook pointers may temporarily 404 until TDD-025 plans land; the pointer text is durable.

## Effort Estimate

| Activity | Hours |
|----------|-------|
| Insert Credential-Proxy Diagnostics subsection (~10 lines, verbatim copy + anchor) | 0.75 |
| Insert Firewall Diagnostics subsection (~12 lines, verbatim copy + anchor) | 0.75 |
| Static checks + regression smoke | 0.5 |
| **Total** | **2.0** |
