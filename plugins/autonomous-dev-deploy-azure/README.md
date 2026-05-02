# autonomous-dev-deploy-azure

## Overview

This plugin adds an `azure` deployment backend to `autonomous-dev`, targeting Azure Container Registry (image build) and Azure Container Apps (revision deploy + traffic-swap rollback). An optional Front Door endpoint is probed for health. It registers as `BackendCapability: 'azure-container-apps'` and works with the credential-proxy delivered by PLAN-024-2.

## Prerequisites

- An Azure subscription. Note the subscription UUID.
- A resource group in the target location.
- An Azure Container Registry (ACR) in the same subscription.
- A Container Apps Environment + a Container App.
- A user-assigned Managed Identity assigned to the Container App with `AcrPull` on the configured ACR.
- (Optional) A Front Door endpoint in front of the Container App's ingress.
- Location must be one of the supported set in this plugin's `plugin.json` `regions_supported` array.

## Install

```
claude plugin install autonomous-dev-deploy-azure
```

Verify the install:

```
deploy backends list
```

The output must include a row for `azure` with `supportedTargets: azure-container-apps`.

## Configuration

| Parameter | Type | Required | Default | Allowed values |
|-----------|------|----------|---------|----------------|
| `subscription_id` | string | yes | — | UUID (`8-4-4-4-12` lowercase hex) |
| `resource_group` | string | yes | — | identifier |
| `location` | enum | yes | — | one of `AZURE_LOCATIONS` (e.g., `eastus`) |
| `acr_name` | string | yes | — | identifier |
| `container_app_name` | string | yes | — | identifier |
| `image_repo` | string | yes | — | shell-safe arg |
| `cpu` | string | no | `"0.5"` | decimal (`/^\d+(\.\d+)?$/`) |
| `memory_gib` | string | no | `"1.0"` | decimal |
| `front_door_endpoint` | string | no | — | shell-safe arg (full URL) |
| `health_path` | string | no | `/health` | shell-safe arg |
| `health_timeout_seconds` | number | no | `180` | 10 .. 600 |

## Configuration example

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

## Helper agent

This plugin ships a read-only reviewer agent (`azure-deploy-expert`) the daemon can consult before deploy. Run it manually with:

```
claude agent azure-deploy-expert --input deploy.yaml
```

The agent walks a Managed-Identity / Container-App / ACR / Front-Door / cost checklist and emits a markdown report. It cannot modify files or shell out.

## Troubleshooting

### `ManagedIdentity not authorized for ACR`

**Cause**: the Container App's user-assigned Managed Identity is missing the `AcrPull` role assignment on the configured ACR.

**Resolution**:
1. Look up the MI principal ID: `az identity show -g <resource_group> -n <mi_name> --query principalId`.
2. Look up the ACR resource ID: `az acr show -n <acr_name> --query id`.
3. Assign the role: `az role assignment create --role AcrPull --assignee <principal_id> --scope <acr_resource_id>`.
4. Re-deploy; the new revision pulls successfully.

### `Container App revision status: Failed`

**Cause**: the new revision failed startup. The detail is in `runningStatusDetails`.

**Resolution**:
1. Inspect `az containerapp revision show -n <container_app_name> -g <resource_group> --revision <revision> --query 'properties.runningStatus' -o json`.
2. Check `runningStatusDetails` for the failure reason (image pull, probe failure, OOM).
3. Address the root cause (probe path, memory tier, env vars).
4. Re-deploy; the failed revision is automatically deactivated.

### `Front Door 502`

**Cause**: Front Door's origin host header binding does not match the Container App's ingress FQDN, or origin probes are failing.

**Resolution**:
1. Inspect Front Door origin: `az afd origin show --profile-name <fd_profile> --origin-group-name <og> --origin-name <origin>`.
2. Confirm `hostName` matches the Container App's `properties.configuration.ingress.fqdn`.
3. Confirm Front Door's health probe path matches `health_path`.
4. Re-issue traffic; 502 should clear within ~5 minutes (Front Door's probe cadence).

### `revision swap takes >5 min`

**Cause**: Container Apps' traffic update is asynchronous; a long swap usually means the new revision hasn't reached `latestReadyRevisionName` yet.

**Resolution**:
1. Watch `az containerapp show -n <container_app_name> -g <resource_group> --query 'properties.latestReadyRevisionName'`.
2. Confirm the deploying revision is reachable on its `<app>--<revision>.<env>.azurecontainerapps.io` URL.
3. If startup is genuinely slow, raise `health_timeout_seconds` and re-deploy.
4. If Container Apps is degraded, surface in Azure Status; manual rollback may be needed.

### `rollback fails: previous revision not Active`

**Cause**: the Container App is in `revision_mode: Single`, so the previous revision was deactivated as soon as the new revision became ready, leaving no rollback target.

**Resolution**:
1. Inspect `az containerapp show ... --query 'properties.configuration.activeRevisionsMode'`.
2. If `Single`, switch to `Multiple`: `az containerapp update ... --revisions-mode multiple`.
3. Re-test rollback by deploying twice and triggering rollback against the second deploy.
4. Document the change in `deploy.yaml` so future operators inherit `Multiple` mode.

## Release-time manual smoke checklist

There is no Azure emulator with Container Apps coverage. Each minor-version bump MUST execute this 4-step manual smoke against a real Azure subscription. Steps are documented in detail at `tests/integration/azure-release-checklist.md` (delivered by SPEC-024-1-05). Summary:

1. **Build**: run `AzureBackend.build` against the real subscription. Confirm an ACR run completes and the image tag matches the commit SHA.
2. **Deploy**: run `AzureBackend.deploy`. Confirm the new revision appears in `az containerapp revision list` and traffic routes to it.
3. **HealthCheck**: confirm the Front Door endpoint (or Container App ingress FQDN) returns 200 within `health_timeout_seconds`.
4. **Rollback**: run `AzureBackend.rollback`. Confirm traffic swaps back to the previous revision and the healthcheck passes.

Operators should record results in the release ticket and deactivate test revisions afterwards to keep the subscription clean.
