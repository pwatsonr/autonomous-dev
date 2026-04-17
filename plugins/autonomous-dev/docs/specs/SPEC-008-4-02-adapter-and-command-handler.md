# SPEC-008-4-02: SlackAdapter & Slash Command Endpoint Handler

## Metadata
- **Parent Plan**: PLAN-008-4
- **Tasks Covered**: Task 4, Task 5, Task 11
- **Estimated effort**: 12 hours

## Description

Implement the core `SlackAdapter` class implementing `IntakeAdapter`, the slash command endpoint handler that routes all 10 commands with the 3-second acknowledgment + `response_url` follow-up pattern, and the Slack user identity mapping.

## Files to Create/Modify

| File | Action |
|------|--------|
| `intake/adapters/slack/slack_adapter.ts` | Create |
| `intake/adapters/slack/slack_command_handler.ts` | Create |
| `intake/adapters/slack/slack_identity.ts` | Create |

## Implementation Details

### Task 4: SlackAdapter Class

```typescript
class SlackAdapter implements IntakeAdapter {
  readonly channelType: ChannelType = 'slack';
  private server: SlackServer;
  private socketMode: SocketModeClient | null = null;

  constructor(
    private slackClient: SlackClient,
    private router: IntakeRouter,
    private identityResolver: SlackIdentityResolver,
    private formatter: SlackFormatter,
    private config: SlackConfig,
  ) {}

  async start(): Promise<AdapterHandle> {
    if (this.config.socket_mode) {
      this.socketMode = new SocketModeClient({ appToken: process.env.SLACK_APP_TOKEN! });
      await this.socketMode.start();
      this.setupSocketModeHandlers();
    } else {
      this.server = new SlackServer(...);
      await this.server.start(this.config.port);
    }

    await this.startupRecovery();
    return { dispose: () => this.shutdown() };
  }

  async sendMessage(target: MessageTarget, payload: FormattedMessage): Promise<DeliveryReceipt> {
    try {
      const web = this.slackClient.getClient();
      const method = target.isDM ? 'chat.postEphemeral' : 'chat.postMessage';
      const result = await web[method === 'chat.postEphemeral' ? 'chat' : 'chat'].postMessage({
        channel: target.platformChannelId!,
        blocks: payload.payload as SlackBlock[],
        text: payload.fallbackText,
        thread_ts: target.threadId,
        ...(target.isDM ? { user: target.userId! } : {}),
      });
      return { success: true, platformMessageId: result.ts };
    } catch (error) {
      const retryable = error.code === 'slack_webapi_platform_error' &&
        ['ratelimited', 'service_unavailable'].includes(error.data?.error);
      return { success: false, error: error.message, retryable };
    }
  }

  async promptUser(target: MessageTarget, prompt: StructuredPrompt): Promise<UserResponse | TimeoutExpired> {
    const web = this.slackClient.getClient();
    const blocks = this.buildPromptBlocks(prompt);
    const result = await web.chat.postMessage({
      channel: target.platformChannelId!,
      blocks,
      text: prompt.content,
      thread_ts: target.threadId,
    });

    // Wait for interaction response via interactionHandler
    // The interaction handler will resolve the pending promise
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          kind: 'timeout',
          requestId: prompt.requestId,
          promptedAt: new Date(),
          expiredAt: new Date(),
        });
      }, prompt.timeoutSeconds * 1000);

      this.pendingPrompts.set(prompt.requestId, { resolve, timer });
    });
  }

  async shutdown(): Promise<void> {
    if (this.socketMode) {
      await this.socketMode.disconnect();
    }
    if (this.server) {
      await this.server.stop();
    }
  }
}
```

### Task 5: Slash Command Endpoint Handler

```typescript
class SlackCommandHandler {
  constructor(
    private router: IntakeRouter,
    private identityResolver: SlackIdentityResolver,
    private formatter: SlackFormatter,
  ) {}

  async handle(req: express.Request, res: express.Response): Promise<void> {
    const body = req.body as URLSearchParams;
    const command = body.get('command')!;         // e.g., '/ad-submit'
    const text = body.get('text') ?? '';           // e.g., '"Build auth" --priority high'
    const userId = body.get('user_id')!;
    const channelId = body.get('channel_id')!;
    const triggerId = body.get('trigger_id')!;
    const responseUrl = body.get('response_url')!;

    // Strip '/ad-' prefix to get command name
    const commandName = command.replace('/ad-', '');

    // Resolve identity
    let internalUserId: string;
    try {
      internalUserId = await this.identityResolver.resolve(userId);
    } catch (error) {
      res.status(200).json({
        response_type: 'ephemeral',
        text: `Authorization error: ${error.message}`,
      });
      return;
    }

    // Parse text into args and flags (reuse Claude adapter arg parser)
    const { args, flags } = parseCommandArgs(text);

    // Construct IncomingCommand
    const incomingCommand: IncomingCommand = {
      commandName,
      args,
      flags,
      rawText: text,
      source: {
        channelType: 'slack',
        userId: internalUserId,
        platformChannelId: channelId,
        timestamp: new Date(),
      },
    };

    // Acknowledge within 3 seconds
    // Try to execute quickly; if it takes too long, acknowledge and follow up
    const startTime = Date.now();
    const FAST_THRESHOLD = 2500; // ms

    try {
      const result = await Promise.race([
        this.router.route(incomingCommand),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), FAST_THRESHOLD)),
      ]);

      if (result !== null) {
        // Fast path: respond inline
        const formatted = this.formatResult(commandName, result as CommandResult);
        res.status(200).json(formatted);
        return;
      }

      // Slow path: acknowledge and use response_url
      res.status(200).json({
        response_type: 'in_channel',
        text: 'Processing your request...',
      });

      // Continue processing and post to response_url
      const finalResult = await this.router.route(incomingCommand);
      const formatted = this.formatResult(commandName, finalResult);
      await fetch(responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formatted,
          replace_original: true,
        }),
      });
    } catch (error) {
      // Error within 3 seconds: respond inline
      if (Date.now() - startTime < 3000) {
        res.status(200).json({
          response_type: 'ephemeral',
          text: `Error: ${error.message}`,
        });
      } else {
        // Error after ack: post to response_url
        await fetch(responseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            response_type: 'ephemeral',
            text: `Error: ${error.message}`,
            replace_original: true,
          }),
        });
      }
    }
  }

  private formatResult(commandName: string, result: CommandResult): SlackResponse {
    if (result.success) {
      const blocks = this.formatter.formatStatusBlocks(result.data);
      return { response_type: 'in_channel', blocks, text: '' };
    } else {
      return {
        response_type: 'ephemeral',
        text: `Error: ${result.error}`,
      };
    }
  }
}
```

### Task 11: Slack User Identity Mapping

```typescript
class SlackIdentityResolver {
  private displayNameCache: Map<string, { name: string; fetchedAt: number }> = new Map();
  private CACHE_TTL = 3600_000; // 1 hour

  constructor(private db: Repository, private web: WebClient) {}

  async resolve(slackUserId: string): Promise<string> {
    const user = await this.db.getUserByPlatformId('slack', slackUserId);
    if (!user) {
      throw new AuthorizationError(
        `Slack user ${slackUserId} is not provisioned. ` +
        'Slack users must be added to intake-auth.yaml by an administrator.'
      );
    }
    return user.internal_id;
  }

  async resolveDisplayName(slackUserId: string): Promise<string> {
    const cached = this.displayNameCache.get(slackUserId);
    if (cached && Date.now() - cached.fetchedAt < this.CACHE_TTL) {
      return cached.name;
    }

    try {
      const result = await this.web.users.info({ user: slackUserId });
      const name = result.user?.real_name ?? result.user?.name ?? `Slack User ${slackUserId}`;
      this.displayNameCache.set(slackUserId, { name, fetchedAt: Date.now() });
      return name;
    } catch {
      return `Slack User ${slackUserId}`;
    }
  }
}
```

**Like Discord**: Slack users are NOT auto-provisioned. They must be pre-configured in `intake-auth.yaml`.

**Display name caching**: `users.info` results are cached for 1 hour to avoid excessive API calls.

## Acceptance Criteria

1. `SlackAdapter` implements all 4 `IntakeAdapter` methods.
2. `channelType` returns `'slack'`.
3. `start()` starts HTTP server (or Socket Mode if configured).
4. Slash command handler strips `/ad-` prefix to get command name.
5. Text is parsed into args and flags using the shared arg parser.
6. Fast commands (< 2.5s) respond inline with HTTP 200.
7. Slow commands acknowledge immediately, then post to `response_url`.
8. Error responses use `response_type: 'ephemeral'` (visible only to invoker).
9. Success responses use `response_type: 'in_channel'`.
10. Slack user identity requires pre-provisioning; unrecognized users get auth error.
11. Display name cached for 1 hour.

## Test Cases

1. **Command name extraction**: Verify `/ad-submit` -> `submit`, `/ad-kill` -> `kill`.
2. **Fast command inline response**: Mock router to return in 100ms; verify HTTP 200 with Block Kit response.
3. **Slow command response_url**: Mock router to return in 5s; verify HTTP 200 with acknowledgment, then POST to response_url.
4. **Error inline**: Mock router to throw in 100ms; verify ephemeral error response.
5. **Error after ack**: Mock router to throw in 5s; verify acknowledgment sent, then error posted to response_url.
6. **Identity: known user**: User in DB with slack_id; verify resolves to internal_id.
7. **Identity: unknown user**: User NOT in DB; verify `AuthorizationError` thrown.
8. **Display name: fresh lookup**: First call for user; verify `users.info` called and result cached.
9. **Display name: cache hit**: Second call within 1 hour; verify `users.info` NOT called.
10. **Display name: cache expired**: Call after 1 hour; verify `users.info` called again.
11. **Display name: API failure**: Mock `users.info` to throw; verify fallback "Slack User {id}".
12. **sendMessage: channel**: Verify `chat.postMessage` called with correct channel and blocks.
13. **sendMessage: ephemeral**: Verify `chat.postEphemeral` called when `isDM` is true.
14. **sendMessage: threaded**: Verify `thread_ts` set when `target.threadId` is provided.
15. **Args parsing**: Verify `"Build auth" --priority high` parsed correctly from Slack `text` field.
