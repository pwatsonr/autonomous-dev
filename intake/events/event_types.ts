/**
 * Internal event contract for the intake layer.
 *
 * Defines the typed discriminated unions for intake events (emitted by the
 * intake layer to the pipeline core) and pipeline events (consumed from the
 * pipeline core). Together with the EventBus, these form the typed messaging
 * backbone between intake and pipeline layers.
 *
 * Implements SPEC-008-1-07, Task 14 (event contract portion).
 *
 * @module event_types
 */

import type {
  Priority,
  StructuredPrompt,
  UserResponse,
} from '../adapters/adapter_interface';
import type { RequestEntity } from '../db/repository';

// ---------------------------------------------------------------------------
// Intake events (emitted by intake layer -> pipeline core)
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all events emitted by the intake layer.
 *
 * Each variant carries a `type` discriminant for exhaustive pattern matching.
 */
export type IntakeEvent =
  | { type: 'request_submitted'; requestId: string; request: RequestEntity }
  | { type: 'request_cancelled'; requestId: string; cleanupRequested: boolean }
  | { type: 'request_paused'; requestId: string }
  | { type: 'request_resumed'; requestId: string; resumeAtPhase: string }
  | { type: 'priority_changed'; requestId: string; oldPriority: Priority; newPriority: Priority }
  | { type: 'feedback_received'; requestId: string; userId: string; content: string }
  | { type: 'kill_all'; initiatedBy: string; timestamp: Date }
  | { type: 'human_response'; requestId: string; messageId: string; response: UserResponse };

// ---------------------------------------------------------------------------
// Pipeline events (consumed from pipeline core)
// ---------------------------------------------------------------------------

/**
 * Metadata attached to a phase transition event.
 */
export interface PhaseTransitionMetadata {
  /** Progress indicator for multi-step phases. */
  progress?: { current: number; total: number };
  /** URL of the artifact produced during this phase. */
  artifactUrl?: string;
  /** Description of a blocker encountered during the phase. */
  blocker?: string;
  /** The agent's reasoning for the phase transition. */
  agentReasoning?: string;
}

/**
 * Links to artifacts produced by a completed request.
 */
export interface ArtifactLinks {
  /** URL of the PRD pull request. */
  prdPr?: string;
  /** URL of the TDD pull request. */
  tddPr?: string;
  /** URL of the code pull request. */
  codePr?: string;
  /** Name of the branch created for this request. */
  branch?: string;
}

/**
 * Discriminated union of all events consumed from the pipeline core.
 *
 * Each variant carries a `type` discriminant for exhaustive pattern matching.
 */
export type PipelineEvent =
  | { type: 'phase_transition'; requestId: string; fromPhase: string; toPhase: string; timestamp: Date; metadata: PhaseTransitionMetadata }
  | { type: 'blocker_detected'; requestId: string; description: string }
  | { type: 'human_input_needed'; requestId: string; prompt: StructuredPrompt }
  | { type: 'request_completed'; requestId: string; artifacts: ArtifactLinks }
  | { type: 'request_failed'; requestId: string; error: string };

// ---------------------------------------------------------------------------
// Event map (channels -> event types)
// ---------------------------------------------------------------------------

/**
 * Maps channel names to their corresponding event types.
 *
 * Used by `TypedEventBus` to enforce type safety on subscribe/emit calls.
 */
export type EventMap = {
  intake: IntakeEvent;
  pipeline: PipelineEvent;
};
