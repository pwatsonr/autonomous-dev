/**
 * Unit tests for notification config loading (SPEC-009-5-7, Tasks 19/22).
 *
 * Tests cover:
 *   15. Valid config loads
 *   16. Missing config uses defaults (cli, batching defaults, DND disabled)
 */

import { loadNotificationConfig } from '../notification-config';

describe('loadNotificationConfig', () => {
  // Test Case 15: Valid config loads
  test('valid config with all fields parses correctly', () => {
    const config = loadNotificationConfig({
      default_method: 'slack',
      per_type_overrides: {
        escalation: 'discord',
      },
      batching: {
        flushIntervalMinutes: 30,
        maxBufferSize: 100,
        exemptTypes: ['escalation', 'pipeline_failed'],
      },
      dnd: {
        enabled: true,
        startTime: '22:00',
        endTime: '07:00',
        timezone: 'America/New_York',
      },
      fatigue: {
        enabled: true,
        thresholdPerHour: 15,
        cooldownMinutes: 45,
      },
      cross_request: {
        enabled: true,
        windowMinutes: 30,
        threshold: 5,
      },
      daily_digest_time: '08:00',
      daily_digest_timezone: 'Europe/London',
    });

    expect(config.default_method).toBe('slack');
    expect(config.per_type_overrides.escalation).toBe('discord');
    expect(config.batching.flushIntervalMinutes).toBe(30);
    expect(config.batching.maxBufferSize).toBe(100);
    expect(config.dnd.enabled).toBe(true);
    expect(config.dnd.timezone).toBe('America/New_York');
    expect(config.fatigue.enabled).toBe(true);
    expect(config.fatigue.thresholdPerHour).toBe(15);
    expect(config.cross_request.enabled).toBe(true);
    expect(config.cross_request.threshold).toBe(5);
    expect(config.daily_digest_time).toBe('08:00');
    expect(config.daily_digest_timezone).toBe('Europe/London');
  });

  // Test Case 16: Missing config uses defaults
  test('empty/missing config uses all defaults', () => {
    const config = loadNotificationConfig(undefined);

    expect(config.default_method).toBe('cli');
    expect(config.per_type_overrides).toEqual({});
    expect(config.batching.flushIntervalMinutes).toBe(60);
    expect(config.batching.maxBufferSize).toBe(50);
    expect(config.dnd.enabled).toBe(false);
    expect(config.fatigue.enabled).toBe(false);
    expect(config.fatigue.thresholdPerHour).toBe(20);
    expect(config.cross_request.enabled).toBe(false);
    expect(config.cross_request.windowMinutes).toBe(60);
    expect(config.cross_request.threshold).toBe(3);
    expect(config.daily_digest_time).toBe('09:00');
    expect(config.daily_digest_timezone).toBe('UTC');
  });

  test('null config uses all defaults', () => {
    const config = loadNotificationConfig(null);

    expect(config.default_method).toBe('cli');
    expect(config.dnd.enabled).toBe(false);
  });

  // Invalid default_method
  test('invalid default_method falls back to cli', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    const config = loadNotificationConfig({
      default_method: 'email',
    });

    expect(config.default_method).toBe('cli');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('default_method'),
    );

    warnSpy.mockRestore();
  });

  // Invalid per_type_overrides (invalid method) silently skipped
  test('invalid per_type_override method is skipped', () => {
    const config = loadNotificationConfig({
      per_type_overrides: {
        escalation: 'carrier_pigeon',
        pipeline_completed: 'discord',
      },
    });

    expect(config.per_type_overrides.escalation).toBeUndefined();
    expect(config.per_type_overrides.pipeline_completed).toBe('discord');
  });

  // Invalid batching values use defaults
  test('invalid batching values use defaults', () => {
    const config = loadNotificationConfig({
      batching: {
        flushIntervalMinutes: -1,
        maxBufferSize: 0,
      },
    });

    expect(config.batching.flushIntervalMinutes).toBe(60);
    expect(config.batching.maxBufferSize).toBe(50);
  });

  // Invalid daily_digest_time
  test('invalid daily_digest_time uses default 09:00', () => {
    const config = loadNotificationConfig({
      daily_digest_time: 'invalid',
    });

    expect(config.daily_digest_time).toBe('09:00');
  });

  test('24:00 is invalid HH:MM format, uses default', () => {
    const config = loadNotificationConfig({
      daily_digest_time: '24:00',
    });

    expect(config.daily_digest_time).toBe('09:00');
  });

  // Partial config merges with defaults
  test('partial config merges with defaults', () => {
    const config = loadNotificationConfig({
      default_method: 'discord',
      // everything else defaults
    });

    expect(config.default_method).toBe('discord');
    expect(config.dnd.enabled).toBe(false);
    expect(config.fatigue.enabled).toBe(false);
    expect(config.batching.flushIntervalMinutes).toBe(60);
  });
});
