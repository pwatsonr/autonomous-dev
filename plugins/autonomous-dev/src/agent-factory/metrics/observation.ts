/**
 * Observation state tracker (SPEC-005-2-4, Task 10).
 *
 * Tracks per-agent invocation counts since the last version promotion to
 * determine when an agent is eligible for performance analysis.  The
 * counter resets when a version change is detected (either via explicit
 * `resetForPromotion()` or automatic detection in `recordInvocation()`).
 *
 * State is maintained in memory and persisted to
 * `data/observation-state.json` for recovery across restarts.
 *
 * Exports: `ObservationTracker`, `ObservationState`
 */

import * as fs from 'fs';
import * as path from 'path';

import type { AgentFactoryConfig } from '../config';

// ---------------------------------------------------------------------------
// ObservationState
// ---------------------------------------------------------------------------

/** Per-agent observation state. */
export interface ObservationState {
  agent_name: string;
  /** Number of invocations recorded since the last version promotion. */
  invocations_since_promotion: number;
  /** Threshold for triggering analysis (from config). */
  threshold: number;
  /** Current status of the observation. */
  status: 'collecting' | 'threshold_reached';
  /** Agent version at the time the counter was last reset. */
  last_promotion_version: string;
}

// ---------------------------------------------------------------------------
// Persistence schema
// ---------------------------------------------------------------------------

/** Shape of the persisted state file. */
interface PersistedState {
  agents: Record<string, PersistedAgentState>;
}

interface PersistedAgentState {
  invocations_since_promotion: number;
  status: 'collecting' | 'threshold_reached';
  last_promotion_version: string;
}

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

export interface ObservationLogger {
  info(message: string): void;
  warn(message: string): void;
}

const defaultLogger: ObservationLogger = {
  info: (msg: string) => console.log(`[observation-tracker] ${msg}`),
  warn: (msg: string) => console.warn(`[observation-tracker] ${msg}`),
};

// ---------------------------------------------------------------------------
// ObservationTracker
// ---------------------------------------------------------------------------

export interface ObservationTrackerOptions {
  config: AgentFactoryConfig;
  /** Path to the state persistence file. Defaults to `data/observation-state.json`. */
  statePath?: string;
  logger?: ObservationLogger;
}

export class ObservationTracker {
  private readonly config: AgentFactoryConfig;
  private readonly statePath: string;
  private readonly logger: ObservationLogger;

  /** In-memory per-agent observation state. */
  private readonly agents: Map<string, PersistedAgentState> = new Map();

  constructor(opts: ObservationTrackerOptions) {
    this.config = opts.config;
    this.statePath = opts.statePath
      ? path.resolve(opts.statePath)
      : path.resolve('data/observation-state.json');
    this.logger = opts.logger ?? defaultLogger;

    this.loadState();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Record an invocation for an agent.
   *
   * Called after each metric record.  Behaviour:
   *   1. If `agentVersion` differs from `last_promotion_version`, reset
   *      the counter to 1 (new version detected).
   *   2. Otherwise increment `invocations_since_promotion`.
   *   3. Update `status` to `threshold_reached` if count >= threshold.
   *   4. Persist state to disk.
   */
  recordInvocation(
    agentName: string,
    agentVersion: string,
  ): ObservationState {
    const threshold = this.resolveThreshold(agentName);
    let state = this.agents.get(agentName);

    if (!state) {
      // First invocation for this agent
      state = {
        invocations_since_promotion: 0,
        status: 'collecting',
        last_promotion_version: agentVersion,
      };
      this.agents.set(agentName, state);
    }

    // Detect version change -> auto-reset counter
    if (agentVersion !== state.last_promotion_version) {
      this.logger.info(
        `Version change detected for '${agentName}': ` +
          `${state.last_promotion_version} -> ${agentVersion}. ` +
          `Resetting observation counter.`,
      );
      state.invocations_since_promotion = 0;
      state.last_promotion_version = agentVersion;
      state.status = 'collecting';
    }

    // Increment counter
    state.invocations_since_promotion++;

    // Check threshold
    if (state.invocations_since_promotion >= threshold) {
      state.status = 'threshold_reached';
    }

    this.persistState();

    return this.toObservationState(agentName, state, threshold);
  }

  /**
   * Query the current observation state for an agent.
   *
   * Returns a state with 0 invocations if the agent has not been seen.
   */
  getState(agentName: string): ObservationState {
    const threshold = this.resolveThreshold(agentName);
    const state = this.agents.get(agentName);

    if (!state) {
      return {
        agent_name: agentName,
        invocations_since_promotion: 0,
        threshold,
        status: 'collecting',
        last_promotion_version: '',
      };
    }

    return this.toObservationState(agentName, state, threshold);
  }

  /**
   * Reset the observation counter for an agent following a version
   * promotion.
   *
   * Sets `invocations_since_promotion` to 0 and updates
   * `last_promotion_version` to the new version.
   */
  resetForPromotion(agentName: string, newVersion: string): void {
    const state = this.agents.get(agentName);

    if (state) {
      state.invocations_since_promotion = 0;
      state.last_promotion_version = newVersion;
      state.status = 'collecting';
    } else {
      this.agents.set(agentName, {
        invocations_since_promotion: 0,
        status: 'collecting',
        last_promotion_version: newVersion,
      });
    }

    this.persistState();

    this.logger.info(
      `Observation counter reset for '${agentName}' at version ${newVersion}`,
    );
  }

  /**
   * Check whether the observation threshold has been reached for an agent.
   */
  isThresholdReached(agentName: string): boolean {
    const state = this.agents.get(agentName);
    if (!state) return false;
    return state.status === 'threshold_reached';
  }

  /**
   * Force the observation state to `threshold_reached` regardless of the
   * current invocation count.
   *
   * Used by `agent analyze --force` CLI command.  Does NOT bypass the
   * FROZEN state check (that is the caller's responsibility).
   */
  forceThresholdReached(agentName: string): ObservationState {
    const threshold = this.resolveThreshold(agentName);
    let state = this.agents.get(agentName);

    if (!state) {
      state = {
        invocations_since_promotion: 0,
        status: 'threshold_reached',
        last_promotion_version: '',
      };
      this.agents.set(agentName, state);
    } else {
      state.status = 'threshold_reached';
    }

    this.persistState();

    this.logger.info(
      `Forced threshold_reached for '${agentName}' ` +
        `(count: ${state.invocations_since_promotion}, threshold: ${threshold})`,
    );

    return this.toObservationState(agentName, state, threshold);
  }

  // -----------------------------------------------------------------------
  // Private: threshold resolution
  // -----------------------------------------------------------------------

  /**
   * Resolve the observation threshold for an agent.
   *
   * Priority:
   *   1. Per-agent override from `config.observation.perAgentOverrides`.
   *   2. Global default from `config.observation.defaultThreshold`.
   */
  private resolveThreshold(agentName: string): number {
    const override =
      this.config.observation.perAgentOverrides[agentName];
    if (override !== undefined && override !== null) {
      return override;
    }
    return this.config.observation.defaultThreshold;
  }

  // -----------------------------------------------------------------------
  // Private: persistence
  // -----------------------------------------------------------------------

  /** Load observation state from disk. */
  private loadState(): void {
    if (!fs.existsSync(this.statePath)) {
      return;
    }

    try {
      const raw = fs.readFileSync(this.statePath, 'utf-8');
      const persisted = JSON.parse(raw) as PersistedState;

      if (persisted.agents && typeof persisted.agents === 'object') {
        for (const [name, agentState] of Object.entries(persisted.agents)) {
          this.agents.set(name, {
            invocations_since_promotion:
              agentState.invocations_since_promotion ?? 0,
            status: agentState.status ?? 'collecting',
            last_promotion_version:
              agentState.last_promotion_version ?? '',
          });
        }
      }

      this.logger.info(
        `Loaded observation state for ${this.agents.size} agent(s) from ${this.statePath}`,
      );
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to load observation state from ${this.statePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Persist observation state to disk. */
  private persistState(): void {
    const dir = path.dirname(this.statePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const persisted: PersistedState = { agents: {} };
    for (const [name, state] of this.agents) {
      persisted.agents[name] = {
        invocations_since_promotion: state.invocations_since_promotion,
        status: state.status,
        last_promotion_version: state.last_promotion_version,
      };
    }

    try {
      fs.writeFileSync(
        this.statePath,
        JSON.stringify(persisted, null, 2) + '\n',
        { encoding: 'utf-8' },
      );
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to persist observation state to ${this.statePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Private: type conversion
  // -----------------------------------------------------------------------

  private toObservationState(
    agentName: string,
    state: PersistedAgentState,
    threshold: number,
  ): ObservationState {
    return {
      agent_name: agentName,
      invocations_since_promotion: state.invocations_since_promotion,
      threshold,
      status: state.status,
      last_promotion_version: state.last_promotion_version,
    };
  }
}
