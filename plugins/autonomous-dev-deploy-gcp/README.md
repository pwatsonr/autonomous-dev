# autonomous-dev-deploy-gcp

## Overview

This plugin adds a `gcp` deployment backend to `autonomous-dev`, targeting Google Cloud Build (image build) and Google Cloud Run (revision deploy + traffic routing). It registers as `BackendCapability: 'gcp-cloud-run'` and works with the credential-proxy delivered by PLAN-024-2.

## Prerequisites

- A GCP project. Note the `project_id` (alphanumeric + dashes).
- Cloud Build API enabled (`gcloud services enable cloudbuild.googleapis.com`).
- Cloud Run API enabled (`gcloud services enable run.googleapis.com`).
- Artifact Registry or Container Registry (gcr.io) configured. The default backend pushes to `gcr.io/<project_id>/<image_repo>:<commit_sha>`.
- A service account configured for the credential proxy (PLAN-024-2) with `roles/cloudbuild.builds.editor`, `roles/run.admin`, `roles/iam.serviceAccountUser`, and `roles/artifactregistry.reader` on the runtime service account.
- Region must be one of the supported set in this plugin's `plugin.json` `regions_supported` array.

## Install

```
claude plugin install autonomous-dev-deploy-gcp
```

Verify the install:

```
deploy backends list
```

The output must include a row for `gcp` with `supportedTargets: gcp-cloud-run`.

## Configuration

| Parameter | Type | Required | Default | Allowed values |
|-----------|------|----------|---------|----------------|
| `project_id` | string | yes | — | identifier (`[a-zA-Z][a-zA-Z0-9-]*`) |
| `region` | enum | yes | — | one of `GCP_REGIONS` (e.g., `us-central1`, `europe-west1`) |
| `service_name` | string | yes | — | identifier |
| `image_repo` | string | yes | — | shell-safe arg |
| `cpu` | string | no | `"1"` | decimal (`/^\d+(\.\d+)?$/`) |
| `memory_mib` | number | no | `512` | 128 .. 32768 |
| `health_path` | string | no | `/health` | shell-safe arg |
| `health_timeout_seconds` | number | no | `120` | 10 .. 600 |

## Configuration example

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

## Helper agent

This plugin ships a read-only reviewer agent (`gcp-deploy-expert`) the daemon can consult before deploy. Run it manually with:

```
claude agent gcp-deploy-expert --input deploy.yaml
```

The agent walks an IAM / Cloud Run / Cloud Build / region / cost checklist and emits a markdown report. It cannot modify files or shell out.

## Troubleshooting

### `PERMISSION_DENIED on Cloud Build createBuild`

**Cause**: the credential-proxy's service account lacks `roles/cloudbuild.builds.editor` (or `roles/cloudbuild.builds.builder`) on the project.

**Resolution**:
1. Confirm `gcloud projects get-iam-policy <project_id>` lists the SA with the build role.
2. If absent, the credential-proxy admin must add: `roles/cloudbuild.builds.editor`.
3. Re-run the build; the proxy fetches a fresh token containing the new role.

### `Cloud Run revision stuck in PENDING`

**Cause**: the container exited before signalling readiness (often a missing `PORT` env handling).

**Resolution**:
1. View Cloud Logging for the revision (`resource.type="cloud_run_revision"`).
2. Confirm the container actually listens on `process.env.PORT` (Cloud Run injects 8080 by default).
3. If the workload starts slowly, increase `health_timeout_seconds` in `deploy.yaml`.
4. Re-deploy; previous PENDING revisions are garbage-collected.

### `health probe times out`

**Cause**: container is up, but `/health` returns non-2xx, or never responds, before `health_timeout_seconds` elapses.

**Resolution**:
1. Confirm `health_path` matches the route your app actually serves.
2. Curl the service URL directly: the deployment record's `details.service_url` field contains the URL.
3. If the app starts >60s, raise `health_timeout_seconds` to >= 180.
4. For non-HTTP workloads, configure a TCP probe (currently out of scope for this backend; use a Cloud Run startup probe).

### `rollback fails: previous revision deleted`

**Cause**: Cloud Run deletes inactive revisions on the service's revision-retention policy.

**Resolution**:
1. Check `gcloud run revisions list --service=<service_name> --region=<region>`.
2. If the previous revision is missing, the service-level retention is too aggressive.
3. Set `gcloud run services update <service_name> --revision-suffix=` and configure retention >= 10 revisions on the service.
4. Future deploys preserve enough history for rollback.

### `image pull failed`

**Cause**: the runtime service account on Cloud Run lacks `roles/artifactregistry.reader` on the source repository.

**Resolution**:
1. Identify the runtime SA: `gcloud run services describe <service_name> --region <region> --format='value(spec.template.spec.serviceAccountName)'`.
2. Grant: `gcloud projects add-iam-policy-binding <project_id> --member='serviceAccount:<sa>' --role='roles/artifactregistry.reader'`.
3. Re-deploy; the new revision pulls successfully.

## Release-time manual smoke checklist

CI integration tests (`.github/workflows/cloud-integration.yml`) cover the GCP lifecycle against the Cloud Run emulator. No additional manual smoke is required at release time, but operators are encouraged to run a one-off `deploy plan --env staging --backend gcp --dry-run` before each minor-version bump.
