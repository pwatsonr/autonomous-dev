/**
 * Unit tests for CLIFormatter (SPEC-008-2-03, Task 5).
 *
 * Covers:
 * 1. formatStatusCard box characters present
 * 2. formatStatusCard phase color green (execution)
 * 3. formatStatusCard phase color red (failed)
 * 4. renderProgressBar 0%
 * 5. renderProgressBar 50%
 * 6. renderProgressBar 100%
 * 7. fallbackText has no ANSI codes
 * 8. formatDuration edge cases
 * 9. formatDigest with active/blocked/completed counts
 * 10. formatError with error code and message
 * 11. formatPhaseTransition rendering
 *
 * @module cli_formatter.test
 */

import {
  CLIFormatter,
  renderProgressBar,
  formatDuration,
  ANSI,
  type DigestData,
  type PhaseTransitionEvent,
} from '../../../notifications/formatters/cli_formatter';
import type { RequestEntity } from '../../../db/repository';
import type { ErrorResponse } from '../../../adapters/adapter_interface';

// ---------------------------------------------------------------------------
// Helpers
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
    phase_progress: JSON.stringify({ current: 3, total: 8 }),
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
    created_at: new Date(Date.now() - 8_040_000).toISOString(), // ~2h 14m ago
    updated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CLIFormatter (SPEC-008-2-03, Task 5)', () => {
  const formatter = new CLIFormatter();

  // -----------------------------------------------------------------------
  // Test 1: formatStatusCard -- box characters present
  // -----------------------------------------------------------------------
  describe('formatStatusCard', () => {
    test('output contains box-drawing characters', () => {
      const request = makeRequest();
      const result = formatter.formatStatusCard(request);

      const payload = result.payload as string;
      expect(payload).toContain('\u250c'); // top-left corner
      expect(payload).toContain('\u2518'); // bottom-right corner
      expect(payload).toContain('\u2500'); // horizontal line
      expect(payload).toContain('\u2502'); // vertical line
      expect(payload).toContain('\u251c'); // left-T
      expect(payload).toContain('\u2524'); // right-T
      expect(payload).toContain('\u2510'); // top-right corner
      expect(payload).toContain('\u2514'); // bottom-left corner
    });

    // -----------------------------------------------------------------------
    // Test 2: phase color green for execution
    // -----------------------------------------------------------------------
    test('execution phase renders with green ANSI code', () => {
      const request = makeRequest({ current_phase: 'execution' });
      const result = formatter.formatStatusCard(request);

      const payload = result.payload as string;
      expect(payload).toContain('\x1b[32m'); // green
    });

    // -----------------------------------------------------------------------
    // Test 3: phase color red for failed
    // -----------------------------------------------------------------------
    test('failed phase renders with red ANSI code', () => {
      const request = makeRequest({
        current_phase: 'failed',
        status: 'failed',
      });
      const result = formatter.formatStatusCard(request);

      const payload = result.payload as string;
      expect(payload).toContain('\x1b[31m'); // red
    });

    // -----------------------------------------------------------------------
    // Test 7: fallbackText has no ANSI codes
    // -----------------------------------------------------------------------
    test('fallbackText contains no ANSI escape codes', () => {
      const request = makeRequest({ current_phase: 'execution' });
      const result = formatter.formatStatusCard(request);

      expect(result.fallbackText).not.toMatch(/\x1b\[/);
    });

    test('channelType is claude_app', () => {
      const request = makeRequest();
      const result = formatter.formatStatusCard(request);
      expect(result.channelType).toBe('claude_app');
    });

    test('contains request ID and title', () => {
      const request = makeRequest();
      const result = formatter.formatStatusCard(request);

      const payload = result.payload as string;
      expect(payload).toContain('REQ-000042');
      expect(payload).toContain('Build user auth with OAuth2');
    });

    test('contains priority', () => {
      const request = makeRequest();
      const result = formatter.formatStatusCard(request);

      const payload = result.payload as string;
      expect(payload).toContain('high');
    });

    test('contains blocker info', () => {
      const request = makeRequest({ blocker: 'Waiting for API credentials' });
      const result = formatter.formatStatusCard(request);

      const payload = result.payload as string;
      expect(payload).toContain('Waiting for API credentials');
    });

    test('shows None when no blocker', () => {
      const request = makeRequest({ blocker: null });
      const result = formatter.formatStatusCard(request);

      const payload = result.payload as string;
      expect(payload).toContain('Blocker:  None');
    });
  });

  // -----------------------------------------------------------------------
  // Tests 4-6: renderProgressBar
  // -----------------------------------------------------------------------
  describe('renderProgressBar', () => {
    test('0% progress: all empty blocks', () => {
      const bar = renderProgressBar(0, 10);
      expect(bar).toMatch(/^\u2591{16} 0%$/);
    });

    test('50% progress: 8 filled and 8 empty blocks', () => {
      const bar = renderProgressBar(5, 10);
      expect(bar).toBe('\u2588'.repeat(8) + '\u2591'.repeat(8) + ' 50%');
    });

    test('100% progress: all filled blocks', () => {
      const bar = renderProgressBar(10, 10);
      expect(bar).toBe('\u2588'.repeat(16) + ' 100%');
    });

    test('total 0: shows 0%', () => {
      const bar = renderProgressBar(0, 0);
      expect(bar).toMatch(/0%$/);
    });

    test('custom width', () => {
      const bar = renderProgressBar(5, 10, 20);
      expect(bar).toBe('\u2588'.repeat(10) + '\u2591'.repeat(10) + ' 50%');
    });
  });

  // -----------------------------------------------------------------------
  // Test 8: formatDuration
  // -----------------------------------------------------------------------
  describe('formatDuration', () => {
    test('0ms -> "0m"', () => {
      expect(formatDuration(0)).toBe('0m');
    });

    test('90_000ms -> "1m"', () => {
      expect(formatDuration(90_000)).toBe('1m');
    });

    test('8_040_000ms -> "2h 14m"', () => {
      expect(formatDuration(8_040_000)).toBe('2h 14m');
    });

    test('97_200_000ms -> "1d 3h"', () => {
      expect(formatDuration(97_200_000)).toBe('1d 3h');
    });

    test('3_600_000ms -> "1h 0m"', () => {
      expect(formatDuration(3_600_000)).toBe('1h 0m');
    });

    test('59_999ms -> "0m" (truncation, not rounding)', () => {
      expect(formatDuration(59_999)).toBe('0m');
    });
  });

  // -----------------------------------------------------------------------
  // Test 15: formatDigest
  // -----------------------------------------------------------------------
  describe('formatDigest', () => {
    test('digest with 3 active, 1 blocked, 2 completed contains counts', () => {
      const digest: DigestData = {
        generatedAt: new Date('2026-04-08T09:00:00Z'),
        activeByState: {
          queued: 3,
          active: 2,
          paused: 1,
          cancelled: 0,
          done: 2,
          failed: 0,
        },
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
          makeRequest({
            request_id: 'REQ-000018',
            title: 'Fix dashboard CSS',
            status: 'done',
          }),
        ],
        queueDepth: 3,
        queueDepthByPriority: { high: 1, normal: 1, low: 1 },
      };

      const result = formatter.formatDigest(digest);

      const text = result.payload as string;
      expect(text).toContain('Daily Pipeline Digest');
      expect(text).toContain('Queued:    3');
      expect(text).toContain('Active:    2');
      expect(text).toContain('Paused:    1');
      expect(text).toContain('Total:     6');
      expect(text).toContain('REQ-000015');
      expect(text).toContain('Waiting for API credentials');
      expect(text).toContain('REQ-000012');
      expect(text).toContain('Build user auth system');
      expect(text).toContain('REQ-000018');
      expect(text).toContain('Fix dashboard CSS');
      expect(text).toContain('Queue Depth: 3');
    });

    test('digest fallbackText equals payload (no ANSI in digest)', () => {
      const digest: DigestData = {
        generatedAt: new Date('2026-04-08T09:00:00Z'),
        activeByState: {
          queued: 0,
          active: 0,
          paused: 0,
          cancelled: 0,
          done: 0,
          failed: 0,
        },
        blockedRequests: [],
        completedLast24h: [],
        queueDepth: 0,
        queueDepthByPriority: { high: 0, normal: 0, low: 0 },
      };

      const result = formatter.formatDigest(digest);
      expect(result.payload).toBe(result.fallbackText);
    });
  });

  // -----------------------------------------------------------------------
  // Test 16: formatError
  // -----------------------------------------------------------------------
  describe('formatError', () => {
    test('error output contains error code and message', () => {
      const error: ErrorResponse = {
        success: false,
        error: 'You do not have permission to perform this action.',
        errorCode: 'AUTHZ_DENIED',
      };

      const result = formatter.formatError(error);

      const payload = result.payload as string;
      expect(payload).toContain('AUTHZ_DENIED');
      expect(payload).toContain(
        'You do not have permission to perform this action.',
      );
      // ANSI codes present in payload
      expect(payload).toContain('\x1b[31m'); // red
    });

    test('error fallbackText has no ANSI codes', () => {
      const error: ErrorResponse = {
        success: false,
        error: 'Rate limit exceeded',
        errorCode: 'RATE_LIMITED',
        retryAfterMs: 60_000,
      };

      const result = formatter.formatError(error);

      expect(result.fallbackText).not.toMatch(/\x1b\[/);
      expect(result.fallbackText).toContain('RATE_LIMITED');
      expect(result.fallbackText).toContain('Rate limit exceeded');
      expect(result.fallbackText).toContain('Retry after: 1m');
    });

    test('error with details includes them', () => {
      const error: ErrorResponse = {
        success: false,
        error: 'Validation failed',
        errorCode: 'VALIDATION_ERROR',
        details: { field: 'priority', allowed: ['high', 'normal', 'low'] },
      };

      const result = formatter.formatError(error);

      expect(result.fallbackText).toContain('Details:');
      expect(result.fallbackText).toContain('priority');
    });
  });

  // -----------------------------------------------------------------------
  // formatPhaseTransition
  // -----------------------------------------------------------------------
  describe('formatPhaseTransition', () => {
    test('renders from and to phases with colors', () => {
      const request = makeRequest({ current_phase: 'tdd_generation' });
      const event: PhaseTransitionEvent = {
        requestId: 'REQ-000042',
        fromPhase: 'prd_review',
        toPhase: 'tdd_generation',
        timestamp: new Date(),
        metadata: {
          progress: { current: 3, total: 8 },
        },
      };

      const result = formatter.formatPhaseTransition(request, event);

      const payload = result.payload as string;
      expect(payload).toContain('REQ-000042');
      expect(payload).toContain('Prd Review');
      expect(payload).toContain('Tdd Generation');
      expect(payload).toContain('(3/8)');
      expect(payload).toContain('\u2192'); // arrow
    });

    test('includes blocker info when present', () => {
      const request = makeRequest();
      const event: PhaseTransitionEvent = {
        requestId: 'REQ-000042',
        fromPhase: 'execution',
        toPhase: 'code_review',
        timestamp: new Date(),
        metadata: {
          blocker: 'Merge conflict in base branch',
        },
      };

      const result = formatter.formatPhaseTransition(request, event);

      const payload = result.payload as string;
      expect(payload).toContain('Merge conflict in base branch');
    });

    test('includes artifact URL when present', () => {
      const request = makeRequest();
      const event: PhaseTransitionEvent = {
        requestId: 'REQ-000042',
        fromPhase: 'prd_generation',
        toPhase: 'prd_review',
        timestamp: new Date(),
        metadata: {
          artifactUrl: 'https://github.com/owner/repo/pull/87',
        },
      };

      const result = formatter.formatPhaseTransition(request, event);

      const payload = result.payload as string;
      expect(payload).toContain('https://github.com/owner/repo/pull/87');
    });

    test('fallbackText has no ANSI codes', () => {
      const request = makeRequest();
      const event: PhaseTransitionEvent = {
        requestId: 'REQ-000042',
        fromPhase: 'queued',
        toPhase: 'prd_generation',
        timestamp: new Date(),
        metadata: {},
      };

      const result = formatter.formatPhaseTransition(request, event);

      expect(result.fallbackText).not.toMatch(/\x1b\[/);
    });
  });
});
