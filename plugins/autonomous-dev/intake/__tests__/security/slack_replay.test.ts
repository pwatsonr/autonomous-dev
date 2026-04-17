/**
 * Security test: Slack Replay Attack Prevention (SPEC-008-4-05, Task 18).
 *
 * Validates that the SlackVerifier correctly prevents replay attacks by:
 *  1. Rejecting stale timestamps (> 5 minutes old).
 *  2. Rejecting invalid signatures.
 *  3. Accepting valid signatures with recent timestamps.
 *
 * @module slack_replay.test
 */

import crypto from 'crypto';
import { SlackVerifier } from '../../adapters/slack/slack_verifier';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const signingSecret = 'replay-test-signing-secret-xyz789';

// ---------------------------------------------------------------------------
// Helper: compute a valid Slack HMAC-SHA256 signature
// ---------------------------------------------------------------------------

function computeSignature(secret: string, timestamp: string, body: string): string {
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac('sha256', secret).update(baseString).digest('hex');
  return `v0=${hmac}`;
}

// ---------------------------------------------------------------------------
// Environment setup
// ---------------------------------------------------------------------------

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv, SLACK_SIGNING_SECRET: signingSecret };
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

describe('Slack Replay Attack Prevention', () => {
  // -----------------------------------------------------------------------
  // Test 1: Rejects stale timestamp (> 5 minutes)
  // -----------------------------------------------------------------------
  test('rejects stale timestamp (> 5 minutes)', () => {
    const verifier = new SlackVerifier();
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 301);
    const body = 'command=%2Fad-status&text=REQ-000001';
    const validSig = computeSignature(signingSecret, staleTimestamp, body);

    expect(verifier.verify(staleTimestamp, body, validSig)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 2: Rejects invalid signature
  // -----------------------------------------------------------------------
  test('rejects invalid signature', () => {
    const verifier = new SlackVerifier();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = 'command=%2Fad-status&text=REQ-000001';

    expect(verifier.verify(timestamp, body, 'v0=invalidsignature')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 3: Accepts valid signature with recent timestamp
  // -----------------------------------------------------------------------
  test('accepts valid signature with recent timestamp', () => {
    const verifier = new SlackVerifier();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = 'command=%2Fad-status&text=REQ-000001';
    const validSig = computeSignature(signingSecret, timestamp, body);

    expect(verifier.verify(timestamp, body, validSig)).toBe(true);
  });
});
