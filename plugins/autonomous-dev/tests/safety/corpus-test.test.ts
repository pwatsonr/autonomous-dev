/**
 * Corpus Tests — Recall, false positive rate, and performance tests
 * for the scrubbing pipeline against a 10K-line synthetic corpus.
 *
 * Covers SPEC-007-2-4 test cases:
 *   TC-2-4-01: Corpus generation
 *   TC-2-4-02: Recall >= 99%
 *   TC-2-4-03: False positive rate < 5%
 *   TC-2-4-04: Performance < 2s
 *   TC-2-4-09: Email recall detail
 *   TC-2-4-10: High-entropy recall
 *   TC-2-4-11: Timestamps not flagged
 *   TC-2-4-12: Version numbers not flagged
 */

import {
  generateCorpus,
  getLineNumber,
  type GeneratedCorpus,
  type CorpusManifest,
} from './corpus/generate-corpus';
import { scrubPii } from '../../src/safety/pii-scrubber';
import { detectSecrets } from '../../src/safety/secret-detector';
import type { Redaction } from '../../src/safety/types';

// ---------------------------------------------------------------------------
// Combined scrub function — runs PII scrubber (stage 1) then secret
// detector (stage 2), the same two-stage pipeline the product uses.
// ---------------------------------------------------------------------------

interface ScrubResult {
  text: string;
  redactions: Redaction[];
}

function scrub(input: string): ScrubResult {
  const piiResult = scrubPii(input);
  const secretResult = detectSecrets(piiResult.text);

  return {
    text: secretResult.text,
    redactions: [...piiResult.redactions, ...secretResult.redactions],
  };
}

// ---------------------------------------------------------------------------
// Corpus generation & structure tests
// ---------------------------------------------------------------------------

describe('Corpus Generation (TC-2-4-01)', () => {
  let corpus: GeneratedCorpus;

  beforeAll(() => {
    corpus = generateCorpus();
  });

  test('generates exactly 10,000 lines', () => {
    const lines = corpus.text.split('\n');
    expect(lines.length).toBe(10_000);
  });

  test('manifest reports 10,000 total lines', () => {
    expect(corpus.manifest.total_lines).toBe(10_000);
  });

  test('embeds exactly 1,450 items', () => {
    expect(corpus.manifest.embedded_items.length).toBe(1_450);
  });

  test('distribution matches spec counts', () => {
    const counts: Record<string, number> = {};
    for (const item of corpus.manifest.embedded_items) {
      counts[item.pattern_type] = (counts[item.pattern_type] || 0) + 1;
    }

    expect(counts['email']).toBe(500);
    expect(counts['phone_us']).toBe(150);
    expect(counts['phone_intl']).toBe(50);
    expect(counts['ssn']).toBe(50);
    expect(counts['credit_card']).toBe(80);
    expect(counts['credit_card_amex']).toBe(20);
    expect(counts['ipv4']).toBe(120);
    expect(counts['ipv6_full']).toBe(15);
    expect(counts['ipv6_compressed']).toBe(15);
    expect(counts['aws_access_key']).toBe(50);
    expect(counts['github_pat']).toBe(30);
    expect(counts['stripe_secret']).toBe(20);
    expect(counts['bearer']).toBe(100);
    expect(counts['jwt']).toBe(50);
    expect(counts['high_entropy']).toBe(200);
  });

  test('each embedded item has a valid line number', () => {
    for (const item of corpus.manifest.embedded_items) {
      expect(item.line_number).toBeGreaterThanOrEqual(0);
      expect(item.line_number).toBeLessThan(10_000);
    }
  });

  test('each embedded item has a non-empty original_value', () => {
    for (const item of corpus.manifest.embedded_items) {
      expect(item.original_value.length).toBeGreaterThan(0);
    }
  });

  test('each embedded item has a non-empty expected_replacement', () => {
    for (const item of corpus.manifest.embedded_items) {
      expect(item.expected_replacement.length).toBeGreaterThan(0);
    }
  });

  test('embedded values are actually present in their declared lines', () => {
    const lines = corpus.text.split('\n');
    let foundCount = 0;
    for (const item of corpus.manifest.embedded_items) {
      const line = lines[item.line_number];
      if (line.includes(item.original_value)) {
        foundCount++;
      }
    }
    // All embedded values should be findable in their line
    expect(foundCount).toBe(corpus.manifest.embedded_items.length);
  });

  test('no duplicate line numbers in manifest', () => {
    const lineNumbers = corpus.manifest.embedded_items.map(i => i.line_number);
    const unique = new Set(lineNumbers);
    expect(unique.size).toBe(lineNumbers.length);
  });

  test('deterministic: two calls with same seed produce identical corpus', () => {
    const c1 = generateCorpus(42);
    const c2 = generateCorpus(42);
    expect(c1.text).toBe(c2.text);
    expect(c1.manifest.embedded_items.length).toBe(c2.manifest.embedded_items.length);
  });

  test('different seed produces different corpus', () => {
    const c1 = generateCorpus(42);
    const c2 = generateCorpus(99);
    expect(c1.text).not.toBe(c2.text);
  });

  test('every line starts with a timestamp bracket', () => {
    const lines = corpus.text.split('\n');
    for (const line of lines) {
      expect(line).toMatch(/^\[2026-04-08T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
    }
  });

  test('clean lines (~8,550) contain no known PII/secret values', () => {
    const lines = corpus.text.split('\n');
    const embeddedLineNums = new Set(corpus.manifest.embedded_items.map(i => i.line_number));

    // Sample 200 clean lines and check they don't contain any embedded values
    const cleanLineIndices = [];
    for (let i = 0; i < lines.length; i++) {
      if (!embeddedLineNums.has(i)) cleanLineIndices.push(i);
    }
    expect(cleanLineIndices.length).toBe(10_000 - 1_450);

    // Spot-check a few clean lines for known PII patterns
    const sampleSize = Math.min(200, cleanLineIndices.length);
    for (let s = 0; s < sampleSize; s++) {
      const idx = cleanLineIndices[Math.floor(s * cleanLineIndices.length / sampleSize)];
      const line = lines[idx];
      // Clean lines should not contain @ (email indicator), except in the log format itself
      // This is a heuristic check, not exhaustive
      expect(line).not.toMatch(/AKIA[0-9A-Z]{16}/);
      expect(line).not.toMatch(/ghp_[a-zA-Z0-9]{36}/);
      expect(line).not.toMatch(/sk_TESTONLY_/);
    }
  });
});

// ---------------------------------------------------------------------------
// Recall tests
// ---------------------------------------------------------------------------

describe('Scrubbing Recall (TC-2-4-02)', () => {
  let corpus: GeneratedCorpus;
  let result: ScrubResult;

  beforeAll(() => {
    corpus = generateCorpus();
    result = scrub(corpus.text);
  });

  test('recall >= 99% on all known patterns', () => {
    let detected = 0;
    let missed = 0;
    const missedDetails: string[] = [];

    for (const item of corpus.manifest.embedded_items) {
      if (!result.text.includes(item.original_value)) {
        detected++;
      } else {
        missed++;
        missedDetails.push(
          `line ${item.line_number}, type=${item.pattern_type}, value=${item.original_value.substring(0, 40)}...`,
        );
      }
    }

    const recall = detected / corpus.manifest.embedded_items.length;

    // Log details for debugging if recall drops
    if (recall < 0.99) {
      console.warn(
        `Recall: ${(recall * 100).toFixed(2)}% (${detected}/${corpus.manifest.embedded_items.length})`,
      );
      console.warn(`Missed ${missed} items:`);
      for (const detail of missedDetails.slice(0, 20)) {
        console.warn(`  ${detail}`);
      }
    }

    expect(recall).toBeGreaterThanOrEqual(0.99);
  });

  test('zero false negatives on known patterns (ideal target)', () => {
    let missed = 0;
    const missedByType: Record<string, number> = {};

    for (const item of corpus.manifest.embedded_items) {
      if (result.text.includes(item.original_value)) {
        missed++;
        missedByType[item.pattern_type] = (missedByType[item.pattern_type] || 0) + 1;
      }
    }

    // This is the aspirational target — log what was missed for investigation
    if (missed > 0) {
      console.warn(`Missed ${missed} embedded items by type:`, missedByType);
    }

    // Enforce the hard >=99% threshold
    const recall = 1 - missed / corpus.manifest.embedded_items.length;
    expect(recall).toBeGreaterThanOrEqual(0.99);
  });
});

// ---------------------------------------------------------------------------
// Per-type recall detail tests
// ---------------------------------------------------------------------------

describe('Per-Type Recall Detail', () => {
  let corpus: GeneratedCorpus;
  let result: ScrubResult;

  beforeAll(() => {
    corpus = generateCorpus();
    result = scrub(corpus.text);
  });

  test('TC-2-4-09: email recall — all 500 detected', () => {
    const emailItems = corpus.manifest.embedded_items.filter(i => i.pattern_type === 'email');
    expect(emailItems.length).toBe(500);

    let detected = 0;
    for (const item of emailItems) {
      if (!result.text.includes(item.original_value)) detected++;
    }

    const recall = detected / emailItems.length;
    expect(recall).toBe(1.0); // 100% recall on emails
  });

  test('US phone recall', () => {
    const items = corpus.manifest.embedded_items.filter(i => i.pattern_type === 'phone_us');
    expect(items.length).toBe(150);

    let detected = 0;
    for (const item of items) {
      if (!result.text.includes(item.original_value)) detected++;
    }

    expect(detected / items.length).toBeGreaterThanOrEqual(0.99);
  });

  test('SSN recall', () => {
    const items = corpus.manifest.embedded_items.filter(i => i.pattern_type === 'ssn');
    expect(items.length).toBe(50);

    let detected = 0;
    for (const item of items) {
      if (!result.text.includes(item.original_value)) detected++;
    }

    expect(detected / items.length).toBe(1.0);
  });

  test('credit card recall', () => {
    const items = corpus.manifest.embedded_items.filter(i => i.pattern_type === 'credit_card');
    expect(items.length).toBe(80);

    let detected = 0;
    for (const item of items) {
      if (!result.text.includes(item.original_value)) detected++;
    }

    expect(detected / items.length).toBeGreaterThanOrEqual(0.99);
  });

  test('IPv4 recall', () => {
    const items = corpus.manifest.embedded_items.filter(i => i.pattern_type === 'ipv4');
    expect(items.length).toBe(120);

    let detected = 0;
    for (const item of items) {
      if (!result.text.includes(item.original_value)) detected++;
    }

    expect(detected / items.length).toBe(1.0);
  });

  test('AWS access key recall', () => {
    const items = corpus.manifest.embedded_items.filter(i => i.pattern_type === 'aws_access_key');
    expect(items.length).toBe(50);

    let detected = 0;
    for (const item of items) {
      if (!result.text.includes(item.original_value)) detected++;
    }

    expect(detected / items.length).toBe(1.0);
  });

  test('GitHub token recall', () => {
    const items = corpus.manifest.embedded_items.filter(i => i.pattern_type === 'github_pat');
    expect(items.length).toBe(30);

    let detected = 0;
    for (const item of items) {
      if (!result.text.includes(item.original_value)) detected++;
    }

    expect(detected / items.length).toBe(1.0);
  });

  test('Stripe key recall', () => {
    const items = corpus.manifest.embedded_items.filter(i => i.pattern_type === 'stripe_secret');
    expect(items.length).toBe(20);

    let detected = 0;
    for (const item of items) {
      if (!result.text.includes(item.original_value)) detected++;
    }

    expect(detected / items.length).toBe(1.0);
  });

  test('Bearer token recall', () => {
    const items = corpus.manifest.embedded_items.filter(i => i.pattern_type === 'bearer');
    expect(items.length).toBe(100);

    let detected = 0;
    for (const item of items) {
      if (!result.text.includes(item.original_value)) detected++;
    }

    expect(detected / items.length).toBe(1.0);
  });

  test('JWT recall', () => {
    const items = corpus.manifest.embedded_items.filter(i => i.pattern_type === 'jwt');
    expect(items.length).toBe(50);

    let detected = 0;
    for (const item of items) {
      if (!result.text.includes(item.original_value)) detected++;
    }

    expect(detected / items.length).toBe(1.0);
  });

  test('TC-2-4-10: high-entropy recall >= 99% (>= 198 of 200)', () => {
    const items = corpus.manifest.embedded_items.filter(i => i.pattern_type === 'high_entropy');
    expect(items.length).toBe(200);

    let detected = 0;
    for (const item of items) {
      if (!result.text.includes(item.original_value)) detected++;
    }

    const recall = detected / items.length;
    expect(recall).toBeGreaterThanOrEqual(0.99); // >= 198 of 200
  });

  test('IPv6 full recall', () => {
    const items = corpus.manifest.embedded_items.filter(i => i.pattern_type === 'ipv6_full');
    expect(items.length).toBe(15);

    let detected = 0;
    for (const item of items) {
      if (!result.text.includes(item.original_value)) detected++;
    }

    expect(detected / items.length).toBe(1.0);
  });

  test('IPv6 compressed recall', () => {
    const items = corpus.manifest.embedded_items.filter(i => i.pattern_type === 'ipv6_compressed');
    expect(items.length).toBe(15);

    let detected = 0;
    for (const item of items) {
      if (!result.text.includes(item.original_value)) detected++;
    }

    expect(detected / items.length).toBeGreaterThanOrEqual(0.99);
  });

  test('international phone recall', () => {
    const items = corpus.manifest.embedded_items.filter(i => i.pattern_type === 'phone_intl');
    expect(items.length).toBe(50);

    let detected = 0;
    for (const item of items) {
      if (!result.text.includes(item.original_value)) detected++;
    }

    expect(detected / items.length).toBeGreaterThanOrEqual(0.99);
  });

  test('Amex credit card recall', () => {
    const items = corpus.manifest.embedded_items.filter(i => i.pattern_type === 'credit_card_amex');
    expect(items.length).toBe(20);

    let detected = 0;
    for (const item of items) {
      if (!result.text.includes(item.original_value)) detected++;
    }

    expect(detected / items.length).toBeGreaterThanOrEqual(0.99);
  });
});

// ---------------------------------------------------------------------------
// False positive rate tests
// ---------------------------------------------------------------------------

describe('False Positive Rate (TC-2-4-03)', () => {
  let corpus: GeneratedCorpus;
  let result: ScrubResult;
  let manifest: CorpusManifest;

  beforeAll(() => {
    corpus = generateCorpus();
    result = scrub(corpus.text);
    manifest = corpus.manifest;
  });

  test('false positive rate < 5%', () => {
    // Count redactions whose position falls on a "clean" line
    const embeddedLines = new Set(manifest.embedded_items.map(i => i.line_number));
    const totalCleanLines = manifest.total_lines - embeddedLines.size;

    // Collect line numbers that had redactions
    const redactedCleanLines = new Set<number>();
    for (const r of result.redactions) {
      const lineNum = getLineNumber(corpus.text, r.position);
      if (!embeddedLines.has(lineNum)) {
        redactedCleanLines.add(lineNum);
      }
    }

    const fpRate = redactedCleanLines.size / totalCleanLines;

    if (fpRate >= 0.05) {
      console.warn(
        `False positive rate: ${(fpRate * 100).toFixed(2)}% (${redactedCleanLines.size} clean lines with redactions / ${totalCleanLines} total clean lines)`,
      );
    }

    // < 5% of clean lines should have false redactions
    expect(fpRate).toBeLessThan(0.05);
  });

  test('false redaction count < 427 (5% of ~8,550 clean lines)', () => {
    const embeddedLines = new Set(manifest.embedded_items.map(i => i.line_number));

    let falseRedactionCount = 0;
    for (const r of result.redactions) {
      const lineNum = getLineNumber(corpus.text, r.position);
      if (!embeddedLines.has(lineNum)) {
        falseRedactionCount++;
      }
    }

    expect(falseRedactionCount).toBeLessThan(427);
  });
});

// ---------------------------------------------------------------------------
// Performance tests
// ---------------------------------------------------------------------------

describe('Performance (TC-2-4-04)', () => {
  test('scrub 10K lines in < 2 seconds (NFR-002)', () => {
    const corpus = generateCorpus();

    const start = performance.now();
    scrub(corpus.text);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(2000);
  });

  test('scrub 10K lines three consecutive runs all < 2s', () => {
    const corpus = generateCorpus();
    const times: number[] = [];

    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      scrub(corpus.text);
      times.push(performance.now() - start);
    }

    for (const t of times) {
      expect(t).toBeLessThan(2000);
    }
  });
});

// ---------------------------------------------------------------------------
// False-positive-specific tests (TC-2-4-11, TC-2-4-12)
// ---------------------------------------------------------------------------

describe('False Positive Edge Cases', () => {
  test('TC-2-4-11: ISO timestamps are not flagged as IPv6', () => {
    const timestampLines = [
      '[2026-04-08T14:30:22.123Z] [INFO] Request completed',
      '[2026-04-08T10:00:00.000Z] [DEBUG] Cache check',
      '[2026-04-08T23:59:59.999Z] [WARN] Connection timeout',
    ];

    for (const line of timestampLines) {
      const result = scrub(line);
      // The timestamp portion should be preserved, not redacted as IPv6
      expect(result.text).toContain('2026-04-08T');
      // The time part HH:MM:SS should not be redacted
      expect(result.redactions.filter(r => r.type === 'ip').length).toBe(0);
    }
  });

  test('TC-2-4-12: version numbers not flagged as IP addresses', () => {
    const versionLines = [
      'Deployment started version=v2.0.1 environment=staging',
      'Deployed version 2.0 to production',
      'API v3.1.4 is now live',
      'Upgrade from 1.0 to 2.0 complete',
    ];

    for (const line of versionLines) {
      const result = scrub(line);
      // Version strings like v2.0.1 or 2.0 should not be treated as IPs
      // Note: v2.0.1 has only 3 octets so it won't match the 4-octet IPv4 regex
      expect(result.text).not.toContain('[REDACTED:ip]');
    }
  });

  test('port numbers not flagged', () => {
    const lines = [
      'Listening on port 8080',
      'PostgreSQL running on port 5432',
      'Redis at port 6379',
    ];

    for (const line of lines) {
      const result = scrub(line);
      expect(result.text).toBe(line); // No changes expected
    }
  });

  test('HTTP status codes not flagged', () => {
    const lines = [
      'Response status=200 OK',
      'Returned status 404 not found',
      'Server error status=500',
    ];

    for (const line of lines) {
      const result = scrub(line);
      expect(result.text).toBe(line);
    }
  });

  test('durations and counts not flagged', () => {
    const lines = [
      'Query took 45ms to complete',
      'Processed 10000 records',
      'Uptime: 72h',
      'TTL: 300s',
    ];

    for (const line of lines) {
      const result = scrub(line);
      expect(result.text).toBe(line);
    }
  });
});

// ---------------------------------------------------------------------------
// getLineNumber helper tests
// ---------------------------------------------------------------------------

describe('getLineNumber helper', () => {
  test('offset 0 returns line 0', () => {
    expect(getLineNumber('hello\nworld', 0)).toBe(0);
  });

  test('offset after first newline returns line 1', () => {
    expect(getLineNumber('hello\nworld', 6)).toBe(1);
  });

  test('offset at newline returns current line', () => {
    expect(getLineNumber('hello\nworld', 5)).toBe(1);
  });

  test('multiple newlines', () => {
    const text = 'a\nb\nc\nd';
    expect(getLineNumber(text, 0)).toBe(0); // 'a'
    expect(getLineNumber(text, 2)).toBe(1); // 'b'
    expect(getLineNumber(text, 4)).toBe(2); // 'c'
    expect(getLineNumber(text, 6)).toBe(3); // 'd'
  });
});
