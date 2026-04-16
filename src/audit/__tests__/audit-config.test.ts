/**
 * Unit tests for audit config loading (SPEC-009-5-7, Tasks 19/21).
 *
 * Tests cover:
 *   12. Valid full config loads
 *   13. Missing config uses defaults
 *   14. Invalid active_days falls back to 90
 */

import { loadAuditConfig } from '../audit-config';
import type { AuditConfig } from '../audit-config';

describe('loadAuditConfig', () => {
  // Test Case 12: Valid full config loads
  test('valid config with all fields parses correctly', () => {
    const config = loadAuditConfig({
      log_path: '/custom/path/events.jsonl',
      integrity: {
        hash_chain_enabled: true,
        verification_schedule: '0 3 * * *',
      },
      retention: {
        active_days: 180,
        archive_path: '/custom/archive/',
      },
      decision_log: {
        include_alternatives: false,
        include_confidence: false,
      },
    });

    expect(config.log_path).toBe('/custom/path/events.jsonl');
    expect(config.integrity.hash_chain_enabled).toBe(true);
    expect(config.integrity.verification_schedule).toBe('0 3 * * *');
    expect(config.retention.active_days).toBe(180);
    expect(config.retention.archive_path).toBe('/custom/archive/');
    expect(config.decision_log.include_alternatives).toBe(false);
    expect(config.decision_log.include_confidence).toBe(false);
  });

  // Test Case 13: Missing config uses defaults
  test('empty/missing config uses all defaults', () => {
    const config = loadAuditConfig(undefined);

    expect(config.log_path).toBe('.autonomous-dev/events.jsonl');
    expect(config.integrity.hash_chain_enabled).toBe(false);
    expect(config.integrity.verification_schedule).toBe('0 2 * * *');
    expect(config.retention.active_days).toBe(90);
    expect(config.retention.archive_path).toBe('.autonomous-dev/archive/');
    expect(config.decision_log.include_alternatives).toBe(true);
    expect(config.decision_log.include_confidence).toBe(true);
  });

  test('null config uses all defaults', () => {
    const config = loadAuditConfig(null);

    expect(config.log_path).toBe('.autonomous-dev/events.jsonl');
    expect(config.integrity.hash_chain_enabled).toBe(false);
    expect(config.retention.active_days).toBe(90);
  });

  test('empty object config uses all defaults', () => {
    const config = loadAuditConfig({});

    expect(config.log_path).toBe('.autonomous-dev/events.jsonl');
    expect(config.integrity.hash_chain_enabled).toBe(false);
    expect(config.retention.active_days).toBe(90);
  });

  // Test Case 14: Invalid active_days falls back to 90
  test('invalid active_days (-5) falls back to default 90', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    const config = loadAuditConfig({
      retention: {
        active_days: -5,
      },
    });

    expect(config.retention.active_days).toBe(90);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('active_days'),
    );

    warnSpy.mockRestore();
  });

  test('zero active_days falls back to default 90', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    const config = loadAuditConfig({
      retention: {
        active_days: 0,
      },
    });

    expect(config.retention.active_days).toBe(90);
    warnSpy.mockRestore();
  });

  // Invalid hash_chain_enabled
  test('non-boolean hash_chain_enabled falls back to false', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    const config = loadAuditConfig({
      integrity: {
        hash_chain_enabled: 'yes',
      },
    });

    expect(config.integrity.hash_chain_enabled).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('hash_chain_enabled'),
    );

    warnSpy.mockRestore();
  });

  // Partial config merges with defaults
  test('partial config merges with defaults', () => {
    const config = loadAuditConfig({
      log_path: '/custom/events.jsonl',
      // integrity and retention not provided -> defaults
    });

    expect(config.log_path).toBe('/custom/events.jsonl');
    expect(config.integrity.hash_chain_enabled).toBe(false);
    expect(config.retention.active_days).toBe(90);
  });
});
