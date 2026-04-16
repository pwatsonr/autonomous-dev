/**
 * Unit tests for DiscordFormatter (SPEC-008-3-03, Task 5).
 *
 * Covers spec test cases 1-8, 17-18:
 *  1. Embed: queued phase color (0x95a5a6)
 *  2. Embed: execution phase color (0x2ecc71)
 *  3. Embed: failed phase color (0xe74c3c)
 *  4. Embed: title truncation at 50 chars + "..."
 *  5. Embed: short title (no truncation)
 *  6. Embed: all 5 fields present, all inline: true
 *  7. Embed: blocker shown
 *  8. Embed: no blocker -> "None"
 * 17. Digest embed: fields for active count, blocked, completed 24h, queue depth
 * 18. Error embed: red color, error code in title
 *
 * @module discord_formatter.test
 */

import {
  DiscordFormatter,
  PHASE_COLORS,
  truncate,
  type DiscordEmbed,
  type RequestWithDisplayName,
} from '../../../notifications/formatters/discord_formatter';
import type { RequestEntity } from '../../../db/repository';
import type { ErrorResponse } from '../../../adapters/adapter_interface';
import type { DigestData } from '../../../notifications/formatters/cli_formatter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal RequestWithDisplayName for testing. */
function makeRequest(overrides: Partial<RequestWithDisplayName> = {}): RequestWithDisplayName {
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
    requester_display_name: 'Alice',
    source_channel: 'discord',
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DiscordFormatter (SPEC-008-3-03, Task 5)', () => {
  const formatter = new DiscordFormatter();

  // -----------------------------------------------------------------------
  // Test 1: Embed: queued phase color
  // -----------------------------------------------------------------------
  test('queued phase returns color 0x95a5a6', () => {
    const request = makeRequest({ current_phase: 'queued' });
    const embed = formatter.formatStatusEmbed(request);
    expect(embed.color).toBe(0x95a5a6);
  });

  // -----------------------------------------------------------------------
  // Test 2: Embed: execution phase color
  // -----------------------------------------------------------------------
  test('execution phase returns color 0x2ecc71', () => {
    const request = makeRequest({ current_phase: 'execution' });
    const embed = formatter.formatStatusEmbed(request);
    expect(embed.color).toBe(0x2ecc71);
  });

  // -----------------------------------------------------------------------
  // Test 3: Embed: failed phase color
  // -----------------------------------------------------------------------
  test('failed phase returns color 0xe74c3c', () => {
    const request = makeRequest({ current_phase: 'failed' });
    const embed = formatter.formatStatusEmbed(request);
    expect(embed.color).toBe(0xe74c3c);
  });

  // -----------------------------------------------------------------------
  // Test 4: Embed: title truncation at 50 chars
  // -----------------------------------------------------------------------
  test('title longer than 50 chars is truncated with "..."', () => {
    const longTitle = 'A'.repeat(60); // 60 characters
    const request = makeRequest({ title: longTitle });
    const embed = formatter.formatStatusEmbed(request);

    // Title format: "{requestId}: {truncated title}"
    expect(embed.title).toBe(`REQ-000042: ${'A'.repeat(50)}...`);
  });

  // -----------------------------------------------------------------------
  // Test 5: Embed: short title not truncated
  // -----------------------------------------------------------------------
  test('title with 30 chars is not truncated', () => {
    const shortTitle = 'B'.repeat(30);
    const request = makeRequest({ title: shortTitle });
    const embed = formatter.formatStatusEmbed(request);

    expect(embed.title).toBe(`REQ-000042: ${shortTitle}`);
    expect(embed.title).not.toContain('...');
  });

  // -----------------------------------------------------------------------
  // Test 6: Embed: all 5 fields present, all inline
  // -----------------------------------------------------------------------
  test('embed has 5 inline fields: Phase, Priority, Progress, Age, Blocker', () => {
    const request = makeRequest();
    const embed = formatter.formatStatusEmbed(request);

    expect(embed.fields).toHaveLength(5);
    expect(embed.fields.every((f) => f.inline === true)).toBe(true);

    const fieldNames = embed.fields.map((f) => f.name);
    expect(fieldNames).toEqual(['Phase', 'Priority', 'Progress', 'Age', 'Blocker']);
  });

  // -----------------------------------------------------------------------
  // Test 7: Embed: blocker shown
  // -----------------------------------------------------------------------
  test('request with blocker shows blocker text in Blocker field', () => {
    const request = makeRequest({ blocker: 'Waiting for API key' });
    const embed = formatter.formatStatusEmbed(request);

    const blockerField = embed.fields.find((f) => f.name === 'Blocker');
    expect(blockerField).toBeDefined();
    expect(blockerField!.value).toBe('Waiting for API key');
  });

  // -----------------------------------------------------------------------
  // Test 8: Embed: no blocker -> "None"
  // -----------------------------------------------------------------------
  test('request without blocker shows "None" in Blocker field', () => {
    const request = makeRequest({ blocker: null });
    const embed = formatter.formatStatusEmbed(request);

    const blockerField = embed.fields.find((f) => f.name === 'Blocker');
    expect(blockerField).toBeDefined();
    expect(blockerField!.value).toBe('None');
  });

  // -----------------------------------------------------------------------
  // Embed footer: requester display name
  // -----------------------------------------------------------------------
  test('footer shows requester display name', () => {
    const request = makeRequest({ requester_display_name: 'Bob' });
    const embed = formatter.formatStatusEmbed(request);

    expect(embed.footer).toBeDefined();
    expect(embed.footer!.text).toBe('Requested by Bob');
  });

  // -----------------------------------------------------------------------
  // Embed timestamp: updated_at
  // -----------------------------------------------------------------------
  test('timestamp is set to updated_at', () => {
    const updatedAt = '2026-04-08T12:00:00.000Z';
    const request = makeRequest({ updated_at: updatedAt });
    const embed = formatter.formatStatusEmbed(request);

    expect(embed.timestamp).toBe(updatedAt);
  });

  // -----------------------------------------------------------------------
  // Phase color map completeness: all 14 phases
  // -----------------------------------------------------------------------
  test('all 14 phases have defined colors', () => {
    const phases = [
      'queued', 'prd_generation', 'prd_review', 'tdd_generation',
      'tdd_review', 'planning', 'spec', 'execution', 'code_review',
      'merged', 'done', 'paused', 'cancelled', 'failed',
    ];

    for (const phase of phases) {
      expect(PHASE_COLORS[phase]).toBeDefined();
      expect(typeof PHASE_COLORS[phase]).toBe('number');
    }
  });

  // -----------------------------------------------------------------------
  // Unknown phase falls back to gray
  // -----------------------------------------------------------------------
  test('unknown phase falls back to gray (0x95a5a6)', () => {
    const request = makeRequest({ current_phase: 'unknown_phase' });
    const embed = formatter.formatStatusEmbed(request);
    expect(embed.color).toBe(0x95a5a6);
  });

  // -----------------------------------------------------------------------
  // Test 17: Digest embed: fields for active, blocked, completed 24h, queue depth
  // -----------------------------------------------------------------------
  test('digest embed has fields for active count, blocked, completed 24h, queue depth', () => {
    const digest: DigestData = {
      generatedAt: new Date(),
      activeByState: { queued: 3, active: 2, paused: 1, cancelled: 0, done: 5, failed: 0 },
      blockedRequests: [],
      completedLast24h: [],
      queueDepth: 3,
      queueDepthByPriority: { high: 1, normal: 1, low: 1 },
    };

    const result = formatter.formatDigest(digest);
    const embed = result.payload as DiscordEmbed;

    const fieldNames = embed.fields.map((f) => f.name);
    expect(fieldNames).toContain('Active Requests');
    expect(fieldNames).toContain('Blocked');
    expect(fieldNames).toContain('Completed (24h)');
    expect(fieldNames).toContain('Queue Depth');

    // Active count = queued + active + paused = 3 + 2 + 1 = 6
    const activeField = embed.fields.find((f) => f.name === 'Active Requests');
    expect(activeField!.value).toBe('6');

    // Queue depth by priority
    const queueField = embed.fields.find((f) => f.name === 'Queue Depth');
    expect(queueField!.value).toContain('High: 1');
    expect(queueField!.value).toContain('Normal: 1');
    expect(queueField!.value).toContain('Low: 1');
  });

  // -----------------------------------------------------------------------
  // Test 18: Error embed: red color, error code in title
  // -----------------------------------------------------------------------
  test('error embed has red color (0xe74c3c) and error code in title', () => {
    const error: ErrorResponse = {
      success: false,
      error: 'Something went wrong',
      errorCode: 'INTERNAL_ERROR',
    };

    const result = formatter.formatError(error);
    const embed = result.payload as DiscordEmbed;

    expect(embed.color).toBe(0xe74c3c);
    expect(embed.title).toContain('INTERNAL_ERROR');
    expect(embed.description).toBe('Something went wrong');
  });

  // -----------------------------------------------------------------------
  // Phase transition embed
  // -----------------------------------------------------------------------
  test('phase transition embed has correct from/to fields and new phase color', () => {
    const request = makeRequest();
    const event = {
      requestId: 'REQ-000042',
      fromPhase: 'prd_generation',
      toPhase: 'prd_review',
      timestamp: new Date(),
      metadata: {},
    };

    const result = formatter.formatPhaseTransition(request, event);
    const embed = result.payload as DiscordEmbed;

    expect(embed.title).toContain('Phase Change');
    expect(embed.color).toBe(PHASE_COLORS['prd_review']);

    const fromField = embed.fields.find((f) => f.name === 'From');
    expect(fromField!.value).toBe('Prd Generation');

    const toField = embed.fields.find((f) => f.name === 'To');
    expect(toField!.value).toBe('Prd Review');
  });

  // -----------------------------------------------------------------------
  // truncate helper
  // -----------------------------------------------------------------------
  describe('truncate', () => {
    test('does not truncate string at or below maxLen', () => {
      expect(truncate('hello', 5)).toBe('hello');
      expect(truncate('hello', 10)).toBe('hello');
    });

    test('truncates string above maxLen and appends "..."', () => {
      expect(truncate('hello world', 5)).toBe('hello...');
    });
  });

  // -----------------------------------------------------------------------
  // formatStatusCard (NotificationFormatter interface)
  // -----------------------------------------------------------------------
  test('formatStatusCard returns a FormattedMessage with channelType "discord"', () => {
    const request = makeRequest();
    const result = formatter.formatStatusCard(request);

    expect(result.channelType).toBe('discord');
    expect(result.payload).toBeDefined();
    expect(typeof result.fallbackText).toBe('string');
  });
});
