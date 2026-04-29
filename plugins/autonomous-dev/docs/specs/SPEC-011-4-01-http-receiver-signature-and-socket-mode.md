# SPEC-011-4-01: HTTP Receiver, Signature Verification, and Socket Mode

## Metadata
- **Parent Plan**: PLAN-011-4
- **Tasks Covered**: Task 1 (scaffold SlackService), Task 2 (HTTP receiver), Task 3 (signature middleware), Task 4 (Socket Mode)
- **Estimated effort**: 7 hours

## Description
Scaffold the `SlackService` class at `intake/adapters/slack/main.ts` with dual-mode operation. Implement an Express-based HTTP receiver bound to `/slack/events`, `/slack/commands`, `/slack/interactions`, and `/health`, gated by an HMAC-SHA256 signature middleware that uses `crypto.timingSafeEqual` and rejects timestamps older than 5 minutes. Implement an alternative Socket Mode startup path using `@slack/socket-mode` for environments without a public endpoint. Mode selection is driven by `config.socket_mode` and per-mode environment variables. Existing helpers (`SlackVerifier`, `SlackServer`, `SlackSocketMode`) are wired in via constructor injection — this spec orchestrates lifecycle but delegates protocol details.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `intake/adapters/slack/main.ts` | Create | `SlackService` class + `startSlackService()` skeleton |

## Implementation Details

### Task 1: SlackService Scaffold

Define the class shape with constructor injection:

```ts
export interface SlackServiceDeps {
  router: IntakeRouter;                  // shared router (PLAN-011-1)
  adapter: SlackAdapter;                 // existing
  verifier: SlackVerifier;               // existing
  commandHandler: SlackCommandHandler;   // existing
  interactionHandler: SlackInteractionHandler; // existing
  socketModeClient?: SocketModeClient;   // optional, only for Socket Mode
  logger: SlackServiceLogger;
}

export interface SlackServiceConfig {
  socket_mode: boolean;                  // default false
  port: number;                          // HTTP mode
  timestamp_tolerance_seconds: number;   // default 300
  rate_limits: { perWorkspacePerMinute: number };
  shutdown_drain_ms: number;             // default 10000
}

export class SlackService {
  constructor(private deps: SlackServiceDeps, private config: SlackServiceConfig) {}
  async start(): Promise<void> { /* dispatch to mode */ }
  async shutdown(): Promise<void> { /* SPEC-011-4-04 */ }
  private async startHttpMode(): Promise<void>;
  private async startSocketMode(): Promise<void>;
}
```

Export `startSlackService(config, router): Promise<SlackService>` factory that constructs all defaults from env, instantiates dependencies, calls `start()`, registers SIGTERM/SIGINT handlers (handler bodies in SPEC-011-4-04), and returns the running service.

### Task 2: HTTP Receiver

Inside `startHttpMode()`:

1. Create an Express app: `const app = express()`.
2. Mount JSON parser scoped to `/slack/events` only: `app.use('/slack/events', express.json({ verify: captureRawBody }))`.
3. Mount URL-encoded parser scoped to `/slack/commands` and `/slack/interactions`: `app.use(['/slack/commands','/slack/interactions'], express.urlencoded({ extended: true, verify: captureRawBody }))`.
4. The `captureRawBody` verify hook stores `req.rawBody = buf.toString('utf8')` for downstream signature verification (Task 3).
5. Apply the signature middleware (Task 3) to the path prefix `/slack`.
6. Register the existing `SlackServer` route handlers:
   - `POST /slack/commands` → `commandHandler.handle`
   - `POST /slack/interactions` → `interactionHandler.handle`
   - `POST /slack/events` → URL verification challenge: if `req.body.type === 'url_verification'` respond `{ challenge: req.body.challenge }`; otherwise dispatch to event router.
7. Register `GET /health` returning `200 { status: 'ok', mode: 'http', uptime_ms }`.
8. Bind: `this.httpServer = app.listen(this.config.port)`. Log `info("slack.http.listening", { port })`.

### Task 3: Signature Verification Middleware

Implement `verifySlackSignatureMiddleware(verifier, logger)`:

```
verifySlackSignatureMiddleware(req, res, next) -> void
```

Steps:
1. Extract `timestamp = req.header('X-Slack-Request-Timestamp')` and `sig = req.header('X-Slack-Signature')`.
2. If either header missing: `res.status(401).json({ error: 'missing_signature_headers' })`; log `warn("slack.sig.missing_headers", { ip: req.ip, path: req.path })`; return.
3. If `Math.abs(Date.now()/1000 - Number(timestamp)) > config.timestamp_tolerance_seconds`: `401 { error: 'timestamp_expired' }`; log `warn("slack.sig.timestamp_expired", { ip, timestamp, drift_seconds })`.
4. Compute `basestring = ` `${'v0:'}${timestamp}:${req.rawBody}`.
5. Delegate to `verifier.verify(basestring, sig)` (existing). On `false`: `401 { error: 'bad_signature' }`; log `warn("slack.sig.invalid", { ip, path })`.
6. On success: `next()`.

The middleware MUST NOT log or echo the rejected signature value.

### Task 4: Socket Mode

Inside `startSocketMode()`:

1. Validate `process.env.SLACK_APP_TOKEN` is present (xapp-token); otherwise throw `Error("SLACK_APP_TOKEN required for Socket Mode")`.
2. If `deps.socketModeClient` is not injected, construct one: `new SocketModeClient({ appToken: process.env.SLACK_APP_TOKEN!, logLevel })`.
3. Register handlers (delegated to existing `SlackSocketMode` helper):
   - `slash_commands` → wrap `commandHandler.handle` with the same `IncomingCommand` mapping used in HTTP mode (Slack delivers slash command payloads with the same shape).
   - `interactive` → wrap `interactionHandler.handle`.
   - `events_api` → no-op for now (URL verification is HTTP-only).
4. Wire structured logging:
   - `client.on('connecting')` → `logger.info("slack.socket.connecting")`
   - `client.on('connected')` → `logger.info("slack.socket.connected")`
   - `client.on('disconnected', e)` → `logger.warn("slack.socket.disconnected", { reason: e })`
   - `client.on('error', e)` → `logger.error("slack.socket.error", { error: e.message })`
5. Call `await client.start()`. Store the reference for `shutdown()`.
6. Skip starting the HTTP server in this mode (no `/slack/*` exposure); still start a minimal HTTP server for `/health` only on `config.port`. Log `info("slack.socket.health_only", { port })`.

### Mode Dispatch

Inside `start()`:

```
if (this.config.socket_mode) await this.startSocketMode();
else await this.startHttpMode();
```

## Acceptance Criteria

- [ ] `SlackService` class exported from `main.ts` with constructor injection of all `SlackServiceDeps`
- [ ] `start()` selects HTTP or Socket Mode based on `config.socket_mode`
- [ ] HTTP mode binds Express to `config.port` and registers `/slack/events`, `/slack/commands`, `/slack/interactions`, `/health`
- [ ] Signature middleware rejects requests missing `X-Slack-Request-Timestamp` or `X-Slack-Signature` with 401 `missing_signature_headers`
- [ ] Signature middleware rejects timestamps drifting >300s with 401 `timestamp_expired`
- [ ] Signature middleware rejects bad HMAC with 401 `bad_signature` (timing-safe via `verifier.verify`)
- [ ] Rejected signature value is never logged or echoed in response body
- [ ] Socket Mode requires `SLACK_APP_TOKEN`; missing token throws clear error
- [ ] Socket Mode registers slash_commands, interactive, events_api handlers and emits connect/disconnect/error logs
- [ ] Socket Mode still exposes `/health` on `config.port` (no `/slack/*` routes)
- [ ] URL verification challenge for `/slack/events` returns the `challenge` echo
- [ ] `tsc --strict` passes; no `any` in public signatures

## Dependencies

- Existing `SlackVerifier` (`slack_verifier.ts`) — used by middleware; this spec adds the Express adapter only
- Existing `SlackServer` route layout (`slack_server.ts`) — handlers reused
- Existing `SlackCommandHandler`, `SlackInteractionHandler` — wired through constructor injection
- Existing `SlackSocketMode` helper — wraps `@slack/socket-mode` event registration
- Shared `IntakeRouter` from PLAN-011-1
- npm: `express` (already in deps), `@slack/socket-mode` (verify in `package.json`)

## Notes

- The existing `SlackServer` already implements signature verification internally for some paths; the middleware here is the canonical gate. The wired handlers MUST receive already-verified requests — do not double-verify in handlers.
- `req.rawBody` capture is intentional: `express.json` and `express.urlencoded` discard the original bytes after parsing, which breaks HMAC. The `verify` callback is the only safe hook.
- Socket Mode `/health` is exposed because container orchestration probes still need a TCP target even without public Slack ingress.
- Body-parser scoping is critical: events use JSON, commands/interactions use URL-encoded. Mounting both globally would cause Slack signature mismatches on commands.
- This spec deliberately leaves shutdown empty — see SPEC-011-4-04. Lifecycle wiring (signal handlers, drain) belongs there to keep concerns separated.
