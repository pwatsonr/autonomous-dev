# SPEC-013-2-01: Bun + Hono Dependencies and Server Bootstrap Entry Point

## Metadata
- **Parent Plan**: PLAN-013-2
- **Tasks Covered**: TASK-001 (deps + tsconfig), TASK-002 (server skeleton + standalone mode), partial TASK-003 (config loader entry)
- **Estimated effort**: 4 hours

## Description
Establish the package manifest, TypeScript/JSX configuration, and the `server/server.ts` bootstrap entry point that constructs the Hono application, loads configuration, registers routes/middleware via the chains defined in sibling specs (SPEC-013-2-02, SPEC-013-2-03, SPEC-013-2-04), and starts listening on the configured port. This spec owns the dependency surface and the top-level orchestration of `startServer()` — middleware bodies, binding security, and shutdown logic are owned by other specs in this plan. The bootstrap MUST fail fast on startup errors with a non-zero exit code and emit a single structured log line per startup phase.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `package.json` | Create | Pin `hono@^3.12.0`; add Bun engine; add typecheck/lint/test scripts |
| `tsconfig.json` | Create | JSX configured for Hono factory; strict mode; ES2022 target |
| `.gitignore` | Create | Standard Bun/TS ignores: `node_modules/`, `*.log`, `data/`, `dist/`, `bun.lockb` excluded |
| `server/server.ts` | Create | `startServer()` orchestration + standalone mode entry |
| `server/lib/config.ts` | Create | Stub `loadPortalConfig()` returning typed `PortalConfig` (full body in SPEC-013-2-03) |
| `config/portal-defaults.json` | Create | Default values: `port: 19280`, `auth_mode: "localhost"`, `logging.level: "info"` |

## Implementation Details

### Task 1: `package.json`

```json
{
  "name": "@autonomous-dev/portal",
  "version": "0.1.0",
  "type": "module",
  "engines": { "bun": ">=1.0.0" },
  "scripts": {
    "start": "bun run server/server.ts",
    "typecheck": "tsc --noEmit",
    "lint": "eslint server/ tests/",
    "test": "bun test"
  },
  "dependencies": {
    "hono": "^3.12.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.3.0"
  }
}
```

- `hono` MUST be pinned to `^3.12.0`; do not use `latest` or `^3.x` (breaking changes in 4.x).
- `engines.bun` MUST be `>=1.0.0`. The startup self-check in SPEC-013-2-03 enforces this at runtime.
- No `uuid` dependency — use `crypto.randomUUID()` from the Bun runtime (Web Crypto standard).

### Task 2: `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "jsx": "react-jsx",
    "jsxImportSource": "hono/jsx",
    "types": ["bun-types"],
    "lib": ["ES2022", "DOM"],
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  },
  "include": ["server/**/*", "tests/**/*", "config/**/*.json"]
}
```

- `jsxImportSource: "hono/jsx"` is REQUIRED for the JSX templates added by other plans (PLAN-013-3). It is set here so the toolchain validates JSX from day one.

### Task 3: `server/server.ts` Bootstrap Orchestration

```ts
import { serve, type Server } from 'bun';
import { Hono } from 'hono';
import { loadPortalConfig } from './lib/config';
import { applyMiddlewareChain } from './middleware';                  // SPEC-013-2-02
import { resolveBindHostname, validateBindingConfig } from './lib/binding'; // SPEC-013-2-03
import { setupGracefulShutdown } from './lib/shutdown';                // SPEC-013-2-04

export interface ServerState {
  server?: Server;
  shutdownInProgress: boolean;
  startTime: number;
}

const state: ServerState = { shutdownInProgress: false, startTime: Date.now() };

export async function startServer(): Promise<Server> {
  const phaseLog = (phase: string, extra: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ ts: new Date().toISOString(), phase, ...extra }));

  phaseLog('server_starting');

  const config = await loadPortalConfig();
  phaseLog('config_loaded', { port: config.port, auth_mode: config.auth_mode });

  await validateBindingConfig(config);
  const hostname = resolveBindHostname(config);

  const app = new Hono();
  applyMiddlewareChain(app, config);

  app.get('/health', (c) => c.json({
    status: 'healthy',
    uptime_ms: Date.now() - state.startTime,
    auth_mode: config.auth_mode,
  }));

  const server = serve({
    port: config.port,
    hostname,
    fetch: app.fetch,
    error: (err) => phaseLog('server_fetch_error', { message: err.message }),
  });

  state.server = server;
  setupGracefulShutdown(server, state);

  phaseLog('server_listening', {
    hostname, port: config.port, startup_ms: Date.now() - state.startTime,
  });
  return server;
}

if (import.meta.main) {
  if (!process.env.CLAUDE_PLUGIN_ROOT) {
    process.env.CLAUDE_PLUGIN_ROOT = process.cwd();
  }
  startServer().catch((err) => {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      phase: 'startup_failed',
      message: err.message,
      code: (err as { code?: string }).code,
    }));
    process.exit(1);
  });
}
```

- Order of operations is fixed: config → binding validation → middleware → routes → listen → shutdown handlers. Do not reorder.
- The bootstrap exposes `/health` directly. Other routes are registered by PLAN-013-3.
- Imports from `./middleware`, `./lib/binding`, and `./lib/shutdown` are PROVIDED by other specs in this plan. This spec assumes those modules exist with the documented signatures.

### Task 4: Stub `server/lib/config.ts`

```ts
export interface PortalConfig {
  port: number;
  auth_mode: 'localhost' | 'tailscale' | 'oauth';
  bind_host?: string;
  allowed_origins?: string[];
  logging: { level: 'debug' | 'info' | 'warn' | 'error' };
}

export async function loadPortalConfig(): Promise<PortalConfig> {
  const defaults = await import('../../config/portal-defaults.json', {
    assert: { type: 'json' },
  });
  return defaults.default as PortalConfig;
}
```

- This is the THIN stub. The full multi-layer loader (defaults + user file + env overrides + validation) is implemented in SPEC-013-2-03. The stub MUST satisfy the `PortalConfig` interface so other specs can compile against it immediately.

### Task 5: `config/portal-defaults.json`

```json
{
  "port": 19280,
  "auth_mode": "localhost",
  "logging": { "level": "info" }
}
```

- Port `19280` is reserved for the autonomous-dev portal (matches TDD-013).
- Do not commit any secrets; this file is checked in.

## Acceptance Criteria

- [ ] `bun install` completes with no peer-dependency warnings and `hono@3.12.x` is resolved
- [ ] `bun run typecheck` exits 0 with zero TypeScript errors
- [ ] `bun run server/server.ts` starts and logs the four phases in order: `server_starting`, `config_loaded`, `server_listening` (and during startup failure, `startup_failed`)
- [ ] `curl -fsS http://127.0.0.1:19280/health` returns HTTP 200 with JSON body containing `status: "healthy"`, numeric `uptime_ms`, and `auth_mode: "localhost"`
- [ ] Sending SIGINT (Ctrl+C) to the running server triggers the shutdown sequence wired in SPEC-013-2-04 (this spec verifies the wire-up exists, not the full sequence)
- [ ] Setting an invalid `port` value (e.g., `99999`) in `portal-defaults.json` causes `startServer()` to throw and exit 1 with a `startup_failed` log line
- [ ] `import.meta.main` guard prevents `startServer()` from auto-running when `server.ts` is imported by tests
- [ ] No raw `console.log("...")` strings in `server.ts` — every startup log uses the structured JSON line format documented above

## Dependencies

- **Consumes from**: `./middleware/index.ts` (`applyMiddlewareChain`) — SPEC-013-2-02; `./lib/binding.ts` (`resolveBindHostname`, `validateBindingConfig`) — SPEC-013-2-03; `./lib/shutdown.ts` (`setupGracefulShutdown`) — SPEC-013-2-04. These modules MUST export the listed symbols with the listed signatures.
- **Exposes to**: `startServer(): Promise<Server>`, `ServerState` interface — consumed by integration tests (SPEC-013-2-05) and PLAN-013-3 route registration.
- **Runtime**: Bun ≥ 1.0.0 (enforced by `engines` and the startup self-check in SPEC-013-2-03).

## Notes

- The `Bun.serve` API is the only listener primitive used. Do not introduce `node:http` or Express — Hono is the application framework, Bun is the runtime.
- The bootstrap is intentionally minimal. Any logic that requires more than ~10 lines belongs in a sibling module so this file remains a readable orchestration surface.
- The standalone-mode env defaulting (`CLAUDE_PLUGIN_ROOT`) is preserved here from the plan's reference snippet; richer plugin/standalone detection is deferred to PLAN-013-1 integration.
- `crypto.randomUUID()` (Web Crypto) is used everywhere request IDs are needed — confirmed available in Bun ≥ 1.0 and Node ≥ 19. Do NOT add the `uuid` package.
