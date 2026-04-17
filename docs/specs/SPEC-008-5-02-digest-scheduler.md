# SPEC-008-5-02: DigestScheduler & Digest Formatting

## Metadata
- **Parent Plan**: PLAN-008-5
- **Tasks Covered**: Task 5, Task 6
- **Estimated effort**: 8 hours

## Description

Implement the daily digest scheduler that generates and delivers summary reports at a configurable time, and extend all three channel formatters (CLI, Discord, Slack) with digest-specific formatting methods.

## Files to Create/Modify

| File | Action |
|------|--------|
| `intake/notifications/digest_scheduler.ts` | Create |
| `intake/notifications/formatters/cli_formatter.ts` | Modify (add formatDigest) |
| `intake/notifications/formatters/discord_formatter.ts` | Modify (add formatDigest) |
| `intake/notifications/formatters/slack_formatter.ts` | Modify (add formatDigest) |

## Implementation Details

### Task 5: DigestScheduler

```typescript
class DigestScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: Repository,
    private adapters: Map<ChannelType, IntakeAdapter>,
    private formatters: Map<ChannelType, NotificationFormatter>,
  ) {}

  start(config: DigestConfig): void {
    const nextRunMs = this.calculateNextRun(config.daily_digest_time);
    logger.info('Digest scheduler started', {
      nextRun: new Date(Date.now() + nextRunMs).toISOString(),
      time: config.daily_digest_time,
    });

    this.timer = setTimeout(async () => {
      try {
        await this.generateAndSendDigest(config);
      } catch (error) {
        logger.error('Digest generation failed', { error: error.message });
      }
      // Reschedule for next day
      this.start(config);
    }, nextRunMs);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async generateAndSendDigest(config: DigestConfig): Promise<void> {
    const digest = await this.buildDigest();

    // Skip if no activity in the last 24 hours
    if (this.isEmptyDigest(digest)) {
      logger.info('Digest skipped: no activity in last 24 hours');
      return;
    }

    const target: MessageTarget = {
      channelType: config.channel_type as ChannelType,
      platformChannelId: config.daily_digest_channel,
    };

    const formatter = this.formatters.get(target.channelType);
    if (!formatter) {
      logger.warn('No formatter for digest channel type', { channelType: target.channelType });
      return;
    }

    const message = formatter.formatDigest(digest);
    const adapter = this.adapters.get(target.channelType);
    if (!adapter) {
      logger.warn('Adapter unavailable for digest delivery', { channelType: target.channelType });
      return;
    }

    await adapter.sendMessage(target, message);
    logger.info('Daily digest delivered', { channelType: target.channelType });
  }

  private async buildDigest(): Promise<DigestData> {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    return {
      generatedAt: now,
      activeByState: await this.db.countRequestsByState(),
      blockedRequests: await this.db.getBlockedRequests(),
      completedLast24h: await this.db.getCompletedSince(yesterday),
      queueDepth: await this.db.getQueuedRequestCount(),
      queueDepthByPriority: await this.db.getQueuedCountByPriority(),
    };
  }

  private calculateNextRun(timeStr: string): number {
    // timeStr format: "HH:MM" (e.g., "09:00")
    const [hours, minutes] = timeStr.split(':').map(Number);
    const now = new Date();
    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);

    if (target.getTime() <= now.getTime()) {
      // Already past today's time, schedule for tomorrow
      target.setDate(target.getDate() + 1);
    }

    return target.getTime() - now.getTime();
  }

  private isEmptyDigest(digest: DigestData): boolean {
    const totalActive = Object.values(digest.activeByState).reduce((a, b) => a + b, 0);
    return totalActive === 0 &&
           digest.blockedRequests.length === 0 &&
           digest.completedLast24h.length === 0;
  }
}
```

**DigestConfig:**

```typescript
interface DigestConfig {
  daily_digest_time: string;    // "HH:MM" format, e.g., "09:00"
  channel_type: string;         // Channel to deliver digest to
  daily_digest_channel: string; // Platform-specific channel ID
}
```

**DigestData:**

```typescript
interface DigestData {
  generatedAt: Date;
  activeByState: Record<RequestStatus, number>;
  blockedRequests: RequestEntity[];
  completedLast24h: RequestEntity[];
  queueDepth: number;
  queueDepthByPriority: Record<Priority, number>;
}
```

**Timer drift mitigation**: After each execution, `calculateNextRun` is called again to compute the exact delay for the next day, preventing accumulated drift.

### Task 6: Digest Formatting for Each Channel

**CLI formatter (`formatDigest`):**

```
=== Daily Pipeline Digest (2026-04-08 09:00) ===

Active Requests:
  Queued:    3  (high: 1, normal: 1, low: 1)
  Active:    2
  Paused:    1
  Total:     6

Blocked Requests:
  REQ-000015: Waiting for API credentials (active, 12h)
  REQ-000023: Merge conflict in base branch (active, 3h)

Completed (last 24h):
  REQ-000012: Build user auth system (done, 18h total)
  REQ-000018: Fix dashboard CSS (done, 4h total)

Queue Depth: 3/50
```

Plain text, no ANSI codes. Handles empty sections by omitting them.

**Discord formatter (`formatDigest`):**

```typescript
{
  title: 'Daily Pipeline Digest',
  color: 0x3498db,  // Blue
  fields: [
    { name: 'Queue', value: `${depth}/50`, inline: true },
    { name: 'Active', value: String(activeCount), inline: true },
    { name: 'Completed (24h)', value: String(completedCount), inline: true },
    { name: 'Blocked', value: blockerSummary || 'None', inline: false },
  ],
  footer: { text: `Generated ${now.toISOString()}` },
}
```

Paginate into multiple embeds if total character count > 6000.

**Slack formatter (`formatDigest`):**

```typescript
[
  { type: 'header', text: { type: 'plain_text', text: 'Daily Pipeline Digest' } },
  {
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: `*Queue:*\n${depth}/50` },
      { type: 'mrkdwn', text: `*Active:*\n${activeCount}` },
      { type: 'mrkdwn', text: `*Completed (24h):*\n${completedCount}` },
      { type: 'mrkdwn', text: `*Paused:*\n${pausedCount}` },
    ],
  },
  // Conditional blocker section
  ...(blockedRequests.length > 0 ? [{
    type: 'section',
    text: { type: 'mrkdwn', text: `:warning: *Blocked Requests:*\n${blockerList}` },
  }] : []),
  { type: 'context', elements: [{ type: 'mrkdwn', text: `Generated ${formatRelativeTime(now)}` }] },
]
```

Paginate into multiple messages if > 50 blocks or > 3000 chars per text block.

**All formatters handle empty digest**: If `isEmptyDigest` returns true (no active, blocked, or completed requests), the digest is skipped (not sent as an empty message).

## Acceptance Criteria

1. `calculateNextRun("09:00")` at 08:00 returns ~1 hour. At 10:00 returns ~23 hours.
2. Timer reschedules after each execution (no accumulated drift).
3. `stop()` clears the timer.
4. `buildDigest()` queries DB for active-by-state, blocked, completed-24h, queue depth by priority.
5. Empty digest (no activity) is skipped, not sent.
6. CLI digest format is plain text without ANSI codes.
7. Discord digest is a blue embed with inline fields.
8. Slack digest uses Block Kit with header, section fields, and conditional blocker section.
9. Discord digest paginates into multiple embeds at 6000 chars.
10. Slack digest respects 50-block and 3000-char limits.

## Test Cases

1. **Schedule: before target time**: At 08:00, target 09:00; verify next run ~3600000ms.
2. **Schedule: after target time**: At 10:00, target 09:00; verify next run ~82800000ms (next day).
3. **Schedule: exact target time**: At 09:00, target 09:00; verify next run ~86400000ms (next day).
4. **BuildDigest: populated**: Insert 3 active, 2 blocked, 1 completed; verify digest data matches.
5. **BuildDigest: empty**: No requests in DB; verify `isEmptyDigest` returns true.
6. **Empty digest skipped**: Generate with empty data; verify `sendMessage` NOT called.
7. **CLI digest format**: Verify output contains "Active Requests:", counts match, no ANSI codes.
8. **CLI digest empty sections**: No blocked requests; verify "Blocked Requests:" section omitted.
9. **Discord digest embed**: Verify title "Daily Pipeline Digest", color 0x3498db, 4 fields.
10. **Discord digest pagination**: Generate digest > 6000 chars; verify multiple embeds returned.
11. **Slack digest blocks**: Verify header + section fields + conditional blocker + context blocks.
12. **Slack digest block limit**: Generate > 50 blocks; verify split into multiple messages.
13. **Stop clears timer**: Call `start()`, then `stop()`; verify timeout cleared.
14. **Rescheduling**: After digest sends, verify `start()` called again with updated timer.
15. **Missing adapter**: Configure digest for unavailable channel; verify warning logged, no crash.
