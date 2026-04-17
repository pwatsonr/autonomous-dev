/**
 * Corpus Generator — Produces a 10,000-line synthetic test corpus with
 * known PII and secret instances embedded at tracked positions.
 *
 * Distribution follows TDD section 8.3 / SPEC-007-2-4:
 *   500 emails, 150 US phones, 50 intl phones, 50 SSNs, 80 credit cards
 *   (16-digit), 20 Amex, 120 IPv4, 15 IPv6 full, 15 IPv6 compressed,
 *   50 AWS keys, 30 GitHub tokens, 20 Stripe keys, 100 Bearer tokens,
 *   50 JWTs, 200 high-entropy strings = 1,450 embedded items.
 *   ~8,550 clean lines.
 *
 * Each embedded instance is tracked in a manifest for validation.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbeddedItem {
  line_number: number;
  pattern_type: string;
  original_value: string;
  expected_replacement: string;
  position_in_line: number;
}

export interface CorpusManifest {
  total_lines: number;
  embedded_items: EmbeddedItem[];
}

export interface GeneratedCorpus {
  text: string;
  manifest: CorpusManifest;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (Mulberry32) — reproducible corpus on every run
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Value generators — produce realistic-looking test data
// ---------------------------------------------------------------------------

function randomDigits(rng: () => number, count: number): string {
  let result = '';
  for (let i = 0; i < count; i++) {
    result += Math.floor(rng() * 10).toString();
  }
  return result;
}

function randomAlphaNum(rng: () => number, count: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < count; i++) {
    result += chars[Math.floor(rng() * chars.length)];
  }
  return result;
}

function randomUpperAlphaNum(rng: () => number, count: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < count; i++) {
    result += chars[Math.floor(rng() * chars.length)];
  }
  return result;
}

function randomHex(rng: () => number, count: number): string {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < count; i++) {
    result += chars[Math.floor(rng() * chars.length)];
  }
  return result;
}

function randomHighEntropyValue(rng: () => number): string {
  const specials = '!@#$%^&*';
  const all = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  let result = '';
  // Ensure high entropy: mix of upper, lower, digit, special
  const guaranteed = [
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(rng() * 26)],
    'abcdefghijklmnopqrstuvwxyz'[Math.floor(rng() * 26)],
    '0123456789'[Math.floor(rng() * 10)],
    specials[Math.floor(rng() * specials.length)],
  ];
  for (const c of guaranteed) result += c;
  const remaining = 21 + Math.floor(rng() * 5); // 25-29 chars total
  for (let i = 0; i < remaining; i++) {
    result += all[Math.floor(rng() * all.length)];
  }
  return result;
}

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

// ---------------------------------------------------------------------------
// PII value generators
// ---------------------------------------------------------------------------

const EMAIL_DOMAINS = [
  'example.com', 'company.com', 'test.org', 'sub.domain.co.uk',
  'mail.example.net', 'corp.io', 'example.org',
];

const EMAIL_NAMES = [
  'john.doe', 'jane.smith', 'admin', 'user', 'bob', 'alice',
  'admin+test', 'first.last', 'user_name-123', 'support',
  'noreply', 'info', 'contact', 'help', 'sales', 'dev',
];

function generateEmail(rng: () => number): string {
  return `${pick(rng, EMAIL_NAMES)}@${pick(rng, EMAIL_DOMAINS)}`;
}

function generateUSPhone(rng: () => number): string {
  const formats = [
    () => `(${randomDigits(rng, 3)}) ${randomDigits(rng, 3)}-${randomDigits(rng, 4)}`,
    () => `+1-${randomDigits(rng, 3)}-${randomDigits(rng, 3)}-${randomDigits(rng, 4)}`,
    () => `${randomDigits(rng, 3)}-${randomDigits(rng, 3)}-${randomDigits(rng, 4)}`,
    () => `${randomDigits(rng, 3)}.${randomDigits(rng, 3)}.${randomDigits(rng, 4)}`,
    () => `${randomDigits(rng, 10)}`,
  ];
  return pick(rng, formats)();
}

function generateIntlPhone(rng: () => number): string {
  const codes = ['+44', '+49', '+81', '+33', '+61', '+86'];
  const code = pick(rng, codes);
  return `${code} ${randomDigits(rng, 4)}${randomDigits(rng, 4)}`;
}

function generateSSN(rng: () => number): string {
  return `${randomDigits(rng, 3)}-${randomDigits(rng, 2)}-${randomDigits(rng, 4)}`;
}

function generateCreditCard(rng: () => number): string {
  const prefixes = ['4111', '5500', '4222', '5105'];
  const prefix = pick(rng, prefixes);
  const formats = [
    () => `${prefix}-${randomDigits(rng, 4)}-${randomDigits(rng, 4)}-${randomDigits(rng, 4)}`,
    () => `${prefix} ${randomDigits(rng, 4)} ${randomDigits(rng, 4)} ${randomDigits(rng, 4)}`,
    () => `${prefix}${randomDigits(rng, 12)}`,
  ];
  return pick(rng, formats)();
}

function generateAmex(rng: () => number): string {
  const prefix = rng() > 0.5 ? '3782' : '3714';
  const formats = [
    () => `${prefix} ${randomDigits(rng, 6)} ${randomDigits(rng, 5)}`,
    () => `${prefix}-${randomDigits(rng, 6)}-${randomDigits(rng, 5)}`,
  ];
  return pick(rng, formats)();
}

function generateIPv4(rng: () => number): string {
  const octets = [
    Math.floor(rng() * 223) + 1, // 1-223
    Math.floor(rng() * 256),
    Math.floor(rng() * 256),
    Math.floor(rng() * 254) + 1, // 1-254
  ];
  return octets.join('.');
}

function generateIPv6Full(rng: () => number): string {
  const groups: string[] = [];
  for (let i = 0; i < 8; i++) {
    groups.push(randomHex(rng, 4));
  }
  return groups.join(':');
}

function generateIPv6Compressed(rng: () => number): string {
  const options = [
    () => `fe80::${randomHex(rng, 1)}`,
    () => `2001:db8::${randomHex(rng, 4)}`,
    () => `::${randomHex(rng, 1)}`,
    () => `fe80::${randomHex(rng, 4)}:${randomHex(rng, 4)}`,
  ];
  return pick(rng, options)();
}

// ---------------------------------------------------------------------------
// Secret value generators
// ---------------------------------------------------------------------------

function generateAWSAccessKey(rng: () => number): string {
  return `AKIA${randomUpperAlphaNum(rng, 16)}`;
}

function generateGitHubToken(rng: () => number): string {
  return `ghp_${randomAlphaNum(rng, 36)}`;
}

function generateStripeKey(rng: () => number): string {
  return `sk_TESTONLY_${randomAlphaNum(rng, 24)}`;
}

function generateBearerToken(rng: () => number): string {
  return `Bearer ${randomAlphaNum(rng, 32)}`;
}

function generateJWT(_rng: () => number): string {
  // JWTs have three base64url-encoded parts: header.payload.signature
  // The header and payload must start with 'eyJ' (base64url of '{"')
  return `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.${randomAlphaNum(_rng, 20)}`;
}

function generateHighEntropySecret(rng: () => number): string {
  const contexts = ['password', 'secret', 'token', 'key'];
  const context = pick(rng, contexts);
  const value = randomHighEntropyValue(rng);
  return `${context}=${value}`;
}

// ---------------------------------------------------------------------------
// Clean log line templates
// ---------------------------------------------------------------------------

const LOG_LEVELS = ['INFO', 'DEBUG', 'WARN', 'ERROR', 'TRACE'];

const CLEAN_TEMPLATES = [
  (rng: () => number) =>
    `Request completed method=${pick(rng, ['GET', 'POST', 'PUT', 'DELETE'])} path=/api/v2/${pick(rng, ['orders', 'users', 'products', 'health'])} status=${pick(rng, ['200', '201', '204', '301', '304'])} duration=${Math.floor(rng() * 500)}ms`,
  (rng: () => number) =>
    `Cache ${pick(rng, ['hit', 'miss'])} for key=${pick(rng, ['orders', 'users', 'products'])}:page:${Math.floor(rng() * 100)} ttl=${Math.floor(rng() * 600)}s`,
  (rng: () => number) =>
    `Connection pool status pool=${pick(rng, ['orders-db', 'users-db', 'cache-redis', 'analytics-db'])} active=${Math.floor(rng() * 50)} max=50`,
  (rng: () => number) =>
    `Health check passed service=${pick(rng, ['api-gateway', 'auth-service', 'payment-service', 'notification-service'])} uptime=${Math.floor(rng() * 720)}h`,
  (rng: () => number) =>
    `Deployment started version=v${Math.floor(rng() * 10)}.${Math.floor(rng() * 20)}.${Math.floor(rng() * 100)} environment=${pick(rng, ['staging', 'production', 'canary'])}`,
  (rng: () => number) =>
    `Rate limit check client=${pick(rng, ['web-app', 'mobile-ios', 'mobile-android', 'partner-api'])} remaining=${Math.floor(rng() * 1000)} window=60s`,
  (rng: () => number) =>
    `Database query completed table=${pick(rng, ['orders', 'users', 'products', 'inventory'])} rows=${Math.floor(rng() * 10000)} latency=${Math.floor(rng() * 200)}ms`,
  (rng: () => number) =>
    `Message processed queue=${pick(rng, ['order-events', 'user-notifications', 'analytics-ingest'])} partition=${Math.floor(rng() * 12)} offset=${Math.floor(rng() * 1000000)}`,
  (rng: () => number) =>
    `Circuit breaker status service=${pick(rng, ['payment-provider', 'email-service', 'sms-gateway'])} state=${pick(rng, ['closed', 'half-open'])} failures=0`,
  (rng: () => number) =>
    `Batch job completed job=${pick(rng, ['daily-report', 'data-export', 'cleanup', 'reindex'])} records=${Math.floor(rng() * 50000)} elapsed=${Math.floor(rng() * 30)}s`,
  (rng: () => number) =>
    `TLS handshake completed protocol=${pick(rng, ['TLSv1.2', 'TLSv1.3'])} cipher=${pick(rng, ['AES256-GCM-SHA384', 'CHACHA20-POLY1305'])}`,
  (rng: () => number) =>
    `Worker thread status thread_id=${Math.floor(rng() * 16)} tasks_completed=${Math.floor(rng() * 10000)} queue_depth=${Math.floor(rng() * 100)}`,
  (rng: () => number) =>
    `Retry attempt operation=${pick(rng, ['send_email', 'process_payment', 'sync_data'])} attempt=${Math.floor(rng() * 3) + 1} max_retries=3`,
  (rng: () => number) =>
    `Feature flag evaluated flag=${pick(rng, ['new-checkout', 'dark-mode', 'beta-search', 'v2-api'])} enabled=${pick(rng, ['true', 'false'])} user_segment=${pick(rng, ['all', 'beta', 'internal'])}`,
  (rng: () => number) =>
    `Garbage collection completed generation=${pick(rng, ['young', 'old'])} freed=${Math.floor(rng() * 512)}MB elapsed=${Math.floor(rng() * 50)}ms`,
];

// Dirty line templates — each takes the sensitive value and embeds it
const DIRTY_TEMPLATES: Record<string, ((rng: () => number, value: string) => string)[]> = {
  email: [
    (rng, v) => `Authentication failed for user ${v} from client=${pick(rng, ['web', 'mobile'])}`,
    (rng, v) => `Password reset requested by ${v} origin=${pick(rng, ['web', 'api'])}`,
    (_rng, v) => `Notification sent to ${v} template=welcome`,
    (_rng, v) => `User profile updated email=${v} fields=["name","avatar"]`,
    (rng, v) => `Login successful user=${v} method=${pick(rng, ['password', 'oauth', 'sso'])}`,
  ],
  phone_us: [
    (_rng, v) => `SMS verification sent to ${v} status=pending`,
    (_rng, v) => `Phone verification: calling ${v}`,
    (_rng, v) => `Contact info updated phone=${v}`,
  ],
  phone_intl: [
    (_rng, v) => `International SMS sent to ${v} provider=twilio`,
    (_rng, v) => `Verification call dispatched to ${v}`,
  ],
  ssn: [
    (_rng, v) => `Identity verification ssn=${v} status=pending`,
    (_rng, v) => `KYC check submitted document_number=${v}`,
  ],
  credit_card: [
    (rng, v) => `Payment processed card=${v} amount=$${(rng() * 1000).toFixed(2)}`,
    (_rng, v) => `Card validation failed card_number=${v} reason=expired`,
  ],
  credit_card_amex: [
    (rng, v) => `Amex payment card=${v} amount=$${(rng() * 1000).toFixed(2)}`,
    (_rng, v) => `Card on file updated card=${v}`,
  ],
  ipv4: [
    (rng, v) => `Connection from ${v} port=${Math.floor(rng() * 65535)}`,
    (_rng, v) => `Rate limited client_ip=${v} reason=too_many_requests`,
    (_rng, v) => `Firewall rule matched source=${v} action=allow`,
  ],
  ipv6_full: [
    (_rng, v) => `IPv6 connection established from ${v}`,
    (_rng, v) => `Peer address: ${v}`,
  ],
  ipv6_compressed: [
    (_rng, v) => `Listening on ${v}`,
    (_rng, v) => `IPv6 peer: ${v}`,
  ],
  aws_access_key: [
    (_rng, v) => `AWS API call with access_key=${v}`,
    (_rng, v) => `Credential detected: ${v}`,
  ],
  github_pat: [
    (_rng, v) => `GitHub API authenticated with token ${v}`,
    (_rng, v) => `git clone using pat=${v}`,
  ],
  stripe_secret: [
    (_rng, v) => `Stripe API initialized with key ${v}`,
    (_rng, v) => `Payment gateway config stripe_key=${v}`,
  ],
  bearer: [
    (_rng, v) => `Authorization: ${v}`,
    (_rng, v) => `Token refresh: ${v}`,
  ],
  jwt: [
    (_rng, v) => `JWT validated token=${v}`,
    (_rng, v) => `Session token: ${v}`,
  ],
  high_entropy: [
    (_rng, v) => `Config loaded: ${v}`,
    (_rng, v) => `Environment variable ${v}`,
  ],
};

// ---------------------------------------------------------------------------
// Timestamp generator
// ---------------------------------------------------------------------------

function generateTimestamp(rng: () => number): string {
  const hour = String(Math.floor(rng() * 24)).padStart(2, '0');
  const min = String(Math.floor(rng() * 60)).padStart(2, '0');
  const sec = String(Math.floor(rng() * 60)).padStart(2, '0');
  const ms = String(Math.floor(rng() * 1000)).padStart(3, '0');
  return `2026-04-08T${hour}:${min}:${sec}.${ms}Z`;
}

// ---------------------------------------------------------------------------
// Main corpus generation
// ---------------------------------------------------------------------------

/**
 * Distribution specification — count of each pattern type to embed.
 */
const DISTRIBUTION: { type: string; count: number; generator: (rng: () => number) => string; expectedReplacement: string }[] = [
  { type: 'email', count: 500, generator: generateEmail, expectedReplacement: '[REDACTED:email]' },
  { type: 'phone_us', count: 150, generator: generateUSPhone, expectedReplacement: '[REDACTED:phone]' },
  { type: 'phone_intl', count: 50, generator: generateIntlPhone, expectedReplacement: '[REDACTED:phone]' },
  { type: 'ssn', count: 50, generator: generateSSN, expectedReplacement: '[REDACTED:ssn]' },
  { type: 'credit_card', count: 80, generator: generateCreditCard, expectedReplacement: '[REDACTED:credit_card]' },
  { type: 'credit_card_amex', count: 20, generator: generateAmex, expectedReplacement: '[REDACTED:credit_card]' },
  { type: 'ipv4', count: 120, generator: generateIPv4, expectedReplacement: '[REDACTED:ip]' },
  { type: 'ipv6_full', count: 15, generator: generateIPv6Full, expectedReplacement: '[REDACTED:ip]' },
  { type: 'ipv6_compressed', count: 15, generator: generateIPv6Compressed, expectedReplacement: '[REDACTED:ip]' },
  { type: 'aws_access_key', count: 50, generator: generateAWSAccessKey, expectedReplacement: '[SECRET_REDACTED]' },
  { type: 'github_pat', count: 30, generator: generateGitHubToken, expectedReplacement: '[SECRET_REDACTED]' },
  { type: 'stripe_secret', count: 20, generator: generateStripeKey, expectedReplacement: '[SECRET_REDACTED]' },
  { type: 'bearer', count: 100, generator: generateBearerToken, expectedReplacement: '[SECRET_REDACTED]' },
  { type: 'jwt', count: 50, generator: generateJWT, expectedReplacement: '[REDACTED:jwt]' },
  { type: 'high_entropy', count: 200, generator: generateHighEntropySecret, expectedReplacement: '[SECRET_REDACTED]' },
];

const TOTAL_LINES = 10_000;
const TOTAL_EMBEDDED = DISTRIBUTION.reduce((sum, d) => sum + d.count, 0); // 1,450

/**
 * Generate the 10K-line test corpus with known PII and secret instances.
 *
 * Uses a deterministic PRNG seeded with 42 for reproducibility.
 *
 * @param seed  Optional PRNG seed (default 42).
 * @returns The generated corpus text and its validation manifest.
 */
export function generateCorpus(seed: number = 42): GeneratedCorpus {
  const rng = mulberry32(seed);
  const embeddedItems: EmbeddedItem[] = [];

  // 1. Decide which line numbers will contain embedded PII/secrets.
  //    We spread them across the corpus to avoid clustering.
  const dirtyLineNumbers = new Set<number>();
  const allDirtyLines: { lineNumber: number; type: string; value: string; expectedReplacement: string }[] = [];

  for (const dist of DISTRIBUTION) {
    for (let i = 0; i < dist.count; i++) {
      let lineNum: number;
      do {
        lineNum = Math.floor(rng() * TOTAL_LINES);
      } while (dirtyLineNumbers.has(lineNum));
      dirtyLineNumbers.add(lineNum);

      const value = dist.generator(rng);
      allDirtyLines.push({
        lineNumber: lineNum,
        type: dist.type,
        value,
        expectedReplacement: dist.expectedReplacement,
      });
    }
  }

  // 2. Build a lookup map: lineNum -> dirty entry
  const dirtyMap = new Map<number, typeof allDirtyLines[0]>();
  for (const entry of allDirtyLines) {
    dirtyMap.set(entry.lineNumber, entry);
  }

  // 3. Generate all 10,000 lines
  const lines: string[] = [];
  for (let lineIdx = 0; lineIdx < TOTAL_LINES; lineIdx++) {
    const timestamp = generateTimestamp(rng);
    const level = pick(rng, LOG_LEVELS);

    const dirty = dirtyMap.get(lineIdx);
    if (dirty) {
      // Dirty line: embed the sensitive value using a template
      const templates = DIRTY_TEMPLATES[dirty.type] || DIRTY_TEMPLATES.email;
      const template = pick(rng, templates);
      const messageBody = template(rng, dirty.value);
      const line = `[${timestamp}] [${level}] ${messageBody}`;

      // Find the position of the original value in the line
      const posInLine = line.indexOf(dirty.value);

      embeddedItems.push({
        line_number: lineIdx,
        pattern_type: dirty.type,
        original_value: dirty.value,
        expected_replacement: dirty.expectedReplacement,
        position_in_line: posInLine,
      });

      lines.push(line);
    } else {
      // Clean line: normal operational log
      const template = pick(rng, CLEAN_TEMPLATES);
      const messageBody = template(rng);
      lines.push(`[${timestamp}] [${level}] ${messageBody}`);
    }
  }

  return {
    text: lines.join('\n'),
    manifest: {
      total_lines: TOTAL_LINES,
      embedded_items: embeddedItems,
    },
  };
}

/**
 * Helper: get the 0-based line number for a character offset in text.
 */
export function getLineNumber(text: string, charOffset: number): number {
  let lineNum = 0;
  for (let i = 0; i < charOffset && i < text.length; i++) {
    if (text[i] === '\n') lineNum++;
  }
  return lineNum;
}

/**
 * Write the generated corpus to a text file and manifest to a JSON file.
 *
 * This produces the `test-corpus.txt` artifact specified in SPEC-007-2-4.
 *
 * @param corpus  The generated corpus object.
 * @param dir     Directory to write files into.
 */
export async function writeCorpusToFile(
  corpus: GeneratedCorpus,
  dir: string,
): Promise<void> {
  const fs = await import('fs/promises');
  const path = await import('path');

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'test-corpus.txt'), corpus.text, 'utf-8');
  await fs.writeFile(
    path.join(dir, 'test-corpus-manifest.json'),
    JSON.stringify(corpus.manifest, null, 2),
    'utf-8',
  );
}

/** The total number of embedded items per the spec distribution. */
export { TOTAL_EMBEDDED, TOTAL_LINES };
