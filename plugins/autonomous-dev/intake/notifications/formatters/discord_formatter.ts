/**
 * Discord Embed Formatter.
 *
 * Renders pipeline status information as Discord embed objects with
 * color-coded phases, inline fields, and digest/error formatting.
 *
 * Implements SPEC-008-3-03, Task 5.
 *
 * @module discord_formatter
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
// Phase color map (decimal values for Discord embeds)
// ---------------------------------------------------------------------------

export const PHASE_COLORS: Record<string, number> = {
  queued:         0x95a5a6,  // Gray
  prd_generation: 0x3498db,  // Blue
  prd_review:     0xe67e22,  // Orange
  tdd_generation: 0x3498db,  // Blue
  tdd_review:     0xe67e22,  // Orange
  planning:       0x9b59b6,  // Purple
  spec:           0x9b59b6,  // Purple
  execution:      0x2ecc71,  // Green
  code_review:    0xe67e22,  // Orange
  merged:         0x27ae60,  // Dark green
  done:           0x2ecc71,  // Green
  paused:         0xf39c12,  // Yellow
  cancelled:      0xe74c3c,  // Red
  failed:         0xe74c3c,  // Red
};

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
// Discord embed field type
// ---------------------------------------------------------------------------

export interface EmbedField {
  name: string;
  value: string;
  inline: boolean;
}

export interface DiscordEmbed {
  title: string;
  color: number;
  fields: EmbedField[];
  footer?: { text: string };
  timestamp?: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// Request with display name (extended for embed rendering)
// ---------------------------------------------------------------------------

/**
 * A request entity augmented with the requester's display name.
 *
 * The `requester_display_name` is resolved at the adapter layer
 * (via `DiscordIdentityResolver.resolveDisplayName`) before
 * formatting embeds.
 */
export interface RequestWithDisplayName extends RequestEntity {
  requester_display_name: string;
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
 * Convert a snake_case phase name to a Title Case label.
 */
function formatPhase(phase: string): string {
  return phase
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Compute a progress string like "3/8 (37%)" for the current pipeline phase.
 */
function formatProgress(request: RequestEntity): string {
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

// ---------------------------------------------------------------------------
// DiscordFormatter
// ---------------------------------------------------------------------------

/**
 * Discord embed formatter that produces Discord-native embed objects
 * with color-coded phases, inline fields, and digest/error formatting.
 *
 * Implements SPEC-008-3-03, Task 5.
 */
export class DiscordFormatter implements NotificationFormatter {
  // -----------------------------------------------------------------------
  // formatStatusCard -> formatStatusEmbed
  // -----------------------------------------------------------------------

  /**
   * Render a status embed for a request.
   *
   * Produces a Discord embed with:
   * - Title: `{requestId}: {truncated title}`
   * - Color: phase-specific color from PHASE_COLORS
   * - 5 inline fields: Phase, Priority, Progress, Age, Blocker
   * - Footer: requester display name
   * - Timestamp: updated_at
   */
  formatStatusEmbed(request: RequestWithDisplayName): DiscordEmbed {
    return {
      title: `${request.request_id}: ${truncate(request.title, 50)}`,
      color: PHASE_COLORS[request.current_phase] ?? 0x95a5a6,
      fields: [
        { name: 'Phase', value: formatPhase(request.current_phase), inline: true },
        { name: 'Priority', value: request.priority, inline: true },
        { name: 'Progress', value: formatProgress(request), inline: true },
        { name: 'Age', value: formatDuration(Date.now() - new Date(request.created_at).getTime()), inline: true },
        { name: 'Blocker', value: request.blocker ?? 'None', inline: true },
      ],
      footer: { text: `Requested by ${request.requester_display_name}` },
      timestamp: request.updated_at,
    };
  }

  /**
   * Adapter for the NotificationFormatter interface.
   *
   * Wraps formatStatusEmbed and returns a FormattedMessage.
   */
  formatStatusCard(request: RequestEntity) {
    // Use a default display name derived from requester_id when
    // the display name is not provided on the entity.
    const withDisplayName: RequestWithDisplayName = {
      ...request,
      requester_display_name:
        (request as RequestWithDisplayName).requester_display_name
        ?? request.requester_id,
    };
    const embed = this.formatStatusEmbed(withDisplayName);
    return {
      channelType: 'discord' as const,
      payload: embed,
      fallbackText: `${embed.title} | Phase: ${formatPhase(request.current_phase)} | Priority: ${request.priority}`,
    };
  }

  // -----------------------------------------------------------------------
  // formatPhaseTransition
  // -----------------------------------------------------------------------

  /**
   * Render an embed for a phase transition event.
   *
   * Produces an embed with "Phase Change" title, from/to fields,
   * and the color of the new phase.
   */
  formatPhaseTransition(request: RequestEntity, event: PhaseTransitionEvent) {
    const embed: DiscordEmbed = {
      title: `Phase Change: ${request.request_id}`,
      color: PHASE_COLORS[event.toPhase] ?? 0x95a5a6,
      fields: [
        { name: 'From', value: formatPhase(event.fromPhase), inline: true },
        { name: 'To', value: formatPhase(event.toPhase), inline: true },
        { name: 'Request', value: truncate(request.title, 50), inline: false },
      ],
      timestamp: event.timestamp.toISOString(),
    };

    if (event.metadata.blocker) {
      embed.fields.push({
        name: 'Blocker',
        value: event.metadata.blocker,
        inline: false,
      });
    }

    if (event.metadata.artifactUrl) {
      embed.fields.push({
        name: 'Artifact',
        value: event.metadata.artifactUrl,
        inline: false,
      });
    }

    if (event.metadata.progress) {
      embed.fields.push({
        name: 'Progress',
        value: `${event.metadata.progress.current}/${event.metadata.progress.total}`,
        inline: true,
      });
    }

    return {
      channelType: 'discord' as const,
      payload: embed,
      fallbackText: `[${request.request_id}] Phase: ${formatPhase(event.fromPhase)} -> ${formatPhase(event.toPhase)}`,
    };
  }

  // -----------------------------------------------------------------------
  // formatDigest
  // -----------------------------------------------------------------------

  /**
   * Render a daily digest embed with summary fields.
   *
   * Includes: active count, blocked, completed 24h, queue depth by priority.
   * Paginates if > 6000 characters (Discord embed limit).
   */
  formatDigest(digest: DigestData) {
    const totalActive =
      (digest.activeByState.queued ?? 0) +
      (digest.activeByState.active ?? 0) +
      (digest.activeByState.paused ?? 0);

    const fields: EmbedField[] = [
      { name: 'Active Requests', value: String(totalActive), inline: true },
      { name: 'Blocked', value: String(digest.blockedRequests.length), inline: true },
      { name: 'Completed (24h)', value: String(digest.completedLast24h.length), inline: true },
      {
        name: 'Queue Depth',
        value: [
          `Total: ${digest.queueDepth}`,
          `High: ${digest.queueDepthByPriority.high ?? 0}`,
          `Normal: ${digest.queueDepthByPriority.normal ?? 0}`,
          `Low: ${digest.queueDepthByPriority.low ?? 0}`,
        ].join('\n'),
        inline: true,
      },
    ];

    // Add blocked request details if any
    if (digest.blockedRequests.length > 0) {
      const blockedLines = digest.blockedRequests.map((req) => {
        const ageMs = Date.now() - new Date(req.created_at).getTime();
        return `**${req.request_id}**: ${req.blocker ?? 'Unknown'} (${formatDuration(ageMs)})`;
      });
      fields.push({
        name: 'Blocked Details',
        value: blockedLines.join('\n'),
        inline: false,
      });
    }

    // Add completed request details if any
    if (digest.completedLast24h.length > 0) {
      const completedLines = digest.completedLast24h.map((req) => {
        const durationMs =
          new Date(req.updated_at).getTime() - new Date(req.created_at).getTime();
        return `**${req.request_id}**: ${truncate(req.title, 40)} (${formatDuration(durationMs)})`;
      });
      fields.push({
        name: 'Completed Details',
        value: completedLines.join('\n'),
        inline: false,
      });
    }

    // Paginate if total field content exceeds 6000 characters
    const totalChars = fields.reduce(
      (sum, f) => sum + f.name.length + f.value.length,
      0,
    );

    const embeds: DiscordEmbed[] = [];

    if (totalChars > 6000) {
      // Split fields across multiple embeds
      let currentFields: EmbedField[] = [];
      let currentLen = 0;

      for (const field of fields) {
        const fieldLen = field.name.length + field.value.length;
        if (currentLen + fieldLen > 5500 && currentFields.length > 0) {
          embeds.push({
            title: embeds.length === 0
              ? `Pipeline Digest - ${digest.generatedAt.toISOString().slice(0, 10)}`
              : `Pipeline Digest (cont.)`,
            color: 0x3498db,
            fields: currentFields,
          });
          currentFields = [];
          currentLen = 0;
        }
        currentFields.push(field);
        currentLen += fieldLen;
      }

      if (currentFields.length > 0) {
        embeds.push({
          title: embeds.length === 0
            ? `Pipeline Digest - ${digest.generatedAt.toISOString().slice(0, 10)}`
            : `Pipeline Digest (cont.)`,
          color: 0x3498db,
          fields: currentFields,
        });
      }
    } else {
      embeds.push({
        title: `Pipeline Digest - ${digest.generatedAt.toISOString().slice(0, 10)}`,
        color: 0x3498db,
        fields,
        timestamp: digest.generatedAt.toISOString(),
      });
    }

    return {
      channelType: 'discord' as const,
      payload: embeds.length === 1 ? embeds[0] : embeds,
      fallbackText: `Pipeline Digest: ${totalActive} active, ${digest.blockedRequests.length} blocked, ${digest.completedLast24h.length} completed (24h)`,
    };
  }

  // -----------------------------------------------------------------------
  // formatError
  // -----------------------------------------------------------------------

  /**
   * Render an error embed with red color, error code in title, and
   * message in description.
   */
  formatError(error: ErrorResponse) {
    const embed: DiscordEmbed = {
      title: `Error: ${error.errorCode}`,
      color: 0xe74c3c, // Red
      description: error.error,
      fields: [],
    };

    if (error.retryAfterMs !== undefined) {
      embed.fields.push({
        name: 'Retry After',
        value: formatDuration(error.retryAfterMs),
        inline: true,
      });
    }

    if (error.details) {
      embed.fields.push({
        name: 'Details',
        value: JSON.stringify(error.details, null, 2).slice(0, 1024),
        inline: false,
      });
    }

    return {
      channelType: 'discord' as const,
      payload: embed,
      fallbackText: `Error [${error.errorCode}]: ${error.error}`,
    };
  }
}
