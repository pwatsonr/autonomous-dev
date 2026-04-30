/**
 * Slack Service -- Orchestrator wiring HTTP/Socket Mode receivers,
 * signature verification, slash command + interaction handlers, rate
 * limiting, and graceful shutdown.
 *
 * Implements PLAN-011-4 (SPEC-011-4-01..05). The {@link SlackService}
 * delegates protocol details to existing helpers (`SlackVerifier`,
 * `SlackServer`, `SlackSocketMode`, `SlackCommandHandler`,
 * `SlackInteractionHandler`) and focuses on lifecycle wiring.
 *
 * Two transport modes:
 * - HTTP mode: Express-based receiver bound to `/slack/events`,
 *   `/slack/commands`, `/slack/interactions`, and `/health`. All `/slack/*`
 *   routes pass through the HMAC-SHA256 signature middleware.
 * - Socket Mode: WebSocket-based delivery via `@slack/socket-mode`.
 *   Used in environments without public HTTPS endpoints. Still exposes
 *   `/health` for container orchestration probes.
 *
 * @module slack/main
 */

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import http from 'http';
import crypto from 'crypto';
import { parseCommandArgs } from '../claude_arg_parser';
import { SlackVerifier } from './slack_verifier';
import type { SlackCommandHandler } from './slack_command_handler';
import type { SlackInteractionHandler } from './slack_interaction_handler';
import type { SlackAdapter } from './slack_adapter';
import type {
  CommandResult,
  IncomingCommand,
} from '../adapter_interface';

// ---------------------------------------------------------------------------
// Logger interface (shared with the rest of the slack package)
// ---------------------------------------------------------------------------

/**
 * Logger interface for structured logging within the Slack service.
 *
 * Matches the convention used by `SlackServer`, `SlackVerifier`, etc.
 */
export interface SlackServiceLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const noopLogger: SlackServiceLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// Router contract (lightweight; concrete IntakeRouter wiring lives elsewhere)
// ---------------------------------------------------------------------------

/**
 * Minimal IntakeRouter interface consumed by the service.
 *
 * The concrete implementation lives at `intake/core/intake_router.ts`;
 * this interface keeps `main.ts` decoupled so tests can inject mocks
 * without constructing the full router dependency graph.
 */
export interface IntakeRouterLike {
  route(command: IncomingCommand): Promise<CommandResult>;
}

// ---------------------------------------------------------------------------
// Per-workspace inbound rate limiter contract
// ---------------------------------------------------------------------------

/**
 * Result of a per-workspace rate-limit check.
 */
export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs?: number;
}

/**
 * Per-workspace inbound rate limiter contract (SPEC-011-4-04).
 *
 * Distinct from the existing {@link import('./slack_rate_limiter').SlackRateLimiter},
 * which handles outbound Slack API rate limits. This limiter throttles
 * inbound slash commands keyed by `workspaceId` (Slack `team_id`).
 */
export interface InboundRateLimiter {
  check(opts: { key: string; perMinute: number }): Promise<RateLimitDecision>;
}

/**
 * In-memory token-bucket implementation of {@link InboundRateLimiter}.
 *
 * Uses a fixed 60-second window per workspace; counters reset on the
 * minute boundary observed at the first request in a window. This is
 * deliberately simple — production deployments behind a load balancer
 * should swap in a Redis-backed implementation via the public interface.
 */
export class InMemoryInboundRateLimiter implements InboundRateLimiter {
  private state: Map<string, { count: number; windowStart: number }> = new Map();

  async check(opts: { key: string; perMinute: number }): Promise<RateLimitDecision> {
    const now = Date.now();
    const entry = this.state.get(opts.key);
    if (!entry || now - entry.windowStart >= 60_000) {
      this.state.set(opts.key, { count: 1, windowStart: now });
      return { allowed: true };
    }
    if (entry.count < opts.perMinute) {
      entry.count += 1;
      return { allowed: true };
    }
    const retryAfterMs = 60_000 - (now - entry.windowStart);
    return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
  }
}

// ---------------------------------------------------------------------------
// Socket Mode client contract (re-declared so we don't leak `@slack/socket-mode`)
// ---------------------------------------------------------------------------

/**
 * Minimal Socket Mode client contract.
 *
 * Compatible with `@slack/socket-mode` `SocketModeClient` at runtime.
 * Tests can inject a stub implementing the same shape.
 */
export interface SocketModeClient {
  start(): Promise<void>;
  disconnect(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

// ---------------------------------------------------------------------------
// Slack response shape (used for ephemeral acks and inline replies)
// ---------------------------------------------------------------------------

/**
 * Shape of a Slack-bound HTTP response body for slash commands and
 * interactions. Mirrors `SlackResponse` from `slack_command_handler.ts`
 * but redeclared here to avoid cross-module type churn.
 */
export interface SlackResponseBody {
  response_type?: 'in_channel' | 'ephemeral';
  text: string;
  blocks?: unknown[];
  replace_original?: boolean;
  response_action?: 'clear' | 'errors' | 'update' | 'push';
  challenge?: string;
}

// ---------------------------------------------------------------------------
// Service config + dependencies
// ---------------------------------------------------------------------------

/**
 * Configuration for the {@link SlackService}.
 */
export interface SlackServiceConfig {
  /** Whether to use Socket Mode (WebSocket) instead of HTTP. */
  socket_mode: boolean;
  /** TCP port for the HTTP listener (HTTP mode and Socket Mode `/health`). */
  port: number;
  /** Maximum allowed drift (in seconds) between request timestamp and server clock. */
  timestamp_tolerance_seconds: number;
  /** Per-workspace rate limit configuration. */
  rate_limits: { perWorkspacePerMinute: number };
  /** Drain budget (in milliseconds) before the force-shutdown timer fires. */
  shutdown_drain_ms: number;
}

/**
 * Default values for {@link SlackServiceConfig}, keyed by spec defaults.
 */
export const DEFAULT_SLACK_SERVICE_CONFIG: SlackServiceConfig = {
  socket_mode: false,
  port: 3000,
  timestamp_tolerance_seconds: 300,
  rate_limits: { perWorkspacePerMinute: 60 },
  shutdown_drain_ms: 10_000,
};

/**
 * Constructor dependencies for {@link SlackService}.
 *
 * All collaborators are injected so that tests can supply mocks without
 * touching `process.env` or constructing the full Slack adapter graph.
 */
export interface SlackServiceDeps {
  /** Shared command router (PLAN-011-1). */
  router: IntakeRouterLike;
  /** Existing slack adapter (provides `drain()` for graceful shutdown). */
  adapter: SlackAdapter;
  /** HMAC verifier used by the signature middleware. */
  verifier: SlackVerifier;
  /** Existing slash command handler (provides `handle()`). */
  commandHandler: SlackCommandHandler;
  /** Existing interaction handler (provides `handle()`). */
  interactionHandler: SlackInteractionHandler;
  /** Per-workspace inbound rate limiter. */
  rateLimiter: InboundRateLimiter;
  /** Optional pre-built Socket Mode client (only used when `config.socket_mode = true`). */
  socketModeClient?: SocketModeClient;
  /** Structured logger. */
  logger: SlackServiceLogger;
}

// ---------------------------------------------------------------------------
// Slash command inventory (SPEC-011-4-02)
// ---------------------------------------------------------------------------

/**
 * The 10 supported `/request-*` slash commands. The Slack manifest also
 * lists the legacy `/ad-*` commands used by SPEC-008-4 deployments;
 * both prefixes are accepted by {@link mapSlashCommandPayload}.
 */
export const SUPPORTED_SLASH_SUBCOMMANDS = [
  'submit',
  'status',
  'list',
  'cancel',
  'pause',
  'resume',
  'priority',
  'logs',
  'feedback',
  'kill',
] as const;

export type SupportedSubcommand = (typeof SUPPORTED_SLASH_SUBCOMMANDS)[number];

const SUPPORTED_SUBCOMMAND_SET: Set<string> = new Set(SUPPORTED_SLASH_SUBCOMMANDS);

// ---------------------------------------------------------------------------
// Slash command payload shape (Slack form-encoded fields)
// ---------------------------------------------------------------------------

/**
 * Subset of Slack slash command form fields consumed by
 * {@link mapSlashCommandPayload}. Other fields (e.g., `api_app_id`,
 * `enterprise_id`) are ignored.
 */
export interface SlackSlashCommandBody {
  command?: string;
  text?: string;
  user_id?: string;
  user_name?: string;
  team_id?: string;
  team_domain?: string;
  channel_id?: string;
  channel_name?: string;
  response_url?: string;
  trigger_id?: string;
  thread_ts?: string;
}

// ---------------------------------------------------------------------------
// Body-parser raw-body capture (used for HMAC verification downstream)
// ---------------------------------------------------------------------------

/**
 * Express request augmented with `rawBody`. The body parsers in
 * {@link SlackService.startHttpMode} use a `verify` callback to capture
 * the original bytes before Express parses them, so the signature
 * middleware can compute HMAC over the unmodified body.
 */
interface RequestWithRawBody extends Request {
  rawBody?: string;
}

function captureRawBody(req: Request, _res: Response, buf: Buffer): void {
  (req as RequestWithRawBody).rawBody = buf.toString('utf8');
}

// ---------------------------------------------------------------------------
// Signature verification middleware
// ---------------------------------------------------------------------------

/**
 * Build an Express middleware that verifies the Slack request signature
 * before the handler runs.
 *
 * Failure modes (each returns 401 with a `{ error }` body, no signature
 * value echoed):
 * - Missing `X-Slack-Request-Timestamp` or `X-Slack-Signature` header
 * - Timestamp drift > `toleranceSeconds`
 * - HMAC mismatch (delegated to {@link SlackVerifier.verify})
 *
 * @param verifier        - Shared HMAC verifier.
 * @param toleranceSeconds - Maximum allowed clock drift in seconds.
 * @param logger          - Structured logger.
 */
export function verifySlackSignatureMiddleware(
  verifier: SlackVerifier,
  toleranceSeconds: number,
  logger: SlackServiceLogger,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const headerTimestamp = req.header('X-Slack-Request-Timestamp');
    const headerSignature = req.header('X-Slack-Signature');

    if (!headerTimestamp || !headerSignature) {
      logger.warn('slack.sig.missing_headers', { ip: req.ip, path: req.path });
      res.status(401).json({ error: 'missing_signature_headers' });
      return;
    }

    const timestampSeconds = Number(headerTimestamp);
    if (!Number.isFinite(timestampSeconds)) {
      logger.warn('slack.sig.invalid_timestamp', { ip: req.ip, path: req.path });
      res.status(401).json({ error: 'timestamp_expired' });
      return;
    }

    const driftSeconds = Math.abs(Date.now() / 1000 - timestampSeconds);
    if (driftSeconds > toleranceSeconds) {
      logger.warn('slack.sig.timestamp_expired', {
        ip: req.ip,
        timestamp: headerTimestamp,
        drift_seconds: Math.round(driftSeconds),
      });
      res.status(401).json({ error: 'timestamp_expired' });
      return;
    }

    const rawBody = (req as RequestWithRawBody).rawBody ?? '';
    const valid = verifier.verify(headerTimestamp, rawBody, headerSignature);
    if (!valid) {
      // NEVER log/echo the rejected signature value.
      logger.warn('slack.sig.invalid', { ip: req.ip, path: req.path });
      res.status(401).json({ error: 'bad_signature' });
      return;
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Slash command -> IncomingCommand mapping (SPEC-011-4-02)
// ---------------------------------------------------------------------------

/**
 * Tag attached to the canonical {@link IncomingCommand} so downstream
 * code (e.g., the deferred response continuation) can recover the
 * Slack-specific fields without forcing them into the cross-channel
 * type. Stored on `flags` so it survives serialization through the
 * router.
 */
export const SLACK_CONTEXT_FLAG = '__slack_ctx';

/**
 * Slack-specific context attached to the {@link IncomingCommand} via
 * `flags[SLACK_CONTEXT_FLAG]`. The value is a JSON-encoded string of
 * this shape (boxed because flag values must be `string | boolean`).
 */
export interface SlackInvocationContext {
  workspaceId: string;
  workspaceDomain?: string;
  channelId: string;
  channelName?: string;
  threadTs?: string;
  isDM: boolean;
  responseUrl?: string;
  triggerId?: string;
  userDisplay?: string;
}

/**
 * Map a Slack slash command body to the canonical {@link IncomingCommand}
 * consumed by {@link IntakeRouter}.
 *
 * Behavior:
 * 1. Reject commands not prefixed with `/request-` or `/ad-` with
 *    `unknown_command: <name>`.
 * 2. Strip the prefix to derive the subcommand (`commandName`).
 * 3. Validate the subcommand against the supported allowlist; throw
 *    `invalid_subcommand` otherwise.
 * 4. Tokenize `body.text` via `parseCommandArgs` (preserves quoted
 *    strings, rejects shell injection).
 * 5. Attach Slack-specific context as a JSON-encoded flag so the
 *    downstream pipeline (rate limiter, deferred POST) can recover it
 *    without polluting the cross-channel type.
 *
 * @throws {Error} `unknown_command: <command>` when the command lacks the
 *   `/request-` (or legacy `/ad-`) prefix, or when `body.command` is empty.
 * @throws {Error} `invalid_subcommand` when the prefix is present but
 *   the verb is not in {@link SUPPORTED_SLASH_SUBCOMMANDS}.
 */
export function mapSlashCommandPayload(body: SlackSlashCommandBody): IncomingCommand {
  const command = body.command ?? '';
  if (!command) {
    throw new Error(`unknown_command: ${command}`);
  }

  let subcommand: string;
  if (command.startsWith('/request-')) {
    subcommand = command.slice('/request-'.length);
  } else if (command.startsWith('/ad-')) {
    // Backwards-compat: SPEC-008-4 manifest still uses the /ad- prefix.
    subcommand = command.slice('/ad-'.length);
  } else {
    throw new Error(`unknown_command: ${command}`);
  }

  if (!SUPPORTED_SUBCOMMAND_SET.has(subcommand)) {
    throw new Error('invalid_subcommand');
  }

  const text = body.text ?? '';
  const { args, flags } = parseCommandArgs(text);

  const channelId = body.channel_id ?? '';
  const slackCtx: SlackInvocationContext = {
    workspaceId: body.team_id ?? '',
    workspaceDomain: body.team_domain,
    channelId,
    channelName: body.channel_name,
    threadTs: body.thread_ts,
    isDM: channelId.startsWith('D'),
    responseUrl: body.response_url,
    triggerId: body.trigger_id,
    userDisplay: body.user_name,
  };

  return {
    commandName: subcommand,
    args,
    flags: {
      ...flags,
      [SLACK_CONTEXT_FLAG]: JSON.stringify(slackCtx),
    },
    rawText: text,
    source: {
      channelType: 'slack',
      userId: body.user_id ?? '',
      platformChannelId: channelId,
      threadId: body.thread_ts,
      timestamp: new Date(),
    },
  };
}

/**
 * Recover the Slack-specific invocation context from a previously
 * mapped {@link IncomingCommand}. Returns `undefined` when the command
 * did not originate from {@link mapSlashCommandPayload}.
 */
export function getSlackContext(cmd: IncomingCommand): SlackInvocationContext | undefined {
  const raw = cmd.flags?.[SLACK_CONTEXT_FLAG];
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw) as SlackInvocationContext;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 3-second response budget (SPEC-011-4-02)
// ---------------------------------------------------------------------------

/** Sentinel returned by {@link withResponseBudget} when the deadline fires. */
export const DEFERRED_SENTINEL = '__deferred__' as const;

/**
 * Race a work promise against a deadline. If the work resolves first,
 * the result is returned. Otherwise, the `deferred` callback is invoked
 * (typically to send Slack's inline ephemeral acknowledgement) and the
 * sentinel `'__deferred__'` is returned. The caller is responsible for
 * letting `work` continue and posting the eventual result via
 * `response_url`.
 *
 * Slack enforces a 3000ms hard timeout on slash command HTTP responses;
 * the default 2500ms budget leaves a 500ms margin for serialization and
 * network jitter.
 *
 * @typeParam T  - Work resolution type.
 * @param work       - The pending router dispatch.
 * @param deadlineMs - Race deadline in milliseconds (default 2500).
 * @param deferred   - Callback invoked on timeout, typically sending the
 *                     inline `Processing your request...` ack.
 * @param logger     - Optional structured logger; receives `slack.response.deferred`
 *                     when the timeout fires.
 */
export async function withResponseBudget<T>(
  work: Promise<T>,
  deadlineMs: number,
  deferred: () => Promise<void> | void,
  logger?: SlackServiceLogger,
): Promise<T | typeof DEFERRED_SENTINEL> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof DEFERRED_SENTINEL>((resolve) => {
    timer = setTimeout(() => resolve(DEFERRED_SENTINEL), deadlineMs);
  });

  try {
    const winner = await Promise.race([work, timeout]);
    if (winner !== DEFERRED_SENTINEL) {
      if (timer) clearTimeout(timer);
      return winner as T;
    }
    await deferred();
    logger?.info('slack.response.deferred', { elapsed_ms: Date.now() - start });
    return DEFERRED_SENTINEL;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Interaction payload mapping (SPEC-011-4-03)
// ---------------------------------------------------------------------------

/**
 * Slack interaction payload (subset). Each payload type carries a
 * `type` discriminant; consumers branch on it.
 */
export interface SlackInteractionPayload {
  type: 'block_actions' | 'view_submission' | 'view_closed' | 'shortcut' | 'message_action';
  actions?: Array<{ action_id: string; value?: string }>;
  user?: { id: string; username?: string; team_id?: string };
  team?: { id: string; domain?: string };
  channel?: { id: string; name?: string };
  trigger_id?: string;
  response_url?: string;
  view?: {
    callback_id?: string;
    state?: { values: Record<string, Record<string, { value?: string | null }>> };
  };
  callback_id?: string;
}

/**
 * Result returned by {@link mapInteractionPayload}.
 *
 * - `route`: dispatch the embedded {@link IncomingCommand} through the
 *   router; optionally resolve a pending prompt afterward.
 * - `dismiss`: respond locally without invoking the router (cancel/close
 *   buttons, view_closed, etc.).
 * - `error`: ephemeral error response (unknown verb, malformed payload).
 * - `open_modal`: tell the caller to open a modal via `views.open` using
 *   the supplied `triggerId`. Used by the two-hop `clarify_freeform` flow.
 */
export type InteractionDispatch =
  | {
      kind: 'route';
      command: IncomingCommand;
      resolvePromptForRequestId?: string;
      replaceOriginal?: boolean;
      responseAction?: 'clear';
    }
  | {
      kind: 'dismiss';
      responseAction: 'replace' | 'ephemeral';
      text: string;
    }
  | {
      kind: 'error';
      text: string;
    }
  | {
      kind: 'open_modal';
      triggerId: string;
      requestId: string;
    };

/**
 * Map a parsed Slack interaction payload onto an {@link InteractionDispatch}.
 *
 * Action IDs follow the `<verb>:<arg1>[:<arg2>...]` convention; the
 * verb dictates the routing branch.
 */
export function mapInteractionPayload(
  payload: SlackInteractionPayload,
): InteractionDispatch {
  const userId = payload.user?.id ?? '';
  const channelId = payload.channel?.id ?? '';
  const workspaceId = payload.team?.id ?? payload.user?.team_id ?? '';
  const responseUrl = payload.response_url;

  const buildSlackCtx = (overrides?: Partial<SlackInvocationContext>): SlackInvocationContext => ({
    workspaceId,
    channelId,
    channelName: payload.channel?.name,
    threadTs: undefined,
    isDM: channelId.startsWith('D'),
    responseUrl,
    triggerId: payload.trigger_id,
    userDisplay: payload.user?.username,
    ...overrides,
  });

  const buildCommand = (
    commandName: string,
    args: string[],
    rawText: string,
    ctxOverrides?: Partial<SlackInvocationContext>,
  ): IncomingCommand => ({
    commandName,
    args,
    flags: {
      [SLACK_CONTEXT_FLAG]: JSON.stringify(buildSlackCtx(ctxOverrides)),
    },
    rawText,
    source: {
      channelType: 'slack',
      userId,
      platformChannelId: channelId,
      timestamp: new Date(),
    },
  });

  switch (payload.type) {
    case 'block_actions': {
      const action = payload.actions?.[0];
      if (!action) {
        return { kind: 'error', text: 'No action in block_actions payload.' };
      }
      const [verb, ...rest] = action.action_id.split(':');

      switch (verb) {
        case 'clarify_select': {
          const [requestId, optionId] = rest;
          if (!requestId || !optionId) {
            return { kind: 'error', text: 'Malformed clarify_select action.' };
          }
          return {
            kind: 'route',
            command: buildCommand('feedback', [requestId, optionId], `feedback ${requestId} ${optionId}`),
            resolvePromptForRequestId: requestId,
            replaceOriginal: true,
          };
        }
        case 'clarify_freeform': {
          const [requestId] = rest;
          if (!requestId || !payload.trigger_id) {
            return { kind: 'error', text: 'Malformed clarify_freeform action.' };
          }
          return { kind: 'open_modal', triggerId: payload.trigger_id, requestId };
        }
        case 'kill_confirm': {
          const [requestId] = rest;
          // requestId is optional for kill — emergency kill takes no args.
          const args = requestId ? [requestId] : ['CONFIRM'];
          return {
            kind: 'route',
            command: buildCommand('kill', args, `kill ${args.join(' ')}`),
            replaceOriginal: true,
          };
        }
        case 'cancel_confirm': {
          const [requestId] = rest;
          if (!requestId) {
            return { kind: 'error', text: 'Malformed cancel_confirm action.' };
          }
          return {
            kind: 'route',
            command: buildCommand('cancel', [requestId, 'CONFIRM'], `cancel ${requestId} CONFIRM`),
            replaceOriginal: true,
          };
        }
        case 'kill_cancel':
        case 'cancel_dismiss': {
          return { kind: 'dismiss', responseAction: 'replace', text: 'Action cancelled.' };
        }
        case 'approve':
        case 'deny': {
          const [operation, requestId] = rest;
          if (!operation || !requestId) {
            return { kind: 'error', text: `Malformed ${verb} action.` };
          }
          return {
            kind: 'route',
            command: buildCommand(verb, [operation, requestId], `${verb} ${operation} ${requestId}`),
            replaceOriginal: true,
          };
        }
        default:
          return { kind: 'error', text: `Unknown action: ${verb}. Please contact your operator.` };
      }
    }

    case 'view_submission': {
      const callbackId = payload.view?.callback_id ?? '';
      const values = payload.view?.state?.values ?? {};

      if (callbackId === 'submit_request_modal' || callbackId === 'submit_modal') {
        const description =
          values.description_block?.description_input?.value ??
          values.description_block?.description?.value ??
          '';
        const repo =
          values.repo_block?.repo_input?.value ?? values.repo_block?.repo?.value ?? '';
        const criteria =
          values.acceptance_criteria_block?.criteria_input?.value ??
          values.criteria_block?.acceptance_criteria?.value ??
          '';
        return {
          kind: 'route',
          command: buildCommand(
            'submit',
            [description, repo, criteria].filter((v) => v.length > 0),
            description,
          ),
          responseAction: 'clear',
        };
      }
      if (callbackId === 'clarify_freeform_modal') {
        // The modal stores requestId in private_metadata when the freeform
        // modal is opened; we extract it from the values for parity.
        const requestId = values.request_block?.request_input?.value ?? '';
        const feedback = values.feedback_block?.feedback_input?.value ?? '';
        if (!requestId || !feedback) {
          return { kind: 'error', text: 'Missing fields in clarify_freeform_modal.' };
        }
        return {
          kind: 'route',
          command: buildCommand(
            'feedback',
            [requestId, feedback],
            `feedback ${requestId} ${feedback}`,
          ),
          resolvePromptForRequestId: requestId,
          responseAction: 'clear',
        };
      }
      return { kind: 'error', text: `Unknown modal: ${callbackId}` };
    }

    case 'view_closed': {
      return { kind: 'dismiss', responseAction: 'ephemeral', text: '' };
    }

    case 'shortcut':
    case 'message_action':
    default:
      return { kind: 'error', text: 'not_implemented' };
  }
}

// ---------------------------------------------------------------------------
// Error formatting (SPEC-011-4-04)
// ---------------------------------------------------------------------------

/**
 * Mapping from internal error codes to user-facing strings. Adding a
 * new code requires updating this table (do NOT embed `err.message`
 * directly into user-visible text).
 */
const ERROR_CODE_TABLE: Record<string, string> = {
  INVALID_REQUEST_ID: 'Invalid request ID. Format: REQ-NNNNNN',
  UNKNOWN_REQUEST: 'That request was not found.',
  RATE_LIMITED: 'Too many requests. Please slow down.',
  UNAUTHORIZED: 'You are not authorized for that operation.',
  TIMEOUT: 'The operation timed out. It may still complete in the background.',
};

const DEFAULT_ERROR_MESSAGE = 'Something went wrong. Please contact your operator.';
const DEFAULT_ERROR_CODE = 'INTERNAL_ERROR';

interface FormattableError {
  code?: string;
  message?: string;
}

/**
 * Format an error as a Slack-compatible ephemeral Block Kit response.
 *
 * Stack traces and raw `err.message` are NEVER included in the user-
 * visible blocks; only the mapped {@link ERROR_CODE_TABLE} entry and
 * the resolved error code are surfaced.
 *
 * @param err       - Error to format. May expose `code` for direct
 *                    classification; otherwise the code defaults to
 *                    `INTERNAL_ERROR`.
 * @param requestId - Optional request ID to render as a context block.
 */
export function formatError(err: FormattableError, requestId?: string): SlackResponseBody {
  const code = (err.code && ERROR_CODE_TABLE[err.code]) ? err.code : DEFAULT_ERROR_CODE;
  const userMessage = ERROR_CODE_TABLE[code] ?? DEFAULT_ERROR_MESSAGE;

  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `:warning: *${userMessage}*` } },
  ];
  if (requestId) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Request: \`${requestId}\`` }],
    });
  }
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Error code: \`${code}\`` }],
  });

  return {
    response_type: 'ephemeral',
    text: 'An error occurred',
    blocks,
  };
}

// ---------------------------------------------------------------------------
// Util: post a JSON payload to the Slack-supplied response_url
// ---------------------------------------------------------------------------

/**
 * Minimal fetch interface used for `response_url` POSTs. Injected so
 * tests can capture outbound traffic without real network calls.
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

/**
 * POST a payload to the Slack response_url. Failures are logged but
 * not thrown — the original interaction has already been acknowledged.
 */
export async function postToResponseUrl(
  url: string,
  payload: SlackResponseBody,
  fetchFn: FetchLike,
  logger: SlackServiceLogger,
): Promise<void> {
  try {
    await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    logger.error('slack.response_url.post_failed', {
      url,
      error: (error as Error).message,
    });
  }
}

// ---------------------------------------------------------------------------
// Service config validation (SPEC-011-4-02 / SPEC-011-4-04)
// ---------------------------------------------------------------------------

/**
 * Validate a {@link SlackServiceConfig} and the matching environment
 * variables. Throws `Error("config: <key> is required")` for missing
 * required env vars and `Error("config: invalid <key>")` for malformed
 * values. Token values are NEVER logged or echoed in error messages.
 *
 * @throws {Error} On missing/invalid configuration.
 */
export function validateSlackServiceConfig(
  config: SlackServiceConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!Number.isInteger(config.port) || config.port <= 0) {
    throw new Error('config: invalid port');
  }
  if (
    typeof config.timestamp_tolerance_seconds !== 'number' ||
    config.timestamp_tolerance_seconds < 60 ||
    config.timestamp_tolerance_seconds > 600
  ) {
    throw new Error('config: invalid timestamp_tolerance_seconds');
  }
  if (
    typeof config.rate_limits?.perWorkspacePerMinute !== 'number' ||
    config.rate_limits.perWorkspacePerMinute <= 0
  ) {
    throw new Error('config: invalid rate_limits.perWorkspacePerMinute');
  }

  if (config.socket_mode) {
    if (!env.SLACK_APP_TOKEN) {
      throw new Error('config: SLACK_APP_TOKEN is required');
    }
    if (!env.SLACK_BOT_TOKEN) {
      throw new Error('config: SLACK_BOT_TOKEN is required');
    }
  } else {
    if (!env.SLACK_BOT_TOKEN) {
      throw new Error('config: SLACK_BOT_TOKEN is required');
    }
    if (!env.SLACK_SIGNING_SECRET) {
      throw new Error('config: SLACK_SIGNING_SECRET is required');
    }
  }
}

// ---------------------------------------------------------------------------
// SlackService
// ---------------------------------------------------------------------------

/**
 * Slack adapter orchestrator. Composes the existing protocol primitives
 * into a single lifecycle-managed service with two transport modes.
 *
 * Lifecycle:
 * - {@link start} dispatches to {@link startHttpMode} or
 *   {@link startSocketMode} based on `config.socket_mode`.
 * - {@link shutdown} runs the documented drain sequence (stop accepting →
 *   Socket Mode disconnect → adapter drain → HTTP close) with a
 *   force-shutdown timer per `config.shutdown_drain_ms`.
 *
 * Concurrency:
 * - All slash command and interaction handling is async and bounded by
 *   the 3-second response budget enforced via {@link withResponseBudget}.
 * - Per-workspace inbound rate limiting runs after signature
 *   verification and before router dispatch.
 */
export class SlackService {
  private app: Express | null = null;
  private httpServer: http.Server | null = null;
  private startedAt = 0;
  private shuttingDown = false;
  private fetchFn: FetchLike;

  constructor(
    private readonly deps: SlackServiceDeps,
    private readonly config: SlackServiceConfig,
    fetchFn?: FetchLike,
  ) {
    this.fetchFn = fetchFn ?? defaultFetch;
  }

  // -----------------------------------------------------------------------
  // Public API: lifecycle
  // -----------------------------------------------------------------------

  /**
   * Start the service in the configured mode (HTTP or Socket Mode).
   */
  async start(): Promise<void> {
    this.startedAt = Date.now();
    if (this.config.socket_mode) {
      await this.startSocketMode();
    } else {
      await this.startHttpMode();
    }
  }

  /**
   * Graceful shutdown sequence (SPEC-011-4-04).
   *
   * Order:
   * 1. Stop accepting new connections (HTTP listener emits `close()`).
   * 2. Disconnect the Socket Mode client (if attached).
   * 3. Drain the underlying adapter so in-flight router dispatches
   *    complete.
   * 4. Fully close the HTTP server.
   *
   * A force-shutdown timer (`config.shutdown_drain_ms`) fires
   * `process.exit(1)` if the drain exceeds the budget. The graceful
   * path exits with code 0.
   *
   * Idempotent: concurrent SIGTERM/SIGINT calls reuse the in-flight
   * shutdown via the `shuttingDown` guard.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    const drainMs = this.config.shutdown_drain_ms;
    const force = setTimeout(() => {
      this.deps.logger.warn('slack.shutdown.forced', { drain_ms: drainMs });
      process.exit(1);
    }, drainMs);
    force.unref();

    try {
      // 1. Stop accepting new connections (HTTP).
      if (this.httpServer) {
        await this.stopAccepting(this.httpServer);
      }

      // 2. Disconnect Socket Mode (if any).
      if (this.deps.socketModeClient) {
        try {
          await this.deps.socketModeClient.disconnect();
        } catch (error) {
          this.deps.logger.warn('slack.shutdown.socket_disconnect_failed', {
            error: (error as Error).message,
          });
        }
      }

      // 3. Drain the adapter so in-flight handlers complete.
      try {
        await (this.deps.adapter as { drain?: () => Promise<void> }).drain?.();
      } catch (error) {
        this.deps.logger.warn('slack.shutdown.adapter_drain_failed', {
          error: (error as Error).message,
        });
      }

      // 4. Fully close the HTTP server.
      if (this.httpServer) {
        await new Promise<void>((resolve, reject) => {
          this.httpServer!.close((err) => (err ? reject(err) : resolve()));
        });
      }

      clearTimeout(force);
      this.deps.logger.info('slack.shutdown.graceful');
      process.exit(0);
    } catch (err) {
      this.deps.logger.error('slack.shutdown.error', {
        error: (err as Error).message,
      });
      clearTimeout(force);
      process.exit(1);
    }
  }

  // -----------------------------------------------------------------------
  // Internal: HTTP mode
  // -----------------------------------------------------------------------

  /**
   * Start the Express-based HTTP receiver. Mounts:
   * - `POST /slack/events` (JSON body, URL verification challenge)
   * - `POST /slack/commands` (URL-encoded slash command body)
   * - `POST /slack/interactions` (URL-encoded interaction payload)
   * - `GET /health`
   *
   * Body parsers are scoped per-route so the signature verification
   * sees the correct raw bytes for each Slack payload type.
   */
  private async startHttpMode(): Promise<void> {
    const app = express();
    this.app = app;

    // Body parsers: scoped per-route. Both capture the raw body for HMAC.
    app.use('/slack/events', express.json({ verify: captureRawBody }));
    app.use(
      ['/slack/commands', '/slack/interactions'],
      express.urlencoded({ extended: true, verify: captureRawBody }),
    );

    // Signature middleware on /slack/* (mounted before the handlers).
    app.use(
      '/slack',
      verifySlackSignatureMiddleware(
        this.deps.verifier,
        this.config.timestamp_tolerance_seconds,
        this.deps.logger,
      ),
    );

    // Routes.
    app.post('/slack/commands', (req, res) => {
      void this.handleSlashCommand(req, res);
    });
    app.post('/slack/interactions', (req, res) => {
      void this.handleInteraction(req, res);
    });
    app.post('/slack/events', (req, res) => {
      this.handleEvent(req, res);
    });
    app.get('/health', (_req, res) => {
      res.status(200).json({
        status: 'ok',
        mode: 'http',
        uptime_ms: Date.now() - this.startedAt,
      });
    });

    await new Promise<void>((resolve) => {
      this.httpServer = app.listen(this.config.port, () => resolve());
    });

    this.deps.logger.info('slack.http.listening', { port: this.config.port });
  }

  // -----------------------------------------------------------------------
  // Internal: Socket Mode
  // -----------------------------------------------------------------------

  /**
   * Start the Socket Mode receiver and a minimal `/health` HTTP server.
   *
   * @throws {Error} When `SLACK_APP_TOKEN` is missing or no
   *                 `socketModeClient` was injected.
   */
  private async startSocketMode(): Promise<void> {
    if (!process.env.SLACK_APP_TOKEN) {
      throw new Error('SLACK_APP_TOKEN required for Socket Mode');
    }
    if (!this.deps.socketModeClient) {
      throw new Error('socketModeClient is required for Socket Mode');
    }

    const client = this.deps.socketModeClient;

    // Lifecycle event logging.
    client.on('connecting', () => this.deps.logger.info('slack.socket.connecting'));
    client.on('connected', () => this.deps.logger.info('slack.socket.connected'));
    client.on('disconnected', (reason: unknown) =>
      this.deps.logger.warn('slack.socket.disconnected', { reason }),
    );
    client.on('error', (err: unknown) =>
      this.deps.logger.error('slack.socket.error', {
        error: (err as Error)?.message ?? String(err),
      }),
    );

    // Slash command bridge: same canonical mapping as HTTP mode.
    client.on('slash_commands', async (...args: unknown[]) => {
      const event = args[0] as {
        body: SlackSlashCommandBody;
        ack: (response?: unknown) => Promise<void>;
      };
      try {
        const cmd = mapSlashCommandPayload(event.body);
        await event.ack({ text: 'Processing your request...' });
        const result = await this.deps.router.route(cmd);
        const ctx = getSlackContext(cmd);
        if (ctx?.responseUrl) {
          await postToResponseUrl(
            ctx.responseUrl,
            this.formatResultForResponseUrl(result),
            this.fetchFn,
            this.deps.logger,
          );
        }
      } catch (error) {
        this.deps.logger.error('slack.socket.slash_command_error', {
          error: (error as Error).message,
        });
        await event.ack({ text: `Error: ${(error as Error).message}` });
      }
    });

    // Interactive bridge.
    client.on('interactive', async (...args: unknown[]) => {
      const event = args[0] as {
        body: SlackInteractionPayload;
        ack: (response?: unknown) => Promise<void>;
      };
      await event.ack();
      try {
        const dispatch = mapInteractionPayload(event.body);
        await this.executeInteractionDispatch(dispatch);
      } catch (error) {
        this.deps.logger.error('slack.socket.interactive_error', {
          error: (error as Error).message,
        });
      }
    });

    // events_api: stub (URL verification is HTTP-only).
    client.on('events_api', () => {
      // Intentional no-op; HTTP /slack/events handles URL verification.
    });

    await client.start();

    // Bind a minimal HTTP server for /health only (no /slack/* routes).
    const app = express();
    this.app = app;
    app.get('/health', (_req, res) => {
      res.status(200).json({
        status: 'ok',
        mode: 'socket',
        uptime_ms: Date.now() - this.startedAt,
      });
    });
    await new Promise<void>((resolve) => {
      this.httpServer = app.listen(this.config.port, () => resolve());
    });

    this.deps.logger.info('slack.socket.health_only', { port: this.config.port });
  }

  // -----------------------------------------------------------------------
  // Internal: per-workspace rate limiting
  // -----------------------------------------------------------------------

  /**
   * Apply the per-workspace inbound rate limit. Runs after signature
   * verification and before router dispatch.
   */
  private applyRateLimit(workspaceId: string): Promise<RateLimitDecision> {
    return this.deps.rateLimiter.check({
      key: workspaceId,
      perMinute: this.config.rate_limits.perWorkspacePerMinute,
    });
  }

  // -----------------------------------------------------------------------
  // Internal: slash command pipeline (3s budget)
  // -----------------------------------------------------------------------

  private async handleSlashCommand(req: Request, res: Response): Promise<void> {
    const body = req.body as SlackSlashCommandBody;

    // 1. Map payload onto canonical IncomingCommand.
    let cmd: IncomingCommand;
    try {
      cmd = mapSlashCommandPayload(body);
    } catch (err) {
      res.status(200).json({
        response_type: 'ephemeral',
        text: `Error: ${(err as Error).message}`,
      } satisfies SlackResponseBody);
      return;
    }

    const ctx = getSlackContext(cmd) ?? {
      workspaceId: '',
      channelId: '',
      isDM: false,
    };

    // 2. Per-workspace rate limit (workspace-scoped, NOT user-scoped).
    const rl = await this.applyRateLimit(ctx.workspaceId);
    if (!rl.allowed) {
      this.deps.logger.info('slack.ratelimit.hit', {
        workspaceId: ctx.workspaceId,
        retry_after_ms: rl.retryAfterMs,
      });
      res.status(200).json({
        response_type: 'ephemeral',
        text: `Workspace rate limit reached. Try again in ${Math.ceil(
          (rl.retryAfterMs ?? 60_000) / 1000,
        )}s.`,
      } satisfies SlackResponseBody);
      return;
    }

    // 3. Race the router against the 3-second budget.
    const work = this.deps.router.route(cmd);
    const responseUrl = ctx.responseUrl;

    let inlineSent = false;
    const sendInlineAck = async (): Promise<void> => {
      if (inlineSent) return;
      inlineSent = true;
      res.status(200).json({
        response_type: 'ephemeral',
        text: 'Processing your request...',
      } satisfies SlackResponseBody);
    };

    let outcome: CommandResult | typeof DEFERRED_SENTINEL;
    try {
      outcome = await withResponseBudget(work, 2500, sendInlineAck, this.deps.logger);
    } catch (err) {
      // Router rejected within the budget -> render formatted error inline.
      const formatted = formatError(err as FormattableError);
      res.status(200).json(formatted);
      return;
    }

    if (outcome !== DEFERRED_SENTINEL) {
      // Fast path: send the formatted result inline.
      if (!inlineSent) {
        res.status(200).json(this.formatResultForInline(outcome));
      } else if (responseUrl) {
        // Race lost: ack already sent; post final result via response_url.
        await postToResponseUrl(
          responseUrl,
          this.formatResultForResponseUrl(outcome),
          this.fetchFn,
          this.deps.logger,
        );
      }
      return;
    }

    // Deferred path: ack already sent; let work complete and POST.
    if (!responseUrl) return;
    work.then(
      (result) =>
        postToResponseUrl(
          responseUrl,
          this.formatResultForResponseUrl(result),
          this.fetchFn,
          this.deps.logger,
        ),
      (error) =>
        postToResponseUrl(
          responseUrl,
          formatError(error as FormattableError),
          this.fetchFn,
          this.deps.logger,
        ),
    );
  }

  // -----------------------------------------------------------------------
  // Internal: interaction pipeline
  // -----------------------------------------------------------------------

  private async handleInteraction(req: Request, res: Response): Promise<void> {
    const body = req.body as { payload?: string };
    const payloadStr = body?.payload;
    if (!payloadStr) {
      res.status(400).json({ error: 'missing_payload' });
      return;
    }

    let payload: SlackInteractionPayload;
    try {
      payload = JSON.parse(payloadStr);
    } catch {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }

    const dispatch = mapInteractionPayload(payload);

    if (dispatch.kind === 'error') {
      this.deps.logger.warn('slack.interaction.unknown', {
        type: payload.type,
        verb: payload.actions?.[0]?.action_id,
        callback_id: payload.view?.callback_id,
      });
      res.status(200).json({
        response_type: 'ephemeral',
        text: dispatch.text,
      } satisfies SlackResponseBody);
      return;
    }

    if (dispatch.kind === 'dismiss') {
      if (payload.type === 'view_closed') {
        this.deps.logger.info('slack.modal.closed', {
          callback_id: payload.view?.callback_id,
        });
        res.status(200).send();
        return;
      }
      res.status(200).json({
        replace_original: true,
        text: dispatch.text,
      } satisfies SlackResponseBody);
      return;
    }

    if (dispatch.kind === 'open_modal') {
      // Inline-ack and let the modal open continue async via the adapter.
      res.status(200).send();
      // Modal open is performed by the existing interaction handler; the
      // service does not duplicate the views.open call to avoid two
      // implementations diverging.
      void this.executeInteractionDispatch(dispatch);
      return;
    }

    // dispatch.kind === 'route'
    if (dispatch.responseAction === 'clear') {
      res.status(200).json({ response_action: 'clear' } satisfies SlackResponseBody);
    } else {
      res.status(200).json({
        replace_original: true,
        text: 'Working on it...',
        blocks: [],
      } satisfies SlackResponseBody);
    }

    void this.executeInteractionDispatch(dispatch);
  }

  /**
   * Execute the side-effects of an {@link InteractionDispatch} in the
   * background (after the inline ack has been sent).
   */
  private async executeInteractionDispatch(dispatch: InteractionDispatch): Promise<void> {
    if (dispatch.kind === 'route') {
      try {
        const result = await this.deps.router.route(dispatch.command);
        if (dispatch.resolvePromptForRequestId) {
          const ok = (this.deps.adapter as {
            resolvePendingPrompt?: (id: string, response: unknown) => boolean;
          }).resolvePendingPrompt?.(dispatch.resolvePromptForRequestId, {
            responderId: dispatch.command.source.userId,
            content: dispatch.command.args.join(' '),
            timestamp: new Date(),
          });
          if (ok === false) {
            this.deps.logger.warn('slack.prompt.no_pending', {
              requestId: dispatch.resolvePromptForRequestId,
            });
          }
        }
        const ctx = getSlackContext(dispatch.command);
        if (ctx?.responseUrl) {
          await postToResponseUrl(
            ctx.responseUrl,
            this.formatResultForResponseUrl(result),
            this.fetchFn,
            this.deps.logger,
          );
        }
      } catch (error) {
        this.deps.logger.error('slack.interaction.dispatch_failed', {
          error: (error as Error).message,
        });
      }
      return;
    }

    if (dispatch.kind === 'open_modal') {
      // TODO(PLAN-011-4): Delegate to the existing SlackInteractionHandler
      // for views.open — keeps the modal blocks defined in one place.
      // The current SlackInteractionHandler accepts an Express req/res;
      // a future refactor will expose a typed `openClarifyFreeformModal()`.
      this.deps.logger.info('slack.modal.open_requested', {
        requestId: dispatch.requestId,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Internal: events
  // -----------------------------------------------------------------------

  /**
   * Handle the URL verification challenge for Slack Events API. Other
   * event types are acknowledged with a 200 (router dispatch for events
   * is out of scope for this PLAN).
   */
  private handleEvent(req: Request, res: Response): void {
    const body = req.body as { type?: string; challenge?: string };
    if (body?.type === 'url_verification' && body.challenge) {
      res.status(200).json({ challenge: body.challenge });
      return;
    }
    res.status(200).send('ok');
  }

  // -----------------------------------------------------------------------
  // Internal: result formatting
  // -----------------------------------------------------------------------

  private formatResultForInline(result: CommandResult): SlackResponseBody {
    if (result.success) {
      return {
        response_type: 'in_channel',
        text: this.summarize(result.data),
      };
    }
    return formatError({ code: result.errorCode, message: result.error });
  }

  private formatResultForResponseUrl(result: CommandResult): SlackResponseBody {
    return { ...this.formatResultForInline(result), replace_original: true };
  }

  private summarize(data: unknown): string {
    if (typeof data === 'string') return data;
    if (data === null || data === undefined) return 'Done.';
    try {
      return JSON.stringify(data);
    } catch {
      return 'Done.';
    }
  }

  // -----------------------------------------------------------------------
  // Internal: server graceful close helpers
  // -----------------------------------------------------------------------

  private async stopAccepting(server: http.Server): Promise<void> {
    return new Promise((resolve) => {
      // server.close() stops accepting new connections immediately and
      // calls back when the listening socket is fully released. We
      // intentionally do NOT wait for in-flight requests here — the
      // adapter `drain()` covers that step.
      server.unref();
      // Touching `closeIdleConnections` if available helps tests where
      // keepalive sockets would otherwise hold the server open.
      const maybe = server as http.Server & { closeIdleConnections?: () => void };
      if (typeof maybe.closeIdleConnections === 'function') {
        maybe.closeIdleConnections();
      }
      resolve();
    });
  }

  // -----------------------------------------------------------------------
  // Test accessors
  // -----------------------------------------------------------------------

  /** Returns the underlying Express app (for supertest). */
  getApp(): Express | null {
    return this.app;
  }

  /** Whether {@link shutdown} is currently in progress (or finished). */
  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }
}

// ---------------------------------------------------------------------------
// Default fetch wrapper
// ---------------------------------------------------------------------------

const defaultFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, init);
  return { ok: response.ok, status: response.status };
};

// ---------------------------------------------------------------------------
// Factory: startSlackService
// ---------------------------------------------------------------------------

/**
 * Construction-time inputs for {@link startSlackService}. The factory
 * builds defaults for the optional dependencies and registers signal
 * handlers for graceful shutdown.
 *
 * `router` is required (the caller wires the IntakeRouter via
 * `initRouter()` / equivalent). All other deps default to constructed
 * helpers that pull tokens from `process.env`.
 */
export interface StartSlackServiceOptions {
  config?: Partial<SlackServiceConfig>;
  router: IntakeRouterLike;
  adapter: SlackAdapter;
  commandHandler: SlackCommandHandler;
  interactionHandler: SlackInteractionHandler;
  rateLimiter?: InboundRateLimiter;
  socketModeClient?: SocketModeClient;
  verifier?: SlackVerifier;
  logger?: SlackServiceLogger;
  fetchFn?: FetchLike;
  /** Test hook: skip registering process.on(SIGTERM/SIGINT) handlers. */
  skipSignalHandlers?: boolean;
}

/**
 * Construct, start, and register signal handlers for a {@link SlackService}.
 *
 * Defaults applied:
 * - `config` merged with {@link DEFAULT_SLACK_SERVICE_CONFIG}.
 * - `verifier` defaults to `new SlackVerifier()` (reads
 *   `SLACK_SIGNING_SECRET`).
 * - `rateLimiter` defaults to {@link InMemoryInboundRateLimiter}.
 * - `logger` defaults to a no-op (callers should supply a structured
 *   logger in production).
 *
 * Signal handlers (`SIGTERM`, `SIGINT`, `uncaughtException`) all invoke
 * `service.shutdown()`. The handlers are idempotent (the underlying
 * `shuttingDown` guard prevents double-runs) so multiple signals do
 * not race.
 */
export async function startSlackService(
  opts: StartSlackServiceOptions,
): Promise<SlackService> {
  const config: SlackServiceConfig = {
    ...DEFAULT_SLACK_SERVICE_CONFIG,
    ...opts.config,
    rate_limits: {
      ...DEFAULT_SLACK_SERVICE_CONFIG.rate_limits,
      ...(opts.config?.rate_limits ?? {}),
    },
  };

  // Validate before constructing anything that touches env tokens.
  validateSlackServiceConfig(config);

  const logger = opts.logger ?? noopLogger;
  const verifier = opts.verifier ?? new SlackVerifier();
  const rateLimiter = opts.rateLimiter ?? new InMemoryInboundRateLimiter();

  const deps: SlackServiceDeps = {
    router: opts.router,
    adapter: opts.adapter,
    verifier,
    commandHandler: opts.commandHandler,
    interactionHandler: opts.interactionHandler,
    rateLimiter,
    socketModeClient: opts.socketModeClient,
    logger,
  };

  const service = new SlackService(deps, config, opts.fetchFn);
  await service.start();

  if (!opts.skipSignalHandlers) {
    const onSignal = (): void => {
      void service.shutdown();
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    process.on('uncaughtException', (err: Error) => {
      logger.error('slack.uncaught', { error: err.message, stack: err.stack });
      void service.shutdown();
    });
  }

  return service;
}

// ---------------------------------------------------------------------------
// Optional convenience: subtle-equals helper exposed for test signature work
// ---------------------------------------------------------------------------

/**
 * Compute a Slack-style HMAC signature for the given inputs. Exposed so
 * the test signing helper does not need to re-derive the algorithm.
 */
export function computeSlackSignature(
  signingSecret: string,
  timestamp: number | string,
  body: string,
): string {
  const base = `v0:${timestamp}:${body}`;
  return 'v0=' + crypto.createHmac('sha256', signingSecret).update(base).digest('hex');
}
