# SPEC-025-1-03: assist.md Classification, Glob, and Bash Extensions

## Metadata
- **Parent Plan**: PLAN-025-1
- **Parent TDD**: TDD-025-assist-cloud-credproxy-surface
- **Tasks Covered**: PLAN-025-1 Task 4 (Step 1 `security` classification), Task 5 (Step 2 Glob entries), Task 6 (Step 2 Bash probes with platform-aware `stat`)
- **Estimated effort**: 5 hours (2h + 1.5h + 1.5h)
- **Status**: Draft
- **Future location**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-025-1-03-assist-classification-glob-bash.md`

## Description
Extend `plugins/autonomous-dev-assist/commands/assist.md` so the assist agent can route security-class questions (cred-proxy, sockets, TTL, scopers) to the new content surfaces shipped by SPEC-025-1-01 and SPEC-025-1-02. Three changes:

1. **Step 1 (classification)** adds `security` as a recognized top-level category with keyword-based subclassing (`cred-proxy`, `socket`, `TTL`, `scoper` route to `security/cred-proxy`).
2. **Step 2 (Glob discovery)** adds three new glob patterns so the agent reads the cred-proxy intake directory, the four cloud-backend plugin directories (also serving as installed-cloud detection), and the new cred-proxy runbook.
3. **Step 2 (Bash probes)** adds two new non-fatal probes: `ls -l ~/.autonomous-dev/cred-proxy/socket 2>/dev/null` and `cred-proxy status 2>/dev/null`, with a platform-aware `stat` invocation (macOS `stat -f` vs. Linux `stat -c`) selected by `uname` detection.

All three additions are **additive**. Existing classification rules, globs, and bash probes remain unchanged. The `2>/dev/null` redirect on the new probes is a hard contract (TDD-025 §6.6) — it ensures a missing daemon does not break the assist flow.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-assist/commands/assist.md` | Modify (three discrete additive edits in Step 1 and Step 2) | Additive; no removals or rewrites |

## Implementation Details

### Edit 1: Step 1 — add `security` classification (PLAN-025-1 Task 4)

In the Step 1 section of `commands/assist.md`, locate the list of recognized top-level categories. Add `security` to the list, alongside the existing categories. Add a keyword-subclassing rule per TDD-025 §6.6.

Suggested inserted text (the implementer should adapt to match the file's existing list style, which is likely a bulleted list with one category per bullet):

```markdown
- **security** — Questions about the credential proxy, the per-cloud scopers, the Unix-domain socket transport, TTL semantics, audit-log verification, or any topic touching credentials at deploy time.

  Subclass by keyword. If the question contains any of `cred-proxy`, `socket`, `TTL`, or `scoper`, route to `security/cred-proxy`. Worked example: "I'm getting permission denied on the cred-proxy socket" → `security/cred-proxy`. The `security/cred-proxy` subclass triggers the cred-proxy-specific Glob and Bash probes in Step 2.
```

**Required content (acceptance):**

- `security` appears as a top-level category at the same heading level / list level as the other top-level categories.
- The four subclass keywords (`cred-proxy`, `socket`, `TTL`, `scoper`) are listed verbatim.
- The `security/cred-proxy` subclass identifier appears at least twice (in the keyword rule and in the worked example, or equivalent positions).
- A worked example showing a security-class routing decision is present.
- Existing categories on `main` are byte-for-byte unchanged.

### Edit 2: Step 2 — Glob discovery additions (PLAN-025-1 Task 5)

In the Step 2 section, locate the Glob discovery list. Append three new entries grouped logically with the existing intake/cred-proxy globs (or with the existing intake-globs cluster, whichever is the existing pattern):

```markdown
- `plugins/autonomous-dev/intake/cred-proxy/*` — cred-proxy intake notes and operator-submitted documentation drafts.
- `plugins/autonomous-dev-deploy-{gcp,aws,azure,k8s}/` — installed cloud-backend plugin directories. The brace-expansion glob is non-fatal: it matches zero or more directories. Presence of a directory indicates the operator has installed that cloud; absence is interpreted as "this cloud not installed" rather than "no clouds installed." Use this glob as the installed-clouds discovery probe.
- `plugins/autonomous-dev-assist/instructions/cred-proxy-runbook.md` — the cred-proxy deep walkthrough; primary deep-context source for any `security/cred-proxy` question.
```

**Required content (acceptance):**

- All three glob entries appear in the Step 2 Glob list verbatim (path patterns; the surrounding description text is implementer-discretionary).
- The brace-expansion `{gcp,aws,azure,k8s}` syntax is used exactly (not `[gcp|aws|...]`, not four separate entries).
- The `intake/cred-proxy/*` entry appears grouped with other `intake/*` globs if such a cluster exists in the existing list; otherwise grouped with the cred-proxy entries.
- The interpretation note ("absence means this cloud not installed") is present in the description for the deploy-plugin glob, so future authors do not strip the interpretation.
- Existing globs on `main` are byte-for-byte unchanged.

### Edit 3: Step 2 — Bash probes with platform-aware `stat` (PLAN-025-1 Task 6)

In the Step 2 section, locate the Bash probe list. Append two new probes and document the platform-aware `stat` idiom:

```markdown
- `ls -l ~/.autonomous-dev/cred-proxy/socket 2>/dev/null` — list the cred-proxy Unix-domain socket and its permissions. The `2>/dev/null` redirect is required: missing daemon must not break assist.
- `cred-proxy status 2>/dev/null` — query the cred-proxy daemon for health and active token count. Non-fatal if the daemon is not running or the binary is not on PATH.

For socket-permission diagnosis, use a platform-aware `stat` invocation. The `uname` detection idiom:

    [[ "$(uname)" == "Darwin" ]] && stat -f "%Sp %u %g" "$socket" || stat -c "%a %u %g" "$socket"

This single-line idiom selects the macOS `stat -f` form on Darwin and the Linux `stat -c` form everywhere else. On a third platform (e.g., FreeBSD), the Linux form may fail; the failure is non-fatal because subsequent assist diagnostics do not depend on the `stat` output.
```

**Required content (acceptance):**

- Both Bash probes appear in the Step 2 Bash list verbatim, including the `2>/dev/null` redirect.
- The platform-aware `stat` idiom is documented as a single-line shell snippet using `uname` detection.
- The non-fatal contract is explicitly called out at least once (e.g., "missing daemon must not break assist" or equivalent), so future authors do not strip the redirect.
- The `cred-proxy` binary is assumed to already be on the read-only-shell allowlist that the existing assist.md frontmatter declares; if the frontmatter has an explicit `Bash(...)` allowlist, the implementer must verify `cred-proxy status`, `ls`, and `stat` are permitted (they should be — `ls` and `stat` are standard read-only commands; `cred-proxy status` is a read-only subcommand). If the existing allowlist does NOT permit them, this spec REQUIRES adding them to the allowlist; document the addition in the PR description.
- Existing Bash probes on `main` are byte-for-byte unchanged.

### Frontmatter check (cross-cutting)

The implementer MUST read the file's YAML frontmatter before committing. If the frontmatter includes an explicit `tools` or `Bash` allowlist, verify that the additions in Edit 3 are covered:

- `Bash(ls:*)` or unrestricted `Bash` — needed for `ls -l ...`
- `Bash(stat:*)` or unrestricted `Bash` — needed for the `stat` idiom
- `Bash(cred-proxy:*)` — needed for `cred-proxy status`
- `Bash(uname:*)` — needed for the platform detection idiom

If any of these are missing from a restrictive allowlist, add them in the same PR. If the allowlist is unrestricted (e.g., `Bash`), no change is needed. The implementer documents the allowlist state and any additions in the PR description.

### Lint and formatting

- `markdownlint` (existing config) must pass.
- The Bash code blocks use indented or fenced format matching the existing convention in `commands/assist.md` (read first, match second).
- The keyword-subclassing list and glob entries match the existing list bullet style.

## Acceptance Criteria

- [ ] `plugins/autonomous-dev-assist/commands/assist.md` Step 1 section has `security` listed as a recognized top-level classification category.
- [ ] The Step 1 section documents the four subclass keywords (`cred-proxy`, `socket`, `TTL`, `scoper`) verbatim.
- [ ] The Step 1 section documents the `security/cred-proxy` subclass identifier and includes at least one worked example showing a security-class routing decision.
- [ ] `plugins/autonomous-dev-assist/commands/assist.md` Step 2 Glob list contains the three new entries verbatim:
  - `plugins/autonomous-dev/intake/cred-proxy/*`
  - `plugins/autonomous-dev-deploy-{gcp,aws,azure,k8s}/`
  - `plugins/autonomous-dev-assist/instructions/cred-proxy-runbook.md`
- [ ] The brace-expansion glob uses the exact form `{gcp,aws,azure,k8s}` (no spaces inside braces, no alternative syntaxes).
- [ ] The deploy-plugin glob entry's description text contains the interpretation note that absence of a directory means "this cloud not installed" rather than "no clouds installed" (or close paraphrase covering the same intent).
- [ ] `plugins/autonomous-dev-assist/commands/assist.md` Step 2 Bash list contains the two new probes verbatim, including the `2>/dev/null` redirect:
  - `ls -l ~/.autonomous-dev/cred-proxy/socket 2>/dev/null`
  - `cred-proxy status 2>/dev/null`
- [ ] The Step 2 Bash section documents the platform-aware `stat` idiom as a single-line shell snippet that uses `uname` to switch between `stat -f "%Sp %u %g"` (Darwin) and `stat -c "%a %u %g"` (Linux).
- [ ] The non-fatal contract for the new Bash probes is called out explicitly at least once, so the `2>/dev/null` redirect is not silently stripped by future edits.
- [ ] All existing Step 1 categories, Step 2 globs, and Step 2 Bash probes on `main` are byte-for-byte unchanged. (Verify with `git diff main -- plugins/autonomous-dev-assist/commands/assist.md`: only added lines.)
- [ ] The frontmatter YAML on the file is examined; if it has a restrictive `tools` / `Bash(...)` allowlist, the four required entries (`ls`, `stat`, `cred-proxy`, `uname`) are covered (either pre-existing or added in this PR). The PR description documents which.
- [ ] `markdownlint` exits 0 on the modified file.

## Dependencies

- **TDD-025 §6.6** — authoritative source for the classification + Glob + Bash contract.
- **SPEC-025-1-01** (sibling, soft): the help/SKILL.md Credential Proxy section is one of the surfaces the new globs reach. Soft dependency; this spec's globs work even before SPEC-025-1-01 lands (the glob match is non-fatal).
- **SPEC-025-2-01** (forward reference): the `cred-proxy-runbook.md` is referenced by the new glob. Forward link is intentional; PLAN-025-1 Task 8 (SPEC-025-1-04) audits resolution.
- **No code dependencies** — documentation/configuration only.
- **PLAN-025-3 eval cases** (downstream): the eval suite that exercises this spec's behaviour ships in PLAN-025-3. Without the glob additions, eval cases would silently miss the new SKILL sections and degrade in scoring.

## Notes

- The `security` classification is intentionally at top-level (not a subclass of an existing category like `troubleshoot`). Rationale per TDD-025 §6.6: cred-proxy questions are conceptually orthogonal to deploy/troubleshoot — an operator on a non-deploy chain can still ask cred-proxy questions, and a deploy-flow troubleshoot can be unrelated to credentials. The top-level placement keeps the routing tree shallow.
- The brace-expansion glob `{gcp,aws,azure,k8s}` doubles as the installed-clouds detection probe. Without this dual use, the assist agent would need a separate Bash probe to detect installed clouds; the glob is cheaper.
- The `uname` detection idiom uses POSIX shell short-circuit (`&&` / `||`) rather than `if/then/else`. The reason: the assist agent's bash invocations are typically one-liners and the short-circuit form fits a single bullet. The trade-off is that on a `stat -f` failure on Darwin (very unlikely), the `||` arm would run `stat -c` which would also fail; both failures are non-fatal because of the `2>/dev/null` redirect on the surrounding Bash probe (the implementer should add `2>/dev/null` to both arms of the `stat` idiom: `... && stat -f "%Sp %u %g" "$socket" 2>/dev/null || stat -c "%a %u %g" "$socket" 2>/dev/null`).
- The implementer should read the existing `commands/assist.md` carefully to identify (a) the exact heading anchors for "Step 1" and "Step 2"; (b) the existing list-bullet style; (c) the existing fenced vs. indented code-block convention; (d) the frontmatter `tools` allowlist shape. Match the existing conventions; do not reformat existing content.
- The `cred-proxy status` probe assumes the binary is on PATH. On a fresh install where the operator has not yet installed cred-proxy, the probe falls through silently because of `2>/dev/null`. The assist agent's response logic should treat the missing-binary case as "operator has not installed cred-proxy" and route to the install-runbook section of `cred-proxy-runbook.md`. The Step 2 documentation calls this out so the response logic is informed.
- The order of additions in Step 2 should group logically: globs near other intake-related globs; bash probes near other socket/permission probes if such a cluster exists. If no clear cluster exists, append at the end.
