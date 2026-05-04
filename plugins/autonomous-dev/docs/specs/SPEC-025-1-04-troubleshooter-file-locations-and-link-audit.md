# SPEC-025-1-04: troubleshooter.md File-Locations Rows + Cross-Reference Link Audit

## Metadata
- **Parent Plan**: PLAN-025-1
- **Parent TDD**: TDD-025-assist-cloud-credproxy-surface
- **Tasks Covered**: PLAN-025-1 Task 7 (file-locations table additions), Task 8 (cross-reference and link audit)
- **Estimated effort**: 3 hours (2h + 1h)
- **Status**: Draft
- **Future location**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-025-1-04-troubleshooter-file-locations-and-link-audit.md`

## Description
Two distinct activities consolidated into a single spec because they both fall in the `troubleshooter`/audit lane and together close PLAN-025-1:

1. **File-locations table additions** (Task 7) — add three rows to the file-locations table in `plugins/autonomous-dev-assist/agents/troubleshooter.md` for the canonical cred-proxy paths (`socket`, `audit.log`, `scopers/<cloud>`) and add `cred-proxy doctor` + `cred-proxy doctor --verify-audit` to the chain-and-deploy diagnostics subsection.
2. **Cross-reference audit** (Task 8) — walk every "see also" pointer added by SPEC-025-1-01, SPEC-025-1-02, SPEC-025-1-03, and this spec, and verify each link target either resolves on `main` or is a documented forward reference to a sibling-plan deliverable (PLAN-025-2 / PLAN-025-3). Produce a small follow-up commit fixing typos if any are found.

This spec ships only documentation. The link audit is a verification step that may produce a small fix-up commit; if no issues are found, no follow-up commit is needed.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-assist/agents/troubleshooter.md` | Modify (append rows to file-locations table; append rows to chain-and-deploy diagnostics subsection) | Additive only |
| `plugins/autonomous-dev-assist/skills/help/SKILL.md` | Verify only (Task 8) | No changes unless link typos found |
| `plugins/autonomous-dev-assist/skills/config-guide/SKILL.md` | Verify only (Task 8) | No changes unless link typos found |
| `plugins/autonomous-dev-assist/commands/assist.md` | Verify only (Task 8) | No changes unless link typos found |

## Implementation Details

### Edit 1: Three new file-locations rows (PLAN-025-1 Task 7)

Locate the file-locations table in `agents/troubleshooter.md`. The existing table has the canonical `Path | Purpose` two-column shape (per TDD-025 §6.5 reference). Append three rows in the order shown:

```markdown
| `~/.autonomous-dev/cred-proxy/socket`         | Unix-domain socket the cred-proxy daemon listens on. Mode `0600`, owner-only. Do not chown to root; the proxy enforces ownership at startup. |
| `~/.autonomous-dev/cred-proxy/audit.log`      | HMAC-chained audit log of every credential issuance. Verify with `cred-proxy doctor --verify-audit`. **Do not delete this file.** |
| `~/.autonomous-dev/cred-proxy/scopers/<cloud>`| Per-cloud scoper plugin install path (`<cloud>` = `aws`, `gcp`, `azure`, or `k8s`). The scoper translates root credentials into a scoped short-lived token. |
```

**Required content (acceptance):**

- All three rows appear in the file-locations table, in the order shown.
- The socket row contains the literal `0600` and a directive against chown-to-root.
- The audit-log row contains the literal `cred-proxy doctor --verify-audit` and the bold `**Do not delete this file.**` (or `**Do not delete the audit log.**`) directive.
- The scopers row enumerates all four clouds (`aws`, `gcp`, `azure`, `k8s`) verbatim.
- Existing rows in the file-locations table are byte-for-byte unchanged.

### Edit 2: Two new diagnostics rows (PLAN-025-1 Task 7, FR-1519 portion)

Locate the chain-and-deploy diagnostics subsection of `agents/troubleshooter.md` (the section that documents diagnostic-command rows for the troubleshooter agent). Append two rows / list entries — the exact format depends on the existing subsection style (table vs. bulleted list). Use the existing format.

If the existing format is a table (`Command | Purpose`):

```markdown
| `cred-proxy doctor`                    | Full cred-proxy diagnostic: socket perms, scoper plugin presence, root-cred reachability per cloud. Use as the first response to any cred-proxy `permission denied` or `scoper not found` symptom. |
| `cred-proxy doctor --verify-audit`     | Verify the HMAC-chain integrity of `~/.autonomous-dev/cred-proxy/audit.log`. A mismatch is **always** an escalation, never a unilateral recovery. |
```

If the existing format is a bulleted list:

```markdown
- `cred-proxy doctor` — Full cred-proxy diagnostic: socket perms, scoper plugin presence, root-cred reachability per cloud. Use as the first response to any cred-proxy `permission denied` or `scoper not found` symptom.
- `cred-proxy doctor --verify-audit` — Verify the HMAC-chain integrity of `~/.autonomous-dev/cred-proxy/audit.log`. A mismatch is **always** an escalation, never a unilateral recovery.
```

**Required content (acceptance):**

- Both rows / entries appear in the chain-and-deploy diagnostics subsection.
- `cred-proxy doctor` appears as a separate entry from `cred-proxy doctor --verify-audit` (per OQ-4, closed: yes — they have different failure modes).
- The `--verify-audit` row contains the literal `escalation` or `escalate` and the directive against unilateral recovery.
- Existing diagnostic rows are byte-for-byte unchanged.

### Edit 3: Cross-reference audit (PLAN-025-1 Task 8)

After Edits 1 and 2 land (and after SPEC-025-1-01, SPEC-025-1-02, SPEC-025-1-03 have landed in the same PR or merged sibling PRs), run the link audit. The audit walks every `[text](path)` link added by PLAN-025-1's specs and verifies each target.

**Audit scope.** Every link added by PLAN-025-1 specs:

- SPEC-025-1-01: links from the help/SKILL.md Cloud Backends and Credential Proxy "See also" subsections.
- SPEC-025-1-02: links from the config-guide/SKILL.md cred_proxy "See also" subsection.
- SPEC-025-1-03: glob patterns reference paths but are not Markdown links; out of audit scope.
- SPEC-025-1-04 (this spec): links from the new troubleshooter rows reference inline paths (not Markdown links per se), but verify the path strings are well-formed.

**Audit procedure.**

1. Use `grep -rn '\[.*\](.*)' plugins/autonomous-dev-assist/skills/help/SKILL.md plugins/autonomous-dev-assist/skills/config-guide/SKILL.md` (and similar for any other PLAN-025-1 modified files) to extract every Markdown link.
2. Filter to links added by PLAN-025-1 specs (use `git diff main -- <file>` to identify added lines).
3. For each link target:
   - **If the target is a relative path on disk:** verify the file exists. Use `ls -la <target-resolved-from-file-location>`.
   - **If the target is a forward reference to a sibling-plan deliverable:** verify the canonical filename matches what PLAN-025-2 or PLAN-025-3 promises. The two known forward references are:
     - `plugins/autonomous-dev-assist/instructions/cred-proxy-runbook.md` (created by SPEC-025-2-01).
     - PLAN-025-3 eval cases — none of PLAN-025-1's links target eval cases directly, but if any are introduced, they reference the canonical filename `plugins/autonomous-dev-assist/evals/test-cases/cred-proxy-eval.yaml`.
4. **Non-Markdown-link path references** (inline `~/.autonomous-dev/...` paths, `plugins/...` paths in code blocks): verify the path strings are syntactically well-formed and not typo'd (e.g., `cred-proxy/socket` not `credproxy/socket`).

**Audit output.** Either:

- All links resolve / are documented forward references → audit passes; no follow-up commit needed. Document the audit result in the PR description.
- A typo or broken link is found → produce a small follow-up commit with the fix, message format `fix(docs): correct broken link <file>:<line>`. Do not bundle this commit with unrelated changes.

**Non-resolution policy.** Forward references to PLAN-025-2 deliverables (e.g., `cred-proxy-runbook.md`) are not failures. The Markdown linter is configured to allow forward references in this repo (existing pattern). The audit's job is to verify the canonical filename matches the sibling plan's deliverable — typos in the forward filename ARE failures because the link will never resolve.

### Lint and formatting

- `markdownlint` (existing config) must pass on the modified `troubleshooter.md`.
- The new file-locations rows match the existing table column widths (the implementer may need to adjust whitespace padding in the row separators).
- The new diagnostics entries use the exact list/table format of the existing subsection.

## Acceptance Criteria

- [ ] `plugins/autonomous-dev-assist/agents/troubleshooter.md` file-locations table contains three new rows in the order: `~/.autonomous-dev/cred-proxy/socket`, `~/.autonomous-dev/cred-proxy/audit.log`, `~/.autonomous-dev/cred-proxy/scopers/<cloud>`.
- [ ] The socket row contains the literal `0600` and a directive against chown-to-root.
- [ ] The audit.log row contains the literal `cred-proxy doctor --verify-audit` and a bold directive against deletion (`**Do not delete this file.**` or `**Do not delete the audit log.**`).
- [ ] The scopers row enumerates all four clouds: `aws`, `gcp`, `azure`, `k8s`.
- [ ] The chain-and-deploy diagnostics subsection contains two new entries:
  - `cred-proxy doctor` (full diagnostic; first-response tool)
  - `cred-proxy doctor --verify-audit` (HMAC-chain verification)
- [ ] The `--verify-audit` entry contains the literal `escalation` or `escalate` and a directive against unilateral recovery.
- [ ] All existing rows in the file-locations table and the chain-and-deploy diagnostics subsection on `main` are byte-for-byte unchanged. (Verify with `git diff main -- plugins/autonomous-dev-assist/agents/troubleshooter.md`: only added lines.)
- [ ] `markdownlint` exits 0 on the modified `troubleshooter.md`.
- [ ] Cross-reference audit (Task 8) executed against all PLAN-025-1 modified files. Audit result documented in the PR description.
- [ ] Every Markdown link added by PLAN-025-1 specs either resolves to an extant file or is a documented forward reference to a canonical sibling-plan deliverable filename. The two known forward references are: `instructions/cred-proxy-runbook.md` (SPEC-025-2-01) and any PLAN-025-3 eval-case filename (none expected at PLAN-025-1 link granularity).
- [ ] No PLAN-025-1 spec contains a typo'd path reference (e.g., `credproxy` instead of `cred-proxy`, missing `~/`, wrong directory casing).
- [ ] If the audit identifies any broken-link or typo issues, a small follow-up commit with message `fix(docs): correct broken link <file>:<line>` is produced. The follow-up commit is not bundled with unrelated changes.

## Dependencies

- **TDD-025 §6.5** — authoritative source for the three new file-locations rows.
- **TDD-025 §6.6** — referenced by Edit 3 audit (validates SPEC-025-1-03's glob entries do not embed broken paths).
- **SPEC-025-1-01, SPEC-025-1-02, SPEC-025-1-03** (siblings, soft): Task 8 audit walks the links added by these specs. Audit can run before they merge if all four are in the same PR; if they merge separately, the audit runs last.
- **SPEC-025-2-01** (forward reference): the cred-proxy-runbook.md filename is the canonical target for forward links. The audit verifies the canonical filename matches what SPEC-025-2-01 promises.
- **No code dependencies** — documentation only.

## Notes

- This spec consolidates two activities (table-row additions + link audit) because they together close PLAN-025-1 and benefit from running in the same PR. If the audit finds zero issues, the spec's deliverable is just Edits 1 and 2; if it finds issues, the deliverable also includes the small fix-up commit.
- The chain-and-deploy diagnostics subsection is co-owned with TDD-022 (chains) and TDD-026 (deploy) per TDD-025 §6.5. This spec's contribution is strictly the two cred-proxy rows; do not modify the existing chain or deploy rows even if they appear improvable. Out-of-scope changes belong in their own PR against their owning TDD.
- The implementer must read the current `agents/troubleshooter.md` to confirm: (a) whether the file-locations and diagnostics sections use tables or bulleted lists; (b) the exact column widths if tables; (c) the heading slug for the chain-and-deploy diagnostics subsection. Match the existing format precisely.
- The audit is a manual verification step at PR review time, not an automated check. The implementer can use the audit procedure documented above as a checklist and paste the result (audit passed; or audit identified N issues, fix in commit XYZ) into the PR description.
- If the audit identifies a broken link in another PLAN-025-1 spec's deliverable (e.g., a typo in SPEC-025-1-01's "See also" link), the fix belongs in this PR because all four PLAN-025-1 specs ship together. The fix-up commit references the original spec's commit message in its body for traceability.
- The chain-warning style (the bold `**Do not delete the audit log.**` directive) is reused verbatim from the chains-audit warning in `help/SKILL.md`. The implementer may use either `Do not delete this file.` or `Do not delete the audit log.` — both are acceptable; the former is more specific to the row context.
- The `<cloud>` placeholder syntax in the scopers-row path uses angle brackets to indicate substitution; this matches the existing convention used in other file-locations rows (the implementer should verify by reading the file).
