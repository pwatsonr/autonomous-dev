/**
 * Tests for Secret Detector (Stage 2 of Data Safety Pipeline).
 *
 * Per-pattern positive, negative, and edge-case tests.
 * Covers SPEC-007-2-1 test cases TC-2-1-20 through TC-2-1-35.
 */

import {
  detectSecrets,
  SECRET_PATTERNS,
  ENV_VAR_PATTERN,
} from '../../src/safety/secret-detector';
import type { PatternDefinition } from '../../src/safety/types';

// ---------------------------------------------------------------------------
// AWS patterns
// ---------------------------------------------------------------------------

describe('Secret: aws_access_key', () => {
  test('TC-2-1-20: AWS access key', () => {
    const result = detectSecrets('key=AKIAIOSFODNN7EXAMPLE');
    expect(result.text).toBe('key=[SECRET_REDACTED]');
    expect(result.redactions.some(r => r.patternName === 'aws_access_key')).toBe(true);
  });

  test('partial AKIA prefix not matched', () => {
    const result = detectSecrets('key=AKIA123');
    // Only 3 chars after AKIA, need 16
    expect(result.redactions.filter(r => r.patternName === 'aws_access_key').length).toBe(0);
  });
});

describe('Secret: aws_secret_key', () => {
  test('TC-2-1-21: AWS secret key', () => {
    const result = detectSecrets(
      'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    );
    expect(result.text).toContain('[SECRET_REDACTED]');
    expect(result.redactions.some(r => r.patternName === 'aws_secret_key')).toBe(true);
  });

  test('case insensitive matching', () => {
    const result = detectSecrets(
      'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    );
    expect(result.text).toContain('[SECRET_REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// Stripe patterns
// ---------------------------------------------------------------------------

describe('Secret: stripe_secret', () => {
  test('TC-2-1-22: Stripe secret key', () => {
    const result = detectSecrets('sk_TESTONLY_abc123def456ghi789jkl012mnop');
    expect(result.text).toBe('[SECRET_REDACTED]');
    expect(result.redactions.some(r => r.patternName === 'stripe_secret')).toBe(true);
  });

  test('Stripe test key not matched (sk_TESTONLY_)', () => {
    const result = detectSecrets('sk_TESTONLY_abc123def456ghi789jkl012');
    expect(result.redactions.filter(r => r.patternName === 'stripe_secret').length).toBe(0);
  });
});

describe('Secret: stripe_publishable', () => {
  test('Stripe publishable key', () => {
    const result = detectSecrets('pk_TESTONLY_abc123def456ghi789jkl012mnop');
    expect(result.text).toBe('[SECRET_REDACTED]');
    expect(result.redactions.some(r => r.patternName === 'stripe_publishable')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GitHub patterns
// ---------------------------------------------------------------------------

describe('Secret: github_pat', () => {
  test('TC-2-1-23: GitHub PAT', () => {
    const result = detectSecrets('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij');
    expect(result.text).toBe('[SECRET_REDACTED]');
    expect(result.redactions.some(r => r.patternName === 'github_pat')).toBe(true);
  });

  test('too short GitHub PAT not matched', () => {
    const result = detectSecrets('ghp_short');
    expect(result.redactions.filter(r => r.patternName === 'github_pat').length).toBe(0);
  });
});

describe('Secret: github_app', () => {
  test('GitHub App token', () => {
    const result = detectSecrets('ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij');
    expect(result.text).toBe('[SECRET_REDACTED]');
  });
});

describe('Secret: github_oauth', () => {
  test('GitHub OAuth token', () => {
    const result = detectSecrets('gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij');
    expect(result.text).toBe('[SECRET_REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// GitLab pattern
// ---------------------------------------------------------------------------

describe('Secret: gitlab_pat', () => {
  test('TC-2-1-24: GitLab PAT', () => {
    const result = detectSecrets('glpat-abc123def456ghi789jk');
    expect(result.text).toBe('[SECRET_REDACTED]');
    expect(result.redactions.some(r => r.patternName === 'gitlab_pat')).toBe(true);
  });

  test('GitLab PAT with hyphens', () => {
    const result = detectSecrets('glpat-abc-123-def-456-ghi-789');
    expect(result.text).toBe('[SECRET_REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// GCP patterns
// ---------------------------------------------------------------------------

describe('Secret: gcp_service_account', () => {
  test('GCP service account private key header', () => {
    const result = detectSecrets('"private_key": "-----BEGIN RSA PRIVATE KEY-----');
    expect(result.text).toContain('[SECRET_REDACTED]');
  });
});

describe('Secret: gcp_api_key', () => {
  test('TC-2-1-25: GCP API key', () => {
    const result = detectSecrets('AIzaSyA1234567890abcdefghijklmnopqrstuv');
    expect(result.text).toBe('[SECRET_REDACTED]');
    expect(result.redactions.some(r => r.patternName === 'gcp_api_key')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Slack patterns
// ---------------------------------------------------------------------------

describe('Secret: slack_bot_token', () => {
  test('TC-2-1-26: Slack bot token', () => {
    const result = detectSecrets('xoxb-FAKE-0000000-ABCDEFGHIJKLMNOPQRSTUVWXyz');
    expect(result.text).toBe('[SECRET_REDACTED]');
    expect(result.redactions.some(r => r.patternName === 'slack_bot_token')).toBe(true);
  });
});

describe('Secret: slack_webhook', () => {
  test('TC-2-1-27: Slack webhook URL', () => {
    const result = detectSecrets(
      'https://hooks.slack.com/services/T12345/B67890/abcdef123456',
    );
    expect(result.text).toBe('[SECRET_REDACTED]');
    expect(result.redactions.some(r => r.patternName === 'slack_webhook')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auth patterns
// ---------------------------------------------------------------------------

describe('Secret: generic_bearer', () => {
  test('TC-2-1-28: Bearer token', () => {
    const result = detectSecrets(
      'Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.abc.def',
    );
    expect(result.text).toBe('Authorization: [SECRET_REDACTED]');
    expect(result.redactions.some(r => r.patternName === 'generic_bearer')).toBe(true);
  });

  test('case insensitive Bearer', () => {
    const result = detectSecrets('BEARER sometoken123');
    expect(result.text).toBe('[SECRET_REDACTED]');
  });
});

describe('Secret: basic_auth', () => {
  test('TC-2-1-29: Basic auth', () => {
    const result = detectSecrets('Authorization: Basic dXNlcjpwYXNz');
    expect(result.text).toBe('Authorization: [SECRET_REDACTED]');
    expect(result.redactions.some(r => r.patternName === 'basic_auth')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Private key block
// ---------------------------------------------------------------------------

describe('Secret: private_key_block', () => {
  test('TC-2-1-30: RSA private key block', () => {
    const result = detectSecrets('-----BEGIN RSA PRIVATE KEY-----');
    expect(result.text).toBe('[SECRET_REDACTED]');
    expect(result.redactions.some(r => r.patternName === 'private_key_block')).toBe(true);
  });

  test('EC private key block', () => {
    const result = detectSecrets('-----BEGIN EC PRIVATE KEY-----');
    expect(result.text).toBe('[SECRET_REDACTED]');
  });

  test('generic private key block', () => {
    const result = detectSecrets('-----BEGIN PRIVATE KEY-----');
    expect(result.text).toBe('[SECRET_REDACTED]');
  });

  test('public key not matched', () => {
    const input = '-----BEGIN PUBLIC KEY-----';
    const result = detectSecrets(input);
    expect(result.redactions.filter(r => r.patternName === 'private_key_block').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// High-entropy detection (integrated through detectSecrets)
// ---------------------------------------------------------------------------

describe('Secret: high entropy detection', () => {
  test('TC-2-1-31: high entropy in password context', () => {
    const result = detectSecrets('password=aB3$xY9!kL2@mN5^pQ8&rT1');
    expect(result.text).toContain('[SECRET_REDACTED]');
  });

  test('TC-2-1-32: low entropy not flagged', () => {
    const result = detectSecrets('password=aaaaaaaaaaaaaaaaaaaaaa');
    // The env var pattern may match here since it ends with _PASSWORD-like patterns
    // but the entropy detector should NOT flag it
    expect(result.redactions.filter(r => r.patternName === 'high_entropy').length).toBe(0);
  });

  test('TC-2-1-33: high entropy without context not flagged', () => {
    const input = 'random_data aB3$xY9!kL2@mN5^pQ8&rT1';
    const result = detectSecrets(input);
    expect(result.redactions.filter(r => r.patternName === 'high_entropy').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Environment variable pattern
// ---------------------------------------------------------------------------

describe('Secret: env_var', () => {
  test('TC-2-1-34: env var pattern', () => {
    const result = detectSecrets('MY_SECRET_KEY=super-secret-value123');
    expect(result.text).toBe('MY_SECRET_KEY=[SECRET_REDACTED]');
  });

  test('TC-2-1-35: env var preserves name with colon', () => {
    const result = detectSecrets('DATABASE_PASSWORD: hunter2');
    expect(result.text).toBe('DATABASE_PASSWORD:[SECRET_REDACTED]');
  });

  test('env var with _TOKEN suffix', () => {
    const result = detectSecrets('API_TOKEN=mytoken12345');
    expect(result.text).toBe('API_TOKEN=[SECRET_REDACTED]');
  });

  test('env var with _SECRET suffix', () => {
    const result = detectSecrets('APP_SECRET=secretvalue');
    expect(result.text).toBe('APP_SECRET=[SECRET_REDACTED]');
  });

  test('non-secret env var not matched', () => {
    const input = 'MY_CONFIG=some_value';
    const result = detectSecrets(input);
    // No _KEY, _SECRET, _TOKEN, or _PASSWORD suffix
    expect(result.redactions.filter(r => r.patternName === 'env_var').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Custom patterns
// ---------------------------------------------------------------------------

describe('Custom patterns', () => {
  test('custom pattern applied between built-in and env var patterns', () => {
    const customPattern: PatternDefinition = {
      name: 'custom_api',
      type: 'secret',
      regex: /myapi_[a-z0-9]{16}/g,
      replacement: '[SECRET_REDACTED]',
    };
    const result = detectSecrets(
      'token: myapi_abcdef1234567890',
      [customPattern],
    );
    expect(result.text).toContain('[SECRET_REDACTED]');
    expect(result.redactions.some(r => r.patternName === 'custom_api')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('Secret detector integration', () => {
  test('multiple secret types in one string', () => {
    const input = [
      'key=AKIAIOSFODNN7EXAMPLE',
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',
      '-----BEGIN RSA PRIVATE KEY-----',
    ].join('\n');
    const result = detectSecrets(input);
    expect(result.redactionCount).toBeGreaterThanOrEqual(3);
    const patternNames = result.redactions.map(r => r.patternName);
    expect(patternNames).toContain('aws_access_key');
    expect(patternNames).toContain('github_pat');
    expect(patternNames).toContain('private_key_block');
  });

  test('empty string returns empty result', () => {
    const result = detectSecrets('');
    expect(result.text).toBe('');
    expect(result.redactionCount).toBe(0);
    expect(result.redactions).toEqual([]);
  });

  test('string with no secrets returns unchanged', () => {
    const input = 'Hello world, this is a safe message with no secrets.';
    const result = detectSecrets(input);
    expect(result.text).toBe(input);
    expect(result.redactionCount).toBe(0);
  });

  test('all 15 pattern names are present', () => {
    const names = SECRET_PATTERNS.map(p => p.name);
    expect(names).toEqual([
      'aws_access_key',
      'aws_secret_key',
      'stripe_secret',
      'stripe_publishable',
      'github_pat',
      'github_app',
      'github_oauth',
      'gitlab_pat',
      'gcp_service_account',
      'gcp_api_key',
      'slack_bot_token',
      'slack_webhook',
      'generic_bearer',
      'basic_auth',
      'private_key_block',
    ]);
  });

  test('all patterns have global flag', () => {
    for (const pattern of SECRET_PATTERNS) {
      expect(pattern.regex.flags).toContain('g');
    }
  });

  test('env var pattern has global flag', () => {
    expect(ENV_VAR_PATTERN.regex.flags).toContain('g');
  });

  test('env var pattern has replaceFunc', () => {
    expect(typeof ENV_VAR_PATTERN.replaceFunc).toBe('function');
  });

  test('all secret patterns use [SECRET_REDACTED] replacement', () => {
    for (const pattern of SECRET_PATTERNS) {
      expect(pattern.replacement).toBe('[SECRET_REDACTED]');
    }
  });

  test('redaction records include patternName', () => {
    const result = detectSecrets('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij');
    expect(result.redactions[0].patternName).toBeDefined();
  });
});
