/**
 * Unit tests for DigestScheduler (SPEC-008-5-02, Task 5 & Task 6).
 *
 * Covers all 15 test cases from the spec:
 *  1. Schedule: before target time
 *  2. Schedule: after target time
 *  3. Schedule: exact target time
 *  4. BuildDigest: populated
 *  5. BuildDigest: empty
 *  6. Empty digest skipped
 *  7. CLI digest format
 *  8. CLI digest empty sections
 *  9. Discord digest embed
 * 10. Discord digest pagination
 * 11. Slack digest blocks
 * 12. Slack digest block limit
 * 13. Stop clears timer
 * 14. Rescheduling
 * 15. Missing adapter
 *
 * @module digest_scheduler.test
 */

import {
  DigestScheduler,
  type DigestConfig,
  type DigestLogger,
} from '../../notifications/digest_scheduler';
import { CLIFormatter, type DigestData } from '../../notifications/formatters/cli_formatter';
import { DiscordFormatter, type DiscordEmbed } from '../../notifications/formatters/discord_formatter';
import { SlackFormatter, type SlackBlock } from '../../notifications/formatters/slack_formatter';
import type { RequestEntity } from '../../db/repository';
import type {
  ChannelType,
  FormattedMessage,
  IntakeAdapter,
  MessageTarget,
  DeliveryReceipt,
} from '../../adapters/adapter_interface';
import type { NotificationFormatter } from '../../notifications/formatters/cli_formatter';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Create a minimal RequestEntity for testing. */
function makeRequest(overrides: Partial<RequestEntity> = {}): RequestEntity {
  return {
    request_id: 'REQ-000042',
    title: 'Build user auth with OAuth2',
    description: 'Implement full OAuth2 authentication flow',
    raw_input: 'Build user auth with OAuth2',
    priority: 'high',
    target_repo: 'owner/repo',
    status: 'active',
    current_phase: 'tdd_generation',
    phase_progress: null,
    requester_id: 'user-1',
    source_channel: 'claude_app',
    notification_config: '{}',
    deadline: null,
    related_tickets: '[]',
    technical_constraints: null,
    acceptance_criteria: null,
    blocker: null,
    promotion_count: 0,
    last_promoted_at: null,
    paused_at_phase: null,
    created_at: new Date(Date.now() - 8_040_000).toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Create a mock Repository with configurable return values. */
function createMockDb(overrides: {
  countRequestsByState?: Record<string, number>;
  blockedRequests?: RequestEntity[];
  completedSince?: RequestEntity[];
  queuedCount?: number;
  queuedCountByPriority?: Record<string, number>;
} = {}) {
  return {
    countRequestsByState: jest.fn().mockReturnValue(
      overrides.countRequestsByState ?? {
        queued: 0, active: 0, paused: 0, cancelled: 0, done: 0, failed: 0,
      },
    ),
    getBlockedRequests: jest.fn().mockReturnValue(overrides.blockedRequests ?? []),
    getCompletedSince: jest.fn().mockReturnValue(overrides.completedSince ?? []),
    getQueuedRequestCount: jest.fn().mockReturnValue(overrides.queuedCount ?? 0),
    getQueuedCountByPriority: jest.fn().mockReturnValue(
      overrides.queuedCountByPriority ?? { high: 0, normal: 0, low: 0 },
    ),
  };
}

/** Create a mock adapter that tracks sendMessage calls. */
function createMockAdapter(channelType: ChannelType): IntakeAdapter & {
  sendMessage: jest.Mock;
} {
  return {
    channelType,
    start: jest.fn().mockResolvedValue({ dispose: jest.fn() }),
    sendMessage: jest.fn().mockResolvedValue({ success: true } as DeliveryReceipt),
    promptUser: jest.fn(),
    shutdown: jest.fn().mockResolvedValue(undefined),
  };
}

/** Create a mock logger that records calls. */
function createMockLogger(): DigestLogger & {
  infoCalls: Array<{ message: string; context?: Record<string, unknown> }>;
  warnCalls: Array<{ message: string; context?: Record<string, unknown> }>;
  errorCalls: Array<{ message: string; context?: Record<string, unknown> }>;
} {
  const infoCalls: Array<{ message: string; context?: Record<string, unknown> }> = [];
  const warnCalls: Array<{ message: string; context?: Record<string, unknown> }> = [];
  const errorCalls: Array<{ message: string; context?: Record<string, unknown> }> = [];

  return {
    info: jest.fn((message: string, context?: Record<string, unknown>) => {
      infoCalls.push({ message, context });
    }),
    warn: jest.fn((message: string, context?: Record<string, unknown>) => {
      warnCalls.push({ message, context });
    }),
    error: jest.fn((message: string, context?: Record<string, unknown>) => {
      errorCalls.push({ message, context });
    }),
    infoCalls,
    warnCalls,
    errorCalls,
  };
}

/** Default digest config for tests. */
const defaultConfig: DigestConfig = {
  daily_digest_time: '09:00',
  channel_type: 'claude_app',
  daily_digest_channel: 'digest-channel',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DigestScheduler (SPEC-008-5-02)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Test 1: Schedule: before target time
  // -----------------------------------------------------------------------
  test('calculateNextRun at 08:00 with target 09:00 returns ~3600000ms', () => {
    const db = createMockDb();
    const scheduler = new DigestScheduler(
      db as any,
      new Map(),
      new Map(),
    );

    // Mock "now" as 08:00:00
    const now = new Date();
    now.setHours(8, 0, 0, 0);
    jest.setSystemTime(now);

    const result = scheduler.calculateNextRun('09:00');

    // Should be approximately 1 hour (3600000ms)
    expect(result).toBe(3_600_000);
  });

  // -----------------------------------------------------------------------
  // Test 2: Schedule: after target time
  // -----------------------------------------------------------------------
  test('calculateNextRun at 10:00 with target 09:00 returns ~82800000ms (next day)', () => {
    const db = createMockDb();
    const scheduler = new DigestScheduler(
      db as any,
      new Map(),
      new Map(),
    );

    // Mock "now" as 10:00:00
    const now = new Date();
    now.setHours(10, 0, 0, 0);
    jest.setSystemTime(now);

    const result = scheduler.calculateNextRun('09:00');

    // Should be ~23 hours (82800000ms)
    expect(result).toBe(82_800_000);
  });

  // -----------------------------------------------------------------------
  // Test 3: Schedule: exact target time
  // -----------------------------------------------------------------------
  test('calculateNextRun at 09:00 with target 09:00 returns ~86400000ms (next day)', () => {
    const db = createMockDb();
    const scheduler = new DigestScheduler(
      db as any,
      new Map(),
      new Map(),
    );

    // Mock "now" as exactly 09:00:00.000
    const now = new Date();
    now.setHours(9, 0, 0, 0);
    jest.setSystemTime(now);

    const result = scheduler.calculateNextRun('09:00');

    // At exactly target time, should schedule for next day (86400000ms)
    expect(result).toBe(86_400_000);
  });

  // -----------------------------------------------------------------------
  // Test 4: BuildDigest: populated
  // -----------------------------------------------------------------------
  test('generateAndSendDigest with populated data sends digest', async () => {
    const blockedReq = makeRequest({
      request_id: 'REQ-000015',
      blocker: 'Waiting for API credentials',
      status: 'active',
    });
    const completedReq = makeRequest({
      request_id: 'REQ-000012',
      title: 'Build user auth system',
      status: 'done',
    });

    const db = createMockDb({
      countRequestsByState: {
        queued: 3, active: 2, paused: 1, cancelled: 0, done: 5, failed: 0,
      },
      blockedRequests: [blockedReq],
      completedSince: [completedReq],
      queuedCount: 3,
      queuedCountByPriority: { high: 1, normal: 1, low: 1 },
    });

    const adapter = createMockAdapter('claude_app');
    const adapters = new Map<ChannelType, IntakeAdapter>([['claude_app', adapter]]);

    const formatter = new CLIFormatter();
    const formatters = new Map<ChannelType, NotificationFormatter>([['claude_app', formatter]]);

    const logger = createMockLogger();
    const scheduler = new DigestScheduler(db as any, adapters, formatters, logger);

    await scheduler.generateAndSendDigest(defaultConfig);

    // Verify sendMessage was called
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);

    // Verify the target
    const [target] = adapter.sendMessage.mock.calls[0];
    expect(target.channelType).toBe('claude_app');
    expect(target.platformChannelId).toBe('digest-channel');

    // Verify DB methods were called
    expect(db.countRequestsByState).toHaveBeenCalled();
    expect(db.getBlockedRequests).toHaveBeenCalled();
    expect(db.getCompletedSince).toHaveBeenCalled();
    expect(db.getQueuedRequestCount).toHaveBeenCalled();
    expect(db.getQueuedCountByPriority).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Test 5: BuildDigest: empty
  // -----------------------------------------------------------------------
  test('isEmptyDigest returns true when no activity', () => {
    const db = createMockDb();
    const scheduler = new DigestScheduler(db as any, new Map(), new Map());

    const emptyDigest: DigestData = {
      generatedAt: new Date(),
      activeByState: { queued: 0, active: 0, paused: 0, cancelled: 0, done: 0, failed: 0 },
      blockedRequests: [],
      completedLast24h: [],
      queueDepth: 0,
      queueDepthByPriority: { high: 0, normal: 0, low: 0 },
    };

    expect(scheduler.isEmptyDigest(emptyDigest)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 6: Empty digest skipped
  // -----------------------------------------------------------------------
  test('empty digest is skipped and sendMessage is NOT called', async () => {
    const db = createMockDb();

    const adapter = createMockAdapter('claude_app');
    const adapters = new Map<ChannelType, IntakeAdapter>([['claude_app', adapter]]);

    const formatter = new CLIFormatter();
    const formatters = new Map<ChannelType, NotificationFormatter>([['claude_app', formatter]]);

    const logger = createMockLogger();
    const scheduler = new DigestScheduler(db as any, adapters, formatters, logger);

    await scheduler.generateAndSendDigest(defaultConfig);

    // sendMessage should NOT be called
    expect(adapter.sendMessage).not.toHaveBeenCalled();

    // Logger should indicate skip
    expect(logger.info).toHaveBeenCalledWith(
      'Digest skipped: no activity in last 24 hours',
    );
  });

  // -----------------------------------------------------------------------
  // Test 7: CLI digest format
  // -----------------------------------------------------------------------
  test('CLI digest format contains "Active Requests:" and counts match, no ANSI codes', () => {
    const formatter = new CLIFormatter();

    const digest: DigestData = {
      generatedAt: new Date('2026-04-08T09:00:00Z'),
      activeByState: { queued: 3, active: 2, paused: 1, cancelled: 0, done: 2, failed: 0 },
      blockedRequests: [
        makeRequest({
          request_id: 'REQ-000015',
          blocker: 'Waiting for API credentials',
          status: 'active',
        }),
      ],
      completedLast24h: [
        makeRequest({
          request_id: 'REQ-000012',
          title: 'Build user auth system',
          status: 'done',
        }),
      ],
      queueDepth: 3,
      queueDepthByPriority: { high: 1, normal: 1, low: 1 },
    };

    const result = formatter.formatDigest(digest);
    const text = result.payload as string;

    // Verify text content
    expect(text).toContain('Active Requests:');
    expect(text).toContain('Queued:    3');
    expect(text).toContain('Active:    2');
    expect(text).toContain('Paused:    1');
    expect(text).toContain('Total:     6');

    // Verify no ANSI codes (plain text)
    expect(text).not.toMatch(/\x1b\[/);

    // Verify fallbackText equals payload (no ANSI in digest)
    expect(result.payload).toBe(result.fallbackText);
  });

  // -----------------------------------------------------------------------
  // Test 8: CLI digest empty sections
  // -----------------------------------------------------------------------
  test('CLI digest omits "Blocked Requests:" section when no blocked requests', () => {
    const formatter = new CLIFormatter();

    const digest: DigestData = {
      generatedAt: new Date('2026-04-08T09:00:00Z'),
      activeByState: { queued: 1, active: 1, paused: 0, cancelled: 0, done: 0, failed: 0 },
      blockedRequests: [],
      completedLast24h: [],
      queueDepth: 1,
      queueDepthByPriority: { high: 0, normal: 1, low: 0 },
    };

    const result = formatter.formatDigest(digest);
    const text = result.payload as string;

    // Blocked section should be omitted
    expect(text).not.toContain('Blocked Requests:');

    // Completed section should also be omitted
    expect(text).not.toContain('Completed (last 24h):');
  });

  // -----------------------------------------------------------------------
  // Test 9: Discord digest embed
  // -----------------------------------------------------------------------
  test('Discord digest has title "Pipeline Digest", color 0x3498db, 4 fields', () => {
    const formatter = new DiscordFormatter();

    const digest: DigestData = {
      generatedAt: new Date('2026-04-08T09:00:00Z'),
      activeByState: { queued: 3, active: 2, paused: 1, cancelled: 0, done: 5, failed: 0 },
      blockedRequests: [],
      completedLast24h: [],
      queueDepth: 3,
      queueDepthByPriority: { high: 1, normal: 1, low: 1 },
    };

    const result = formatter.formatDigest(digest);
    const embed = result.payload as DiscordEmbed;

    expect(embed.title).toContain('Pipeline Digest');
    expect(embed.color).toBe(0x3498db);

    // Should have at least 4 fields: Active Requests, Blocked, Completed (24h), Queue Depth
    expect(embed.fields.length).toBeGreaterThanOrEqual(4);

    const fieldNames = embed.fields.map((f) => f.name);
    expect(fieldNames).toContain('Active Requests');
    expect(fieldNames).toContain('Blocked');
    expect(fieldNames).toContain('Completed (24h)');
    expect(fieldNames).toContain('Queue Depth');
  });

  // -----------------------------------------------------------------------
  // Test 10: Discord digest pagination
  // -----------------------------------------------------------------------
  test('Discord digest paginates into multiple embeds at 6000 chars', () => {
    const formatter = new DiscordFormatter();

    // Create many blocked requests with long blocker text to exceed 6000 chars
    const longBlocker = 'A'.repeat(200);
    const blockedRequests: RequestEntity[] = [];
    for (let i = 0; i < 30; i++) {
      blockedRequests.push(
        makeRequest({
          request_id: `REQ-${String(i).padStart(6, '0')}`,
          blocker: `${longBlocker} blocker ${i}`,
          status: 'active',
        }),
      );
    }

    const digest: DigestData = {
      generatedAt: new Date('2026-04-08T09:00:00Z'),
      activeByState: { queued: 3, active: 30, paused: 1, cancelled: 0, done: 5, failed: 0 },
      blockedRequests,
      completedLast24h: [],
      queueDepth: 3,
      queueDepthByPriority: { high: 1, normal: 1, low: 1 },
    };

    const result = formatter.formatDigest(digest);

    // Should be multiple embeds (array)
    expect(Array.isArray(result.payload)).toBe(true);
    const embeds = result.payload as DiscordEmbed[];
    expect(embeds.length).toBeGreaterThan(1);

    // All embeds should have the digest title or continuation
    expect(embeds[0].title).toContain('Pipeline Digest');
    for (let i = 1; i < embeds.length; i++) {
      expect(embeds[i].title).toContain('Pipeline Digest');
    }
  });

  // -----------------------------------------------------------------------
  // Test 11: Slack digest blocks
  // -----------------------------------------------------------------------
  test('Slack digest has header + section fields + conditional blocker + context blocks', () => {
    const formatter = new SlackFormatter();

    const digest: DigestData = {
      generatedAt: new Date('2026-04-08T09:00:00Z'),
      activeByState: { queued: 3, active: 2, paused: 1, cancelled: 0, done: 5, failed: 0 },
      blockedRequests: [
        makeRequest({
          request_id: 'REQ-000015',
          blocker: 'Waiting for API credentials',
          status: 'active',
        }),
      ],
      completedLast24h: [
        makeRequest({
          request_id: 'REQ-000012',
          title: 'Build user auth system',
          status: 'done',
        }),
      ],
      queueDepth: 3,
      queueDepthByPriority: { high: 1, normal: 1, low: 1 },
    };

    const result = formatter.formatDigest(digest);
    const blocks = result.payload as SlackBlock[];

    // Should have header block
    expect(blocks[0]).toEqual(
      expect.objectContaining({ type: 'header' }),
    );

    // Should have section with fields
    expect(blocks[1]).toEqual(
      expect.objectContaining({ type: 'section' }),
    );
    expect(blocks[1]).toHaveProperty('fields');

    // Should have blocker section (since there are blocked requests)
    const blockerBlock = blocks.find(
      (b) => b.type === 'section' &&
        typeof (b as any).text === 'object' &&
        typeof (b as any).text?.text === 'string' &&
        ((b as any).text.text as string).includes(':warning:'),
    );
    expect(blockerBlock).toBeDefined();

    // Should have context block at the end
    const contextBlock = blocks[blocks.length - 1];
    expect(contextBlock).toEqual(
      expect.objectContaining({ type: 'context' }),
    );

    // Verify the section fields contain expected mrkdwn content
    const sectionFields = (blocks[1] as any).fields;
    const fieldTexts = sectionFields.map((f: any) => f.text);
    const hasActiveCount = fieldTexts.some((t: string) => t.includes('Active Requests'));
    const hasBlocked = fieldTexts.some((t: string) => t.includes('Blocked'));
    const hasCompleted = fieldTexts.some((t: string) => t.includes('Completed'));
    const hasQueueDepth = fieldTexts.some((t: string) => t.includes('Queue Depth'));

    expect(hasActiveCount).toBe(true);
    expect(hasBlocked).toBe(true);
    expect(hasCompleted).toBe(true);
    expect(hasQueueDepth).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 12: Slack digest block limit
  // -----------------------------------------------------------------------
  test('Slack digest splits into multiple messages if > 50 blocks', () => {
    const formatter = new SlackFormatter();

    // Create enough blocked + completed requests to generate > 50 blocks.
    // Each blocked request adds 1 block, each completed adds 1 block.
    // Base blocks: header(1) + section(1) + context(1) = 3
    // Need 48+ additional blocks from blocker/completed sections.
    // But each group is a single section block with multiple lines.
    // To actually exceed 50 blocks, we would need the formatter to produce
    // individual blocks per request. The current Slack formatter aggregates
    // into single sections, so the realistic limit test checks the
    // paginateBlocks function directly.

    // Instead, we test paginateBlocks directly since the formatter delegates
    // to it for block limit enforcement.
    const { paginateBlocks, MAX_BLOCKS_PER_MESSAGE } = require('../../notifications/formatters/slack_formatter');

    // Create 55 blocks
    const blocks: SlackBlock[] = [];
    for (let i = 0; i < 55; i++) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `Block ${i}` },
      });
    }

    const pages = paginateBlocks(blocks);

    expect(pages.length).toBe(2);
    expect(pages[0].length).toBe(MAX_BLOCKS_PER_MESSAGE);
    expect(pages[1].length).toBe(5);
  });

  // -----------------------------------------------------------------------
  // Test 13: Stop clears timer
  // -----------------------------------------------------------------------
  test('stop() clears the scheduled timer', () => {
    const db = createMockDb();
    const scheduler = new DigestScheduler(db as any, new Map(), new Map());

    // Set time to 08:00
    const now = new Date();
    now.setHours(8, 0, 0, 0);
    jest.setSystemTime(now);

    scheduler.start(defaultConfig);

    // Verify there is a pending timer
    expect(jest.getTimerCount()).toBe(1);

    scheduler.stop();

    // Timer should be cleared
    expect(jest.getTimerCount()).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 14: Rescheduling
  // -----------------------------------------------------------------------
  test('after digest sends, start() is called again with updated timer', async () => {
    const db = createMockDb({
      countRequestsByState: {
        queued: 1, active: 0, paused: 0, cancelled: 0, done: 0, failed: 0,
      },
      queuedCount: 1,
      queuedCountByPriority: { high: 1, normal: 0, low: 0 },
    });

    const adapter = createMockAdapter('claude_app');
    const adapters = new Map<ChannelType, IntakeAdapter>([['claude_app', adapter]]);

    const formatter = new CLIFormatter();
    const formatters = new Map<ChannelType, NotificationFormatter>([['claude_app', formatter]]);

    const logger = createMockLogger();
    const scheduler = new DigestScheduler(db as any, adapters, formatters, logger);

    // Spy on start to confirm rescheduling
    const startSpy = jest.spyOn(scheduler, 'start');

    // Set time to 08:00, target 09:00 (1 hour delay)
    const now = new Date();
    now.setHours(8, 0, 0, 0);
    jest.setSystemTime(now);

    scheduler.start(defaultConfig);

    expect(startSpy).toHaveBeenCalledTimes(1);

    // Advance to the scheduled time
    await jest.advanceTimersByTimeAsync(3_600_000);

    // start should have been called again (rescheduling)
    expect(startSpy).toHaveBeenCalledTimes(2);

    // Clean up
    scheduler.stop();
    startSpy.mockRestore();
  });

  // -----------------------------------------------------------------------
  // Test 15: Missing adapter
  // -----------------------------------------------------------------------
  test('missing adapter logs warning and does not crash', async () => {
    const db = createMockDb({
      countRequestsByState: {
        queued: 1, active: 0, paused: 0, cancelled: 0, done: 0, failed: 0,
      },
      queuedCount: 1,
      queuedCountByPriority: { high: 1, normal: 0, low: 0 },
    });

    // No adapters available
    const adapters = new Map<ChannelType, IntakeAdapter>();

    const formatter = new CLIFormatter();
    const formatters = new Map<ChannelType, NotificationFormatter>([['claude_app', formatter]]);

    const logger = createMockLogger();
    const scheduler = new DigestScheduler(db as any, adapters, formatters, logger);

    // Should not throw
    await expect(
      scheduler.generateAndSendDigest(defaultConfig),
    ).resolves.toBeUndefined();

    // Should have logged a warning
    expect(logger.warn).toHaveBeenCalledWith(
      'Adapter unavailable for digest delivery',
      expect.objectContaining({ channelType: 'claude_app' }),
    );
  });

  // -----------------------------------------------------------------------
  // Additional edge case: missing formatter
  // -----------------------------------------------------------------------
  test('missing formatter logs warning and does not crash', async () => {
    const db = createMockDb({
      countRequestsByState: {
        queued: 1, active: 0, paused: 0, cancelled: 0, done: 0, failed: 0,
      },
      queuedCount: 1,
      queuedCountByPriority: { high: 1, normal: 0, low: 0 },
    });

    const adapter = createMockAdapter('claude_app');
    const adapters = new Map<ChannelType, IntakeAdapter>([['claude_app', adapter]]);

    // No formatters available
    const formatters = new Map<ChannelType, NotificationFormatter>();

    const logger = createMockLogger();
    const scheduler = new DigestScheduler(db as any, adapters, formatters, logger);

    // Should not throw
    await expect(
      scheduler.generateAndSendDigest(defaultConfig),
    ).resolves.toBeUndefined();

    // Should have logged a warning
    expect(logger.warn).toHaveBeenCalledWith(
      'No formatter for digest channel type',
      expect.objectContaining({ channelType: 'claude_app' }),
    );

    // sendMessage should NOT be called
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // isEmptyDigest with activity returns false
  // -----------------------------------------------------------------------
  test('isEmptyDigest returns false when there are active requests', () => {
    const db = createMockDb();
    const scheduler = new DigestScheduler(db as any, new Map(), new Map());

    const digest: DigestData = {
      generatedAt: new Date(),
      activeByState: { queued: 1, active: 0, paused: 0, cancelled: 0, done: 0, failed: 0 },
      blockedRequests: [],
      completedLast24h: [],
      queueDepth: 1,
      queueDepthByPriority: { high: 1, normal: 0, low: 0 },
    };

    expect(scheduler.isEmptyDigest(digest)).toBe(false);
  });

  test('isEmptyDigest returns false when there are blocked requests', () => {
    const db = createMockDb();
    const scheduler = new DigestScheduler(db as any, new Map(), new Map());

    const digest: DigestData = {
      generatedAt: new Date(),
      activeByState: { queued: 0, active: 0, paused: 0, cancelled: 0, done: 0, failed: 0 },
      blockedRequests: [makeRequest({ blocker: 'test' })],
      completedLast24h: [],
      queueDepth: 0,
      queueDepthByPriority: { high: 0, normal: 0, low: 0 },
    };

    expect(scheduler.isEmptyDigest(digest)).toBe(false);
  });

  test('isEmptyDigest returns false when there are completed requests', () => {
    const db = createMockDb();
    const scheduler = new DigestScheduler(db as any, new Map(), new Map());

    const digest: DigestData = {
      generatedAt: new Date(),
      activeByState: { queued: 0, active: 0, paused: 0, cancelled: 0, done: 0, failed: 0 },
      blockedRequests: [],
      completedLast24h: [makeRequest({ status: 'done' })],
      queueDepth: 0,
      queueDepthByPriority: { high: 0, normal: 0, low: 0 },
    };

    expect(scheduler.isEmptyDigest(digest)).toBe(false);
  });
});
