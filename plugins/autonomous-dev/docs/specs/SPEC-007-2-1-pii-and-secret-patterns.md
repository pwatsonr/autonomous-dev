# SPEC-007-2-1: PII Scrubber & Secret Detector Pattern Libraries

## Metadata
- **Parent Plan**: PLAN-007-2
- **Tasks Covered**: Task 1 (PII scrubber), Task 2 (secret detector)
- **Estimated effort**: 16 hours

## Description

Implement the two regex-based scrubbing stages that form the core of the Data Safety Pipeline. Stage 1 (PII scrubber) covers 11 PII patterns. Stage 2 (secret detector) covers 15 secret patterns including a Shannon entropy-based generic detector. All patterns are deterministic (no LLM involvement) and each produces a specific replacement string that preserves the semantic category without retaining the original value.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/safety/pii-scrubber.ts` | Create | Stage 1: 11 PII regex patterns with replacement |
| `src/safety/secret-detector.ts` | Create | Stage 2: 15 secret regex patterns with replacement |
| `src/safety/entropy.ts` | Create | Shannon entropy calculator for generic high-entropy detection |
| `src/safety/types.ts` | Create | `Redaction`, `PatternDefinition`, `ScrubStageResult` types |
| `tests/safety/pii-scrubber.test.ts` | Create | Per-pattern positive, negative, and edge-case tests |
| `tests/safety/secret-detector.test.ts` | Create | Per-pattern positive, negative, and edge-case tests |
| `tests/safety/entropy.test.ts` | Create | Entropy calculation tests |

## Implementation Details

### Task 1: PII Scrubber (Stage 1)

All 11 patterns with their exact regex and replacement strings from TDD section 3.4.2.

```typescript
interface PatternDefinition {
  name: string;
  type: string;           // Used in [REDACTED:<type>]
  regex: RegExp;
  replacement: string;
  contextRequired?: {     // For context-aware patterns (UUID)
    fieldNames: string[];
  };
  falsePositiveCheck?: (match: string, context: string) => boolean;
}

const PII_PATTERNS: PatternDefinition[] = [
  {
    name: 'email',
    type: 'email',
    regex: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
    replacement: '[REDACTED:email]',
  },
  {
    name: 'phone_us',
    type: 'phone',
    regex: /\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
    replacement: '[REDACTED:phone]',
  },
  {
    name: 'phone_intl',
    type: 'phone',
    regex: /\+\d{1,3}[-.\s]?\d{4,14}/g,
    replacement: '[REDACTED:phone]',
  },
  {
    name: 'ssn',
    type: 'ssn',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: '[REDACTED:ssn]',
  },
  {
    name: 'credit_card',
    type: 'credit_card',
    regex: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
    replacement: '[REDACTED:credit_card]',
  },
  {
    name: 'credit_card_amex',
    type: 'credit_card',
    regex: /\b3[47]\d{2}[-\s]?\d{6}[-\s]?\d{5}\b/g,
    replacement: '[REDACTED:credit_card]',
  },
  {
    name: 'ipv4',
    type: 'ip',
    regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    replacement: '[REDACTED:ip]',
  },
  {
    name: 'ipv6_full',
    type: 'ip',
    regex: /\b([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g,
    replacement: '[REDACTED:ip]',
  },
  {
    name: 'ipv6_compressed',
    type: 'ip',
    regex: /\b([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\b/g,
    replacement: '[REDACTED:ip]',
    falsePositiveCheck: (match: string, _context: string): boolean => {
      // Reject matches that look like timestamps (HH:MM:SS or HH:MM:SS.mmm)
      const timestampPattern = /^\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?$/;
      if (timestampPattern.test(match)) return true; // IS a false positive
      // Reject if it matches ISO 8601 time portion
      const isoTimePattern = /^\d{2}:\d{2}:\d{2}/;
      if (isoTimePattern.test(match)) return true;
      return false; // NOT a false positive, proceed with redaction
    },
  },
  {
    name: 'jwt',
    type: 'jwt',
    regex: /\beyJ[a-zA-Z0-9\-_]+\.eyJ[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+\b/g,
    replacement: '[REDACTED:jwt]',
  },
  {
    name: 'uuid_user_context',
    type: 'user_id',
    regex: /(?<=(?:user_id|customer_id|account_id)\s*[=:]\s*)[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
    replacement: '[REDACTED:user_id]',
    contextRequired: {
      fieldNames: ['user_id', 'customer_id', 'account_id'],
    },
  },
];
```

**Execution order**: Patterns are applied in the order listed above. This order matters because:
- Email runs before IPv6 compressed (an email's domain could superficially match IPv6 compressed)
- US phone runs before international phone (US is more specific)
- Credit card Amex runs after standard credit card (Amex pattern is more specific with `3[47]` prefix)

**IPv6 compressed false-positive validation**: The `falsePositiveCheck` function validates matches against known timestamp formats. Matches that look like `14:30:22` or `10:00:00.000` are NOT redacted.

**Context-aware UUID**: The UUID pattern uses a lookbehind assertion to only match UUIDs preceded by `user_id=`, `customer_id=`, or `account_id=`. Generic UUIDs (trace IDs, request IDs) are NOT redacted.

### Task 2: Secret Detector (Stage 2)

All 15 secret patterns from TDD section 3.4.3.

```typescript
const SECRET_PATTERNS: PatternDefinition[] = [
  {
    name: 'aws_access_key',
    type: 'secret',
    regex: /AKIA[0-9A-Z]{16}/g,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'aws_secret_key',
    type: 'secret',
    regex: /(?i)aws_secret_access_key\s*[=:]\s*[A-Za-z0-9/+=]{40}/gi,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'stripe_secret',
    type: 'secret',
    regex: /sk_TESTONLY_[a-zA-Z0-9]{24,}/g,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'stripe_publishable',
    type: 'secret',
    regex: /pk_TESTONLY_[a-zA-Z0-9]{24,}/g,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'github_pat',
    type: 'secret',
    regex: /ghp_[a-zA-Z0-9]{36}/g,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'github_app',
    type: 'secret',
    regex: /ghs_[a-zA-Z0-9]{36}/g,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'github_oauth',
    type: 'secret',
    regex: /gho_[a-zA-Z0-9]{36}/g,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'gitlab_pat',
    type: 'secret',
    regex: /glpat-[a-zA-Z0-9\-]{20,}/g,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'gcp_service_account',
    type: 'secret',
    regex: /"private_key":\s*"-----BEGIN [A-Z ]+ KEY-----/g,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'gcp_api_key',
    type: 'secret',
    regex: /AIza[0-9A-Za-z\-_]{35}/g,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'slack_bot_token',
    type: 'secret',
    regex: /xoxb-[0-9]{10,}-[a-zA-Z0-9]{24,}/g,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'slack_webhook',
    type: 'secret',
    regex: /https:\/\/hooks\.slack\.com\/services\/T[a-zA-Z0-9]+\/B[a-zA-Z0-9]+\/[a-zA-Z0-9]+/g,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'generic_bearer',
    type: 'secret',
    regex: /(?:bearer|Bearer|BEARER)\s+[a-zA-Z0-9\-_.~+/]+=*/gi,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'basic_auth',
    type: 'secret',
    regex: /(?:basic|Basic|BASIC)\s+[a-zA-Z0-9+/]+=*/gi,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'private_key_block',
    type: 'secret',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    replacement: '[SECRET_REDACTED]',
  },
];
```

**Generic high-entropy detector** (separate from the pattern list, runs last):

```typescript
// src/safety/entropy.ts

function shannonEntropy(s: string): number {
  const freq: Record<string, number> = {};
  for (const c of s) {
    freq[c] = (freq[c] || 0) + 1;
  }
  let entropy = 0;
  const len = s.length;
  for (const count of Object.values(freq)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const HIGH_ENTROPY_CONTEXT_REGEX =
  /(?:password|secret|token|key)\s*[=:]\s*(\S{20,})/gi;

function detectHighEntropySecrets(text: string): Redaction[] {
  const redactions: Redaction[] = [];
  let match;
  while ((match = HIGH_ENTROPY_CONTEXT_REGEX.exec(text)) !== null) {
    const value = match[1];
    if (value.length > 20 && shannonEntropy(value) > 4.5) {
      redactions.push({
        type: 'secret',
        position: match.index,
        original_length: match[0].length,
      });
    }
  }
  return redactions;
}
```

**Environment variable pattern** (preserves key name):

```typescript
const ENV_VAR_PATTERN: PatternDefinition = {
  name: 'env_var',
  type: 'secret',
  regex: /(?:.*_KEY|.*_SECRET|.*_TOKEN|.*_PASSWORD)\s*[=:]\s*\S+/gi,
  replacement: '', // Special handling: preserve key name
  // Custom replacement function:
  replaceFunc: (match: string): string => {
    const separatorIdx = match.search(/[=:]/);
    const keyPart = match.substring(0, separatorIdx + 1);
    return `${keyPart.trim()}=[SECRET_REDACTED]`;
  },
};
```

## Acceptance Criteria

1. All 11 PII patterns from TDD section 3.4.2 are implemented with exact regex from the TDD.
2. PII replacement strings match: `[REDACTED:email]`, `[REDACTED:phone]`, `[REDACTED:ssn]`, `[REDACTED:credit_card]`, `[REDACTED:ip]`, `[REDACTED:jwt]`, `[REDACTED:user_id]`.
3. IPv6 compressed pattern includes false-positive validation that rejects timestamp-like matches (`14:30:22`, `10:00:00.000`).
4. Context-aware UUID only redacts UUIDs in `user_id`, `customer_id`, `account_id` field contexts. Generic UUIDs (trace_id, request_id) pass through unchanged.
5. All 15 secret patterns from TDD section 3.4.3 are implemented.
6. Secret replacement string is `[SECRET_REDACTED]` for all patterns.
7. High-entropy detector computes Shannon entropy correctly: flags strings >20 chars with entropy >4.5 bits/char in `password=`/`secret=`/`token=`/`key=` contexts.
8. Environment variable pattern preserves the key name while replacing only the value: `MY_SECRET_KEY=abc123` becomes `MY_SECRET_KEY=[SECRET_REDACTED]`.
9. Each pattern is individually testable with positive matches, negative matches, and edge cases.

## Test Cases

### PII Pattern Tests

| ID | Test | Input | Expected |
|----|------|-------|----------|
| TC-2-1-01 | Email basic | `user john@example.com logged in` | `user [REDACTED:email] logged in` |
| TC-2-1-02 | Email with plus | `user john+tag@example.com` | `user [REDACTED:email]` |
| TC-2-1-03 | Non-email preserved | `version 2.0 is ready` | Unchanged (no `.` followed by TLD) |
| TC-2-1-04 | US phone with parens | `call (555) 123-4567` | `call [REDACTED:phone]` |
| TC-2-1-05 | US phone plain | `5551234567` | `[REDACTED:phone]` |
| TC-2-1-06 | Intl phone | `+44 7911 123456` | `[REDACTED:phone]` |
| TC-2-1-07 | Port number not phone | `listening on port 8080` | Unchanged |
| TC-2-1-08 | SSN | `ssn: 123-45-6789` | `ssn: [REDACTED:ssn]` |
| TC-2-1-09 | Date not SSN | `date: 2026-04-08` | Unchanged (not 3-2-4 format) |
| TC-2-1-10 | Visa credit card | `card 4111-1111-1111-1111` | `card [REDACTED:credit_card]` |
| TC-2-1-11 | Amex credit card | `card 3782 822463 10005` | `card [REDACTED:credit_card]` |
| TC-2-1-12 | IPv4 | `from 192.168.1.100` | `from [REDACTED:ip]` |
| TC-2-1-13 | IPv6 full | `addr 2001:0db8:85a3:0000:0000:8a2e:0370:7334` | `addr [REDACTED:ip]` |
| TC-2-1-14 | IPv6 compressed | `addr fe80::1` | `addr [REDACTED:ip]` |
| TC-2-1-15 | Timestamp not IPv6 | `time 14:30:22` | Unchanged (false positive check) |
| TC-2-1-16 | JWT | `token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.abc123def456` | `token [REDACTED:jwt]` |
| TC-2-1-17 | UUID user_id | `user_id=550e8400-e29b-41d4-a716-446655440000` | `user_id=[REDACTED:user_id]` |
| TC-2-1-18 | UUID trace_id preserved | `trace_id=550e8400-e29b-41d4-a716-446655440000` | Unchanged (not a user context) |

### Secret Pattern Tests

| ID | Test | Input | Expected |
|----|------|-------|----------|
| TC-2-1-20 | AWS access key | `key=AKIAIOSFODNN7EXAMPLE` | `key=[SECRET_REDACTED]` |
| TC-2-1-21 | AWS secret key | `aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` | `[SECRET_REDACTED]` |
| TC-2-1-22 | Stripe secret key | `sk_TESTONLY_abc123def456ghi789jkl012mnop` | `[SECRET_REDACTED]` |
| TC-2-1-23 | GitHub PAT | `ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij` | `[SECRET_REDACTED]` |
| TC-2-1-24 | GitLab PAT | `glpat-abc123def456ghi789jk` | `[SECRET_REDACTED]` |
| TC-2-1-25 | GCP API key | `AIzaSyA1234567890abcdefghijklmnopqrstuv` | `[SECRET_REDACTED]` |
| TC-2-1-26 | Slack bot token | `xoxb-FAKE-0000000-ABCDEFGHIJKLMNOPQRSTUVWXyz` | `[SECRET_REDACTED]` |
| TC-2-1-27 | Slack webhook | `https://hooks.slack.com/services/T12345/B67890/abcdef123456` | `[SECRET_REDACTED]` |
| TC-2-1-28 | Bearer token | `Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.abc.def` | `Authorization: [SECRET_REDACTED]` |
| TC-2-1-29 | Basic auth | `Authorization: Basic dXNlcjpwYXNz` | `Authorization: [SECRET_REDACTED]` |
| TC-2-1-30 | Private key block | `-----BEGIN RSA PRIVATE KEY-----` | `[SECRET_REDACTED]` |
| TC-2-1-31 | High entropy in context | `password=aB3$xY9!kL2@mN5^pQ8&rT1` (entropy > 4.5) | `password=[SECRET_REDACTED]` |
| TC-2-1-32 | Low entropy not flagged | `password=aaaaaaaaaaaaaaaaaaaaaa` (entropy ~0) | Unchanged |
| TC-2-1-33 | High entropy no context | `random_data aB3$xY9!kL2@mN5^pQ8&rT1` (no key= prefix) | Unchanged |
| TC-2-1-34 | Env var pattern | `MY_SECRET_KEY=super-secret-value123` | `MY_SECRET_KEY=[SECRET_REDACTED]` |
| TC-2-1-35 | Env var preserves name | `DATABASE_PASSWORD: hunter2` | `DATABASE_PASSWORD:[SECRET_REDACTED]` |

### Shannon Entropy Tests

| ID | Test | Input | Expected |
|----|------|-------|----------|
| TC-2-1-40 | All same chars | `aaaaaaaaaa` | Entropy = 0.0 |
| TC-2-1-41 | Two equal chars | `ababababab` | Entropy = 1.0 |
| TC-2-1-42 | High entropy string | `aB3$xY9!kL2@mN5^pQ8&rT1wZ` | Entropy > 4.5 |
| TC-2-1-43 | Base64 string | `dXNlcjpwYXNzd29yZA==` | Entropy around 3.5-4.0 (below 4.5 threshold) |
| TC-2-1-44 | Random hex 32 chars | `a3f8c2d1e9b04f72a3f8c2d1e9b04f72` | Entropy around 3.5-4.0 (limited charset) |
