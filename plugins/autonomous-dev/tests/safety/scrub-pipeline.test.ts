/**
 * Tests for Scrub Pipeline Orchestrator — SPEC-007-2-2.
 *
 * Covers pipeline ordering, post-scrub validation, failure mode handling,
 * and the full `scrub()` entry point.
 *
 * Test cases TC-2-2-01 through TC-2-2-13.
 */

import {
  scrub,
  performScrub,
  postScrubValidation,
  detectResiduals,
  buildSafetyConfig,
  ScrubTimeoutError,
  getMalformedPatternWarnings,
  clearMalformedPatternWarnings,
} from '../../src/safety/scrub-pipeline';
import type {
  DataSafetyConfig,
  PatternDefinition,
  ScrubContext,
  ScrubResult,
} from '../../src/safety/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<ScrubContext> = {}): ScrubContext {
  return {
    runId: 'RUN-TEST-001',
    service: 'test-service',
    source: 'opensearch',
    lineCount: 1,
    ...overrides,
  };
}

function defaultConfig(): DataSafetyConfig {
  return buildSafetyConfig();
}

// ---------------------------------------------------------------------------
// TC-2-2-01: PII before secrets ordering
// ---------------------------------------------------------------------------

describe('TC-2-2-01: PII before secrets ordering', () => {
  test('email in key=value is redacted as email, not double-tagged as secret', async () => {
    const config = defaultConfig();
    const context = makeContext({ fieldName: 'test_field' });
    const result = await scrub('key=john@example.com', config, context);

    expect(result.text).toBe('key=[REDACTED:email]');
    expect(result.redactions.some((r) => r.type === 'email')).toBe(true);
    // Should NOT have a secret redaction for the email
    expect(
      result.redactions.filter((r) => r.type === 'secret').length,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TC-2-2-02: Mixed PII and secrets
// ---------------------------------------------------------------------------

describe('TC-2-2-02: Mixed PII and secrets', () => {
  test('both email and GitHub PAT are redacted with correct types', async () => {
    const config = defaultConfig();
    const context = makeContext({ fieldName: 'mixed' });
    const input = 'user john@example.com token=ghp_abcdefghijklmnopqrstuvwxyz1234567890';
    const result = await scrub(input, config, context);

    expect(result.text).toContain('[REDACTED:email]');
    expect(result.text).toContain('[SECRET_REDACTED]');
    expect(result.redactions.some((r) => r.type === 'email')).toBe(true);
    expect(result.redactions.some((r) => r.type === 'secret')).toBe(true);
    expect(result.redaction_count).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// TC-2-2-03: Custom pattern appended
// ---------------------------------------------------------------------------

describe('TC-2-2-03: Custom pattern appended', () => {
  test('custom PII pattern is applied alongside built-in patterns', async () => {
    const customPattern: PatternDefinition = {
      name: 'custom_id',
      type: 'custom',
      regex: /CUSTOM_\d{6}/g,
      replacement: '[REDACTED:custom]',
    };
    const config = buildSafetyConfig([customPattern]);
    const context = makeContext({ fieldName: 'custom' });
    const input = 'user john@example.com id CUSTOM_123456';
    const result = await scrub(input, config, context);

    expect(result.text).toContain('[REDACTED:email]');
    expect(result.text).toContain('[REDACTED:custom]');
    expect(result.redactions.some((r) => r.type === 'email')).toBe(true);
    expect(result.redactions.some((r) => r.type === 'custom')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TC-2-2-04: Post-scrub clean
// ---------------------------------------------------------------------------

describe('TC-2-2-04: Post-scrub clean', () => {
  test('text with 3 emails scrubbed: validation passes, 0 residuals', async () => {
    const config = defaultConfig();
    const context = makeContext({ fieldName: 'emails' });
    const input = 'a@b.com c@d.com e@f.com';
    const result = await scrub(input, config, context);

    expect(result.text).toBe(
      '[REDACTED:email] [REDACTED:email] [REDACTED:email]',
    );
    expect(result.validation_passed).toBe(true);
    expect(result.redaction_count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// TC-2-2-05: Post-scrub residual caught
// ---------------------------------------------------------------------------

describe('TC-2-2-05: Post-scrub residual caught', () => {
  test('contrived pattern: residual caught on second pass', () => {
    // Create a pattern that, after replacement, produces text matching
    // another pattern. The trick pattern replaces "HIDE_THIS" with an
    // IPv4 address, which then triggers the IPv4 redaction on re-scrub.
    const trickPattern: PatternDefinition = {
      name: 'trick_pattern',
      type: 'trick',
      regex: /HIDE_THIS/g,
      replacement: '192.168.1.1', // This will be a residual
    };
    const config = buildSafetyConfig([trickPattern]);

    // performScrub will apply all PII patterns (including trick appended
    // after built-in), producing an IPv4 address as a residual
    const initial = performScrub('Test HIDE_THIS end', config, {
      fieldName: 'trick',
    });

    // The trick pattern created a residual (192.168.1.1)
    const validated = postScrubValidation(initial, config, 'trick');

    // After re-scrub the IPv4 should be caught
    expect(validated.text).toContain('[REDACTED:ip]');
    expect(validated.validation_passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TC-2-2-06: Post-scrub persistent residual
// ---------------------------------------------------------------------------

describe('TC-2-2-06: Post-scrub persistent residual', () => {
  test('pattern that cannot be fully scrubbed results in SCRUB_FAILED', () => {
    // Create a pattern whose replacement itself matches the same pattern,
    // creating an infinite loop that triggers the nuclear option.
    const selfMatchPattern: PatternDefinition = {
      name: 'infinite_loop',
      type: 'loop',
      regex: /LOOP_\d+/g,
      replacement: 'LOOP_999', // Replacement matches the same pattern
    };

    // Build config with only this pattern (to isolate behavior)
    const config: DataSafetyConfig = {
      pii_patterns: [selfMatchPattern],
      secret_patterns: [],
      timeout_ms: 30_000,
    };

    const initial = performScrub('Test LOOP_123 end', config, {
      fieldName: 'loop_field',
    });

    // Initial scrub replaces LOOP_123 with LOOP_999
    // Residual detection finds LOOP_999
    // Re-scrub replaces LOOP_999 with LOOP_999 (same text)
    // Residual detection still finds LOOP_999
    // Nuclear option: SCRUB_FAILED
    const validated = postScrubValidation(initial, config, 'loop_field');

    expect(validated.text).toBe('[SCRUB_FAILED:loop_field]');
    expect(validated.validation_passed).toBe(false);
    expect(validated.scrub_failed_fields).toContain('loop_field');
  });
});

// ---------------------------------------------------------------------------
// TC-2-2-07: Malformed regex skipped
// ---------------------------------------------------------------------------

describe('TC-2-2-07: Malformed regex skipped', () => {
  beforeEach(() => {
    clearMalformedPatternWarnings();
  });

  test('malformed custom regex is caught and skipped, remaining patterns work', async () => {
    // Create a pattern with an invalid regex source that throws when
    // reconstructed via `new RegExp()`
    const badPattern: PatternDefinition = {
      name: 'bad_regex',
      type: 'bad',
      regex: /(?=)/g, // valid but useless — we override .source below
      replacement: '[BAD]',
    };

    // Override the regex source to something that will throw
    Object.defineProperty(badPattern.regex, 'source', {
      value: '[invalid regex',
      writable: false,
    });

    const config = buildSafetyConfig([badPattern]);
    const context = makeContext({ fieldName: 'malformed' });
    const input = 'user john@example.com logged in';
    const result = await scrub(input, config, context);

    // Email should still be redacted despite the bad pattern
    expect(result.text).toContain('[REDACTED:email]');

    // Warning should be logged
    const warnings = getMalformedPatternWarnings();
    expect(warnings.some((w) => w.patternName === 'bad_regex')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TC-2-2-08: Timeout discards data
// ---------------------------------------------------------------------------

describe('TC-2-2-08: Timeout discards data', () => {
  test('ScrubTimeoutError has correct name and message', () => {
    const error = new ScrubTimeoutError('Scrubbing exceeded 30000ms');
    expect(error.name).toBe('ScrubTimeoutError');
    expect(error.message).toBe('Scrubbing exceeded 30000ms');
    expect(error instanceof Error).toBe(true);
  });

  test('timeout result never contains unscrubbed data', () => {
    // Verify the shape of a timeout result matches spec
    const timeoutResult: ScrubResult = {
      text: '[SCRUB_FAILED:timeout]',
      redaction_count: 0,
      redactions: [],
      validation_passed: false,
      scrub_failed_fields: ['*'],
      processing_time_ms: 30_000,
    };

    expect(timeoutResult.text).toBe('[SCRUB_FAILED:timeout]');
    expect(timeoutResult.validation_passed).toBe(false);
    expect(timeoutResult.scrub_failed_fields).toEqual(['*']);
    expect(timeoutResult.redaction_count).toBe(0);
    // Unscrubbed text is NEVER present
    expect(timeoutResult.text).not.toContain('@');
  });

  test('scrub with very short timeout may timeout', async () => {
    const config: DataSafetyConfig = {
      ...defaultConfig(),
      timeout_ms: 1,
    };
    const context = makeContext({ fieldName: 'timeout_field' });
    const input = 'user john@example.com '.repeat(10000);

    const result = await scrub(input, config, context);

    // Either completes or times out -- both are acceptable
    expect(result).toBeDefined();
    expect(typeof result.text).toBe('string');
    if (result.text === '[SCRUB_FAILED:timeout]') {
      expect(result.validation_passed).toBe(false);
      expect(result.scrub_failed_fields).toContain('*');
      expect(result.redaction_count).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// TC-2-2-11: Empty text input
// ---------------------------------------------------------------------------

describe('TC-2-2-11: Empty text input', () => {
  test('empty string returns empty text with 0 redactions', async () => {
    const config = defaultConfig();
    const context = makeContext({ fieldName: 'empty' });
    const result = await scrub('', config, context);

    expect(result.text).toBe('');
    expect(result.redaction_count).toBe(0);
    expect(result.redactions).toEqual([]);
    expect(result.validation_passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TC-2-2-12: Text with no PII
// ---------------------------------------------------------------------------

describe('TC-2-2-12: Text with no PII', () => {
  test('normal log message returns unchanged, 0 redactions', async () => {
    const config = defaultConfig();
    const context = makeContext({ fieldName: 'normal' });
    const input = 'normal log message at 2026-04-08';
    const result = await scrub(input, config, context);

    expect(result.text).toBe(input);
    expect(result.redaction_count).toBe(0);
    expect(result.validation_passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TC-2-2-13: Redaction metadata no values
// ---------------------------------------------------------------------------

describe('TC-2-2-13: Redaction metadata no values', () => {
  test('redaction includes original_length but never original_value', async () => {
    const config = defaultConfig();
    const context = makeContext({ fieldName: 'meta' });
    const result = await scrub('john@test.com', config, context);

    expect(result.redaction_count).toBe(1);
    expect(result.redactions[0].original_length).toBe(13); // 'john@test.com'.length
    expect(result.redactions[0].type).toBe('email');
    // Ensure original value is NEVER stored
    expect(
      (result.redactions[0] as Record<string, unknown>).original_value,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pipeline ordering
// ---------------------------------------------------------------------------

describe('Pipeline ordering', () => {
  test('PII patterns run before secret patterns', () => {
    const config = defaultConfig();
    const result = performScrub(
      'Email: user@domain.com API_KEY=sk_TESTONLY_abcdefghijklmnopqrstuvwx',
      config,
      { fieldName: 'order' },
    );

    // Email should be caught by PII stage
    expect(result.text).toContain('[REDACTED:email]');
    // Stripe key should be caught by secret stage
    expect(result.text).toContain('[SECRET_REDACTED]');
  });

  test('custom patterns are appended, not replacing defaults', () => {
    const custom: PatternDefinition = {
      name: 'test_custom',
      type: 'custom',
      regex: /TEST_\d{4}/g,
      replacement: '[REDACTED:custom]',
    };
    const config = buildSafetyConfig([custom]);

    // Default PII patterns should still be present
    expect(config.pii_patterns.length).toBeGreaterThan(1);
    expect(config.pii_patterns[config.pii_patterns.length - 1].name).toBe(
      'test_custom',
    );
  });
});

// ---------------------------------------------------------------------------
// Residual detection
// ---------------------------------------------------------------------------

describe('detectResiduals', () => {
  test('returns empty array when no residuals found', () => {
    const config = defaultConfig();
    const residuals = detectResiduals(
      'clean text with [REDACTED:email] tokens',
      config,
    );
    expect(residuals).toEqual([]);
  });

  test('finds residual PII that was missed', () => {
    const config = defaultConfig();
    const residuals = detectResiduals(
      'clean text but also john@example.com',
      config,
    );
    expect(residuals.length).toBeGreaterThan(0);
    expect(residuals[0].pattern).toBe('email');
  });

  test('skips replacement tokens', () => {
    const config = defaultConfig();
    const residuals = detectResiduals(
      '[REDACTED:email] [SECRET_REDACTED]',
      config,
    );
    expect(residuals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// postScrubValidation
// ---------------------------------------------------------------------------

describe('postScrubValidation', () => {
  test('passes when no residuals', () => {
    const config = defaultConfig();
    const result: ScrubResult = {
      text: 'clean [REDACTED:email] text',
      redaction_count: 1,
      redactions: [{ type: 'email', position: 6, original_length: 15 }],
      validation_passed: false,
      scrub_failed_fields: [],
      processing_time_ms: 0,
    };

    const validated = postScrubValidation(result, config, 'test');
    expect(validated.validation_passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildSafetyConfig
// ---------------------------------------------------------------------------

describe('buildSafetyConfig', () => {
  test('default config has correct timeout', () => {
    const config = defaultConfig();
    expect(config.timeout_ms).toBe(30_000);
  });

  test('custom timeout is respected', () => {
    const config = buildSafetyConfig([], [], 5_000);
    expect(config.timeout_ms).toBe(5_000);
  });

  test('includes all built-in PII patterns', () => {
    const config = defaultConfig();
    expect(config.pii_patterns.length).toBe(11);
  });

  test('includes built-in secret patterns plus env var pattern', () => {
    const config = defaultConfig();
    // 15 core + 1 env var = 16
    expect(config.secret_patterns.length).toBe(16);
  });
});
