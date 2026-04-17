/**
 * Canary State Manager (SPEC-005-5-1, Task 1).
 *
 * Tracks extended validation periods for agents with proposals that
 * passed A/B testing. Manages the full canary lifecycle: creation,
 * comparison recording, completion, and termination.
 *
 * State is persisted to `data/canary-state.json` and survives restarts.
 *
 * Lifecycle:
 *   1. `startCanary()`: Create state, set end date, persist, transition
 *      agent to CANARY state.
 *   2. During canary: `addComparison()` appends comparison results.
 *   3. `completeCanary()`: Set final status (positive or negative).
 *   4. `terminateCanary()`: Immediate termination on catastrophic regression.
 *
 * Exports: `CanaryStateManager`, `CanaryState`, `CanaryComparison`, `CanaryStatus`
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { AgentFactoryConfig } from '../config';
import type { AuditLogger } from '../audit';
import type { IAgentRegistry } from '../types';
import type { AgentProposal } from '../improvement/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lifecycle status of a canary validation period. */
export type CanaryStatus =
  | 'active'
  | 'completed_positive'
  | 'completed_negative'
  | 'terminated_regression';

/** A single comparison recorded during the canary period. */
export interface CanaryComparison {
  /** UUID v4 identifying this comparison. */
  comparison_id: string;
  /** ISO 8601 timestamp of the comparison. */
  timestamp: string;
  /** SHA-256 hex digest of the input that produced both outputs. */
  input_hash: string;
  /** Quality score for the current agent's output. */
  current_score: number;
  /** Quality score for the proposed agent's output. */
  proposed_score: number;
  /** proposed_score - current_score. */
  delta: number;
  /** Delta per quality dimension (dimension_name -> proposed - current). */
  per_dimension: Record<string, number>;
  /** Classification of the comparison outcome. */
  outcome: 'proposed_wins' | 'current_wins' | 'tie';
}

/** Complete canary state for a single agent. */
export interface CanaryState {
  agent_name: string;
  current_version: string;
  proposed_version: string;
  proposal_id: string;
  /** ISO 8601 timestamp when the canary period started. */
  canary_started_at: string;
  /** ISO 8601 timestamp when the canary period is scheduled to end. */
  canary_ends_at: string;
  /** All comparisons recorded during the canary period. */
  comparisons: CanaryComparison[];
  /** Whether an auto-rollback was triggered due to catastrophic regression. */
  auto_rollback_triggered: boolean;
  /** Current lifecycle status. */
  status: CanaryStatus;
}

// ---------------------------------------------------------------------------
// Persistence schema
// ---------------------------------------------------------------------------

/** Shape of the persisted state file. */
interface PersistedCanaryData {
  canaries: Record<string, CanaryState>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default canary duration in days. */
const DEFAULT_CANARY_DURATION_DAYS = 7;

/** Milliseconds per day. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// CanaryStateManager
// ---------------------------------------------------------------------------

export class CanaryStateManager {
  private readonly config: AgentFactoryConfig;
  private readonly auditLogger: AuditLogger;
  private readonly statePath: string;
  private readonly registry: IAgentRegistry | null;

  /** In-memory canary states keyed by agent name. */
  private canaries: Map<string, CanaryState> = new Map();

  constructor(
    config: AgentFactoryConfig,
    auditLogger: AuditLogger,
    registry?: IAgentRegistry,
  ) {
    this.config = config;
    this.auditLogger = auditLogger;
    this.registry = registry ?? null;

    // Resolve the persistence path from config
    const canaryStatePath = config.paths['canary-state'] ?? 'data/canary-state.json';
    this.statePath = path.resolve(canaryStatePath);

    this.loadState();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Create a new canary for an agent.
   *
   * Sets up the canary state with the configured duration, persists it,
   * and transitions the agent to the CANARY registry state.
   *
   * @param agentName  The name of the agent entering canary.
   * @param proposal   The agent proposal that passed A/B validation.
   * @returns          The newly created CanaryState.
   * @throws           Error if a canary is already active for this agent.
   */
  startCanary(agentName: string, proposal: AgentProposal): CanaryState {
    // Guard: no duplicate canaries
    const existing = this.canaries.get(agentName);
    if (existing && existing.status === 'active') {
      throw new Error(
        `Cannot start canary for '${agentName}': an active canary already exists (proposal: ${existing.proposal_id})`,
      );
    }

    const now = new Date();
    const durationDays = this.resolveDurationDays();
    const endsAt = new Date(now.getTime() + durationDays * MS_PER_DAY);

    const state: CanaryState = {
      agent_name: agentName,
      current_version: proposal.current_version,
      proposed_version: proposal.proposed_version,
      proposal_id: proposal.proposal_id,
      canary_started_at: now.toISOString(),
      canary_ends_at: endsAt.toISOString(),
      comparisons: [],
      auto_rollback_triggered: false,
      status: 'active',
    };

    this.canaries.set(agentName, state);
    this.persistState();

    // Transition agent to CANARY state in the registry
    if (this.registry) {
      try {
        this.registry.setState(agentName, 'CANARY');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[CANARY] Failed to transition '${agentName}' to CANARY state: ${message}\n`,
        );
      }
    }

    // Audit log
    this.auditLogger.log({
      timestamp: now.toISOString(),
      event_type: 'agent_state_changed',
      agent_name: agentName,
      details: {
        event: 'canary_started',
        proposal_id: proposal.proposal_id,
        current_version: proposal.current_version,
        proposed_version: proposal.proposed_version,
        canary_ends_at: endsAt.toISOString(),
        duration_days: durationDays,
      },
    });

    return state;
  }

  /**
   * Get the active canary for an agent, or null if none exists.
   *
   * Only returns canaries with status 'active'.
   */
  getActiveCanary(agentName: string): CanaryState | null {
    const state = this.canaries.get(agentName);
    if (!state || state.status !== 'active') {
      return null;
    }
    return state;
  }

  /**
   * List all active canaries across all agents.
   */
  listActiveCanaries(): CanaryState[] {
    const active: CanaryState[] = [];
    for (const state of this.canaries.values()) {
      if (state.status === 'active') {
        active.push(state);
      }
    }
    return active;
  }

  /**
   * Record a comparison result for an active canary.
   *
   * Appends the comparison to the canary's comparisons array and persists.
   *
   * @param agentName   The agent name.
   * @param comparison  The comparison result to record.
   * @throws            Error if no active canary exists for this agent.
   */
  addComparison(agentName: string, comparison: CanaryComparison): void {
    const state = this.canaries.get(agentName);
    if (!state || state.status !== 'active') {
      throw new Error(
        `Cannot add comparison: no active canary for '${agentName}'`,
      );
    }

    state.comparisons.push(comparison);
    this.persistState();
  }

  /**
   * Complete the canary with a final positive or negative verdict.
   *
   * Transitions the agent out of CANARY state in the registry.
   *
   * @param agentName  The agent name.
   * @param status     The final status: 'completed_positive' or 'completed_negative'.
   * @throws           Error if no active canary exists for this agent.
   */
  completeCanary(
    agentName: string,
    status: 'completed_positive' | 'completed_negative',
  ): void {
    const state = this.canaries.get(agentName);
    if (!state || state.status !== 'active') {
      throw new Error(
        `Cannot complete canary: no active canary for '${agentName}'`,
      );
    }

    state.status = status;
    this.persistState();

    this.auditLogger.log({
      timestamp: new Date().toISOString(),
      event_type: 'agent_state_changed',
      agent_name: agentName,
      details: {
        event: 'canary_completed',
        status,
        proposal_id: state.proposal_id,
        total_comparisons: state.comparisons.length,
      },
    });
  }

  /**
   * Terminate a canary immediately due to catastrophic regression.
   *
   * Sets status to 'terminated_regression' and marks auto_rollback_triggered.
   *
   * @param agentName  The agent name.
   * @throws           Error if no active canary exists for this agent.
   */
  terminateCanary(agentName: string): void {
    const state = this.canaries.get(agentName);
    if (!state || state.status !== 'active') {
      throw new Error(
        `Cannot terminate canary: no active canary for '${agentName}'`,
      );
    }

    state.status = 'terminated_regression';
    state.auto_rollback_triggered = true;
    this.persistState();

    this.auditLogger.log({
      timestamp: new Date().toISOString(),
      event_type: 'agent_state_changed',
      agent_name: agentName,
      details: {
        event: 'canary_terminated_regression',
        proposal_id: state.proposal_id,
        total_comparisons: state.comparisons.length,
        auto_rollback_triggered: true,
      },
    });
  }

  /**
   * Check if the canary period has expired for an agent.
   *
   * Returns false if no active canary exists.
   */
  isExpired(agentName: string): boolean {
    const state = this.canaries.get(agentName);
    if (!state || state.status !== 'active') {
      return false;
    }
    return new Date() >= new Date(state.canary_ends_at);
  }

  /**
   * Get a canary state by agent name (any status).
   *
   * Useful for inspecting completed or terminated canaries.
   */
  getCanary(agentName: string): CanaryState | null {
    return this.canaries.get(agentName) ?? null;
  }

  // -------------------------------------------------------------------------
  // Private: configuration
  // -------------------------------------------------------------------------

  /**
   * Resolve the canary duration in days from config.
   *
   * Looks for `config.canary.durationDays`; falls back to 7 days.
   */
  private resolveDurationDays(): number {
    // The canary config may live under a 'canary' section of the config.
    // Since AgentFactoryConfig does not yet have a 'canary' field, we
    // check if one has been added or fall back to the default.
    const configAny = this.config as Record<string, unknown>;
    if (
      configAny['canary'] &&
      typeof configAny['canary'] === 'object' &&
      (configAny['canary'] as Record<string, unknown>)['durationDays'] !== undefined
    ) {
      const days = Number(
        (configAny['canary'] as Record<string, unknown>)['durationDays'],
      );
      if (!isNaN(days) && days > 0) {
        return days;
      }
    }
    return DEFAULT_CANARY_DURATION_DAYS;
  }

  // -------------------------------------------------------------------------
  // Private: persistence
  // -------------------------------------------------------------------------

  /** Load canary state from disk. */
  private loadState(): void {
    if (!fs.existsSync(this.statePath)) {
      return;
    }

    try {
      const raw = fs.readFileSync(this.statePath, 'utf-8');
      const persisted = JSON.parse(raw) as PersistedCanaryData;

      if (persisted.canaries && typeof persisted.canaries === 'object') {
        for (const [name, state] of Object.entries(persisted.canaries)) {
          this.canaries.set(name, state);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[CANARY] Failed to load canary state from ${this.statePath}: ${message}\n`,
      );
    }
  }

  /** Persist canary state to disk. */
  private persistState(): void {
    const dir = path.dirname(this.statePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const persisted: PersistedCanaryData = { canaries: {} };
    for (const [name, state] of this.canaries) {
      persisted.canaries[name] = state;
    }

    try {
      fs.writeFileSync(
        this.statePath,
        JSON.stringify(persisted, null, 2) + '\n',
        { encoding: 'utf-8' },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[CANARY] Failed to persist canary state to ${this.statePath}: ${message}\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Utility: generate a comparison ID
// ---------------------------------------------------------------------------

/**
 * Generate a UUID v4 for comparison IDs.
 */
export function generateComparisonId(): string {
  return crypto.randomUUID();
}
