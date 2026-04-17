# SPEC-008-3-02: DiscordAdapter, Interaction Flow & Identity Resolution

## Metadata
- **Parent Plan**: PLAN-008-3
- **Tasks Covered**: Task 3, Task 4, Task 10
- **Estimated effort**: 11 hours

## Description

Implement the core `DiscordAdapter` class that implements `IntakeAdapter`, the interaction deferral and response editing pattern required by Discord's 3-second deadline, and the Discord user identity mapping that resolves Discord user IDs to internal identities.

## Files to Create/Modify

| File | Action |
|------|--------|
| `intake/adapters/discord/discord_adapter.ts` | Create |
| `intake/adapters/discord/discord_identity.ts` | Create |

## Implementation Details

### Task 3: DiscordAdapter Class

```typescript
class DiscordAdapter implements IntakeAdapter {
  readonly channelType: ChannelType = 'discord';
  private discordClient: DiscordClient;
  private shuttingDown = false;
  private inFlightInteractions = 0;

  constructor(
    private client: DiscordClient,
    private router: IntakeRouter,
    private identityResolver: DiscordIdentityResolver,
    private formatter: DiscordFormatter,
    private componentHandler: ComponentInteractionHandler,
  ) {}

  async start(): Promise<AdapterHandle> {
    await this.client.connect();
    const guildId = process.env.DISCORD_GUILD_ID!;
    await registerCommands(this.client.getClient(), guildId);
    this.setupInteractionListener();
    return { dispose: () => this.shutdown() };
  }

  async sendMessage(target: MessageTarget, payload: FormattedMessage): Promise<DeliveryReceipt> {
    try {
      const channel = await this.resolveChannel(target);
      const msg = await channel.send({
        embeds: payload.payload ? [payload.payload] : undefined,
        content: payload.fallbackText,
      });
      return { success: true, platformMessageId: msg.id };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        retryable: error.status === 429 || error.status >= 500,
      };
    }
  }

  async promptUser(target: MessageTarget, prompt: StructuredPrompt): Promise<UserResponse | TimeoutExpired> {
    const channel = await this.resolveChannel(target);
    // Build message with optional button components
    const components = prompt.options
      ? [this.buildOptionButtons(prompt.options)]
      : [];
    const msg = await channel.send({
      content: prompt.content,
      components,
    });

    // Wait for button interaction or message reply
    try {
      const collected = await msg.awaitMessageComponent({
        filter: (i) => i.user.id === target.userId,
        time: prompt.timeoutSeconds * 1000,
      });
      return {
        responderId: collected.user.id,
        content: collected.customId,
        selectedOption: collected.customId,
        timestamp: new Date(),
      };
    } catch {
      return {
        kind: 'timeout',
        requestId: prompt.requestId,
        promptedAt: new Date(msg.createdTimestamp),
        expiredAt: new Date(),
      };
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const deadline = Date.now() + 10_000;
    while (this.inFlightInteractions > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }
    await this.client.disconnect();
  }
}
```

### Task 4: Interaction Deferral and Response Editing

Discord requires acknowledging interactions within 3 seconds. The flow:

```typescript
private setupInteractionListener(): void {
  this.client.getClient().on(Events.InteractionCreate, async (interaction) => {
    if (this.shuttingDown) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: 'System is shutting down.', ephemeral: true });
      }
      return;
    }

    if (interaction.isChatInputCommand()) {
      await this.handleSlashCommand(interaction);
    } else if (interaction.isMessageComponent()) {
      await this.componentHandler.handle(interaction);
    } else if (interaction.isModalSubmit()) {
      await this.componentHandler.handleModalSubmit(interaction);
    }
  });
}

private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  this.inFlightInteractions++;
  try {
    // Step 1: IMMEDIATELY defer (must happen within 3 seconds)
    await interaction.deferReply();

    // Step 2: Extract subcommand and options
    const subcommand = interaction.options.getSubcommand();
    const args = this.extractArgs(interaction, subcommand);
    const flags = this.extractFlags(interaction, subcommand);

    // Step 3: Resolve identity
    const userId = await this.identityResolver.resolve(interaction.user.id);

    // Step 4: Construct IncomingCommand
    const command: IncomingCommand = {
      commandName: subcommand,
      args,
      flags,
      rawText: interaction.toString(),
      source: {
        channelType: 'discord',
        userId,
        platformChannelId: interaction.channelId,
        timestamp: new Date(),
      },
    };

    // Step 5: Route through IntakeRouter
    const result = await this.router.route(command);

    // Step 6: Edit the deferred response
    if (result.success) {
      const formatted = this.formatter.formatStatusEmbed(result.data);
      await interaction.editReply({ embeds: [formatted] });
    } else {
      await interaction.editReply({ content: `Error: ${result.error}` });
    }
  } catch (error) {
    // Handle interaction expiry (15-minute Discord limit)
    try {
      await interaction.editReply({ content: 'An error occurred processing your command.' });
    } catch {
      logger.warn('Failed to edit expired interaction');
    }
  } finally {
    this.inFlightInteractions--;
  }
}
```

**Interaction expiry handling**: Discord interaction tokens expire after 15 minutes. If the router takes longer (unlikely but possible for complex submissions with NLP parsing + duplicate detection), the `editReply` will fail. The catch block logs a warning.

**Argument extraction from Discord interaction:**

```typescript
private extractArgs(interaction: ChatInputCommandInteraction, subcommand: string): string[] {
  switch (subcommand) {
    case 'submit':
      return [interaction.options.getString('description', true)];
    case 'status':
    case 'cancel':
    case 'pause':
    case 'resume':
    case 'logs':
      return [interaction.options.getString('request-id', true)];
    case 'priority':
      return [
        interaction.options.getString('request-id', true),
        interaction.options.getString('level', true),
      ];
    case 'feedback':
      return [
        interaction.options.getString('request-id', true),
        interaction.options.getString('message', true),
      ];
    case 'list':
    case 'kill':
      return [];
    default:
      return [];
  }
}
```

### Task 10: Discord User Identity Mapping

```typescript
class DiscordIdentityResolver {
  constructor(private db: Repository, private guild: Guild) {}

  async resolve(discordUserId: string): Promise<string> {
    const user = await this.db.getUserByPlatformId('discord', discordUserId);
    if (!user) {
      throw new AuthorizationError(
        `Discord user ${discordUserId} is not provisioned. ` +
        'Discord users must be added to intake-auth.yaml by an administrator.'
      );
    }
    return user.internal_id;
  }

  async resolveDisplayName(discordUserId: string): Promise<string> {
    try {
      const member = await this.guild.members.fetch(discordUserId);
      return member.displayName;
    } catch {
      return `Discord User ${discordUserId}`;
    }
  }
}
```

**Key difference from Claude App**: Discord users are NOT auto-provisioned. They must be pre-configured in `intake-auth.yaml` with their `discord_id`. Unrecognized users receive an authorization error.

## Acceptance Criteria

1. `DiscordAdapter` implements all 4 `IntakeAdapter` methods.
2. `channelType` returns `'discord'`.
3. Slash command interactions are deferred within the event handler (before any processing).
4. Deferred response is edited with the formatted result after processing.
5. Expired interactions (15-minute) are handled gracefully without crashing.
6. `sendMessage` sends embeds to the resolved channel and returns a `DeliveryReceipt`.
7. `promptUser` sends buttons and waits for interaction; returns `TimeoutExpired` on timeout.
8. `shutdown()` waits for in-flight interactions and disconnects the gateway.
9. Discord user identity requires pre-provisioning; unrecognized users get an auth error.
10. Display name resolved via guild member fetch with graceful fallback.

## Test Cases

1. **Interaction deferral**: Mock interaction; verify `deferReply()` called before any router invocation.
2. **Successful command flow**: Mock interaction for `/ad status REQ-000001`; verify `deferReply()` called, router receives correct `IncomingCommand`, `editReply()` called with embed.
3. **Router error**: Mock router to return error; verify `editReply()` called with error text content (not embed).
4. **Interaction expiry**: Mock `editReply()` to throw DiscordAPIError; verify error logged and no crash.
5. **Argument extraction: submit**: Mock interaction with `description` option; verify args = `[description]`.
6. **Argument extraction: priority**: Mock interaction with `request-id` and `level`; verify args = `[id, level]`.
7. **Argument extraction: kill**: Mock interaction for kill; verify args = `[]`.
8. **Identity: known user**: User in DB with discord_id; resolve returns internal_id.
9. **Identity: unknown user**: User NOT in DB; resolve throws `AuthorizationError`.
10. **Display name: resolved**: Guild member fetch succeeds; returns display name.
11. **Display name: fallback**: Guild member fetch fails; returns "Discord User {id}".
12. **Shutdown during interaction**: Start processing an interaction, call shutdown; verify waits for completion.
13. **Reject during shutdown**: Set shuttingDown, receive new interaction; verify ephemeral "System is shutting down" reply.
14. **sendMessage success**: Mock channel.send() to succeed; verify `DeliveryReceipt.success = true` with message ID.
15. **sendMessage retryable error**: Mock channel.send() to throw 429; verify `retryable: true`.
