/**
 * IntakeRouter: central command dispatch pipeline.
 *
 * Implements the resolve-user -> authorize -> rate-limit -> execute pipeline
 * described in SPEC-008-1-06 (Task 12).  All 10 command handlers are registered
 * on construction and dispatched via a string-keyed handler map.
 *
 * @module intake_router
 */

import type {
  AuthzAction,
  ChannelType,
  CommandHandler,
  CommandResult,
  CommandSource,
  IncomingCommand,
} from '../adapters/adapter_interface';
import type { AuthzEngine } from '../authz/authz_engine';
import type { RateLimiter } from '../rate_limit/rate_limiter';
import type { Repository } from '../db/repository';

import { SubmitHandler } from '../handlers/submit_handler';
import { StatusHandler } from '../handlers/status_handler';
import { ListHandler } from '../handlers/list_handler';
import { CancelHandler } from '../handlers/cancel_handler';
import { PauseHandler } from '../handlers/pause_handler';
import { ResumeHandler } from '../handlers/resume_handler';
import { PriorityHandler } from '../handlers/priority_handler';
import { LogsHandler } from '../handlers/logs_handler';
import { FeedbackHandler } from '../handlers/feedback_handler';
import { KillHandler } from '../handlers/kill_handler';
import { InvalidStateError } from '../handlers/state_machine';

// ---------------------------------------------------------------------------
// Dependencies that SubmitHandler needs beyond the base repository
// ---------------------------------------------------------------------------

import type { ClaudeApiClient } from '../core/request_parser';
import type { DuplicateDetector } from '../core/duplicate_detector';
import type { InjectionRule } from '../core/sanitizer';

// ---------------------------------------------------------------------------
// EventEmitter contract (optional dependency)
// ---------------------------------------------------------------------------

/** Minimal event emitter interface for domain events. */
export interface IntakeEventEmitter {
  emit(event: string, payload: unknown): void;
}

/** No-op event emitter used when no emitter is provided. */
const nullEmitter: IntakeEventEmitter = {
  emit: () => {},
};

// ---------------------------------------------------------------------------
// Router dependencies
// ---------------------------------------------------------------------------

/** All dependencies required to construct the IntakeRouter. */
export interface IntakeRouterDeps {
  authz: AuthzEngine;
  rateLimiter: RateLimiter;
  db: Repository;
  emitter?: IntakeEventEmitter;
  /** Required by SubmitHandler for NLP parsing. */
  claudeClient?: ClaudeApiClient;
  /** Required by SubmitHandler for duplicate detection. */
  duplicateDetector?: DuplicateDetector;
  /** Required by SubmitHandler for prompt-injection sanitization. */
  injectionRules?: InjectionRule[];
}

// ---------------------------------------------------------------------------
// IntakeRouter
// ---------------------------------------------------------------------------

/**
 * Central command router for the intake layer.
 *
 * Dispatch pipeline (per command):
 * 1. Look up the handler by command name.
 * 2. Resolve the internal user identity from the command source.
 * 3. Authorize the user for the requested action.
 * 4. Check rate limits.
 * 5. Execute the handler.
 *
 * Errors at any stage short-circuit with the appropriate error code.
 */
export class IntakeRouter {
  private handlers: Map<string, CommandHandler> = new Map();

  constructor(private readonly deps: IntakeRouterDeps) {
    this.registerHandlers();
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Route an incoming command through the full dispatch pipeline.
   */
  async route(command: IncomingCommand): Promise<CommandResult> {
    // Step 0: Look up handler
    const handler = this.handlers.get(command.commandName);
    if (!handler) {
      return {
        success: false,
        error: `Unknown command: ${command.commandName}`,
        errorCode: 'VALIDATION_ERROR',
      };
    }

    // Step 1: Resolve internal user identity
    const userId = this.resolveUserId(command.source);
    if (!userId) {
      return {
        success: false,
        error: 'Unable to resolve user identity',
        errorCode: 'AUTHZ_DENIED',
      };
    }

    // Step 2: Authorization check
    const authzContext = handler.buildAuthzContext(command);
    const decision = this.deps.authz.authorize(
      userId,
      command.commandName as AuthzAction,
      authzContext,
      command.source.channelType,
    );
    await this.deps.db.insertAuditLog(decision);
    if (!decision.granted) {
      return {
        success: false,
        error: `Permission denied: ${decision.reason}`,
        errorCode: 'AUTHZ_DENIED',
      };
    }

    // Step 3: Rate limit check
    const actionType = handler.isQueryCommand() ? 'query' : 'submission';
    const rateResult = this.deps.rateLimiter.checkLimit(userId, actionType);
    if (!rateResult.allowed) {
      return {
        success: false,
        error: rateResult.message,
        errorCode: 'RATE_LIMITED',
        retryAfterMs: rateResult.retryAfterMs,
      };
    }

    // Step 4: Execute
    try {
      return await handler.execute(command, userId);
    } catch (error) {
      if (error instanceof InvalidStateError) {
        return {
          success: false,
          error: error.message,
          errorCode: 'INVALID_STATE',
        };
      }
      return {
        success: false,
        error: 'An internal error occurred.',
        errorCode: 'INTERNAL_ERROR',
      };
    }
  }

  // =========================================================================
  // Handler registration
  // =========================================================================

  /**
   * Register all 10 command handlers.
   */
  private registerHandlers(): void {
    const emitter = this.deps.emitter ?? nullEmitter;
    const db = this.deps.db;

    this.handlers.set(
      'submit',
      new SubmitHandler(db, emitter, {
        claudeClient: this.deps.claudeClient,
        duplicateDetector: this.deps.duplicateDetector,
        injectionRules: this.deps.injectionRules,
      }),
    );
    this.handlers.set('status', new StatusHandler(db));
    this.handlers.set('list', new ListHandler(db));
    this.handlers.set('cancel', new CancelHandler(db, emitter));
    this.handlers.set('pause', new PauseHandler(db, emitter));
    this.handlers.set('resume', new ResumeHandler(db, emitter));
    this.handlers.set('priority', new PriorityHandler(db, emitter));
    this.handlers.set('logs', new LogsHandler(db));
    this.handlers.set('feedback', new FeedbackHandler(db, emitter));
    this.handlers.set('kill', new KillHandler(db, emitter));
  }

  // =========================================================================
  // User resolution
  // =========================================================================

  /**
   * Resolve the internal user ID from a command source.
   *
   * Looks up the user by platform-specific ID using the authz engine's
   * `resolveUserId` method, which searches the YAML config.
   */
  private resolveUserId(source: CommandSource): string | undefined {
    const platformKey = this.channelTypeToPlatformKey(source.channelType);
    return this.deps.authz.resolveUserId(platformKey, source.userId);
  }

  /**
   * Map a channel type to the platform identity key used in the authz config.
   */
  private channelTypeToPlatformKey(
    channelType: ChannelType,
  ): 'discord_id' | 'slack_id' | 'claude_user' | 'cli_user' {
    switch (channelType) {
      case 'discord':
        return 'discord_id';
      case 'slack':
        return 'slack_id';
      case 'claude_app':
        return 'claude_user';
      case 'cli':
        // TODO(PLAN-011-1): authz config must define cli_user identity for operators
        return 'cli_user';
    }
  }
}
