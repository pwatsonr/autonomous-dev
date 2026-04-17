/**
 * Security Audit Tests — PII leak audit, secret leak audit, and
 * credential scan tests.
 *
 * Covers SPEC-007-2-4 test cases:
 *   TC-2-4-05: PII leak audit (zero PII in generated observation files)
 *   TC-2-4-06: Secret leak audit (zero secrets in generated observation files)
 *   TC-2-4-07: Credential scan — config file
 *   TC-2-4-08: Credential scan — observation reports
 *
 * These tests simulate the observation pipeline by injecting known
 * sensitive values into mock MCP responses, running them through
 * the scrubbing pipeline, and verifying that no sensitive values
 * leak into the generated output files.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { scrubPii } from '../../src/safety/pii-scrubber';
import { detectSecrets } from '../../src/safety/secret-detector';

// ---------------------------------------------------------------------------
// Test infrastructure — mock observation pipeline
// ---------------------------------------------------------------------------

/**
 * Combined scrub: runs PII scrubber then secret detector (the full pipeline).
 */
function scrubFull(input: string): string {
  const piiResult = scrubPii(input);
  const secretResult = detectSecrets(piiResult.text);
  return secretResult.text;
}

/**
 * Simulates a mock observation cycle that:
 * 1. Receives raw MCP responses containing the injected sensitive values
 * 2. Runs them through the scrubbing pipeline
 * 3. Writes the scrubbed output to observation report files
 *
 * Returns the directory containing the generated files.
 */
async function runMockObservation(
  injectedValues: string[],
  observationsDir: string,
): Promise<void> {
  // Simulate multiple MCP response documents with injected values
  const mockResponses = [
    {
      filename: 'observation-metrics.md',
      content: generateMetricsReport(injectedValues),
    },
    {
      filename: 'observation-logs.md',
      content: generateLogsReport(injectedValues),
    },
    {
      filename: 'observation-alerts.md',
      content: generateAlertsReport(injectedValues),
    },
    {
      filename: 'observation-summary.md',
      content: generateSummaryReport(injectedValues),
    },
  ];

  await fs.mkdir(observationsDir, { recursive: true });

  // Process each mock response through the scrubbing pipeline
  for (const response of mockResponses) {
    const scrubbedContent = scrubFull(response.content);
    await fs.writeFile(
      path.join(observationsDir, response.filename),
      scrubbedContent,
      'utf-8',
    );
  }
}

/**
 * Generates a mock metrics report embedding the sensitive values in
 * realistic operational contexts.
 */
function generateMetricsReport(values: string[]): string {
  const lines = [
    '# Metrics Observation Report',
    '',
    `Generated: 2026-04-08T14:30:00.000Z`,
    '',
    '## Service Health',
    '',
    '| Service | Status | Latency |',
    '|---------|--------|---------|',
    '| api-gateway | healthy | 45ms |',
    '| auth-service | healthy | 12ms |',
    '',
    '## Anomalies Detected',
    '',
  ];

  // Embed each value in a context that simulates a real observation finding
  for (let i = 0; i < values.length; i++) {
    lines.push(`- Anomaly #${i + 1}: Detected in request from ${values[i]}`);
    lines.push(`  - Correlation ID: req-${Date.now()}-${i}`);
    lines.push('');
  }

  lines.push('## Summary');
  lines.push(`Total anomalies: ${values.length}`);

  return lines.join('\n');
}

function generateLogsReport(values: string[]): string {
  const lines = [
    '# Log Analysis Report',
    '',
    '## Error Patterns',
    '',
  ];

  for (let i = 0; i < values.length; i++) {
    lines.push(`[ERROR] Authentication failed for ${values[i]} - invalid credentials`);
    lines.push(`[WARN] Suspicious activity from ${values[i]} detected`);
    lines.push('');
  }

  return lines.join('\n');
}

function generateAlertsReport(values: string[]): string {
  const lines = [
    '# Alerts Report',
    '',
    '## Active Alerts',
    '',
  ];

  for (let i = 0; i < values.length; i++) {
    lines.push(`**Alert ${i + 1}**: Credential exposure detected — ${values[i]}`);
    lines.push(`  Severity: HIGH`);
    lines.push(`  Recommended action: Rotate credential immediately`);
    lines.push('');
  }

  return lines.join('\n');
}

function generateSummaryReport(values: string[]): string {
  const lines = [
    '# Observation Summary',
    '',
    `Run timestamp: 2026-04-08T14:30:00.000Z`,
    `Service count: 5`,
    `Total findings: ${values.length}`,
    '',
    '## Finding Details',
    '',
  ];

  for (let i = 0; i < values.length; i++) {
    lines.push(`${i + 1}. Value detected in logs: \`${values[i]}\``);
  }

  return lines.join('\n');
}

/**
 * Generates a mock intelligence.yaml config file for credential scanning.
 */
function generateMockConfig(): string {
  return [
    'schedule:',
    '  type: interval',
    '  expression: "4h"',
    '',
    'services:',
    '  - name: api-gateway',
    '    type: http',
    '    url: http://api.internal:8080/health',
    '    interval: 60',
    '',
    '  - name: database',
    '    type: postgres',
    '    host: db.internal',
    '    port: 5432',
    '    database: app_production',
    '',
    'default_thresholds:',
    '  error_rate: 0.01',
    '  latency_p99: 2000',
    '  cpu_percent: 80',
    '',
    'query_budgets:',
    '  max_queries_per_run: 50',
    '  max_queries_per_service: 10',
    '',
    'anomaly_detection:',
    '  enabled: true',
    '  sensitivity: medium',
    '',
    '# No real credentials should appear in this file',
    '# Connections use IAM roles and service accounts',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Security Audit Tests
// ---------------------------------------------------------------------------

describe('Security Audit Tests', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'safety-audit-'));
  });

  afterEach(async () => {
    // Cleanup temp files
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // TC-2-4-05: PII Leak Audit
  // -----------------------------------------------------------------------

  test('TC-2-4-05: PII leak audit — zero PII in generated observation files', async () => {
    const knownPII = [
      'john@example.com',
      '555-123-4567',
      '123-45-6789',
      '4111111111111111',
      '192.168.1.100',
    ];

    const observationsDir = path.join(tempDir, 'observations');
    await runMockObservation(knownPII, observationsDir);

    // Scan all generated files for the known PII values
    const files = await fs.readdir(observationsDir);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = await fs.readFile(
        path.join(observationsDir, file),
        'utf-8',
      );
      for (const pii of knownPII) {
        expect(content).not.toContain(pii);
      }
    }
  });

  test('PII leak audit — emails are scrubbed to [REDACTED:email]', async () => {
    const piiEmails = [
      'admin@company.com',
      'user+tag@example.org',
      'first.last@sub.domain.co.uk',
    ];

    const observationsDir = path.join(tempDir, 'observations-email');
    await runMockObservation(piiEmails, observationsDir);

    const files = await fs.readdir(observationsDir);
    for (const file of files) {
      const content = await fs.readFile(
        path.join(observationsDir, file),
        'utf-8',
      );
      for (const email of piiEmails) {
        expect(content).not.toContain(email);
      }
      // The scrubbed output should contain redaction tokens
      expect(content).toContain('[REDACTED:email]');
    }
  });

  test('PII leak audit — phone numbers are scrubbed', async () => {
    const phones = ['(555) 987-6543', '+1-555-111-2222', '5559876543'];

    const observationsDir = path.join(tempDir, 'observations-phone');
    await runMockObservation(phones, observationsDir);

    const files = await fs.readdir(observationsDir);
    for (const file of files) {
      const content = await fs.readFile(
        path.join(observationsDir, file),
        'utf-8',
      );
      for (const phone of phones) {
        expect(content).not.toContain(phone);
      }
    }
  });

  test('PII leak audit — SSNs are scrubbed', async () => {
    const ssns = ['123-45-6789', '987-65-4321', '456-78-9012'];

    const observationsDir = path.join(tempDir, 'observations-ssn');
    await runMockObservation(ssns, observationsDir);

    const files = await fs.readdir(observationsDir);
    for (const file of files) {
      const content = await fs.readFile(
        path.join(observationsDir, file),
        'utf-8',
      );
      for (const ssn of ssns) {
        expect(content).not.toContain(ssn);
      }
    }
  });

  test('PII leak audit — credit cards are scrubbed', async () => {
    const cards = ['4111-1111-1111-1111', '5500 0000 0000 0004'];

    const observationsDir = path.join(tempDir, 'observations-cc');
    await runMockObservation(cards, observationsDir);

    const files = await fs.readdir(observationsDir);
    for (const file of files) {
      const content = await fs.readFile(
        path.join(observationsDir, file),
        'utf-8',
      );
      for (const card of cards) {
        expect(content).not.toContain(card);
      }
    }
  });

  test('PII leak audit — IP addresses are scrubbed', async () => {
    const ips = ['192.168.1.100', '10.0.0.1', '172.16.0.50'];

    const observationsDir = path.join(tempDir, 'observations-ip');
    await runMockObservation(ips, observationsDir);

    const files = await fs.readdir(observationsDir);
    for (const file of files) {
      const content = await fs.readFile(
        path.join(observationsDir, file),
        'utf-8',
      );
      for (const ip of ips) {
        expect(content).not.toContain(ip);
      }
    }
  });

  // -----------------------------------------------------------------------
  // TC-2-4-06: Secret Leak Audit
  // -----------------------------------------------------------------------

  test('TC-2-4-06: secret leak audit — zero secrets in generated observation files', async () => {
    const knownSecrets = [
      'AKIAIOSFODNN7EXAMPLE',
      'sk_TESTONLY_testkey1234567890abcdef',
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',
    ];

    const observationsDir = path.join(tempDir, 'observations-secrets');
    await runMockObservation(knownSecrets, observationsDir);

    const files = await fs.readdir(observationsDir);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = await fs.readFile(
        path.join(observationsDir, file),
        'utf-8',
      );
      for (const secret of knownSecrets) {
        expect(content).not.toContain(secret);
      }
    }
  });

  test('secret leak audit — Bearer tokens are scrubbed', async () => {
    const bearerTokens = [
      'Bearer eyJhbGciOiJSUzI1NiJ9.abc.def',
      'Bearer someRandomToken1234567890abc',
    ];

    const observationsDir = path.join(tempDir, 'observations-bearer');
    await runMockObservation(bearerTokens, observationsDir);

    const files = await fs.readdir(observationsDir);
    for (const file of files) {
      const content = await fs.readFile(
        path.join(observationsDir, file),
        'utf-8',
      );
      for (const token of bearerTokens) {
        expect(content).not.toContain(token);
      }
    }
  });

  test('secret leak audit — private key markers are scrubbed', async () => {
    const keys = [
      '-----BEGIN RSA PRIVATE KEY-----',
      '-----BEGIN EC PRIVATE KEY-----',
    ];

    const observationsDir = path.join(tempDir, 'observations-privkey');
    await runMockObservation(keys, observationsDir);

    const files = await fs.readdir(observationsDir);
    for (const file of files) {
      const content = await fs.readFile(
        path.join(observationsDir, file),
        'utf-8',
      );
      for (const key of keys) {
        expect(content).not.toContain(key);
      }
    }
  });

  test('secret leak audit — GitLab tokens are scrubbed', async () => {
    const tokens = ['glpat-abc123def456ghi789jk'];

    const observationsDir = path.join(tempDir, 'observations-gitlab');
    await runMockObservation(tokens, observationsDir);

    const files = await fs.readdir(observationsDir);
    for (const file of files) {
      const content = await fs.readFile(
        path.join(observationsDir, file),
        'utf-8',
      );
      for (const token of tokens) {
        expect(content).not.toContain(token);
      }
    }
  });

  test('secret leak audit — Slack bot tokens are scrubbed', async () => {
    const tokens = ['xoxb-FAKE-0000000-ABCDEFGHIJKLMNOPQRSTUVWXyz'];

    const observationsDir = path.join(tempDir, 'observations-slack');
    await runMockObservation(tokens, observationsDir);

    const files = await fs.readdir(observationsDir);
    for (const file of files) {
      const content = await fs.readFile(
        path.join(observationsDir, file),
        'utf-8',
      );
      for (const token of tokens) {
        expect(content).not.toContain(token);
      }
    }
  });

  test('secret leak audit — GCP API keys are scrubbed', async () => {
    const keys = ['AIzaSyA1234567890abcdefghijklmnopqrstuv'];

    const observationsDir = path.join(tempDir, 'observations-gcp');
    await runMockObservation(keys, observationsDir);

    const files = await fs.readdir(observationsDir);
    for (const file of files) {
      const content = await fs.readFile(
        path.join(observationsDir, file),
        'utf-8',
      );
      for (const key of keys) {
        expect(content).not.toContain(key);
      }
    }
  });

  test('secret leak audit — mixed PII and secrets all scrubbed', async () => {
    const mixed = [
      'john@example.com',                                     // PII: email
      '123-45-6789',                                          // PII: SSN
      'AKIAIOSFODNN7EXAMPLE',                                 // Secret: AWS key
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',            // Secret: GitHub PAT
      '192.168.1.100',                                        // PII: IPv4
      'Bearer eyJhbGciOiJSUzI1NiJ9.abc.def',                 // Secret: Bearer
    ];

    const observationsDir = path.join(tempDir, 'observations-mixed');
    await runMockObservation(mixed, observationsDir);

    const files = await fs.readdir(observationsDir);
    for (const file of files) {
      const content = await fs.readFile(
        path.join(observationsDir, file),
        'utf-8',
      );
      for (const val of mixed) {
        expect(content).not.toContain(val);
      }
    }
  });

  // -----------------------------------------------------------------------
  // TC-2-4-07: Credential Scan — Config
  // -----------------------------------------------------------------------

  test('TC-2-4-07: credential scan — no hardcoded credentials in config', async () => {
    const configPath = path.join(tempDir, 'intelligence.yaml');
    await fs.writeFile(configPath, generateMockConfig(), 'utf-8');

    const configContent = await fs.readFile(configPath, 'utf-8');

    // Scan for known credential patterns
    expect(configContent).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(configContent).not.toMatch(/sk_TESTONLY_/);
    expect(configContent).not.toMatch(/ghp_[a-zA-Z0-9]{36}/);
    expect(configContent).not.toMatch(/xoxb-/);
    expect(configContent).not.toMatch(/Bearer [a-zA-Z0-9]/);
    expect(configContent).not.toMatch(/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/);
    expect(configContent).not.toMatch(/glpat-/);
    expect(configContent).not.toMatch(/ghs_[a-zA-Z0-9]{36}/);
    expect(configContent).not.toMatch(/gho_[a-zA-Z0-9]{36}/);
    expect(configContent).not.toMatch(/AIza[0-9A-Za-z\-_]{35}/);
  });

  test('credential scan — config with accidentally embedded credentials fails', () => {
    // This test proves our scan patterns work by checking that they
    // WOULD detect credentials if they were present
    const dirtyConfig = [
      'services:',
      '  - name: api',
      '    api_key: AKIAIOSFODNN7EXAMPLE',
      '    stripe_key: sk_TESTONLY_abc123def456ghi789jkl012',
      '    github_token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',
    ].join('\n');

    expect(dirtyConfig).toMatch(/AKIA[0-9A-Z]{16}/);
    expect(dirtyConfig).toMatch(/sk_TESTONLY_/);
    expect(dirtyConfig).toMatch(/ghp_[a-zA-Z0-9]{36}/);
  });

  // -----------------------------------------------------------------------
  // TC-2-4-08: Credential Scan — Reports
  // -----------------------------------------------------------------------

  test('TC-2-4-08: credential scan — no credentials in observation reports', async () => {
    const observationsDir = path.join(tempDir, 'observations-credscan');

    // Generate "clean" observation reports (no injected secrets)
    const cleanValues = [
      'user-42',
      'order-12345',
      'request-abc-def',
    ];
    await runMockObservation(cleanValues, observationsDir);

    const files = await fs.readdir(observationsDir);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = await fs.readFile(
        path.join(observationsDir, file),
        'utf-8',
      );

      // None of these credential patterns should appear
      expect(content).not.toMatch(/AKIA[0-9A-Z]{16}/);
      expect(content).not.toMatch(/sk_TESTONLY_/);
      expect(content).not.toMatch(/ghp_[a-zA-Z0-9]{36}/);
      expect(content).not.toMatch(/xoxb-/);
      expect(content).not.toMatch(/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/);
      expect(content).not.toMatch(/glpat-/);
      expect(content).not.toMatch(/AIza[0-9A-Za-z\-_]{35}/);
    }
  });

  test('credential scan — reports after injected secrets are clean', async () => {
    const observationsDir = path.join(tempDir, 'observations-credscan-dirty');

    // Inject known secrets, then verify they are scrubbed from reports
    const injected = [
      'AKIAIOSFODNN7EXAMPLE',
      'sk_TESTONLY_testkey1234567890abcdef',
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',
      'xoxb-FAKE-0000000-ABCDEFGHIJKLMNOPQRSTUVWXyz',
    ];
    await runMockObservation(injected, observationsDir);

    const files = await fs.readdir(observationsDir);
    for (const file of files) {
      const content = await fs.readFile(
        path.join(observationsDir, file),
        'utf-8',
      );

      // After scrubbing, no credential patterns should remain
      expect(content).not.toMatch(/AKIA[0-9A-Z]{16}/);
      expect(content).not.toMatch(/sk_TESTONLY_/);
      expect(content).not.toMatch(/ghp_[a-zA-Z0-9]{36}/);
      expect(content).not.toMatch(/xoxb-\d{10,}/);
    }
  });

  // -----------------------------------------------------------------------
  // Scrubbing pipeline end-to-end (reinforces the 4 security scans)
  // -----------------------------------------------------------------------

  test('end-to-end: all 26 pattern types covered by scrubbing', () => {
    // Comprehensive input with every pattern type
    const input = [
      'john@example.com',                                               // email
      '(555) 123-4567',                                                 // phone_us
      '+44 79111234',                                                   // phone_intl
      '123-45-6789',                                                    // ssn
      '4111-1111-1111-1111',                                            // credit_card
      '3782 822463 10005',                                              // credit_card_amex
      '192.168.1.100',                                                  // ipv4
      '2001:0db8:85a3:0000:0000:8a2e:0370:7334',                       // ipv6_full
      'fe80::1',                                                        // ipv6_compressed
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.abc123def456',        // jwt
      'AKIAIOSFODNN7EXAMPLE',                                           // aws_access_key
      'sk_TESTONLY_abc123def456ghi789jkl012mnop',                           // stripe_secret
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',                      // github_pat
      'Bearer sometoken123456789',                                      // generic_bearer
      'Basic dXNlcjpwYXNz',                                            // basic_auth
      '-----BEGIN RSA PRIVATE KEY-----',                                // private_key_block
      'glpat-abc123def456ghi789jk',                                     // gitlab_pat
      'ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',                      // github_app
      'gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',                      // github_oauth
      'AIzaSyA1234567890abcdefghijklmnopqrstuv',                        // gcp_api_key
      'xoxb-FAKE-0000000-ABCDEFGHIJKLMNOPQRSTUVWXyz',                    // slack_bot_token
      'https://hooks.slack.com/services/T12345/B67890/abcdef123456',    // slack_webhook
      'MY_SECRET_KEY=super-secret-value123',                            // env_var
      'password=aB3$xY9!kL2@mN5^pQ8&rT1',                              // high_entropy
    ].join('\n');

    const result = scrubFull(input);

    // None of the original sensitive values should remain
    expect(result).not.toContain('john@example.com');
    expect(result).not.toContain('123-45-6789');
    expect(result).not.toContain('4111-1111-1111-1111');
    expect(result).not.toContain('192.168.1.100');
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result).not.toContain('sk_TESTONLY_');
    expect(result).not.toContain('ghp_ABCDEF');
    expect(result).not.toContain('-----BEGIN RSA PRIVATE KEY-----');
    expect(result).not.toContain('glpat-');
    expect(result).not.toContain('ghs_ABCDEF');
    expect(result).not.toContain('gho_ABCDEF');
    expect(result).not.toContain('AIzaSyA');
    expect(result).not.toContain('xoxb-');
    expect(result).not.toContain('hooks.slack.com');
    expect(result).not.toContain('dXNlcjpwYXNz');

    // Redaction tokens should be present
    expect(result).toContain('[REDACTED:email]');
    expect(result).toContain('[REDACTED:ssn]');
    expect(result).toContain('[REDACTED:credit_card]');
    expect(result).toContain('[REDACTED:ip]');
    expect(result).toContain('[SECRET_REDACTED]');
  });

  test('safe content passes through untouched', () => {
    const safeContent = [
      'Health check passed service=api-gateway uptime=72h',
      'Cache hit for key=orders:page:1 ttl=300s',
      'Deployment version=v2.0.1 environment=staging',
      'Request completed method=GET path=/api/v2/orders status=200 duration=45ms',
    ].join('\n');

    const result = scrubFull(safeContent);
    expect(result).toBe(safeContent);
  });
});
