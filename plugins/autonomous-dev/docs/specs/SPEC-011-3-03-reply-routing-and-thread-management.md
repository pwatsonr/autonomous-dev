# SPEC-011-3-03: Reply Routing (Clarifications, Approvals) and Thread Management

## Metadata
- **Parent Plan**: PLAN-011-3
- **Tasks Covered**: Task 3 (interaction wiring extended), Task 4 (button/modal interactions), Task 7 (structured logging for reply paths)
- **Estimated effort**: 5 hours

## Description
Extend `DiscordService` to handle non-slash-command interactions: button clicks, modal submissions, and follow-up replies in long-running request threads. Implement thread creation for any request whose initial response is not immediate so the bot can post progress updates and the user can post clarifying replies in a dedicated, scoped surface. Wire reply routing so that clarifying-question modals and approval buttons forward an `IncomingReply` (not `IncomingCommand`) to the existing adapter, which already supports both types.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `intake/adapters/discord/main.ts` | Modify | Extend `interactionCreate` switch to dispatch button + modal interactions |
| `intake/adapters/discord/discord_threads.ts` | Create | Thread creation, lookup, and message posting helpers |
| `intake/adapters/discord/discord_components.ts` | Verify/Modify | Confirm `buildApprovalRow()` and `buildClarificationModal()` exist; add if missing |
| `intake/__tests__/adapters/discord/reply_routing.test.ts` | Create | Unit tests for each interaction type |

## Implementation Details

### Interaction Dispatch Switch

In the `interactionCreate` listener (introduced in SPEC-011-3-01), expand to dispatch by interaction type:

```ts
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await this.adapter.handleInteraction(interaction);
    } else if (interaction.isButton()) {
      await this.handleButtonInteraction(interaction);
    } else if (interaction.isModalSubmit()) {
      await this.handleModalSubmit(interaction);
    } else {
      this.logger.warn('discord_unhandled_interaction_type', {
        type: interaction.type,
        id: interaction.id,
      });
    }
  } catch (err) {
    await this.replyWithError(interaction, err);
  }
});
```

### `handleButtonInteraction(interaction: ButtonInteraction)`

`customId` format: `request:<REQ-NNNNNN>:<action>` where action is one of `approve`, `reject`, `pause`, `resume`, `cancel`.

Behavior:

1. Parse `customId`. If malformed (does not match `/^request:REQ-\d{6}:(approve|reject|pause|resume|cancel)$/`):
   - Log `discord_button_malformed_custom_id` with the raw value.
   - Reply ephemerally: `This action is no longer valid. Re-issue the request.`
   - Return.
2. Construct an `IncomingReply`:
   ```ts
   {
     channel: 'discord',
     replyType: 'button',
     requestId,
     action,
     user: { id: interaction.user.id, name: interaction.user.username },
     correlationId: interaction.id,
   }
   ```
3. Call `await interaction.deferUpdate()` to acknowledge within Discord's 3-second budget.
4. Forward to `this.adapter.handleReply(reply)`.
5. On success, edit the original message via `interaction.editReply({ components: [] })` to clear the buttons (prevents double-clicks).

### `handleModalSubmit(interaction: ModalSubmitInteraction)`

`customId` format: `clarify:<REQ-NNNNNN>` for clarifying-question modals.

Behavior:

1. Parse `customId`. Malformed → ephemeral error, return.
2. Read the `response` text input field via `interaction.fields.getTextInputValue('response')`.
3. Reject if empty after trim, or if length > 4000 (Discord's modal limit).
4. Build `IncomingReply`:
   ```ts
   {
     channel: 'discord',
     replyType: 'clarification',
     requestId,
     message: response,
     user: { id: interaction.user.id, name: interaction.user.username },
     correlationId: interaction.id,
   }
   ```
5. `await interaction.deferReply({ ephemeral: true })`.
6. Forward to `this.adapter.handleReply(reply)`.
7. Reply: `Clarification received for ${requestId}. Continuing.`

### Thread Management — `discord_threads.ts`

Long-running requests (those whose initial response is `deferReply`) should run in a thread off the original channel so progress updates do not pollute the parent channel.

Exports:

```ts
export async function ensureRequestThread(
  channel: TextChannel | NewsChannel,
  requestId: string,
  parentMessageId: string,
): Promise<ThreadChannel>;

export async function postProgress(
  thread: ThreadChannel,
  requestId: string,
  message: string,
): Promise<void>;

export async function findExistingThread(
  channel: TextBasedChannel,
  requestId: string,
): Promise<ThreadChannel | null>;
```

`ensureRequestThread` behavior:

1. Search the channel's active threads for one named `request-${requestId}`. If found, return it.
2. Otherwise, create a public thread off `parentMessageId`:
   ```ts
   await channel.threads.create({
     name: `request-${requestId}`,
     startMessage: parentMessageId,
     autoArchiveDuration: 60, // 1 hour idle
     reason: `autonomous-dev request ${requestId}`,
   });
   ```
3. If thread creation fails (50013 missing perms, 30033 max threads), fall back to posting in the parent channel and log `discord_thread_creation_fallback` with the error code.

`postProgress` writes to the thread with a consistent prefix:

```
[REQ-NNNNNN @ HH:MM:SS] <message>
```

Truncate `message` to 1900 chars (Discord 2000-char limit minus prefix headroom). If truncated, append `… (truncated; see logs)`.

### Identifying When to Use Threads

The adapter signals "this request will run long" by responding to a slash command via `deferReply`. The orchestrator (caller of `DiscordService`) is responsible for invoking `ensureRequestThread` when a request transitions to `running`. This spec only provides the helper — wiring lives in the orchestrator integration layer (out of scope here).

## Acceptance Criteria

- [ ] Button interactions with valid `customId` produce an `IncomingReply` with `replyType: 'button'` and the correct `action`
- [ ] Button interactions with malformed `customId` reply ephemerally with the documented message and do not call `adapter.handleReply`
- [ ] Successful button interactions clear the button row via `editReply({ components: [] })`
- [ ] Modal submissions with valid `customId` and non-empty response produce an `IncomingReply` with `replyType: 'clarification'`
- [ ] Modal submissions with empty / over-4000-char response reply ephemerally with a length error and do not forward
- [ ] Unknown interaction types log `discord_unhandled_interaction_type` and do not throw
- [ ] `ensureRequestThread` returns the existing thread when one named `request-${requestId}` already exists
- [ ] `ensureRequestThread` creates a new thread off the parent message with `autoArchiveDuration: 60` when none exists
- [ ] On `50013` or `30033` thread creation error, `ensureRequestThread` logs `discord_thread_creation_fallback` and returns `null`
- [ ] `postProgress` truncates messages over 1900 chars with the documented suffix
- [ ] All interactions are acknowledged within Discord's 3-second budget (deferred where async work follows)

## Dependencies

- SPEC-011-3-01 — `interactionCreate` listener exists and is the integration point.
- `DiscordAdapter.handleReply(reply: IncomingReply)` — assumed to exist; if missing, raise as a finding.
- `discord_components.ts` — provides component builders (verified, not authored here).
- discord.js: `ButtonInteraction`, `ModalSubmitInteraction`, `ThreadChannel`, `TextChannel`.

## Notes

- The `customId` format is the contract surface between the bot's emitted components (Slack/Discord) and its consuming reply handler. Keep `request:<REQ-NNNNNN>:<action>` stable — changing it breaks already-posted messages with live buttons.
- 60-minute auto-archive is a balance: shorter ages out helpful threads; longer keeps stale threads visible. 60 matches the user's typical session length for an interactive autonomous-dev request.
- Threads are public; the bot must NOT post sensitive data (tokens, secrets) into thread messages. Adapter responsibility, but worth noting because thread messages are visible to all channel members.
- Modal field name `response` is hardcoded here and in `discord_components.ts`. Both must agree; a mismatch fails silently when `getTextInputValue` returns `null`. Tests must cover this.
