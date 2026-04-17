import type {
  DeliveryAdapter,
  DeliveryResult,
  NotificationPayload,
  NotificationUrgency,
} from '../types';

interface SlackTextObject {
  type: 'plain_text' | 'mrkdwn';
  text: string;
}

interface SlackHeaderBlock {
  type: 'header';
  text: SlackTextObject;
}

interface SlackSectionBlock {
  type: 'section';
  text: SlackTextObject;
}

interface SlackContextBlock {
  type: 'context';
  elements: SlackTextObject[];
}

interface SlackDividerBlock {
  type: 'divider';
}

type SlackBlock = SlackHeaderBlock | SlackSectionBlock | SlackContextBlock | SlackDividerBlock;

interface SlackPayload {
  blocks: SlackBlock[];
}

/**
 * Produces Slack Block Kit JSON for notifications.
 *
 * Urgency emoji mapping:
 *   - immediate = :red_circle:
 *   - soon = :large_yellow_circle:
 *   - informational = :blue_circle:
 *
 * Single delivery: header + section + context blocks.
 * Batch delivery: single message with dividers between grouped notifications.
 */
export class SlackDeliveryAdapter implements DeliveryAdapter {
  readonly method = "slack" as const;

  deliver(payload: NotificationPayload): DeliveryResult {
    try {
      const blocks = buildBlocks(payload);
      const output: SlackPayload = { blocks };
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
      const allBlocks: SlackBlock[] = [];

      for (let i = 0; i < payloads.length; i++) {
        if (i > 0) {
          allBlocks.push({ type: 'divider' });
        }
        const blocks = buildBlocks(payloads[i]);
        allBlocks.push(...blocks);
      }

      const output: SlackPayload = { blocks: allBlocks };
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

function urgencyEmoji(urgency: NotificationUrgency): string {
  switch (urgency) {
    case 'immediate':
      return ':red_circle:';
    case 'soon':
      return ':large_yellow_circle:';
    case 'informational':
      return ':blue_circle:';
  }
}

function buildBlocks(payload: NotificationPayload): SlackBlock[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: payload.title },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: payload.body },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `*Repository:* ${payload.repository} | *Request:* ${payload.request_id} | *Urgency:* ${urgencyEmoji(payload.urgency)} ${payload.urgency}`,
        },
      ],
    },
  ];
}
