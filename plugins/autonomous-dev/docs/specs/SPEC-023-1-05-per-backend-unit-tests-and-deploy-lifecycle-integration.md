# SPEC-023-1-05: Per-Backend Unit Tests and Full Deploy-Lifecycle Integration Test

## Metadata
- **Parent Plan**: PLAN-023-1
- **Tasks Covered**: Task 11 (per-backend unit tests), Task 12 (full deploy-lifecycle integration test)
- **Estimated effort**: 7 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-023-1-05-per-backend-unit-tests-and-deploy-lifecycle-integration.md`

## Description
Add deep, backend-specific unit coverage on top of the conformance floor (SPEC-023-1-04) and prove end-to-end correctness with a real lifecycle integration test for the two side-effect-light backends (`local` and `static`). The conformance suite proves every backend HONORS the contract; these tests prove each backend's INTERNAL logic — error handling, edge cases, parameter rejection, and rollback restoration — is correct, and that the full `build → deploy → healthCheck → rollback` flow works against actual filesystem and git operations.

`docker-local` and `github-pages` are intentionally excluded from the integration suite due to environmental dependencies (Docker daemon, real GitHub repo) — they are exercised through deeply mocked unit tests here and through manual smoke tests documented in PLAN-023-3's operator guide.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/deploy/backends/local.test.ts` | Create | `LocalBackend` deep tests with mocked `gh` + `git` |
| `plugins/autonomous-dev/tests/deploy/backends/static.test.ts` | Create | `StaticBackend` deep tests with real temp-dir rsync |
| `plugins/autonomous-dev/tests/deploy/backends/docker-local.test.ts` | Create | `DockerLocalBackend` deep tests with mocked `docker` |
| `plugins/autonomous-dev/tests/deploy/backends/github-pages.test.ts` | Create | `GithubPagesBackend` deep tests with mocked `git` + `gh` |
| `plugins/autonomous-dev/tests/integration/test-deploy-lifecycle.test.ts` | Create | End-to-end lifecycle for `local` + `static` |
| `plugins/autonomous-dev/tests/deploy/__mocks__/run-tool.ts` | Create | Shared `runTool` mock with stubbed responses per command |

## Implementation Details

### Shared mock: `tests/deploy/__mocks__/run-tool.ts`

A spy-friendly replacement for `runTool` that lets each test register expected `(cmd, args)` patterns and returns canned `{ stdout, stderr }`. Unmatched invocations FAIL the test with a clear message naming the unmatched argv. Captures the full call list for assertions.

```ts
export function makeRunToolMock(): {
  runTool: typeof runTool;
  expect(cmdRegex: RegExp, argMatcher: (args: string[]) => boolean, response: { stdout?: string; stderr?: string; exitCode?: number }): void;
  calls(): { cmd: string; args: string[]; opts: RunToolOptions }[];
};
```

### `tests/deploy/backends/local.test.ts`

Deep `LocalBackend` coverage. Mocks `runTool`. Required cases:

- `build()` is pure (no `runTool` calls verified by `calls().length === 0`).
- `build()` checksum is deterministic for the same context, different for different commit shas.
- `deploy()` aborts BEFORE `git push` when `git status --porcelain` returns non-empty.
- `deploy()` writes `pr_body` to a temp file with mode `0600` and deletes it on success.
- `deploy()` deletes the `pr_body` temp file when `gh pr create` fails (tested with mocked exit code 1).
- `deploy()` parses the PR URL from mocked `gh` stdout (`https://github.com/o/r/pull/42`).
- `deploy()` rejects `pr_title` containing `;` via `validateParameters`.
- `healthCheck()` returns `healthy: true` when `gh pr view` returns `{"state":"OPEN"}`, `false` for `MERGED` and `CLOSED`.
- `rollback()` invokes `gh pr close <url> --comment <text containing deployId>` and returns `{ success: true }` on exit 0.
- `rollback()` returns `{ success: false, errors: [...] }` on `gh pr close` exit 1.

### `tests/deploy/backends/static.test.ts`

Uses a real OS temp directory as the rsync target so file-tree assertions are end-to-end (not mocked). Mocks the build command via `runTool` mock.

- `build()` rejects `build_command` with `;` or `|`.
- `build()` rejects `build_dir: '../escape'`.
- `build()` rejects when the build command exits non-zero.
- `build()` records `sizeBytes` matching `du -b` of the actual `dist/` content.
- `deploy()` to a local temp dir copies the file tree byte-for-byte (verified via SHA-256 over a sorted file manifest).
- `deploy()` to a remote target with `ssh_key_path` passes `-e "ssh -i <key> -o StrictHostKeyChecking=accept-new"` to rsync.
- `deploy()` propagates rsync's non-zero exit as a rejection.
- `healthCheck()` with `health_url` returns `false` when the URL responds 500 (use a tiny `http.createServer` test fixture).
- `healthCheck()` with `health_url` omitted returns `true` and emits a `no-health-url-configured` check.
- `rollback()` after a second deploy restores the first deploy's contents (verified by file equality).

### `tests/deploy/backends/docker-local.test.ts`

Mocks `runTool` for `docker` invocations. Uses the mock pattern matcher to assert exact argv shapes.

- `build()` invokes `docker build -t <image>:<sha12> -f <dockerfile> .` with `cwd: ctx.repoPath`.
- `build()` resolves `image_id` from mocked `docker image inspect` stdout.
- `deploy()` invokes `docker run -d --name <image>-<requestId> -p <host>:<container> <tag>`.
- `deploy()` rejects `host_port: 80` (range), `image_name: 'My-IMAGE'` (format), `extra_run_args` containing `;`.
- `healthCheck()` polls until 2xx; returns `{ healthy: true }` when first poll returns 200; returns `{ healthy: false, unhealthyReason: 'health-timeout' }` when all polls fail before timeout (use fake timers).
- `rollback()` is idempotent: invoking twice does not raise; second invocation succeeds with no errors when container is already gone.
- `rollback()` re-deploys the previous record's image when present and `restoredArtifactId` matches the previous record.

### `tests/deploy/backends/github-pages.test.ts`

Mocks `runTool` for `git` and `gh` invocations.

- `build()` rejects `pages_branch: 'gh pages'` (whitespace).
- `deploy()` records both `previous_sha` and `new_sha` in the signed record.
- `deploy()` does NOT pass `--force` or `--force-with-lease` to any `git push` (verified by inspecting all captured `runTool` calls).
- `deploy()` falls back to the worktree path when the mocked `git subtree push` exits non-zero with the diverged-history error pattern.
- `rollback()` with `allow_force_rollback: false` returns `{ success: false }` and an error containing `HEAD moved` when mocked `git ls-remote` reports a sha differing from `details.new_sha`.
- `rollback()` with `allow_force_rollback: true` invokes `git push --force-with-lease=<branch>:<details.new_sha> origin <details.previous_sha>:<branch>`.
- `healthCheck()` with `pages_url` returns `healthy: true` on 200, `false` on 500.

### `tests/integration/test-deploy-lifecycle.test.ts`

Exercises the full `build → deploy → healthCheck → rollback` flow for `local` and `static` against real filesystem state and a fixture git repo. `docker-local` and `github-pages` are skipped here.

Setup:
- Initialize a temp-dir git repo with two commits and a `dist/` directory.
- Stub the `gh` CLI via the `runTool` mock returning canned PR responses.
- For `static`, use a sibling temp directory as the rsync target.

Assertions per backend:
1. `build(ctx)` returns an artifact and `artifact-store.verifyArtifactChecksum` returns true.
2. `deploy(artifact, 'integration-test', validParams)` returns a record with non-empty `hmac` AND `verifyDeploymentRecord(record)` returns `{ valid: true }`.
3. The record file exists at `<repoPath>/.autonomous-dev/deployments/<deployId>.json` and round-trips through `JSON.parse` + `verifyDeploymentRecord`.
4. `healthCheck(record)` returns `{ healthy: true }` (mocked PR open / configured local health URL).
5. A second deploy followed by `rollback(secondRecord)` restores the first deploy's state (PR closed for `local`; file tree matches the first artifact for `static`).
6. The full lifecycle for both backends completes in under 30 seconds wall-clock.

## Acceptance Criteria

- [ ] All four per-backend test files exist under `tests/deploy/backends/` and pass.
- [ ] Coverage report shows ≥90% line coverage for each `src/deploy/backends/*.ts` file.
- [ ] All four per-backend test files combined complete in under 10 seconds wall-clock.
- [ ] No per-backend test depends on a real `gh`, `docker`, or remote `rsync` target — every external command is mocked via the `runTool` mock.
- [ ] `tests/deploy/backends/static.test.ts` performs at least one assertion against a REAL local temp directory (file-tree byte equality) — not all assertions are mocked.
- [ ] `tests/integration/test-deploy-lifecycle.test.ts` exercises BOTH `local` and `static` end-to-end and asserts a signed record round-trips through `verifyDeploymentRecord`.
- [ ] The integration test asserts the deployment record file lands at `<repoPath>/.autonomous-dev/deployments/<deployId>.json`.
- [ ] The integration test's rollback assertion proves state restoration (PR closed for `local`; file tree byte-equal to the first artifact for `static`).
- [ ] The integration test completes in under 30 seconds wall-clock.
- [ ] All tests pass on CI without requiring `docker`, `rsync` to a remote, or network access to GitHub.
- [ ] No flakiness across 10 consecutive runs of the integration suite (verified manually by the implementer; recorded in PR description).

## Dependencies

- SPEC-023-1-01: `verifyDeploymentRecord` and supporting types.
- SPEC-023-1-02: `LocalBackend`, `StaticBackend`, `runTool`, `artifact-store`.
- SPEC-023-1-03: `DockerLocalBackend`, `GithubPagesBackend`.
- SPEC-023-1-04: `BackendRegistry`, `registerBundledBackends`. Integration test calls `registerBundledBackends()` then `BackendRegistry.get(name)` to obtain instances.
- Test framework: existing project default (Jest/Vitest). No new test-runner dependency.
- `rsync` MUST be on PATH for the integration test's `static` path. CI installs it; documented in CI config.

## Notes

- The `runTool` mock pattern (in `tests/deploy/__mocks__/run-tool.ts`) is shared across all test files to keep the mocking idiom consistent. Each test registers patterns scoped to its own `describe` block via `beforeEach`.
- The integration test's deliberate exclusion of `docker-local` and `github-pages` is by design — they are stateful enough that automated end-to-end coverage requires a Docker daemon and a real GitHub repo. Their unit tests cover the logic exhaustively; PLAN-023-3 adds an opt-in `--with-docker` integration suite.
- Coverage threshold of ≥90% is enforced by the project's existing coverage tooling (e.g., `--coverage` thresholds in package.json). This spec assumes that infrastructure already exists; if it does not, the implementer adds the threshold check and notes it in the PR.
- The 30-second integration timeout is generous; expected wall-clock for the documented assertions on a developer laptop is ~5-8s. The slack absorbs CI variance.
- Per-backend tests purposely overlap with the conformance suite on shape assertions but go DEEPER on error paths and edge cases. Both layers are needed — conformance proves the contract, per-backend proves the internals.
- Future cloud backends (TDD-024) follow this pattern: a unit test file plus an opt-in integration test gated on cloud credentials.
