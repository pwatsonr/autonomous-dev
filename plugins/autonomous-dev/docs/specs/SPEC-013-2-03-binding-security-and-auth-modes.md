# SPEC-013-2-03: Localhost-Only Binding by Default, Tailscale Mode, OAuth+PKCE Hook

## Metadata
- **Parent Plan**: PLAN-013-2
- **Tasks Covered**: TASK-003 (full config loader + env overrides + validation), TASK-006 (binding security validation), TASK-010 (startup self-check)
- **Estimated effort**: 6 hours

## Description
Implement the secure binding policy and configuration loader that enforces it. The server MUST bind only to `127.0.0.1` when `auth_mode === 'localhost'` (the default). Binding to non-loopback interfaces is permitted ONLY when `auth_mode` is `tailscale` (which restricts to the host's Tailscale interface) or `oauth` (which requires OAuth2+PKCE configuration to be present, registered as an extension point for future TDD-014 work). This is the security boundary that prevents accidental exposure of the development server. The loader merges defaults + user file + env vars and validates types and ranges before the server attempts to bind.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `server/lib/config.ts` | Modify | Replace stub from SPEC-013-2-01 with full loader |
| `server/lib/binding.ts` | Create | `resolveBindHostname`, `validateBindingConfig`, `checkPortAvailability` |
| `server/lib/validation.ts` | Create | Type/range validators for config fields |
| `server/lib/oauth-extension.ts` | Create | Empty extension point + interface for TDD-014 |
| `server/lib/startup-checks.ts` | Create | `validateStartupConditions(config)` — runtime + path checks |
| `config/portal-defaults.json` | Modify | Add full default tree (port, auth_mode, logging, paths) |

## Implementation Details

### Task 1: `PortalConfig` Schema and Defaults

`config/portal-defaults.json`:

```json
{
  "port": 19280,
  "auth_mode": "localhost",
  "bind_host": null,
  "allowed_origins": [],
  "logging": { "level": "info" },
  "paths": {
    "state_dir": "~/.autonomous-dev",
    "logs_dir": "~/.autonomous-dev/logs",
    "user_config": "~/.autonomous-dev/config.json"
  },
  "shutdown": {
    "grace_period_ms": 10000,
    "force_timeout_ms": 15000
  }
}
```

`server/lib/config.ts`:

```ts
export type AuthMode = 'localhost' | 'tailscale' | 'oauth';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface PortalConfig {
  port: number;
  auth_mode: AuthMode;
  bind_host: string | null;          // explicit override, only honored when auth_mode !== 'localhost'
  allowed_origins: string[];
  logging: { level: LogLevel };
  paths: { state_dir: string; logs_dir: string; user_config: string };
  shutdown: { grace_period_ms: number; force_timeout_ms: number };
  oauth?: OAuthConfig;               // see oauth-extension.ts
}

export async function loadPortalConfig(): Promise<PortalConfig> {
  const defaults = (await import('../../config/portal-defaults.json', { assert: { type: 'json' } })).default as PortalConfig;
  const userPath = expandHome(process.env.PORTAL_USER_CONFIG ?? defaults.paths.user_config);
  const userOverrides = await loadUserConfig(userPath);
  const envOverrides = parseEnvOverrides();
  const merged = deepMerge(defaults, userOverrides, envOverrides);
  validateConfig(merged);
  return merged;
}
```

- `loadUserConfig(path)` MUST return `{}` if the file does not exist (NOT an error). Throw `PortalError('INVALID_CONFIG_SYNTAX', ...)` if it exists but contains invalid JSON.
- `deepMerge` is right-biased on objects, replacement on arrays/scalars. Implement inline (~25 LOC); no `lodash`.
- `expandHome(p)` replaces a leading `~` with `os.homedir()`.

### Task 2: Environment Overrides

`parseEnvOverrides()` in `server/lib/config.ts`:

| Env var | Type | Maps to | Validation |
|---|---|---|---|
| `PORTAL_PORT` | int | `port` | 1024–65535 |
| `PORTAL_AUTH_MODE` | enum | `auth_mode` | `localhost\|tailscale\|oauth` |
| `PORTAL_LOG_LEVEL` | enum | `logging.level` | `debug\|info\|warn\|error` |
| `PORTAL_BIND_HOST` | string | `bind_host` | Valid IPv4 or hostname |
| `PORTAL_USER_CONFIG` | path | (consumed before merge) | — |

Invalid env values throw `PortalError('INVALID_ENV_<VAR>', '...')` with the env value redacted from the message ONLY if it could plausibly contain credentials (apply the SPEC-013-2-02 sanitizer).

### Task 3: Binding Resolution and Validation

`server/lib/binding.ts`:

```ts
import { networkInterfaces } from 'node:os';
import { PortalError } from '../middleware/error-handler';
import type { PortalConfig } from './config';

export function resolveBindHostname(config: PortalConfig): string {
  if (config.auth_mode === 'localhost') return '127.0.0.1';
  if (config.auth_mode === 'tailscale') return resolveTailscaleAddress();
  if (config.auth_mode === 'oauth')     return config.bind_host ?? '0.0.0.0';
  throw new PortalError('INVALID_AUTH_MODE', `Unknown auth_mode: ${config.auth_mode}`, 500);
}

export async function validateBindingConfig(config: PortalConfig): Promise<void> {
  // 1. Localhost mode forbids any non-loopback bind_host.
  if (config.auth_mode === 'localhost' && config.bind_host && config.bind_host !== '127.0.0.1') {
    throw new PortalError(
      'BIND_HOST_DISALLOWED',
      `bind_host '${config.bind_host}' is not permitted in auth_mode=localhost. Use auth_mode=tailscale or auth_mode=oauth for non-loopback binds.`,
      500,
    );
  }

  // 2. Tailscale mode requires a Tailscale interface on this host.
  if (config.auth_mode === 'tailscale') {
    const tsAddr = resolveTailscaleAddress();
    if (!tsAddr) {
      throw new PortalError(
        'TAILSCALE_NOT_FOUND',
        'auth_mode=tailscale but no tailscale0 interface was found. Install Tailscale or change auth_mode.',
        500,
      );
    }
  }

  // 3. OAuth mode requires the extension to be registered (see oauth-extension.ts).
  if (config.auth_mode === 'oauth') {
    if (!isOAuthExtensionRegistered()) {
      throw new PortalError(
        'OAUTH_NOT_CONFIGURED',
        'auth_mode=oauth requires the OAuth+PKCE extension (TDD-014) to be registered before startup.',
        500,
      );
    }
  }

  // 4. Privileged-port check (Unix only).
  if (config.port < 1024 && process.getuid?.() !== 0) {
    throw new PortalError(
      'INSUFFICIENT_PRIVILEGES',
      `Port ${config.port} requires root privileges. Use a port >= 1024.`,
      500,
    );
  }

  // 5. Port availability probe.
  await checkPortAvailability(config.port, resolveBindHostname(config));
}

function resolveTailscaleAddress(): string {
  const ifaces = networkInterfaces();
  const ts = ifaces['tailscale0'];
  const v4 = ts?.find((i) => i.family === 'IPv4' && !i.internal);
  return v4?.address ?? '';
}

export async function checkPortAvailability(port: number, hostname: string): Promise<void> {
  try {
    const probe = Bun.serve({ port, hostname, fetch: () => new Response() });
    probe.stop(true);
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === 'EADDRINUSE') {
      throw new PortalError(
        'PORT_IN_USE',
        `Port ${port} on ${hostname} is already in use.`,
        500,
        { port, hostname },
      );
    }
    throw err;
  }
}
```

### Task 4: OAuth+PKCE Extension Hook

`server/lib/oauth-extension.ts`:

```ts
export interface OAuthConfig {
  authorize_url: string;
  token_url: string;
  client_id: string;
  redirect_uri: string;
  scopes: string[];
  pkce: { code_challenge_method: 'S256' };
}

export interface OAuthExtension {
  /** Registered by TDD-014 plans before `startServer()` runs. */
  attach(app: import('hono').Hono, config: OAuthConfig): void;
}

let registered: OAuthExtension | null = null;

export function registerOAuthExtension(ext: OAuthExtension): void {
  if (registered) throw new Error('OAuth extension already registered');
  registered = ext;
}

export function isOAuthExtensionRegistered(): boolean {
  return registered !== null;
}

export function getOAuthExtension(): OAuthExtension | null {
  return registered;
}
```

- This spec deliberately ships an EMPTY extension surface. The implementation of OAuth+PKCE flows belongs to TDD-014. The contract here is: `auth_mode === 'oauth'` MUST refuse to start unless an extension is registered, AND when registered, the extension is attached after the CORS middleware (the EXTENSION POINT in SPEC-013-2-02) by way of an integrator wiring inside `applyMiddlewareChain` (an additional hook that calls `getOAuthExtension()?.attach(app, config.oauth!)`).
- Add to `applyMiddlewareChain` (modifying SPEC-013-2-02 by 3 lines):
  ```ts
  // After CORS, before error boundary:
  const oauth = getOAuthExtension();
  if (oauth && config.oauth) oauth.attach(app, config.oauth);
  ```

### Task 5: Validation Rules (`server/lib/validation.ts`)

```ts
import { PortalError } from '../middleware/error-handler';
import type { PortalConfig } from './config';

export function validateConfig(c: PortalConfig): void {
  if (!Number.isInteger(c.port) || c.port < 1024 || c.port > 65535) {
    throw new PortalError('INVALID_CONFIG', `port must be integer in [1024, 65535], got ${c.port}`, 500);
  }
  if (!['localhost', 'tailscale', 'oauth'].includes(c.auth_mode)) {
    throw new PortalError('INVALID_CONFIG', `auth_mode must be one of localhost|tailscale|oauth`, 500);
  }
  if (!['debug', 'info', 'warn', 'error'].includes(c.logging.level)) {
    throw new PortalError('INVALID_CONFIG', `logging.level invalid`, 500);
  }
  if (!Array.isArray(c.allowed_origins) || c.allowed_origins.some((o) => typeof o !== 'string')) {
    throw new PortalError('INVALID_CONFIG', `allowed_origins must be string[]`, 500);
  }
  if (c.shutdown.grace_period_ms <= 0 || c.shutdown.force_timeout_ms <= c.shutdown.grace_period_ms) {
    throw new PortalError('INVALID_CONFIG', `shutdown.force_timeout_ms must exceed grace_period_ms`, 500);
  }
}
```

### Task 6: Startup Self-Check (`server/lib/startup-checks.ts`)

```ts
import { stat } from 'node:fs/promises';
import { PortalError } from '../middleware/error-handler';
import type { PortalConfig } from './config';

const MIN_BUN = '1.0.0';

export async function validateStartupConditions(config: PortalConfig): Promise<void> {
  // Bun version
  const v = Bun.version;
  if (compareSemver(v, MIN_BUN) < 0) {
    throw new PortalError('INCOMPATIBLE_RUNTIME', `Bun ${v} < required ${MIN_BUN}`, 500);
  }
  // State + logs dirs are accessible (read-write)
  for (const p of [config.paths.state_dir, config.paths.logs_dir]) {
    const expanded = expandHome(p);
    try {
      const s = await stat(expanded);
      if (!s.isDirectory()) {
        throw new PortalError('INVALID_STATE_PATH', `${expanded} exists but is not a directory`, 500);
      }
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === 'ENOENT') {
        throw new PortalError('MISSING_STATE_PATH', `${expanded} does not exist; run autonomous-dev install-daemon first`, 500);
      }
      if (e.code === 'EACCES') {
        throw new PortalError('STATE_PATH_ACCESS_DENIED', `Cannot access ${expanded}; check permissions`, 500);
      }
      throw err;
    }
  }
}
```

- `validateStartupConditions` is invoked from `startServer()` (SPEC-013-2-01) AFTER `loadPortalConfig` and BEFORE `validateBindingConfig`.

## Acceptance Criteria

- [ ] With default config, server binds to `127.0.0.1` and rejects `curl http://<lan-ip>:19280/health` (connection refused or timeout)
- [ ] Setting `bind_host: "0.0.0.0"` while `auth_mode: "localhost"` throws `PortalError('BIND_HOST_DISALLOWED', ...)` and exits 1
- [ ] Setting `auth_mode: "tailscale"` on a host without `tailscale0` throws `TAILSCALE_NOT_FOUND` and exits 1
- [ ] Setting `auth_mode: "tailscale"` on a host with `tailscale0` causes `resolveBindHostname` to return the IPv4 address of that interface
- [ ] Setting `auth_mode: "oauth"` without calling `registerOAuthExtension(...)` throws `OAUTH_NOT_CONFIGURED` and exits 1
- [ ] Setting `auth_mode: "oauth"` after `registerOAuthExtension(...)` allows startup; `getOAuthExtension().attach(app, config.oauth)` is called exactly once
- [ ] `PORTAL_PORT=8080 bun run server/server.ts` binds to port 8080 and logs `port: 8080` in `config_loaded`
- [ ] `PORTAL_PORT=foo` causes startup to fail with `INVALID_ENV_PORTAL_PORT`
- [ ] User config file with malformed JSON causes `INVALID_CONFIG_SYNTAX` with the file path in the message (path home-redacted)
- [ ] Missing user config file is handled silently (not an error)
- [ ] Port-in-use detection: starting two instances on the same port causes the second to fail with `PORT_IN_USE` and a non-zero exit
- [ ] `validateStartupConditions` rejects with `MISSING_STATE_PATH` when `~/.autonomous-dev/` does not exist
- [ ] `compareSemver('0.9.0', '1.0.0') < 0` and the server refuses to start on Bun < 1.0
- [ ] Configuration loading completes in < 50 ms for a typical run (measured via `performance.now()` around `loadPortalConfig`)

## Dependencies

- **Consumes**: `PortalError` from SPEC-013-2-02 (`server/middleware/error-handler.ts`).
- **Modifies**: `applyMiddlewareChain` from SPEC-013-2-02 to insert the OAuth attach call between CORS and the error boundary. The change is additive (3 lines) and documented at the EXTENSION POINT comment.
- **Exposes**: `loadPortalConfig`, `PortalConfig`, `resolveBindHostname`, `validateBindingConfig`, `validateStartupConditions`, `registerOAuthExtension`, `getOAuthExtension` — all consumed by `startServer()` (SPEC-013-2-01) and tests (SPEC-013-2-05).

## Notes

- The `tailscale` mode reads `tailscale0` from `os.networkInterfaces()`. On Linux/macOS this is the Tailscale-managed virtual interface; the Tailscale daemon assigns a 100.x.y.z address. We do not shell out to the `tailscale` CLI — the interface presence is the contract.
- The `oauth` extension hook (`registerOAuthExtension`) is a singleton register. TDD-014 owns the actual OAuth+PKCE flow, token storage, and session middleware. This spec ships only the contract: `auth_mode=oauth` requires the extension to be registered.
- We rely on Bun's `Bun.serve` for the port-availability probe. A short-lived listener that immediately stops is the most reliable cross-platform check; alternatives (`netstat`, `lsof`) are platform-dependent.
- Validation errors during config load throw `PortalError`. They are caught by the top-level `startServer().catch(...)` in SPEC-013-2-01, logged as `startup_failed`, and cause `process.exit(1)` — never a partial bind.
