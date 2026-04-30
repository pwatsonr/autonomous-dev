# SPEC-023-1-03: Bundled Backends — `docker-local` and `github-pages`

## Metadata
- **Parent Plan**: PLAN-023-1
- **Tasks Covered**: Task 6 (`docker-local` backend), Task 7 (`github-pages` backend)
- **Estimated effort**: 7 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-023-1-03-bundled-backends-docker-local-and-github-pages.md`

## Description
Implement the two stateful bundled backends from TDD-023 §6: `docker-local` (builds an OCI image, runs a container with port mapping, captures the container ID) and `github-pages` (pushes the build artifact to a `gh-pages` branch via `git subtree push` or `gh api`). Both backends conform to the `DeploymentBackend` interface from SPEC-023-1-01, share the `runTool` and `artifact-store` helpers introduced in SPEC-023-1-02, validate all parameters before invoking external commands, and produce HMAC-signed `DeploymentRecord`s.

These two backends carry meaningful runtime state (a container that must be stopped, a remote branch that must be reverted) and therefore have stricter rollback semantics than `local`/`static`. The risk register in PLAN-023-1 specifically calls out container-leak and `--force-with-lease` race scenarios; the implementations below address each.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/deploy/backends/docker-local.ts` | Create | `DockerLocalBackend implements DeploymentBackend` |
| `plugins/autonomous-dev/src/deploy/backends/github-pages.ts` | Create | `GithubPagesBackend implements DeploymentBackend` |

## Implementation Details

### `src/deploy/backends/docker-local.ts`

`DockerLocalBackend implements DeploymentBackend`.

- `metadata`: `{ name: 'docker-local', version: '0.1.0', supportedTargets: ['localhost-docker'], capabilities: ['localhost-docker'], requiredTools: ['docker'] }`.
- Parameter schema (validated before `deploy`):
  - `image_name` — `string`, required, `format: 'identifier'` (lowercase, `[a-z0-9_-]+`), max 64 chars; full image tag becomes `<image_name>:<commitSha[0..12]>`.
  - `dockerfile_path` — `string`, default `Dockerfile`, `format: 'path'` (relative to `repoPath`).
  - `host_port` — `number`, required, `range: [1024, 65535]`.
  - `container_port` — `number`, required, `range: [1, 65535]`.
  - `health_path` — `string`, default `/`, `format: 'path'`.
  - `health_timeout_seconds` — `number`, default `30`, `range: [1, 300]`.
  - `extra_run_args` — `string[]`, default `[]`. Each entry validated as `format: 'shell-safe-arg'`.
- `build(ctx)`:
  - Tag = `${image_name}:${ctx.commitSha.slice(0, 12)}`.
  - Runs `runTool('docker', ['build', '-t', tag, '-f', dockerfile_path, '.'], { cwd: ctx.repoPath, timeoutMs: 1_200_000 })`.
  - Resolves the image ID via `runTool('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'])`.
  - Returns a `BuildArtifact` of `type: 'docker-image'`, `location: <tag>`, `metadata: { image_id, image_size }`. Persisted via `artifact-store.writeArtifact`.
- `deploy(artifact, env, params)`:
  - Args = `['run', '-d', '--name', `${image_name}-${ctx.requestId}`, '-p', `${host_port}:${container_port}`, ...extra_run_args, artifact.location]`.
  - Runs `runTool('docker', args, { cwd: ctx.repoPath })`. Stdout is the container ID.
  - Builds + signs a `DeploymentRecord` with `details: { container_id, image_tag: artifact.location, host_port, container_port }`.
- `healthCheck(record)`:
  - Polls `http://127.0.0.1:<host_port><health_path>` (GET, 5s per attempt) at 1-second intervals until 2xx or `health_timeout_seconds` elapses.
  - Returns `healthy: true` on first 2xx; otherwise `healthy: false` with `unhealthyReason: 'health-timeout'`.
  - Also runs `docker inspect --format '{{.State.Status}}'` and includes a `container-running` check.
- `rollback(record)`:
  - Idempotent. Step 1: `runTool('docker', ['stop', container_id])` — ignore "no such container" errors.
  - Step 2: `runTool('docker', ['rm', container_id])` — ignore not-found.
  - Step 3: locate previous `DeploymentRecord` for the same backend+environment; if present, re-deploy by running `docker run -d` with its image tag (reusing the same `host_port`).
  - Returns `{ success: true, restoredArtifactId, errors }`. If a step fails after step 1 succeeded, returns `{ success: false, errors: [...] }` but DOES NOT raise — leaks are logged so the operator can `docker container prune`.

### `src/deploy/backends/github-pages.ts`

`GithubPagesBackend implements DeploymentBackend`.

- `metadata`: `{ name: 'github-pages', version: '0.1.0', supportedTargets: ['github-pages'], capabilities: ['github-pages'], requiredTools: ['git', 'gh'] }`.
- Parameter schema:
  - `build_command` — `string`, default `npm run build`, `format: 'shell-safe-arg'`. Split on whitespace.
  - `build_dir` — `string`, default `dist`, `format: 'path'` (relative to `repoPath`).
  - `pages_branch` — `string`, default `gh-pages`, `format: 'identifier'`.
  - `pages_url` — `string`, optional, `format: 'url'`.
  - `allow_force_rollback` — `boolean`, default `false`. When `false`, rollback aborts if `pages_branch` HEAD has moved since the deploy recorded its sha.
- `build(ctx)`:
  - Splits `build_command` and runs via `runTool` (`shell: false`, `timeoutMs: 600_000`).
  - Verifies `<repoPath>/<build_dir>` exists; computes a SHA-256 over a deterministic file manifest.
  - Returns a `BuildArtifact` of `type: 'directory'`, persisted via `artifact-store.writeArtifact`.
- `deploy(artifact, env, params)`:
  - Captures pre-deploy `pages_branch` HEAD sha via `git ls-remote origin <pages_branch>` (may be empty for first deploy).
  - Pushes via `git subtree push --prefix <build_dir> origin <pages_branch>`. If subtree fails because the branch already diverged, fall back to a temporary worktree: clone shallowly, copy `build_dir` over, commit, push (force is NOT used in the deploy direction).
  - Builds + signs a `DeploymentRecord` with `details: { pages_branch, previous_sha, new_sha, pages_url }`.
- `healthCheck(record)`:
  - When `pages_url` was provided, fetches it (GET, 10s timeout). Returns `healthy: status === 200`.
  - When omitted, returns `healthy: true` with a `checks[]` entry `no-pages-url-configured`.
- `rollback(record)`:
  - Reads `details.previous_sha`. If empty, returns `{ success: false, errors: ['no previous sha to restore'] }`.
  - Reads current `pages_branch` HEAD via `git ls-remote`. If it does NOT match `details.new_sha` (i.e., a subsequent deploy raced), and `allow_force_rollback` is `false`, returns `{ success: false, errors: ['gh-pages HEAD moved since deploy; rerun with allow_force_rollback=true to override'] }`.
  - Performs `git push --force-with-lease=<pages_branch>:<details.new_sha> origin <details.previous_sha>:<pages_branch>`. The `--force-with-lease` ref-spec ensures we only force when the branch is exactly where we left it.
  - Returns `{ success: true, restoredArtifactId, errors: [] }`.

## Acceptance Criteria

- [ ] `DockerLocalBackend.metadata.name === 'docker-local'` and `requiredTools === ['docker']`.
- [ ] `DockerLocalBackend.build()` invokes `docker build -t <name>:<sha12> -f <dockerfile_path> .` (verified by spying on `runTool` in tests).
- [ ] `DockerLocalBackend.build()` returns an artifact whose `metadata.image_id` matches the value mocked from `docker image inspect`.
- [ ] `DockerLocalBackend.deploy()` invokes `docker run -d --name <name>-<requestId> -p <host>:<container> <tag>`; the captured `container_id` is stored in the record's `details`.
- [ ] `DockerLocalBackend.deploy()` rejects `host_port: 80` (range violation, surfaced by `validateParameters`).
- [ ] `DockerLocalBackend.deploy()` rejects `image_name: 'My-IMAGE'` (uppercase, fails `format: 'identifier'`).
- [ ] `DockerLocalBackend.deploy()` rejects an `extra_run_args` entry containing `;`, `|`, `$`, or backtick.
- [ ] `DockerLocalBackend.healthCheck()` polls until 2xx or timeout; on 2xx returns `healthy: true`; on timeout returns `healthy: false` with `unhealthyReason: 'health-timeout'`.
- [ ] `DockerLocalBackend.rollback()` is idempotent — calling it twice on the same record does not raise; the second call succeeds with no errors when the container is already gone.
- [ ] `DockerLocalBackend.rollback()` re-deploys the previous record's image when one exists; `restoredArtifactId` matches that record's artifact.
- [ ] `GithubPagesBackend.metadata.name === 'github-pages'` and `supportedTargets === ['github-pages']`.
- [ ] `GithubPagesBackend.build()` rejects `pages_branch: 'gh pages'` (whitespace fails `format: 'identifier'`).
- [ ] `GithubPagesBackend.deploy()` records `previous_sha` (string, may be empty) and `new_sha` in the signed record's `details`.
- [ ] `GithubPagesBackend.deploy()` does NOT use `--force` in the deploy direction; verified by asserting no `runTool` call to `git push` includes `--force` or `--force-with-lease` during deploy.
- [ ] `GithubPagesBackend.rollback()` with `allow_force_rollback: false` returns `{ success: false, errors: [containing 'HEAD moved'] }` when the remote sha differs from `details.new_sha`.
- [ ] `GithubPagesBackend.rollback()` with `allow_force_rollback: true` invokes `git push --force-with-lease=<branch>:<details.new_sha> origin <details.previous_sha>:<branch>`.
- [ ] `GithubPagesBackend.healthCheck()` returns `healthy: true` on 200 from `pages_url`; `false` on 500.
- [ ] Both backends produce signed records that pass `verifyDeploymentRecord` (SPEC-023-1-01).
- [ ] All external commands run via `runTool` (`execFile`, `shell: false`) — verified by spying.

## Dependencies

- SPEC-023-1-01: `DeploymentBackend`, supporting types, `validateParameters`, `signDeploymentRecord`.
- SPEC-023-1-02: `runTool` (`src/deploy/exec.ts`), `artifact-store` (`src/deploy/artifact-store.ts`).
- External tools: `docker` (for `docker-local`), `git` and `gh` (for `github-pages`). Availability gating happens in SPEC-023-1-04's `BackendRegistry`.
- Node built-ins only: `fetch`, `fs/promises`, `child_process.execFile`.

## Notes

- `docker-local` uses `--name <image_name>-<requestId>` rather than letting Docker auto-name the container so that rollback can find it without parsing `docker ps` output. The requestId guarantees uniqueness across simultaneous deploys.
- The `health_timeout_seconds` parameter exists because container startup time varies wildly — a Rails app may take 20s, a static nginx container 100ms. The default of 30s is conservative; operators dial it.
- `docker rm` failures during rollback are logged but do not fail the rollback — the goal is to free the port for a re-deploy, and a stopped-but-not-removed container does not bind the port.
- `github-pages` uses `git subtree push` first because it is the lowest-friction path for `dist/`-shaped artifacts. The fallback to a worktree-based push covers cases where subtree's history-rewriting fights with prior deploys.
- `--force-with-lease` ref-spec is the safety mechanism for the rollback race scenario in PLAN-023-1's risk register: if another deploy raced between our `ls-remote` and our `push`, the ref-spec mismatch will reject the push and we will not lose work.
- Neither backend supports rolling forward to a NEW commit during rollback — rollback only restores a previously deployed artifact. Forward rolls are a deploy, not a rollback.
- Both backends export a `PARAM_SCHEMA` constant (consumed by SPEC-023-1-04's `deploy backends describe` CLI) that exactly matches the schema passed to `validateParameters`; this is the single source of truth for parameter documentation.
