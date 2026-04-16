import type {
  DeliveryAdapter,
  DeliveryResult,
  NotificationPayload,
  NotificationUrgency,
} from '../types';

// Discord embed color values
const COLOR_RED = 16711680;       // immediate
const COLOR_YELLOW = 16776960;    // soon
const COLOR_BLUE = 3447003;       // informational

interface DiscordEmbedField {
  name: string;
  value: string;
  inline: boolean;
}

interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields: DiscordEmbedField[];
  timestamp: string;
}

interface DiscordPayload {
  embeds: DiscordEmbed[];
}

/**
 * Produces Discord embed JSON for notifications.
 *
 * Color mapping:
 *   - immediate = 16711680 (red)
 *   - soon = 16776960 (yellow)
 *   - informational = 3447003 (blue)
 *
 * Single delivery: one embed in the embeds array.
 * Batch delivery: single embed with multiple field groups.
 */
export class DiscordDeliveryAdapter implements DeliveryAdapter {
  readonly method = "discord" as const;

  deliver(payload: NotificationPayload): DeliveryResult {
    try {
      const embed = buildEmbed(payload);
      const output: DiscordPayload = { embeds: [embed] };
      return {
        success: true,
        method: this.method,
        formattedOutput: output,
      };
    } catch (err: unknown) {
      return {
        success: false,
        method: this.method,
        formattedOutput: {},
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  deliverBatch(payloads: NotificationPayload[]): DeliveryResult {
    try {
      const fields: DiscordEmbedField[] = [];
      let highestUrgency: NotificationUrgency = 'informational';

      for (const p of payloads) {
        if (p.urgency === 'immediate') {
          highestUrgency = 'immediate';
        } else if (p.urgency === 'soon' && highestUrgency !== 'immediate') {
          highestUrgency = 'soon';
        }

        // Add separator field between notification groups
        if (fields.length > 0) {
          fields.push({ name: '\u200B', value: '---', inline: false });
        }

        fields.push(
          { name: 'Event', value: `**${p.title}**\n${p.body}`, inline: false },
          { name: 'Repository', value: p.repository, inline: true },
          { name: 'Request', value: p.request_id, inline: true },
          { name: 'Urgency', value: p.urgency, inline: true },
        );
      }

      const embed: DiscordEmbed = {
        title: `Batch Notification (${payloads.length} events)`,
        description: `Consolidated notification batch`,
        color: urgencyColor(highestUrgency),
        fields,
        timestamp: new Date().toISOString(),
      };

      const output: DiscordPayload = { embeds: [embed] };
      return {
        success: true,
        method: this.method,
        formattedOutput: output,
      };
    } catch (err: unknown) {
      return {
        success: false,
        method: this.method,
        formattedOutput: {},
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function urgencyColor(urgency: NotificationUrgency): number {
  switch (urgency) {
    case 'immediate':
      return COLOR_RED;
    case 'soon':
      return COLOR_YELLOW;
    case 'informational':
      return COLOR_BLUE;
  }
}

function buildEmbed(payload: NotificationPayload): DiscordEmbed {
  return {
    title: payload.title,
    description: payload.body,
    color: urgencyColor(payload.urgency),
    fields: [
      { name: 'Repository', value: payload.repository, inline: true },
      { name: 'Request', value: payload.request_id, inline: true },
      { name: 'Urgency', value: payload.urgency, inline: true },
    ],
    timestamp: payload.timestamp,
  };
}
