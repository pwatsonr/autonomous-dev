# SPEC-021-2-03: Custom Evaluator Subprocess Sandbox + EvaluatorRegistry

## Metadata
- **Parent Plan**: PLAN-021-2
- **Tasks Covered**: Task 6 (subprocess sandbox), Task 8 (EvaluatorRegistry)
- **Estimated effort**: 8 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-021-2-03-custom-evaluator-sandbox-registry.md`

## Description

Implement two security-critical pieces of the standards evaluation runtime:

1. **`EvaluatorRegistry`** (`src/standards/evaluator-registry.ts`): a single in-process registry that maps evaluator names → handlers. At daemon startup it auto-registers the five built-in evaluators (SPEC-021-2-01, SPEC-021-2-02). It then loads custom evaluators declared in `extensions.evaluators_allowlist` (config field per TDD §17). The registry is reload-safe: SIGUSR1 → re-read the allowlist → register newly-added paths, leave existing entries intact, refuse to remove built-ins.

2. **Custom evaluator subprocess sandbox** (`src/standards/sandbox.ts`): the only place in the codebase that executes operator-supplied code. Per TDD §7, every custom evaluator runs under the strictest available isolation: empty environment, read-only filesystem, no network, 30-second wall clock, 256MB memory cap. Implementation uses `child_process.execFile` as the base; on Linux it wraps the call in `unshare --net --mount` plus `prlimit --as=268435456 --rss=268435456`; on macOS it wraps in `sandbox-exec -f bin/sandbox-profiles/macos-sandbox.sb`; on other platforms (Windows, BSDs without unshare) it falls back to `execFile`-only and logs a structured warning indicating the weaker isolation level.

The allowlist is the trust boundary: a custom evaluator path NOT in `extensions.evaluators_allowlist` MUST throw `SecurityError` BEFORE any subprocess is spawned. This is the single most important check in the spec; adversarial tests in SPEC-021-2-05 verify it. The allowlist is operator-only (set via config file or `evaluators add` admin CLI in SPEC-021-2-04); user-level rules cannot extend it.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/standards/evaluator-registry.ts` | Create | Registry class; built-in registration; allowlist loading; SIGUSR1 reload |
| `plugins/autonomous-dev/src/standards/sandbox.ts` | Create | `runCustomEvaluator()` with platform-specific isolation |
| `plugins/autonomous-dev/src/standards/sandbox-platform.ts` | Create | Platform detection helpers (Linux unshare? macOS sandbox-exec?) |
| `plugins/autonomous-dev/bin/sandbox-profiles/macos-sandbox.sb` | Create | macOS sandbox profile: deny network, restrict fs writes |
| `plugins/autonomous-dev/src/standards/errors.ts` | Create | `SecurityError`, `EvaluatorNotFoundError`, `EvaluatorRunError`, `SandboxTimeoutError`, `SandboxMemoryError` |
| `plugins/autonomous-dev/tests/standards/evaluator-registry.test.ts` | Create | Built-in registration, custom add, reload semantics |
| `plugins/autonomous-dev/tests/standards/sandbox.test.ts` | Create | Allowlist enforcement; happy-path subprocess; timeout; memory limit (platform-conditional) |
| `plugins/autonomous-dev/tests/standards/fixtures/eval-allowed.sh` | Create | Trivial allowlisted shell evaluator emitting `{"passed": true, "findings": []}` |
| `plugins/autonomous-dev/tests/standards/fixtures/eval-denied.sh` | Create | Identical script NOT in allowlist (used to test SecurityError path) |

## Implementation Details

### Errors (`errors.ts`)

```typescript
export class SecurityError extends Error {
  readonly code = 'EVALUATOR_SECURITY';
  constructor(message: string) { super(message); this.name = 'SecurityError'; }
}
export class EvaluatorNotFoundError extends Error {
  readonly code = 'EVALUATOR_NOT_FOUND';
  constructor(public readonly name: string) {
    super(`Evaluator "${name}" is not registered`);
    this.name = 'EvaluatorNotFoundError';
  }
}
export class EvaluatorRunError extends Error {
  readonly code = 'EVALUATOR_RUN';
  constructor(public readonly ruleId: string, public readonly cause: Error) {
    super(`Evaluator failed for rule "${ruleId}": ${cause.message}`);
    this.name = 'EvaluatorRunError';
  }
}
export class SandboxTimeoutError extends Error {
  readonly code = 'SANDBOX_TIMEOUT';
  constructor(public readonly path: string, public readonly elapsedMs: number) {
    super(`Custom evaluator "${path}" exceeded 30s wall clock (ran for ${elapsedMs}ms)`);
    this.name = 'SandboxTimeoutError';
  }
}
export class SandboxMemoryError extends Error {
  readonly code = 'SANDBOX_MEMORY';
  constructor(public readonly path: string) {
    super(`Custom evaluator "${path}" exceeded 256MB memory cap`);
    this.name = 'SandboxMemoryError';
  }
}
```

### `EvaluatorRegistry` (`evaluator-registry.ts`)

```typescript
import { BuiltinEvaluator, EvaluatorResult, EvaluatorContext } from './evaluators/types';
import { runCustomEvaluator } from './sandbox';
import { EvaluatorNotFoundError } from './errors';

export type RegisteredEvaluator =
  | { kind: 'builtin'; name: string; handler: BuiltinEvaluator }
  | { kind: 'custom'; name: string; absolutePath: string };

export class EvaluatorRegistry {
  private map = new Map<string, RegisteredEvaluator>();
  private builtinNames = new Set<string>();

  constructor(private readonly loadAllowlist: () => string[]) {
    this.registerBuiltins();
    this.loadCustomFromAllowlist();
  }

  private registerBuiltins(): void {
    // Import each builtin lazily to keep startup graph clean
    const { default: frameworkDetector } = require('./evaluators/framework-detector');
    const { default: endpointScanner } = require('./evaluators/endpoint-scanner');
    const { default: sqlInjectionDetector } = require('./evaluators/sql-injection-detector');
    const { default: dependencyChecker } = require('./evaluators/dependency-checker');
    const { default: patternGrep } = require('./evaluators/pattern-grep');
    const builtins: Array<[string, BuiltinEvaluator]> = [
      ['framework-detector', frameworkDetector],
      ['endpoint-scanner', endpointScanner],
      ['sql-injection-detector', sqlInjectionDetector],
      ['dependency-checker', dependencyChecker],
      ['pattern-grep', patternGrep],
    ];
    for (const [name, handler] of builtins) {
      this.map.set(name, { kind: 'builtin', name, handler });
      this.builtinNames.add(name);
    }
  }

  private loadCustomFromAllowlist(): void {
    for (const absolutePath of this.loadAllowlist()) {
      // Convention: custom evaluator name = basename(path) without extension
      const name = basenameNoExt(absolutePath);
      if (this.builtinNames.has(name)) {
        // Built-ins shadow custom of the same name — log + skip
        console.warn(`evaluator name "${name}" collides with built-in; ignoring custom path ${absolutePath}`);
        continue;
      }
      this.map.set(name, { kind: 'custom', name, absolutePath });
    }
  }

  list(): RegisteredEvaluator[] {
    return [...this.map.values()];
  }

  get(name: string): RegisteredEvaluator {
    const entry = this.map.get(name);
    if (!entry) throw new EvaluatorNotFoundError(name);
    return entry;
  }

  reload(): void {
    // Remove all custom entries; re-load from current allowlist.
    // Built-ins are immutable.
    for (const [name, entry] of this.map) {
      if (entry.kind === 'custom') this.map.delete(name);
    }
    this.loadCustomFromAllowlist();
  }
}
```

The constructor receives `loadAllowlist: () => string[]` rather than reading config directly. This keeps the registry pure for tests (inject a stub) and lets the daemon wire it to the real config-loading function (TDD-007 helper).

**SIGUSR1 wiring** (handled outside the registry; documented here for context): the daemon's signal handler in `src/daemon/signals.ts` (existing) calls `registry.reload()` on SIGUSR1. This spec only provides `reload()`; the wiring is part of the existing signal infrastructure (PLAN-001-X).

### Subprocess Sandbox (`sandbox.ts`)

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, isAbsolute } from 'node:path';
import { mkdir } from 'node:fs/promises';
import {
  SecurityError, SandboxTimeoutError, SandboxMemoryError,
} from './errors';
import { detectPlatform } from './sandbox-platform';
import { EvaluatorResult } from './evaluators/types';

const execFileP = promisify(execFile);

const SANDBOX_CWD = '/tmp/eval-sandbox';
const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 10 * 1024 * 1024;
const MEMORY_BYTES = 256 * 1024 * 1024; // 256MB

export interface SandboxOptions {
  allowlist: string[];        // absolute paths
}

export async function runCustomEvaluator(
  evaluatorPath: string,
  filePaths: string[],
  args: Record<string, unknown>,
  opts: SandboxOptions,
): Promise<EvaluatorResult> {
  // 1) Allowlist enforcement — BEFORE any subprocess is spawned.
  if (!isAbsolute(evaluatorPath)) {
    throw new SecurityError(`Custom evaluator path must be absolute: "${evaluatorPath}"`);
  }
  const resolved = resolve(evaluatorPath);
  if (!opts.allowlist.includes(resolved)) {
    throw new SecurityError(
      `Custom evaluator "${resolved}" is not in extensions.evaluators_allowlist`,
    );
  }

  // 2) Ensure sandbox cwd exists (mode 0700).
  await mkdir(SANDBOX_CWD, { recursive: true, mode: 0o700 });

  // 3) Build platform-specific argv.
  const platform = detectPlatform();
  const { command, baseArgs } = buildSandboxCommand(platform, resolved);

  // 4) Append evaluator-contract argv: <file_paths> --args '<json>'
  const userArgs = [
    ...filePaths,
    '--args',
    JSON.stringify(args),
  ];

  const start = Date.now();
  try {
    const { stdout } = await execFileP(command, [...baseArgs, ...userArgs], {
      cwd: SANDBOX_CWD,
      env: {},                  // empty env — no secrets leak
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      killSignal: 'SIGKILL',
    });
    return parseEvaluatorOutput(stdout, resolved);
  } catch (err: any) {
    const elapsed = Date.now() - start;
    // Node's execFile sets `err.killed = true` and `err.signal = 'SIGKILL'`
    // when the timeout fires.
    if (err?.killed && elapsed >= TIMEOUT_MS - 100) {
      throw new SandboxTimeoutError(resolved, elapsed);
    }
    // OOM detection is platform-specific:
    // Linux prlimit --as: child receives SIGKILL with no specific marker;
    //   we infer "memory error" if exit code is 137 (128 + SIGKILL) and not a timeout.
    // macOS sandbox-exec / ulimit: similar SIGKILL.
    if (err?.code === 137 && elapsed < TIMEOUT_MS - 100) {
      throw new SandboxMemoryError(resolved);
    }
    throw err;
  }
}

function parseEvaluatorOutput(stdout: string, path: string): EvaluatorResult {
  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`Custom evaluator "${path}" emitted invalid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed?.passed !== 'boolean' || !Array.isArray(parsed?.findings)) {
    throw new Error(`Custom evaluator "${path}" output missing required fields {passed, findings}`);
  }
  return { passed: parsed.passed, findings: parsed.findings };
}
```

### Platform-specific command builder (`sandbox-platform.ts`)

```typescript
export type Platform = 'linux-unshare' | 'macos-sandbox' | 'fallback';

export function detectPlatform(): Platform {
  if (process.platform === 'linux' && hasUnshareSupport()) return 'linux-unshare';
  if (process.platform === 'darwin' && hasSandboxExec())   return 'macos-sandbox';
  return 'fallback';
}

export function buildSandboxCommand(
  platform: Platform,
  evaluatorPath: string,
): { command: string; baseArgs: string[] } {
  switch (platform) {
    case 'linux-unshare':
      // unshare --net --mount: new network ns (no net), new mount ns (no global mount writes)
      // prlimit --as / --rss: cap virtual + resident memory at 256MB
      return {
        command: 'unshare',
        baseArgs: [
          '--net', '--mount',
          'prlimit',
          '--as=268435456',
          '--rss=268435456',
          evaluatorPath,
        ],
      };
    case 'macos-sandbox': {
      // sandbox-exec -f <profile> <evaluator>
      const profile = `${process.env.AUTONOMOUS_DEV_ROOT ?? __dirname}/../../bin/sandbox-profiles/macos-sandbox.sb`;
      return {
        command: 'sandbox-exec',
        baseArgs: ['-f', profile, evaluatorPath],
      };
    }
    case 'fallback':
      // Direct execFile — weaker isolation; warning logged at startup
      logWeakSandboxWarningOnce();
      return { command: evaluatorPath, baseArgs: [] };
  }
}
```

`hasUnshareSupport()` runs `unshare --version` once and caches the result; if exit non-zero, returns `false`. `hasSandboxExec()` does the same for `sandbox-exec -p '(version 1)' /usr/bin/true`.

### macOS sandbox profile (`bin/sandbox-profiles/macos-sandbox.sb`)

```scheme
(version 1)
(deny default)

;; Allow basic process lifecycle
(allow process-fork)
(allow process-exec)
(allow signal (target self))

;; Allow read of system shared libraries and the evaluator binary itself
(allow file-read*
  (subpath "/usr/lib")
  (subpath "/usr/bin")
  (subpath "/System")
  (subpath "/Library/Frameworks")
  (subpath "/private/tmp/eval-sandbox"))

;; Allow write only inside the sandbox cwd
(allow file-write*
  (subpath "/private/tmp/eval-sandbox"))

;; Deny ALL network
(deny network*)

;; Allow stdin/stdout/stderr (descriptors 0/1/2 inherited from parent)
(allow file-ioctl)
```

### Evaluator Contract (per TDD §7 — for documentation only; enforced by `parseEvaluatorOutput`)

Custom evaluators are scripts (any language) invoked as:
```
<script-path> <file_path> [<file_path> ...] --args '<json-encoded-args>'
```
They must emit a single JSON object on stdout: `{"passed": <bool>, "findings": [...]}` and exit 0 (passed), 1 (failed-with-findings), or 2 (evaluator internal error). Stderr is captured but not parsed; it goes to the daemon log.

## Acceptance Criteria

- [ ] `EvaluatorRegistry.list()` immediately after `new EvaluatorRegistry(() => [])` returns exactly 5 entries: `framework-detector`, `endpoint-scanner`, `sql-injection-detector`, `dependency-checker`, `pattern-grep` — all `kind: 'builtin'`.
- [ ] `EvaluatorRegistry.get('framework-detector')` returns the built-in entry; `get('nope')` throws `EvaluatorNotFoundError` with `name === 'nope'`.
- [ ] Constructing the registry with `loadAllowlist: () => ['/abs/path/to/my-eval.sh']` adds an entry `{kind: 'custom', name: 'my-eval', absolutePath: '/abs/path/to/my-eval.sh'}`.
- [ ] If the allowlist contains a path whose basename collides with a built-in (e.g. `/x/framework-detector.sh`), the registry logs a warning and the built-in wins; the custom entry is NOT registered.
- [ ] Calling `registry.reload()` after the allowlist function returns a new path adds that path; calling `reload()` after the allowlist function returns an empty list removes ALL custom entries but preserves all 5 built-ins.
- [ ] `runCustomEvaluator('/relative/path', [], {}, {allowlist: []})` throws `SecurityError` containing `"absolute"` BEFORE attempting to spawn.
- [ ] `runCustomEvaluator('/abs/path/not-listed.sh', [], {}, {allowlist: ['/abs/path/listed.sh']})` throws `SecurityError` containing `"not in extensions.evaluators_allowlist"` BEFORE attempting to spawn (verified via spy on `child_process.execFile`).
- [ ] `runCustomEvaluator('/abs/path/eval-allowed.sh', ['file1.ts'], {key: 'val'}, {allowlist: ['/abs/path/eval-allowed.sh']})` invokes the script and returns the parsed `{passed, findings}` result.
- [ ] A fixture script that runs `sleep 35` (exceeds 30s timeout) throws `SandboxTimeoutError` with `elapsedMs >= 30000`. (Test marked `slow`; allowed up to 32s wall clock.)
- [ ] Linux only: a fixture script attempting `curl http://example.com` exits non-zero (network blocked by `unshare --net`); the wrapper surfaces this as a non-zero exit and the daemon does NOT crash.
- [ ] Linux only: a fixture script attempting to allocate 1GB via `python3 -c "x = 'a' * (1024**3)"` is killed by prlimit; the wrapper raises `SandboxMemoryError`.
- [ ] macOS only: a fixture script attempting `curl http://example.com` exits non-zero (network blocked by sandbox-exec deny network).
- [ ] macOS only: a fixture script attempting to write to `/etc/test-evaluator-write` is denied by sandbox-exec; write to `/tmp/eval-sandbox/x` succeeds.
- [ ] On any platform: env vars from the parent process (e.g. `process.env.HOME`, `process.env.AWS_SECRET_ACCESS_KEY`) are NOT visible inside the evaluator; a fixture script writing `env` to stdout returns an empty (or near-empty: only PWD/SHLVL injected by shell init) result.
- [ ] On a platform without unshare/sandbox-exec support, `detectPlatform()` returns `'fallback'`, a structured warning is logged exactly once per process, and the evaluator still runs (with weaker isolation).
- [ ] Custom evaluator emitting non-JSON to stdout produces a clear error message containing `"invalid JSON"` and the evaluator path.
- [ ] Custom evaluator emitting valid JSON missing `passed` or `findings` produces an error containing `"missing required fields"`.
- [ ] Test coverage ≥ 95% for `evaluator-registry.ts`; ≥ 90% for `sandbox.ts` (the platform-specific branches account for the gap and are exercised by SPEC-021-2-05).

## Dependencies

- **Blocked by**: SPEC-021-2-01, SPEC-021-2-02 (the registry imports all 5 built-ins by name).
- **Consumed by**: SPEC-021-2-04 (`runEvaluator` orchestrator dispatches built-in vs custom; CLI consumes `registry.list()`).
- **Hardened by**: SPEC-021-2-05 (adversarial test suite proves the sandbox holds against escape attempts).
- **Runtime deps**: `node:child_process`, `node:util`, `node:path`, `node:fs/promises`. No new npm packages.
- **External binaries** (resolved via PATH at runtime; absent → fallback platform):
  - Linux: `unshare` (util-linux), `prlimit` (util-linux). Both ship by default on Ubuntu/Debian/RHEL.
  - macOS: `sandbox-exec` (Apple-shipped, present on every macOS install but officially deprecated since 10.15 — see Notes).

## Notes

- The allowlist check happens BEFORE `mkdir`, BEFORE `execFile`, BEFORE any platform-specific setup. The single most important invariant of this spec is: a denied path CANNOT cause a subprocess to spawn, no matter how the caller misuses the API. Adversarial tests in SPEC-021-2-05 verify this with a spy on `child_process`.
- `unshare --net` requires Linux user namespaces. Most modern distros enable them by default; some hardened kernels (e.g. RHEL with `user.max_user_namespaces=0`) disable them. `hasUnshareSupport()` MUST detect this at startup, not per-call, to avoid a per-evaluator fork bomb of failing detection probes. The detection result is process-lifetime cached.
- `sandbox-exec` has been formally deprecated by Apple since macOS 10.15 (Catalina) but remains shipped through macOS 15.x. The risk of removal is documented in PLAN-021-2 §Risks. If/when it disappears, the fallback path (no isolation + warning) keeps the system functional but operationally degraded; a follow-up plan will add Docker-based isolation.
- The 256MB cap uses `prlimit --as` (virtual address space) AND `--rss` (resident set) together. `--as` catches mmap-heavy attacks; `--rss` catches genuine memory pressure. Defense in depth.
- The empty `env: {}` is critical: ANY env var leak (e.g. `AWS_*`, `GITHUB_TOKEN`, `OPENAI_API_KEY`) would defeat the sandbox's purpose. The execFile contract guarantees no inheritance when `env` is explicitly set to `{}`.
- The sandbox cwd `/tmp/eval-sandbox` is created mode 0700 to prevent other users on a multi-tenant host from observing intermediate evaluator state. On macOS, the path resolves to `/private/tmp/eval-sandbox` — the sandbox profile uses the `/private/tmp` form because that is the canonical kernel path.
- `EvaluatorRegistry.reload()` deliberately removes ALL custom entries and re-adds from the current allowlist. This is simpler than diffing and ensures stale entries are evicted when the operator removes a path. Built-ins survive because they live in a separate `builtinNames` set checked during cleanup.
- The convention "custom evaluator name = basename without extension" means an operator uploading `/usr/local/bin/sec-check.py` exposes it as `sec-check`. Collisions across paths (e.g. two `sec-check` files in different dirs) are resolved last-wins; documented in the README, not enforced here.
