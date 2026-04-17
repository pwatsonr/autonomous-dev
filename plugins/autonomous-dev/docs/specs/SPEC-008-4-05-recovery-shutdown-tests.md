# SPEC-008-4-05: Bot Recovery, Graceful Shutdown & Slack Test Suites

## Metadata
- **Parent Plan**: PLAN-008-4
- **Tasks Covered**: Task 14, Task 15, Task 16, Task 17, Task 18
- **Estimated effort**: 17 hours

## Description

Implement Slack bot startup recovery for pending prompts, graceful shutdown for HTTP server and Socket Mode, and write the full Slack test suite: adapter unit tests, integration tests, and the replay attack security test.

## Files to Create/Modify

| File | Action |
|------|--------|
| `intake/adapters/slack/slack_adapter.ts` | Modify (add recovery and shutdown) |
| `intake/__tests__/adapters/slack/slack_adapter.test.ts` | Create |
| `intake/__tests__/adapters/slack/slack_verifier.test.ts` | Create |
| `intake/__tests__/adapters/slack/slack_formatter.test.ts` | Create |
| `intake/__tests__/adapters/slack/slack_components.test.ts` | Create |
| `intake/__tests__/adapters/slack/slack_interaction_handler.test.ts` | Create |
| `intake/__tests__/integration/slack_e2e.test.ts` | Create |
| `intake/__tests__/security/slack_replay.test.ts` | Create |

## Implementation Details

### Task 14: Bot Startup Recovery

```typescript
async startupRecovery(): Promise<void> {
  const pendingPrompts = await this.db.getPendingPrompts();
  const slackPrompts = pendingPrompts.filter(p =>
    p.channel === 'slack' && new Date(p.timeout_at) > new Date()
  );

  for (const prompt of slackPrompts) {
    try {
      const web = this.slackClient.getClient();
      await web.chat.postMessage({
        channel: prompt.platform_channel_id,
        thread_ts: prompt.thread_id,
        blocks: [
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: ':arrows_counterclockwise: *[Resent]*' }],
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: prompt.content },
          },
        ],
        text: `[Resent] ${prompt.content}`,
      });

      logger.info('Re-sent pending Slack prompt after startup', {
        requestId: prompt.request_id,
        messageId: prompt.message_id,
      });
    } catch (error) {
      logger.error('Failed to re-send pending Slack prompt', {
        requestId: prompt.request_id,
        error: error.message,
      });
    }
  }
}
```

**"[Resent]" prefix**: Rendered as a Block Kit `context` block with `:arrows_counterclockwise:` emoji, distinct from the original message.

### Task 15: Graceful Shutdown

```typescript
async shutdown(): Promise<void> {
  logger.info('Slack adapter shutdown initiated');

  if (this.socketMode) {
    await this.socketMode.disconnect();
  }

  if (this.server) {
    await this.server.stop();
  }

  // Clear all pending prompt timers
  for (const [requestId, pending] of this.pendingPrompts) {
    clearTimeout(pending.timer);
    pending.resolve({
      kind: 'timeout',
      requestId,
      promptedAt: new Date(),
      expiredAt: new Date(),
    });
  }
  this.pendingPrompts.clear();

  logger.info('Slack adapter shutdown complete');
}
```

**Shutdown clears pending prompt timers**: Any outstanding `promptUser` calls are resolved with `TimeoutExpired` to prevent dangling promises.

### Task 16: Slack Adapter Unit Tests

**`slack_adapter.test.ts`:**
- Test `start()` starts HTTP server (mock server).
- Test `start()` with Socket Mode config starts Socket Mode client.
- Test `sendMessage()` calls `chat.postMessage` with correct params.
- Test `sendMessage()` calls `chat.postEphemeral` for DM target.
- Test `sendMessage()` includes `thread_ts` for threaded messages.
- Test `promptUser()` sends prompt and resolves on interaction response.
- Test `promptUser()` resolves with `TimeoutExpired` on timeout.
- Test `shutdown()` stops server and clears pending prompts.

**`slack_verifier.test.ts`:**
- Test valid signature (compute HMAC with known inputs).
- Test invalid signature (wrong secret).
- Test stale timestamp (> 5 minutes).
- Test buffer length mismatch.
- Test timing-safe comparison used.

**`slack_formatter.test.ts`:**
- Test `formatStatusBlocks` structure: header, section, conditional blocker, conditional artifacts, context.
- Test emoji mapping for all 14 phases.
- Test title truncation at 50 chars.
- Test mrkdwn link format for artifacts.
- Test requester mention format `<@userId>`.
- Test block limit enforcement (50 blocks).
- Test text truncation (3000 chars).
- Test `formatDigest` with various digest data.
- Test `formatError` with error code.

**`slack_components.test.ts`:**
- Test `buildKillConfirmationBlocks` structure: section + actions.
- Test kill button has `style: 'danger'` and nested `confirm` dialog.
- Test `buildCancelConfirmationBlocks` embeds request ID in action_id.
- Test `buildSubmitModal` has 3 input blocks with correct types and constraints.

**`slack_interaction_handler.test.ts`:**
- Test `block_actions` routing for kill_confirm, kill_cancel, cancel_confirm, cancel_cancel.
- Test `view_submission` routing for submit_modal.
- Test authorization check on kill_confirm.
- Test ephemeral error on unauthorized action.
- Test acknowledgment sent (res.status(200)) before processing.

### Task 17: Slack Integration Tests

**`slack_e2e.test.ts`:**

Uses real SQLite database, mock Slack Web API client.

1. **Submit via slash command webhook**: Simulate POST to `/slack/commands` with `/ad-submit` payload. Verify request created in DB.
2. **Status query response**: Submit request, simulate `/ad-status`; verify Block Kit response with correct fields.
3. **Kill confirmation flow**: Simulate `/ad-kill`; verify kill confirmation blocks returned. Simulate `block_actions` with `kill_confirm`; verify all active requests paused.
4. **Modal submission**: Simulate `view_submission` with description, repo, criteria; verify request created with all fields.
5. **Thread conversation**: Trigger clarifying question; verify `chat.postMessage` called with `thread_ts`. Verify `conversations.join` called.
6. **Unauthorized user**: Simulate slash command from unmapped Slack user; verify ephemeral error response.
7. **Response_url follow-up**: Mock slow router (> 2.5s); verify HTTP 200 acknowledgment sent, then POST to `response_url`.

### Task 18: Replay Attack Security Test

**`slack_replay.test.ts`:**

```typescript
describe('Slack Replay Attack Prevention', () => {
  test('rejects stale timestamp (> 5 minutes)', () => {
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 301);
    const body = 'command=%2Fad-status&text=REQ-000001';
    const validSig = computeSignature(signingSecret, staleTimestamp, body);
    expect(verifier.verify(staleTimestamp, body, validSig)).toBe(false);
  });

  test('rejects invalid signature', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = 'command=%2Fad-status&text=REQ-000001';
    expect(verifier.verify(timestamp, body, 'v0=invalidsignature')).toBe(false);
  });

  test('accepts valid signature with recent timestamp', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = 'command=%2Fad-status&text=REQ-000001';
    const validSig = computeSignature(signingSecret, timestamp, body);
    expect(verifier.verify(timestamp, body, validSig)).toBe(true);
  });
});
```

## Acceptance Criteria

1. Startup recovery re-sends pending Slack prompts with "[Resent]" Block Kit context prefix.
2. Only prompts with `timeout_at > now` and `responded = false` are re-sent.
3. Failed re-sends are logged but do not prevent recovery of other prompts.
4. Graceful shutdown stops HTTP server (or Socket Mode), clears pending prompt timers.
5. Pending `promptUser` calls resolve with `TimeoutExpired` on shutdown.
6. All 5 unit test files pass with mocked Slack Web API.
7. Signature verification tested with valid, invalid, and stale cases.
8. Block Kit output validated for structure, emoji, and limits.
9. Component structures validated for buttons and modals.
10. Interaction handler routing tested for all payload types.
11. All 7 e2e scenarios pass with real SQLite and mocked Slack API.
12. Replay attack test: stale timestamp rejected, invalid signature rejected, valid accepted.

## Test Cases

| File | Test Count |
|------|-----------|
| `slack_adapter.test.ts` | 8 |
| `slack_verifier.test.ts` | 5 |
| `slack_formatter.test.ts` | 12 |
| `slack_components.test.ts` | 4 |
| `slack_interaction_handler.test.ts` | 6 |
| `slack_e2e.test.ts` | 7 |
| `slack_replay.test.ts` | 3 |
| **Total** | **45** |
