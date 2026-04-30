# SPEC-023-1-02: Bundled Backends — `local` and `static`

## Metadata
- **Parent Plan**: PLAN-023-1
- **Tasks Covered**: Task 4 (`local` backend), Task 5 (`static` backend)
- **Estimated effort**: 7 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-023-1-02-bundled-backends-local-and-static.md`

## Description
Implement the two simplest bundled deployment backends defined in TDD-023 §6 against the `DeploymentBackend` interface from SPEC-023-1-01: `local` (commits a feature branch and opens a GitHub PR) and `static` (runs a configured build command, then rsyncs the artifact to a local path or remote SSH target). Both backends produce HMAC-signed `DeploymentRecord`s via the helpers from SPEC-023-1-01, validate all parameters with `validateParameters`, and invoke external tooling exclusively through `execFile` (no shell interpolation).

The `local` backend supersedes the existing deploy "stub" — after this spec, the deploy phase has at least one functional backend. The `static` backend exercises the artifact-storage + rsync paths that future cloud backends (TDD-024) will share.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/deploy/backends/local.ts` | Create | `LocalBackend implements DeploymentBackend` |
| `plugins/autonomous-dev/src/deploy/backends/static.ts` | Create | `StaticBackend implements DeploymentBackend` |
| `plugins/autonomous-dev/src/deploy/artifact-store.ts` | Create | `<request>/.autonomous-dev/builds/<artifactId>/` + `checksum.sha256` |
| `plugins/autonomous-dev/src/deploy/exec.ts` | Create | `runTool(cmd, args, { cwd, timeout })` thin wrapper around `execFile` |

## Implementation Details

### Shared: `src/deploy/exec.ts`

A 1-purpose helper used by every backend. It MUST refuse a `cmd` containing path separators ambiguity unless absolute, set `shell: false`, enforce a default 60-second timeout, and reject on non-zero exit with stdout+stderr included in the error message.

```ts
export interface RunToolOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;          // default 60_000
  maxBufferBytes?: number;     // default 10 * 1024 * 1024
}
export interface RunToolResult { stdout: string; stderr: string; }
export async function runTool(cmd: string, args: string[], opts: RunToolOptions): Promise<RunToolResult>;
```

### Shared: `src/deploy/artifact-store.ts`

Persists artifact metadata and a SHA-256 checksum so future operations (rollback, audit) can verify integrity.

```
<request>/.autonomous-dev/builds/<artifactId>/
  ├── manifest.json     # BuildArtifact serialized
  └── checksum.sha256   # canonical sha256 of manifest.json
```

Functions: `writeArtifact(repoPath, artifact)`, `readArtifact(repoPath, artifactId)`, `verifyArtifactChecksum(repoPath, artifactId)`. Each function uses two-phase commit (write to `.tmp`, fsync, rename) consistent with existing PLAN-002-1 patterns.

### `src/deploy/backends/local.ts`

`LocalBackend implements DeploymentBackend`.

- `metadata`: `{ name: 'local', version: '0.1.0', supportedTargets: ['github-pr'], capabilities: ['github-pr'], requiredTools: ['git', 'gh'] }`.
- Parameter schema (validated before `deploy`):
  - `pr_title` — `string`, required, `format: 'shell-safe-arg'`, max 200 chars.
  - `pr_body` — `string`, required, max 8000 chars (no shell-safe restriction; passed via `--body-file` written to a temp file).
  - `base_branch` — `string`, default `main`, `format: 'identifier'` (allow `[A-Za-z0-9._/\-]+`).
- `build(ctx)`:
  - Returns a `BuildArtifact` of type `commit` whose `location` is `ctx.commitSha`. No actual build runs.
  - `checksum` = sha256 of `ctx.commitSha + ctx.branch + ctx.requestId`.
  - Persists via `artifact-store.writeArtifact`.
- `deploy(artifact, env, params)`:
  - Asserts the worktree is clean (`git status --porcelain` returns empty); aborts if not.
  - Runs `git push origin <ctx.branch>` via `runTool('git', ['push', 'origin', branch], ...)`.
  - Writes `pr_body` to a temp file (mode 0600, deleted in `finally`).
  - Runs `gh pr create --title <pr_title> --body-file <tmpfile> --base <base_branch>` via `runTool`.
  - Captures the PR URL from stdout (regex `https://github\.com/[^\s]+/pull/\d+`).
  - Builds + signs a `DeploymentRecord` with `details: { pr_url, branch, base_branch }`.
- `healthCheck(record)`:
  - Runs `gh pr view <pr_url> --json state` and returns `healthy: state === 'OPEN'`.
- `rollback(record)`:
  - Runs `gh pr close <pr_url> --comment "Rolled back by autonomous-dev deployId=<deployId>"`.
  - Returns `{ success: true, errors: [] }` on close success; otherwise captures the error.

### `src/deploy/backends/static.ts`

`StaticBackend implements DeploymentBackend`.

- `metadata`: `{ name: 'static', version: '0.1.0', supportedTargets: ['local-fs', 'remote-rsync'], capabilities: ['local-fs', 'remote-rsync'], requiredTools: ['rsync'] }`. `npm` / build tool is treated as a soft requirement (validated when used).
- Parameter schema:
  - `build_command` — `string`, default `npm run build`, `format: 'shell-safe-arg'`. Split on whitespace into argv (no shell).
  - `build_dir` — `string`, default `dist`, `format: 'path'`, MUST be relative to `repoPath`.
  - `target` — `string`, required. Either an absolute local path (`format: 'path'`) OR `user@host:/abs/path` validated by a dedicated regex (`^[A-Za-z0-9._\-]+@[A-Za-z0-9.\-]+:/[A-Za-z0-9._/\-]+$`).
  - `health_url` — `string`, optional, `format: 'url'`.
  - `ssh_key_path` — `string`, optional (used only with remote target), `format: 'path'`.
- `build(ctx)`:
  - Splits `build_command` into `[cmd, ...args]`.
  - Runs `runTool(cmd, args, { cwd: ctx.repoPath, timeoutMs: 600_000 })`.
  - Verifies `<repoPath>/<build_dir>` exists; computes a SHA-256 over a deterministic file-list manifest of the directory.
  - Returns a `BuildArtifact` of `type: 'directory'`, `location: <build_dir>`, `sizeBytes` summed via `fs.stat`, persisted via `artifact-store.writeArtifact`.
- `deploy(artifact, env, params)`:
  - Builds rsync args: `['-az', '--delete', `${repoPath}/${build_dir}/`, target]`. When `ssh_key_path` is present and target is remote, prepends `['-e', `ssh -i ${ssh_key_path} -o StrictHostKeyChecking=accept-new`]`.
  - Runs `runTool('rsync', args, { cwd: repoPath, timeoutMs: 300_000 })`.
  - Builds + signs a `DeploymentRecord` with `details: { target, build_dir, files_synced: <count> }`.
- `healthCheck(record)`:
  - When `health_url` was provided, fetches it (GET, 5s timeout) and reports `healthy` iff status 200..299.
  - When omitted, returns `healthy: true` with a check named `no-health-url-configured`.
- `rollback(record)`:
  - Locates the previous `DeploymentRecord` for the same backend+environment via `<request>/.autonomous-dev/deployments/`.
  - Reads its artifact via `artifact-store.readArtifact` and rsyncs it back to the same target.
  - Returns `{ success, restoredArtifactId, errors }`.

## Acceptance Criteria

- [ ] `LocalBackend.metadata.name === 'local'` and `supportedTargets === ['github-pr']`.
- [ ] `LocalBackend.build()` returns an artifact whose `location` equals `ctx.commitSha` and whose checksum is reproducible across two calls with the same context.
- [ ] `LocalBackend.deploy()` invokes `gh pr create` (mocked) with `--body-file` pointing to a tempfile (verified by spying on `runTool`); the tempfile is removed even if `gh` rejects.
- [ ] `LocalBackend.deploy()` aborts BEFORE invoking `git push` when `git status --porcelain` returns non-empty output.
- [ ] `LocalBackend.deploy()` returns a `DeploymentRecord` whose `hmac` is non-empty and whose `details.pr_url` matches the PR URL emitted by mocked `gh`.
- [ ] `LocalBackend.healthCheck()` returns `healthy: true` when `gh pr view` reports `state: OPEN`, `healthy: false` when `MERGED` or `CLOSED`.
- [ ] `LocalBackend.rollback()` invokes `gh pr close <url> --comment <...>` with a comment containing the deployId; returns `{ success: true }` on exit code 0.
- [ ] `StaticBackend.metadata.supportedTargets` includes both `local-fs` and `remote-rsync`.
- [ ] `StaticBackend.build()` rejects a `build_command` containing `;` or `|` (parameter validation).
- [ ] `StaticBackend.build()` rejects a `build_dir` of `../escape`.
- [ ] `StaticBackend.build()` runs the build via `execFile` (no shell), verified by inspecting the spawn options in test (`shell: false`).
- [ ] `StaticBackend.deploy()` writes the rsynced contents to a temp directory in test and the file tree matches the source byte-for-byte.
- [ ] `StaticBackend.deploy()` with a remote `target` and `ssh_key_path` set passes `-e "ssh -i <key> -o StrictHostKeyChecking=accept-new"` to rsync.
- [ ] `StaticBackend.healthCheck()` with `health_url` returns `healthy: false` when the URL responds 500; returns `healthy: true` on 200.
- [ ] `StaticBackend.rollback()` restores the previous artifact's contents to the same target (verified by file equality after rollback in a test using two consecutive deploys).
- [ ] Both backends produce signed records that pass `verifyDeploymentRecord` (from SPEC-023-1-01).
- [ ] Artifact files land at `<repoPath>/.autonomous-dev/builds/<artifactId>/manifest.json` with a sibling `checksum.sha256` whose contents match `sha256(manifest.json)`.
- [ ] `runTool` rejects (does not throw) on non-zero exit; the rejection error message contains both `stdout` and `stderr`.

## Dependencies

- SPEC-023-1-01: imports `DeploymentBackend`, `BuildContext`, `DeployParameters`, `validateParameters`, `signDeploymentRecord` and supporting types.
- Node built-ins only: `child_process.execFile`, `fs/promises`, `crypto`, `os`, `path`, `fetch` (Node >= 20).
- External tools (must be on PATH at runtime): `git`, `gh`, `rsync`. `BackendRegistry` (SPEC-023-1-04) checks availability at startup.

## Notes

- Both backends are intentionally restricted to `execFile` so that even a parameter-validation bypass cannot produce shell injection. Defense in depth, per PLAN-023-1's risk register.
- `build_command` is split on whitespace, NOT through a shell. Operators who need pipelines should put them in a script file referenced by `build_command`.
- The `local` backend stores `pr_body` via `--body-file` rather than `--body` because `--body` interpolates through the shell-quoted argv when a body contains complex characters; the file path is shell-safe.
- `StaticBackend.healthCheck` deliberately reports `healthy: true` when no `health_url` is configured rather than `unknown`; the rationale is that the rsync exit code already gates success, and this keeps the Boolean simple. The `checks[]` entry makes the "no probe ran" fact discoverable.
- Rollback for `static` requires a previous deployment record; the FIRST deploy to an environment cannot be rolled back via this backend. This is documented for operators in PLAN-023-3's observability deliverables.
