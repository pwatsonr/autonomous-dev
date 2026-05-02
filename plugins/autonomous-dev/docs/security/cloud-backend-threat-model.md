# Cloud Backend Threat Model

Canonical reference for the autonomous-dev cloud-backend subsystem's
security posture. Every threat below has a documented mitigation chain
that cites the PLAN or SPEC delivering it. Future cloud-related plans
extend this document with new scenarios.

## Scope

This threat model covers the cloud-backend execution path: from operator
config (`extensions.privileged_backends`, `egress_allowlist`) through
plugin loading (PLAN-019-3 trust validator), session spawn (PLAN-018-2 +
PLAN-024-2), credential acquisition (PLAN-024-2 CredentialProxy with
15-minute TTL), egress filtering (SPEC-024-3-01 nftables / SPEC-024-3-02
pfctl), cost estimation (SPEC-024-3-03), and post-deploy reconciliation
into the cost ledger (PLAN-023-3).

Out-of-scope concerns are listed at the end.

## Assumptions

- The host kernel is Linux ≥5.8 (cgroup v2, nftables) or macOS ≥13 (pf
  with anchors).
- The autonomous-dev daemon runs as root or holds `CAP_NET_ADMIN`; on
  macOS, `pf` is enabled (`pfctl -e`).
- Cloud SDK dependencies are pinned by SHA in `package-lock.json` and
  reviewed via Dependabot.
- The operator's `extensions.privileged_backends[]` allowlist is
  intentionally curated — adding a backend is a security-review event.

## Threat Scenarios

### T1: Malicious or compromised cloud-backend plugin

- **Attack:** an attacker compromises a cloud-backend plugin (supply chain,
  malicious maintainer) and tries to execute arbitrary cloud API calls or
  exfiltrate the operator's credentials.
- **Impact:** unauthorised cloud actions; credential theft; lateral move
  into the operator's cloud account.
- **Mitigation chain:**
  1. PLAN-019-3 trust validator: signature + manifest validation rejects
     unsigned or tampered plugins.
  2. PLAN-024-2 `extensions.privileged_backends[]`: the plugin must be
     explicitly allowlisted; mere code presence is insufficient.
  3. SPEC-024-3-02 `validateCloudBackendTrust` hook: cross-checks
     privileged-backends membership AND meta-review approval.
  4. SPEC-024-3-01 / SPEC-024-3-02 egress firewall: even if loaded, the
     child process can only reach allowlisted FQDNs.
  5. PLAN-024-2 CredentialProxy: 15-minute TTL on issued credentials
     plus cloud-side audit (CloudTrail / Cloud Audit Logs / Azure
     Activity Log) gives forensic traceability.
- **Residual risk:** zero-day in a signed-but-malicious package between
  Dependabot scan and detection. Mitigated by short TTL and audit, not
  fully prevented.

### T2: Credential exfiltration to attacker host

- **Attack:** a compromised plugin tries to POST stolen short-lived
  credentials to an attacker-controlled host.
- **Impact:** credentials reused outside the daemon's enforcement window
  for the remaining TTL.
- **Mitigation chain:**
  1. SPEC-024-3-01 egress firewall (Linux nftables) / SPEC-024-3-02
     egress firewall (macOS pfctl): the attacker host's FQDN is not in
     the plugin's `egress_allowlist[]`, so the connection is rejected
     at the kernel layer (`reject with icmp` / `block return`).
  2. PLAN-024-2 CredentialProxy 15-minute TTL: even on bypass, the
     credential expires before significant abuse.
  3. SPEC-024-3-01 DNS refresh + 1-hour stale TTL: attacker cannot
     pin a stale IP and reuse it indefinitely.
- **Residual risk:** DNS rebinding inside the allowlisted FQDN —
  see T5.

### T3: Excessive cloud spend (intentional or accidental)

- **Attack:** a plugin (compromised or buggy) issues large numbers of
  expensive cloud API calls (e.g. spawn 10 000 ECS tasks).
- **Impact:** unexpected cloud bill; resource exhaustion in the
  operator's account.
- **Mitigation chain:**
  1. SPEC-024-3-03 `estimateDeployCost`: per-cloud heuristic estimates
     the deploy's cost before invocation.
  2. SPEC-024-3-03 orchestrator wiring: the estimate is checked against
     PLAN-023-3's daily cap; over-cap deploys are rejected with
     `DeployRejectedError` BEFORE `backend.deploy()` runs.
  3. PLAN-023-3 cost ledger: actuals (when reconciled) reduce the
     remaining cap window so subsequent deploys see reduced headroom.
  4. PLAN-024-2 CredentialProxy scope: credentials are scoped to the
     specific service+resource, so unrelated expensive APIs are denied
     at the cloud-IAM layer.
- **Residual risk:** an estimate that diverges 50% from actuals — the
  `confidence` field signals this, and operators with low-confidence
  backends are advised to set conservative caps.

### T4: Supply-chain attack on cloud SDK dependency

- **Attack:** a compromised version of `@aws-sdk/*`, `@google-cloud/*`,
  or `@azure/*` is published; a daemon update pulls it in.
- **Impact:** SDK acts as a man-in-the-middle for credentials or API
  calls.
- **Mitigation chain:**
  1. `package-lock.json` integrity hashes (`sha512-…`) — npm refuses to
     install a tampered tarball.
  2. Dependabot review: every cloud SDK upgrade is reviewed by a human
     maintainer (PLAN-019-3 trust posture extends to dev dependencies).
  3. SPEC-024-3-01 / SPEC-024-3-02 egress firewall: even a compromised
     SDK can only reach allowlisted endpoints; exfiltration of stolen
     credentials to an attacker host is blocked.
  4. PLAN-024-2 CredentialProxy TTL: 15 minutes — short window for
     abuse.
- **Residual risk:** an SDK that abuses an allowlisted endpoint
  (e.g. exfil via a legitimate AWS service) remains possible. Cloud-side
  audit logs are the post-hoc detection control.

### T5: DNS rebinding to bypass egress allowlist

- **Attack:** an attacker controls an allowlisted FQDN's authoritative DNS
  and rebinds it to an attacker IP between the daemon's resolution and
  the plugin's connection.
- **Impact:** plugin connects to attacker-controlled IP under the cover
  of an allowlisted FQDN.
- **Mitigation chain:**
  1. SPEC-024-3-01 / SPEC-024-3-02 design: rules are keyed on resolved
     IPs, not FQDNs. The plugin's connection goes to the IP the daemon
     resolved at apply time; an attacker who later rebinds DNS does not
     reach the plugin until the next 5-minute refresh.
  2. SPEC-024-3-01 stale TTL = 1 hour: rebinding-resistance is bounded
     by this window.
  3. PLAN-024-2 CredentialProxy 15-minute TTL: post-rebinding, stolen
     credentials still expire quickly.
  4. Cloud SDKs typically use TLS with hostname verification — even on
     rebinding, the attacker would need a valid cert for the
     allowlisted FQDN.
- **Residual risk:** an attacker with a valid cert for an allowlisted
  FQDN AND control of authoritative DNS during the 5-minute refresh
  window. Documented as the threshold the design accepts.

### T6: Privilege escalation via shared filesystem (`/tmp` leak)

- **Attack:** a compromised plugin writes credentials or sensitive data
  to `/tmp` where another (less-privileged) process can read it.
- **Impact:** credential leakage outside the daemon's enforcement
  perimeter.
- **Mitigation chain:**
  1. PLAN-024-2 spawner: each cloud-backend child runs with a unique
     effective UID drawn from `extensions.cloud_backend_uid_range`,
     limiting cross-process readability.
  2. PLAN-024-2 file mode: credentials written by the proxy use mode
     `0600` and are owned by the spawned UID.
  3. PLAN-021-2 evaluator-sandbox pattern (precedent): per-process
     mount namespace via `unshare --mount` is the documented future
     enhancement — out of scope for v1.
- **Residual risk:** without per-process mount namespaces, a co-located
  malicious process running as the same UID can still read the files.
  Mitigated operationally by reserving the cloud-backend UID range to
  the daemon.

## Out of Scope

- Cluster-level controls inside Kubernetes (out of v1 — the K8s backend
  treats cluster security as the operator's concern; cost confidence is
  0.0 for the same reason).
- Cross-cloud cost normalisation (USD only for v1).
- Service-mesh-level egress controls — the per-process firewall is
  process-bound, not service-bound.
- Plugin-marketplace approval workflow.
- Live cloud-billing-API integration for actuals (manual or
  billing-export-driven for v1).

## References

- TDD-024 sections §8 (firewall), §9 (trust integration), §10 (cost
  estimation), §14 (threat model).
- PLAN-019-3 trust validator, agent-meta-reviewer.
- PLAN-024-1 cloud backends.
- PLAN-024-2 CredentialProxy + privileged-backends.
- PLAN-024-3 (this plan): SPEC-024-3-01..04.
- PLAN-023-2 deploy orchestrator.
- PLAN-023-3 cost ledger + cap enforcement.
- PLAN-018-2 session spawner.
- PLAN-021-2 evaluator sandbox (precedent for mount-namespace work).
