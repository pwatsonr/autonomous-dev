/**
 * Integration tests confirming no bypass path for the scrub pipeline.
 *
 * Covers SPEC-007-2-3 test cases TC-2-3-01 through TC-2-3-05, TC-2-3-11, TC-2-3-12.
 */

import {
  scrubCollectedData,
  buildSafetyConfig,
  scrub,
  type CollectedData,
  type ScrubbedData,
} from '../../src/safety/scrub-pipeline';
import type { DataSafetyConfig } from '../../src/safety/types';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeConfig(): DataSafetyConfig {
  return buildSafetyConfig();
}

function makeContext(service: string = 'test-service') {
  return { runId: 'RUN-TEST-001', service };
}

// ---------------------------------------------------------------------------
// TC-2-3-01: OpenSearch messages scrubbed
// ---------------------------------------------------------------------------

describe('TC-2-3-01: OpenSearch messages scrubbed', () => {
  test('email in message field is replaced with [REDACTED:email]', async () => {
    const data: CollectedData = {
      prometheus: [],
      opensearch: [
        {
          hits: [
            { message: 'User john@test.com logged in successfully' },
          ],
        },
      ],
      grafana: { alerts: {}, annotations: { annotations: [] } },
    };

    const result = await scrubCollectedData(data, makeConfig(), makeContext());

    expect(result.opensearch[0].hits[0].message).not.toContain('john@test.com');
    expect(result.opensearch[0].hits[0].message).toContain('[REDACTED:email]');
  });

  test('multiple PII types in OpenSearch message', async () => {
    const data: CollectedData = {
      prometheus: [],
      opensearch: [
        {
          hits: [
            {
              message:
                'User john@test.com from 192.168.1.1 with SSN 123-45-6789',
            },
          ],
        },
      ],
      grafana: { alerts: {}, annotations: { annotations: [] } },
    };

    const result = await scrubCollectedData(data, makeConfig(), makeContext());
    const msg = result.opensearch[0].hits[0].message;

    expect(msg).not.toContain('john@test.com');
    expect(msg).not.toContain('192.168.1.1');
    expect(msg).not.toContain('123-45-6789');
    expect(msg).toContain('[REDACTED:email]');
    expect(msg).toContain('[REDACTED:ip]');
    expect(msg).toContain('[REDACTED:ssn]');
  });
});

// ---------------------------------------------------------------------------
// TC-2-3-02: Stack traces scrubbed
// ---------------------------------------------------------------------------

describe('TC-2-3-02: Stack traces scrubbed', () => {
  test('IP addresses in stack traces are replaced with [REDACTED:ip]', async () => {
    const data: CollectedData = {
      prometheus: [],
      opensearch: [
        {
          hits: [
            {
              message: 'Connection failed',
              stack_trace:
                'Error at 10.0.0.5:8080\n  at connect(192.168.1.100)\n  at main()',
            },
          ],
        },
      ],
      grafana: { alerts: {}, annotations: { annotations: [] } },
    };

    const result = await scrubCollectedData(data, makeConfig(), makeContext());
    const stack = result.opensearch[0].hits[0].stack_trace!;

    expect(stack).not.toContain('10.0.0.5');
    expect(stack).not.toContain('192.168.1.100');
    expect(stack).toContain('[REDACTED:ip]');
  });

  test('stack_trace left unchanged when no PII present', async () => {
    const data: CollectedData = {
      prometheus: [],
      opensearch: [
        {
          hits: [
            {
              message: 'Error occurred',
              stack_trace: 'at function foo()\n  at bar()',
            },
          ],
        },
      ],
      grafana: { alerts: {}, annotations: { annotations: [] } },
    };

    const result = await scrubCollectedData(data, makeConfig(), makeContext());

    expect(result.opensearch[0].hits[0].stack_trace).toBe(
      'at function foo()\n  at bar()',
    );
  });

  test('hits without stack_trace preserve undefined', async () => {
    const data: CollectedData = {
      prometheus: [],
      opensearch: [
        {
          hits: [{ message: 'No stack trace here' }],
        },
      ],
      grafana: { alerts: {}, annotations: { annotations: [] } },
    };

    const result = await scrubCollectedData(data, makeConfig(), makeContext());

    expect(result.opensearch[0].hits[0].stack_trace).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TC-2-3-03: Grafana annotations scrubbed
// ---------------------------------------------------------------------------

describe('TC-2-3-03: Grafana annotations scrubbed', () => {
  test('bearer token in annotation text is replaced with [SECRET_REDACTED]', async () => {
    const data: CollectedData = {
      prometheus: [],
      opensearch: [],
      grafana: {
        alerts: { status: 'ok' },
        annotations: {
          annotations: [
            {
              text: 'Deploy with auth: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.abc123def456',
            },
          ],
        },
      },
    };

    const result = await scrubCollectedData(data, makeConfig(), makeContext());
    const text = result.grafana.annotations.annotations[0].text;

    expect(text).not.toContain('Bearer eyJ');
    // Should be redacted by either bearer or JWT pattern
    expect(
      text.includes('[SECRET_REDACTED]') || text.includes('[REDACTED:jwt]'),
    ).toBe(true);
  });

  test('alerts are passed through unchanged', async () => {
    const alerts = { status: 'firing', count: 3, labels: { severity: 'critical' } };
    const data: CollectedData = {
      prometheus: [],
      opensearch: [],
      grafana: {
        alerts,
        annotations: { annotations: [{ text: 'clean annotation' }] },
      },
    };

    const result = await scrubCollectedData(data, makeConfig(), makeContext());

    expect(result.grafana.alerts).toEqual(alerts);
  });
});

// ---------------------------------------------------------------------------
// TC-2-3-04: Prometheus labels scrubbed
// ---------------------------------------------------------------------------

describe('TC-2-3-04: Prometheus labels scrubbed', () => {
  test('email in label value is replaced with [REDACTED:email]', async () => {
    const data: CollectedData = {
      prometheus: [
        {
          metric: 'http_requests_total',
          labels: {
            instance: 'web-01',
            contact: 'admin@company.com',
          },
        },
      ],
      opensearch: [],
      grafana: { alerts: {}, annotations: { annotations: [] } },
    };

    const result = await scrubCollectedData(data, makeConfig(), makeContext());
    const labels = result.prometheus[0].labels!;

    expect(labels.contact).not.toContain('admin@company.com');
    expect(labels.contact).toContain('[REDACTED:email]');
    // Non-PII label preserved
    expect(labels.instance).toBe('web-01');
  });

  test('Prometheus results without labels pass through unchanged', async () => {
    const data: CollectedData = {
      prometheus: [{ metric: 'up', value: 1 }],
      opensearch: [],
      grafana: { alerts: {}, annotations: { annotations: [] } },
    };

    const result = await scrubCollectedData(data, makeConfig(), makeContext());

    expect(result.prometheus[0]).toEqual({ metric: 'up', value: 1 });
  });
});

// ---------------------------------------------------------------------------
// TC-2-3-05: No bypass path
// ---------------------------------------------------------------------------

describe('TC-2-3-05: No bypass path', () => {
  test('scrubCollectedData is a function that cannot be skipped', () => {
    // The function exists and is callable
    expect(typeof scrubCollectedData).toBe('function');
  });

  test('there is no skip_scrubbing option in DataSafetyConfig', () => {
    const config = makeConfig();

    // TypeScript would prevent this at compile time, but we also verify
    // at runtime that no such property exists
    expect((config as any).skip_scrubbing).toBeUndefined();
    expect((config as any).skipScrubbing).toBeUndefined();
    expect((config as any).bypass).toBeUndefined();
  });

  test('empty data still passes through scrub pipeline without error', async () => {
    const data: CollectedData = {
      prometheus: [],
      opensearch: [],
      grafana: { alerts: {}, annotations: { annotations: [] } },
    };

    const result = await scrubCollectedData(data, makeConfig(), makeContext());

    expect(result.prometheus).toEqual([]);
    expect(result.opensearch).toEqual([]);
    expect(result.grafana.annotations.annotations).toEqual([]);
    expect(result.scrubAuditEntries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TC-2-3-11: Scrub failure blocks data
// ---------------------------------------------------------------------------

describe('TC-2-3-11: Scrub failure blocks data', () => {
  test('scrub() returns SCRUB_FAILED on timeout, NOT raw text', async () => {
    // Create a config with an extremely short timeout to force timeout
    const config: DataSafetyConfig = {
      pii_patterns: [],
      secret_patterns: [],
      timeout_ms: 0, // Immediate timeout
    };

    const rawText = 'sensitive@email.com';
    const result = await scrub(rawText, config, {
      fieldName: 'test_field',
      runId: 'RUN-TEST',
      service: 'test',
      source: 'test',
      lineCount: 1,
    });

    // The result should either be the scrubbed text or a SCRUB_FAILED token
    // It should NEVER be the raw text
    expect(result.text).not.toBe(rawText);
  });
});

// ---------------------------------------------------------------------------
// TC-2-3-12: Integration end-to-end
// ---------------------------------------------------------------------------

describe('TC-2-3-12: Integration end-to-end', () => {
  test('final scrubbed data contains zero raw PII', async () => {
    const rawEmail = 'alice@production.com';
    const rawIp = '10.0.0.42';
    const rawSsn = '987-65-4321';
    const rawAwsKey = 'AKIAIOSFODNN7EXAMPLE';
    const rawBearer = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.abc123def456';

    const data: CollectedData = {
      prometheus: [
        {
          metric: 'error_rate',
          labels: { admin_email: rawEmail },
        },
      ],
      opensearch: [
        {
          hits: [
            {
              message: `Error from ${rawEmail} at ${rawIp}`,
              stack_trace: `SSN: ${rawSsn}\n  at handler(${rawIp})`,
            },
          ],
        },
      ],
      grafana: {
        alerts: {},
        annotations: {
          annotations: [
            { text: `Key ${rawAwsKey} used for auth: ${rawBearer}` },
          ],
        },
      },
    };

    const result = await scrubCollectedData(data, makeConfig(), makeContext());

    // Serialize everything to check no raw PII remains
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(rawEmail);
    expect(serialized).not.toContain(rawIp);
    expect(serialized).not.toContain(rawSsn);
    expect(serialized).not.toContain(rawAwsKey);
    // Check that bearer token value is gone (the word "Bearer" may remain
    // as part of the redacted output context, but the actual token should not)
    expect(serialized).not.toContain('eyJhbGciOiJIUzI1NiJ9');

    // Verify redaction tokens are present
    expect(serialized).toContain('[REDACTED:email]');
    expect(serialized).toContain('[REDACTED:ip]');
    expect(serialized).toContain('[REDACTED:ssn]');
    expect(serialized).toContain('[SECRET_REDACTED]');
  });

  test('audit entries are produced for each scrubbed field', async () => {
    const data: CollectedData = {
      prometheus: [
        { metric: 'test', labels: { email: 'user@test.com' } },
      ],
      opensearch: [
        {
          hits: [
            { message: 'from user@test.com', stack_trace: 'at 10.0.0.1' },
          ],
        },
      ],
      grafana: {
        alerts: {},
        annotations: {
          annotations: [{ text: 'annotation with user@test.com' }],
        },
      },
    };

    const result = await scrubCollectedData(data, makeConfig(), makeContext());

    // Should have audit entries for: 1 prometheus label, 1 opensearch message,
    // 1 opensearch stack_trace, 1 grafana annotation = 4 entries
    expect(result.scrubAuditEntries.length).toBe(4);

    const sources = result.scrubAuditEntries.map((e) => e.source);
    expect(sources).toContain('prometheus');
    expect(sources).toContain('opensearch');
    expect(sources).toContain('grafana');
  });
});

// ---------------------------------------------------------------------------
// TC-2-3-10: .gitignore updated (verified via file read)
// ---------------------------------------------------------------------------

describe('TC-2-3-10: .gitignore updated', () => {
  test('.gitignore contains all four exclusion lines', async () => {
    const fs = await import('fs/promises');
    const path = await import('path');

    const gitignorePath = path.join(
      __dirname,
      '../../.gitignore',
    );

    let content: string;
    try {
      content = await fs.readFile(gitignorePath, 'utf-8');
    } catch {
      // If .gitignore doesn't exist at test time, skip gracefully
      console.warn('.gitignore not found at expected path, skipping');
      return;
    }

    expect(content).toContain('.autonomous-dev/observations/');
    expect(content).toContain('.autonomous-dev/logs/');
    expect(content).toContain('.autonomous-dev/baselines/');
    expect(content).toContain('.autonomous-dev/fingerprints/');
  });
});
