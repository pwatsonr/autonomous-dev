/**
 * Slack Block Kit Formatter.
 *
 * Renders pipeline status information as Slack Block Kit payloads with
 * status emoji per phase, mrkdwn fields, conditional blocker/artifact
 * sections, and digest/error formatting.
 *
 * Enforces Block Kit limits:
 * - Max 50 blocks per message (splits into multiple messages if exceeded).
 * - Max 3000 characters per text block (truncated with "...").
 *
 * Implements SPEC-008-4-03, Task 6.
 *
 * @module slack_formatter
 */

import type { RequestEntity } from '../../db/repository';
import type { ErrorResponse } from '../../adapters/adapter_interface';
import {
  formatDuration,
  type DigestData,
  type PhaseTransitionEvent,
  type NotificationFormatter,
} from './cli_formatter';

// ---------------------------------------------------------------------------
// Block Kit types
// ---------------------------------------------------------------------------

/** A single Slack Block Kit block. */
export type SlackBlock = Record<string, unknown>;

/** A text object used inside blocks. */
export interface SlackTextObject {
  type: 'plain_text' | 'mrkdwn';
  text: string;
  emoji?: boolean;
}

// ---------------------------------------------------------------------------
// Status emoji map (from TDD section 3.4.3)
// ---------------------------------------------------------------------------

export const STATUS_EMOJI: Record<string, string> = {
  queued:         ':white_circle:',
  prd_generation: ':large_blue_circle:',
  prd_review:     ':orange_circle:',
  tdd_generation: ':large_blue_circle:',
  tdd_review:     ':orange_circle:',
  planning:       ':purple_circle:',
  spec:           ':purple_circle:',
  execution:      ':green_circle:',
  code_review:    ':orange_circle:',
  merged:         ':white_check_mark:',
  done:           ':heavy_check_mark:',
  paused:         ':double_vertical_bar:',
  cancelled:      ':x:',
  failed:         ':red_circle:',
};

// ---------------------------------------------------------------------------
// Block Kit limits
// ---------------------------------------------------------------------------

/** Maximum blocks per Slack message. */
export const MAX_BLOCKS_PER_MESSAGE = 50;

/** Maximum characters per text block. */
export const MAX_TEXT_LENGTH = 3000;

// ---------------------------------------------------------------------------
// Ordered pipeline phases for progress computation
// ---------------------------------------------------------------------------

const PHASE_ORDER: string[] = [
  'queued',
  'prd_generation',
  'prd_review',
  'tdd_generation',
  'tdd_review',
  'planning',
  'spec',
  'execution',
];

// ---------------------------------------------------------------------------
// Extended request type for Slack rendering
// ---------------------------------------------------------------------------

/** An artifact link for rendering in status blocks. */
export interface ArtifactLink {
  url: string;
  label: string;
}

/**
 * A request entity augmented with Slack-specific display fields.
 *
 * The `slack_user_id` is the Slack platform user ID for mention rendering.
 * The `artifact_links` are resolved at the adapter layer before formatting.
 */
export interface SlackRequestData extends RequestEntity {
  slack_user_id: string;
  artifact_links?: ArtifactLink[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Truncate a string to `maxLen` characters, appending "..." if truncated.
 */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

/**
 * Truncate text to fit within the Block Kit text limit.
 */
export function truncateBlockText(text: string): string {
  return truncate(text, MAX_TEXT_LENGTH);
}

/**
 * Convert a snake_case phase name to a Title Case label.
 */
export function formatPhase(phase: string): string {
  return phase
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Compute a progress string like "3/8 (37%)" for the current pipeline phase.
 */
export function formatProgress(request: RequestEntity): string {
  // Try to use phase_progress JSON if available
  if (request.phase_progress) {
    try {
      const parsed = JSON.parse(request.phase_progress);
      if (typeof parsed.current === 'number' && typeof parsed.total === 'number') {
        const pct = parsed.total > 0 ? Math.round((parsed.current / parsed.total) * 100) : 0;
        return `${parsed.current}/${parsed.total} (${pct}%)`;
      }
    } catch {
      // Not valid JSON -- fall through
    }
  }

  // Fall back to phase-order position
  const total = PHASE_ORDER.length;
  const idx = PHASE_ORDER.indexOf(request.current_phase);
  if (idx === -1) {
    // Terminal or unknown phase -- show as complete
    return `${total}/${total} (100%)`;
  }
  const current = idx + 1;
  const pct = Math.round((current / total) * 100);
  return `${current}/${total} (${pct}%)`;
}

/**
 * Format a timestamp as a relative time string (e.g., "2 hours ago").
 */
export function formatRelativeTime(isoTimestamp: string): string {
  const ms = Date.now() - new Date(isoTimestamp).getTime();
  if (ms < 60_000) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Split an array of blocks into pages of at most MAX_BLOCKS_PER_MESSAGE.
 */
export function paginateBlocks(blocks: SlackBlock[]): SlackBlock[][] {
  if (blocks.length <= MAX_BLOCKS_PER_MESSAGE) return [blocks];

  const pages: SlackBlock[][] = [];
  for (let i = 0; i < blocks.length; i += MAX_BLOCKS_PER_MESSAGE) {
    pages.push(blocks.slice(i, i + MAX_BLOCKS_PER_MESSAGE));
  }
  return pages;
}

// ---------------------------------------------------------------------------
// SlackFormatter
// ---------------------------------------------------------------------------

/**
 * Slack Block Kit formatter that produces Slack-native block arrays
 * with status emoji, mrkdwn fields, and conditional sections.
 *
 * Implements SPEC-008-4-03, Task 6.
 */
export class SlackFormatter implements NotificationFormatter {
  // -----------------------------------------------------------------------
  // formatStatusBlocks
  // -----------------------------------------------------------------------

  /**
   * Build Block Kit blocks for a request status card.
   *
   * Produces:
   * - Header block: `{requestId}: {truncated title}`
   * - Section with 4 fields: Phase (with emoji), Priority, Progress, Age
   * - Conditional blocker section (when blocker is non-null)
   * - Conditional artifact links section (when links are present)
   * - Context block: requester mention + relative update time
   *
   * Enforces Block Kit limits (50 blocks, 3000 chars per text block).
   */
  formatStatusBlocks(request: SlackRequestData): SlackBlock[] {
    const statusEmoji = STATUS_EMOJI[request.current_phase] ?? ':white_circle:';

    const blocks: SlackBlock[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${request.request_id}: ${truncate(request.title, 50)}` },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: truncateBlockText(`*Phase:*\n${statusEmoji} ${formatPhase(request.current_phase)}`) },
          { type: 'mrkdwn', text: truncateBlockText(`*Priority:*\n${request.priority}`) },
          { type: 'mrkdwn', text: truncateBlockText(`*Progress:*\n${formatProgress(request)}`) },
          { type: 'mrkdwn', text: truncateBlockText(`*Age:*\n${formatDuration(Date.now() - new Date(request.created_at).getTime())}`) },
        ],
      },
      // Conditional blocker section
      ...(request.blocker ? [{
        type: 'section',
        text: { type: 'mrkdwn', text: truncateBlockText(`:warning: *Blocker:* ${request.blocker}`) },
      }] : []),
      // Conditional artifact links section
      ...(request.artifact_links && request.artifact_links.length > 0 ? [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: truncateBlockText(
            request.artifact_links.map((l) => `<${l.url}|${l.label}>`).join(' | '),
          ),
        },
      }] : []),
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `Requested by <@${request.slack_user_id}> | Updated ${formatRelativeTime(request.updated_at)}`,
        }],
      },
    ];

    return blocks;
  }

  // -----------------------------------------------------------------------
  // NotificationFormatter interface: formatStatusCard
  // -----------------------------------------------------------------------

  /**
   * Adapter for the NotificationFormatter interface.
   *
   * Wraps formatStatusBlocks and returns a FormattedMessage.
   */
  formatStatusCard(request: RequestEntity) {
    const slackRequest: SlackRequestData = {
      ...request,
      slack_user_id: (request as SlackRequestData).slack_user_id ?? request.requester_id,
      artifact_links: (request as SlackRequestData).artifact_links,
    };

    const blocks = this.formatStatusBlocks(slackRequest);
    const pages = paginateBlocks(blocks);

    return {
      channelType: 'slack' as const,
      payload: pages.length === 1 ? blocks : pages,
      fallbackText: `${request.request_id}: ${request.title} | Phase: ${formatPhase(request.current_phase)} | Priority: ${request.priority}`,
    };
  }

  // -----------------------------------------------------------------------
  // formatPhaseTransition
  // -----------------------------------------------------------------------

  /**
   * Render Block Kit blocks for a phase transition event.
   *
   * Produces blocks showing the from/to phase change with emoji,
   * and optional metadata (blocker, artifact, progress).
   */
  formatPhaseTransition(request: RequestEntity, event: PhaseTransitionEvent) {
    const fromEmoji = STATUS_EMOJI[event.fromPhase] ?? ':white_circle:';
    const toEmoji = STATUS_EMOJI[event.toPhase] ?? ':white_circle:';

    const blocks: SlackBlock[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `Phase Change: ${request.request_id}` },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*From:*\n${fromEmoji} ${formatPhase(event.fromPhase)}` },
          { type: 'mrkdwn', text: `*To:*\n${toEmoji} ${formatPhase(event.toPhase)}` },
          { type: 'mrkdwn', text: `*Request:*\n${truncate(request.title, 50)}` },
        ],
      },
    ];

    if (event.metadata.blocker) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: truncateBlockText(`:warning: *Blocker:* ${event.metadata.blocker}`) },
      });
    }

    if (event.metadata.artifactUrl) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: truncateBlockText(`*Artifact:* <${event.metadata.artifactUrl}|View>`) },
      });
    }

    if (event.metadata.progress) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Progress:* ${event.metadata.progress.current}/${event.metadata.progress.total}`,
        },
      });
    }

    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `Updated ${formatRelativeTime(event.timestamp.toISOString())}`,
      }],
    });

    return {
      channelType: 'slack' as const,
      payload: blocks,
      fallbackText: `[${request.request_id}] Phase: ${formatPhase(event.fromPhase)} -> ${formatPhase(event.toPhase)}`,
    };
  }

  // -----------------------------------------------------------------------
  // formatDigest
  // -----------------------------------------------------------------------

  /**
   * Render Block Kit blocks for a daily digest summary.
   *
   * Includes: header, section fields for active count, blocked, completed 24h,
   * queue depth, and conditional blocker list.
   */
  formatDigest(digest: DigestData) {
    const totalActive =
      (digest.activeByState.queued ?? 0) +
      (digest.activeByState.active ?? 0) +
      (digest.activeByState.paused ?? 0);

    const blocks: SlackBlock[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `Pipeline Digest - ${digest.generatedAt.toISOString().slice(0, 10)}` },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Active Requests:*\n${totalActive}` },
          { type: 'mrkdwn', text: `*Blocked:*\n${digest.blockedRequests.length}` },
          { type: 'mrkdwn', text: `*Completed (24h):*\n${digest.completedLast24h.length}` },
          {
            type: 'mrkdwn',
            text: [
              `*Queue Depth:* ${digest.queueDepth}`,
              `High: ${digest.queueDepthByPriority.high ?? 0}`,
              `Normal: ${digest.queueDepthByPriority.normal ?? 0}`,
              `Low: ${digest.queueDepthByPriority.low ?? 0}`,
            ].join('\n'),
          },
        ],
      },
    ];

    // Blocked request details
    if (digest.blockedRequests.length > 0) {
      const blockedLines = digest.blockedRequests.map((req) => {
        const ageMs = Date.now() - new Date(req.created_at).getTime();
        return `*${req.request_id}*: ${req.blocker ?? 'Unknown'} (${formatDuration(ageMs)})`;
      });
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: truncateBlockText(`:warning: *Blocked Requests:*\n${blockedLines.join('\n')}`) },
      });
    }

    // Completed request details
    if (digest.completedLast24h.length > 0) {
      const completedLines = digest.completedLast24h.map((req) => {
        const durationMs =
          new Date(req.updated_at).getTime() - new Date(req.created_at).getTime();
        return `*${req.request_id}*: ${truncate(req.title, 40)} (${formatDuration(durationMs)})`;
      });
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: truncateBlockText(`:white_check_mark: *Completed:*\n${completedLines.join('\n')}`) },
      });
    }

    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `Generated ${digest.generatedAt.toISOString().replace('T', ' ').slice(0, 16)} UTC`,
      }],
    });

    const pages = paginateBlocks(blocks);

    return {
      channelType: 'slack' as const,
      payload: pages.length === 1 ? blocks : pages,
      fallbackText: `Pipeline Digest: ${totalActive} active, ${digest.blockedRequests.length} blocked, ${digest.completedLast24h.length} completed (24h)`,
    };
  }

  // -----------------------------------------------------------------------
  // formatError
  // -----------------------------------------------------------------------

  /**
   * Render Block Kit blocks for an error notification.
   *
   * Produces a section block with `:x:` emoji and error message.
   */
  formatError(error: ErrorResponse) {
    const blocks: SlackBlock[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: truncateBlockText(`:x: *Error [${error.errorCode}]:* ${error.error}`),
        },
      },
    ];

    if (error.retryAfterMs !== undefined) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Retry After:* ${formatDuration(error.retryAfterMs)}`,
        },
      });
    }

    if (error.details) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: truncateBlockText(`*Details:*\n\`\`\`${JSON.stringify(error.details, null, 2)}\`\`\``),
        },
      });
    }

    return {
      channelType: 'slack' as const,
      payload: blocks,
      fallbackText: `Error [${error.errorCode}]: ${error.error}`,
    };
  }
}
