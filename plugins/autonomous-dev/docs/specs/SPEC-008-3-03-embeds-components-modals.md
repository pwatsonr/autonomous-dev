# SPEC-008-3-03: Discord Embed Formatter, Button Components & Modal Forms

## Metadata
- **Parent Plan**: PLAN-008-3
- **Tasks Covered**: Task 5, Task 6, Task 7, Task 8
- **Estimated effort**: 12 hours

## Description

Implement the Discord rich embed formatter with color-coded status phases, button components for kill/cancel confirmations with authorization validation, the `ComponentInteractionHandler` for routing button clicks, and modal forms for complex submissions.

## Files to Create/Modify

| File | Action |
|------|--------|
| `intake/notifications/formatters/discord_formatter.ts` | Create |
| `intake/adapters/discord/discord_components.ts` | Create |
| `intake/adapters/discord/discord_interaction_handler.ts` | Create |

## Implementation Details

### Task 5: Discord Embed Formatter

**Phase color map (decimal values for Discord embeds):**

```typescript
const PHASE_COLORS: Record<string, number> = {
  queued:         0x95a5a6,  // Gray
  prd_generation: 0x3498db,  // Blue
  prd_review:     0xe67e22,  // Orange
  tdd_generation: 0x3498db,  // Blue
  tdd_review:     0xe67e22,  // Orange
  planning:       0x9b59b6,  // Purple
  spec:           0x9b59b6,  // Purple
  execution:      0x2ecc71,  // Green
  code_review:    0xe67e22,  // Orange
  merged:         0x27ae60,  // Dark green
  done:           0x2ecc71,  // Green
  paused:         0xf39c12,  // Yellow
  cancelled:      0xe74c3c,  // Red
  failed:         0xe74c3c,  // Red
};
```

**`formatStatusEmbed` return value:**

```typescript
{
  title: `${request.request_id}: ${truncate(request.title, 50)}`,
  color: PHASE_COLORS[request.current_phase] ?? 0x95a5a6,
  fields: [
    { name: 'Phase', value: formatPhase(request.current_phase), inline: true },
    { name: 'Priority', value: request.priority, inline: true },
    { name: 'Progress', value: formatProgress(request), inline: true },
    { name: 'Age', value: formatDuration(Date.now() - new Date(request.created_at).getTime()), inline: true },
    { name: 'Blocker', value: request.blocker ?? 'None', inline: true },
  ],
  footer: { text: `Requested by ${request.requester_display_name}` },
  timestamp: request.updated_at,
}
```

**Additional methods:**
- `formatPhaseTransition(request, event)`: Embed with "Phase Change" title, from/to fields, new color.
- `formatDigest(digest)`: Embed with summary fields (active count, blocked, completed 24h, queue depth by priority). Paginate if > 6000 characters.
- `formatError(error)`: Embed with red color, error code in title, message in description.

**Title truncation**: Truncate at 50 characters, append "..." if truncated.

### Task 6: Button Components

**Kill confirmation:**

```typescript
function buildKillConfirmation(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('kill_confirm')
      .setLabel('CONFIRM KILL ALL')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('kill_cancel')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );
}
```

**Cancel confirmation:**

```typescript
function buildCancelConfirmation(requestId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`cancel_confirm_${requestId}`)
      .setLabel('Confirm Cancel')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`cancel_cancel_${requestId}`)
      .setLabel('Keep Request')
      .setStyle(ButtonStyle.Secondary),
  );
}
```

**Custom ID pattern**: `{action}_{confirm|cancel}[_{requestId}]`. The request ID is embedded in the custom ID for cancel confirmations.

### Task 7: ComponentInteractionHandler

```typescript
class ComponentInteractionHandler {
  constructor(
    private router: IntakeRouter,
    private identityResolver: DiscordIdentityResolver,
    private authz: AuthzEngine,
  ) {}

  async handle(interaction: MessageComponentInteraction): Promise<void> {
    const customId = interaction.customId;

    if (customId === 'kill_confirm') {
      await this.handleKillConfirm(interaction);
    } else if (customId === 'kill_cancel') {
      await interaction.update({ content: 'Kill cancelled.', components: [] });
    } else if (customId.startsWith('cancel_confirm_')) {
      const requestId = customId.replace('cancel_confirm_', '');
      await this.handleCancelConfirm(interaction, requestId);
    } else if (customId.startsWith('cancel_cancel_')) {
      await interaction.update({ content: 'Cancel aborted.', components: [] });
    }
  }

  private async handleKillConfirm(interaction: MessageComponentInteraction): Promise<void> {
    // Validate: only the original invoker or an admin can confirm
    const userId = await this.identityResolver.resolve(interaction.user.id);
    const decision = await this.authz.authorize(userId, 'kill', {});
    if (!decision.granted) {
      await interaction.reply({ content: 'Permission denied.', ephemeral: true });
      return;
    }

    const result = await this.router.route({
      commandName: 'kill',
      args: ['CONFIRM'],
      flags: {},
      rawText: 'kill CONFIRM',
      source: { channelType: 'discord', userId, timestamp: new Date() },
    });

    await interaction.update({
      content: result.success ? 'All requests have been killed.' : `Error: ${result.error}`,
      components: [],
    });
  }

  async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    // Extract fields from modal
    const description = interaction.fields.getTextInputValue('description');
    const repo = interaction.fields.getTextInputValue('repo') || undefined;
    const criteria = interaction.fields.getTextInputValue('acceptance_criteria') || undefined;

    await interaction.deferReply();

    const userId = await this.identityResolver.resolve(interaction.user.id);
    const command: IncomingCommand = {
      commandName: 'submit',
      args: [description],
      flags: {
        ...(repo ? { repo } : {}),
        ...(criteria ? { acceptance_criteria: criteria } : {}),
      },
      rawText: description,
      source: { channelType: 'discord', userId, platformChannelId: interaction.channelId, timestamp: new Date() },
    };

    const result = await this.router.route(command);
    await interaction.editReply({
      content: result.success ? `Request created: ${(result.data as any).requestId}` : `Error: ${result.error}`,
    });
  }
}
```

### Task 8: Modal Form

```typescript
function buildSubmitModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('submit_modal')
    .setTitle('Submit Pipeline Request')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('description')
          .setLabel('Description')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Describe the feature or task...')
          .setRequired(true)
          .setMaxLength(10000),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('repo')
          .setLabel('Target Repository')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('owner/repo-name')
          .setRequired(false),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('acceptance_criteria')
          .setLabel('Acceptance Criteria')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Optional: How will you know this is done?')
          .setRequired(false)
          .setMaxLength(2000),
      ),
    );
}
```

## Acceptance Criteria

1. Embed color matches the phase color map for all 14 phases.
2. Embed title is `{requestId}: {truncated title}` with "..." at 50 chars.
3. Embed has 5 inline fields: Phase, Priority, Progress, Age, Blocker.
4. Embed footer shows requester display name.
5. Kill confirmation has DANGER "CONFIRM KILL ALL" and SECONDARY "Cancel" buttons.
6. Cancel confirmation embeds the request ID in the custom_id.
7. Button clicker authorization: non-admin clicking "CONFIRM KILL ALL" gets ephemeral denial.
8. Modal has 3 fields: description (paragraph, required, max 10000), repo (short, optional), acceptance criteria (paragraph, optional, max 2000).
9. Modal submission routes through `IntakeRouter` as a submit command.
10. Component handler routes by `custom_id` prefix.

## Test Cases

1. **Embed: queued phase color**: Request in `queued` state; verify color = `0x95a5a6`.
2. **Embed: execution phase color**: Verify color = `0x2ecc71`.
3. **Embed: failed phase color**: Verify color = `0xe74c3c`.
4. **Embed: title truncation**: Title with 60 chars; verify truncated to 50 + "...".
5. **Embed: short title**: Title with 30 chars; verify no truncation.
6. **Embed: all fields present**: Verify fields array has 5 entries, all `inline: true`.
7. **Embed: blocker shown**: Request with blocker; verify Blocker field value is the blocker text.
8. **Embed: no blocker**: Request without blocker; verify Blocker field value is "None".
9. **Kill button structure**: Verify 2 buttons, first is DANGER style with custom_id `kill_confirm`, second is SECONDARY with `kill_cancel`.
10. **Cancel button custom_id**: For REQ-000042, verify custom_ids are `cancel_confirm_REQ-000042` and `cancel_cancel_REQ-000042`.
11. **Component handler: kill confirm authorized**: Admin user clicks kill_confirm; verify router called with `kill CONFIRM`.
12. **Component handler: kill confirm unauthorized**: Non-admin clicks kill_confirm; verify ephemeral "Permission denied" sent.
13. **Component handler: kill cancel**: Click kill_cancel; verify message updated to "Kill cancelled." with empty components.
14. **Component handler: cancel confirm**: Click `cancel_confirm_REQ-000042`; verify cancel routed for that request ID.
15. **Modal structure**: Verify 3 action rows, custom_ids `description`, `repo`, `acceptance_criteria`.
16. **Modal submission**: Submit modal with description and repo; verify `IncomingCommand` has description in args[0] and repo in flags.
17. **Digest embed**: Verify fields for active count, blocked, completed 24h, queue depth.
18. **Error embed**: Verify red color (`0xe74c3c`), error code in title.
