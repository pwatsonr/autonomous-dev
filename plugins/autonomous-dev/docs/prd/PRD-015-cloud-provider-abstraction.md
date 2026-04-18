# PRD-015: Cloud Provider Abstraction (AWS / GCP / On-Prem)

| Field | Value |
|-------|-------|
| PRD ID | PRD-015 |
| Version | 0.1.0 |
| Date | 2026-04-18 |
| Author | Patrick Watson |
| Status | Draft |
| Plugin | autonomous-dev |

## 1. Problem

autonomous-dev targets no specific cloud today. Users deploying production workloads need first-class support for AWS, GCP, and on-premises infrastructure with a consistent abstraction layer so that projects are not locked into any single provider at the platform level.

The 2026 FAANG-consensus architecture acknowledges that most organizations run on a single primary cloud but require portability as a strategic option — not active multi-cloud operations. The correct design principle is: **SINGLE-CLOUD-NATIVE with OPEN-STANDARD PORTABILITY**. Kubernetes, OpenTelemetry, OCI, SPIFFE, and Crossplane deliver portability as optionality without the operational overhead of active multi-cloud.

Without a `CloudProvider` abstraction, autonomous-dev forces users to write cloud-specific logic inside agent workflows, IaC templates, and CLI commands. Every new cloud requires a rewrite. This PRD defines the interface, the three initial adapters, and the cross-cutting concerns (secrets, registry, observability, identity) that make provider switching a configuration change rather than a code change.

## 2. Goals

| ID | Goal |
|----|------|
| G-1 | Define a `CloudProvider` interface with `aws`, `gcp`, and `onprem` adapters |
| G-2 | Kubernetes as common substrate across providers (EKS / GKE / Talos-k3s) |
| G-3 | Crossplane Compositions `XPostgres`, `XBucket`, `XQueue` compile per-cloud label |
| G-4 | Cloud Native Buildpacks / Paketo for image builds — no Dockerfile authoring required |
| G-5 | OCI registry abstraction covering ECR, Artifact Registry, Harbor, and GHCR |
| G-6 | Secrets abstraction: Vault/OpenBao + External Secrets Operator + SOPS/age |
| G-7 | OpenTelemetry OTLP export to any backend — provider agnostic |
| G-8 | FOCUS-format billing exports wired to PRD-023 cost dashboard |
| G-9 | Configuration wizard guides cloud setup end-to-end (PRD-024) |
| G-10 | Document portability-as-optionality; prohibit active multi-cloud in core workflows |

## 3. Non-Goals

| ID | Non-Goal |
|----|----------|
| NG-1 | This is not an IaC tool — IaC is owned by PRD-014 |
| NG-2 | Not a Kubernetes distribution or cluster lifecycle manager |
| NG-3 | Not a secrets vault product — Vault/OpenBao are external dependencies |
| NG-4 | Not replacing cloud-native managed services (RDS, Cloud SQL, Pub/Sub, etc.) |
| NG-5 | Azure support is deferred to Phase 3 as an opt-in adapter |
| NG-6 | Not prescribing a service mesh — that is left to user choice |

## 4. Personas

- **Platform Operator** — owns cloud accounts, cluster configuration, and cost governance.
- **Cloud Architect** — designs the cloud topology and approves Crossplane Compositions.
- **DevOps / SRE** — runs day-two operations, rotates credentials, monitors cost.
- **On-Prem Admin** — manages bare-metal or private-cloud infrastructure with Talos + k3s.
- **Security Reviewer** — audits credential flows, secret access patterns, and SPIFFE identity.

## 5. User Stories

| ID | Story | Priority |
|----|-------|----------|
| US-01 | As a Platform Operator, I run `config wizard --section cloud` and select AWS, GCP, or on-prem interactively | P0 |
| US-02 | As a Platform Operator, the wizard validates my credentials via `aws sso login` or `gcloud auth login` without storing plaintext | P0 |
| US-03 | As a DevOps engineer, I create an `XPostgres` resource and the agent provisions RDS, Cloud SQL, or Postgres-on-k3s depending on the active provider | P0 |
| US-04 | As an On-Prem Admin, running `autonomous-dev cloud configure --provider onprem` sets Talos + k3s + MinIO + Redpanda as defaults | P1 |
| US-05 | As a Security Reviewer, workload secrets are sourced from Vault via ESO — never from env vars baked into images | P0 |
| US-06 | As an SRE, OpenTelemetry traces from all adapters flow to my chosen backend without reconfiguration | P0 |
| US-07 | As a Cloud Architect, I view per-provider cost breakdowns in the PRD-023 dashboard sourced from FOCUS exports | P1 |
| US-08 | As a Platform Operator, I deploy the same service definition to both AWS staging and GCP production using the same Crossplane Composition | P1 |
| US-09 | As an On-Prem Admin, I install autonomous-dev in an air-gapped datacenter using a mirrored artifact bundle | P1 |
| US-10 | As a Security Reviewer, credential rotation for IRSA and Workload Identity is transparent to running workloads | P0 |
| US-11 | As a Platform Operator, I swap the container registry from ECR to Harbor with zero downtime using `cloud switch registry` | P1 |
| US-12 | As a Security Reviewer, all workloads automatically receive SPIFFE SVIDs from the SPIRE server on cluster | P1 |
| US-13 | As a Cloud Architect, every Crossplane-managed resource surfaces as a Backstage catalog entity | P2 |
| US-14 | As a DevOps engineer, every IaC pull request includes an Infracost diff comment before merge | P0 |
| US-15 | As a Security Reviewer, I can find documented BeyondCorp / zero-trust network access patterns for on-prem workloads | P1 |
| US-16 | As a Platform Operator, `autonomous-dev cloud switch <provider>` is safe, idempotent, and non-destructive | P0 |

## 6. Functional Requirements

### 6.1 CloudProvider Interface (FR-100s)

**FR-100** Define the `CloudProvider` contract with the following operations: `provision(resource, spec)`, `destroy(resource)`, `get-credential(target)`, `list-resources(filter)`, and `health-check()`. All adapters must implement the full contract.

**FR-101** Ship three concrete adapters in Phase 2: `aws`, `gcp`, and `onprem`. Each adapter is a separate module with no cross-adapter dependencies.

**FR-102** Active provider is selected via `cloud.provider = aws | gcp | onprem` in the project configuration file. Changing this value and re-running the wizard is the complete switching mechanism.

**FR-103** Multi-account and multi-project support via a `cloud.accounts` list. Each entry carries a label, provider type, and credential reference. Agent workflows reference accounts by label, not by account ID.

### 6.2 AWS Adapter (FR-200s)

**FR-200** Phase 2 supported services: EKS, ECS Fargate, Lambda, API Gateway, RDS, Aurora DSQL, DynamoDB, S3, CloudFront, Route53, MSK, Kinesis, SQS, SNS, EventBridge, Cognito, Secrets Manager, CloudWatch, and X-Ray.

**FR-201** Human identity via IAM Identity Center (AWS SSO). Workload identity via IRSA (IAM Roles for Service Accounts). No long-lived IAM user keys permitted.

**FR-202** Credential bootstrap via `aws sso login`. The adapter reads the SSO session token from the AWS SDK credential chain. No tokens are stored or logged by autonomous-dev.

### 6.3 GCP Adapter (FR-300s)

**FR-300** Phase 2 supported services: GKE (Standard + Autopilot), Cloud Run, Cloud Functions (2nd gen), API Gateway, Cloud SQL, AlloyDB, Spanner, BigQuery, GCS, Cloud CDN, Managed Kafka, Pub/Sub, Identity Platform, Secret Manager, Cloud Logging, and Cloud Trace.

**FR-301** Workload identity via Workload Identity Federation — no service account key files. Short-lived tokens issued per-request.

**FR-302** Credential bootstrap via `gcloud auth login --update-adc`. The adapter reads Application Default Credentials from the standard GCP SDK path.

### 6.4 On-Prem Adapter (FR-400s)

**FR-400** Default cluster runtime: Talos Linux. Supported alternatives: k3s standalone, MicroK8s, OpenShift, and Rancher. Wizard presents options and documents trade-offs.

**FR-401** MinIO deployed as the S3-compatible object store. All agents that consume `XBucket` receive MinIO endpoints on on-prem. No code change required.

**FR-402** Redpanda deployed as the Kafka-compatible streaming layer. All agents that consume `XQueue` receive Redpanda bootstrap servers. Known parity gaps with Kafka are documented in the test matrix.

**FR-403** Harbor deployed as the OCI-compatible container registry. Trivy scanner integrated for image scanning on push.

**FR-404** HashiCorp Vault + Consul + Nomad are available as optional add-ons. The wizard offers a guided install path for each.

**FR-405** Outbound-only connectivity via Tailscale or Cloudflare Tunnel. No inbound firewall rules required. Documented for air-gapped and NAT-restricted environments.

### 6.5 Crossplane Compositions (FR-500s)

**FR-500** Define the following XRDs (Composite Resource Definitions): `XPostgres`, `XBucket`, `XQueue`, `XCache`, and `XSearch`. Each XRD specifies a provider-agnostic schema.

**FR-501** Compositions are labelled by provider (`provider: aws | gcp | onprem`). Crossplane selects the correct Composition at runtime based on the cluster label. No agent logic required.

**FR-502** Agent workflows create XR (Composite Resource) objects only — never cloud-provider-specific managed resources directly. This is enforced via OPA policy in Phase 2.

### 6.6 Buildpacks and OCI (FR-600s)

**FR-600** Cloud Native Buildpacks (CNB) with Paketo buildpacks are the default build path. `pack build` replaces manual Dockerfile authoring for all supported language stacks.

**FR-601** All produced images are OCI image-spec compliant and include SBOM layers generated by Syft.

**FR-602** Images are signed at push time using Sigstore cosign with keyless signing via OIDC. Verification policy enforced via Kyverno.

**FR-603** Registry adapters: ECR (AWS), Artifact Registry (GCP), Harbor (on-prem), and GHCR (fallback / CI). Switching registries updates only the `cloud.registry` config key.

### 6.7 Secrets Abstraction (FR-700s)

**FR-700** HashiCorp Vault or OpenBao (the open-source fork) is the default secrets backend. The adapter supports both via the same Vault API.

**FR-701** External Secrets Operator (ESO) syncs secrets from Vault into Kubernetes `Secret` objects. Workloads consume secrets as mounted volumes or environment variables — they do not talk to Vault directly.

**FR-702** SOPS + age handles secrets committed to git repositories. The wizard generates age keys, stores the private key in Vault, and configures `.sops.yaml` automatically.

**FR-703** Doppler and 1Password CLI are supported for developer-local secret access. The adapter wraps their CLIs and presents the same interface as Vault.

**FR-704** The wizard never requests plaintext secrets. All credential flows delegate to `gh auth login`, `gcloud auth login`, or `aws sso login`. The adapter reads tokens from the respective SDK credential chains.

### 6.8 Identity and Authentication (FR-800s)

**FR-800** OIDC for human authentication across all providers. The wizard configures the identity provider (IAM Identity Center, Google Identity, or Keycloak on-prem).

**FR-801** SPIFFE SVIDs issued to all workloads by a SPIRE server running on the cluster. SVIDs rotate automatically and are transparent to workloads via the SPIFFE Workload API.

**FR-802** SCIM 2.0 for automated user and group provisioning from the organization's identity provider.

**FR-803** BeyondCorp / zero-trust access patterns documented for on-prem deployments using Tailscale ACLs or Cloudflare Access.

### 6.9 Observability Hooks (FR-900s)

**FR-900** Every adapter emits OpenTelemetry spans, metrics, and logs via OTLP. No adapter uses a vendor-specific SDK directly.

**FR-901** W3C Trace Context (`traceparent` / `tracestate`) propagated across all inter-service calls made by the adapters.

**FR-902** Backend configuration (Jaeger, Tempo, Google Cloud Trace, AWS X-Ray, Datadog, etc.) is deferred entirely to PRD-021 — this PRD only mandates OTLP emission.

### 6.10 CLI Commands (FR-1000s)

**FR-1000** The following `autonomous-dev cloud` subcommands are shipped in Phase 2:

- `cloud configure` — interactive wizard for provider setup
- `cloud list-providers` — list registered providers and their health status
- `cloud validate` — run credential and connectivity checks against the active provider
- `cloud switch <provider>` — safely transition the active provider label; dry-run by default
- `cloud rotate-credentials` — trigger credential refresh for all workload identities

## 7. Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NFR-01 | Provider switch requires zero code changes in agent workflows or IaC templates |
| NFR-02 | Wizard validates credentials and connectivity in under 10 seconds |
| NFR-03 | On-prem installation supports full air-gapped operation with a mirrored artifact bundle |
| NFR-04 | Adapter parity test suite achieves 80% coverage across all common operations per provider |
| NFR-05 | OCI builds are reproducible — same source input produces byte-for-byte identical image layers |
| NFR-06 | No secret value is written to any log, span attribute, or metric label at any verbosity level |
| NFR-07 | FOCUS billing exports are refreshed at least once every 24 hours |
| NFR-08 | OTLP is the default and only required observability export format |
| NFR-09 | The operator CLI is portable across macOS (Apple Silicon + Intel) and Linux (amd64 + arm64) |
| NFR-10 | The core `CloudProvider` interface has no static import of any AWS or GCP SDK |

## 8. Architecture

```
Agent Workflow / IaC Pull Request
            │
            ▼
  CloudProvider Interface
            │
    ┌───────┼───────┐
    ▼       ▼       ▼
  aws     gcp   onprem
 adapter adapter adapter
    │       │       │
    └───────┴───────┘
            │
            ▼
  Kubernetes API Server
  (EKS / GKE Autopilot / Talos-k3s)
            │
            ▼
  Crossplane Compositions
  (XPostgres / XBucket / XQueue / XCache / XSearch)
            │
            ▼
  Cloud-Native Managed Resources
  (RDS / Cloud SQL / MinIO / etc.)

Cross-Cutting Concerns (all adapters):
  ┌─────────────────────────────────────────┐
  │  Secrets      Vault / OpenBao + ESO     │
  │  Registry     OCI (ECR / AR / Harbor)   │
  │  Observability OTel OTLP                │
  │  Identity      OIDC (humans) +          │
  │                SPIFFE SVIDs (workloads) │
  │  Cost          FOCUS exports → PRD-023  │
  └─────────────────────────────────────────┘
```

**Design invariants:**

1. Agents never reference a cloud provider by name in workflow logic. They reference abstract resource types (`XPostgres`, `XBucket`) and let Crossplane resolve the cloud target.
2. All secrets flow through ESO. Workloads never call Vault directly.
3. The `cloud.provider` config key is the single source of truth for active provider. Changing it and running `cloud validate` is the complete switch procedure.
4. OTLP is emitted regardless of whether a backend is configured. Spans are dropped if no collector is reachable — never cause a build failure.

## 9. Testing Strategy

**Adapter parity tests:** A shared test suite runs against all three adapters. Each test invokes the `CloudProvider` interface and asserts provider-agnostic behavior. Tests are skipped (not failed) when cloud credentials are unavailable in CI.

**Smoke provision tests:** Per-cloud end-to-end tests provision an `XPostgres` instance, write a row, read it back, and destroy the resource. Run nightly against staging accounts.

**On-prem air-gap test:** A Talos VM with no outbound internet access. The full install bundle is loaded from a local mirror. Test asserts that `cloud validate` passes with zero external DNS queries.

**Crossplane Composition render test:** Unit test that renders each Composition against a set of XR inputs and asserts the output managed resources match the expected cloud-specific spec. No cloud credentials required.

**Credential flow test:** Integration test that runs the wizard in mock mode and asserts that no token or secret value appears in logs, span attributes, environment variables baked into images, or Kubernetes `ConfigMap` objects.

**Policy-as-code test:** OPA policies assert that no agent-generated resource manifest references a cloud-specific managed resource type directly (must go through XRD).

## 10. Migration and Rollout

**Phase 1 (Weeks 1–4):**
- Define and stabilize the `CloudProvider` interface and plugin contract.
- Ship GCP adapter and on-prem adapter (Talos + k3s + MinIO + Redpanda).
- Integrate Cloud Native Buildpacks / Paketo; deprecate Dockerfile-based builds.
- Deploy Vault / OpenBao + ESO + SOPS/age secret management stack.
- Wire OTLP emission to all existing adapters.

**Phase 2 (Weeks 5–8):**
- Ship AWS adapter with full FR-200 service coverage.
- Define and deploy all five Crossplane XRDs and per-cloud Compositions.
- Wire FOCUS billing exports to PRD-023 cost dashboard.
- Complete credential flow automation (`aws sso login`, `gcloud auth login`, IRSA, WIF).
- Publish adapter parity test suite; enforce 80% pass rate in CI.

**Phase 3 (Weeks 9–12):**
- Azure adapter as opt-in (separate plugin module).
- Service mesh guidance documentation (Istio / Linkerd / Cilium trade-offs).
- Tailscale and Cloudflare Tunnel documented for on-prem zero-trust connectivity.
- SPIFFE SPIRE production hardening and rotation automation.
- Backstage catalog integration for Crossplane-managed resources (US-13).

## 11. Risks

| ID | Risk | Mitigation |
|----|------|------------|
| R-1 | Cloud provider API drift breaks adapter compatibility | Maintain an adapter version matrix; pin SDK versions; run nightly compatibility tests |
| R-2 | Crossplane learning curve slows Platform Operator adoption | Ship golden-path Composition templates with annotated examples for each XRD |
| R-3 | On-prem hardware diversity causes Talos install failures | Talos + k3s is the supported golden path; document OpenShift/Rancher as community paths |
| R-4 | Air-gap install edges (missing OCI layers, DNS) surface late | Automate air-gap fixture mirror in CI; test weekly against a Talos VM with iptables drop |
| R-5 | IAM least-privilege policies are difficult to maintain | Publish example IAM policies per service; provide `cloud validate --permissions` dry-run |
| R-6 | Secrets bootstrap chicken-and-egg (Vault needs secrets to bootstrap) | Wizard generates a one-time bootstrap token flow; documented in runbook |
| R-7 | FOCUS adoption lag — some cloud providers produce incomplete exports | Implement provider-side fallback cost parsers; flag incomplete data in the dashboard |
| R-8 | Runaway costs from automated provision in staging | PRD-023 budget gate blocks provision above threshold; default gate is $50/day |
| R-9 | Pressure to support active multi-cloud from stakeholders | Document portability-as-optionality explicitly; active multi-cloud explicitly out of scope |
| R-10 | OCI registry quota exhaustion under heavy CI | Registry garbage collection policy shipped with Harbor and ECR lifecycle rules |
| R-11 | Redpanda vs Apache Kafka parity gaps affect on-prem workloads | Publish a parity test matrix; mark unsupported features with a compatibility warning |
| R-12 | Azure Phase 3 scope creep pulled into Phase 1 | Azure is a separate plugin module; interface boundary enforced in PR review |

## 12. Success Metrics

| Metric | Target |
|--------|--------|
| Time-to-first-deploy on a new cloud provider | Less than 30 minutes from `cloud configure` to running workload |
| Adapter parity test pass rate | 80% or higher across all three adapters |
| Secret leak incidents | Zero — enforced by credential flow test in CI |
| Air-gap install on Talos VM | Passes with no external network access |
| Agent workflow changes required on provider switch | Zero — switch is config-only |
| Infracost diff coverage | 100% of IaC pull requests include a cost diff comment |
| FOCUS export freshness | Less than 24 hours old at all times |

## 13. Open Questions

| ID | Question | Current Lean |
|----|----------|-------------|
| OQ-1 | Should Azure be Phase 1 or Phase 3? | Phase 3 — scope control |
| OQ-2 | Default registry: Harbor for all providers, or per-cloud native (ECR/AR)? | Per-cloud native in Phase 2; Harbor on-prem only |
| OQ-3 | Primary on-prem stack: Talos + k3s or OpenShift? | Talos + k3s as golden path |
| OQ-4 | Composition runtime: Crossplane or terranetes? | Crossplane — larger community, CNCF sandbox |
| OQ-5 | Should service mesh opinions live in this PRD or a dedicated PRD? | Dedicated PRD or ADR |
| OQ-6 | What is the right credential refresh cadence for long-running agent sessions? | Align with cloud provider session maximums (1h IRSA, 12h WIF) |

## 14. References

**Related PRDs:** PRD-014 (IaC), PRD-016, PRD-017, PRD-021 (Observability), PRD-022, PRD-023 (Cost), PRD-024 (Config Wizard).

**External references:**

- Talos Linux: https://www.talos.dev
- Crossplane: https://www.crossplane.io
- Cloud Native Buildpacks: https://buildpacks.io
- OCI Image Spec: https://opencontainers.org
- External Secrets Operator: https://external-secrets.io
- SOPS: https://getsops.io
- SPIFFE / SPIRE: https://spiffe.io
- FinOps FOCUS: https://focus.finops.org
- GKE: https://cloud.google.com/products/gke
- Amazon EKS: https://aws.amazon.com/eks/
- Redpanda: https://www.redpanda.com

---

**END PRD-015**
