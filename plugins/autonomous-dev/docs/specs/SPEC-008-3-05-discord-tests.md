# SPEC-008-3-05: Discord Adapter Unit & Integration Tests

## Metadata
- **Parent Plan**: PLAN-008-3
- **Tasks Covered**: Task 14, Task 15
- **Estimated effort**: 10 hours

## Description

Write the full test suite for the Discord adapter: unit tests for all Discord-specific components (mocked Discord.js client), and end-to-end integration tests that verify the full lifecycle through the Discord adapter with a real SQLite database.

## Files to Create/Modify

| File | Action |
|------|--------|
| `intake/__tests__/adapters/discord/discord_adapter.test.ts` | Create |
| `intake/__tests__/adapters/discord/discord_commands.test.ts` | Create |
| `intake/__tests__/adapters/discord/discord_formatter.test.ts` | Create |
| `intake/__tests__/adapters/discord/discord_components.test.ts` | Create |
| `intake/__tests__/adapters/discord/discord_interaction_handler.test.ts` | Create |
| `intake/__tests__/integration/discord_e2e.test.ts` | Create |

## Implementation Details

### Task 14: Discord Adapter Unit Tests

All tests mock the Discord.js client, REST API, and gateway. No live Discord server.

**`discord_adapter.test.ts`:**
- Test `start()` connects client and registers commands.
- Test `sendMessage()` sends to channel with embed payload.
- Test `promptUser()` sends buttons and collects interaction response.
- Test `promptUser()` returns `TimeoutExpired` when collection times out.
- Test `shutdown()` disconnects after draining in-flight.
- Test interaction listener routes slash commands, components, and modal submissions.

**`discord_commands.test.ts`:**
- Test command payload has exactly 1 top-level command `/ad` with 10 subcommands.
- Test each subcommand has correct option types, required flags, max_length constraints, and choice enums.
- Test registration calls `REST.put` with correct route and body.
- Test registration is idempotent.

**`discord_formatter.test.ts`:**
- Test `formatStatusEmbed` returns correct structure for each phase (color, title, fields).
- Test title truncation at 50 characters.
- Test progress bar rendering in embed field.
- Test `formatPhaseTransition` includes from/to phase.
- Test `formatDigest` with empty digest (no activity in 24h).
- Test `formatDigest` pagination when content exceeds 6000 chars.
- Test `formatError` with red color and error code.

**`discord_components.test.ts`:**
- Test `buildKillConfirmation` returns ActionRow with 2 buttons (DANGER + SECONDARY).
- Test `buildCancelConfirmation` includes request ID in custom_id.
- Test `buildSubmitModal` returns 3 action rows with correct field types.
- Test modal max_length constraints.

**`discord_interaction_handler.test.ts`:**
- Test `kill_confirm` button authorized: routes to kill handler with "CONFIRM".
- Test `kill_confirm` button unauthorized: returns ephemeral denial.
- Test `kill_cancel` button: updates message with "Kill cancelled."
- Test `cancel_confirm_REQ-XXXXXX`: routes to cancel handler.
- Test modal submission: extracts fields and routes to submit handler.
- Test expired interaction handling.

### Task 15: Discord Integration Tests

**`discord_e2e.test.ts`:**

Uses real SQLite database, mock Discord.js client. All interactions are simulated.

**Test scenarios:**

1. **Submit via interaction**: Simulate `/ad submit description:"Build auth" priority:high`. Verify:
   - `deferReply()` called.
   - Request created in DB with correct fields.
   - `editReply()` called with status embed.
   - Embed color matches `queued` phase.

2. **Status query**: Submit a request, then simulate `/ad status request-id:REQ-000001`. Verify:
   - Status embed returned with all fields populated.

3. **Pause/resume**: Set request to `active`, simulate `/ad pause request-id:REQ-000001`. Verify status is `paused`. Simulate `/ad resume request-id:REQ-000001`. Verify status is `active`.

4. **Kill confirmation flow**: Simulate `/ad kill`. Verify deferred reply edited with kill confirmation buttons. Simulate button click on `kill_confirm` by admin. Verify all active requests paused.

5. **Modal submission**: Simulate modal submit with description, repo, acceptance criteria. Verify request created with all fields.

6. **Thread creation**: Trigger a clarifying question. Verify thread created with request ID in name. Verify subsequent questions go to the same thread.

7. **Unauthorized user**: Simulate interaction from unmapped Discord user. Verify authorization error in deferred reply.

## Acceptance Criteria

1. All 5 unit test files pass with mocked Discord.js client.
2. Command registration payload verified against TDD section 3.3.2 JSON structure.
3. Interaction deferral verified (deferReply called before router invocation).
4. Embed formatting verified for all phases (colors, fields, truncation).
5. Button component structure verified (custom_ids, styles).
6. Modal structure verified (3 fields, correct types and constraints).
7. Component interaction handler authorization verified.
8. All 7 e2e scenarios pass with real SQLite and mock Discord.js.

## Test Cases

| File | Test Count |
|------|-----------|
| `discord_adapter.test.ts` | 8 |
| `discord_commands.test.ts` | 10 |
| `discord_formatter.test.ts` | 10 |
| `discord_components.test.ts` | 5 |
| `discord_interaction_handler.test.ts` | 6 |
| `discord_e2e.test.ts` | 7 |
| **Total** | **46** |
