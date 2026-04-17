import { SlackDeliveryAdapter } from '../../../src/notifications/adapters/slack-adapter';
import type { NotificationPayload } from '../../../src/notifications/types';

function makePayload(overrides: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    notification_id: '550e8400-e29b-41d4-a716-446655440000',
    event_type: 'escalation',
    urgency: 'immediate',
    timestamp: '2026-04-08T10:30:00Z',
    request_id: 'req-abc',
    repository: 'repo-name',
    title: 'Pipeline code_review gate requires human approval',
    body: 'Code review has failed after 3 retries...',
    ...overrides,
  };
}

describe('SlackDeliveryAdapter', () => {
  let adapter: SlackDeliveryAdapter;

  beforeEach(() => {
    adapter = new SlackDeliveryAdapter();
  });

  it('has method "slack"', () => {
    expect(adapter.method).toBe('slack');
  });

  // Test Case 9: Single: valid Block Kit JSON
  it('produces valid JSON with blocks array', () => {
    const result = adapter.deliver(makePayload());
    expect(result.success).toBe(true);
    expect(result.method).toBe('slack');

    const output = result.formattedOutput as { blocks: unknown[] };
    expect(output).toHaveProperty('blocks');
    expect(Array.isArray(output.blocks)).toBe(true);

    // Verify it can round-trip through JSON
    const json = JSON.stringify(output);
    const parsed = JSON.parse(json);
    expect(parsed.blocks.length).toBeGreaterThan(0);
  });

  // Test Case 10: Single: header block present
  it('first block is header type with title', () => {
    const result = adapter.deliver(makePayload({
      title: 'My Notification Title',
    }));

    const output = result.formattedOutput as {
      blocks: Array<{ type: string; text?: { type: string; text: string } }>;
    };
    const firstBlock = output.blocks[0];
    expect(firstBlock.type).toBe('header');
    expect(firstBlock.text?.type).toBe('plain_text');
    expect(firstBlock.text?.text).toBe('My Notification Title');
  });

  it('section block contains body as mrkdwn', () => {
    const result = adapter.deliver(makePayload({
      body: 'Detailed body content here',
    }));

    const output = result.formattedOutput as {
      blocks: Array<{ type: string; text?: { type: string; text: string } }>;
    };
    const sectionBlock = output.blocks.find(b => b.type === 'section');
    expect(sectionBlock).toBeDefined();
    expect(sectionBlock!.text?.type).toBe('mrkdwn');
    expect(sectionBlock!.text?.text).toBe('Detailed body content here');
  });

  // Test Case 11: Single: urgency emoji
  it('context block contains :red_circle: for immediate urgency', () => {
    const result = adapter.deliver(makePayload({ urgency: 'immediate' }));

    const output = result.formattedOutput as {
      blocks: Array<{
        type: string;
        elements?: Array<{ type: string; text: string }>;
      }>;
    };
    const contextBlock = output.blocks.find(b => b.type === 'context');
    expect(contextBlock).toBeDefined();
    expect(contextBlock!.elements![0].text).toContain(':red_circle:');
  });

  it('context block contains :large_yellow_circle: for soon urgency', () => {
    const result = adapter.deliver(makePayload({ urgency: 'soon' }));

    const output = result.formattedOutput as {
      blocks: Array<{
        type: string;
        elements?: Array<{ type: string; text: string }>;
      }>;
    };
    const contextBlock = output.blocks.find(b => b.type === 'context');
    expect(contextBlock!.elements![0].text).toContain(':large_yellow_circle:');
  });

  it('context block contains :blue_circle: for informational urgency', () => {
    const result = adapter.deliver(makePayload({ urgency: 'informational' }));

    const output = result.formattedOutput as {
      blocks: Array<{
        type: string;
        elements?: Array<{ type: string; text: string }>;
      }>;
    };
    const contextBlock = output.blocks.find(b => b.type === 'context');
    expect(contextBlock!.elements![0].text).toContain(':blue_circle:');
  });

  it('context block includes repository and request_id', () => {
    const result = adapter.deliver(makePayload({
      repository: 'my-repo',
      request_id: 'req-123',
    }));

    const output = result.formattedOutput as {
      blocks: Array<{
        type: string;
        elements?: Array<{ type: string; text: string }>;
      }>;
    };
    const contextBlock = output.blocks.find(b => b.type === 'context');
    const text = contextBlock!.elements![0].text;
    expect(text).toContain('*Repository:* my-repo');
    expect(text).toContain('*Request:* req-123');
  });

  // Test Case 12: Batch: dividers between groups
  it('batch output includes divider blocks between notification groups', () => {
    const payloads: NotificationPayload[] = [
      makePayload({ notification_id: 'n1' }),
      makePayload({ notification_id: 'n2' }),
      makePayload({ notification_id: 'n3' }),
    ];

    const result = adapter.deliverBatch(payloads);
    expect(result.success).toBe(true);

    const output = result.formattedOutput as {
      blocks: Array<{ type: string }>;
    };
    const dividers = output.blocks.filter(b => b.type === 'divider');
    // 3 notifications = 2 dividers between them
    expect(dividers).toHaveLength(2);
  });

  it('batch produces single message with all notifications', () => {
    const payloads: NotificationPayload[] = [
      makePayload({ notification_id: 'n1', title: 'First' }),
      makePayload({ notification_id: 'n2', title: 'Second' }),
    ];

    const result = adapter.deliverBatch(payloads);
    const output = result.formattedOutput as {
      blocks: Array<{ type: string; text?: { text: string } }>;
    };

    const headers = output.blocks.filter(b => b.type === 'header');
    expect(headers).toHaveLength(2);
    expect(headers[0].text?.text).toBe('First');
    expect(headers[1].text?.text).toBe('Second');
  });

  it('empty batch produces empty blocks array', () => {
    const result = adapter.deliverBatch([]);
    expect(result.success).toBe(true);
    const output = result.formattedOutput as { blocks: unknown[] };
    expect(output.blocks).toHaveLength(0);
  });

  it('returns DeliveryResult with success, method, and formattedOutput', () => {
    const result = adapter.deliver(makePayload());
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('method');
    expect(result).toHaveProperty('formattedOutput');
    expect(typeof result.formattedOutput).toBe('object');
  });
});
