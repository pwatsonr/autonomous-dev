# Security Policy

This document covers reporting security issues, the secret-scanning baseline,
and the governance process for changes to `.github/security/gitleaks.toml`.

## Reporting a Vulnerability

Please open a private security advisory via GitHub
(`Security` tab → `Report a vulnerability`) rather than a public issue. Include
reproduction steps, affected versions, and suggested mitigations.

## Managing the Gitleaks Allowlist

The `.github/security/gitleaks.toml` file powers the `security-baseline`
required check on `main` (PRD-007 FR-14). Changes to the allowlist directly
affect what credential leaks CI will catch, so all edits go through the
process below.

### Adding a Path Exemption

Path exemptions live in `[allowlist].paths` as TOML strings interpreted by
gitleaks as regular expressions. Use them when a directory legitimately
contains placeholder credentials, fixtures, or vendored sample files.

Example — exempt a new docs subtree:

```toml
[allowlist]
paths = [
  # ... existing entries ...
  '''docs/integrations/.*''',
]
```

Requirements:

- The PR introducing the entry MUST be reviewed by a member of the
  `security-review` GitHub team.
- Prefer narrowly-scoped regexes (`docs/integrations/.*`) over broad ones
  (`docs/.*`) when a tighter pattern works.
- Document the rationale in the PR description.

### Adding a Commit-SHA Exemption

The `[allowlist.commits]` block holds SHAs of historical commits that contain
credentials which have since been **rotated**. Use commit exemptions when
removing the leak would require rewriting public history.

```toml
[allowlist.commits]
commits = [
  "abc1234def5678",
]
```

Every entry MUST be logged in the
`## Allowlist Exemption Log` table at the bottom of this file with the columns
below; missing log entries fail review:

| SHA | Rule | Rotated On | Approver |
|-----|------|------------|----------|

The bats suite (`tests/ci/test_security_workflow.bats`) enforces a soft cap of
five commit-SHA exemptions; raising the cap requires updating the test and a
second `security-review` approval.

### Review Process

Every PR that modifies `.github/security/gitleaks.toml`:

1. Requires an approval from the `security-review` GitHub team.
2. Must keep the bats test suite green (`bats tests/ci/test_security_workflow.bats`).
3. Must explain in the PR description WHY the change is needed and WHAT
   alternatives were considered (e.g. credential rotation, fixture relocation).
4. Cannot remove or weaken an existing custom rule without a separate
   discussion captured in the PR body.

Squash-merges are required so the exemption history is auditable from
`git log -- .github/security/gitleaks.toml`.

## Allowlist Exemption Log

| SHA | Rule | Rotated On | Approver |
|-----|------|------------|----------|
| _(none)_ | | | |
