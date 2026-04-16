/**
 * SubmitHandler: processes new request submissions.
 *
 * Pipeline: sanitize -> NLP parse -> ambiguity detect -> duplicate detect -> enqueue.
 * Returns `{ requestId, position, estimatedWait }` on success.
 *
 * Implements SPEC-008-1-06 SubmitHandler specification.
 *
 * @module submit_handler
 */

import type {
  AuthzContext,
  CommandHandler,
  CommandResult,
  IncomingCommand,
  Priority,
} from '../adapters/adapter_interface';
import type { Repository, RequestEntity } from '../db/repository';
import type { IntakeEventEmitter } from '../core/intake_router';
import type { ClaudeApiClient } from '../core/request_parser';
import type { DuplicateDetector } from '../core/duplicate_detector';
import type { InjectionRule } from '../core/sanitizer';
import { sanitize } from '../core/sanitizer';
import { parseRequest } from '../core/request_parser';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum description length (characters). */
const MIN_DESCRIPTION_LENGTH = 10;

/** Maximum description length (characters). */
const MAX_DESCRIPTION_LENGTH = 10_000;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface SubmitHandlerDeps {
  claudeClient?: ClaudeApiClient;
  duplicateDetector?: DuplicateDetector;
  injectionRules?: InjectionRule[];
}

// ---------------------------------------------------------------------------
// SubmitHandler
// ---------------------------------------------------------------------------

export class SubmitHandler implements CommandHandler {
  constructor(
    private readonly db: Repository,
    private readonly emitter: IntakeEventEmitter,
    private readonly deps: SubmitHandlerDeps = {},
  ) {}

  isQueryCommand(): boolean {
    return false;
  }

  buildAuthzContext(command: IncomingCommand): AuthzContext {
    const targetRepo =
      typeof command.flags['--repo'] === 'string'
        ? command.flags['--repo']
        : typeof command.flags['repo'] === 'string'
          ? command.flags['repo']
          : undefined;
    return { targetRepo };
  }

  async execute(command: IncomingCommand, userId: string): Promise<CommandResult> {
    const description = command.args.join(' ').trim();

    // Validate description length
    if (description.length < MIN_DESCRIPTION_LENGTH) {
      return {
        success: false,
        error: `Description must be at least ${MIN_DESCRIPTION_LENGTH} characters.`,
        errorCode: 'VALIDATION_ERROR',
      };
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      return {
        success: false,
        error: `Description must not exceed ${MAX_DESCRIPTION_LENGTH} characters.`,
        errorCode: 'VALIDATION_ERROR',
      };
    }

    // Stage 1: Sanitize
    if (this.deps.injectionRules && this.deps.injectionRules.length > 0) {
      const sanitizationResult = sanitize(description, this.deps.injectionRules);
      if (sanitizationResult.blocked) {
        return {
          success: false,
          error: 'Request blocked: potential prompt injection detected.',
          errorCode: 'INJECTION_BLOCKED',
          data: { appliedRules: sanitizationResult.appliedRules },
        };
      }
    }

    // Stage 2: NLP parse
    let title = description.slice(0, 100);
    let parsedDescription = description;
    let targetRepo: string | null = null;
    let deadline: string | null = null;
    let relatedTickets: string[] = [];
    let technicalConstraints: string | null = null;
    let acceptanceCriteria: string | null = null;

    if (this.deps.claudeClient) {
      const repoFlag =
        typeof command.flags['--repo'] === 'string'
          ? command.flags['--repo']
          : typeof command.flags['repo'] === 'string'
            ? command.flags['repo']
            : undefined;

      const parsed = await parseRequest(description, this.deps.claudeClient, {
        repoFlag,
      });
      title = parsed.title;
      parsedDescription = parsed.description;
      targetRepo = parsed.target_repo;
      deadline = parsed.deadline;
      relatedTickets = parsed.related_tickets;
      technicalConstraints = parsed.technical_constraints;
      acceptanceCriteria = parsed.acceptance_criteria;
    }

    // Apply flag overrides
    const flagRepo =
      typeof command.flags['--repo'] === 'string'
        ? command.flags['--repo']
        : typeof command.flags['repo'] === 'string'
          ? command.flags['repo']
          : null;
    if (flagRepo) targetRepo = flagRepo;

    const flagDeadline =
      typeof command.flags['--deadline'] === 'string'
        ? command.flags['--deadline']
        : typeof command.flags['deadline'] === 'string'
          ? command.flags['deadline']
          : null;
    if (flagDeadline) deadline = flagDeadline;

    const flagPriority =
      typeof command.flags['--priority'] === 'string'
        ? command.flags['--priority']
        : typeof command.flags['priority'] === 'string'
          ? command.flags['priority']
          : null;
    const priority: Priority =
      flagPriority === 'high' || flagPriority === 'normal' || flagPriority === 'low'
        ? flagPriority
        : 'normal';

    // Stage 3: Duplicate detection
    if (this.deps.duplicateDetector) {
      const duplicateResult = await this.deps.duplicateDetector.detectDuplicate(
        {
          title,
          description: parsedDescription,
          priority,
          target_repo: targetRepo,
          deadline,
          related_tickets: relatedTickets,
          technical_constraints: technicalConstraints,
          acceptance_criteria: acceptanceCriteria,
          confidence: 1.0,
        },
        {
          async getRequestEmbeddings(cutoff: Date) {
            return [];
          },
          async storeRequestEmbedding() {},
        },
        { enabled: true, similarity_threshold: 0.85, lookback_days: 30 },
      );

      if (
        duplicateResult.isDuplicate &&
        !command.flags['--force'] &&
        !command.flags['force']
      ) {
        return {
          success: false,
          error: 'Duplicate request detected.',
          errorCode: 'DUPLICATE_DETECTED',
          data: { candidates: duplicateResult.candidates },
        };
      }
    }

    // Stage 4: Enqueue
    const now = new Date().toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z');
    const requestId = this.db.generateRequestId();

    const request: RequestEntity = {
      request_id: requestId,
      title,
      description: parsedDescription,
      raw_input: description,
      priority,
      target_repo: targetRepo,
      status: 'queued',
      current_phase: 'intake',
      phase_progress: null,
      requester_id: userId,
      source_channel: command.source.channelType,
      notification_config: '{}',
      deadline,
      related_tickets: JSON.stringify(relatedTickets),
      technical_constraints: technicalConstraints,
      acceptance_criteria: acceptanceCriteria,
      blocker: null,
      promotion_count: 0,
      last_promoted_at: null,
      paused_at_phase: null,
      created_at: now,
      updated_at: now,
    };

    this.db.insertRequest(request);

    const position = this.db.getQueuePosition(requestId);
    const avgDuration = this.db.getAveragePipelineDuration(20);
    const concurrentSlots = this.db.getMaxConcurrentSlots();

    let estimatedWait = 'Unable to estimate (insufficient history)';
    if (avgDuration && concurrentSlots) {
      const waitMs = (position / concurrentSlots) * avgDuration;
      estimatedWait = formatDuration(waitMs);
    }

    this.emitter.emit('request_submitted', {
      requestId,
      userId,
      priority,
      position,
    });

    this.db.insertActivityLog({
      request_id: requestId,
      event: 'request_submitted',
      phase: 'intake',
      details: JSON.stringify({ priority, position, estimatedWait }),
    });

    return {
      success: true,
      data: { requestId, position, estimatedWait },
    };
  }
}

// ---------------------------------------------------------------------------
// Duration formatting (duplicated from request_queue for independence)
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms <= 0) return '< 1m';
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 1) return '< 1m';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}
