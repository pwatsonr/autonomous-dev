# SPEC-011-4-03: Block Kit UI for Clarifying Questions, Approvals, and Interactive Components

## Metadata
- **Parent Plan**: PLAN-011-4
- **Tasks Covered**: Task 5 (interactive component handling — Block Kit portion), Task 8 (Slack app manifest YAML for the manifest's interactivity entries)
- **Estimated effort**: 4 hours

## Description
Wire the existing `SlackComponents` Block Kit builders into the service's interactive payload pipeline. Two interaction surfaces are in scope: (1) clarifying-question prompts that the orchestrator emits via the adapter's `StructuredPrompt` API and that must round-trip user replies back to the pending request, and (2) approval blocks for destructive operations (cancel, kill) that use Slack's nested `confirm` dialog for two-step confirmation. The interaction handler maps Slack `block_actions`, `view_submission`, and `view_closed` payloads back onto `UserResponse`/`CommandResult` shapes consumed by the router.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `intake/adapters/slack/main.ts` | Modify | Wire `interactionHandler` and `mapInteractionPayload()` |
| `intake/adapters/slack/slack-app-manifest.yaml` | Modify | Add interactivity URL + shortcut entries (manifest already exists) |

## Implementation Details

### Interaction Payload Types

Slack delivers all interactive payloads to `/slack/interactions` as URL-encoded with a single `payload` field whose value is JSON. The wrapper handler in `main.ts`:

1. Parses `JSON.parse(req.body.payload)`.
2. Branches on `payload.type`:
   - `block_actions` — button clicks on a posted message (e.g., "Confirm Cancel", "Approve")
   - `view_submission` — modal "Submit" pressed (e.g., the submit-request modal)
   - `view_closed` — modal closed via X button
   - `shortcut` / `message_action` — global/message shortcuts (out of scope; reject with `not_implemented`)

### Block Kit Builders to Reuse

All builders are already defined in `slack_components.ts`:

| Builder | Use case | Action IDs |
|---------|----------|-----------|
| `buildClarifyingPromptBlocks(promptText, optionsList, requestId)` | Orchestrator-emitted clarifying question | `clarify_select:<reqId>:<optionId>`, `clarify_freeform:<reqId>` |
| `buildKillConfirmBlocks(requestId)` | Two-step kill confirm with nested `confirm` dialog | `kill_confirm:<reqId>`, `kill_cancel:<reqId>` |
| `buildCancelConfirmBlocks(requestId)` | One-step cancel confirm | `cancel_confirm:<reqId>`, `cancel_dismiss:<reqId>` |
| `buildApprovalBlocks(operation, requestId)` | Generic approve/deny for elevated ops | `approve:<op>:<reqId>`, `deny:<op>:<reqId>` |
| `buildSubmitModal(triggerId)` | Submit-request modal form | callback_id: `submit_request_modal` |

This spec does NOT change the builders. It defines the routing contract on the inbound side.

### Action ID Convention

All `action_id` values use the format `<verb>:<arg1>[:<arg2>...]` where colons separate arguments. The `mapInteractionPayload` function splits on the first `:` to derive `verb`, then forwards the rest to the appropriate router subcommand:

```ts
const [verb, ...rest] = action.action_id.split(':');
switch (verb) {
  case 'clarify_select':   // [requestId, optionId]
  case 'clarify_freeform': // [requestId]
  case 'kill_confirm':     // [requestId]
  case 'cancel_confirm':   // [requestId]
  case 'approve':          // [operation, requestId]
  case 'deny':             // [operation, requestId]
  // dismiss/cancel button variants resolve locally — no router call
  case 'kill_cancel':
  case 'cancel_dismiss':
}
```

### `mapInteractionPayload(payload) -> RouterDispatch | LocalDismiss`

Define:

```ts
type RouterDispatch = {
  kind: 'route';
  command: IncomingCommand;
};

type LocalDismiss = {
  kind: 'dismiss';
  responseAction: 'replace' | 'ephemeral';
  text: string;
};
```

Mapping rules:

1. **`block_actions` with verb `clarify_select`**: Build `IncomingCommand` with `subcommand: 'feedback'`, `args: [requestId, optionId]`, `user`/`context` from `payload.user`/`payload.channel`. Return `{ kind: 'route', command }`.
2. **`block_actions` with verb `clarify_freeform`**: Same as above but open a modal first via `views.open` using `buildClarifyingFreeformModal(requestId)`; the actual feedback is delivered via the subsequent `view_submission`.
3. **`block_actions` with verb `kill_confirm` or `cancel_confirm`**: Build `IncomingCommand` with `subcommand: 'kill'` or `'cancel'`, `args: [requestId]`. Return `{ kind: 'route', command }`. The orchestrator uses the existing kill-switch path; the nested Slack `confirm` dialog has already provided the second-step gate.
4. **`block_actions` with verb `kill_cancel` or `cancel_dismiss`**: Return `{ kind: 'dismiss', responseAction: 'replace', text: 'Action cancelled.' }`. No router call.
5. **`block_actions` with verb `approve` or `deny`**: Build `IncomingCommand` with `subcommand: '<verb>'`, `args: [operation, requestId]`. Return `{ kind: 'route', command }`.
6. **`view_submission` with `callback_id: submit_request_modal`**: Extract the field values from `payload.view.state.values`:
   - `description_block.description_input.value`
   - `repo_block.repo_input.value`
   - `acceptance_criteria_block.criteria_input.value`
   Build `IncomingCommand` with `subcommand: 'submit'`, `args: [description, repo, acceptance_criteria]`. Return `{ kind: 'route', command }`.
   Response: `{ response_action: 'clear' }` after dispatch acknowledges.
7. **`view_submission` with `callback_id: clarify_freeform_modal`**: Extract the freeform feedback text and dispatch as `subcommand: 'feedback'`, `args: [requestId, freeformText]`.
8. **`view_closed`**: Local dismiss only. No router call. Log `info("slack.modal.closed", { callback_id })`.
9. **Unknown verb or callback_id**: Return ephemeral error `"Unknown action: <verb>. Please contact your operator."`. Log `warn("slack.interaction.unknown", { verb, callback_id })`.

### StructuredPrompt Round-Trip

The `SlackAdapter` already implements `prompt(target, prompt) -> Promise<UserResponse|TimeoutExpired>`; this spec ensures the inbound side resolves the pending promise. Inside the interaction wrapper:

1. After successful router dispatch for a `clarify_*` verb, also call `adapter.resolvePendingPrompt(requestId, userResponse)` so that any orchestrator code awaiting the prompt unblocks.
2. If no pending prompt exists for `requestId`, log `warn("slack.prompt.no_pending", { requestId })` and proceed with router dispatch only.

### Response Format

For `block_actions`, the inline 200 response replaces the original message with an "in-progress" formatting using `replace_original: true`:

```json
{ "replace_original": true, "text": "Working on it...", "blocks": [] }
```

For `view_submission`, return `{ response_action: 'clear' }` to close the modal.

For `view_closed` and local dismisses, return `200` with empty body.

### Manifest Updates (Task 8 portion)

In `slack-app-manifest.yaml`, ensure the `features.interactivity` block is set:

```yaml
features:
  interactivity:
    is_enabled: true
    request_url: https://${HOST}/slack/interactions
```

The OAuth scopes already include `chat:write` and `commands`. Add `chat:write.public` if not present (required to post in channels the bot is not a member of).

## Acceptance Criteria

- [ ] All `payload.type` branches (`block_actions`, `view_submission`, `view_closed`) are routed by `mapInteractionPayload`
- [ ] Action IDs are split on `:` and dispatched per the verb table; unknown verbs return ephemeral error
- [ ] `clarify_select` and `clarify_freeform` produce `IncomingCommand` with `subcommand: 'feedback'`
- [ ] `clarify_freeform` first opens the freeform modal via `views.open`; the subsequent `view_submission` is what dispatches feedback
- [ ] `kill_confirm` and `cancel_confirm` produce `subcommand: 'kill' | 'cancel'`
- [ ] `kill_cancel` and `cancel_dismiss` return `LocalDismiss` (no router call)
- [ ] `submit_request_modal` extracts the three named fields from `state.values` and dispatches `subcommand: 'submit'`
- [ ] `view_submission` returns `response_action: 'clear'` after dispatch
- [ ] After clarify dispatch, `adapter.resolvePendingPrompt(requestId, ...)` is called; missing pending prompts are warned, not errored
- [ ] `slack-app-manifest.yaml` `features.interactivity.is_enabled` is `true` and `request_url` ends with `/slack/interactions`
- [ ] Manifest scopes include `chat:write`, `commands`, `app_mentions:read`, `chat:write.public`

## Dependencies

- SPEC-011-4-01: HTTP receiver routes and middleware
- SPEC-011-4-02: `IncomingCommand` mapping conventions (channel='slack', user/context shape)
- Existing `SlackComponents` builders in `slack_components.ts`
- Existing `SlackAdapter.resolvePendingPrompt()` and `prompt()` methods
- `slack-app-manifest.yaml` (already exists at `intake/adapters/slack/slack-app-manifest.yaml`)

## Notes

- Slack's nested `confirm` dialog (used by `buildKillConfirmBlocks`) provides a hard two-step gate at the UI layer — the user clicks "CONFIRM KILL ALL" and then must click again in a native modal. This is intentionally stronger than the cancel flow because kill is destructive and irreversible.
- Action IDs are colon-delimited because Slack imposes a 255-character limit and disallows certain JSON-quoted forms; the colon delimiter is portable and matches existing action IDs in the codebase.
- The `clarify_freeform` two-hop flow (button → modal → submit) is intentional: free-form text in a button payload would be invisible to the user; the modal makes editing visible and provides character validation.
- `view_submission` is the only payload type where the inline 200 must use `response_action`; other types use `replace_original`. Mixing these breaks the Slack UI.
- `chat:write.public` is needed because the orchestrator can post to channels where the bot has not been invited (e.g., a `#dev-alerts` channel an operator named without inviting the app). Without this scope, those posts return `not_in_channel`.
- This spec does not duplicate the manifest creation — the file already exists and is finalized in SPEC-011-4-04 alongside deployment files.
