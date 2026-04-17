# SPEC-007-2-4: Scrubbing Test Suite & Corpus

## Metadata
- **Parent Plan**: PLAN-007-2
- **Tasks Covered**: Task 10 (scrubbing test suite with 10K-line corpus)
- **Estimated effort**: 10 hours

## Description

Build the dedicated scrubbing test suite with a 10K-line synthetic corpus containing known PII and secret instances at the exact distribution specified in TDD section 8.3. Measure recall (>99%), false positive rate (<5%), and performance (<2s for the full corpus). Also implement the three security tests from TDD section 8.5: PII leak audit, secret leak audit, and credential scan.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `tests/safety/corpus/generate-corpus.ts` | Create | Script to generate the 10K-line test corpus |
| `tests/safety/corpus/test-corpus.txt` | Create (generated) | 10,000 log lines with embedded PII and secrets |
| `tests/safety/corpus-test.test.ts` | Create | Corpus recall, false positive, and performance tests |
| `tests/safety/security-audit.test.ts` | Create | PII leak audit, secret leak audit, credential scan |

## Implementation Details

### Corpus Generation

The corpus generator creates 10,000 production-like log lines with known PII/secret instances embedded at specific positions. Each embedded instance is tracked in a manifest for validation.

```typescript
interface CorpusManifest {
  total_lines: number;
  embedded_items: EmbeddedItem[];
}

interface EmbeddedItem {
  line_number: number;
  pattern_type: string;      // "email", "phone_us", "aws_access_key", etc.
  original_value: string;    // The exact PII/secret embedded
  expected_replacement: string; // "[REDACTED:email]", "[SECRET_REDACTED]", etc.
  position_in_line: number;  // Character offset
}
```

**Distribution from TDD section 8.3**:

| Pattern | Count | Example Values |
|---------|-------|---------------|
| Email addresses | 500 | `john.doe@company.com`, `admin+test@example.org`, `user@sub.domain.co.uk` |
| Phone numbers (US) | 150 | `(555) 123-4567`, `+1-555-987-6543`, `5551234567` |
| Phone numbers (intl) | 50 | `+44 7911 123456`, `+81 3-1234-5678` |
| SSN | 50 | `123-45-6789`, `987-65-4321` |
| Credit card (16-digit) | 80 | `4111-1111-1111-1111`, `5500 0000 0000 0004` |
| Credit card (Amex) | 20 | `3782 822463 10005`, `3714-496353-98431` |
| IPv4 addresses | 120 | `192.168.1.100`, `10.0.0.1`, `172.16.0.50` |
| IPv6 full | 15 | `2001:0db8:85a3:0000:0000:8a2e:0370:7334` |
| IPv6 compressed | 15 | `fe80::1`, `::1`, `2001:db8::1` |
| AWS access keys | 50 | `AKIAIOSFODNN7EXAMPLE` |
| GitHub tokens | 30 | `ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij` |
| Stripe keys | 20 | `sk_TESTONLY_abc123def456ghi789jkl012mnop` |
| Bearer tokens | 100 | `Bearer eyJhbGciOiJIUzI1NiJ9...` |
| JWT tokens | 50 | `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U` |
| High-entropy strings | 200 | `password=aB3$xY9!kL2@mN5^pQ8&rT1wZ...` (in key=value context) |
| **Total embedded** | **1,450** | |
| **Clean lines** | **~8,550** | Normal log lines without PII/secrets |

**Corpus line templates** (clean lines):

```
[2026-04-08T14:30:22.123Z] [INFO] Request completed method=GET path=/api/v2/orders status=200 duration=45ms
[2026-04-08T14:30:23.456Z] [DEBUG] Cache hit for key=orders:page:1 ttl=300s
[2026-04-08T14:30:24.789Z] [WARN] Connection pool nearing capacity pool=orders-db active=45 max=50
[2026-04-08T14:30:25.012Z] [ERROR] ConnectionPoolExhausted: pool "orders-db" max_connections=50 active=50 waiting=312
[2026-04-08T14:30:26.345Z] [INFO] Health check passed service=api-gateway uptime=72h
```

**Corpus line templates** (with embedded PII/secrets):

```
[2026-04-08T14:30:22.123Z] [ERROR] Authentication failed for user john.doe@company.com from 192.168.1.100
[2026-04-08T14:30:23.456Z] [ERROR] Payment failed card=4111-1111-1111-1111 user_id=550e8400-e29b-41d4-a716-446655440000
[2026-04-08T14:30:24.789Z] [WARN] Leaked credential detected: aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
[2026-04-08T14:30:25.012Z] [DEBUG] Token refresh: Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.abc123
```

### Corpus Test: Recall, False Positive Rate, Performance

```typescript
describe('Scrubbing Corpus Test', () => {
  let corpus: string;
  let manifest: CorpusManifest;

  beforeAll(async () => {
    const generated = await generateCorpus();
    corpus = generated.text;
    manifest = generated.manifest;
  });

  test('recall >= 99% on known patterns', async () => {
    const config = buildSafetyConfig(defaultIntelligenceConfig());
    const result = await scrub(corpus, config, testContext());

    // Check each embedded item was redacted
    let detected = 0;
    let missed = 0;
    for (const item of manifest.embedded_items) {
      if (!result.text.includes(item.original_value)) {
        detected++;
      } else {
        missed++;
        console.warn(`MISSED: line ${item.line_number}, type=${item.pattern_type}`);
      }
    }

    const recall = detected / manifest.embedded_items.length;
    expect(recall).toBeGreaterThanOrEqual(0.99);
    // Zero false negatives on known patterns
    expect(missed).toBe(0);
  });

  test('false positive rate < 5%', async () => {
    const config = buildSafetyConfig(defaultIntelligenceConfig());
    const result = await scrub(corpus, config, testContext());

    // Count redactions in clean lines (lines not in manifest)
    const embeddedLines = new Set(manifest.embedded_items.map(i => i.line_number));
    const cleanLineRedactions = result.redactions.filter(r => {
      // Check if this redaction position falls on a clean line
      const lineNum = getLineNumber(corpus, r.position);
      return !embeddedLines.has(lineNum);
    });

    // Total clean lines: ~8,550
    // False positive rate = clean line redactions / total clean lines
    const fpRate = cleanLineRedactions.length / (manifest.total_lines - manifest.embedded_items.length);
    expect(fpRate).toBeLessThan(0.05);
  });

  test('performance < 2 seconds for 10K lines', async () => {
    const config = buildSafetyConfig(defaultIntelligenceConfig());
    const start = performance.now();
    await scrub(corpus, config, testContext());
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(2000); // NFR-002: <2s per 10K lines
  });
});
```

### Security Tests (TDD Section 8.5)

```typescript
describe('Security Audit Tests', () => {
  test('PII leak audit: zero PII in generated observation files', async () => {
    // 1. Run a mock observation cycle that produces report files
    // 2. Inject known PII into the mock MCP responses
    // 3. After the run, scan all generated files for the known PII values
    // 4. Expect zero matches

    const knownPII = [
      'john@example.com',
      '555-123-4567',
      '123-45-6789',
      '4111111111111111',
      '192.168.1.100',
    ];

    // Run mock observation
    await runMockObservation(knownPII);

    // Scan all generated files
    const generatedFiles = await glob('**/*.md', { cwd: observationsDir });
    for (const file of generatedFiles) {
      const content = await fs.readFile(path.join(observationsDir, file), 'utf-8');
      for (const pii of knownPII) {
        expect(content).not.toContain(pii);
      }
    }
  });

  test('secret leak audit: zero secrets in generated observation files', async () => {
    const knownSecrets = [
      'AKIAIOSFODNN7EXAMPLE',
      'sk_TESTONLY_testkey1234567890abcdef',
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',
    ];

    await runMockObservation(knownSecrets);

    const generatedFiles = await glob('**/*.md', { cwd: observationsDir });
    for (const file of generatedFiles) {
      const content = await fs.readFile(path.join(observationsDir, file), 'utf-8');
      for (const secret of knownSecrets) {
        expect(content).not.toContain(secret);
      }
    }
  });

  test('credential scan: no hardcoded credentials in config or reports', async () => {
    // Scan intelligence.yaml for anything that looks like a real credential
    const configContent = await fs.readFile(configPath, 'utf-8');
    expect(configContent).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(configContent).not.toMatch(/sk_TESTONLY_/);
    expect(configContent).not.toMatch(/ghp_[a-zA-Z0-9]{36}/);
    expect(configContent).not.toMatch(/xoxb-/);
    expect(configContent).not.toMatch(/Bearer [a-zA-Z0-9]/);

    // Scan all observation reports
    const reports = await glob('**/*.md', { cwd: observationsDir });
    for (const report of reports) {
      const content = await fs.readFile(path.join(observationsDir, report), 'utf-8');
      expect(content).not.toMatch(/AKIA[0-9A-Z]{16}/);
      expect(content).not.toMatch(/sk_TESTONLY_/);
      expect(content).not.toMatch(/ghp_[a-zA-Z0-9]{36}/);
    }
  });
});
```

## Acceptance Criteria

1. Test corpus contains exactly 10,000 log lines with the distribution from TDD section 8.3 (500 emails, 200 phones, 50 SSNs, 100 credit cards, 150 IPs, 50 AWS keys, 30 GitHub tokens, 20 Stripe keys, 100 Bearer tokens, 50 JWTs, 200 high-entropy strings).
2. Corpus manifest tracks every embedded PII/secret with its line number, type, original value, and expected replacement.
3. Recall >= 99% on known patterns (NFR-009). Ideally zero false negatives on explicitly embedded items.
4. False positive rate < 5% (legitimate clean-line text misidentified as PII).
5. Performance < 2 seconds for the full 10K-line corpus (NFR-002).
6. PII leak audit: after a mock observation run with injected PII, zero known PII values appear in any generated file.
7. Secret leak audit: same, zero known secret values appear in any generated file.
8. Credential scan: `intelligence.yaml` and all observation reports contain no hardcoded credentials matching known patterns.
9. Any PII/secret discovered by the weekly audit in production is added to the corpus as a regression test case.

## Test Cases

| ID | Test | Input | Expected |
|----|------|-------|----------|
| TC-2-4-01 | Corpus generation | Generate script | 10,000 lines, 1,450 embedded items |
| TC-2-4-02 | Recall >= 99% | Full corpus through `scrub()` | All 1,450 items redacted (0 false negatives) |
| TC-2-4-03 | False positive < 5% | Full corpus through `scrub()` | < 427 false redactions on clean lines (5% of ~8,550) |
| TC-2-4-04 | Performance < 2s | Full corpus through `scrub()` | `elapsed < 2000ms` |
| TC-2-4-05 | PII leak audit | Mock run with 5 injected PII values | 0 of 5 PII values found in output files |
| TC-2-4-06 | Secret leak audit | Mock run with 3 injected secrets | 0 of 3 secrets found in output files |
| TC-2-4-07 | Credential scan config | Scan `intelligence.yaml` | No matches for credential patterns |
| TC-2-4-08 | Credential scan reports | Scan all `.md` in observations/ | No matches for credential patterns |
| TC-2-4-09 | Email recall detail | 500 embedded emails | 500 detected (100% recall on emails) |
| TC-2-4-10 | High-entropy recall | 200 embedded high-entropy strings | >= 198 detected (99% of 200) |
| TC-2-4-11 | Timestamps not flagged | Clean lines with ISO timestamps | Timestamps preserved (not flagged as IPv6) |
| TC-2-4-12 | Version numbers not flagged | Clean lines with `v2.0.1` or `2.0` | Not flagged as IP addresses |
