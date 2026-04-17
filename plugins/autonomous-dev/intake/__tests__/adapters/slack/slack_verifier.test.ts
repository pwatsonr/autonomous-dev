/**
 * Unit tests for SlackVerifier: HMAC-SHA256 signature verification with
 * replay attack prevention (SPEC-008-4-05, Task 16).
 *
 * Test cases (5 total):
 *  1. Valid signature (compute HMAC with known inputs).
 *  2. Invalid signature (wrong secret).
 *  3. Stale timestamp (> 5 minutes).
 *  4. Buffer length mismatch.
 *  5. Timing-safe comparison used.
 *
 * @module slack_verifier.test
 */

import crypto from 'crypto';
import { SlackVerifier } from '../../../adapters/slack/slack_verifier';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIGNING_SECRET = 'test-signing-secret-abcdef123456';

// ---------------------------------------------------------------------------
// Helper: compute a valid Slack signature
// ---------------------------------------------------------------------------

function computeSignature(secret: string, timestamp: string, body: string): string {
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac('sha256', secret).update(baseString).digest('hex');
  return `v0=${hmac}`;
}

// ---------------------------------------------------------------------------
// Setup: inject signing secret via environment variable
// ---------------------------------------------------------------------------

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv, SLACK_SIGNING_SECRET: SIGNING_SECRET };
});

afterEach(() => {
  process.env = originalEnv;
});

// Suppress stderr logging during tests
const originalStderr = process.stderr.write;
beforeAll(() => {
  process.stderr.write = jest.fn() as unknown as typeof process.stderr.write;
});
afterAll(() => {
  process.stderr.write = originalStderr;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SlackVerifier (SPEC-008-4-05, Task 16)', () => {
  // -----------------------------------------------------------------------
  // Test 1: Valid signature with known inputs
  // -----------------------------------------------------------------------
  test('accepts valid signature computed with the correct signing secret', () => {
    const verifier = new SlackVerifier();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = 'command=%2Fad-status&text=REQ-000001';
    const signature = computeSignature(SIGNING_SECRET, timestamp, body);

    expect(verifier.verify(timestamp, body, signature)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 2: Invalid signature (wrong secret)
  // -----------------------------------------------------------------------
  test('rejects invalid signature computed with wrong secret', () => {
    const verifier = new SlackVerifier();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = 'command=%2Fad-status&text=REQ-000001';
    const wrongSignature = computeSignature('wrong-secret', timestamp, body);

    expect(verifier.verify(timestamp, body, wrongSignature)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 3: Stale timestamp (> 5 minutes old)
  // -----------------------------------------------------------------------
  test('rejects stale timestamp older than 5 minutes', () => {
    const verifier = new SlackVerifier();
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 301);
    const body = 'command=%2Fad-status&text=REQ-000001';
    const signature = computeSignature(SIGNING_SECRET, staleTimestamp, body);

    expect(verifier.verify(staleTimestamp, body, signature)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 4: Buffer length mismatch
  // -----------------------------------------------------------------------
  test('rejects signature with mismatched buffer length', () => {
    const verifier = new SlackVerifier();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = 'command=%2Fad-status&text=REQ-000001';

    // Short signature that will cause timingSafeEqual to throw RangeError
    expect(verifier.verify(timestamp, body, 'v0=short')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 5: Timing-safe comparison is used (no timing leak)
  // -----------------------------------------------------------------------
  test('uses crypto.timingSafeEqual for comparison (spy verification)', () => {
    const timingSafeEqualSpy = jest.spyOn(crypto, 'timingSafeEqual');

    const verifier = new SlackVerifier();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = 'command=%2Fad-status&text=REQ-000001';
    const signature = computeSignature(SIGNING_SECRET, timestamp, body);

    verifier.verify(timestamp, body, signature);

    expect(timingSafeEqualSpy).toHaveBeenCalled();

    timingSafeEqualSpy.mockRestore();
  });

  // -----------------------------------------------------------------------
  // Bonus: Invalid (non-numeric) timestamp
  // -----------------------------------------------------------------------
  test('rejects invalid non-numeric timestamp', () => {
    const verifier = new SlackVerifier();
    const body = 'command=%2Fad-status&text=REQ-000001';

    expect(verifier.verify('not-a-number', body, 'v0=abc')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Bonus: Constructor throws when SLACK_SIGNING_SECRET is not set
  // -----------------------------------------------------------------------
  test('constructor throws when SLACK_SIGNING_SECRET is not set', () => {
    delete process.env.SLACK_SIGNING_SECRET;

    expect(() => new SlackVerifier()).toThrow('SLACK_SIGNING_SECRET');
  });
});
