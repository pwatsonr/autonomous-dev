# Credential Proxy Runbook

This runbook covers operating the credential proxy day-to-day: bootstrap, scoper installation per cloud, common failures, recovery, TTL tuning, audit-hash verification, and emergency revoke. It is the deep operator reference behind the `Credential Proxy` section in `skills/help/SKILL.md` and the `cred_proxy` section in `skills/config-guide/SKILL.md`.

## Sections

1. [Overview](#1-overview)
2. [Bootstrap](#2-bootstrap)
3. [Scoper installation per cloud](#3-scoper-installation-per-cloud)
4. [Common failures](#4-common-failures)
5. [Recovery](#5-recovery)
6. [TTL tuning](#6-ttl-tuning)
7. [Audit-hash verification](#7-audit-hash-verification)
8. [Emergency revoke](#8-emergency-revoke)
9. [Escalation](#9-escalation)

## See also

- `skills/help/SKILL.md` "Credential Proxy" section — operator-facing intro
- `skills/config-guide/SKILL.md` `cred_proxy` section — config schema
- `skills/troubleshoot/SKILL.md` — diagnostic scenarios

---

## 1. Overview

The credential proxy is a small daemon that issues short-lived, scope-narrowed credentials to deploy workers without ever exposing your root credentials to the deploying process. Architecturally:

- Your shell holds **root credentials** (AWS profile, GCP service-account keyfile, Azure session, K8s kubeconfig).
- The cred-proxy daemon reads those root credentials in its own process.
- When a deploy worker requests a credential, the proxy invokes a **per-cloud scoper plugin** (`cred-proxy-scoper-aws`, `cred-proxy-scoper-gcp`, `cred-proxy-scoper-azure`, `cred-proxy-scoper-k8s`) which calls the cloud's short-lived-token API (AWS STS, GCP OIDC, Azure access-token, K8s TokenRequest) to mint a credential narrowed to the requested scope.
- The proxy passes the resulting credential **as a file descriptor** to the deploy worker over a Unix-domain socket using the `SCM_RIGHTS` ancillary-data channel. This is **file descriptor passing**, not byte transport. The deploy worker never sees your root credentials.
- Each issuance is logged to `~/.autonomous-dev/cred-proxy/audit.log` as an HMAC-chained entry. The chain key is held in an environment variable named by the `audit_key_env` config field — the field stores the *name* of the env var, not the key itself.
- Each issued credential expires automatically at TTL end (default `900` seconds = 15 minutes); on expiry the proxy closes the deploy-worker FD, immediately revoking access.

```text
operator's shell environment (root creds: AWS_PROFILE, GCP keyfile, etc.)
        |
        v
+-----------------------------------------+
| cred-proxy daemon                       |
|   listens on ~/.autonomous-dev/         |
|           cred-proxy/socket             |
|   (mode 0600, owner-only)               |
+-----------------+-----------------------+
                  | SCM_RIGHTS (file descriptor passing)
                  v
+-----------------------------------------+
| deploy worker (autonomous-dev daemon)   |
|   receives scoped FD                    |
|   never sees root creds                 |
|   credential expires at TTL end (15m)   |
+-----------------------------------------+
```

The scoper-as-isolation-layer pattern means a compromised deploy worker can hold at worst a 15-minute, scope-narrowed token — not your root credentials.

---

## 2. Bootstrap

This section walks the first-time bootstrap of the cred-proxy on a fresh operator workstation. After completing it, you will have a running daemon, a verified socket, an installed audit key, and a passing `cred-proxy doctor`.

### 2.1 Start the daemon

```bash
cred-proxy start
```

The daemon forks and listens on `~/.autonomous-dev/cred-proxy/socket` with mode `0600`. The daemon enforces ownership at startup; if the socket already exists with the wrong owner, `start` exits non-zero with a diagnostic. **Do not run `cred-proxy start` as root.** The daemon must run as the same user that runs deploys.

### 2.2 Run the diagnostic

```bash
cred-proxy doctor
```

`doctor` checks: socket exists with mode `0600`; socket ownership matches the running user; daemon is responsive on the socket; per-cloud scoper plugins are discoverable at `~/.autonomous-dev/cred-proxy/scopers/<cloud>`; root credentials are reachable for each installed cloud (without storing or echoing them). A clean `doctor` is the precondition for the rest of bootstrap.

### 2.3 Generate and install the audit key

The audit key is the HMAC chain key for `audit.log`. It must be installed in your shell environment so the daemon can read it on next start. **Never echo the audit key to stdout.** Use the file-based pattern:

```bash
# Generate a 32-byte hex key into an owner-only file. The redirect avoids stdout exposure.
( umask 0177; openssl rand -hex 32 > ~/.autonomous-dev/cred-proxy/audit-key )

# Verify mode (the umask above sets 0600). Re-apply explicitly if needed.
chmod 0600 ~/.autonomous-dev/cred-proxy/audit-key
```

Add the export to your shell rc (`~/.bashrc`, `~/.zshrc`, etc.):

```bash
# In your shell rc:
export CRED_PROXY_AUDIT_KEY="$(cat ~/.autonomous-dev/cred-proxy/audit-key)"
```

Then in `~/.autonomous-dev/cred-proxy/config.yaml` set:

```yaml
cred_proxy:
  audit_key_env: CRED_PROXY_AUDIT_KEY   # the NAME of the env var, not the key
```

**Alternative pattern.** If you prefer not to keep the key in a file, you can prompt for it interactively without echo:

```bash
read -s -p "Audit key: " CRED_PROXY_AUDIT_KEY
export CRED_PROXY_AUDIT_KEY
```

Either pattern is acceptable; both keep the key out of shell scrollback.

### 2.4 Restart and re-verify

```bash
cred-proxy stop
cred-proxy start
cred-proxy doctor
```

After the restart, `doctor` should report the audit key is loaded (the chain hash advances when an issuance occurs).

### 2.5 What to commit

Commit `~/.autonomous-dev/cred-proxy/config.yaml` to your dotfiles repo if you wish, **but never commit `~/.autonomous-dev/cred-proxy/audit-key`**. Add it to your dotfiles `.gitignore`:

```text
.autonomous-dev/cred-proxy/audit-key
.autonomous-dev/cred-proxy/audit.log
.autonomous-dev/cred-proxy/socket
```

---

## 3. Scoper installation per cloud

Each cloud you target requires its scoper plugin installed at `~/.autonomous-dev/cred-proxy/scopers/<cloud>`. The scoper translates root credentials into a scoped, short-lived token specific to that cloud's API. AWS is documented in detail below; GCP, Azure, and K8s are covered briefly with pointers to the per-cloud TDD-024 §8 deep reference.

Install only the scopers for clouds you actually deploy to. The cred-proxy daemon does not require all four to be present.

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

---

## 4. Common failures

The cred-proxy fails in four canonical ways. The detection signals below let you triage which failure mode applies before consulting §5 for the recovery procedure.

### 4.1 Permission denied on the Unix socket

The deploy worker (or any other client) cannot connect to `~/.autonomous-dev/cred-proxy/socket`. Symptom is `EACCES` or "Permission denied" on the connect call. Two root causes:

- **Socket mode is not `0600`.** Verify with `ls -l ~/.autonomous-dev/cred-proxy/socket`. The file should be `srw-------`.
- **Socket ownership does not match the running user.** Verify with `stat` (use `stat -f "%Sp %u %g"` on macOS, `stat -c "%a %u %g"` on Linux). The owner must match the user that runs both the daemon and the deploy worker.

### 4.2 Scoper missing

`cred-proxy issue <cloud> ...` fails with a "scoper not found" diagnostic, or `cred-proxy doctor` reports the requested cloud's scoper as missing. Detection: `ls ~/.autonomous-dev/cred-proxy/scopers/<cloud>` returns no such file. The scoper plugin has not been installed for that cloud.

### 4.3 TTL expired mid-deploy

A long-running deploy fails with an auth error (typically a 401, 403, or token-expired diagnostic from the cloud API) approximately 15 minutes after deploy start. The cred-proxy `audit.log` shows the issuance entry was issued well before the failure. Detection: `cred-proxy audit.log | tail` shows the issuance, and the elapsed time from issuance to failure exceeds `default_ttl_seconds` (default `900`).

This is the **most-misdiagnosed failure mode**. Operators routinely interpret the auth error as a credential compromise and rotate root credentials. That is the wrong action. See §5.3.

### 4.4 Audit-hash mismatch

`cred-proxy doctor --verify-audit` reports a chain-hash mismatch. Some entry in `~/.autonomous-dev/cred-proxy/audit.log` has a hash that does not match the previous-entry hash chained through the audit key. Detection: the verbatim diagnostic output of `cred-proxy doctor --verify-audit` includes "chain mismatch" or "audit chain broken" (exact phrasing per TDD-024 §10).

This is a **security-significant** event. The audit chain breaks for one of three reasons: (a) the audit log was edited or truncated outside the daemon; (b) the audit key changed mid-stream; (c) an actual integrity break worth investigating. In all three cases, the response is the same: **escalate**. Do not unilaterally "fix" the audit log. See §5.4 and §9.

---

## 5. Recovery

For each failure in §4, the recovery procedure below. Read the §4 detection signal first to confirm which failure applies — applying the wrong recovery makes the situation worse (especially for §5.3).

### 5.1 Permission denied on the Unix socket

If the socket mode is wrong:

```bash
chmod 0600 ~/.autonomous-dev/cred-proxy/socket
```

If the socket ownership is wrong, restart the cred-proxy daemon as the deploying user (the user that runs the deploy worker, **not** root):

```bash
cred-proxy stop
cred-proxy start
cred-proxy doctor
```

If the daemon is not running at all, start it:

```bash
cred-proxy start
```

**Do not chown the socket to root.** The cred-proxy daemon enforces ownership at startup; chown-to-root will cause the daemon to refuse to start (and even if you bypass that check, the deploy worker, which runs as a non-root user, will still get `EACCES`). The socket *must* be owned by the deploying user.

### 5.2 Scoper missing

Install the missing scoper plugin for the affected cloud, then restart the daemon and re-verify:

```bash
claude plugin install cred-proxy-scoper-<cloud>   # one of aws, gcp, azure, k8s
cred-proxy stop
cred-proxy start
cred-proxy doctor
```

`doctor` should now list the scoper as discoverable. Re-run the deploy.

If you do not actually deploy to that cloud, check that the deploy command's target was correct — a typo in `--cloud` can request a scoper you never installed.

### 5.3 TTL expired mid-deploy

The auth failure is **expected** for any deploy whose wall-clock duration exceeds `default_ttl_seconds`. There are two correct recovery paths:

- **Option A: Raise the TTL.** Edit `~/.autonomous-dev/cred-proxy/config.yaml` and increase `cred_proxy.default_ttl_seconds`. The practical upper bound for AWS STS chained roles is ~4 hours (14400 seconds); see §6 for the full TTL-tuning trade-off. After editing, restart the daemon (`cred-proxy stop && cred-proxy start`) and retry the deploy.
- **Option B: Restructure the deploy** into shorter steps that each complete within `default_ttl_seconds`. This is the preferred long-term fix for deploys whose duration grows over time.

**Do not rotate root credentials.** The auth failure is a TTL expiry, not a credential compromise. Rotating root credentials does not fix the underlying cause (the deploy still exceeds the TTL on the next attempt) and creates unnecessary downstream work (every other consumer of those credentials must be updated). The cred-proxy `audit.log` (§4.3 detection signal) confirms the issuance is legitimate.

### 5.4 Audit-hash mismatch

A chain-hash mismatch is a security-significant event. The recovery is **always escalation**, not a unilateral fix.

```bash
# Capture the diagnostic output for escalation:
cred-proxy doctor --verify-audit > /tmp/audit-mismatch-$(date +%s).log

# Stop the daemon to prevent further issuance until the mismatch is resolved:
cred-proxy stop
```

Then escalate per §9. The on-call security contact will:

- Compare the captured diagnostic against the operational audit-key rotation history.
- Determine whether the mismatch is a benign cause (audit-key rotation without re-keying the chain) or a security-significant cause (log tampering, integrity break).
- Decide on the recovery path (re-key the chain from a known-good entry; restore from a backup; investigate further).

**Do not delete the audit log.** Deleting the log destroys the only forensic record of what was issued and when. **Do not edit the audit log.** Editing the log makes the chain-hash mismatch worse and obscures the original cause. **Do not attempt unilateral recovery.** Escalate and let the security contact decide.
