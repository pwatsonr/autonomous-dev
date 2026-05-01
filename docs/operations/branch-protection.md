# Branch Protection Runbook

Operator runbook for configuring required status checks on `main`. Every plan
that introduces a new required check appends to the table below and updates
the `gh api` snippet so the protected-branch state is reproducible.

## Required Status Checks on `main`

The following checks are required on every PR before merge:

| Check Name | Owning Plan | Source Workflow |
|------------|-------------|-----------------|
| `lint` | PLAN-016-1 | `.github/workflows/ci.yml` |
| `unit-tests` | PLAN-016-1 | `.github/workflows/ci.yml` |
| `security-baseline` | PLAN-016-4 | `.github/workflows/security-review.yml` |

> The check name is the **GitHub job display name** (the `name:` field on the
> job), NOT the workflow filename or job key. Branch protection matches on
> the display name as a literal string. Renaming a job requires a coordinated
> update to this document AND the `gh api` command below on every protected
> repository.

### Applying Branch Protection

Run the following as a repo admin (the `gh` CLI must be authenticated with
`repo` and `admin:repo_hook` scopes):

```bash
gh api -X PUT \
  "repos/${OWNER}/${REPO}/branches/main/protection" \
  -F required_status_checks.strict=true \
  -F 'required_status_checks.contexts[]=lint' \
  -F 'required_status_checks.contexts[]=unit-tests' \
  -F 'required_status_checks.contexts[]=security-baseline' \
  -F enforce_admins=true \
  -F required_pull_request_reviews.required_approving_review_count=1
```

`enforce_admins=true` is **non-negotiable** for security gates: even repo
admins must comply, otherwise an attacker who compromises an admin account
can bypass the scanner.

### Verifying Branch Protection

```bash
gh api "repos/${OWNER}/${REPO}/branches/main/protection" \
  | jq '.required_status_checks.contexts'
```

Expected output:

```json
[
  "lint",
  "unit-tests",
  "security-baseline"
]
```

If any context is missing, re-run the `PUT` command above. The API replaces
the full `contexts[]` array on each call, so partial updates require listing
every required context.

### Removing a Required Check

Removing a required check is a security-sensitive operation. Open a PR that
(a) removes the row from the table above, (b) updates the `gh api` snippet,
and (c) has explicit approval from the `security-review` GitHub team. Once
merged, re-run the `PUT` command from the snippet to apply the new state.

## Related Documents

- `SECURITY.md` — gitleaks allowlist governance.
- `plugins/autonomous-dev/docs/specs/SPEC-016-4-04-*` — origin spec for the
  `security-baseline` aggregate gate.
- PRD-007 FR-14 — required-status-check governance contract.
