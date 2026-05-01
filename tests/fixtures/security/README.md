# Security Fixtures

This directory contains **synthetic** credential samples used to regression-test
the secret-scanning configuration in `.github/security/gitleaks.toml`.

## Purpose

The fixtures here exist so that CI can verify the `aws-access-key` (and other)
gitleaks rules continue to fire as patterns evolve. The smoke test in
`tests/ci/test_security_workflow.bats` (added by SPEC-016-4-04) runs:

```bash
gitleaks detect --config .github/security/gitleaks.toml \
  --no-git --no-allowlist --source tests/fixtures/security
```

and asserts that `aws-access-key` produces a finding against
`leaked-aws-key.txt`.

## Why These Fixtures Are Allowlisted

The `[allowlist].paths` block in `gitleaks.toml` includes
`tests/fixtures/security/.*`. This prevents the planted fixture from blocking
ordinary PRs while still allowing the smoke test to detect it via
`--no-allowlist`.

## Warning

**Do NOT** copy any value from these fixtures into:

- application code
- environment files (`.env`, `.envrc`, `direnv` configs)
- shell history or scratch files
- CI secrets or any production system

The strings here are deliberately shaped to look like real credentials so the
regex engine matches them. They have **no access** to any real service, but
mishandling them undermines the discipline this scanner protects.

## Files

| File | Rule Tested | Notes |
|------|-------------|-------|
| `leaked-aws-key.txt` | `aws-access-key` | Uses `AKIAEXAMPLE...` prefix per AWS' published convention for synthetic keys. |
