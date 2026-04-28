# TDD-024: Cloud Backends & Credential Proxy

| Field        | Value                                              |
|--------------|----------------------------------------------------|
| **Title**    | Cloud Backends & Credential Proxy                  |
| **TDD ID**   | TDD-024                                            |
| **Version**  | 1.0                                                |
| **Date**     | 2026-04-28                                         |
| **Status**   | Draft                                              |
| **Author**   | Patrick Watson                                     |
| **Parent PRD** | PRD-014: Deployment Backends Framework           |
| **Plugin**   | autonomous-dev                                     |

---

## 1. Summary

This security-critical TDD specifies cloud deployment backends (gcp, aws, azure, k8s) and the **CredentialProxy** that serves operation-scoped, short-lived credentials to backend processes. The CredentialProxy is BINDING per PRD-014 §20.1: backends never receive long-lived credentials directly; they request scoped tokens via stdin/socket; egress is firewalled to cloud API endpoints only.

This addresses the SEC-004 CRITICAL finding from the PR-8 review (backend credential exfiltration).

## 2. Goals & Non-Goals

| ID    | Goal                                                                              |
|-------|------------------------------------------------------------------------------------|
| G-01  | Cloud backend plugin shape: separate `plugins/autonomous-dev-deploy-{provider}/`. |
| G-02  | CredentialProxy serves operation-scoped 15-minute STS-style tokens.               |
| G-03  | Tokens delivered via stdin/socket only — never env vars or files.                 |
| G-04  | Per-process egress firewall: backends reach cloud APIs and daemon socket only.    |
| G-05  | HMAC-signed deployment records (cross-ref TDD-023 §8) for safe rollback.          |
| G-06  | Per-cloud conformance suite: every backend passes the same 12 baseline tests.     |

| ID     | Non-Goal                                                                       |
|--------|---------------------------------------------------------------------------------|
| NG-01  | DeploymentBackend interface itself (TDD-023).                                  |
| NG-02  | Bundled (non-cloud) backends — local/static/docker-local/github-pages (TDD-023).|
| NG-03  | Direct cloud SDK trust — backends use cloud SDKs but creds come from proxy.    |

## 3. Background

PRD-014 §20.1 mandates a CredentialProxy because cloud backends, as plugins, run with potential access to operator-managed long-lived credentials in `~/.aws/credentials`, `gcloud auth`, and kubeconfig. A malicious or buggy backend can exfiltrate these. The proxy decouples credential storage from backend execution.

## 4. Architecture

```
┌────────────────────────────────────────────────────────────────┐
│ Operator workstation                                            │
│                                                                  │
│  ┌──────────────┐    long-lived creds   ┌──────────────────┐    │
│  │ ~/.aws/      │◄──── (read-only)─────►│ CredentialProxy   │    │
│  │ ~/.config/   │                       │  (in-process)     │    │
│  │   gcloud/    │                       │                   │    │
│  │ ~/.kube/     │                       │ • Source loaders  │    │
│  └──────────────┘                       │ • Policy generator│    │
│                                          │ • Token issuer    │    │
│                                          │ • Audit logger    │    │
│                                          └────────┬──────────┘    │
│                                                   │               │
│                                       acquire(provider, op, scope)│
│                                                   │               │
│                                                   ▼               │
│                                          ┌──────────────────┐     │
│                                          │ Backend Plugin   │     │
│                                          │ Process          │     │
│                                          │                  │     │
│                                          │ scoped 15m token │     │
│                                          │ via stdin/socket │     │
│                                          └────────┬─────────┘     │
│                                                   │               │
│                              egress firewall ─────┤               │
│                                                   ▼               │
└──────────────────────────────────────────────────────────────────┘
                                                    │
                                                    ▼
                                       ┌─────────────────────────┐
                                       │ Cloud API endpoints      │
                                       │ (allowlisted only)        │
                                       │ *.amazonaws.com          │
                                       │ *.googleapis.com         │
                                       │ *.azure.com              │
                                       │ kubeconfig.server         │
                                       └─────────────────────────┘
```

## 5. Cloud Backend Plugin Shape

Each cloud backend ships as a separate plugin: `plugins/autonomous-dev-deploy-{gcp,aws,azure,k8s}/`.

```
plugins/autonomous-dev-deploy-aws/
├── .claude-plugin/
│   └── plugin.json          # declares dependency on autonomous-dev >=1.x
├── src/
│   ├── backend.ts           # implements DeploymentBackend (TDD-023)
│   ├── ecs-deployer.ts
│   ├── ecr-builder.ts
│   └── health-checker.ts
├── agents/
│   └── aws-deploy-expert.md
└── README.md
```

`plugin.json` extension:

```json
{
  "name": "autonomous-dev-deploy-aws",
  "version": "1.0.0",
  "extends": ["autonomous-dev"],
  "deployment_backend": {
    "name": "aws",
    "regions_supported": ["us-east-1", "us-west-2", "eu-west-1"],
    "services_supported": ["ecs-fargate", "lambda", "s3-static"],
    "credential_provider": "credential-proxy"
  }
}
```

## 6. Per-Cloud Backend Specs

### 6.1 GCP (Cloud Run + Cloud Build)

```typescript
class GCPBackend implements DeploymentBackend {
  name = "gcp";
  async build(ctx: BuildContext): Promise<BuildArtifact> {
    // Acquire scoped creds from proxy
    const creds = await proxy.acquire("gcp", "CloudBuild:CreateBuild", { project: ctx.params.gcp_project });
    const cb = new CloudBuildClient({ credentials: creds });
    const build = await cb.createBuild({ /* ... */ });
    return { id: build.id, type: "container-image", uri: build.images[0] };
  }
  async deploy(artifact, env): Promise<DeploymentRecord> {
    const creds = await proxy.acquire("gcp", "Run.Deploy", { project: env.gcp_project, service: env.service });
    const run = new CloudRunClient({ credentials: creds });
    const deployment = await run.deployRevision({ image: artifact.uri, /* ... */ });
    return signDeploymentRecord(deployment);
  }
  async healthCheck(d) { return await pollUrl(d.url, "/health"); }
  async rollback(d) {
    const creds = await proxy.acquire("gcp", "Run.UpdateService", { project: d.project });
    return new CloudRunClient({ credentials: creds }).rollbackToRevision(d.previous_revision);
  }
}
```

### 6.2 AWS (ECS Fargate + ECR)

```typescript
class AWSBackend implements DeploymentBackend {
  async build(ctx) {
    const creds = await proxy.acquire("aws", "ECR:PutImage", { account: ctx.params.aws_account, region: ctx.params.aws_region });
    // docker push via vendored client (egress-firewalled)
  }
  async deploy(artifact, env) {
    const creds = await proxy.acquire("aws", "ECS:UpdateService", { cluster: env.cluster, service: env.service });
    const ecs = new ECSClient({ credentials: creds });
    return signDeploymentRecord(await ecs.updateService({ image: artifact.uri }));
  }
  // ... healthCheck, rollback
}
```

### 6.3 Azure (Container Apps + ACR)

Same pattern. Azure uses Managed Identity scoped to the operation via Role Assignment.

### 6.4 Kubernetes (kubectl/helm)

```typescript
class K8sBackend implements DeploymentBackend {
  async deploy(artifact, env) {
    // Proxy returns a ScopedKubeconfig limited to a specific namespace + ServiceAccount
    const scopedKubeconfig = await proxy.acquire("k8s", "deploy", { cluster: env.cluster, namespace: env.namespace });
    await execFile("kubectl", ["--kubeconfig=/dev/stdin", "apply", "-f", "-"], { input: scopedKubeconfig + "\n---\n" + manifests });
    return signDeploymentRecord(/* ... */);
  }
}
```

## 7. CredentialProxy (Deepest Section)

### 7.1 Service Architecture

In-process service running inside the autonomous-dev daemon. Backend plugins are spawned as child processes; the proxy serves credentials to them via stdin (preferred) or unix socket.

```typescript
interface ScopedCredential {
  provider: "aws" | "gcp" | "azure" | "k8s";
  delivery: "stdin" | "socket";
  payload: string;          // serialized credential (JSON for cloud SDKs, kubeconfig for K8s)
  expires_at: string;       // ISO 8601
  token_id: string;         // for revocation
  scope: { operation: string; resources: string[] };
}

class CredentialProxy {
  async acquire(
    provider: string,
    operation: string,
    scope: Record<string, unknown>
  ): Promise<ScopedCredential> {
    // 1. Verify caller is on the privileged backends allowlist
    const callerPlugin = inferCallerPlugin();
    if (!config.extensions.privileged_backends.includes(callerPlugin)) {
      throw new SecurityError(`Plugin ${callerPlugin} not allowlisted for cloud creds`);
    }

    // 2. Generate operation-scoped token via provider-specific flow
    const token = await this.scoper(provider).scope(operation, scope);

    // 3. Audit log
    await auditLog.append({
      event: "credential_issued",
      provider, operation, scope,
      caller: callerPlugin,
      token_id: token.id,
      ttl_seconds: 900
    });

    // 4. Return for stdin/socket delivery (15min TTL hard-coded)
    return { provider, delivery: "stdin", payload: token.serialize(), expires_at: token.expires, token_id: token.id, scope: { operation, resources: Object.keys(scope) } };
  }

  async revoke(token_id: string): Promise<void> {
    await this.scoper(token.provider).revoke(token_id);
    await auditLog.append({ event: "credential_revoked", token_id });
  }
}
```

### 7.2 Per-Provider Scoping

**AWS**: STS AssumeRole with on-the-fly IAM policy generated from operation:

```typescript
function awsPolicyFor(operation: string, scope: Record<string, unknown>): IAMPolicy {
  if (operation === "ECS:UpdateService") {
    return {
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Action: ["ecs:UpdateService", "ecs:DescribeServices"],
        Resource: `arn:aws:ecs:${scope.region}:${scope.account}:service/${scope.cluster}/${scope.service}`
      }]
    };
  }
  // ... other operations
}

const stsCreds = await sts.assumeRole({
  RoleArn: config.aws.deploy_role_arn,
  RoleSessionName: `autonomous-dev-${scope.operation}-${Date.now()}`,
  DurationSeconds: 900,  // 15 min
  Policy: JSON.stringify(awsPolicyFor(operation, scope))   // inline session policy
});
```

**GCP**: Service Account with custom IAM binding scoped to a single resource for 15 minutes via short-lived token (`generateAccessToken` with delegated permissions).

**Azure**: Managed Identity with Role Assignment scoped to specific resource; assignment created at acquire, removed at TTL.

**K8s**: ServiceAccount-issued token with namespace-scoped Role binding; certificate has `Not After` 15 min from issuance.

### 7.3 Delivery Mechanism

**Stdin (preferred)**:

```typescript
const child = spawn(backendPath, args, { stdio: ["pipe", "inherit", "inherit"] });
child.stdin.write(scopedCred.payload);
child.stdin.end();
```

**Unix socket fallback**: when backend needs to acquire multiple times during a long operation:

```typescript
// Daemon side
const server = net.createServer((sock) => {
  sock.on("data", async (req) => {
    const parsed = JSON.parse(req.toString());
    const cred = await proxy.acquire(parsed.provider, parsed.operation, parsed.scope);
    sock.write(JSON.stringify(cred));
  });
});
server.listen("/tmp/autonomous-dev-cred.sock", { mode: 0o600 });
```

Backend connects to the socket via `SCM_RIGHTS` for credential authentication.

### 7.4 TTL Enforcement

- Hard-coded 900s (15 min) in proxy code, not configurable
- Backend plugins SHALL renew tokens before expiry; explicit `release(token_id)` for early return
- Tokens auto-revoke at TTL; subsequent API calls fail with cloud-provider auth error

## 8. Per-Process Egress Firewall

### Linux (preferred): nftables

```bash
# Per-PID firewall rule, configured at backend spawn
nft add table ip autonomous-dev-egress
nft add chain ip autonomous-dev-egress output { type filter hook output priority 0\; }
nft add rule ip autonomous-dev-egress output meta cgroup $BACKEND_CGROUP_ID accept ip daddr { aws-api-cidr, gcp-api-cidr, azure-api-cidr } 
nft add rule ip autonomous-dev-egress output meta cgroup $BACKEND_CGROUP_ID drop
```

Backend processes run in a dedicated cgroup; firewall enforces per-cgroup egress allowlist.

### macOS / fallback: vendored HTTP client allowlist

When OS-level firewall isn't available, backends MUST use the vendored `@autonomous-dev/safe-http` module which validates destination against the allowlist before connecting:

```typescript
import { safeFetch } from "@autonomous-dev/safe-http";

const allowedDomains = [
  "*.amazonaws.com",
  "*.googleapis.com",
  "*.azure.com",
  "127.0.0.1"
];

await safeFetch("https://ecs.us-east-1.amazonaws.com/...", { /* ... */ });  // OK
await safeFetch("https://attacker.example.com/...", { /* ... */ });          // throws
```

Backend code review verifies no other HTTP client is imported (linter rule).

## 9. Trust Integration

- Cloud backend registration triggers `agent-meta-reviewer` (PRD-003 FR-32) audit at install
- `extensions.privileged_backends` allowlist (separate from general allowlist) — operator approves each backend explicitly
- Production environment deploys require additional approval gate per PRD-007 trust ladder

## 10. Cost Estimation

```typescript
interface CostShape {
  per_build_usd: number;
  per_runtime_hour_usd: number;
  per_request_usd?: number;
  egress_per_gb_usd?: number;
}

// Each backend declares its shape in plugin.json
{
  "deployment_backend": {
    "cost_shape": {
      "per_build_usd": 0.05,
      "per_runtime_hour_usd": 0.10,
      "egress_per_gb_usd": 0.09
    }
  }
}
```

CredentialProxy enforces `governance.deploy_cost_cap_per_request_usd` at acquire time using the cost shape.

## 11. Test Strategy

12-test conformance suite every backend must pass:

1. Build artifact happy path
2. Deploy happy path
3. Health check after deploy
4. Rollback success
5. Rollback failure recovery
6. Credential leak via env var (must fail to read)
7. Credential leak via file read (must fail)
8. Credential leak via sibling process /proc inspection (must fail)
9. Egress firewall: connect to disallowed domain (must fail)
10. Scope bypass: use creds for unrelated operation (must fail with cloud auth error)
11. TTL expiry: use cred after 15min (must fail with auth error)
12. Concurrent acquire/release stress test

## 12. Performance

- Credential acquisition: <200ms p95 (cached scoper) / <500ms p95 (cold)
- Cloud API call: provider-dependent (AWS 100-500ms, GCP 200-1000ms, Azure 200-1500ms)
- Deploy e2e p95: GCP 4min, AWS 5min, Azure 6min, K8s 2min

## 13. Migration & Rollout

- Phase 2a: GCP backend (simplest API) — Weeks 1-3
- Phase 2b: AWS backend — Weeks 4-6
- Phase 2c: Azure backend — Weeks 7-9
- Phase 2d: K8s backend — Weeks 10-12

## 14. Security Threat Model

| Threat | Severity | Mitigation |
|--------|----------|------------|
| Credential exfiltration via env | Critical | Stdin/socket delivery only; env stripped |
| Credential exfiltration via fs read | Critical | Backend has no fs access to operator cred files |
| Token replay after revoke | High | Cloud-side TTL enforcement; revoke list |
| Scope escalation | High | Operation-scoped policy at issue time |
| Egress to attacker domain | High | nftables firewall or safe-http allowlist |
| Supply chain (compromised cloud SDK) | High | Pinned dep versions; SBOM; deps reviewed at install |

## 15. Open Questions

1. Multi-region deployments: per-region creds or single multi-region scope?
2. Cross-cloud deployments (AWS RDS + GCP Cloud Run): supported?
3. Long-lived backend processes that need creds beyond 15min: renewal or re-spawn?

## 16. References

- PRD-014 §20 (CredentialProxy binding)
- TDD-023 (DeploymentBackend interface)
- TDD-019 (privileged-backends allowlist)
- AWS IAM best practices, GCP IAM best practices
