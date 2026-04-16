/**
 * Unit tests for SlackFormatter (SPEC-008-4-03, Task 6).
 *
 * Covers spec test cases 1-8, 17-18:
 *  1. Status emoji: queued -> :white_circle:
 *  2. Status emoji: execution -> :green_circle:
 *  3. Status emoji: paused -> :double_vertical_bar:
 *  4. Status blocks structure: header + section + context (minimum 3 blocks)
 *  5. Blocker conditional: with blocker -> 4+ blocks; without -> 3 blocks
 *  6. Artifact links: 2 artifacts; verify mrkdwn links with <url|label> format
 *  7. Block limit enforcement: >50 blocks -> pagination
 *  8. Text truncation: >3000 chars -> truncated with "..."
 * 17. Digest blocks: header + section fields for active, blocked, completed 24h
 * 18. Error blocks: section with :x: emoji and error text
 *
 * @module slack_formatter.test
 */

import {
  SlackFormatter,
  STATUS_EMOJI,
  MAX_BLOCKS_PER_MESSAGE,
  MAX_TEXT_LENGTH,
  truncate,
  truncateBlockText,
  formatPhase,
  formatProgress,
  formatRelativeTime,
  paginateBlocks,
  type SlackRequestData,
  type SlackBlock,
} from '../../../notifications/formatters/slack_formatter';
import type { RequestEntity } from '../../../db/repository';
import type { ErrorResponse } from '../../../adapters/adapter_interface';
import type { DigestData } from '../../../notifications/formatters/cli_formatter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal SlackRequestData for testing. */
function makeRequest(overrides: Partial<SlackRequestData> = {}): SlackRequestData {
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
    slack_user_id: 'U01ABCDEF23',
    source_channel: 'slack',
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

function makeDigest(overrides: Partial<DigestData> = {}): DigestData {
  return {
    generatedAt: new Date('2026-04-08T12:00:00Z'),
    activeByState: { queued: 3, active: 2, paused: 1, cancelled: 0, done: 0, failed: 0 },
    blockedRequests: [],
    completedLast24h: [],
    queueDepth: 5,
    queueDepthByPriority: { high: 2, normal: 2, low: 1 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SlackFormatter (SPEC-008-4-03, Task 6)', () => {
  const formatter = new SlackFormatter();

  // -----------------------------------------------------------------------
  // Test 1: Status emoji: queued -> :white_circle:
  // -----------------------------------------------------------------------
  test('queued phase contains :white_circle: emoji', () => {
    const request = makeRequest({ current_phase: 'queued' });
    const blocks = formatter.formatStatusBlocks(request);

    const sectionBlock = blocks.find((b) => b.type === 'section' && Array.isArray(b.fields));
    expect(sectionBlock).toBeDefined();

    const phaseField = (sectionBlock!.fields as Array<{ text: string }>)[0];
    expect(phaseField.text).toContain(':white_circle:');
  });

  // -----------------------------------------------------------------------
  // Test 2: Status emoji: execution -> :green_circle:
  // -----------------------------------------------------------------------
  test('execution phase contains :green_circle: emoji', () => {
    const request = makeRequest({ current_phase: 'execution' });
    const blocks = formatter.formatStatusBlocks(request);

    const sectionBlock = blocks.find((b) => b.type === 'section' && Array.isArray(b.fields));
    const phaseField = (sectionBlock!.fields as Array<{ text: string }>)[0];
    expect(phaseField.text).toContain(':green_circle:');
  });

  // -----------------------------------------------------------------------
  // Test 3: Status emoji: paused -> :double_vertical_bar:
  // -----------------------------------------------------------------------
  test('paused phase contains :double_vertical_bar: emoji', () => {
    const request = makeRequest({ current_phase: 'paused' });
    const blocks = formatter.formatStatusBlocks(request);

    const sectionBlock = blocks.find((b) => b.type === 'section' && Array.isArray(b.fields));
    const phaseField = (sectionBlock!.fields as Array<{ text: string }>)[0];
    expect(phaseField.text).toContain(':double_vertical_bar:');
  });

  // -----------------------------------------------------------------------
  // Test 4: Status blocks structure: header + section + context (min 3)
  // -----------------------------------------------------------------------
  test('status blocks contain at minimum header + section + context (3 blocks)', () => {
    const request = makeRequest();
    const blocks = formatter.formatStatusBlocks(request);

    expect(blocks.length).toBeGreaterThanOrEqual(3);
    expect(blocks[0].type).toBe('header');
    expect(blocks[1].type).toBe('section');
    expect(blocks[blocks.length - 1].type).toBe('context');
  });

  // -----------------------------------------------------------------------
  // Test 5: Blocker conditional
  // -----------------------------------------------------------------------
  test('with blocker adds blocker section (4+ blocks)', () => {
    const request = makeRequest({ blocker: 'Waiting for design review' });
    const blocks = formatter.formatStatusBlocks(request);

    expect(blocks.length).toBeGreaterThanOrEqual(4);
    const blockerBlock = blocks.find(
      (b) => b.type === 'section' && typeof b.text === 'object' &&
             (b.text as { text: string }).text.includes(':warning:'),
    );
    expect(blockerBlock).toBeDefined();
  });

  test('without blocker has exactly 3 blocks', () => {
    const request = makeRequest({ blocker: null });
    const blocks = formatter.formatStatusBlocks(request);

    expect(blocks.length).toBe(3);
  });

  // -----------------------------------------------------------------------
  // Test 6: Artifact links with <url|label> format
  // -----------------------------------------------------------------------
  test('artifact links rendered as Slack mrkdwn links', () => {
    const request = makeRequest({
      artifact_links: [
        { url: 'https://github.com/org/repo/pull/1', label: 'PRD PR' },
        { url: 'https://github.com/org/repo/pull/2', label: 'TDD PR' },
      ],
    });
    const blocks = formatter.formatStatusBlocks(request);

    const artifactBlock = blocks.find(
      (b) => b.type === 'section' && typeof b.text === 'object' &&
             (b.text as { text: string }).text.includes('<https://'),
    );
    expect(artifactBlock).toBeDefined();

    const text = (artifactBlock!.text as { text: string }).text;
    expect(text).toContain('<https://github.com/org/repo/pull/1|PRD PR>');
    expect(text).toContain('<https://github.com/org/repo/pull/2|TDD PR>');
    expect(text).toContain(' | ');
  });

  // -----------------------------------------------------------------------
  // Test 7: Block limit enforcement (>50 blocks -> pagination)
  // -----------------------------------------------------------------------
  test('blocks exceeding 50 are paginated', () => {
    const blocks: SlackBlock[] = [];
    for (let i = 0; i < 55; i++) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `Block ${i}` } });
    }

    const pages = paginateBlocks(blocks);
    expect(pages.length).toBe(2);
    expect(pages[0].length).toBe(50);
    expect(pages[1].length).toBe(5);
  });

  test('blocks within limit are not paginated', () => {
    const blocks: SlackBlock[] = [];
    for (let i = 0; i < 10; i++) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `Block ${i}` } });
    }

    const pages = paginateBlocks(blocks);
    expect(pages.length).toBe(1);
    expect(pages[0].length).toBe(10);
  });

  // -----------------------------------------------------------------------
  // Test 8: Text truncation (>3000 chars -> "...")
  // -----------------------------------------------------------------------
  test('text exceeding 3000 chars is truncated with "..."', () => {
    const longText = 'x'.repeat(3500);
    const truncated = truncateBlockText(longText);

    expect(truncated.length).toBe(3003); // 3000 + "..."
    expect(truncated.endsWith('...')).toBe(true);
  });

  test('text within limit is not truncated', () => {
    const shortText = 'Hello world';
    const result = truncateBlockText(shortText);
    expect(result).toBe(shortText);
  });

  // -----------------------------------------------------------------------
  // Header block contains {requestId}: {truncated title}
  // -----------------------------------------------------------------------
  test('header block contains request ID and truncated title', () => {
    const request = makeRequest({
      request_id: 'REQ-000042',
      title: 'A very long title that exceeds fifty characters and should be truncated here',
    });
    const blocks = formatter.formatStatusBlocks(request);

    const header = blocks[0];
    expect(header.type).toBe('header');
    const headerText = (header.text as { text: string }).text;
    expect(headerText).toContain('REQ-000042');
    expect(headerText.length).toBeLessThanOrEqual(
      'REQ-000042: '.length + 50 + 3, // requestId + ": " + truncated(50) + "..."
    );
  });

  // -----------------------------------------------------------------------
  // Section fields use mrkdwn type with bold labels
  // -----------------------------------------------------------------------
  test('section fields use mrkdwn type with bold labels', () => {
    const request = makeRequest();
    const blocks = formatter.formatStatusBlocks(request);

    const sectionBlock = blocks.find((b) => b.type === 'section' && Array.isArray(b.fields));
    const fields = sectionBlock!.fields as Array<{ type: string; text: string }>;

    expect(fields).toHaveLength(4);
    for (const field of fields) {
      expect(field.type).toBe('mrkdwn');
      expect(field.text).toMatch(/^\*\w+.*:\*/); // Starts with bold label
    }
  });

  // -----------------------------------------------------------------------
  // Context block shows requester mention <@slackUserId>
  // -----------------------------------------------------------------------
  test('context block shows requester mention <@slackUserId>', () => {
    const request = makeRequest({ slack_user_id: 'U01ABCDEF23' });
    const blocks = formatter.formatStatusBlocks(request);

    const contextBlock = blocks[blocks.length - 1];
    expect(contextBlock.type).toBe('context');
    const elements = contextBlock.elements as Array<{ text: string }>;
    expect(elements[0].text).toContain('<@U01ABCDEF23>');
  });

  // -----------------------------------------------------------------------
  // Phase transition formatting
  // -----------------------------------------------------------------------
  test('phase transition contains from/to with emoji', () => {
    const request = makeRequest();
    const event = {
      requestId: 'REQ-000042',
      fromPhase: 'prd_generation',
      toPhase: 'prd_review',
      timestamp: new Date(),
      metadata: {},
    };

    const result = formatter.formatPhaseTransition(request, event);
    const blocks = result.payload as SlackBlock[];

    expect(blocks[0].type).toBe('header');
    expect((blocks[0].text as { text: string }).text).toContain('Phase Change');

    const sectionBlock = blocks.find((b) => b.type === 'section' && Array.isArray(b.fields));
    const fields = sectionBlock!.fields as Array<{ text: string }>;

    const fromField = fields.find((f) => f.text.includes('*From:*'));
    const toField = fields.find((f) => f.text.includes('*To:*'));
    expect(fromField!.text).toContain(':large_blue_circle:');
    expect(toField!.text).toContain(':orange_circle:');
  });

  // -----------------------------------------------------------------------
  // Test 17: Digest blocks
  // -----------------------------------------------------------------------
  test('digest blocks contain header and section fields for active, blocked, completed', () => {
    const digest = makeDigest();
    const result = formatter.formatDigest(digest);
    const blocks = result.payload as SlackBlock[];

    expect(blocks[0].type).toBe('header');
    expect((blocks[0].text as { text: string }).text).toContain('Pipeline Digest');

    const sectionBlock = blocks.find((b) => b.type === 'section' && Array.isArray(b.fields));
    expect(sectionBlock).toBeDefined();

    const fields = sectionBlock!.fields as Array<{ text: string }>;
    const activeField = fields.find((f) => f.text.includes('*Active Requests:*'));
    const blockedField = fields.find((f) => f.text.includes('*Blocked:*'));
    const completedField = fields.find((f) => f.text.includes('*Completed (24h):*'));

    expect(activeField).toBeDefined();
    expect(blockedField).toBeDefined();
    expect(completedField).toBeDefined();
    expect(activeField!.text).toContain('6'); // 3 + 2 + 1
  });

  test('digest includes blocked request details when blockers exist', () => {
    const digest = makeDigest({
      blockedRequests: [
        makeRequest({ request_id: 'REQ-001', blocker: 'Waiting for review' }) as RequestEntity,
      ],
    });
    const result = formatter.formatDigest(digest);
    const blocks = result.payload as SlackBlock[];

    const blockerDetailBlock = blocks.find(
      (b) => b.type === 'section' && typeof b.text === 'object' &&
             (b.text as { text: string }).text.includes(':warning:'),
    );
    expect(blockerDetailBlock).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Test 18: Error blocks
  // -----------------------------------------------------------------------
  test('error blocks contain :x: emoji and error text', () => {
    const error: ErrorResponse = {
      success: false,
      error: 'Something went wrong',
      errorCode: 'INTERNAL_ERROR',
    };

    const result = formatter.formatError(error);
    const blocks = result.payload as SlackBlock[];

    expect(blocks.length).toBeGreaterThanOrEqual(1);
    const errorBlock = blocks[0];
    expect(errorBlock.type).toBe('section');

    const text = (errorBlock.text as { text: string }).text;
    expect(text).toContain(':x:');
    expect(text).toContain('INTERNAL_ERROR');
    expect(text).toContain('Something went wrong');
  });

  test('error blocks include retry after when present', () => {
    const error: ErrorResponse = {
      success: false,
      error: 'Rate limited',
      errorCode: 'RATE_LIMITED',
      retryAfterMs: 60_000,
    };

    const result = formatter.formatError(error);
    const blocks = result.payload as SlackBlock[];

    const retryBlock = blocks.find(
      (b) => b.type === 'section' && typeof b.text === 'object' &&
             (b.text as { text: string }).text.includes('Retry After'),
    );
    expect(retryBlock).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // STATUS_EMOJI map completeness
  // -----------------------------------------------------------------------
  test('STATUS_EMOJI map contains all expected phases', () => {
    const expectedPhases = [
      'queued', 'prd_generation', 'prd_review', 'tdd_generation', 'tdd_review',
      'planning', 'spec', 'execution', 'code_review', 'merged', 'done',
      'paused', 'cancelled', 'failed',
    ];
    for (const phase of expectedPhases) {
      expect(STATUS_EMOJI[phase]).toBeDefined();
    }
  });

  // -----------------------------------------------------------------------
  // Helper function tests
  // -----------------------------------------------------------------------
  describe('truncate', () => {
    test('returns original string when within limit', () => {
      expect(truncate('hello', 10)).toBe('hello');
    });

    test('truncates and adds "..." when exceeding limit', () => {
      expect(truncate('hello world', 5)).toBe('hello...');
    });
  });

  describe('formatPhase', () => {
    test('converts snake_case to Title Case', () => {
      expect(formatPhase('prd_generation')).toBe('Prd Generation');
      expect(formatPhase('code_review')).toBe('Code Review');
      expect(formatPhase('queued')).toBe('Queued');
    });
  });

  describe('formatProgress', () => {
    test('uses phase_progress JSON when available', () => {
      const request = makeRequest({
        phase_progress: JSON.stringify({ current: 3, total: 8 }),
      });
      expect(formatProgress(request)).toBe('3/8 (38%)');
    });

    test('falls back to phase order position', () => {
      const request = makeRequest({ current_phase: 'execution', phase_progress: null });
      expect(formatProgress(request)).toBe('8/8 (100%)');
    });

    test('terminal phase shows 100%', () => {
      const request = makeRequest({ current_phase: 'done', phase_progress: null });
      expect(formatProgress(request)).toBe('8/8 (100%)');
    });
  });

  describe('formatRelativeTime', () => {
    test('recent timestamp shows "just now"', () => {
      const now = new Date().toISOString();
      expect(formatRelativeTime(now)).toBe('just now');
    });

    test('older timestamp shows relative time', () => {
      const twoHoursAgo = new Date(Date.now() - 7_200_000).toISOString();
      expect(formatRelativeTime(twoHoursAgo)).toBe('2h ago');
    });
  });

  // -----------------------------------------------------------------------
  // formatStatusCard (NotificationFormatter interface)
  // -----------------------------------------------------------------------
  test('formatStatusCard returns FormattedMessage with slack channelType', () => {
    const request = makeRequest();
    const result = formatter.formatStatusCard(request);

    expect(result.channelType).toBe('slack');
    expect(result.fallbackText).toContain('REQ-000042');
    expect(result.payload).toBeDefined();
  });
});
