# SPEC-023-1-04: Conformance Test Suite, BackendRegistry, and `deploy backends` CLI

## Metadata
- **Parent Plan**: PLAN-023-1
- **Tasks Covered**: Task 8 (conformance test suite), Task 9 (`BackendRegistry`), Task 10 (`deploy backends list`/`describe` CLI)
- **Estimated effort**: 7 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-023-1-04-conformance-suite-registry-and-cli.md`

## Description
Wire the four bundled backends from SPEC-023-1-02 and SPEC-023-1-03 into a runtime registry, enforce a uniform interface contract via a single conformance test that loops over every registered backend, and surface backend information to operators via two new CLI subcommands. After this spec, registering a future backend (e.g., `aws-s3`) automatically picks up conformance coverage and shows up in `deploy backends list` without further wiring.

The registry also performs startup tool-availability checks (per PLAN-023-1's risk register): if `docker` is missing, the `docker-local` backend is registered with `available: false` and a clear warning rather than failing the whole deploy phase. The CLI reports this state so operators can debug missing prerequisites.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/deploy/registry.ts` | Create | `BackendRegistry` with `register`/`get`/`list`/`clear` |
| `plugins/autonomous-dev/src/deploy/registry-bootstrap.ts` | Create | One-time registration of the four bundled backends |
| `plugins/autonomous-dev/src/cli/commands/deploy-backends.ts` | Create | `list` and `describe <name>` subcommands |
| `plugins/autonomous-dev/tests/deploy/conformance.test.ts` | Create | Single suite, `describe.each` over registry contents |
| `plugins/autonomous-dev/tests/deploy/registry.test.ts` | Create | Registration, lookup, error cases |
| `plugins/autonomous-dev/tests/cli/deploy-backends.test.ts` | Create | CLI output (text + JSON modes) |

## Implementation Details

### `src/deploy/registry.ts`

A single-process singleton with a `clear()` for tests. Each entry tracks availability separately from registration so unavailable backends can still be listed.

```ts
export interface RegisteredBackend {
  backend: DeploymentBackend;
  available: boolean;
  unavailableReason?: string;  // e.g., "docker not on PATH"
}
export class BackendNotFoundError extends Error {
  constructor(public readonly name: string) { super(`backend not registered: ${name}`); }
}
export class BackendRegistry {
  static register(backend: DeploymentBackend): void;          // checks tool availability
  static get(name: string): DeploymentBackend;                // throws BackendNotFoundError
  static list(): RegisteredBackend[];                          // sorted by name
  static clear(): void;                                        // tests only
}
```

Tool-availability check: for each `metadata.requiredTools` entry, run `runTool(tool, ['--version'], { timeoutMs: 5000 })`. If it rejects, mark the backend `available: false` with `unavailableReason: '<tool> not on PATH or unresponsive'`. Log once at WARN level. Backend is still registered (so `get(name)` works for tests with mocked tools) — it is the caller's responsibility to honor `available`.

### `src/deploy/registry-bootstrap.ts`

```ts
import { BackendRegistry } from './registry';
import { LocalBackend } from './backends/local';
import { StaticBackend } from './backends/static';
import { DockerLocalBackend } from './backends/docker-local';
import { GithubPagesBackend } from './backends/github-pages';

export function registerBundledBackends(): void {
  BackendRegistry.register(new LocalBackend());
  BackendRegistry.register(new StaticBackend());
  BackendRegistry.register(new DockerLocalBackend());
  BackendRegistry.register(new GithubPagesBackend());
}
```

Called once from the deploy phase entry point. Idempotent (safe to call twice; `register` overwrites by name).

### `tests/deploy/conformance.test.ts`

A single test file that loops over `BackendRegistry.list()` and runs the same battery against each backend. External tools are mocked at the `runTool` boundary so the suite is deterministic and tool-free.

Battery (every backend MUST pass each):

1. **Metadata shape**: `metadata.name` non-empty kebab-case; `metadata.version` valid semver; `metadata.supportedTargets` non-empty subset of `BackendCapability`; `metadata.requiredTools` is a string[].
2. **Build returns a valid artifact**: invoking `build(ctx)` with a fixture `BuildContext` returns an object whose shape passes a runtime schema check (artifactId is ULID, type is one of the union, checksum is 64-hex, sizeBytes is a non-negative integer).
3. **Deploy returns a signed record**: invoking `deploy(artifact, 'test-env', validParams)` returns a `DeploymentRecord` whose `hmac` is non-empty AND `verifyDeploymentRecord(record)` returns `{ valid: true }`.
4. **HealthCheck returns valid status**: returns `{ healthy: boolean, checks: array }` with at least one entry in `checks`.
5. **Rollback returns valid result**: returns `{ success: boolean, errors: string[] }`. Errors is an array even when empty.
6. **Tampering is detected**: mutate `record.environment` after deploy and assert `verifyDeploymentRecord` returns `{ valid: false }`.

Per-backend `validParams` fixtures live in `tests/deploy/fixtures/<backend-name>.params.ts` so a new backend just adds a fixture file.

### `src/cli/commands/deploy-backends.ts`

Two subcommands. Both honor a global `--json` flag.

`deploy backends list`:
- Calls `BackendRegistry.list()`.
- Default text mode: prints columns `NAME`, `VERSION`, `AVAILABLE`, `TARGETS`, `CAPABILITIES`. `AVAILABLE` is `yes`/`no (<reason>)`.
- `--json` mode: emits `{ backends: RegisteredBackend[] }` where each entry contains `name`, `version`, `available`, `unavailableReason`, `supportedTargets`, `capabilities`, `requiredTools`.

`deploy backends describe <name>`:
- Calls `BackendRegistry.get(name)`.
- Default text mode: section blocks for `Metadata`, `Required tools`, `Parameter schema`, `Capabilities`. Parameter schema is read from a static `<Backend>.PARAM_SCHEMA` export each backend MUST expose alongside its class.
- `--json` mode: emits `{ name, version, available, unavailableReason, supportedTargets, capabilities, requiredTools, parameterSchema }`.
- Exit code 1 with stderr message `backend not registered: <name>` if `BackendNotFoundError` is thrown.

Each backend file (from SPEC-023-1-02 and SPEC-023-1-03) MUST also export a `PARAM_SCHEMA` constant matching the schema it passes to `validateParameters`. This is the single source of truth for the `describe` output. (This does not change the implementation surface from those specs — it just promotes a local constant to a module export.)

## Acceptance Criteria

- [ ] `BackendRegistry.register(new LocalBackend())` followed by `BackendRegistry.get('local')` returns the same instance.
- [ ] `BackendRegistry.get('does-not-exist')` throws `BackendNotFoundError` whose `.name` property equals `'does-not-exist'`.
- [ ] After `registerBundledBackends()`, `BackendRegistry.list()` returns exactly 4 entries with names `['docker-local', 'github-pages', 'local', 'static']` (alphabetical).
- [ ] When `docker` is unavailable in the test environment, the `docker-local` entry has `available: false` and `unavailableReason` mentions `docker`.
- [ ] `BackendRegistry.clear()` after `registerBundledBackends()` leaves `list()` returning `[]`.
- [ ] `tests/deploy/conformance.test.ts` runs `describe.each(BackendRegistry.list())` and reports a separate `describe` block per backend (verifiable by Jest output).
- [ ] All 4 bundled backends pass every battery item (metadata shape, build artifact, signed record, healthCheck, rollback, tamper detection) with mocked external commands.
- [ ] Adding a fictional fifth backend in a test (`registerBundledBackends(); BackendRegistry.register(new FakeBackend())`) automatically extends the conformance describe.each — no test edit required.
- [ ] `deploy backends list` (default text) prints a table with columns `NAME`, `VERSION`, `AVAILABLE`, `TARGETS`, `CAPABILITIES` and one row per registered backend.
- [ ] `deploy backends list --json` emits valid JSON parsed by `JSON.parse` whose top-level key is `backends` and whose entries include `name`, `version`, `available`, `supportedTargets`, `capabilities`, `requiredTools`.
- [ ] `deploy backends describe local` (text) prints sections labeled `Metadata`, `Required tools`, `Parameter schema`, `Capabilities`. The `Parameter schema` section lists `pr_title`, `pr_body`, `base_branch`.
- [ ] `deploy backends describe local --json` emits a JSON object containing a top-level `parameterSchema` matching the `LocalBackend.PARAM_SCHEMA` export.
- [ ] `deploy backends describe nonexistent` exits with code 1 and prints `backend not registered: nonexistent` to stderr.
- [ ] CLI tests do not require any external tool to be installed (everything mocked at `runTool`).
- [ ] The conformance test suite completes in under 5 seconds total.

## Dependencies

- SPEC-023-1-01: `DeploymentBackend`, supporting types, `verifyDeploymentRecord`.
- SPEC-023-1-02: `LocalBackend`, `StaticBackend`, `runTool`. Each backend MUST also export `PARAM_SCHEMA`.
- SPEC-023-1-03: `DockerLocalBackend`, `GithubPagesBackend`. Each backend MUST also export `PARAM_SCHEMA`.
- Existing CLI infrastructure (commander/yargs/whatever the project uses today). The two new subcommands plug into the existing `deploy` command group.
- Node built-ins only.

## Notes

- The registry deliberately uses a static class rather than an injected instance so existing CLI commands can call `BackendRegistry.get(...)` without threading state. `clear()` exists strictly for tests; production code MUST NOT call it.
- Tool-availability is a soft signal, not a hard gate. A backend marked `available: false` can still be invoked (tests mock `runTool`), but the deploy phase entry point (out of scope here) MUST refuse to use it for real deploys. PLAN-023-2's selection algorithm honors this flag.
- The conformance suite is the FLOOR, not the ceiling. PLAN-023-1's task 11 (covered in SPEC-023-1-05) adds per-backend deep tests on top.
- Promoting `PARAM_SCHEMA` to a module export is the only retroactive change to SPEC-023-1-02/03 implementations. It is a constant, not a behavior change. This makes `describe` output authoritative without duplicating the schema.
- `--json` output contracts are stable and will be relied on by PLAN-013-X portal UI and by CI scripts; do not reshape them without a major-version bump.
- Conformance fixtures use a stable in-memory `BuildContext` so the suite is deterministic and does not depend on a real git repo.
