/**
 * Unit tests for DeliveryManager (SPEC-009-5-7, Task 22).
 *
 * Tests cover:
 *   1. Configured method succeeds
 *   2. Configured method fails, CLI fallback
 *   3. Configured and CLI fail, file_drop fallback
 *   4. All fail: pipeline pauses
 *   5. Per-type override: escalation to slack
 *   6. Per-type override fails, fallback chain
 *   7. Batch delivery uses same fallback
 */

import { DeliveryManager } from '../delivery-manager';
import type {
  DeliveryAdapter,
  DeliveryMethod,
  DeliveryResult,
  NotificationEventType,
  NotificationPayload,
} from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(
  overrides: Partial<NotificationPayload> = {},
): NotificationPayload {
  return {
    notification_id: 'notif-001',
    event_type: 'pipeline_completed',
    urgency: 'informational',
    timestamp: new Date().toISOString(),
    request_id: 'req-001',
    repository: 'test-repo',
    title: 'Test notification',
    body: 'Test body',
    ...overrides,
  };
}

function makeAdapter(
  method: DeliveryMethod,
  success: boolean,
): DeliveryAdapter {
  return {
    method,
    deliver(_payload: NotificationPayload): DeliveryResult {
      return {
        success,
        method,
        formattedOutput: success ? `delivered via ${method}` : '',
        error: success ? undefined : `${method} failed`,
      };
    },
    deliverBatch(_payloads: NotificationPayload[]): DeliveryResult {
      return {
        success,
        method,
        formattedOutput: success ? `batch delivered via ${method}` : '',
        error: success ? undefined : `${method} batch failed`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeliveryManager', () => {
  // Test Case 1: Configured method succeeds
  test('configured method succeeds and returns result', () => {
    const adapters = new Map<DeliveryMethod, DeliveryAdapter>([
      ['slack', makeAdapter('slack', true)],
      ['cli', makeAdapter('cli', true)],
    ]);
    const dm = new DeliveryManager(
      adapters,
      'slack',
      new Map(),
      jest.fn(),
    );

    const result = dm.deliver(makePayload());

    expect(result.success).toBe(true);
    expect(result.method).toBe('slack');
  });

  // Test Case 2: Configured method fails, CLI fallback
  test('CLI fallback used when configured method fails', () => {
    const adapters = new Map<DeliveryMethod, DeliveryAdapter>([
      ['slack', makeAdapter('slack', false)],
      ['cli', makeAdapter('cli', true)],
    ]);
    const dm = new DeliveryManager(
      adapters,
      'slack',
      new Map(),
      jest.fn(),
    );

    const result = dm.deliver(makePayload());

    expect(result.success).toBe(true);
    expect(result.method).toBe('cli');
  });

  // Test Case 3: Configured and CLI fail, file_drop fallback
  test('file_drop fallback used when configured and CLI both fail', () => {
    const adapters = new Map<DeliveryMethod, DeliveryAdapter>([
      ['slack', makeAdapter('slack', false)],
      ['cli', makeAdapter('cli', false)],
      ['file_drop', makeAdapter('file_drop', true)],
    ]);
    const dm = new DeliveryManager(
      adapters,
      'slack',
      new Map(),
      jest.fn(),
    );

    const result = dm.deliver(makePayload());

    expect(result.success).toBe(true);
    expect(result.method).toBe('file_drop');
  });

  // Test Case 4: All fail: pipeline pauses
  test('onAllFailed called when all delivery methods fail', () => {
    const onAllFailed = jest.fn();
    const adapters = new Map<DeliveryMethod, DeliveryAdapter>([
      ['slack', makeAdapter('slack', false)],
      ['cli', makeAdapter('cli', false)],
      ['file_drop', makeAdapter('file_drop', false)],
    ]);
    const dm = new DeliveryManager(
      adapters,
      'slack',
      new Map(),
      onAllFailed,
    );

    const result = dm.deliver(makePayload());

    expect(result.success).toBe(false);
    expect(onAllFailed).toHaveBeenCalledTimes(1);
  });

  // Test Case 5: Per-type override: escalation to slack
  test('per-type override routes escalation to slack', () => {
    const adapters = new Map<DeliveryMethod, DeliveryAdapter>([
      ['cli', makeAdapter('cli', true)],
      ['slack', makeAdapter('slack', true)],
    ]);
    const overrides = new Map<NotificationEventType, DeliveryMethod>([
      ['escalation', 'slack'],
    ]);
    const dm = new DeliveryManager(
      adapters,
      'cli',
      overrides,
      jest.fn(),
    );

    const result = dm.deliver(
      makePayload({ event_type: 'escalation' }),
    );

    expect(result.success).toBe(true);
    expect(result.method).toBe('slack');
  });

  // Test Case 6: Per-type override fails, fallback chain
  test('fallback chain applies when per-type override fails', () => {
    const adapters = new Map<DeliveryMethod, DeliveryAdapter>([
      ['slack', makeAdapter('slack', false)],
      ['cli', makeAdapter('cli', true)],
    ]);
    const overrides = new Map<NotificationEventType, DeliveryMethod>([
      ['escalation', 'slack'],
    ]);
    const dm = new DeliveryManager(
      adapters,
      'cli',
      overrides,
      jest.fn(),
    );

    const result = dm.deliver(
      makePayload({ event_type: 'escalation' }),
    );

    expect(result.success).toBe(true);
    expect(result.method).toBe('cli');
  });

  // Test Case 7: Batch delivery uses same fallback
  test('deliverBatch follows same fallback chain', () => {
    const adapters = new Map<DeliveryMethod, DeliveryAdapter>([
      ['discord', makeAdapter('discord', false)],
      ['cli', makeAdapter('cli', true)],
    ]);
    const dm = new DeliveryManager(
      adapters,
      'discord',
      new Map(),
      jest.fn(),
    );

    const result = dm.deliverBatch([makePayload(), makePayload()]);

    expect(result.success).toBe(true);
    expect(result.method).toBe('cli');
  });

  // Empty batch returns success
  test('deliverBatch with empty array returns success', () => {
    const dm = new DeliveryManager(
      new Map(),
      'cli',
      new Map(),
      jest.fn(),
    );

    const result = dm.deliverBatch([]);

    expect(result.success).toBe(true);
  });
});
