import { DiscordDeliveryAdapter } from '../../../src/notifications/adapters/discord-adapter';
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

describe('DiscordDeliveryAdapter', () => {
  let adapter: DiscordDeliveryAdapter;

  beforeEach(() => {
    adapter = new DiscordDeliveryAdapter();
  });

  it('has method "discord"', () => {
    expect(adapter.method).toBe('discord');
  });

  // Test Case 5: Single: valid embed JSON
  it('produces valid JSON with embeds array', () => {
    const result = adapter.deliver(makePayload());
    expect(result.success).toBe(true);
    expect(result.method).toBe('discord');

    const output = result.formattedOutput as { embeds: unknown[] };
    expect(output).toHaveProperty('embeds');
    expect(Array.isArray(output.embeds)).toBe(true);
    expect(output.embeds).toHaveLength(1);

    // Verify it can round-trip through JSON
    const json = JSON.stringify(output);
    const parsed = JSON.parse(json);
    expect(parsed.embeds).toHaveLength(1);
  });

  // Test Case 6: Single: immediate color 16711680
  it('uses color 16711680 (red) for immediate urgency', () => {
    const result = adapter.deliver(makePayload({ urgency: 'immediate' }));
    const output = result.formattedOutput as { embeds: Array<{ color: number }> };
    expect(output.embeds[0].color).toBe(16711680);
  });

  it('uses color 16776960 (yellow) for soon urgency', () => {
    const result = adapter.deliver(makePayload({ urgency: 'soon' }));
    const output = result.formattedOutput as { embeds: Array<{ color: number }> };
    expect(output.embeds[0].color).toBe(16776960);
  });

  it('uses color 3447003 (blue) for informational urgency', () => {
    const result = adapter.deliver(makePayload({ urgency: 'informational' }));
    const output = result.formattedOutput as { embeds: Array<{ color: number }> };
    expect(output.embeds[0].color).toBe(3447003);
  });

  // Test Case 7: Single: fields include repo and request
  it('embed fields contain repository and request values', () => {
    const result = adapter.deliver(makePayload({
      repository: 'my-cool-repo',
      request_id: 'req-xyz-123',
    }));
    const output = result.formattedOutput as {
      embeds: Array<{
        fields: Array<{ name: string; value: string; inline: boolean }>;
      }>;
    };

    const fields = output.embeds[0].fields;
    const repoField = fields.find(f => f.name === 'Repository');
    const requestField = fields.find(f => f.name === 'Request');

    expect(repoField).toBeDefined();
    expect(repoField!.value).toBe('my-cool-repo');
    expect(repoField!.inline).toBe(true);

    expect(requestField).toBeDefined();
    expect(requestField!.value).toBe('req-xyz-123');
    expect(requestField!.inline).toBe(true);
  });

  it('embed includes title and description from payload', () => {
    const result = adapter.deliver(makePayload({
      title: 'My Title',
      body: 'My Description',
    }));
    const output = result.formattedOutput as {
      embeds: Array<{ title: string; description: string }>;
    };
    expect(output.embeds[0].title).toBe('My Title');
    expect(output.embeds[0].description).toBe('My Description');
  });

  it('embed includes timestamp', () => {
    const result = adapter.deliver(makePayload({
      timestamp: '2026-04-08T10:30:00Z',
    }));
    const output = result.formattedOutput as {
      embeds: Array<{ timestamp: string }>;
    };
    expect(output.embeds[0].timestamp).toBe('2026-04-08T10:30:00Z');
  });

  it('embed includes urgency field', () => {
    const result = adapter.deliver(makePayload({ urgency: 'immediate' }));
    const output = result.formattedOutput as {
      embeds: Array<{
        fields: Array<{ name: string; value: string }>;
      }>;
    };
    const urgencyField = output.embeds[0].fields.find(f => f.name === 'Urgency');
    expect(urgencyField).toBeDefined();
    expect(urgencyField!.value).toBe('immediate');
  });

  // Test Case 8: Batch: consolidated embed
  it('produces single embed with multiple field groups for batch', () => {
    const payloads: NotificationPayload[] = [
      makePayload({ notification_id: 'n1', urgency: 'immediate' }),
      makePayload({ notification_id: 'n2', urgency: 'soon' }),
      makePayload({ notification_id: 'n3', urgency: 'informational' }),
    ];

    const result = adapter.deliverBatch(payloads);
    expect(result.success).toBe(true);

    const output = result.formattedOutput as { embeds: unknown[] };
    expect(output.embeds).toHaveLength(1);

    // The single embed should have fields for all 3 notifications
    const embed = output.embeds[0] as { fields: Array<{ name: string }> };
    const repoFields = embed.fields.filter(f => f.name === 'Repository');
    expect(repoFields).toHaveLength(3);
  });

  it('batch uses highest urgency color', () => {
    const payloads: NotificationPayload[] = [
      makePayload({ notification_id: 'n1', urgency: 'informational' }),
      makePayload({ notification_id: 'n2', urgency: 'soon' }),
    ];

    const result = adapter.deliverBatch(payloads);
    const output = result.formattedOutput as {
      embeds: Array<{ color: number }>;
    };
    // "soon" is highest urgency in this batch
    expect(output.embeds[0].color).toBe(16776960);
  });

  it('returns DeliveryResult with success, method, and formattedOutput', () => {
    const result = adapter.deliver(makePayload());
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('method');
    expect(result).toHaveProperty('formattedOutput');
    expect(typeof result.formattedOutput).toBe('object');
  });
});
