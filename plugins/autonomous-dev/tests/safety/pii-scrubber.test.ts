/**
 * Tests for PII Scrubber (Stage 1 of Data Safety Pipeline).
 *
 * Per-pattern positive, negative, and edge-case tests.
 * Covers SPEC-007-2-1 test cases TC-2-1-01 through TC-2-1-18.
 */

import { scrubPii, PII_PATTERNS } from '../../src/safety/pii-scrubber';
import type { PatternDefinition } from '../../src/safety/types';

// ---------------------------------------------------------------------------
// Email pattern
// ---------------------------------------------------------------------------

describe('PII: email', () => {
  test('TC-2-1-01: basic email', () => {
    const result = scrubPii('user john@example.com logged in');
    expect(result.text).toBe('user [REDACTED:email] logged in');
    expect(result.redactionCount).toBe(1);
    expect(result.redactions[0].type).toBe('email');
  });

  test('TC-2-1-02: email with plus addressing', () => {
    const result = scrubPii('user john+tag@example.com');
    expect(result.text).toBe('user [REDACTED:email]');
    expect(result.redactionCount).toBe(1);
  });

  test('TC-2-1-03: non-email preserved', () => {
    const result = scrubPii('version 2.0 is ready');
    expect(result.text).toBe('version 2.0 is ready');
    expect(result.redactionCount).toBe(0);
  });

  test('email with dots in local part', () => {
    const result = scrubPii('contact first.last@example.co.uk');
    expect(result.text).toBe('contact [REDACTED:email]');
    expect(result.redactionCount).toBe(1);
  });

  test('email with underscores and hyphens', () => {
    const result = scrubPii('send to user_name-123@sub-domain.example.com');
    expect(result.text).toBe('send to [REDACTED:email]');
  });

  test('multiple emails in one string', () => {
    const result = scrubPii('from alice@a.com to bob@b.com');
    expect(result.text).toBe('from [REDACTED:email] to [REDACTED:email]');
    expect(result.redactionCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Phone patterns
// ---------------------------------------------------------------------------

describe('PII: phone_us', () => {
  test('TC-2-1-04: US phone with parentheses', () => {
    const result = scrubPii('call (555) 123-4567');
    expect(result.text).toBe('call [REDACTED:phone]');
    expect(result.redactionCount).toBe(1);
    expect(result.redactions[0].type).toBe('phone');
  });

  test('TC-2-1-05: US phone plain 10 digits', () => {
    const result = scrubPii('5551234567');
    expect(result.text).toBe('[REDACTED:phone]');
  });

  test('US phone with dashes', () => {
    const result = scrubPii('555-123-4567');
    expect(result.text).toBe('[REDACTED:phone]');
  });

  test('US phone with dots', () => {
    const result = scrubPii('555.123.4567');
    expect(result.text).toBe('[REDACTED:phone]');
  });

  test('US phone with country code', () => {
    const result = scrubPii('+1 555-123-4567');
    expect(result.text).toBe('[REDACTED:phone]');
  });

  test('TC-2-1-07: port number not treated as phone', () => {
    const result = scrubPii('listening on port 8080');
    expect(result.text).toBe('listening on port 8080');
    expect(result.redactionCount).toBe(0);
  });
});

describe('PII: phone_intl', () => {
  test('TC-2-1-06: international phone', () => {
    const result = scrubPii('+44 7911 123456');
    expect(result.text).toContain('[REDACTED:phone]');
    expect(result.redactions.some(r => r.type === 'phone')).toBe(true);
  });

  test('international phone with country code +49', () => {
    const result = scrubPii('+49 30 12345678');
    expect(result.text).toContain('[REDACTED:phone]');
  });
});

// ---------------------------------------------------------------------------
// SSN pattern
// ---------------------------------------------------------------------------

describe('PII: ssn', () => {
  test('TC-2-1-08: SSN', () => {
    const result = scrubPii('ssn: 123-45-6789');
    expect(result.text).toBe('ssn: [REDACTED:ssn]');
    expect(result.redactionCount).toBe(1);
    expect(result.redactions[0].type).toBe('ssn');
  });

  test('TC-2-1-09: date not treated as SSN', () => {
    const result = scrubPii('date: 2026-04-08');
    // 2026-04-08 is yyyy-mm-dd, not 3-2-4 format
    expect(result.text).toBe('date: 2026-04-08');
  });

  test('SSN embedded in text', () => {
    const result = scrubPii('My SSN is 987-65-4321 please protect it');
    expect(result.text).toBe('My SSN is [REDACTED:ssn] please protect it');
  });
});

// ---------------------------------------------------------------------------
// Credit card patterns
// ---------------------------------------------------------------------------

describe('PII: credit_card', () => {
  test('TC-2-1-10: Visa credit card with dashes', () => {
    const result = scrubPii('card 4111-1111-1111-1111');
    expect(result.text).toBe('card [REDACTED:credit_card]');
    expect(result.redactions[0].type).toBe('credit_card');
  });

  test('credit card with spaces', () => {
    const result = scrubPii('card 4111 1111 1111 1111');
    expect(result.text).toBe('card [REDACTED:credit_card]');
  });

  test('credit card with no separators', () => {
    const result = scrubPii('card 4111111111111111');
    expect(result.text).toBe('card [REDACTED:credit_card]');
  });
});

describe('PII: credit_card_amex', () => {
  test('TC-2-1-11: Amex credit card', () => {
    const result = scrubPii('card 3782 822463 10005');
    expect(result.text).toBe('card [REDACTED:credit_card]');
    expect(result.redactions.some(r => r.type === 'credit_card')).toBe(true);
  });

  test('Amex with dashes', () => {
    const result = scrubPii('card 3782-822463-10005');
    expect(result.text).toBe('card [REDACTED:credit_card]');
  });
});

// ---------------------------------------------------------------------------
// IP address patterns
// ---------------------------------------------------------------------------

describe('PII: ipv4', () => {
  test('TC-2-1-12: IPv4 address', () => {
    const result = scrubPii('from 192.168.1.100');
    expect(result.text).toBe('from [REDACTED:ip]');
    expect(result.redactions[0].type).toBe('ip');
  });

  test('localhost IPv4', () => {
    const result = scrubPii('connect to 127.0.0.1');
    expect(result.text).toBe('connect to [REDACTED:ip]');
  });

  test('multiple IPv4 addresses', () => {
    const result = scrubPii('from 10.0.0.1 to 10.0.0.2');
    expect(result.text).toBe('from [REDACTED:ip] to [REDACTED:ip]');
    expect(result.redactionCount).toBe(2);
  });
});

describe('PII: ipv6_full', () => {
  test('TC-2-1-13: full IPv6 address', () => {
    const result = scrubPii('addr 2001:0db8:85a3:0000:0000:8a2e:0370:7334');
    expect(result.text).toBe('addr [REDACTED:ip]');
    expect(result.redactions[0].type).toBe('ip');
  });
});

describe('PII: ipv6_compressed', () => {
  test('TC-2-1-14: compressed IPv6 address', () => {
    const result = scrubPii('addr fe80::1');
    expect(result.text).toBe('addr [REDACTED:ip]');
  });

  test('TC-2-1-15: timestamp not treated as IPv6', () => {
    const result = scrubPii('time 14:30:22');
    expect(result.text).toBe('time 14:30:22');
  });

  test('ISO 8601 time not treated as IPv6', () => {
    const result = scrubPii('time 10:00:00.000');
    expect(result.text).toBe('time 10:00:00.000');
  });

  test('HH:MM timestamp not treated as IPv6', () => {
    const result = scrubPii('starts at 14:30');
    // 14:30 has only one colon, which should have fewer than 2 groups
    // The regex requires {2,7} groups, so "14:30" should not match
    expect(result.text).toBe('starts at 14:30');
  });
});

// ---------------------------------------------------------------------------
// JWT pattern
// ---------------------------------------------------------------------------

describe('PII: jwt', () => {
  test('TC-2-1-16: JWT token', () => {
    const result = scrubPii(
      'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.abc123def456',
    );
    expect(result.text).toBe('token [REDACTED:jwt]');
    expect(result.redactions[0].type).toBe('jwt');
  });

  test('JWT in Authorization header', () => {
    const result = scrubPii(
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature123',
    );
    expect(result.text).toContain('[REDACTED:jwt]');
  });

  test('non-JWT base64 not matched', () => {
    const result = scrubPii('data: dXNlcjpwYXNzd29yZA==');
    // Should not match JWT pattern (doesn't start with eyJ)
    expect(result.text).not.toContain('[REDACTED:jwt]');
  });
});

// ---------------------------------------------------------------------------
// UUID (user context) pattern
// ---------------------------------------------------------------------------

describe('PII: uuid_user_context', () => {
  test('TC-2-1-17: UUID in user_id context', () => {
    const result = scrubPii('user_id=550e8400-e29b-41d4-a716-446655440000');
    expect(result.text).toBe('user_id=[REDACTED:user_id]');
    expect(result.redactions[0].type).toBe('user_id');
  });

  test('TC-2-1-18: UUID in trace_id context preserved', () => {
    const result = scrubPii('trace_id=550e8400-e29b-41d4-a716-446655440000');
    expect(result.text).toBe('trace_id=550e8400-e29b-41d4-a716-446655440000');
  });

  test('UUID in customer_id context', () => {
    const result = scrubPii('customer_id=550e8400-e29b-41d4-a716-446655440000');
    expect(result.text).toBe('customer_id=[REDACTED:user_id]');
  });

  test('UUID in account_id context', () => {
    const result = scrubPii('account_id=550e8400-e29b-41d4-a716-446655440000');
    expect(result.text).toBe('account_id=[REDACTED:user_id]');
  });

  test('UUID in request_id context preserved', () => {
    const result = scrubPii('request_id=550e8400-e29b-41d4-a716-446655440000');
    expect(result.text).toBe('request_id=550e8400-e29b-41d4-a716-446655440000');
  });

  test('UUID in user_id with colon separator', () => {
    const result = scrubPii('user_id: 550e8400-e29b-41d4-a716-446655440000');
    expect(result.text).toBe('user_id: [REDACTED:user_id]');
  });
});

// ---------------------------------------------------------------------------
// Custom patterns
// ---------------------------------------------------------------------------

describe('Custom patterns', () => {
  test('custom pattern is applied after built-in patterns', () => {
    const customPattern: PatternDefinition = {
      name: 'custom_id',
      type: 'custom',
      regex: /CUST-\d{8}/g,
      replacement: '[REDACTED:custom]',
    };
    const result = scrubPii('customer CUST-12345678 logged in', [customPattern]);
    expect(result.text).toBe('customer [REDACTED:custom] logged in');
    expect(result.redactions.some(r => r.type === 'custom')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('PII scrubber integration', () => {
  test('multiple PII types in one string', () => {
    const input =
      'User john@example.com (SSN: 123-45-6789) called from 192.168.1.1';
    const result = scrubPii(input);
    expect(result.text).toContain('[REDACTED:email]');
    expect(result.text).toContain('[REDACTED:ssn]');
    expect(result.text).toContain('[REDACTED:ip]');
    expect(result.redactionCount).toBeGreaterThanOrEqual(3);
  });

  test('empty string returns empty result', () => {
    const result = scrubPii('');
    expect(result.text).toBe('');
    expect(result.redactionCount).toBe(0);
    expect(result.redactions).toEqual([]);
  });

  test('string with no PII returns unchanged', () => {
    const input = 'Hello world, this is a safe message.';
    const result = scrubPii(input);
    expect(result.text).toBe(input);
    expect(result.redactionCount).toBe(0);
  });

  test('all 11 pattern names are present', () => {
    const names = PII_PATTERNS.map(p => p.name);
    expect(names).toEqual([
      'email',
      'phone_us',
      'phone_intl',
      'ssn',
      'credit_card',
      'credit_card_amex',
      'ipv4',
      'ipv6_full',
      'ipv6_compressed',
      'jwt',
      'uuid_user_context',
    ]);
  });

  test('all patterns have global flag', () => {
    for (const pattern of PII_PATTERNS) {
      expect(pattern.regex.flags).toContain('g');
    }
  });

  test('redaction records include patternName', () => {
    const result = scrubPii('email: test@example.com');
    expect(result.redactions[0].patternName).toBe('email');
  });

  test('redaction records include position and length', () => {
    const result = scrubPii('email: test@example.com');
    const r = result.redactions[0];
    expect(typeof r.position).toBe('number');
    expect(r.position).toBeGreaterThanOrEqual(0);
    expect(r.original_length).toBeGreaterThan(0);
  });
});
