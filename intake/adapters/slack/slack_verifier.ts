/**
 * Slack Request Signature Verification -- HMAC-SHA256 with replay prevention.
 *
 * Implements SPEC-008-4-01, Task 3.
 *
 * Security properties:
 * - Replay prevention: rejects requests with timestamps older than 5 minutes.
 * - Constant-time comparison: uses `crypto.timingSafeEqual` to prevent timing attacks.
 * - Buffer length mismatch: catches `RangeError` from `timingSafeEqual` when
 *   signature lengths differ (returns false, never crashes).
 *
 * @module slack_verifier
 */

import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/**
 * Logger interface for structured logging within the Slack verifier.
 */
export interface SlackVerifierLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Default no-op logger (used when none is injected)
// ---------------------------------------------------------------------------

const noopLogger: SlackVerifierLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum age (in seconds) of a valid Slack request timestamp. */
const MAX_TIMESTAMP_AGE_SECONDS = 300; // 5 minutes

// ---------------------------------------------------------------------------
// SlackVerifier
// ---------------------------------------------------------------------------

/**
 * Verifies the authenticity of incoming Slack HTTP requests using
 * HMAC-SHA256 signature verification.
 *
 * The signing secret is loaded from the `SLACK_SIGNING_SECRET` environment
 * variable. If the variable is not set, the constructor throws.
 *
 * Usage:
 * ```typescript
 * const verifier = new SlackVerifier();
 * const isValid = verifier.verify(timestamp, rawBody, signature);
 * ```
 */
export class SlackVerifier {
  private signingSecret: string;
  private logger: SlackVerifierLogger;

  /**
   * @param logger Optional structured logger for diagnostic output.
   * @throws {Error} If `SLACK_SIGNING_SECRET` is not set in the environment.
   */
  constructor(logger?: SlackVerifierLogger) {
    this.logger = logger ?? noopLogger;
    this.signingSecret = process.env.SLACK_SIGNING_SECRET ?? '';
    if (!this.signingSecret) {
      throw new Error('SLACK_SIGNING_SECRET environment variable is not set');
    }
  }

  /**
   * Verify a Slack request signature.
   *
   * @param timestamp  The `X-Slack-Request-Timestamp` header value (Unix epoch seconds).
   * @param body       The raw request body string (before any parsing).
   * @param signature  The `X-Slack-Signature` header value (e.g. `v0=abc123...`).
   * @returns `true` if the signature is valid and the timestamp is fresh; `false` otherwise.
   */
  verify(timestamp: string, body: string, signature: string): boolean {
    // -----------------------------------------------------------------------
    // Replay attack prevention: reject if timestamp > 5 minutes old
    // -----------------------------------------------------------------------
    const requestTimestamp = parseInt(timestamp, 10);
    if (isNaN(requestTimestamp)) {
      this.logger.warn('Slack request rejected: invalid timestamp', { timestamp });
      return false;
    }

    const fiveMinutesAgo = Math.floor(Date.now() / 1000) - MAX_TIMESTAMP_AGE_SECONDS;
    if (requestTimestamp < fiveMinutesAgo) {
      this.logger.warn('Slack request rejected: stale timestamp', {
        timestamp,
        age: Math.floor(Date.now() / 1000) - requestTimestamp,
      });
      return false;
    }

    // -----------------------------------------------------------------------
    // Compute expected HMAC-SHA256
    // -----------------------------------------------------------------------
    const baseString = `v0:${timestamp}:${body}`;
    const hmac = crypto
      .createHmac('sha256', this.signingSecret)
      .update(baseString)
      .digest('hex');
    const expectedSignature = `v0=${hmac}`;

    // -----------------------------------------------------------------------
    // Constant-time comparison (prevents timing attacks)
    // -----------------------------------------------------------------------
    try {
      return crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(signature),
      );
    } catch {
      // Buffer length mismatch -- signatures have different lengths
      this.logger.warn('Slack request rejected: signature length mismatch', {
        expectedLength: expectedSignature.length,
        receivedLength: signature.length,
      });
      return false;
    }
  }
}
