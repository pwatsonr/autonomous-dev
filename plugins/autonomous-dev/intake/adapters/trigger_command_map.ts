/**
 * ONBOARD Phase 6 (#583) — map a scoped `/autodev` chat command (Discord or
 * Slack) to the canonical intake `IncomingCommand` that routes to the
 * TriggerHandler.
 *
 * Both inbound adapters extract the same four pieces — scope type, scope id,
 * task text, and a platform message/interaction id — then call
 * {@link buildTriggerCommand}. Centralizing the shape here guarantees:
 *   - `commandName` is exactly `'trigger'` (so the intake router dispatches to
 *     the TriggerHandler);
 *   - the scoped grammar is `args = [scopeType, scopeId, task]`
 *     (`parseScopedTrigger` joins `args[2:]` back into the task, so a single
 *     task element is preserved verbatim);
 *   - `flags.messageId` carries the idempotency key — which MUST be the
 *     platform's signature-verified interaction/event id, so a retried or
 *     forged webhook cannot double-enqueue (security blocker 2).
 *
 * @module intake/adapters/trigger_command_map
 */

import type { ChannelType, IncomingCommand } from './adapter_interface';

/** The chat-platform command name for scoped triggers (`/autodev …`). Shared by
 *  the Discord/Slack registration and dispatch so they cannot drift. */
export const AUTODEV_COMMAND_NAME = 'autodev';

export interface TriggerCommandInput {
  /** `'repo'` | `'project'` — validated downstream by `parseScopedTrigger`. */
  scopeType: string;
  scopeId: string;
  task: string;
  channelType: ChannelType;
  /** Internal/resolved user id (authz subject). */
  userId: string;
  /** Platform channel id (for reporting back to origin). */
  channelId?: string;
  /**
   * Platform message/interaction id — the dedup key. MUST come from the
   * signature-verified payload (Discord `interaction.id`, Slack `trigger_id` /
   * `event_id`) so it cannot be forged or replayed into a double-run.
   */
  messageId: string;
  /** Optional verbatim text for the audit trail. */
  rawText?: string;
}

/**
 * Build the canonical `IncomingCommand` for a scoped `/autodev` trigger from
 * any chat platform. Pure (apart from the source timestamp); the adapters do
 * the platform-specific extraction + signature verification before calling it.
 */
export function buildTriggerCommand(input: TriggerCommandInput): IncomingCommand {
  return {
    commandName: 'trigger',
    args: [input.scopeType, input.scopeId, input.task],
    flags: { messageId: input.messageId },
    rawText: input.rawText ?? `/autodev ${input.scopeType} ${input.scopeId} ${input.task}`,
    source: {
      channelType: input.channelType,
      userId: input.userId,
      platformChannelId: input.channelId,
      timestamp: new Date(),
    },
  };
}
