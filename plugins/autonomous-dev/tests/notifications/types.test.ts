import type {
  NotificationEventType,
  NotificationUrgency,
  DeliveryMethod,
  NotificationPayload,
  DeliveryAdapter,
  DeliveryResult,
  BatchingConfig,
  DndConfig,
  FatigueConfig,
  CrossRequestConfig,
} from '../../src/notifications/types';

describe('Notification types', () => {
  it('NotificationEventType enumerates all 7 values', () => {
    const types: NotificationEventType[] = [
      'escalation',
      'gate_approval_needed',
      'pipeline_completed',
      'pipeline_failed',
      'trust_level_changed',
      'kill_switch_activated',
      'systemic_issue',
    ];
    expect(types).toHaveLength(7);
    // TypeScript compilation itself verifies these are valid values
  });

  it('NotificationUrgency enumerates all 3 values', () => {
    const urgencies: NotificationUrgency[] = [
      'immediate',
      'soon',
      'informational',
    ];
    expect(urgencies).toHaveLength(3);
  });

  it('DeliveryMethod enumerates all 4 values', () => {
    const methods: DeliveryMethod[] = [
      'cli',
      'discord',
      'slack',
      'file_drop',
    ];
    expect(methods).toHaveLength(4);
  });

  it('NotificationPayload accepts valid shape', () => {
    const payload: NotificationPayload = {
      notification_id: '550e8400-e29b-41d4-a716-446655440000',
      event_type: 'escalation',
      urgency: 'immediate',
      timestamp: '2026-04-08T10:30:00Z',
      request_id: 'req-abc',
      repository: 'repo-name',
      title: 'Test notification',
      body: 'Test body content',
      metadata: { key: 'value' },
    };
    expect(payload.notification_id).toBeDefined();
    expect(payload.event_type).toBe('escalation');
  });

  it('DeliveryResult shape is valid', () => {
    const result: DeliveryResult = {
      success: true,
      method: 'cli',
      formattedOutput: 'text output',
    };
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('DeliveryResult with error is valid', () => {
    const result: DeliveryResult = {
      success: false,
      method: 'discord',
      formattedOutput: {},
      error: 'something went wrong',
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe('something went wrong');
  });

  it('BatchingConfig shape is valid', () => {
    const config: BatchingConfig = {
      flushIntervalMinutes: 60,
      maxBufferSize: 50,
      exemptTypes: ['escalation'],
    };
    expect(config.flushIntervalMinutes).toBe(60);
  });

  it('DndConfig shape is valid', () => {
    const config: DndConfig = {
      enabled: true,
      startTime: '22:00',
      endTime: '08:00',
      timezone: 'America/New_York',
    };
    expect(config.enabled).toBe(true);
  });

  it('FatigueConfig shape is valid', () => {
    const config: FatigueConfig = {
      enabled: true,
      thresholdPerHour: 20,
      cooldownMinutes: 30,
    };
    expect(config.thresholdPerHour).toBe(20);
  });

  it('CrossRequestConfig shape is valid', () => {
    const config: CrossRequestConfig = {
      enabled: true,
      windowMinutes: 60,
      threshold: 3,
    };
    expect(config.threshold).toBe(3);
  });
});
