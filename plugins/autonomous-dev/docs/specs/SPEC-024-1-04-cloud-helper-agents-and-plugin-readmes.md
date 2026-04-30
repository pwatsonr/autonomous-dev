# SPEC-024-1-04: Cloud-Specific Helper Agents + Plugin READMEs

## Metadata
- **Parent Plan**: PLAN-024-1
- **Tasks Covered**: Task 6 (cloud-specific helper agents), Task 9 (plugin-specific README.md)
- **Estimated effort**: 8 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-024-1-04-cloud-helper-agents-and-plugin-readmes.md`

## Description
Author the operator-facing docs and read-only reviewer agents for the four cloud plugins scaffolded by SPEC-024-1-01 and implemented by SPEC-024-1-02 / SPEC-024-1-03. Each plugin gets:
1. A read-only Claude Code helper agent (`{aws,gcp,azure,k8s}-deploy-expert.md`) the daemon can consult during deploy planning. The agents have ONLY `Read`, `Glob`, `Grep` tools — they cannot edit files or shell out, and they pass the agent-meta-reviewer (PLAN-017-2).
2. A plugin `README.md` documenting prerequisites, a working `deploy.yaml` example, and at least 5 troubleshooting entries.

This spec produces no runtime code and no tests beyond the agent-meta-reviewer pass. The READMEs and agent prompts are the deliverable.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-deploy-gcp/agents/gcp-deploy-expert.md` | Create | Read-only reviewer agent |
| `plugins/autonomous-dev-deploy-gcp/README.md` | Create | Prereqs, config example, troubleshooting |
| `plugins/autonomous-dev-deploy-aws/agents/aws-deploy-expert.md` | Create | Read-only reviewer agent |
| `plugins/autonomous-dev-deploy-aws/README.md` | Create | Prereqs, config example, troubleshooting |
| `plugins/autonomous-dev-deploy-azure/agents/azure-deploy-expert.md` | Create | Read-only reviewer agent |
| `plugins/autonomous-dev-deploy-azure/README.md` | Create | Prereqs, config example, troubleshooting |
| `plugins/autonomous-dev-deploy-k8s/agents/k8s-deploy-expert.md` | Create | Read-only reviewer agent |
| `plugins/autonomous-dev-deploy-k8s/README.md` | Create | Prereqs, config example, troubleshooting |
| `tests/agents/cloud-deploy-experts.test.ts` | Create | Runs agent-meta-reviewer over each agent file |

## Implementation Details

### Agent file shape (frontmatter + prompt)

Each agent uses the standard Claude Code agent frontmatter (per PLAN-017-2 conventions):

```md
---
name: <gcp|aws|azure|k8s>-deploy-expert
description: Read-only reviewer for <cloud> deployment configurations. Consult before deploy to surface IAM, networking, scaling, and cost concerns.
tools:
  - Read
  - Glob
  - Grep
---

You are a deployment-best-practices reviewer for <cloud>. You operate read-only ...
```

Constraints (enforced by agent-meta-reviewer):
- `tools` is exactly `[Read, Glob, Grep]` — no `Bash`, `Edit`, `Write`, no MCP tools.
- `description` is one sentence, present-tense, ≤ 200 chars.
- `name` is kebab-case and matches the filename (without `.md`).
- The body MUST NOT instruct the agent to write files or invoke shell commands.

### Per-agent prompt content

Each prompt is structured into 4 sections:

1. **Role & boundaries**: explicit "you are read-only", "consult deploy.yaml and supporting files", "produce a markdown review".
2. **Cloud-specific concerns checklist**: a numbered list the agent walks through. Different per cloud (see below).
3. **Output contract**: the agent emits a markdown report with `## Findings` (Critical/High/Medium/Low) and `## Recommendations`. The deploy daemon can parse the headings.
4. **Anti-patterns to flag**: a list of red flags specific to the cloud.

#### `gcp-deploy-expert.md` checklist (excerpt)

```
1. **IAM & Service Accounts**
   - Is the service account used by Cloud Run scoped to least-privilege roles
     (e.g., `roles/run.invoker`, NOT `roles/owner`)?
   - Does the deploy.yaml's `project_id` match the credential proxy's allowed projects?
2. **Cloud Run service config**
   - `cpu` <= 4 vCPU and `memory_mib` between 128 and 32768 (matches PARAM_SCHEMA).
   - `health_path` configured (defaults to `/health` but operators should explicitly set).
   - `min_instances` consideration (cold-start vs cost).
3. **Cloud Build pipeline**
   - Build steps don't pull from public registries without verification (supply chain).
   - Build timeout >= worst-case build duration.
4. **Region selection**
   - Region in `regions_supported` list (manifest, SPEC-024-1-01).
   - Region matches application data-residency requirements.
5. **Cost & quotas**
   - Cloud Run concurrency setting; over-provisioning warning.
   - Cloud Build's per-build minutes vs project quota.
```

Anti-patterns flagged:
- `--allow-unauthenticated` set when the service handles non-public traffic.
- Hard-coded `latest` tag (deploy uses `ctx.commitSha`, but operators may override).
- No `health_path` configured; `healthCheck` will fall back to root `/`.

#### `aws-deploy-expert.md` checklist (excerpt)

```
1. **IAM least-privilege**
   - ECS task role separated from execution role.
   - ECR repo policy restricts `PutImage` to the build proxy's STS principal.
2. **ECS service config**
   - `desired_count` >= 2 for HA; warn at 1.
   - `health_check_grace_period_seconds` set generously for slow-start apps.
   - Deployment circuit breaker enabled (`enable: true`, `rollback: true`).
3. **ALB target group**
   - `target_group_arn` matches the cluster's VPC.
   - Target group health-check path matches the container's actual health endpoint.
4. **ECR**
   - Image scanning on push enabled (recommend in deploy.yaml comment).
   - Lifecycle policy retains <= N untagged images.
5. **Networking**
   - Security group restricts inbound to ALB's SG only.
   - Subnets are private; only ALB lives in public subnets.
6. **Cost**
   - Fargate vs Fargate Spot tradeoff documented in operator's notes.
```

Anti-patterns flagged:
- `desired_count: 1` without an explicit "intentional single-instance" comment.
- Container `essential: false` with no companion essential container.
- Task role with `*:*` permissions.

#### `azure-deploy-expert.md` checklist (excerpt)

```
1. **Managed Identity**
   - Container App uses a user-assigned MI (NOT system-assigned, for portability).
   - MI has only `AcrPull` on the configured ACR + minimum Key Vault permissions.
2. **Container App revision config**
   - `revision_mode: Multiple` (required for traffic-swap rollback per SPEC-024-1-03).
   - Min/max replicas configured for autoscale.
3. **ACR**
   - Admin user disabled; access via MI only.
   - Geo-replication if multi-region (warn if `regions_supported` lists multiple but ACR is single-region).
4. **Front Door**
   - WAF policy attached.
   - Health probe path matches container's health endpoint.
5. **Cost**
   - Container Apps consumption vs dedicated plan tradeoff.
```

#### `k8s-deploy-expert.md` checklist (excerpt)

```
1. **Namespace scoping**
   - All manifests' `metadata.namespace` matches the deploy.yaml `namespace` parameter
     (otherwise SPEC-024-1-03's deploy will reject).
   - No cluster-scoped kinds in the manifest (`ClusterRole`, `Namespace`, etc.).
2. **Deployment config**
   - `revisionHistoryLimit >= 2` (required for `rollback` to find a previous revision).
   - Resource requests AND limits set on all containers.
   - Liveness AND readiness probes configured.
3. **Image references**
   - Image tagged with a digest or commit SHA (NOT `:latest`).
   - `imagePullPolicy: IfNotPresent` (matches autonomous-dev's deterministic-image policy).
   - `imagePullSecrets` references a Secret in the same namespace.
4. **Pod Security**
   - `runAsNonRoot: true`.
   - `readOnlyRootFilesystem: true` where feasible.
   - No `privileged: true` containers.
5. **OPA Gatekeeper / policy compatibility**
   - If cluster runs OPA, manifest aligns with declared constraints.
   - Common rejected fields: `hostNetwork`, `hostPID`, missing labels, no resource limits.
```

### `deploy.yaml` examples (per plugin README)

Each README ships a working `deploy.yaml` snippet sized to the cloud's required parameters.

GCP example (in `plugins/autonomous-dev-deploy-gcp/README.md`):

```yaml
backend: gcp
environment: prod
parameters:
  project_id: my-gcp-project
  region: us-central1
  service_name: api
  image_repo: api
  cpu: "1"
  memory_mib: 512
  health_path: /healthz
  health_timeout_seconds: 120
```

AWS example:

```yaml
backend: aws
environment: prod
parameters:
  account_id: "123456789012"
  region: us-east-1
  cluster_name: prod-cluster
  service_name: api
  ecr_repo: api
  task_family: api-task
  target_group_arn: arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/api-tg/abc123
  desired_count: 2
  health_timeout_seconds: 180
```

Azure example:

```yaml
backend: azure
environment: prod
parameters:
  subscription_id: 11111111-2222-3333-4444-555555555555
  resource_group: prod-rg
  location: eastus
  acr_name: prodacr
  container_app_name: api
  image_repo: api
  cpu: "0.5"
  memory_gib: "1.0"
  front_door_endpoint: https://api.azurefd.net
  health_path: /health
```

K8s example:

```yaml
backend: k8s
environment: prod
parameters:
  namespace: api-prod
  manifest_path: ./k8s/api-deployment.yaml
  deployment_name: api
  context_name: prod-cluster
  ready_timeout_seconds: 180
```

### README structure (identical sections across all 4 plugins)

1. **Overview** — One paragraph: what this backend does and which cloud service it targets.
2. **Prerequisites** — Cloud-specific list:
   - GCP: GCP project; Cloud Build API enabled; Cloud Run API enabled; service account configured for the credential proxy (PLAN-024-2).
   - AWS: AWS account; ECR repository created; ECS cluster + service; ALB + target group; IAM role for the credential proxy.
   - Azure: Subscription; resource group; ACR; Container Apps environment; user-assigned Managed Identity; (optional) Front Door endpoint.
   - K8s: Cluster reachable from the autonomous-dev daemon; ServiceAccount with namespace-scoped RBAC; (optional) image-pull Secret.
3. **Install** — `claude plugin install autonomous-dev-deploy-<cloud>`; verify with `deploy backends list` (must show `<cloud>` row).
4. **Configuration** — Table of every parameter (matches `PARAM_SCHEMA` from SPEC-024-1-02 / SPEC-024-1-03), its type, default, allowed values.
5. **Configuration example** — The `deploy.yaml` snippet above.
6. **Helper agent** — One paragraph: "consult `<cloud>-deploy-expert` agent before deploy via `claude agent <cloud>-deploy-expert ...`".
7. **Troubleshooting** — At minimum 5 entries per plugin. Each entry: symptom (first line), cause (one paragraph), resolution (numbered steps). Examples below.
8. **Release-time manual smoke checklist** — For Azure, an explicit checklist (no CI emulator). For GCP/AWS/K8s, a one-line note that CI integration tests cover this.

### Required troubleshooting entries (per plugin, minimum 5)

GCP:
- `PERMISSION_DENIED on Cloud Build createBuild` → check service-account roles.
- `Cloud Run revision stuck in PENDING` → check container exit code via Cloud Logging.
- `health probe times out` → confirm container actually listens on `$PORT`.
- `rollback fails: previous revision deleted` → check Cloud Run's revision retention setting.
- `image pull failed` → ensure Cloud Run SA has `roles/artifactregistry.reader`.

AWS:
- `AccessDeniedException: ECR PutImage` → confirm STS principal has the repo policy entry.
- `service stuck deploying` → describe the service; look for `(reason RESOURCE:NETWORK_INTERFACE)`.
- `target health: unhealthy` → ALB health-check path must return 200.
- `task fails with image pull` → confirm execution role has ECR pull permissions.
- `circuit breaker trips, no rollback` → confirm `enable: true` AND `rollback: true` in deployment config.

Azure:
- `ManagedIdentity not authorized for ACR` → assign `AcrPull` role.
- `Container App revision status: Failed` → check `properties.runningStatus.runningStatusDetails`.
- `Front Door 502` → check origin's host header binding.
- `revision swap takes >5 min` → Container Apps' traffic update is async; verify `latestReadyRevisionName`.
- `rollback fails: previous revision not Active` → confirm `revision_mode: Multiple`.

K8s:
- `Forbidden on Apply` → ServiceAccount lacks Role/RoleBinding for the resource.
- `OPA admission webhook denied` → review Gatekeeper constraint, adjust manifest.
- `Deployment never becomes Ready` → describe Pods; look at events for ImagePull / OOMKilled.
- `rollout undo: no previous revision` → set `revisionHistoryLimit >= 2`.
- `manifest rejected: namespace mismatch` → set `metadata.namespace` to match deploy.yaml.

Each README is ≤ 250 lines (cloud-specific docs may be longer than the 200-line guideline used by other specs).

### `tests/agents/cloud-deploy-experts.test.ts`

```ts
import { runAgentMetaReviewer } from '../../src/agents/meta-reviewer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AGENTS = [
  { plugin: 'autonomous-dev-deploy-gcp', name: 'gcp-deploy-expert' },
  { plugin: 'autonomous-dev-deploy-aws', name: 'aws-deploy-expert' },
  { plugin: 'autonomous-dev-deploy-azure', name: 'azure-deploy-expert' },
  { plugin: 'autonomous-dev-deploy-k8s', name: 'k8s-deploy-expert' },
] as const;

describe.each(AGENTS)('agent meta-review: $name', ({ plugin, name }) => {
  const path = join('plugins', plugin, 'agents', `${name}.md`);
  const content = readFileSync(path, 'utf8');
  test('passes meta-reviewer (read-only tools)', async () => {
    const result = await runAgentMetaReviewer(content);
    expect(result.passed).toBe(true);
    expect(result.findings.filter(f => f.severity === 'critical')).toEqual([]);
  });
  test('frontmatter declares only Read, Glob, Grep tools', () => {
    expect(content).toMatch(/tools:\s*\n\s*- Read\s*\n\s*- Glob\s*\n\s*- Grep/);
  });
  test('frontmatter name matches filename', () => {
    expect(content).toMatch(new RegExp(`^name:\\s*${name}\\s*$`, 'm'));
  });
});
```

## Acceptance Criteria

- [ ] All four agent files exist at `plugins/autonomous-dev-deploy-<cloud>/agents/<cloud>-deploy-expert.md`.
- [ ] Each agent's frontmatter `tools` field is exactly `[Read, Glob, Grep]` (verified by regex test).
- [ ] Each agent's frontmatter `name` matches the filename without `.md`.
- [ ] Each agent's `description` is a single sentence, ≤ 200 chars.
- [ ] Each agent's prompt body contains the 4 standard sections: Role & boundaries, Cloud-specific concerns checklist, Output contract, Anti-patterns to flag.
- [ ] Each agent's checklist enumerates the cloud-specific items documented above (verified by manual review; presence of the section heading is automated).
- [ ] `runAgentMetaReviewer` (from PLAN-017-2) returns `passed: true` for each agent file with zero critical findings.
- [ ] Agent prompts contain NO instruction to write files or invoke shell commands (verified by grep: agent files do not contain `Bash`, `Edit`, `Write`, `execFile`, or `child_process`).
- [ ] All four `README.md` files exist at `plugins/autonomous-dev-deploy-<cloud>/README.md`.
- [ ] Each README contains all 8 sections (Overview, Prerequisites, Install, Configuration, Configuration example, Helper agent, Troubleshooting, Release-time manual smoke checklist) in the documented order, using `##` (h2) headings.
- [ ] Each README's Configuration table covers EVERY parameter from the corresponding plugin's `PARAM_SCHEMA` (per SPEC-024-1-02 / SPEC-024-1-03).
- [ ] Each README's Configuration example is syntactically valid YAML (verified by `yaml.load(...)` in a test).
- [ ] Each README's Troubleshooting section has at least 5 entries, each with symptom + cause + resolution.
- [ ] Each README is ≤ 250 lines.
- [ ] Each README's Install section references the canonical `claude plugin install autonomous-dev-deploy-<cloud>` command and confirms the backend appears in `deploy backends list`.
- [ ] The Azure README's release-time manual smoke checklist contains at least 4 numbered steps (build, deploy, healthcheck, rollback) executed against a real Azure subscription.
- [ ] `tests/agents/cloud-deploy-experts.test.ts` passes for all four agents and runs in under 5 seconds.
- [ ] Documentation reviewer (manual, captured in PR review) confirms accuracy of cloud-specific terminology in each README.

## Dependencies

- **PLAN-017-2** (existing on main): `runAgentMetaReviewer` for read-only tool enforcement. This spec consumes the function.
- **SPEC-024-1-01**: plugin directories exist; `agents/.gitkeep` placeholders are replaced by these agent files.
- **SPEC-024-1-02 / SPEC-024-1-03**: `PARAM_SCHEMA` exports drive each README's Configuration table. Agent prompts reference the schemas conceptually (no compile-time link).
- `js-yaml` (already added by SPEC-024-1-03 to the K8s plugin) — the test for "config example is valid YAML" uses it; the test runs at the repo root and imports the version from any plugin's `node_modules/`. Alternatively, the test imports from the autonomous-dev base plugin which already vendors `js-yaml`.

## Notes
- The helper agents are NOT part of the deploy phase itself (per PLAN-024-1's task 6 description). The daemon consults them when an operator asks for guidance via `claude agent <cloud>-deploy-expert`. They are pure-advisory.
- The agent prompt structure (Role & boundaries → Checklist → Output contract → Anti-patterns) mirrors PLAN-017-2's reviewer-agent template. Drift from this structure will be caught by `runAgentMetaReviewer`.
- README troubleshooting entries were drawn from real-world cloud-deployment failure modes documented in TDD-024 §11 and the PLAN-024-1 risk register. The 5-per-cloud minimum is the floor; operators are encouraged to extend each plugin's README via PRs as new failure modes surface.
- Each README's Configuration example is a runnable `deploy.yaml` for that backend. Operators copy-paste, substitute their values, and run `deploy plan --env prod --backend <cloud>`. The selector wiring (PLAN-023-2) is unchanged by this spec.
- The cross-cloud comparison table referenced in PLAN-024-1's Definition of Done lives in the autonomous-dev base plugin's docs (not in any single cloud plugin's README) and is delivered by a separate operator-doc spec outside PLAN-024-1's scope.
- Helper-agent-prompt drift over time is tracked by PLAN-024-1's risk register (annual review). Each agent's review date is captured in the agent file's footer (`<!-- last reviewed: YYYY-MM-DD -->`) so reviewers can spot stale prompts.
