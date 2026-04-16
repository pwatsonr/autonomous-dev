/**
 * Slack Bot Module -- WebClient setup and lifecycle management.
 *
 * Configures the @slack/web-api WebClient with the bot token loaded from
 * the `SLACK_BOT_TOKEN` environment variable. Throws on missing token.
 *
 * Implements SPEC-008-4-01, Task 1 (client portion).
 *
 * @module slack_client
 */

import { WebClient } from '@slack/web-api';

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/**
 * Logger interface for structured logging within the Slack client.
 */
export interface SlackClientLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Default no-op logger (used when none is injected)
// ---------------------------------------------------------------------------

const noopLogger: SlackClientLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// SlackClient
// ---------------------------------------------------------------------------

/**
 * Manages the Slack Web API client lifecycle.
 *
 * - Loads the bot token from `SLACK_BOT_TOKEN` environment variable.
 * - Throws with a descriptive error if the variable is not set.
 * - Exposes {@link getClient} for use by the command and interaction handlers.
 */
export class SlackClient {
  private client: WebClient;
  private logger: SlackClientLogger;

  /**
   * @param logger Optional structured logger for diagnostic output.
   * @throws {Error} If `SLACK_BOT_TOKEN` is not set in the environment.
   */
  constructor(logger?: SlackClientLogger) {
    this.logger = logger ?? noopLogger;
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
      throw new Error('SLACK_BOT_TOKEN environment variable is not set');
    }
    this.client = new WebClient(token);
    this.logger.info('Slack WebClient initialized');
  }

  /**
   * Return the underlying @slack/web-api WebClient instance.
   *
   * Used by command handlers, interaction handlers, and the notification
   * system to interact with the Slack API.
   */
  getClient(): WebClient {
    return this.client;
  }
}
