/**
 * Tests for Weekly Audit Scan (SPEC-007-2-3, Task 8).
 *
 * Covers test cases TC-2-3-06 through TC-2-3-09.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { weeklyAuditScan, type AuditScanResult } from '../../src/safety/weekly-audit';
import { PII_PATTERNS } from '../../src/safety/pii-scrubber';
import { SECRET_PATTERNS } from '../../src/safety/secret-detector';

// ---------------------------------------------------------------------------
// Shared setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'weekly-audit-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * Helper to write an observation file.
 */
async function writeObservation(
  relativePath: string,
  content: string,
): Promise<void> {
  const fullPath = path.join(tmpDir, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// TC-2-3-06: Clean files with only redaction tokens
// ---------------------------------------------------------------------------

describe('TC-2-3-06: Weekly audit clean files', () => {
  test('zero findings when files contain only redaction tokens', async () => {
    await writeObservation('report-001.md', [
      '# Observation Report',
      '',
      'User [REDACTED:email] logged in from [REDACTED:ip].',
      'Auth token: [SECRET_REDACTED]',
      'SSN provided: [REDACTED:ssn]',
      'Phone: [REDACTED:phone]',
    ].join('\n'));

    const result = await weeklyAuditScan(tmpDir);

    expect(result.findings).toEqual([]);
    expect(result.files_scanned).toBe(1);
    expect(result.total_lines_scanned).toBe(6);
  });

  test('zero findings on empty observations directory', async () => {
    const result = await weeklyAuditScan(tmpDir);

    expect(result.findings).toEqual([]);
    expect(result.files_scanned).toBe(0);
    expect(result.total_lines_scanned).toBe(0);
  });

  test('zero findings with multiple clean files', async () => {
    await writeObservation('report-001.md', 'Status: OK\nNo PII here.');
    await writeObservation('report-002.md', 'All clear. Service healthy.');
    await writeObservation('archive/old-report.md', 'Archived: [REDACTED:email]');

    const result = await weeklyAuditScan(tmpDir);

    expect(result.findings).toEqual([]);
    expect(result.files_scanned).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// TC-2-3-07: Audit finds leaked PII
// ---------------------------------------------------------------------------

describe('TC-2-3-07: Weekly audit finds leak', () => {
  test('detects raw email on specific line', async () => {
    const lines = new Array(41).fill('clean line');
    lines.push('User john@test.com logged in'); // line 42
    lines.push('More clean content');

    await writeObservation('report-with-leak.md', lines.join('\n'));

    const result = await weeklyAuditScan(tmpDir);

    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    const emailFinding = result.findings.find(
      (f) => f.pattern_name === 'email',
    );
    expect(emailFinding).toBeDefined();
    expect(emailFinding!.file_path).toBe('report-with-leak.md');
    expect(emailFinding!.line_number).toBe(42);
    expect(emailFinding!.pattern_type).toBe('pii');
  });

  test('detects raw IPv4 address', async () => {
    await writeObservation('report-ip.md', 'Connected from 192.168.1.100');

    const result = await weeklyAuditScan(tmpDir);

    const ipFinding = result.findings.find((f) => f.pattern_name === 'ipv4');
    expect(ipFinding).toBeDefined();
    expect(ipFinding!.pattern_type).toBe('pii');
  });

  test('detects raw SSN', async () => {
    await writeObservation('report-ssn.md', 'SSN: 123-45-6789');

    const result = await weeklyAuditScan(tmpDir);

    const ssnFinding = result.findings.find((f) => f.pattern_name === 'ssn');
    expect(ssnFinding).toBeDefined();
    expect(ssnFinding!.pattern_type).toBe('pii');
  });

  test('detects leaked secret (AWS access key)', async () => {
    await writeObservation('report-secret.md', 'Key: AKIAIOSFODNN7EXAMPLE');

    const result = await weeklyAuditScan(tmpDir);

    const secretFinding = result.findings.find(
      (f) => f.pattern_name === 'aws_access_key',
    );
    expect(secretFinding).toBeDefined();
    expect(secretFinding!.pattern_type).toBe('secret');
  });

  test('detects leaked bearer token', async () => {
    await writeObservation(
      'report-bearer.md',
      'Auth: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.abc123def456',
    );

    const result = await weeklyAuditScan(tmpDir);

    // Should find either bearer or JWT pattern
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// TC-2-3-08: Expanded entropy analysis
// ---------------------------------------------------------------------------

describe('TC-2-3-08: Weekly audit expanded entropy', () => {
  test('detects high-entropy string outside key= context', async () => {
    // This string is high-entropy and > 20 chars but NOT in password=/token= context
    // The real-time detector would miss it, but the weekly audit should catch it
    const highEntropyString = 'aB3$xY9!kL2@mN5^pQ8&rT1wZ';
    await writeObservation(
      'report-entropy.md',
      `Some context: ${highEntropyString} more text`,
    );

    const result = await weeklyAuditScan(tmpDir);

    const entropyFinding = result.findings.find(
      (f) => f.pattern_type === 'high_entropy',
    );
    expect(entropyFinding).toBeDefined();
    expect(entropyFinding!.pattern_name).toBe('expanded_entropy_scan');
    expect(entropyFinding!.context).toContain('high-entropy string detected');
    expect(entropyFinding!.context).toContain(`${highEntropyString.length} chars`);
  });

  test('does not flag low-entropy long strings', async () => {
    // Repeated characters have low entropy
    const lowEntropy = 'aaaaaaaaaaaaaaaaaaaaaaaaa'; // 25 'a' chars
    await writeObservation('report-low-entropy.md', `Data: ${lowEntropy}`);

    const result = await weeklyAuditScan(tmpDir);

    const entropyFindings = result.findings.filter(
      (f) => f.pattern_type === 'high_entropy',
    );
    expect(entropyFindings.length).toBe(0);
  });

  test('does not flag strings shorter than 20 chars', async () => {
    await writeObservation('report-short.md', 'Short: aB3$xY9!kL2@mN5');

    const result = await weeklyAuditScan(tmpDir);

    const entropyFindings = result.findings.filter(
      (f) => f.pattern_type === 'high_entropy',
    );
    expect(entropyFindings.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TC-2-3-09: Skips redaction tokens
// ---------------------------------------------------------------------------

describe('TC-2-3-09: Weekly audit skips tokens', () => {
  test('does not report [REDACTED:email] as a finding', async () => {
    await writeObservation(
      'report-redacted.md',
      'User [REDACTED:email] logged in from [REDACTED:ip]',
    );

    const result = await weeklyAuditScan(tmpDir);

    expect(result.findings).toEqual([]);
  });

  test('does not report [SECRET_REDACTED] as a finding', async () => {
    await writeObservation(
      'report-secret-redacted.md',
      'Token: [SECRET_REDACTED]',
    );

    const result = await weeklyAuditScan(tmpDir);

    expect(result.findings).toEqual([]);
  });

  test('does not report [SCRUB_FAILED:timeout] in entropy scan', async () => {
    await writeObservation(
      'report-scrub-failed.md',
      'Field value: [SCRUB_FAILED:timeout]',
    );

    const result = await weeklyAuditScan(tmpDir);

    const entropyFindings = result.findings.filter(
      (f) => f.pattern_type === 'high_entropy',
    );
    expect(entropyFindings.length).toBe(0);
  });

  test('reports raw PII next to a redaction token', async () => {
    // The line has a redacted email AND a raw email
    await writeObservation(
      'report-mixed.md',
      'From [REDACTED:email] to john@leaked.com',
    );

    const result = await weeklyAuditScan(tmpDir);

    const emailFindings = result.findings.filter(
      (f) => f.pattern_name === 'email',
    );
    expect(emailFindings.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scan metadata
// ---------------------------------------------------------------------------

describe('Audit scan metadata', () => {
  test('reports scan duration', async () => {
    await writeObservation('report.md', 'Clean content.');

    const result = await weeklyAuditScan(tmpDir);

    expect(result.scan_duration_ms).toBeGreaterThanOrEqual(0);
    expect(typeof result.scan_duration_ms).toBe('number');
  });

  test('reports scan timestamp as ISO 8601', async () => {
    const result = await weeklyAuditScan(tmpDir);

    expect(result.scan_timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });

  test('counts files and lines correctly', async () => {
    await writeObservation('a.md', 'line1\nline2\nline3');
    await writeObservation('b.md', 'line1\nline2');

    const result = await weeklyAuditScan(tmpDir);

    expect(result.files_scanned).toBe(2);
    expect(result.total_lines_scanned).toBe(5);
  });

  test('scans files in subdirectories (archive)', async () => {
    await writeObservation('current.md', 'Clean.');
    await writeObservation('archive/old.md', 'User john@test.com leaked');

    const result = await weeklyAuditScan(tmpDir);

    expect(result.files_scanned).toBe(2);
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.findings[0].file_path).toBe('archive/old.md');
  });

  test('ignores non-.md files', async () => {
    await writeObservation('data.json', '{"email": "john@test.com"}');
    await writeObservation('report.md', 'Clean content.');

    const result = await weeklyAuditScan(tmpDir);

    // Only the .md file should be scanned
    expect(result.files_scanned).toBe(1);
    // No findings from the .json file
    expect(result.findings).toEqual([]);
  });
});
