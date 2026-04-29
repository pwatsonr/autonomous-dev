# SPEC-011-4-02: Slash Command Handler and Payload-to-IncomingCommand Mapping

## Metadata
- **Parent Plan**: PLAN-011-4
- **Tasks Covered**: Task 5 (3-second response budget + deferred response), Task 7 (config loading and validation — slash command portion)
- **Estimated effort**: 4 hours

## Description
Implement the slash command pipeline that maps Slack `application/x-www-form-urlencoded` payloads onto the shared `IncomingCommand` shape consumed by `IntakeRouter` (PLAN-011-1), and enforce the 3-second Slack acknowledgement budget using `Promise.race`. When the router exceeds 2.5s, the inline HTTP 200 returns an ephemeral acknowledgement and the final result is POSTed asynchronously to the Slack-supplied `response_url`. The mapping covers the 10 `/request-*` slash commands defined in `slack-app-manifest.yaml`. This spec writes the mapping logic in `main.ts`; the existing `SlackCommandHandler` provides the response-formatting plumbing.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `intake/adapters/slack/main.ts` | Modify | Add `mapSlashCommandPayload()` + `withResponseBudget()` + register handlers |

## Implementation Details

### Slash Command Inventory

The following 10 commands must be mapped (matching the manifest). Each maps to a router subcommand identical to the bash CLI (SPEC-011-1-01):

| Slack command | Router subcommand | Positional arg pattern |
|--------------|-------------------|------------------------|
| `/request-submit` | `submit` | `<description...>` |
| `/request-status` | `status` | `<REQ-id>` |
| `/request-list` | `list` | `[--state <state>]` |
| `/request-cancel` | `cancel` | `<REQ-id>` |
| `/request-pause` | `pause` | `<REQ-id>` |
| `/request-resume` | `resume` | `<REQ-id>` |
| `/request-priority` | `priority` | `<REQ-id> <high\|normal\|low>` |
| `/request-logs` | `logs` | `<REQ-id>` |
| `/request-feedback` | `feedback` | `<REQ-id> <msg...>` |
| `/request-kill` | `kill` | `<REQ-id>` |

### Payload-to-IncomingCommand Mapping

Implement `mapSlashCommandPayload(body, config) -> IncomingCommand`:

Slack delivers slash command bodies as URL-encoded form fields. The relevant keys:

| Slack field | Type | Use |
|-------------|------|-----|
| `command` | string (e.g., `/request-submit`) | derive `subcommand` |
| `text` | string (raw arg string) | tokenized into `args` |
| `user_id` | string (Uxxxxx) | `userId` |
| `user_name` | string | `userDisplay` |
| `team_id` | string (Txxxxx) | `workspaceId` |
| `team_domain` | string | `workspaceDomain` |
| `channel_id` | string (Cxxxxx or Dxxxxx) | `channelId` |
| `channel_name` | string | `channelName` |
| `response_url` | URL | `responseUrl` (for deferred reply) |
| `trigger_id` | string | `triggerId` (for modal opens) |
| `thread_ts` | string\|undefined | `threadTs` if present |

Mapping behavior:

1. Reject unknown commands not in the inventory: throw `Error("unknown_command: ${body.command}")` upstream of `withResponseBudget`.
2. Derive `subcommand = body.command.replace(/^\/request-/, '')`.
3. Tokenize `body.text` with the existing `parseCommandArgs` helper (already used by `SlackCommandHandler`); preserves quoted strings and rejects shell metacharacter injection.
4. Build:

```ts
const cmd: IncomingCommand = {
  channel: 'slack',
  subcommand,                     // 'submit' | 'status' | ...
  args,                           // string[]
  user: {
    id: body.user_id,
    display: body.user_name,
    workspaceId: body.team_id,
    workspaceDomain: body.team_domain,
  },
  context: {
    channelId: body.channel_id,
    channelName: body.channel_name,
    threadTs: body.thread_ts,
    isDM: body.channel_id.startsWith('D'),
  },
  reply: {
    responseUrl: body.response_url,
    triggerId: body.trigger_id,
  },
  receivedAt: Date.now(),
};
```

5. Validate `subcommand` is in the 10-command allowlist; throw `Error("invalid_subcommand")` otherwise.

### 3-Second Response Budget

Implement `withResponseBudget<T>(work: Promise<T>, deadlineMs: number, deferred: () => Promise<void>) -> Promise<T | 'deferred'>`:

```
withResponseBudget(work, deadlineMs, deferred) -> Promise<T | 'deferred'>
```

Behavior:

1. Set `deadlineMs = 2500` (500ms margin under Slack's 3000ms hard limit).
2. Race the work against a timer:
   - `winner = await Promise.race([work, sleep(deadlineMs).then(() => 'TIMEOUT')])`
3. If `winner !== 'TIMEOUT'`: return the resolved value directly.
4. If `winner === 'TIMEOUT'`:
   - Invoke `deferred()` (sends the inline ack — see below) and `await` it before returning.
   - Continue running `work` in the background. When it resolves, POST the final formatted result to `responseUrl`. When it rejects, POST a formatted error block.
   - Log `info("slack.response.deferred", { subcommand, elapsed_ms })`.
   - Return the sentinel `'deferred'`.

### Inline Ack (deferred path)

When the budget fires, the inline 200 response is:

```json
{
  "response_type": "ephemeral",
  "text": "Processing your request..."
}
```

Existing `SlackCommandHandler` already formats this — call its `respondAck(res)` method.

### Wiring the Pipeline

In `main.ts`, replace the direct `commandHandler.handle` registration with a wrapper:

```ts
async function handleSlashCommand(req, res) {
  let cmd: IncomingCommand;
  try {
    cmd = mapSlashCommandPayload(req.body, this.config);
  } catch (err) {
    return res.status(200).json({
      response_type: 'ephemeral',
      text: `Error: ${err.message}`,
    });
  }

  const work = this.deps.router.route(cmd);
  const result = await withResponseBudget(
    work,
    2500,
    async () => commandHandler.respondAck(res),
  );

  if (result !== 'deferred') {
    return commandHandler.respondInline(res, result);
  }
  // deferred path: ack already sent; background continuation handles response_url
  work.then(
    (r) => commandHandler.postToResponseUrl(cmd.reply.responseUrl, r),
    (err) => commandHandler.postErrorToResponseUrl(cmd.reply.responseUrl, err),
  );
}
```

### Config Validation (slash command portion of Task 7)

In `startSlackService()`, validate before starting:

- `config.port` is a positive integer (HTTP mode)
- `config.timestamp_tolerance_seconds` is in [60, 600]; default 300
- If `config.socket_mode === false`: `process.env.SLACK_BOT_TOKEN` and `process.env.SLACK_SIGNING_SECRET` must be set
- If `config.socket_mode === true`: `process.env.SLACK_APP_TOKEN` and `process.env.SLACK_BOT_TOKEN` must be set

Each missing value throws `Error("config: <key> is required")` listing the offending key. Do not log token values.

## Acceptance Criteria

- [ ] All 10 commands in the inventory map to the documented `subcommand` value
- [ ] `mapSlashCommandPayload` rejects commands not prefixed with `/request-` with `unknown_command`
- [ ] `mapSlashCommandPayload` populates `user`, `context`, and `reply` blocks per the table
- [ ] `mapSlashCommandPayload` sets `context.isDM` true iff `channel_id` starts with `D`
- [ ] Tokenization uses `parseCommandArgs` (no naive `.split(' ')`)
- [ ] `withResponseBudget` returns the work result when work resolves before 2500ms
- [ ] `withResponseBudget` calls `deferred()` and returns `'deferred'` when work exceeds 2500ms
- [ ] Deferred path continues running work and posts to `response_url` on resolve and reject
- [ ] Inline ack response uses `response_type: 'ephemeral'` and the literal text "Processing your request..."
- [ ] Config validation throws clear, key-named errors; never logs token values
- [ ] No token strings appear in any log statement (verified via grep at PR review)

## Dependencies

- SPEC-011-4-01: HTTP receiver and middleware pipeline
- PLAN-011-1: `IntakeRouter`, `IncomingCommand` shape, `parseCommandArgs`
- Existing `SlackCommandHandler` for `respondAck`, `respondInline`, `postToResponseUrl`, `postErrorToResponseUrl`

## Notes

- Slack enforces a 3000ms hard timeout on slash command HTTP responses — the 2500ms internal budget gives 500ms of margin for HTTP serialization and network jitter. Do not raise the budget closer to 3000ms.
- The `'deferred'` sentinel is intentional: returning the resolved value would race with the inline ack already on the wire. Sentinel branching keeps the response writing single-threaded.
- `parseCommandArgs` is the same helper used by the bash dispatcher (SPEC-011-1) — keeping a single tokenizer ensures error messages are consistent across channels.
- The `responseUrl` is workspace-scoped and bound to a 30-minute, 5-message window per Slack docs. Background continuations must complete promptly; timeouts on the work promise belong to the adapter (out of scope here).
- Slack DMs with the bot have `channel_id` starting with `D` (direct message channel); group DMs start with `G` and are NOT treated as DMs by this mapping (left in channel, no ephemeral fallback).
