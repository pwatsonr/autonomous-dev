/**
 * Unit tests for SlackFormatter Block Kit output (SPEC-008-4-05, Task 16).
 *
 * Validates formatStatusBlocks structure, emoji mapping, title truncation,
 * mrkdwn link format, requester mention, block limit enforcement, text
 * truncation, formatDigest, and formatError.
 *
 * Test cases (12 total):
 *  1. formatStatusBlocks structure: header, section, conditional blocker,
 *     conditional artifacts, context.
 *  2. Emoji mapping for all 14 phases.
 *  3. Title truncation at 50 chars.
 *  4. mrkdwn link format for artifacts.
 *  5. Requester mention format <@userId>.
 *  6. Block limit enforcement (50 blocks).
 *  7. Text truncation (3000 chars).
 *  8. formatDigest with various digest data.
 *  9. formatError with error code.
 * 10. Section fields contain Phase, Priority, Progress, Age.
 * 11. Blocker section only present when blocker is set.
 * 12. Context block contains relative time.
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

describe('SlackFormatter (SPEC-008-4-05, Task 16)', () => {
  const formatter = new SlackFormatter();

  // -----------------------------------------------------------------------
  // Test 1: formatStatusBlocks structure
  // -----------------------------------------------------------------------
  test('formatStatusBlocks produces header + section + context (min 3 blocks)', () => {
    const request = makeRequest();
    const blocks = formatter.formatStatusBlocks(request);

    expect(blocks.length).toBeGreaterThanOrEqual(3);
    expect(blocks[0].type).toBe('header');
    expect(blocks[1].type).toBe('section');
    expect(blocks[blocks.length - 1].type).toBe('context');
  });

  test('formatStatusBlocks includes blocker section when blocker is present', () => {
    const request = makeRequest({ blocker: 'Waiting for API key' });
    const blocks = formatter.formatStatusBlocks(request);

    const blockerBlock = blocks.find(
      (b) => b.type === 'section' && typeof b.text === 'object' &&
             (b.text as { text: string }).text.includes(':warning:'),
    );
    expect(blockerBlock).toBeDefined();
    expect(blocks.length).toBeGreaterThanOrEqual(4);
  });

  test('formatStatusBlocks includes artifact links when present', () => {
    const request = makeRequest({
      artifact_links: [
        { url: 'https://github.com/org/repo/pull/1', label: 'PRD PR' },
      ],
    });
    const blocks = formatter.formatStatusBlocks(request);

    const artifactBlock = blocks.find(
      (b) => b.type === 'section' && typeof b.text === 'object' &&
             (b.text as { text: string }).text.includes('<https://'),
    );
    expect(artifactBlock).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Test 2: Emoji mapping for all 14 phases
  // -----------------------------------------------------------------------
  test('STATUS_EMOJI covers all 14 phases', () => {
    const expectedPhases = [
      'queued', 'prd_generation', 'prd_review', 'tdd_generation', 'tdd_review',
      'planning', 'spec', 'execution', 'code_review', 'merged', 'done',
      'paused', 'cancelled', 'failed',
    ];
    expect(expectedPhases).toHaveLength(14);

    for (const phase of expectedPhases) {
      expect(STATUS_EMOJI[phase]).toBeDefined();
      expect(STATUS_EMOJI[phase]).toMatch(/^:[a-z_]+:$/);
    }
  });

  test('each phase gets its correct emoji in the rendered output', () => {
    const phaseEmojiPairs: Array<[string, string]> = [
      ['queued', ':white_circle:'],
      ['execution', ':green_circle:'],
      ['paused', ':double_vertical_bar:'],
      ['done', ':heavy_check_mark:'],
      ['failed', ':red_circle:'],
      ['cancelled', ':x:'],
    ];

    for (const [phase, emoji] of phaseEmojiPairs) {
      const request = makeRequest({ current_phase: phase });
      const blocks = formatter.formatStatusBlocks(request);
      const sectionBlock = blocks.find((b) => b.type === 'section' && Array.isArray(b.fields));
      const phaseField = (sectionBlock!.fields as Array<{ text: string }>)[0];
      expect(phaseField.text).toContain(emoji);
    }
  });

  // -----------------------------------------------------------------------
  // Test 3: Title truncation at 50 chars
  // -----------------------------------------------------------------------
  test('header truncates title at 50 characters', () => {
    const longTitle = 'A very long title that definitely exceeds fifty characters and should be truncated';
    const request = makeRequest({ title: longTitle });
    const blocks = formatter.formatStatusBlocks(request);

    const headerText = (blocks[0].text as { text: string }).text;
    // "REQ-000042: " + truncated(50) + "..."
    expect(headerText).toContain('REQ-000042');
    // The title portion should be at most 53 chars (50 + "...")
    const titlePortion = headerText.replace('REQ-000042: ', '');
    expect(titlePortion.length).toBeLessThanOrEqual(53);
    expect(titlePortion.endsWith('...')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 4: mrkdwn link format for artifacts
  // -----------------------------------------------------------------------
  test('artifact links rendered as <url|label> mrkdwn format', () => {
    const request = makeRequest({
      artifact_links: [
        { url: 'https://example.com/pr/1', label: 'PR #1' },
        { url: 'https://example.com/pr/2', label: 'PR #2' },
      ],
    });
    const blocks = formatter.formatStatusBlocks(request);

    const artifactBlock = blocks.find(
      (b) => b.type === 'section' && typeof b.text === 'object' &&
             (b.text as { text: string }).text.includes('<https://'),
    );
    expect(artifactBlock).toBeDefined();

    const text = (artifactBlock!.text as { text: string }).text;
    expect(text).toContain('<https://example.com/pr/1|PR #1>');
    expect(text).toContain('<https://example.com/pr/2|PR #2>');
    expect(text).toContain(' | '); // Pipe separator between links
  });

  // -----------------------------------------------------------------------
  // Test 5: Requester mention format <@userId>
  // -----------------------------------------------------------------------
  test('context block contains requester mention <@slackUserId>', () => {
    const request = makeRequest({ slack_user_id: 'U99XYZABC99' });
    const blocks = formatter.formatStatusBlocks(request);

    const contextBlock = blocks[blocks.length - 1];
    expect(contextBlock.type).toBe('context');
    const elements = contextBlock.elements as Array<{ text: string }>;
    expect(elements[0].text).toContain('<@U99XYZABC99>');
  });

  // -----------------------------------------------------------------------
  // Test 6: Block limit enforcement (50 blocks)
  // -----------------------------------------------------------------------
  test('paginateBlocks splits > 50 blocks into multiple pages', () => {
    const blocks: SlackBlock[] = Array.from({ length: 75 }, (_, i) => ({
      type: 'section',
      text: { type: 'mrkdwn', text: `Block ${i}` },
    }));

    const pages = paginateBlocks(blocks);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toHaveLength(50);
    expect(pages[1]).toHaveLength(25);
  });

  test('paginateBlocks returns single page for <= 50 blocks', () => {
    const blocks: SlackBlock[] = Array.from({ length: 10 }, (_, i) => ({
      type: 'section',
      text: { type: 'mrkdwn', text: `Block ${i}` },
    }));

    const pages = paginateBlocks(blocks);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toHaveLength(10);
  });

  // -----------------------------------------------------------------------
  // Test 7: Text truncation (3000 chars)
  // -----------------------------------------------------------------------
  test('truncateBlockText truncates at 3000 chars with "..."', () => {
    const longText = 'x'.repeat(3500);
    const result = truncateBlockText(longText);

    expect(result.length).toBe(3003); // 3000 + "..."
    expect(result.endsWith('...')).toBe(true);
  });

  test('truncateBlockText preserves text within limit', () => {
    const shortText = 'Hello world';
    expect(truncateBlockText(shortText)).toBe(shortText);
  });

  // -----------------------------------------------------------------------
  // Test 8: formatDigest with various digest data
  // -----------------------------------------------------------------------
  test('formatDigest renders header with date and section fields', () => {
    const digest = makeDigest();
    const result = formatter.formatDigest(digest);
    const blocks = result.payload as SlackBlock[];

    expect(blocks[0].type).toBe('header');
    expect((blocks[0].text as { text: string }).text).toContain('Pipeline Digest');
    expect((blocks[0].text as { text: string }).text).toContain('2026-04-08');

    const sectionBlock = blocks.find((b) => b.type === 'section' && Array.isArray(b.fields));
    expect(sectionBlock).toBeDefined();

    const fields = sectionBlock!.fields as Array<{ text: string }>;
    const activeField = fields.find((f) => f.text.includes('*Active Requests:*'));
    expect(activeField).toBeDefined();
    expect(activeField!.text).toContain('6'); // 3 + 2 + 1
  });

  test('formatDigest includes blocked request details when present', () => {
    const digest = makeDigest({
      blockedRequests: [
        makeRequest({ request_id: 'REQ-001', blocker: 'Waiting' }) as RequestEntity,
      ],
    });
    const result = formatter.formatDigest(digest);
    const blocks = result.payload as SlackBlock[];

    const blockerBlock = blocks.find(
      (b) => b.type === 'section' && typeof b.text === 'object' &&
             (b.text as { text: string }).text.includes(':warning:'),
    );
    expect(blockerBlock).toBeDefined();
  });

  test('formatDigest includes completed request details when present', () => {
    const digest = makeDigest({
      completedLast24h: [
        makeRequest({ request_id: 'REQ-002', status: 'done' }) as RequestEntity,
      ],
    });
    const result = formatter.formatDigest(digest);
    const blocks = result.payload as SlackBlock[];

    const completedBlock = blocks.find(
      (b) => b.type === 'section' && typeof b.text === 'object' &&
             (b.text as { text: string }).text.includes(':white_check_mark:'),
    );
    expect(completedBlock).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Test 9: formatError with error code
  // -----------------------------------------------------------------------
  test('formatError renders :x: emoji with error code and message', () => {
    const error: ErrorResponse = {
      success: false,
      error: 'Something went wrong',
      errorCode: 'INTERNAL_ERROR',
    };

    const result = formatter.formatError(error);
    const blocks = result.payload as SlackBlock[];

    expect(blocks.length).toBeGreaterThanOrEqual(1);
    const text = (blocks[0].text as { text: string }).text;
    expect(text).toContain(':x:');
    expect(text).toContain('INTERNAL_ERROR');
    expect(text).toContain('Something went wrong');
  });

  test('formatError includes retry-after block when present', () => {
    const error: ErrorResponse = {
      success: false,
      error: 'Rate limited',
      errorCode: 'RATE_LIMITED',
      retryAfterMs: 30_000,
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
  // Test 10: Section fields contain Phase, Priority, Progress, Age
  // -----------------------------------------------------------------------
  test('section fields contain Phase, Priority, Progress, Age', () => {
    const request = makeRequest();
    const blocks = formatter.formatStatusBlocks(request);

    const sectionBlock = blocks.find((b) => b.type === 'section' && Array.isArray(b.fields));
    expect(sectionBlock).toBeDefined();

    const fields = sectionBlock!.fields as Array<{ type: string; text: string }>;
    expect(fields).toHaveLength(4);
    expect(fields[0].text).toContain('*Phase:*');
    expect(fields[1].text).toContain('*Priority:*');
    expect(fields[2].text).toContain('*Progress:*');
    expect(fields[3].text).toContain('*Age:*');

    for (const field of fields) {
      expect(field.type).toBe('mrkdwn');
    }
  });

  // -----------------------------------------------------------------------
  // Test 11: Blocker section only when blocker is set
  // -----------------------------------------------------------------------
  test('without blocker has exactly 3 blocks (no blocker section)', () => {
    const request = makeRequest({ blocker: null });
    const blocks = formatter.formatStatusBlocks(request);
    expect(blocks).toHaveLength(3);
  });

  // -----------------------------------------------------------------------
  // Test 12: Context block contains relative time
  // -----------------------------------------------------------------------
  test('context block contains relative time ("Updated ...")', () => {
    const request = makeRequest({
      updated_at: new Date(Date.now() - 7_200_000).toISOString(), // 2 hours ago
    });
    const blocks = formatter.formatStatusBlocks(request);

    const contextBlock = blocks[blocks.length - 1];
    const elements = contextBlock.elements as Array<{ text: string }>;
    expect(elements[0].text).toContain('Updated');
    expect(elements[0].text).toContain('2h ago');
  });
});
