/**
 * Slack Interaction Handler.
 *
 * Routes Slack interaction payloads (`block_actions`, `view_submission`,
 * `shortcut`) to the appropriate actions:
 * - Kill confirm/cancel button clicks
 * - Cancel confirm/cancel button clicks (with embedded request ID)
 * - Submit modal form submissions
 * - Global shortcut handling (opens submit modal)
 *
 * Validates button clicker authorization before executing destructive
 * actions (kill). Unauthorized users receive an ephemeral denial via
 * `chat.postEphemeral`.
 *
 * The handler acknowledges all requests immediately (within 3 seconds)
 * and processes the payload asynchronously, posting results via the
 * `response_url` provided by Slack.
 *
 * Implements SPEC-008-4-03, Task 8.
 *
 * @module slack_interaction_handler
 */

import type { SlackIdentityResolver } from './slack_identity';
import type { AuthzEngine } from '../../authz/authz_engine';
import type { IncomingCommand, CommandResult } from '../adapter_interface';

// ---------------------------------------------------------------------------
// Minimal type stubs for express & Slack Web API
// ---------------------------------------------------------------------------

/**
 * Minimal express Request interface.
 */
export interface ExpressRequest {
  body: {
    get?(key: string): string | null;
    payload?: string;
  } | URLSearchParams;
}

/**
 * Minimal express Response interface.
 */
export interface ExpressResponse {
  status(code: number): ExpressResponse;
  send(body?: string): ExpressResponse;
}

/**
 * Minimal Slack Web API client interface for interaction handling.
 *
 * Extends the base adapter client with `views.open` for modal support
 * and `chat.postEphemeral` for private error messages.
 */
export interface SlackWebClient {
  chat: {
    postEphemeral(params: {
      channel: string;
      user: string;
      text: string;
    }): Promise<{ ok: boolean }>;
  };
  views: {
    open(params: {
      trigger_id: string;
      view: Record<string, unknown>;
    }): Promise<{ ok: boolean }>;
  };
}

/**
 * Minimal IntakeRouter interface consumed by the interaction handler.
 *
 * The concrete implementation is in `intake/core/intake_router.ts`.
 */
export interface IntakeRouter {
  route(command: IncomingCommand): Promise<CommandResult>;
}

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

/** A Slack block_actions payload. */
interface BlockActionsPayload {
  type: 'block_actions';
  actions: Array<{
    action_id: string;
    value?: string;
  }>;
  user: { id: string };
  channel?: { id: string };
  response_url: string;
}

/** A Slack view_submission payload. */
interface ViewSubmissionPayload {
  type: 'view_submission';
  user: { id: string };
  view: {
    callback_id: string;
    state: {
      values: Record<string, Record<string, { value: string | null }>>;
    };
  };
}

/** A Slack shortcut payload. */
interface ShortcutPayload {
  type: 'shortcut';
  trigger_id: string;
  user: { id: string };
  callback_id: string;
}

/** Union of supported interaction payload types. */
type InteractionPayload = BlockActionsPayload | ViewSubmissionPayload | ShortcutPayload;

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
// SlackInteractionHandler
// ---------------------------------------------------------------------------

/**
 * Handles Slack interaction payloads (button clicks, modal submissions,
 * and global shortcuts).
 *
 * Routing is based on the payload type:
 * - `block_actions` -> routes button clicks by `action_id`
 * - `view_submission` -> routes modal form submissions by `callback_id`
 * - `shortcut` -> routes global shortcuts by `callback_id`
 *
 * For `block_actions`:
 * - `kill_confirm`         -> Execute kill with CONFIRM, after authz check
 * - `kill_cancel`          -> Respond with "Kill cancelled."
 * - `cancel_confirm_{id}`  -> Execute cancel for the embedded request ID
 * - `cancel_cancel_{id}`   -> Respond with "Cancel aborted."
 *
 * For `view_submission`:
 * - `submit_modal`         -> Extract fields and route as submit command
 *
 * For `shortcut`:
 * - `submit_request`       -> Open the submit modal via `views.open`
 *
 * Implements SPEC-008-4-03, Task 8.
 */
export class SlackInteractionHandler {
  constructor(
    private router: IntakeRouter,
    private identityResolver: SlackIdentityResolver,
    private authz: AuthzEngine,
    private web: SlackWebClient,
  ) {}

  // -----------------------------------------------------------------------
  // Main HTTP handler
  // -----------------------------------------------------------------------

  /**
   * Handle an incoming Slack interaction HTTP request.
   *
   * Acknowledges the request immediately (HTTP 200) to satisfy Slack's
   * 3-second timeout requirement, then processes the payload asynchronously.
   *
   * @param req - The Express request containing the interaction payload.
   * @param res - The Express response (used only for the 200 acknowledgement).
   */
  async handle(req: ExpressRequest, res: ExpressResponse): Promise<void> {
    // Acknowledge within 3 seconds
    res.status(200).send();

    const payloadStr = this.extractPayload(req);
    if (!payloadStr) return;

    let payload: InteractionPayload;
    try {
      payload = JSON.parse(payloadStr);
    } catch {
      logger.error('Failed to parse interaction payload');
      return;
    }

    switch (payload.type) {
      case 'block_actions':
        await this.handleBlockAction(payload);
        break;
      case 'view_submission':
        await this.handleViewSubmission(payload);
        break;
      case 'shortcut':
        await this.handleShortcut(payload);
        break;
      default:
        logger.warn('Unknown interaction payload type', { type: (payload as { type: string }).type });
    }
  }

  // -----------------------------------------------------------------------
  // Block actions handler
  // -----------------------------------------------------------------------

  /**
   * Handle a block_actions payload (button clicks).
   *
   * Routes by action_id:
   * - `kill_confirm`  -> Kill with CONFIRM (after authz check)
   * - `kill_cancel`   -> Respond with "Kill cancelled."
   * - `cancel_confirm_{requestId}` -> Cancel the request
   * - `cancel_cancel_{requestId}`  -> Respond with "Cancel aborted."
   */
  private async handleBlockAction(payload: BlockActionsPayload): Promise<void> {
    const action = payload.actions[0];
    if (!action) return;

    const actionId = action.action_id;
    const responseUrl = payload.response_url;

    let userId: string;
    try {
      userId = await this.identityResolver.resolve(payload.user.id);
    } catch (error) {
      logger.error('Failed to resolve user identity', {
        slackUserId: payload.user.id,
        error: (error as Error).message,
      });
      await this.postToResponseUrl(responseUrl, {
        success: false,
        data: 'User not authorized.',
      });
      return;
    }

    if (actionId === 'kill_confirm') {
      const decision = this.authz.authorize(userId, 'kill', {}, 'slack');
      if (!decision.granted) {
        await this.postEphemeral(payload, 'Permission denied.');
        return;
      }
      const result = await this.router.route({
        commandName: 'kill',
        args: ['CONFIRM'],
        flags: {},
        rawText: 'kill CONFIRM',
        source: { channelType: 'slack', userId, timestamp: new Date() },
      });
      await this.postToResponseUrl(responseUrl, result);
    } else if (actionId === 'kill_cancel') {
      await this.postToResponseUrl(responseUrl, { success: true, data: 'Kill cancelled.' });
    } else if (actionId.startsWith('cancel_confirm_')) {
      const requestId = actionId.replace('cancel_confirm_', '');
      const result = await this.router.route({
        commandName: 'cancel',
        args: [requestId, 'CONFIRM'],
        flags: {},
        rawText: `cancel ${requestId} CONFIRM`,
        source: { channelType: 'slack', userId, timestamp: new Date() },
      });
      await this.postToResponseUrl(responseUrl, result);
    } else if (actionId.startsWith('cancel_cancel_')) {
      await this.postToResponseUrl(responseUrl, { success: true, data: 'Cancel aborted.' });
    }
  }

  // -----------------------------------------------------------------------
  // View submission handler
  // -----------------------------------------------------------------------

  /**
   * Handle a view_submission payload (modal form submissions).
   *
   * For the `submit_modal` callback_id, extracts the description, repo,
   * and acceptance_criteria fields and routes them through the IntakeRouter
   * as a `submit` command.
   */
  private async handleViewSubmission(payload: ViewSubmissionPayload): Promise<void> {
    if (payload.view.callback_id !== 'submit_modal') {
      logger.warn('Unknown modal callback_id', { callbackId: payload.view.callback_id });
      return;
    }

    let userId: string;
    try {
      userId = await this.identityResolver.resolve(payload.user.id);
    } catch (error) {
      logger.error('Failed to resolve user identity for modal submission', {
        slackUserId: payload.user.id,
        error: (error as Error).message,
      });
      return;
    }

    const values = payload.view.state.values;
    const description = values.description_block?.description?.value ?? '';
    const repo = values.repo_block?.repo?.value ?? undefined;
    const criteria = values.criteria_block?.acceptance_criteria?.value ?? undefined;

    const command: IncomingCommand = {
      commandName: 'submit',
      args: [description],
      flags: {
        ...(repo ? { repo } : {}),
        ...(criteria ? { acceptance_criteria: criteria } : {}),
      },
      rawText: description,
      source: {
        channelType: 'slack',
        userId,
        timestamp: new Date(),
      },
    };

    const result = await this.router.route(command);
    if (!result.success) {
      logger.error('Modal submit command failed', { error: result.error });
    }
  }

  // -----------------------------------------------------------------------
  // Shortcut handler
  // -----------------------------------------------------------------------

  /**
   * Handle a shortcut payload (global shortcuts).
   *
   * For the `submit_request` callback_id, opens the submit modal via
   * `views.open` using the `trigger_id` from the shortcut payload.
   */
  private async handleShortcut(payload: ShortcutPayload): Promise<void> {
    if (payload.callback_id === 'submit_request') {
      const { buildSubmitModal } = await import('./slack_components');
      const modal = buildSubmitModal(payload.trigger_id);

      try {
        await this.web.views.open({
          trigger_id: modal.trigger_id,
          view: modal.view as unknown as Record<string, unknown>,
        });
      } catch (error) {
        logger.error('Failed to open submit modal', {
          error: (error as Error).message,
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Extract the payload string from the express request body.
   *
   * Handles both `URLSearchParams` bodies (from Express body parsing
   * with `urlencoded` middleware) and plain objects with a `payload` key.
   */
  private extractPayload(req: ExpressRequest): string | null {
    if (req.body instanceof URLSearchParams) {
      return req.body.get('payload');
    }
    if (typeof req.body === 'object' && req.body !== null && 'payload' in req.body) {
      return (req.body as { payload?: string }).payload ?? null;
    }
    return null;
  }

  /**
   * Send an ephemeral message to the user who clicked the button.
   *
   * Used for authorization denial messages that should only be visible
   * to the clicking user.
   */
  private async postEphemeral(payload: BlockActionsPayload, text: string): Promise<void> {
    if (!payload.channel) {
      logger.warn('Cannot send ephemeral: no channel in payload');
      return;
    }
    try {
      await this.web.chat.postEphemeral({
        channel: payload.channel.id,
        user: payload.user.id,
        text,
      });
    } catch (error) {
      logger.error('Failed to post ephemeral message', {
        error: (error as Error).message,
      });
    }
  }

  /**
   * Post a result to the Slack response_url.
   *
   * Uses a plain `fetch` call to the response URL, which is the
   * standard Slack pattern for deferred interaction responses.
   */
  private async postToResponseUrl(
    responseUrl: string,
    result: CommandResult | { success: boolean; data: string },
  ): Promise<void> {
    const text = result.success
      ? (typeof result.data === 'string' ? result.data : JSON.stringify(result.data))
      : `Error: ${(result as CommandResult).error ?? 'Unknown error'}`;

    try {
      await fetch(responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          replace_original: true,
          text,
        }),
      });
    } catch (error) {
      logger.error('Failed to post to response URL', {
        error: (error as Error).message,
        responseUrl,
      });
    }
  }
}
