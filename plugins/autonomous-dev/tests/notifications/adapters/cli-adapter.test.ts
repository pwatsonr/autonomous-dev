import { CliDeliveryAdapter } from '../../../src/notifications/adapters/cli-adapter';
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

describe('CliDeliveryAdapter', () => {
  let adapter: CliDeliveryAdapter;

  beforeEach(() => {
    adapter = new CliDeliveryAdapter();
  });

  it('has method "cli"', () => {
    expect(adapter.method).toBe('cli');
  });

  // Test Case 1: Single: immediate urgency red
  it('applies ANSI red escape code for immediate urgency', () => {
    const result = adapter.deliver(makePayload({ urgency: 'immediate' }));
    expect(result.success).toBe(true);
    expect(result.method).toBe('cli');
    const output = result.formattedOutput as string;
    expect(output).toContain('\x1b[31m');
    expect(output).toContain('\x1b[0m');
  });

  it('applies ANSI yellow escape code for soon urgency', () => {
    const result = adapter.deliver(makePayload({ urgency: 'soon' }));
    const output = result.formattedOutput as string;
    expect(output).toContain('\x1b[33m');
    expect(output).toContain('\x1b[0m');
  });

  // Test Case 2: Single: informational no color
  it('applies no color codes for informational urgency', () => {
    const result = adapter.deliver(makePayload({ urgency: 'informational' }));
    const output = result.formattedOutput as string;
    expect(output).not.toContain('\x1b[31m');
    expect(output).not.toContain('\x1b[33m');
    expect(output).not.toContain('\x1b[0m');
  });

  // Test Case 3: Single: contains title and body
  it('includes title and body in output', () => {
    const payload = makePayload({
      title: 'Test Title Here',
      body: 'Detailed body content',
    });
    const result = adapter.deliver(payload);
    const output = result.formattedOutput as string;
    expect(output).toContain('Test Title Here');
    expect(output).toContain('Detailed body content');
  });

  it('includes request_id, timestamp, event_type, and repository', () => {
    const payload = makePayload();
    const result = adapter.deliver(payload);
    const output = result.formattedOutput as string;
    expect(output).toContain('req-abc');
    expect(output).toContain('2026-04-08T10:30:00Z');
    expect(output).toContain('escalation');
    expect(output).toContain('repo-name');
  });

  it('formats urgency label as uppercase', () => {
    const result = adapter.deliver(makePayload({ urgency: 'immediate' }));
    const output = result.formattedOutput as string;
    expect(output).toContain('IMMEDIATE');
  });

  // Test Case 4: Batch: grouped by request
  it('groups batch output by request ID', () => {
    const payloads: NotificationPayload[] = [
      makePayload({ request_id: 'req-1', event_type: 'escalation', notification_id: 'n1' }),
      makePayload({ request_id: 'req-1', event_type: 'pipeline_failed', notification_id: 'n2' }),
      makePayload({ request_id: 'req-1', event_type: 'escalation', notification_id: 'n3' }),
      makePayload({ request_id: 'req-2', event_type: 'gate_approval_needed', notification_id: 'n4' }),
      makePayload({ request_id: 'req-2', event_type: 'pipeline_completed', notification_id: 'n5' }),
    ];

    const result = adapter.deliverBatch(payloads);
    expect(result.success).toBe(true);
    const output = result.formattedOutput as string;

    // Should have 2 request groups
    expect(output).toContain('Request: req-1');
    expect(output).toContain('Request: req-2');
    expect(output).toContain('3 notifications');
    expect(output).toContain('2 notifications');
  });

  it('groups batch output by event type within request', () => {
    const payloads: NotificationPayload[] = [
      makePayload({ request_id: 'req-1', event_type: 'escalation', notification_id: 'n1' }),
      makePayload({ request_id: 'req-1', event_type: 'pipeline_failed', notification_id: 'n2' }),
      makePayload({ request_id: 'req-1', event_type: 'escalation', notification_id: 'n3' }),
    ];

    const result = adapter.deliverBatch(payloads);
    const output = result.formattedOutput as string;

    // Should have event type sub-groups
    expect(output).toContain('[escalation]');
    expect(output).toContain('[pipeline_failed]');
  });

  it('returns empty string for empty batch', () => {
    const result = adapter.deliverBatch([]);
    expect(result.success).toBe(true);
    expect(result.formattedOutput).toBe('');
  });

  it('returns DeliveryResult with success, method, and formattedOutput', () => {
    const result = adapter.deliver(makePayload());
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('method');
    expect(result).toHaveProperty('formattedOutput');
    expect(typeof result.formattedOutput).toBe('string');
  });
});
