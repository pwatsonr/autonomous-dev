# SPEC-016-4-01: Gitleaks Configuration with Allowlist and Five Custom Rules

## Metadata
- **Parent Plan**: PLAN-016-4
- **Tasks Covered**: TASK-001 (gitleaks allowlist config), TASK-007 (security smoke-test fixture allowlisting), TASK-009 (allowlist contributor guide)
- **Estimated effort**: 3 hours

## Description
Author the canonical `gitleaks` v8 configuration that powers the `security-baseline` PR check. The TOML file declares (a) five custom `[[rules]]` blocks for credential patterns we explicitly care about (Anthropic API keys, Slack tokens, Discord bot tokens, GitHub PAT/fine-grained tokens, AWS access keys), (b) a path-and-regex `[allowlist]` that quiets documentation placeholders and the planted-secret smoke-test fixture, and (c) an empty `[allowlist.commits]` block reserved for SHA-based exemptions managed via `SECURITY.md` review. The file is consumed by SPEC-016-4-02's gitleaks job; this spec owns the allowlist contract and the contributor guide that governs changes to it.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `.github/security/gitleaks.toml` | Create | Top-level config, `extend.useDefault = true`, five custom rules, `[allowlist]`, empty `[allowlist.commits]` |
| `tests/fixtures/security/leaked-aws-key.txt` | Create | Planted dummy AWS key (`AKIAEXAMPLEKEY12345`) used by the smoke test in SPEC-016-4-04 |
| `tests/fixtures/security/README.md` | Create | Explains the fixture is synthetic; warns against copy/paste into real code |
| `SECURITY.md` | Create or modify | Add "Managing the Gitleaks Allowlist" section with three subsections: commit exemptions, path exemptions, review process |

## Implementation Details

### `.github/security/gitleaks.toml` Structure

The file MUST start with `title` and `[extend]` to inherit gitleaks' built-in default ruleset, then layer the five custom rules on top.

```toml
title = "autonomous-dev gitleaks config (PRD-007 FR-14)"

[extend]
useDefault = true

# --- Custom rules (ordered by detection priority) ---

[[rules]]
id = "anthropic-api-key"
description = "Anthropic API key (sk-ant-... prefix)"
regex = '''sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_\-]{80,}'''
tags = ["key", "anthropic"]

[[rules]]
id = "slack-bot-token"
description = "Slack bot/user/app token"
regex = '''xox[baprs]-[A-Za-z0-9-]{10,}'''
tags = ["key", "slack"]

[[rules]]
id = "discord-bot-token"
description = "Discord bot token (3-segment base64)"
regex = '''[MN][A-Za-z0-9]{23}\.[\w-]{6}\.[\w-]{27,}'''
tags = ["key", "discord"]

[[rules]]
id = "github-pat"
description = "GitHub PAT (ghp_) or fine-grained (github_pat_) token"
regex = '''(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82})'''
tags = ["key", "github"]

[[rules]]
id = "aws-access-key"
description = "AWS access key ID (AKIA prefix)"
regex = '''\bAKIA[0-9A-Z]{16}\b'''
tags = ["key", "aws"]

# --- Allowlist (paths + regex placeholders) ---

[allowlist]
description = "Documentation, fixtures, and known-safe placeholders"
paths = [
  '''(?i)\.md$''',
  '''plugins/autonomous-dev/tests/fixtures/.*''',
  '''tests/fixtures/security/.*''',
  '''docs/.*''',
  '''.*\.example$''',
  '''.*\.sample$''',
]
regexes = [
  '''(?i)example[_\-]?(api[_\-]?key|token|secret)''',
  '''(?i)your[_\-]?(api[_\-]?key|token|secret)[_\-]?here''',
  '''(?i)<replace[_\-]?(me|with[_\-]?your[_\-]?key)>''',
  '''(?i)dummy[_\-]?(api[_\-]?key|token|secret)''',
  '''AKIAEXAMPLE[A-Z0-9]+''',
]

# Reserved for SHA-pinned exemptions; require SECURITY.md review.
[allowlist.commits]
commits = []
```

Rule design notes:
- Anthropic regex matches both `api01` and `admin01` styles; tail is `[A-Za-z0-9_-]{80,}` to tolerate length growth.
- Discord regex pins the 3-segment shape (`<mfa>.<timestamp>.<hmac>`) starting with `M` or `N`.
- AWS regex uses `\b` word boundaries so `XYZAKIA...` does not false-match.
- The `aws-access-key` rule regex MUST detect the `AKIAEXAMPLEKEY12345` literal in the smoke fixture; the `AKIAEXAMPLE[A-Z0-9]+` regex allowlist silences it during normal CI but still allows the rule to fire when `--no-allowlist` is passed.

### Smoke Fixture (`tests/fixtures/security/leaked-aws-key.txt`)

```
# This file intentionally contains a SYNTHETIC AWS access key for security
# scanner regression testing. It is NOT a real credential.
# See: tests/fixtures/security/README.md
AWS_ACCESS_KEY_ID=AKIAEXAMPLEKEY12345
```

### Smoke Fixture README (`tests/fixtures/security/README.md`)

One-pager covering:
- Purpose: regression-test the `aws-access-key` gitleaks rule.
- Why allowlisted: prevents the fixture itself from blocking PRs.
- How the test still works: SPEC-016-4-04's smoke test runs `gitleaks detect --no-allowlist` against the fixture path and asserts a finding.
- Warning: do NOT copy the value into application code, environment files, or shell history.

### `SECURITY.md` "Managing the Gitleaks Allowlist" Section

Three subsections (each ≤200 words):

1. **Adding a Path Exemption** — describe the `[allowlist].paths` regex format, give a worked example, require a security-review code owner approval.
2. **Adding a Commit-SHA Exemption** — describe `[allowlist.commits]`, when to use it (legacy commits with rotated secrets), and the requirement to log the exemption in a `## Allowlist Exemption Log` table at the bottom of `SECURITY.md` with columns: SHA, rule, rotated-on date, approver.
3. **Review Process** — every PR touching `.github/security/gitleaks.toml` requires a `security-review` GitHub team approval before merge; the bats test in SPEC-016-4-04 enforces a soft cap of 5 commit exemptions before a stricter review is needed.

## Acceptance Criteria

- [ ] `.github/security/gitleaks.toml` parses cleanly via `gitleaks detect --config .github/security/gitleaks.toml --no-git --source /tmp/empty-dir` (exit code 0, no schema errors).
- [ ] `gitleaks detect --config .github/security/gitleaks.toml --no-git --no-allowlist --source tests/fixtures/security` reports at least one finding with `RuleID == "aws-access-key"` against `leaked-aws-key.txt`.
- [ ] `gitleaks detect --config .github/security/gitleaks.toml --no-git --source tests/fixtures/security` (with allowlist) reports zero findings.
- [ ] All five custom rule IDs are present and unique: `anthropic-api-key`, `slack-bot-token`, `discord-bot-token`, `github-pat`, `aws-access-key`.
- [ ] `[allowlist].paths` includes regex entries matching `.md$`, `plugins/autonomous-dev/tests/fixtures/.*`, `tests/fixtures/security/.*`, and `docs/.*`.
- [ ] `[allowlist].regexes` includes placeholders for `example_api_key`, `your_token_here`, `<replace_with_your_key>`, `dummy_secret`, and `AKIAEXAMPLE[A-Z0-9]+`.
- [ ] `[allowlist.commits].commits` exists and is initialized to `[]` (empty list, not omitted).
- [ ] `[extend].useDefault = true` is set so gitleaks' built-in rules also run.
- [ ] Hand-crafted positive samples for each of the five rules (one synthetic credential per rule, embedded in a temp file) are detected when `--no-allowlist` is passed.
- [ ] Hand-crafted negative samples (e.g., `AKIAEXAMPLEKEY12345`, `your_anthropic_key_here`) are silenced by the regex allowlist when allowlist is active.
- [ ] `tests/fixtures/security/README.md` explicitly states the fixture is synthetic and must not be reused in real code.
- [ ] `SECURITY.md` contains the section heading `## Managing the Gitleaks Allowlist` with three documented subsections (path, commit, review).

## Dependencies

- gitleaks v8.x (binary; CI installs via `gitleaks/gitleaks-action@v2` -- not a runtime dep here).
- TDD-016 §11 (Security scanning architecture).
- PRD-007 FR-14 (Security baseline required check on `main`).

## Notes

- We deliberately do NOT add per-rule severity overrides; the default severity is sufficient for the aggregate gate in SPEC-016-4-04 (any finding fails the build).
- The `extend.useDefault = true` line keeps gitleaks' built-in patterns (Stripe, Twilio, etc.) active. Custom rules layer on top, they don't replace.
- Commit-SHA exemptions exist for legacy leaks where the credential has been rotated and removing the commit would rewrite history. Path exemptions exist for fixtures, docs, and example files.
- The `AKIAEXAMPLE` prefix follows AWS' published convention for synthetic example keys, matching the rule regex while remaining clearly non-production.
- The path allowlist is intentionally generous (covers `*.md` and `docs/*`) because gitleaks' default rule set has high false-positive rates on prose. Custom rules in this file will still fire on those paths because path-allowlist entries are an OR'd allowlist, not a rule-disabler -- but verified placeholder regexes catch the common doc patterns.
