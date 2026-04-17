# SPEC-008-4-03: Block Kit Formatter, Interactive Components & Modal Forms

## Metadata
- **Parent Plan**: PLAN-008-4
- **Tasks Covered**: Task 6, Task 7, Task 8, Task 9
- **Estimated effort**: 14 hours

## Description

Implement the Slack Block Kit formatter with status emoji, the interactive button components for kill/cancel confirmations (with Slack's nested confirm dialog), the interaction handler that routes `block_actions`, `view_submission`, and `shortcut` payloads, and the modal form for complex submissions via `views.open`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `intake/notifications/formatters/slack_formatter.ts` | Create |
| `intake/adapters/slack/slack_components.ts` | Create |
| `intake/adapters/slack/slack_interaction_handler.ts` | Create |

## Implementation Details

### Task 6: Block Kit Formatter

**Status emoji map (from TDD section 3.4.3):**

```typescript
const STATUS_EMOJI: Record<string, string> = {
  queued:         ':white_circle:',
  prd_generation: ':large_blue_circle:',
  prd_review:     ':orange_circle:',
  tdd_generation: ':large_blue_circle:',
  tdd_review:     ':orange_circle:',
  planning:       ':purple_circle:',
  spec:           ':purple_circle:',
  execution:      ':green_circle:',
  code_review:    ':orange_circle:',
  merged:         ':white_check_mark:',
  done:           ':heavy_check_mark:',
  paused:         ':double_vertical_bar:',
  cancelled:      ':x:',
  failed:         ':red_circle:',
};
```

**`formatStatusBlocks(request)` output:**

```typescript
[
  {
    type: 'header',
    text: { type: 'plain_text', text: `${request.request_id}: ${truncate(request.title, 50)}` },
  },
  {
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: `*Phase:*\n${statusEmoji} ${formatPhase(request.current_phase)}` },
      { type: 'mrkdwn', text: `*Priority:*\n${request.priority}` },
      { type: 'mrkdwn', text: `*Progress:*\n${formatProgress(request)}` },
      { type: 'mrkdwn', text: `*Age:*\n${formatDuration(Date.now() - new Date(request.created_at).getTime())}` },
    ],
  },
  // Conditional blocker section
  ...(request.blocker ? [{
    type: 'section',
    text: { type: 'mrkdwn', text: `:warning: *Blocker:* ${request.blocker}` },
  }] : []),
  // Conditional artifact links section
  ...(request.artifact_links?.length > 0 ? [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: request.artifact_links.map(l => `<${l.url}|${l.label}>`).join(' | '),
    },
  }] : []),
  {
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `Requested by <@${request.slack_user_id}> | Updated ${formatRelativeTime(request.updated_at)}`,
    }],
  },
]
```

**Block Kit limits enforced:**
- Max 50 blocks per message. If exceeded, split into multiple messages.
- Max 3000 characters per `text` block. If exceeded, truncate with "...".

**`NotificationFormatter` interface methods:**
- `formatStatusBlocks(request)`: Status card as above.
- `formatPhaseTransition(request, event)`: Blocks showing phase change with from/to.
- `formatDigest(digest)`: Blocks with header, section fields for counts, conditional blocker list.
- `formatError(error)`: Section block with `:x:` emoji and error message.

### Task 7: Interactive Button Components

**Kill confirmation (from TDD section 3.4.4):**

```typescript
function buildKillConfirmationBlocks(): SlackBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':rotating_light: *Emergency Kill Switch* :rotating_light:\n' +
              'This will immediately stop ALL running pipeline processes and pause all active requests.',
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'CONFIRM KILL ALL' },
          style: 'danger',
          action_id: 'kill_confirm',
          confirm: {
            title: { type: 'plain_text', text: 'Are you absolutely sure?' },
            text: { type: 'mrkdwn', text: 'This will halt all pipeline activity.' },
            confirm: { type: 'plain_text', text: 'Kill All' },
            deny: { type: 'plain_text', text: 'Go Back' },
          },
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Cancel' },
          action_id: 'kill_cancel',
        },
      ],
    },
  ];
}
```

**Cancel confirmation:**

```typescript
function buildCancelConfirmationBlocks(requestId: string): SlackBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Are you sure you want to cancel *${requestId}*? This will clean up all associated branches and PRs.`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Confirm Cancel' },
          style: 'danger',
          action_id: `cancel_confirm_${requestId}`,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Keep Request' },
          action_id: `cancel_cancel_${requestId}`,
        },
      ],
    },
  ];
}
```

**Key Slack difference from Discord**: The kill confirmation button uses Slack's built-in nested `confirm` dialog (two-step confirmation), providing an extra safety layer.

### Task 8: Interaction Handler

```typescript
class SlackInteractionHandler {
  constructor(
    private router: IntakeRouter,
    private identityResolver: SlackIdentityResolver,
    private authz: AuthzEngine,
    private web: WebClient,
  ) {}

  async handle(req: express.Request, res: express.Response): Promise<void> {
    // Acknowledge within 3 seconds
    res.status(200).send();

    const payloadStr = (req.body as URLSearchParams).get('payload');
    if (!payloadStr) return;
    const payload = JSON.parse(payloadStr);

    switch (payload.type) {
      case 'block_actions':
        await this.handleBlockAction(payload);
        break;
      case 'view_submission':
        await this.handleViewSubmission(payload);
        break;
      case 'shortcut':
        await this.handleShortcut(payload);
        break;
    }
  }

  private async handleBlockAction(payload: any): Promise<void> {
    const action = payload.actions[0];
    const actionId = action.action_id;
    const responseUrl = payload.response_url;
    const userId = await this.identityResolver.resolve(payload.user.id);

    if (actionId === 'kill_confirm') {
      const decision = await this.authz.authorize(userId, 'kill', {});
      if (!decision.granted) {
        await this.postEphemeral(payload, 'Permission denied.');
        return;
      }
      const result = await this.router.route({
        commandName: 'kill', args: ['CONFIRM'], flags: {},
        rawText: 'kill CONFIRM',
        source: { channelType: 'slack', userId, timestamp: new Date() },
      });
      await this.postToResponseUrl(responseUrl, result);
    } else if (actionId === 'kill_cancel') {
      await this.postToResponseUrl(responseUrl, { success: true, data: 'Kill cancelled.' });
    } else if (actionId.startsWith('cancel_confirm_')) {
      const requestId = actionId.replace('cancel_confirm_', '');
      // Route cancel with confirmation
      const result = await this.router.route({
        commandName: 'cancel', args: [requestId, 'CONFIRM'], flags: {},
        rawText: `cancel ${requestId} CONFIRM`,
        source: { channelType: 'slack', userId, timestamp: new Date() },
      });
      await this.postToResponseUrl(responseUrl, result);
    } else if (actionId.startsWith('cancel_cancel_')) {
      await this.postToResponseUrl(responseUrl, { success: true, data: 'Cancel aborted.' });
    }
  }

  private async postEphemeral(payload: any, text: string): Promise<void> {
    await this.web.chat.postEphemeral({
      channel: payload.channel.id,
      user: payload.user.id,
      text,
    });
  }
}
```

### Task 9: Modal Form

```typescript
function buildSubmitModal(triggerId: string): SlackModal {
  return {
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: 'submit_modal',
      title: { type: 'plain_text', text: 'Submit Pipeline Request' },
      submit: { type: 'plain_text', text: 'Submit' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input',
          block_id: 'description_block',
          label: { type: 'plain_text', text: 'Description' },
          element: {
            type: 'plain_text_input',
            action_id: 'description',
            multiline: true,
            placeholder: { type: 'plain_text', text: 'Describe the feature or task...' },
            max_length: 10000,
          },
        },
        {
          type: 'input',
          block_id: 'repo_block',
          optional: true,
          label: { type: 'plain_text', text: 'Target Repository' },
          element: {
            type: 'plain_text_input',
            action_id: 'repo',
            placeholder: { type: 'plain_text', text: 'owner/repo-name' },
          },
        },
        {
          type: 'input',
          block_id: 'criteria_block',
          optional: true,
          label: { type: 'plain_text', text: 'Acceptance Criteria' },
          element: {
            type: 'plain_text_input',
            action_id: 'acceptance_criteria',
            multiline: true,
            placeholder: { type: 'plain_text', text: 'Optional: How will you know this is done?' },
            max_length: 2000,
          },
        },
      ],
    },
  };
}
```

**Modal opened via `views.open` with `trigger_id`** from the original slash command interaction. The `view_submission` payload is routed through the interaction handler, which extracts field values and constructs an `IncomingCommand` for the submit handler.

## Acceptance Criteria

1. Block Kit status output uses correct emoji per phase from the `STATUS_EMOJI` map.
2. Header block contains `{requestId}: {truncated title}`.
3. Section fields use `mrkdwn` type with bold labels.
4. Blocker section only included when blocker is non-null.
5. Artifact links rendered as Slack mrkdwn links: `<url|label>`.
6. Context block shows requester mention `<@slackUserId>`.
7. Kill confirmation has danger button with nested `confirm` dialog.
8. Cancel confirmation embeds request ID in `action_id`.
9. Interaction handler routes `block_actions`, `view_submission`, `shortcut` payloads.
10. Button click authorization verified before executing action.
11. Ephemeral messages used for permission denied errors.
12. Modal has 3 input blocks: description (required, multiline, max 10000), repo (optional), acceptance criteria (optional, multiline, max 2000).
13. Modal submission routed through IntakeRouter as submit command.
14. Block Kit limits enforced (50 blocks max, 3000 chars per text block).

## Test Cases

1. **Status emoji: queued**: Verify Phase field contains `:white_circle:`.
2. **Status emoji: execution**: Verify Phase field contains `:green_circle:`.
3. **Status emoji: paused**: Verify Phase field contains `:double_vertical_bar:`.
4. **Status blocks structure**: Verify blocks array: header + section + context (minimum 3 blocks).
5. **Blocker conditional**: With blocker -> 4+ blocks. Without blocker -> 3 blocks.
6. **Artifact links**: Request with 2 artifacts; verify mrkdwn links with `<url|label>` format.
7. **Block limit enforcement**: Generate content exceeding 50 blocks; verify truncation/pagination.
8. **Text truncation**: Generate text field > 3000 chars; verify truncated with "...".
9. **Kill button confirm dialog**: Verify nested `confirm` object with title, text, confirm, deny fields.
10. **Kill button action_id**: Verify `action_id = 'kill_confirm'`.
11. **Cancel button action_id**: For REQ-000042, verify `action_id = 'cancel_confirm_REQ-000042'`.
12. **Interaction handler: block_actions routing**: Payload with `type: 'block_actions'` and `action_id: 'kill_confirm'`; verify routed to kill handler.
13. **Interaction handler: unauthorized**: Non-admin clicks kill_confirm; verify ephemeral "Permission denied" via `chat.postEphemeral`.
14. **Interaction handler: view_submission**: Payload with `type: 'view_submission'` and `callback_id: 'submit_modal'`; verify fields extracted and routed to submit.
15. **Modal structure**: Verify 3 input blocks with correct `action_id`, `multiline`, `max_length`.
16. **Modal trigger_id**: Verify `views.open` called with the `trigger_id`.
17. **Digest blocks**: Verify header + section fields for active count, blocked, completed 24h.
18. **Error blocks**: Verify section with `:x:` emoji and error text.
