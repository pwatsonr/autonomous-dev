import type {
  DeliveryAdapter,
  DeliveryResult,
  NotificationPayload,
  NotificationUrgency,
} from '../types';

const ANSI_RED = '\x1b[31m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_RESET = '\x1b[0m';

/**
 * Formats notifications as human-readable console text with ANSI color codes.
 *
 * Color coding by urgency:
 *   - immediate: red text
 *   - soon: yellow text
 *   - informational: no color
 *
 * Batch output is grouped by request ID, then by event type.
 */
export class CliDeliveryAdapter implements DeliveryAdapter {
  readonly method = "cli" as const;

  deliver(payload: NotificationPayload): DeliveryResult {
    try {
      const output = formatSingle(payload);
      return {
        success: true,
        method: this.method,
        formattedOutput: output,
      };
    } catch (err: unknown) {
      return {
        success: false,
        method: this.method,
        formattedOutput: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  deliverBatch(payloads: NotificationPayload[]): DeliveryResult {
    try {
      const output = formatBatch(payloads);
      return {
        success: true,
        method: this.method,
        formattedOutput: output,
      };
    } catch (err: unknown) {
      return {
        success: false,
        method: this.method,
        formattedOutput: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function urgencyColor(urgency: NotificationUrgency): string {
  switch (urgency) {
    case 'immediate':
      return ANSI_RED;
    case 'soon':
      return ANSI_YELLOW;
    case 'informational':
      return '';
  }
}

function formatSingle(payload: NotificationPayload): string {
  const color = urgencyColor(payload.urgency);
  const reset = color ? ANSI_RESET : '';
  const urgencyLabel = payload.urgency.toUpperCase();

  const lines = [
    `${color}[${urgencyLabel}] [${payload.event_type}] ${payload.repository}${reset}`,
    `  ${payload.title}`,
    `  Request: ${payload.request_id} | ${payload.timestamp}`,
    `  Details: ${payload.body}`,
  ];

  return lines.join('\n');
}

function formatBatch(payloads: NotificationPayload[]): string {
  if (payloads.length === 0) {
    return '';
  }

  // Group by request_id
  const byRequest = new Map<string, NotificationPayload[]>();
  for (const p of payloads) {
    const group = byRequest.get(p.request_id) ?? [];
    group.push(p);
    byRequest.set(p.request_id, group);
  }

  const sections: string[] = [];

  for (const [requestId, requestPayloads] of byRequest) {
    // Sub-group by event_type within each request
    const byType = new Map<string, NotificationPayload[]>();
    for (const p of requestPayloads) {
      const group = byType.get(p.event_type) ?? [];
      group.push(p);
      byType.set(p.event_type, group);
    }

    const header = `--- Request: ${requestId} (${requestPayloads.length} notifications) ---`;
    const typeBlocks: string[] = [header];

    for (const [eventType, typePayloads] of byType) {
      typeBlocks.push(`  [${eventType}]`);
      for (const p of typePayloads) {
        typeBlocks.push(`    ${formatSingle(p)}`);
      }
    }

    sections.push(typeBlocks.join('\n'));
  }

  return sections.join('\n\n');
}
