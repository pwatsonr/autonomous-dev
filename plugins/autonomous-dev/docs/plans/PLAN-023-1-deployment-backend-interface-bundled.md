# PLAN-023-1: DeploymentBackend Interface + Bundled Backends + Build Context + Deployment Record

## Metadata
- **Parent TDD**: TDD-023-deployment-backend-framework-core
- **Estimated effort**: 5 days
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P0

## Objective
Replace the autonomous-dev deploy phase's stub with a real pluggable framework: the `DeploymentBackend` TypeScript interface per TDD §5 (with `build()`, `deploy()`, `healthCheck()`, `rollback()` methods and supporting types), the four bundled backends per TDD §6 (`local`, `static`, `docker-local`, `github-pages`), the `BuildContext` and `DeployParameters` types per TDD §7 with server-side validated parameter contracts (preventing shell injection), and the HMAC-signed `DeploymentRecord` schema per TDD §8 used for rollback integrity. Multi-environment support, backend selection, trust integration, observability, and cost caps are layered in by sibling plans.

## Scope
### In Scope
- `DeploymentBackend` interface at `src/deploy/types.ts` per TDD §5: required methods `build(ctx): Promise<BuildArtifact>`, `deploy(artifact, env, params): Promise<DeploymentRecord>`, `healthCheck(record): Promise<HealthStatus>`, `rollback(record): Promise<RollbackResult>`, plus `metadata: BackendMetadata` (name, version, supportedTargets, capabilities)
- Supporting types: `BuildArtifact` (artifactId, type, location, checksum, sizeBytes, metadata), `DeploymentRecord` (deployId, backend, environment, artifactId, deployedAt, status, hmac), `HealthStatus` (healthy, checks[], unhealthyReason?), `RollbackResult` (success, restoredArtifactId?, errors[])
- `BuildContext` interface per TDD §7: `repoPath`, `commitSha`, `branch`, `requestId`, `cleanWorktree: bool`, `params: DeployParameters` (validated). Build is a pure function over context — no side effects on the repo.
- `DeployParameters` validation: each parameter has a declared type (string|number|boolean|enum) and validators (regex, range, allowlist). Server validates ALL params before invoking the backend; backends receive only validated, typed values. No shell metacharacters allowed in string params unless declared `format: shell-safe-arg`.
- `local` backend per TDD §6: commits the validated artifact to a feature branch, opens a PR via `gh pr create`. The simplest backend; current "stub" deploy upgraded to this.
- `static` backend: rsyncs the build artifact (typically `dist/` or `build/`) to a configured target path or remote (via SSH key)
- `docker-local` backend: runs `docker build` against the repo's `Dockerfile`, tags with `<repo>:<commitSha>`, runs `docker run -d` with port mapping, captures container ID in the deployment record
- `github-pages` backend: pushes the build artifact to a `gh-pages` branch (via `gh api` or git subtree), GitHub Pages serves
- Build artifact storage at `<request>/.autonomous-dev/builds/<artifactId>/` with `checksum.sha256`
- `DeploymentRecord` HMAC-signing per TDD §8: HMAC-SHA256 over canonical-JSON of all fields except `hmac`, signed with `DEPLOY_HMAC_KEY` (derived from env or auto-generated). Records are persisted at `<request>/.autonomous-dev/deployments/<deployId>.json`
- Conformance test suite per TDD §15: a single test file at `tests/deploy/conformance.test.ts` that runs the same battery of tests against each registered backend, validating they meet the interface contract (build returns valid artifact, deploy returns signed record, healthCheck returns valid status, rollback returns valid result)
- CLI `autonomous-dev deploy backends list` and `deploy backends describe <name>` for operator visibility
- Unit tests for: each backend's individual methods, parameter validation, HMAC signing, conformance suite

### Out of Scope
- Multi-environment configuration (dev/staging/prod) -- PLAN-023-2
- Backend selection algorithm -- PLAN-023-2
- Trust integration (per-env approval gates, cost caps) -- PLAN-023-2 + PLAN-023-3
- Health-check monitor (continuous polling, SLA tracking) -- PLAN-023-3
- Observability (per-deploy log directories, metrics) -- PLAN-023-3
- Cost cap enforcement -- PLAN-023-3
- Cloud backends (`gcp`, `aws`, `azure`, `k8s`) -- TDD-024 / PLAN-024-*
- Service mesh, infrastructure provisioning, CI/CD replacement (NG list in TDD §2)
- Auto-scaling, load-balancer configuration

## Tasks

1. **Author `DeploymentBackend` interface and supporting types** -- Create `src/deploy/types.ts` with all required interfaces from TDD §5: `DeploymentBackend`, `BackendMetadata`, `BuildArtifact`, `DeploymentRecord`, `HealthStatus`, `RollbackResult`. Strict TypeScript with no `any`.
   - Files to create: `plugins/autonomous-dev/src/deploy/types.ts`
   - Acceptance criteria: TypeScript compiles. JSDoc cross-references TDD §5. All four interface methods are required (not optional). `metadata.capabilities` is a typed enum.
   - Estimated effort: 2h

2. **Author parameter-validation framework** -- Create `src/deploy/parameters.ts` with `DeployParameters` shape and `validateParameters(schema, values)` function. Schema declares per-param type, validators (regex, min, max, enum, format). Returns `{valid, sanitized, errors[]}`. No shell metacharacters allowed in string values unless `format: shell-safe-arg`.
   - Files to create: `plugins/autonomous-dev/src/deploy/parameters.ts`
   - Acceptance criteria: `target_dir: '/var/www/site'` validates with `format: 'path'`. `target_dir: '/etc/passwd'` (path traversal attempt) fails. `port: 8080` validates with `range: [1024, 65535]`. `port: 80` fails. String containing `;` or `|` fails unless `format: 'shell-safe-arg'`. Tests cover each validator.
   - Estimated effort: 3h

3. **Author `BuildContext` type and HMAC-signed `DeploymentRecord`** -- Add `BuildContext` to `types.ts`. Implement `signDeploymentRecord(record, key)` and `verifyDeploymentRecord(record, key)` helpers in `src/deploy/record-signer.ts`. HMAC-SHA256 over canonical-JSON. `DEPLOY_HMAC_KEY` env var or auto-generated to `~/.autonomous-dev/deploy-key` (mode 0600).
   - Files to create: `plugins/autonomous-dev/src/deploy/record-signer.ts`
   - Acceptance criteria: Signed record has non-empty `hmac` field. Tampering with any field invalidates the HMAC. `verifyDeploymentRecord()` returns `{valid: bool}` and `Error` on mismatch. Auto-generated key has correct permissions. Tests cover sign + verify roundtrip and tamper detection.
   - Estimated effort: 3h

4. **Implement `local` backend** -- Create `src/deploy/backends/local.ts`. `build()` returns the current commit as the artifact (no actual build). `deploy()` invokes `git push origin <branch>` then `gh pr create --title "..." --body "..."`. `healthCheck()` returns healthy if PR exists. `rollback()` closes the PR.
   - Files to create: `plugins/autonomous-dev/src/deploy/backends/local.ts`
   - Acceptance criteria: Backend's metadata declares `name: 'local'`, `supportedTargets: ['github-pr']`. Deploy creates a PR (via `gh` CLI). HealthCheck returns healthy when PR is open. Rollback closes the PR with a comment. Tests use mocked `gh` invocations.
   - Estimated effort: 3h

5. **Implement `static` backend** -- Create `src/deploy/backends/static.ts`. `build()` runs `npm run build` (or configured build command) and produces an artifact pointing at `dist/`. `deploy()` rsyncs `dist/` to a configured target (local path or `user@host:/path` via SSH). `healthCheck()` curls a configured health URL. `rollback()` rsyncs the previous artifact back.
   - Files to create: `plugins/autonomous-dev/src/deploy/backends/static.ts`
   - Acceptance criteria: Backend's metadata: `name: 'static'`, `supportedTargets: ['local-fs', 'remote-rsync']`. Build runs the configured command via `execFile` (no shell). Deploy rsyncs to the target. Tests use a temp dir as the target and verify file contents.
   - Estimated effort: 4h

6. **Implement `docker-local` backend** -- Create `src/deploy/backends/docker-local.ts`. `build()` runs `docker build` and captures the image ID. `deploy()` runs `docker run -d -p <port>:<container-port>` with the image. `healthCheck()` curls `http://localhost:<port>/<healthPath>`. `rollback()` stops the new container and starts the previous one (if record exists).
   - Files to create: `plugins/autonomous-dev/src/deploy/backends/docker-local.ts`
   - Acceptance criteria: Backend metadata: `name: 'docker-local'`, `supportedTargets: ['localhost-docker']`. Build creates an image tagged `<repo>:<sha>`. Deploy starts a container; container ID is stored in record. HealthCheck succeeds when the configured endpoint returns 200. Rollback stops the new container. Tests use Docker test-containers.
   - Estimated effort: 4h

7. **Implement `github-pages` backend** -- Create `src/deploy/backends/github-pages.ts`. `build()` runs the configured build command. `deploy()` pushes the artifact to a `gh-pages` branch via `git subtree push` or equivalent. `healthCheck()` curls the GitHub Pages URL. `rollback()` reverts the `gh-pages` branch to the previous commit.
   - Files to create: `plugins/autonomous-dev/src/deploy/backends/github-pages.ts`
   - Acceptance criteria: Backend metadata: `name: 'github-pages'`, `supportedTargets: ['github-pages']`. Deploy pushes to `gh-pages` branch (or configured branch). Rollback uses `git push --force-with-lease` to revert (only when explicitly authorized). Tests use a fixture repo.
   - Estimated effort: 3h

8. **Author conformance test suite** -- Create `tests/deploy/conformance.test.ts` per TDD §15. The suite runs the same battery against each registered backend: build returns valid artifact (schema validation), deploy returns signed valid record, healthCheck returns valid status, rollback succeeds against the deployed record. Loops over all bundled backends.
   - Files to create: `plugins/autonomous-dev/tests/deploy/conformance.test.ts`
   - Acceptance criteria: All 4 bundled backends pass conformance. Adding a new backend (e.g., a future cloud backend) automatically picks up the conformance tests via the registry. Tests are deterministic (mocked external commands).
   - Estimated effort: 4h

9. **Implement `BackendRegistry`** -- Create `src/deploy/registry.ts` with `register(backend)`, `get(name)`, `list()`, `clear()`. At startup, register the four bundled backends. Plugin-based backends register via PLAN-023-2's selection algorithm (this plan provides the registry interface).
   - Files to create: `plugins/autonomous-dev/src/deploy/registry.ts`
   - Acceptance criteria: Registry has 4 entries after startup. `get('local')` returns the local backend. `get('aws')` throws `BackendNotFoundError`. `list()` returns metadata for all registered backends. Tests cover registration, lookup, list.
   - Estimated effort: 1.5h

10. **Implement `deploy backends list` and `describe` CLI** -- `deploy backends list` prints all registered backends with metadata. `describe <name>` prints details (capabilities, supported targets, parameter schema, version).
    - Files to create: `plugins/autonomous-dev/src/cli/commands/deploy-backends.ts`
    - Acceptance criteria: `list` shows columns: name, version, capabilities, supported targets. `describe local` prints the full schema. JSON output mode emits structured data. Tests cover both commands.
    - Estimated effort: 1.5h

11. **Unit tests per backend** -- One test file per backend covering: build success/failure, deploy success/failure, healthCheck pass/fail, rollback success/failure. Use mocked external commands (gh, rsync, docker, git).
    - Files to create: 4 test files under `plugins/autonomous-dev/tests/deploy/backends/`
    - Acceptance criteria: All tests pass. Coverage ≥90% per backend file. Tests are fast (<10s total).
    - Estimated effort: 4h

12. **Integration test: full deploy lifecycle** -- `tests/integration/test-deploy-lifecycle.test.ts` that runs build → deploy → healthCheck → rollback for each bundled backend (`local` and `static` only — `docker-local` requires Docker, `github-pages` requires a real repo). Asserts deployment record is signed and validates.
    - Files to create: `plugins/autonomous-dev/tests/integration/test-deploy-lifecycle.test.ts`
    - Acceptance criteria: Both backends complete the full lifecycle. Records are signed. Rollback restores the previous state. Tests run in <30s.
    - Estimated effort: 3h

## Dependencies & Integration Points

**Exposes to other plans:**
- `DeploymentBackend` interface and supporting types consumed by PLAN-023-2 (multi-env, selection), PLAN-023-3 (monitoring, observability), and PLAN-024-* (cloud backends).
- `BackendRegistry` reused by all sibling plans.
- `DeploymentRecord` HMAC pattern reusable for any future signed-artifact context.
- Parameter validation framework reusable for any future user-input that needs server-side validation.
- Conformance test suite extensible: future backends automatically inherit the contract tests.

**Consumes from other plans:**
- TDD-002 / PLAN-002-1: existing two-phase commit pattern for atomic record persistence.
- TDD-007 / PLAN-007-X: existing config infrastructure for backend-specific config sections.
- PRD-007 trust framework: deferred to PLAN-023-2 for multi-env approval gates.

## Testing Strategy

- **Unit tests per backend (task 11):** Mocked external commands. ≥90% coverage per backend.
- **Conformance suite (task 8):** Same battery against each backend; ensures uniform contract.
- **Integration tests (task 12):** Full lifecycle for `local` and `static`. `docker-local` and `github-pages` tested manually due to environmental dependencies.
- **Parameter-validation negative tests:** Path traversal, shell metacharacters, range violations — all rejected.
- **HMAC roundtrip:** Sign + verify on 100 records; assert all valid. Tamper detection on 100 mutated records; assert all detected.
- **Performance:** Build + deploy + healthCheck for `local` backend completes in <10s. Documented as a perf benchmark.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Parameter validation has a bypass that allows shell injection (e.g., a path field with embedded `$()`) | Low | Critical -- RCE via deploy params | Validation uses `execFile` (no shell) when invoking external commands. Even if a malicious parameter slips past the validator, it's passed as an argv element, not interpolated into a shell command. Defense in depth. |
| Backend's external command (gh, docker, rsync) is missing on the host, breaking deploy | Medium | High -- deploy fails with cryptic error | Each backend's `metadata.capabilities` declares required tools. At startup, `BackendRegistry` checks tool availability and skips backends with missing dependencies (logging a warning). `deploy backends list` reports availability status. |
| `docker-local` backend leaks containers if rollback fails partway | Medium | Medium -- disk + memory accumulation over time | Rollback is idempotent: stops the new container, optionally removes; on failure, leaves the container running but logs a warning. Operator runs `docker container prune` periodically (documented). Future enhancement: scheduled cleanup task. |
| `github-pages` backend's `--force-with-lease` rollback can lose work if another deploy raced | Low | Medium -- lost gh-pages content | Rollback requires explicit `--force` flag from the operator (CLI prompt). Default behavior: refuse to rollback if `gh-pages` HEAD has moved since the deploy. |
| HMAC key (`DEPLOY_HMAC_KEY`) loss makes existing records unverifiable, blocking rollback | Medium | High -- rollback unavailable | Same mitigation as PLAN-019-4's audit key: log a warning, regenerate, write a "key rotation" record. Existing records become unverifiable; documented in operator guide. |
| Conformance test suite is too generic and misses backend-specific bugs | High | Medium -- backend ships broken | Conformance suite is the floor, not the ceiling. Each backend has its own dedicated tests (task 11). Adding a new backend requires both passing conformance AND its own test suite. PR template enforces this. |

## Definition of Done

- [ ] `DeploymentBackend` interface and supporting types compile under TypeScript strict mode
- [ ] Parameter validation rejects path traversal, shell metacharacters, range violations, and unknown enum values
- [ ] `DeploymentRecord` HMAC signing protects record integrity; tampering is detected
- [ ] All four bundled backends (`local`, `static`, `docker-local`, `github-pages`) implement the full interface
- [ ] Conformance test suite passes for all four bundled backends
- [ ] `BackendRegistry` registers backends at startup; `get`/`list` work as documented
- [ ] `deploy backends list` and `describe` CLI subcommands work with JSON output
- [ ] Unit tests pass with ≥90% coverage per backend file
- [ ] Integration tests demonstrate full lifecycle for `local` and `static`
- [ ] HMAC sign+verify roundtrip works for 100 records; tampering detected for 100 mutated records
- [ ] Build + deploy + healthCheck for `local` backend completes in <10s
- [ ] No regressions in existing tests
- [ ] Operator documentation describes when to use each backend and parameter formats
