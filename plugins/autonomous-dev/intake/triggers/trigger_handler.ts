/**
 * ONBOARD Phase 4 (#596) — the scoped trigger command handler.
 *
 * A `CommandHandler` (command name `trigger`) registered on `intake_router`.
 * It wires the Phase-4 pieces onto the EXISTING intake submit path:
 *   parse (scoped_command) → sanitize (intake sanitizer) → resolve scope
 *   (scope_resolution vs P0 ownership) → pick a concrete target repo →
 *   scope-authz (scope_authz, composing the per-repo AuthzEngine decision) →
 *   enqueue a normal pipeline request (so R1 + the allowlist apply unchanged).
 *
 * All collaborators are INJECTED (db, emitter, ownership reader, the per-repo
 * authorize fn, injection rules) so the handler is fully unit-testable without
 * a live DB, ownership manifest, or AuthzEngine. The scope→request/origin
 * linkage that reporting (step 4) and the watch (step 5) need is recorded by
 * the trigger store (step 3) — wired in a follow-up; here we audit the scope.
 *
 * @module intake/triggers/trigger_handler
 */

import type { Ownership } from '../../src/ownership/types';
import type {
  AuthzContext,
  ChannelType,
  CommandHandler,
  CommandResult,
  IncomingCommand,
} from '../adapters/adapter_interface';
import type { IntakeEventEmitter } from '../core/intake_router';
import { sanitize, type InjectionRule } from '../core/sanitizer';
import type { Repository, RequestEntity } from '../db/repository';
import { channelTypeToRequestSource } from '../types/request_source';

import { canTriggerScope, type RepoAuthorizeFn } from './scope_authz';
import { resolveScope } from './scope_resolution';
import { parseScopedTrigger } from './scoped_command';
import {
  commitTrigger,
  defaultTriggerStoreIO,
  hasSeen,
  type TriggerStoreIO,
} from './trigger_store';

/**
 * Per-repo authorize decision WITH the originating channel (for audit). The
 * production wiring closes over the intake AuthzEngine
 * (`(u, repo, ch) => authz.authorize(u, 'trigger', { targetRepo: repo }, ch).granted`);
 * the handler binds the channel per request, then composes across the scope.
 */
export type TriggerAuthorizeFn = (
  userId: string,
  targetRepo: string,
  sourceChannel: ChannelType,
) => boolean;

export interface TriggerHandlerDeps {
  injectionRules?: InjectionRule[];
  /** Injected store seam (defaults to real fs); tests pass an in-memory IO. */
  storeIO?: TriggerStoreIO;
}

export class TriggerHandler implements CommandHandler {
  constructor(
    private readonly db: Repository,
    private readonly emitter: IntakeEventEmitter,
    /** Loads the current ownership tree (prod: `() => readOwnership()`). */
    private readonly ownershipReader: () => Ownership,
    /** Per-repo decision (prod: wraps `AuthzEngine.authorize(u,'trigger',{targetRepo},ch).granted`). */
    private readonly authorize: TriggerAuthorizeFn,
    private readonly deps: TriggerHandlerDeps = {},
  ) {}

  isQueryCommand(): boolean {
    return false;
  }

  buildAuthzContext(command: IncomingCommand): AuthzContext {
    // Surface the repo to the router's coarse authorize() when the scope is a
    // repo; project scope has no single repo (scope_authz does the per-repo
    // check inside execute()).
    if (command.args[0] === 'repo' && typeof command.args[1] === 'string') {
      return { targetRepo: command.args[1].trim() };
    }
    return {};
  }

  async execute(command: IncomingCommand, userId: string): Promise<CommandResult> {
    const storeIO = this.deps.storeIO ?? defaultTriggerStoreIO;
    // Trim so a whitespace-only message id can't both bypass dedupe (length>0)
    // and pollute the seen-set; an effectively-empty id means "no dedupe key".
    const messageId =
      typeof command.flags['messageId'] === 'string' ? command.flags['messageId'].trim() : '';

    // 0. Idempotency: a retried inbound webhook (same message id) must not
    //    re-enqueue. Survives restarts (the seen-set is read from disk). The
    //    intake router is sequential, so check-then-commit cannot race.
    if (messageId.length > 0 && hasSeen(messageId, storeIO)) {
      return { success: true, data: { requestId: null, alreadyReceived: true } };
    }

    // 1. Parse the scoped grammar.
    const parsed = parseScopedTrigger(command.args);
    if (!parsed.ok) {
      return { success: false, error: parsed.message, errorCode: 'VALIDATION_ERROR' };
    }

    // 2. Sanitize the task (reuse the intake injection rules).
    if (this.deps.injectionRules && this.deps.injectionRules.length > 0) {
      const s = sanitize(parsed.task, this.deps.injectionRules);
      if (s.blocked) {
        return {
          success: false,
          error: 'Task blocked: potential prompt injection detected.',
          errorCode: 'INJECTION_BLOCKED',
          data: { appliedRules: s.appliedRules },
        };
      }
    }

    // 3. Resolve the scope against ownership.
    const resolved = resolveScope(this.ownershipReader(), parsed.scopeType, parsed.scopeId);
    if (!resolved.found) {
      return {
        success: false,
        error: `Unknown ${parsed.scopeType}: ${parsed.scopeId}`,
        errorCode: 'UNKNOWN_SCOPE',
      };
    }

    // 4. Pick a concrete target repo. v1: a repo scope is the repo; a project
    //    scope must resolve to exactly one repo (no silent multi-repo fan-out).
    let targetRepo: string;
    if (resolved.scopeType === 'repo') {
      targetRepo = resolved.scopeId;
    } else if (resolved.repoIds.length === 1) {
      targetRepo = resolved.repoIds[0];
    } else if (resolved.repoIds.length === 0) {
      return {
        success: false,
        error: `Project ${resolved.scopeId} has no repos to act on.`,
        errorCode: 'UNKNOWN_SCOPE',
      };
    } else {
      return {
        success: false,
        error: `Project ${resolved.scopeId} has ${resolved.repoIds.length} repos — target one with: /autodev repo <owner/name> <task>.`,
        errorCode: 'AMBIGUOUS_SCOPE',
      };
    }

    // 5. Scope-aware authorization (composes the per-repo AuthzEngine decision
    //    across the scope; bind the per-request channel for the audit trail).
    const channelType = command.source.channelType;
    const authorizeForChannel: RepoAuthorizeFn = (uid, repo) =>
      this.authorize(uid, repo, channelType);
    let authz: ReturnType<typeof canTriggerScope>;
    try {
      authz = canTriggerScope(resolved, userId, authorizeForChannel);
    } catch {
      // A throw from the injected AuthzEngine must not escape as a 500 — fail
      // closed with a typed error (nothing has been enqueued yet).
      return { success: false, error: 'authorization check failed', errorCode: 'INTERNAL_ERROR' };
    }
    if (!authz.allowed) {
      return {
        success: false,
        error: authz.reason ?? 'Not authorized for this scope.',
        errorCode: 'UNAUTHORIZED',
      };
    }

    // 6. Enqueue a normal pipeline request (mirrors SubmitHandler's build). One
    //    clock (storeIO.now) for the row + the trigger record so they agree.
    const nowMs = storeIO.now();
    const now = new Date(nowMs).toISOString();
    const requestId = this.db.generateRequestId();

    const request: RequestEntity = {
      request_id: requestId,
      title: parsed.task.slice(0, 100),
      description: parsed.task,
      raw_input: command.rawText,
      priority: 'normal',
      target_repo: targetRepo,
      status: 'queued',
      current_phase: 'intake',
      phase_progress: null,
      requester_id: userId,
      // Mirror SubmitHandler: cli → claude_app for the state-channel label.
      source_channel: channelType === 'cli' ? 'claude_app' : channelType,
      notification_config: '{}',
      deadline: null,
      related_tickets: '[]',
      technical_constraints: null,
      acceptance_criteria: null,
      blocker: null,
      promotion_count: 0,
      last_promoted_at: null,
      paused_at_phase: null,
      type: 'feature',
      source: channelTypeToRequestSource(channelType),
      adapter_metadata: {},
      created_at: now,
      updated_at: now,
    };

    this.db.insertRequest(request);

    const position = this.db.getQueuePosition(requestId);
    this.emitter.emit('request_submitted', { requestId, userId, priority: 'normal', position });
    this.db.insertActivityLog({
      request_id: requestId,
      event: 'trigger_enqueued',
      phase: 'intake',
      details: JSON.stringify({
        scope: resolved.scope,
        scopeId: resolved.scopeId,
        scopeType: resolved.scopeType,
        targetRepo,
        position,
      }),
    });

    // Record the trigger (origin + scope) and mark the message id seen so a
    // retry is deduped. Reporting (step 4) + the watch (step 5) read this.
    // Best-effort: the request is already enqueued, so a store-write failure
    // degrades tracking/reporting but must not fail the run.
    try {
      commitTrigger(
        {
          requestId,
          scope: resolved.scope,
          scopeId: resolved.scopeId,
          scopeType: resolved.scopeType,
          targetRepo,
          origin: {
            platform: channelType,
            channelId: command.source.platformChannelId,
            userId: command.source.userId,
            messageId: messageId.length > 0 ? messageId : undefined,
          },
          createdAtMs: nowMs,
          status: 'enqueued',
        },
        storeIO,
      );
    } catch {
      /* best-effort tracking */
    }

    return {
      success: true,
      data: { requestId, scope: resolved.scope, targetRepo, position },
    };
  }
}
