# SPEC-025-2-02: cred-proxy-runbook.md §3 Scoper Installation Per Cloud

## Metadata
- **Parent Plan**: PLAN-025-2
- **Parent TDD**: TDD-025-assist-cloud-credproxy-surface
- **Tasks Covered**: PLAN-025-2 Task 2 (§3 Scoper installation per cloud)
- **Estimated effort**: 5 hours
- **Status**: Draft
- **Future location**: `plugins/autonomous-dev/docs/specs/SPEC-025-2-02-cred-proxy-runbook-scoper-installation.md`

## Description
Append §3 "Scoper installation per cloud" to `plugins/autonomous-dev-assist/instructions/cred-proxy-runbook.md` (created by SPEC-025-2-01). Four subsections, one per cloud:

- **§3.1 AWS** — canonical detailed walkthrough per TDD-025 §11.3 trade-off. Covers `claude plugin install cred-proxy-scoper-aws`, IAM-policy snippet (or pointer to TDD-024 §8) for the minimum permissions the scoper's IAM principal needs to mint scoped STS sessions, and how to point the scoper at the right profile/role.
- **§3.2 GCP** — brief 5-10 line procedure with pointer to TDD-024 §8.
- **§3.3 Azure** — brief 5-10 line procedure with pointer to TDD-024 §8.
- **§3.4 K8s** — brief 5-10 line procedure with pointer to TDD-024 §8 + the explicit cred-proxy-TTL-vs-K8s-SA-token-projection-TTL distinction per TDD-025 §3.3 R-4.

The asymmetric depth (AWS canonical + others brief) is the documented trade-off. AWS is the most-deployed scoper and most-similar pattern operators already know; GCP/Azure/K8s deep coverage belongs in their per-cloud TDD-024 sections. K8s coverage is intentionally shallow per TDD-025 NG-07 (deep K8s service-account-token-projection coverage deferred to a future TDD).

No subsection instructs the operator to paste root credentials anywhere. Every documented command verifies prerequisites or installs/configures the scoper plugin.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-assist/instructions/cred-proxy-runbook.md` | Modify (append §3) | File created by SPEC-025-2-01. This spec appends §3 between §2 (created by SPEC-025-2-01) and §4 (created by SPEC-025-2-03). |

## Implementation Details

### Section 3 scaffold

Append after §2.5 (the last subsection landed by SPEC-025-2-01):

```markdown
## 3. Scoper installation per cloud

Each cloud you target requires its scoper plugin installed at `~/.autonomous-dev/cred-proxy/scopers/<cloud>`. The scoper translates root credentials into a scoped, short-lived token specific to that cloud's API. AWS is documented in detail below; GCP, Azure, and K8s are covered briefly with pointers to the per-cloud TDD-024 §8 deep reference.

Install only the scopers for clouds you actually deploy to. The cred-proxy daemon does not require all four to be present.
```

### §3.1 AWS (canonical detailed walkthrough)

```markdown
### 3.1 AWS

The AWS scoper translates a long-lived AWS profile (or assumed role) into short-lived **STS** session credentials narrowed to a requested scope. Operators familiar with `aws sts assume-role` will recognize the pattern.

#### 3.1.1 Install the scoper plugin

```bash
claude plugin install cred-proxy-scoper-aws
```

This places the scoper at `~/.autonomous-dev/cred-proxy/scopers/aws/`. After installation, restart the daemon:

```bash
cred-proxy stop
cred-proxy start
cred-proxy doctor
```

`doctor` should now list `aws` in the discoverable-scopers report.

#### 3.1.2 Configure the principal

The scoper needs an IAM principal it can authenticate as in order to call STS. The recommended pattern is a dedicated IAM user with a long-lived access key (kept in your `~/.aws/credentials` under a named profile) **or** an assumed role accessible via your existing AWS SSO session.

Set the profile name in `~/.autonomous-dev/cred-proxy/config.yaml`:

```yaml
cred_proxy:
  scopers:
    aws: ~/.autonomous-dev/cred-proxy/scopers/aws
  scoper_config:
    aws:
      profile: cred-proxy-issuer    # AWS profile the scoper uses to call STS
      session_name: cred-proxy      # tag for STS audit trail
```

If you prefer SSO, set `sso_session: <session-name>` instead of `profile`.

#### 3.1.3 Minimum IAM policy

The principal needs permission to call `sts:GetFederationToken` (or `sts:AssumeRole` for cross-account) **scoped to the resources the scoper will narrow to**. The minimum policy looks like:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sts:GetFederationToken",
        "sts:AssumeRole"
      ],
      "Resource": "*"
    }
  ]
}
```

For the deep specification of what each scoped issuance requests, see **TDD-024 §8 cred-proxy-scoper-aws**. The above is the minimum needed for the scoper to call STS at all; per-deploy scoping is then layered on by the issuance request body.

#### 3.1.4 Verify with a test issuance

```bash
cred-proxy issue aws "ec2:DescribeInstances"
```

A successful issuance returns a token-id and writes a chained entry to `audit.log`. Use `cred-proxy doctor --verify-audit` to confirm the chain advances.

**Do not paste your AWS root access keys into the scoper config.** The scoper reads from your existing `~/.aws/credentials` profile or SSO session; the YAML stores only the profile name.
```

### §3.2 GCP (brief)

```markdown
### 3.2 GCP

The GCP scoper translates a service-account keyfile (or `gcloud auth` session) into a short-lived OIDC token narrowed to the requested scope.

```bash
claude plugin install cred-proxy-scoper-gcp
```

Configure in `~/.autonomous-dev/cred-proxy/config.yaml`:

```yaml
cred_proxy:
  scopers:
    gcp: ~/.autonomous-dev/cred-proxy/scopers/gcp
  scoper_config:
    gcp:
      keyfile: ~/.config/gcloud/application_default_credentials.json
      # OR: use_gcloud_session: true
```

Test:

```bash
cred-proxy issue gcp "https://www.googleapis.com/auth/cloud-platform"
```

For full configuration detail (OIDC audience, impersonation chain, custom keyfile path), see **TDD-024 §8 cred-proxy-scoper-gcp**.

**Do not paste your service-account keyfile contents into the scoper YAML.** The YAML stores only the path; keep the keyfile at its canonical `0600` location.
```

### §3.3 Azure (brief)

```markdown
### 3.3 Azure

The Azure scoper uses `az account get-access-token --resource <scope>` to mint a short-lived token narrowed to the requested resource.

```bash
claude plugin install cred-proxy-scoper-azure
```

Configure in `~/.autonomous-dev/cred-proxy/config.yaml`:

```yaml
cred_proxy:
  scopers:
    azure: ~/.autonomous-dev/cred-proxy/scopers/azure
  scoper_config:
    azure:
      tenant_id: <your-tenant-id>
      # subscription_id: <optional-default>
```

The scoper requires an active `az login` session for the configured tenant. Test:

```bash
cred-proxy issue azure "https://management.azure.com/.default"
```

For the full Azure configuration matrix (managed identity vs. service principal vs. user session), see **TDD-024 §8 cred-proxy-scoper-azure**.
```

### §3.4 K8s (brief, with TTL distinction)

```markdown
### 3.4 K8s

The K8s scoper projects a short-lived service-account token via the **TokenRequest API** narrowed to the requested resource scope.

```bash
claude plugin install cred-proxy-scoper-k8s
```

Configure in `~/.autonomous-dev/cred-proxy/config.yaml`:

```yaml
cred_proxy:
  scopers:
    k8s: ~/.autonomous-dev/cred-proxy/scopers/k8s
  scoper_config:
    k8s:
      kubeconfig: ~/.kube/config
      # context: <optional-non-default-context>
```

Test:

```bash
cred-proxy issue k8s "namespace=default,verbs=get,resources=pods"
```

#### Two TTLs, not one

This is the most-misunderstood point about the K8s scoper. There are **two independent TTLs** at play:

- **cred-proxy TTL** — defaults to `900` seconds (15 minutes). This is the time the deploy worker holds the FD. Configurable in `cred_proxy.default_ttl_seconds`.
- **K8s service-account-token-projection TTL** — controlled by the cluster (`--service-account-extend-token-expiration`, typically 1 hour or more). This is the lifetime the cluster will accept the projected token.

The cred-proxy will set the projected token's `expirationSeconds` to match `default_ttl_seconds`, but the cluster may extend it to its own minimum. **A K8s TokenRequest token is therefore typically a no-op to revoke client-side after expiry** — the cluster has its own view of the token's lifetime. If you suspect a token compromise on K8s, use `kubectl delete serviceaccount <name>` to invalidate the cluster-side, not just `cred-proxy revoke`.

For deep coverage of the TokenRequest projection, audience-binding, and bound-service-account-token-volume semantics, see **TDD-024 §8 cred-proxy-scoper-k8s**. This runbook intentionally keeps K8s coverage shallow per TDD-025 NG-07.
```

### Lint and formatting

- `markdownlint` (existing config) must pass on the modified file.
- §3 heading is H2 (`## 3. Scoper installation per cloud`); subsections are H3 (`### 3.1 AWS`, etc.); deeper subsections are H4 (`#### 3.1.1 Install the scoper plugin`).
- Code-block fences use language hints: `bash`, `yaml`, `json`.
- The §3.4 "Two TTLs, not one" subheading uses H4 (`#### Two TTLs, not one`) and explicitly names both TTLs.
- All four `claude plugin install cred-proxy-scoper-<cloud>` commands appear, one per subsection.

## Acceptance Criteria

- [ ] `plugins/autonomous-dev-assist/instructions/cred-proxy-runbook.md` contains §3 between §2 and §4 (or at the end if §4 is not yet landed in the same PR).
- [ ] §3 has subsections §3.1 AWS, §3.2 GCP, §3.3 Azure, §3.4 K8s (in this order).
- [ ] §3.1 AWS contains all four subsubsections: install, configure principal, minimum IAM policy, verify with test issuance.
- [ ] §3.1 contains either an example IAM policy snippet OR a clear pointer to "TDD-024 §8 cred-proxy-scoper-aws" for the canonical policy.
- [ ] §3.1 has the verbatim directive "Do not paste your AWS root access keys" (or close paraphrase) — no documented step asks the operator to paste root credentials anywhere.
- [ ] §3.2 GCP, §3.3 Azure, §3.4 K8s each contain: the install command, a YAML configuration block, a test issuance command, and a "see TDD-024 §8" pointer.
- [ ] §3.2 contains the verbatim directive "Do not paste your service-account keyfile contents" (or close paraphrase).
- [ ] §3.4 K8s contains the explicit cred-proxy-TTL-vs-K8s-TokenRequest-TTL distinction.
- [ ] §3.4 names both TTLs by their full names ("cred-proxy TTL" and "K8s service-account-token-projection TTL" or equivalent).
- [ ] §3.4 mentions `kubectl delete serviceaccount` as the cluster-side invalidation path.
- [ ] §3.4 contains the phrase "TDD-025 NG-07" or "intentionally keeps K8s coverage shallow" (signposting the deferred deep coverage).
- [ ] All four `cred-proxy-scoper-<cloud>` plugin install commands appear, one per subsection.
- [ ] No documented command echoes a credential, keyfile content, or token to stdout.
- [ ] All bash blocks fenced with `bash`; YAML blocks with `yaml`; JSON blocks with `json`.
- [ ] §3 does not modify §1 or §2; existing content is byte-for-byte unchanged.
- [ ] `markdownlint` exits 0 on the modified file.

## Dependencies

- **TDD-025 §6.8** — authoritative source for §3 structure (per-cloud subsections).
- **TDD-025 §11.3 trade-off** — authoritative for the AWS-canonical / others-brief depth pattern.
- **TDD-025 §3.3 R-4** — authoritative for the K8s-TTL distinction.
- **TDD-025 NG-07** — authoritative for the K8s-coverage-shallow ceiling.
- **TDD-024 §8** — referenced from each subsection as the deep specification of per-cloud scoper internals. Forward reference acceptable.
- **SPEC-025-2-01** (sibling, hard precedence): creates the runbook file, lands §1 and §2, and reserves §3-§9 anchors in the TOC. This spec must run after SPEC-025-2-01 has at least its file-creation commit landed (in the same PR or merged).
- **SPEC-025-2-03** (sibling, soft): lands §4-§5 after this spec. Either order is fine if both are in the same PR.
- **No code dependencies** — documentation only.

## Notes

- The asymmetric depth (AWS canonical, GCP/Azure/K8s brief) is a deliberate design decision per TDD-025 §11.3. Reviewers may push back wanting equal depth across all four clouds; the plan-author rationale is: AWS STS is the most-similar pattern to what operators already know; GCP/Azure/K8s have their own per-cloud TDD-024 §8 sections for deep coverage; the runbook avoids duplicating those.
- The `scoper_config` YAML key is a documented convention in this spec but is **not** in TDD-025 §5.2's schema (the TDD's schema only documents the top-level `cred_proxy` block). If TDD-024 §10's actual config schema uses a different key name, this spec is updated at PR review time. The convention is otherwise defensible: namespaced under `cred_proxy.scoper_config.<cloud>` keeps the field explicit and testable.
- The minimum IAM policy in §3.1.3 is a placeholder example. The implementer should re-read TDD-024 §8 cred-proxy-scoper-aws at PR time and either copy the canonical policy from there or replace the example with a pointer-only ("see TDD-024 §8 for the minimum IAM policy"). The pointer-only path is the safer default.
- The K8s "Two TTLs, not one" callout uses H4 to avoid promoting it to a top-level subsection (H3) which would clash with §3.4's own H3. The H4-with-named-anchor pattern is consistent with how §2.5 uses H3 inside §2.
- The `kubectl delete serviceaccount` recommendation in §3.4 is a strong-form remediation; in practice operators may prefer `kubectl rollout restart` or rotating the SA keyfile. The "compromise" framing here is deliberately conservative — for actual incident response, operators should escalate per §9 (escalation, owned by SPEC-025-2-04).
- §3 does not document the cred-proxy daemon's own root-credential handling (that lives in §1 Overview, owned by SPEC-025-2-01). Operators reading §3 in isolation will be referred back to §1 for the architecture context.
