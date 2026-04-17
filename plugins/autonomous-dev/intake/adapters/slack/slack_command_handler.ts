/**
 * Slack Slash Command Endpoint Handler.
 *
 * Handles incoming Slack slash commands with the 3-second acknowledgment +
 * `response_url` follow-up pattern:
 *
 * - **Fast path** (< 2.5s): The router returns before the deadline, so the
 *   formatted result is sent as the inline HTTP 200 response.
 * - **Slow path** (>= 2.5s): An acknowledgment ("Processing your request...")
 *   is sent as the inline HTTP 200, and once the router completes, the final
 *   result is POSTed to the Slack `response_url`.
 *
 * All 10 commands are routed through the shared `IntakeRouter`.
 *
 * Implements SPEC-008-4-02, Task 5.
 *
 * @module slack_command_handler
 */

import { parseCommandArgs } from '../claude_arg_parser';
import type { SlackIdentityResolver } from './slack_identity';
import { AuthorizationError } from './slack_identity';
import type {
  CommandResult,
  IncomingCommand,
} from '../adapter_interface';

// ---------------------------------------------------------------------------
// Slack request / response types
// ---------------------------------------------------------------------------

/**
 * Minimal Express-like request interface.
 *
 * The `body` is expected to be the parsed `URLSearchParams` (or a plain
 * object with `.get()`) from the Slack slash command POST payload.
 */
export interface SlackCommandRequest {
  body: {
    get(key: string): string | null;
  };
}

/**
 * Minimal Express-like response interface.
 */
export interface SlackCommandResponse {
  status(code: number): SlackCommandResponse;
  json(data: unknown): void;
}

/**
 * Slack API response shape for slash command replies.
 */
export interface SlackResponse {
  response_type: 'in_channel' | 'ephemeral';
  blocks?: unknown[];
  text: string;
  replace_original?: boolean;
}

// ---------------------------------------------------------------------------
// Forward-declared dependency interfaces
// ---------------------------------------------------------------------------

/**
 * Router interface consumed by the command handler.
 *
 * The concrete implementation is in `intake/core/intake_router.ts`.
 */
export interface IntakeRouter {
  route(command: IncomingCommand): Promise<CommandResult>;
}

/**
 * Slack Block Kit formatter interface.
 *
 * Renders structured data into Slack Block Kit payloads.
 */
export interface SlackFormatter {
  formatStatusBlocks(data: unknown): unknown[];
}

/**
 * Minimal fetch function type for posting to response_url.
 *
 * Matches the signature of the global `fetch`. Injected for testability.
 */
export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

// ---------------------------------------------------------------------------
// Logger (structured JSON to stderr, matching codebase conventions)
// ---------------------------------------------------------------------------

const logger = {
  info(msg: string, data?: Record<string, unknown>): void {
    process.stderr.write(
      JSON.stringify({ level: 'info', msg, ...data, ts: new Date().toISOString() }) + '\n',
    );
  },
  warn(msg: string, data?: Record<string, unknown>): void {
    process.stderr.write(
      JSON.stringify({ level: 'warn', msg, ...data, ts: new Date().toISOString() }) + '\n',
    );
  },
  error(msg: string, data?: Record<string, unknown>): void {
    process.stderr.write(
      JSON.stringify({ level: 'error', msg, ...data, ts: new Date().toISOString() }) + '\n',
    );
  },
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Threshold in milliseconds for the "fast path" inline response.
 *
 * If the router returns within this window, the result is sent as the
 * HTTP 200 response body. Otherwise, an acknowledgment is sent and the
 * final result is POSTed to `response_url`.
 *
 * Set to 2500ms to leave a 500ms safety margin before Slack's 3-second
 * deadline for slash command responses.
 */
const FAST_THRESHOLD = 2500;

// ---------------------------------------------------------------------------
// SlackCommandHandler
// ---------------------------------------------------------------------------

/**
 * Handles Slack slash command HTTP requests.
 *
 * Flow:
 * 1. Parse the slash command payload from `req.body`.
 * 2. Strip the `/ad-` prefix to extract the command name.
 * 3. Resolve the Slack user to an internal identity.
 * 4. Parse the `text` field into args and flags using the shared parser.
 * 5. Construct an {@link IncomingCommand}.
 * 6. Race the router against the {@link FAST_THRESHOLD}:
 *    - Fast: respond inline.
 *    - Slow: acknowledge, then POST to `response_url`.
 * 7. Error handling preserves the same fast/slow split.
 */
export class SlackCommandHandler {
  private fetchFn: FetchFn;

  constructor(
    private router: IntakeRouter,
    private identityResolver: SlackIdentityResolver,
    private formatter: SlackFormatter,
    fetchFn?: FetchFn,
  ) {
    // Default to global fetch; tests can inject a mock
    this.fetchFn = fetchFn ?? globalFetch;
  }

  /**
   * Handle an incoming Slack slash command request.
   *
   * @param req - The Express-like request with Slack slash command body.
   * @param res - The Express-like response for sending the HTTP 200.
   */
  async handle(req: SlackCommandRequest, res: SlackCommandResponse): Promise<void> {
    const body = req.body;
    const command = body.get('command') ?? '';        // e.g., '/ad-submit'
    const text = body.get('text') ?? '';              // e.g., '"Build auth" --priority high'
    const userId = body.get('user_id') ?? '';
    const channelId = body.get('channel_id') ?? '';
    const responseUrl = body.get('response_url') ?? '';

    // Strip '/ad-' prefix to get command name
    const commandName = command.replace(/^\/ad-/, '');

    // Resolve identity
    let internalUserId: string;
    try {
      internalUserId = await this.identityResolver.resolve(userId);
    } catch (error) {
      const errMsg =
        error instanceof AuthorizationError
          ? error.message
          : (error as Error).message;
      res.status(200).json({
        response_type: 'ephemeral',
        text: `Authorization error: ${errMsg}`,
      } satisfies SlackResponse);
      return;
    }

    // Parse text into args and flags (reuse shared arg parser)
    const { args, flags } = parseCommandArgs(text);

    // Construct IncomingCommand
    const incomingCommand: IncomingCommand = {
      commandName,
      args,
      flags,
      rawText: text,
      source: {
        channelType: 'slack',
        userId: internalUserId,
        platformChannelId: channelId,
        timestamp: new Date(),
      },
    };

    // Acknowledge within 3 seconds using the fast/slow pattern
    const startTime = Date.now();

    try {
      const result = await Promise.race([
        this.router.route(incomingCommand),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), FAST_THRESHOLD),
        ),
      ]);

      if (result !== null) {
        // Fast path: respond inline
        const formatted = this.formatResult(commandName, result as CommandResult);
        res.status(200).json(formatted);
        return;
      }

      // Slow path: acknowledge and use response_url
      res.status(200).json({
        response_type: 'in_channel',
        text: 'Processing your request...',
      } satisfies SlackResponse);

      // Continue processing and post to response_url
      const finalResult = await this.router.route(incomingCommand);
      const formatted = this.formatResult(commandName, finalResult);
      await this.postToResponseUrl(responseUrl, {
        ...formatted,
        replace_original: true,
      });
    } catch (error) {
      const errMsg = (error as Error).message ?? 'Unknown error';

      // Error within 3 seconds: respond inline
      if (Date.now() - startTime < 3000) {
        res.status(200).json({
          response_type: 'ephemeral',
          text: `Error: ${errMsg}`,
        } satisfies SlackResponse);
      } else {
        // Error after ack: post to response_url
        await this.postToResponseUrl(responseUrl, {
          response_type: 'ephemeral',
          text: `Error: ${errMsg}`,
          replace_original: true,
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Private: result formatting
  // -----------------------------------------------------------------------

  /**
   * Format a {@link CommandResult} into a {@link SlackResponse}.
   *
   * Success results use `response_type: 'in_channel'` (visible to all).
   * Error results use `response_type: 'ephemeral'` (visible only to invoker).
   *
   * @param commandName - The command that was executed.
   * @param result      - The result from the IntakeRouter.
   * @returns A Slack-compatible response object.
   */
  private formatResult(commandName: string, result: CommandResult): SlackResponse {
    if (result.success) {
      const blocks = this.formatter.formatStatusBlocks(result.data);
      return { response_type: 'in_channel', blocks, text: '' };
    } else {
      return {
        response_type: 'ephemeral',
        text: `Error: ${result.error}`,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Private: response_url POST
  // -----------------------------------------------------------------------

  /**
   * POST a follow-up response to the Slack `response_url`.
   *
   * @param responseUrl - The Slack-provided response URL.
   * @param payload     - The JSON payload to send.
   */
  private async postToResponseUrl(
    responseUrl: string,
    payload: SlackResponse,
  ): Promise<void> {
    try {
      await this.fetchFn(responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      logger.error('Failed to POST to response_url', {
        responseUrl,
        error: (error as Error).message,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Default fetch wrapper
// ---------------------------------------------------------------------------

/**
 * Wrapper around the global `fetch` function, typed for our needs.
 */
async function globalFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
): Promise<{ ok: boolean; status: number }> {
  const response = await fetch(url, init);
  return { ok: response.ok, status: response.status };
}
