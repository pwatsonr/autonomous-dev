# autonomous-dev-deploy-k8s

## Overview

This plugin adds a `k8s` deployment backend to `autonomous-dev`, targeting Kubernetes via the typed `@kubernetes/client-node` API (no shell-out to `kubectl`). It applies a multi-doc YAML manifest into a single namespace, captures the previous revision before applying, polls the Deployment until ready, and rolls back via `Deployment` revision history. It registers as `BackendCapability: 'k8s-kubectl-apply'` and works with the credential-proxy delivered by PLAN-024-2.

## Prerequisites

- A Kubernetes cluster reachable from the autonomous-dev daemon (kubeconfig delivered by the credential proxy).
- A `ServiceAccount` with namespace-scoped RBAC (`Role` + `RoleBinding`) granting at minimum: `get/list/watch/create/update/patch` on `deployments`, `services`, `configmaps`, `secrets` (as needed by your manifest); `get` on `pods`; and `create` on `deployments/rollback`.
- (Optional) An image-pull `Secret` in the target namespace, referenced from the Deployment's `spec.template.spec.imagePullSecrets`.
- The image referenced from the manifest must already exist in a registry the cluster can reach (this backend does NOT build images; pair with `gcp` / `aws` / `azure` for build).

## Install

```
claude plugin install autonomous-dev-deploy-k8s
```

Verify the install:

```
deploy backends list
```

The output must include a row for `k8s` with `supportedTargets: k8s-kubectl-apply`.

## Configuration

| Parameter | Type | Required | Default | Allowed values |
|-----------|------|----------|---------|----------------|
| `namespace` | string | yes | — | identifier (must match every manifest doc's `metadata.namespace`) |
| `manifest_path` | string | yes | — | path (relative to repo root) |
| `deployment_name` | string | yes | — | identifier (the Deployment to track for readiness + rollback) |
| `context_name` | string | no | — | identifier (kubeconfig context override; defaults to current-context) |
| `ready_timeout_seconds` | number | no | `180` | 10 .. 600 |

## Configuration example

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

## Helper agent

This plugin ships a read-only reviewer agent (`k8s-deploy-expert`) the daemon can consult before deploy. Run it manually with:

```
claude agent k8s-deploy-expert --input deploy.yaml
```

The agent walks a namespace / Deployment-config / image / Pod-Security / OPA-policy checklist and emits a markdown report. It cannot modify files or shell out.

## Troubleshooting

### `Forbidden on Apply`

**Cause**: the credential-proxy-issued kubeconfig's ServiceAccount lacks RBAC for the resource being applied.

**Resolution**:
1. Read the failing API call's verb + resource from the error (e.g., `cannot create resource "deployments" in API group "apps"`).
2. Inspect the ServiceAccount's bindings: `kubectl get rolebinding -n <namespace> -o yaml | grep -A2 <sa_name>`.
3. Add the missing verb to an existing `Role` (or bind an additional `Role`).
4. Re-deploy; the proxy fetches a fresh kubeconfig carrying the new RBAC reachability.

### `OPA admission webhook denied`

**Cause**: a Gatekeeper `K8sPolicyConstraint` rejected the manifest. The deploy daemon surfaces the constraint's reject message as `DeployError { code: 'POLICY_VIOLATION' }`.

**Resolution**:
1. Read the error message; it cites the violated constraint name.
2. `kubectl get constraint <constraint_name> -o yaml` shows the constraint spec.
3. Adjust the manifest to satisfy the constraint (e.g., add resource limits, drop `hostNetwork`).
4. Re-deploy; the manifest passes admission.

### `Deployment never becomes Ready`

**Cause**: pods are crashlooping or unable to schedule. Common reasons: `ImagePullBackOff`, `OOMKilled`, missing `Secret` / `ConfigMap`.

**Resolution**:
1. `kubectl get pods -n <namespace> -l <selector>` to see pod status.
2. `kubectl describe pod <name> -n <namespace>` and inspect `Events:` at the bottom.
3. `kubectl logs <pod> -n <namespace> --previous` for crashed-container output.
4. Fix the root cause and re-deploy. Increase `ready_timeout_seconds` if the workload genuinely starts slowly.

### `rollout undo: no previous revision`

**Cause**: the Deployment's `revisionHistoryLimit` is `0` or `1`, so no prior revision exists to roll back to.

**Resolution**:
1. Inspect: `kubectl get deployment <deployment_name> -n <namespace> -o jsonpath='{.spec.revisionHistoryLimit}'`.
2. Update the manifest to set `revisionHistoryLimit: 10` (or higher; default in autonomous-dev recipes is 10).
3. Re-deploy; the next two deploys populate enough revision history for rollback.

### `manifest rejected: namespace mismatch`

**Cause**: a doc in the multi-doc YAML has `metadata.namespace` differing from the deploy.yaml `namespace` parameter. The K8s backend's manifest-scope check rejects this BEFORE applying anything (see `K8sScopeViolationError` / `validateManifestScope` in `manifest-applier.ts`).

**Resolution**:
1. The error message lists the offending kind + name.
2. Edit the manifest so every doc's `metadata.namespace` matches `<namespace>` from `deploy.yaml`.
3. Or, parametrise the manifest with `${NAMESPACE}` and have your build step substitute it.
4. Re-deploy; manifests now pass the scope check.

## Release-time manual smoke checklist

CI integration tests (`.github/workflows/cloud-integration.yml`) cover the K8s lifecycle against a `kind` cluster. No additional manual smoke is required at release time; operators may run `deploy plan --env staging --backend k8s --dry-run` before each minor-version bump to confirm the registry wiring.
