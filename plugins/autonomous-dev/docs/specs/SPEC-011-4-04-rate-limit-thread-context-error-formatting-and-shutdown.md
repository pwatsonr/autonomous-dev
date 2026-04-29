# SPEC-011-4-04: Rate Limiting, Thread Context, Error Formatting, and Graceful Shutdown

## Metadata
- **Parent Plan**: PLAN-011-4
- **Tasks Covered**: Task 6 (graceful shutdown with 10s drain), Task 7 (config validation — rate limits portion), Task 8 (manifest finalization), Task 9 (systemd + launchd files), plus per-workspace rate limiting and thread context propagation
- **Estimated effort**: 4.5 hours

## Description
Add the cross-cutting service concerns to `SlackService`: per-workspace rate limiting via the existing `SlackRateLimiter`, thread context propagation through `IncomingCommand.context.threadTs` and outbound replies, normalized error formatting via Block Kit, and a graceful shutdown sequence with a 10-second drain budget covering adapter, Socket Mode, and HTTP server. Also finalize the deployment artifacts: the Slack app manifest YAML and systemd + launchd unit files for production deployment.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `intake/adapters/slack/main.ts` | Modify | Add `applyRateLimit()`, `formatError()`, `shutdown()`, signal handlers |
| `intake/adapters/slack/slack-app-manifest.yaml` | Modify | Finalize commands, scopes, event subscriptions |
| `intake/adapters/slack/systemd/autonomous-dev-slack.service` | Create | systemd unit with `After=`, restart policy, env file |
| `intake/adapters/slack/launchd/com.autonomous-dev.slack.plist` | Create | launchd plist with program args, working dir, env vars |

## Implementation Details

### Per-Workspace Rate Limiting

Wrap incoming commands with the existing `SlackRateLimiter` (from `slack_rate_limiter.ts`). Rate-limit BEFORE router dispatch, AFTER signature verification:

```ts
async function applyRateLimit(cmd: IncomingCommand): Promise<{ allowed: boolean; retryAfterMs?: number }> {
  return this.deps.rateLimiter.check({
    key: cmd.user.workspaceId,    // workspace-scoped, NOT user-scoped
    perMinute: this.config.rate_limits.perWorkspacePerMinute,
  });
}
```

In the slash command pipeline (SPEC-011-4-02), insert between mapping and budget:

```ts
const rl = await this.applyRateLimit(cmd);
if (!rl.allowed) {
  return res.status(200).json({
    response_type: 'ephemeral',
    text: `Workspace rate limit reached. Try again in ${Math.ceil(rl.retryAfterMs!/1000)}s.`,
  });
}
```

Rate-limit hits log `info("slack.ratelimit.hit", { workspaceId, retry_after_ms })` (no user PII).

Default config: `perWorkspacePerMinute: 60`. Override via `config.rate_limits.perWorkspacePerMinute`.

### Thread Context Propagation

When a slash command or interaction arrives in a thread (`thread_ts` present in payload), `IncomingCommand.context.threadTs` carries it (already specified in SPEC-011-4-02). The `SlackAdapter`'s outbound `chat.postMessage` already accepts `thread_ts`; ensure the service passes `cmd.context.threadTs` into:

1. `commandHandler.respondInline()` — the inline 200 ALREADY responds in-thread automatically because Slack sources the response from the original payload; no action needed.
2. `commandHandler.postToResponseUrl()` — `response_url` ALSO threads automatically; no action needed.
3. Adapter-initiated posts (clarifying prompts, status updates from background work): the adapter's `postMessage()` is called with `target: { channelId, threadTs }`. The service does NOT need to add anything; `mapSlashCommandPayload` already populates `context.threadTs`.

The acceptance criterion is that the field is wired through to outbound posts when present.

### Error Formatting

Implement `formatError(err: Error, requestId?: string): SlackResponse`:

```ts
{
  response_type: 'ephemeral',
  text: 'An error occurred',
  blocks: [
    { type: 'section', text: { type: 'mrkdwn', text: `:warning: *${userMessage}*` } },
    requestId
      ? { type: 'context', elements: [{ type: 'mrkdwn', text: `Request: \`${requestId}\`` }] }
      : null,
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Error code: \`${errorCode}\`` }] },
  ].filter(Boolean),
}
```

`userMessage` and `errorCode` derivation:

| `err.code` (or message classifier) | `userMessage` | `errorCode` |
|------------------------------------|--------------|-------------|
| `INVALID_REQUEST_ID` | `Invalid request ID. Format: REQ-NNNNNN` | `INVALID_REQUEST_ID` |
| `UNKNOWN_REQUEST` | `That request was not found.` | `UNKNOWN_REQUEST` |
| `RATE_LIMITED` | `Too many requests. Please slow down.` | `RATE_LIMITED` |
| `UNAUTHORIZED` | `You are not authorized for that operation.` | `UNAUTHORIZED` |
| `TIMEOUT` | `The operation timed out. It may still complete in the background.` | `TIMEOUT` |
| (default — unmapped) | `Something went wrong. Please contact your operator.` | `INTERNAL_ERROR` |

Stack traces and raw `err.message` MUST NOT appear in the user-visible blocks. Internal logging captures the full error: `logger.error("slack.command.error", { code: errorCode, stack: err.stack, ... })`.

### Graceful Shutdown

Implement `shutdown(): Promise<void>`:

```ts
async shutdown(): Promise<void> {
  if (this.shuttingDown) return;
  this.shuttingDown = true;

  const drainMs = this.config.shutdown_drain_ms ?? 10000;
  const force = setTimeout(() => {
    this.deps.logger.warn("slack.shutdown.forced", { drain_ms: drainMs });
    process.exit(1);
  }, drainMs);
  force.unref();

  try {
    // 1. Stop accepting new requests (close listening socket but keep in-flight)
    if (this.httpServer) await stopAccepting(this.httpServer);

    // 2. Disconnect Socket Mode (rejects new events; in-flight handlers continue)
    if (this.deps.socketModeClient) await this.deps.socketModeClient.disconnect();

    // 3. Wait for in-flight router dispatches to drain
    await this.deps.adapter.drain();   // existing adapter method

    // 4. Fully close HTTP server
    if (this.httpServer) await new Promise<void>((res, rej) =>
      this.httpServer!.close((e) => e ? rej(e) : res()));

    clearTimeout(force);
    this.deps.logger.info("slack.shutdown.graceful");
    process.exit(0);
  } catch (err) {
    this.deps.logger.error("slack.shutdown.error", { error: (err as Error).message });
    clearTimeout(force);
    process.exit(1);
  }
}
```

`stopAccepting(server)` returns a Promise that resolves once `server.close()` stops accepting NEW connections (the standard `http.Server.close` already does this — it lets in-flight requests finish and only "closes" once they all complete; we wrap that in step 4 explicitly).

### Signal Handlers

In `startSlackService()`:

```ts
process.on('SIGTERM', () => service.shutdown());
process.on('SIGINT', () => service.shutdown());
process.on('uncaughtException', (err) => {
  logger.error("slack.uncaught", { error: err.message, stack: err.stack });
  service.shutdown();
});
```

Each handler is idempotent because `shutdown()` is guarded by `this.shuttingDown`. Multiple signals do not cause concurrent shutdowns.

### Manifest Finalization

`slack-app-manifest.yaml`:

```yaml
display_information:
  name: Autonomous Dev
  description: Submit and manage autonomous development requests
  background_color: "#1a1a1a"
features:
  bot_user:
    display_name: autonomous-dev
    always_online: true
  slash_commands:
    - command: /request-submit
      description: Submit a new development request
      usage_hint: "<description>"
    # ... 9 more (status, list, cancel, pause, resume, priority, logs, feedback, kill)
  interactivity:
    is_enabled: true
    request_url: https://${HOST}/slack/interactions
oauth_config:
  scopes:
    bot:
      - chat:write
      - chat:write.public
      - commands
      - app_mentions:read
      - users:read
settings:
  event_subscriptions:
    request_url: https://${HOST}/slack/events
    bot_events:
      - app_mention
  socket_mode_enabled: false   # operator toggles for Socket Mode deployment
```

`${HOST}` is a placeholder for operator substitution (documented in adjacent README).

### systemd Unit (`autonomous-dev-slack.service`)

```ini
[Unit]
Description=Autonomous-Dev Slack Adapter
After=network.target autonomous-dev-orchestrator.service
Requires=autonomous-dev-orchestrator.service

[Service]
Type=simple
User=autonomous-dev
WorkingDirectory=/opt/autonomous-dev
EnvironmentFile=/etc/autonomous-dev/slack.env
ExecStart=/usr/bin/node /opt/autonomous-dev/intake/adapters/slack/main.js
Restart=on-failure
RestartSec=5s
TimeoutStopSec=15s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

`TimeoutStopSec=15s` provides 5s margin over the 10s in-process drain.

### launchd Plist (`com.autonomous-dev.slack.plist`)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>com.autonomous-dev.slack</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/bin/node</string>
      <string>/opt/autonomous-dev/intake/adapters/slack/main.js</string>
    </array>
    <key>WorkingDirectory</key><string>/opt/autonomous-dev</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>NODE_ENV</key><string>production</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>/var/log/autonomous-dev/slack.out.log</string>
    <key>StandardErrorPath</key><string>/var/log/autonomous-dev/slack.err.log</string>
  </dict>
</plist>
```

Operators source `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN` via a launchd `EnvironmentVariables` extension or a wrapper script (documented externally).

## Acceptance Criteria

- [ ] Rate-limit check is workspace-scoped (key = `team_id`), runs after signature verify and before router dispatch
- [ ] Rate-limit hit returns `200` ephemeral with `Try again in <N>s` text and logs without user PII
- [ ] `IncomingCommand.context.threadTs` is populated whenever the inbound payload includes `thread_ts`
- [ ] `formatError` produces ephemeral Block Kit responses; never includes stack traces or raw error messages in user-visible text
- [ ] All 6 mapped error codes produce the documented `userMessage`; unmapped errors fall back to `INTERNAL_ERROR`
- [ ] `shutdown()` sequence is: stop-accepting → Socket Mode disconnect → adapter drain → HTTP close
- [ ] `shutdown()` is idempotent; concurrent SIGTERM/SIGINT do not double-run
- [ ] 10s drain timeout fires `process.exit(1)` with a `slack.shutdown.forced` log; graceful path exits 0
- [ ] `uncaughtException` triggers `shutdown()` with full error logged
- [ ] `slack-app-manifest.yaml` declares all 10 slash commands, all required scopes, and `interactivity.is_enabled: true`
- [ ] `autonomous-dev-slack.service` has `After=` and `Requires=` for the orchestrator and `TimeoutStopSec=15s`
- [ ] `com.autonomous-dev.slack.plist` is valid plist XML with `RunAtLoad` and `KeepAlive`
- [ ] No tokens or signing secrets appear in any log line, manifest, unit file, or plist (verified by grep at PR review)

## Dependencies

- SPEC-011-4-01: HTTP receiver, signature middleware, mode dispatch
- SPEC-011-4-02: `IncomingCommand` mapping (provides `context.threadTs` field)
- SPEC-011-4-03: Block Kit builders (used indirectly via error formatting)
- Existing `SlackRateLimiter` (`slack_rate_limiter.ts`)
- Existing `SlackAdapter.drain()`
- TDD-011 §8.4 deployment guidance

## Notes

- Workspace-scoped rate limiting (NOT per-user) is intentional: a single user spamming a workspace would otherwise lock everyone out, and operators have already demonstrated trust at the workspace install level. Per-user limits are out of scope.
- The shutdown order — stop-accepting first, drain second, close last — prevents the race where a request arrives during teardown and is half-handled. Socket Mode disconnect specifically returns immediately and lets in-flight events drain through the adapter.
- `force.unref()` is critical: without it, the force-shutdown timer keeps the event loop alive and the graceful path never gets to call `process.exit(0)`.
- Mapped error codes are deliberately user-facing and stable. Adding a new error code requires updating both this spec and the i18n table; do not embed `err.message` directly into user-visible text.
- The systemd `Requires=` (rather than `Wants=`) makes orchestrator failure stop the Slack service, avoiding the case where slash commands accept work that the orchestrator cannot service.
- Manifest `request_url` substitution via `${HOST}` is a documentation placeholder. Slack does not interpret `${HOST}` — operators must replace before pasting into the Slack app config UI; the README adjacent to the manifest will document this.
