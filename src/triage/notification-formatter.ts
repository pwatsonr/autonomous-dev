/**
 * Notification message formatter (SPEC-007-5-4, Task 7).
 *
 * Formats observation data into Slack Block Kit or Discord embed payloads.
 * Matches TDD section 3.10.3 notification format.
 */

import type { NotificationPayload } from './notification';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Format an observation into a Slack Block Kit or Discord embed payload.
 * Matches TDD section 3.10.3 notification format.
 */
export function formatMessage(
  obs: NotificationPayload,
  channel: 'slack' | 'discord'
): object {
  if (channel === 'slack') {
    return formatSlackMessage(obs);
  }
  return formatDiscordMessage(obs);
}

// ---------------------------------------------------------------------------
// Slack formatting
// ---------------------------------------------------------------------------

function formatSlackMessage(obs: NotificationPayload): object {
  const severityEmoji = getSeverityEmoji(obs.severity);
  return {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${severityEmoji} New ${obs.severity} Observation: ${obs.service}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `*${obs.title}*`,
            `Error rate: ${obs.error_rate} (baseline: ${obs.baseline})`,
            `Confidence: ${obs.confidence}`,
            '',
            `Recommended: ${obs.recommended_action}`,
          ].join('\n'),
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            'Reply with:',
            ...obs.commands.map(cmd => `  \`${cmd}\``),
          ].join('\n'),
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Discord formatting
// ---------------------------------------------------------------------------

function formatDiscordMessage(obs: NotificationPayload): object {
  const severityEmoji = getSeverityEmoji(obs.severity);
  return {
    embeds: [
      {
        title: `${severityEmoji} New ${obs.severity} Observation: ${obs.service}`,
        description: [
          `**${obs.title}**`,
          `Error rate: ${obs.error_rate} (baseline: ${obs.baseline})`,
          `Confidence: ${obs.confidence}`,
          '',
          `Recommended: ${obs.recommended_action}`,
          '',
          'Reply with:',
          ...obs.commands.map(cmd => `  \`${cmd}\``),
        ].join('\n'),
        color: getSeverityColor(obs.severity),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

export function getSeverityEmoji(severity: string): string {
  switch (severity) {
    case 'P0': return ':rotating_light:';
    case 'P1': return ':warning:';
    case 'P2': return ':large_yellow_circle:';
    case 'P3': return ':information_source:';
    default: return ':grey_question:';
  }
}

export function getSeverityColor(severity: string): number {
  switch (severity) {
    case 'P0': return 0xFF0000; // Red
    case 'P1': return 0xFF8C00; // Orange
    case 'P2': return 0xFFD700; // Yellow
    case 'P3': return 0x4169E1; // Blue
    default: return 0x808080;   // Grey
  }
}

// ---------------------------------------------------------------------------
// Triage command builder
// ---------------------------------------------------------------------------

/**
 * Build the triage command strings for an observation.
 */
export function buildTriageCommands(observationId: string): string[] {
  return [
    `/promote ${observationId} <reason>`,
    `/dismiss ${observationId} <reason>`,
    `/defer ${observationId} <date> <reason>`,
    `/investigate ${observationId}`,
  ];
}
