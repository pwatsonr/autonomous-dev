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
