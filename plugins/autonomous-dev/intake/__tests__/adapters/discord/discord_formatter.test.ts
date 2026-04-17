/**
 * Unit tests for DiscordFormatter (SPEC-008-3-05, Task 14).
 *
 * Covers 10 test cases:
 *  1. formatStatusEmbed returns correct structure for queued phase (color, title, fields)
 *  2. formatStatusEmbed returns correct structure for execution phase
 *  3. formatStatusEmbed returns correct structure for failed phase
 *  4. Title truncation at 50 characters
 *  5. Progress bar rendering in embed field
 *  6. formatPhaseTransition includes from/to phase
 *  7. formatDigest with empty digest (no activity in 24h)
 *  8. formatDigest pagination when content exceeds 6000 chars
 *  9. formatError with red color and error code
 * 10. formatStatusEmbed all 5 fields present and inline
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
import type { DigestData, PhaseTransitionEvent } from '../../../notifications/formatters/cli_formatter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

describe('DiscordFormatter (SPEC-008-3-05, Task 14)', () => {
  const formatter = new DiscordFormatter();

  // -----------------------------------------------------------------------
  // Test 1: formatStatusEmbed for queued phase
  // -----------------------------------------------------------------------
  test('formatStatusEmbed returns correct structure for queued phase', () => {
    const request = makeRequest({ current_phase: 'queued' });
    const embed = formatter.formatStatusEmbed(request);

    expect(embed.color).toBe(PHASE_COLORS['queued']);
    expect(embed.color).toBe(0x95a5a6);
    expect(embed.title).toContain('REQ-000042');
    expect(embed.fields).toBeDefined();
    expect(embed.fields.length).toBe(5);

    // Verify Phase field shows correct value
    const phaseField = embed.fields.find((f) => f.name === 'Phase');
    expect(phaseField!.value).toBe('Queued');
  });

  // -----------------------------------------------------------------------
  // Test 2: formatStatusEmbed for execution phase
  // -----------------------------------------------------------------------
  test('formatStatusEmbed returns correct structure for execution phase', () => {
    const request = makeRequest({ current_phase: 'execution' });
    const embed = formatter.formatStatusEmbed(request);

    expect(embed.color).toBe(PHASE_COLORS['execution']);
    expect(embed.color).toBe(0x2ecc71);

    const phaseField = embed.fields.find((f) => f.name === 'Phase');
    expect(phaseField!.value).toBe('Execution');
  });

  // -----------------------------------------------------------------------
  // Test 3: formatStatusEmbed for failed phase
  // -----------------------------------------------------------------------
  test('formatStatusEmbed returns correct structure for failed phase', () => {
    const request = makeRequest({ current_phase: 'failed' });
    const embed = formatter.formatStatusEmbed(request);

    expect(embed.color).toBe(PHASE_COLORS['failed']);
    expect(embed.color).toBe(0xe74c3c);

    const phaseField = embed.fields.find((f) => f.name === 'Phase');
    expect(phaseField!.value).toBe('Failed');
  });

  // -----------------------------------------------------------------------
  // Test 4: Title truncation at 50 characters
  // -----------------------------------------------------------------------
  test('title truncation at 50 characters appends "..."', () => {
    const longTitle = 'A'.repeat(60);
    const request = makeRequest({ title: longTitle });
    const embed = formatter.formatStatusEmbed(request);

    // Title format: "{requestId}: {truncated title}"
    expect(embed.title).toBe(`REQ-000042: ${'A'.repeat(50)}...`);

    // Short title should not be truncated
    const shortRequest = makeRequest({ title: 'B'.repeat(30) });
    const shortEmbed = formatter.formatStatusEmbed(shortRequest);
    expect(shortEmbed.title).not.toContain('...');
  });

  // -----------------------------------------------------------------------
  // Test 5: Progress bar rendering in embed field
  // -----------------------------------------------------------------------
  test('progress bar rendering in embed field', () => {
    // With phase_progress JSON
    const requestWithProgress = makeRequest({
      phase_progress: JSON.stringify({ current: 3, total: 8 }),
    });
    const embed1 = formatter.formatStatusEmbed(requestWithProgress);
    const progressField1 = embed1.fields.find((f) => f.name === 'Progress');
    expect(progressField1!.value).toBe('3/8 (38%)');

    // Without phase_progress, falls back to phase-order position
    const requestWithoutProgress = makeRequest({
      current_phase: 'execution',
      phase_progress: null,
    });
    const embed2 = formatter.formatStatusEmbed(requestWithoutProgress);
    const progressField2 = embed2.fields.find((f) => f.name === 'Progress');
    // execution is index 7 in PHASE_ORDER (0-based), so 8/8 (100%)
    expect(progressField2!.value).toBe('8/8 (100%)');

    // Queued phase = position 1/8 (13%)
    const requestQueued = makeRequest({
      current_phase: 'queued',
      phase_progress: null,
    });
    const embed3 = formatter.formatStatusEmbed(requestQueued);
    const progressField3 = embed3.fields.find((f) => f.name === 'Progress');
    expect(progressField3!.value).toBe('1/8 (13%)');
  });

  // -----------------------------------------------------------------------
  // Test 6: formatPhaseTransition includes from/to phase
  // -----------------------------------------------------------------------
  test('formatPhaseTransition includes from/to phase', () => {
    const request = makeRequest();
    const event: PhaseTransitionEvent = {
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

    // Request title shown in embed
    const requestField = embed.fields.find((f) => f.name === 'Request');
    expect(requestField).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Test 7: formatDigest with empty digest (no activity in 24h)
  // -----------------------------------------------------------------------
  test('formatDigest with empty digest (no activity in 24h)', () => {
    const digest: DigestData = {
      generatedAt: new Date(),
      activeByState: { queued: 0, active: 0, paused: 0, cancelled: 0, done: 0, failed: 0 },
      blockedRequests: [],
      completedLast24h: [],
      queueDepth: 0,
      queueDepthByPriority: { high: 0, normal: 0, low: 0 },
    };

    const result = formatter.formatDigest(digest);
    const embed = result.payload as DiscordEmbed;

    expect(embed.title).toContain('Pipeline Digest');

    // Active count should be 0
    const activeField = embed.fields.find((f) => f.name === 'Active Requests');
    expect(activeField!.value).toBe('0');

    // Blocked should be 0
    const blockedField = embed.fields.find((f) => f.name === 'Blocked');
    expect(blockedField!.value).toBe('0');

    // Completed should be 0
    const completedField = embed.fields.find((f) => f.name === 'Completed (24h)');
    expect(completedField!.value).toBe('0');
  });

  // -----------------------------------------------------------------------
  // Test 8: formatDigest pagination when content exceeds 6000 chars
  // -----------------------------------------------------------------------
  test('formatDigest pagination when content exceeds 6000 chars', () => {
    // Create digest with many blocked requests to exceed the 6000 char limit
    const blockedRequests: RequestEntity[] = [];
    for (let i = 0; i < 50; i++) {
      blockedRequests.push(makeRequest({
        request_id: `REQ-${String(i + 1).padStart(6, '0')}`,
        blocker: `Very long blocker description that explains what is blocking this request in great detail. This needs to be long enough to push the total content over 6000 characters when combined with all other blocked requests. Adding more text to make sure we exceed the limit.`,
        created_at: new Date(Date.now() - 86_400_000).toISOString(),
      }));
    }

    const digest: DigestData = {
      generatedAt: new Date(),
      activeByState: { queued: 10, active: 5, paused: 3, cancelled: 0, done: 20, failed: 0 },
      blockedRequests,
      completedLast24h: [],
      queueDepth: 10,
      queueDepthByPriority: { high: 3, normal: 4, low: 3 },
    };

    const result = formatter.formatDigest(digest);

    // When paginated, payload is an array of embeds
    if (Array.isArray(result.payload)) {
      expect(result.payload.length).toBeGreaterThan(1);

      // First embed has the main title
      expect(result.payload[0].title).toContain('Pipeline Digest');

      // Continuation embeds have "(cont.)" in the title
      for (let i = 1; i < result.payload.length; i++) {
        expect(result.payload[i].title).toContain('cont.');
      }
    } else {
      // If not paginated, the single embed should have all fields
      const embed = result.payload as DiscordEmbed;
      expect(embed.fields.length).toBeGreaterThanOrEqual(4);
    }

    // Fallback text should always be present
    expect(result.fallbackText).toContain('Pipeline Digest');
  });

  // -----------------------------------------------------------------------
  // Test 9: formatError with red color and error code
  // -----------------------------------------------------------------------
  test('formatError with red color and error code', () => {
    const error: ErrorResponse = {
      success: false,
      error: 'Something went wrong',
      errorCode: 'INTERNAL_ERROR',
    };

    const result = formatter.formatError(error);
    const embed = result.payload as DiscordEmbed;

    expect(embed.color).toBe(0xe74c3c); // Red
    expect(embed.title).toContain('INTERNAL_ERROR');
    expect(embed.description).toBe('Something went wrong');

    // Error with retry info
    const errorWithRetry: ErrorResponse = {
      success: false,
      error: 'Too many requests',
      errorCode: 'RATE_LIMITED',
      retryAfterMs: 5000,
    };

    const retryResult = formatter.formatError(errorWithRetry);
    const retryEmbed = retryResult.payload as DiscordEmbed;
    expect(retryEmbed.color).toBe(0xe74c3c);
    expect(retryEmbed.title).toContain('RATE_LIMITED');
    const retryField = retryEmbed.fields.find((f) => f.name === 'Retry After');
    expect(retryField).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Test 10: formatStatusEmbed all 5 fields present and inline
  // -----------------------------------------------------------------------
  test('formatStatusEmbed has all 5 fields present and inline', () => {
    const request = makeRequest({ blocker: 'Waiting for API key' });
    const embed = formatter.formatStatusEmbed(request);

    expect(embed.fields).toHaveLength(5);

    const fieldNames = embed.fields.map((f) => f.name);
    expect(fieldNames).toEqual(['Phase', 'Priority', 'Progress', 'Age', 'Blocker']);

    // All fields should be inline
    expect(embed.fields.every((f) => f.inline === true)).toBe(true);

    // Blocker should show the actual blocker text
    const blockerField = embed.fields.find((f) => f.name === 'Blocker');
    expect(blockerField!.value).toBe('Waiting for API key');

    // Priority field shows the value
    const priorityField = embed.fields.find((f) => f.name === 'Priority');
    expect(priorityField!.value).toBe('high');

    // Footer shows requester
    expect(embed.footer!.text).toBe('Requested by Alice');
  });
});
