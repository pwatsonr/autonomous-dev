/**
 * Shared types for the autonomous-dev reliability harness (#524).
 *
 * These are the data contracts that flow between the three layers:
 *   1. The task suite (`task-suite.json`)               -> {@link Task}
 *   2. The runner (`run-harness.ts`), one record per     -> {@link RunResult}
 *      task x repeat, derived from the CLI `status` JSON
 *      and the per-request `state.json` `phase_history`.
 *   3. The pure aggregation (`aggregate.ts`)             -> {@link Summary}
 *
 * Keeping {@link RunResult} a plain serializable record is what lets the
 * aggregation be pure (array in, summary out) and unit-tested with no live
 * daemon. See README for the cost warning on real runs.
 *
 * @module tools/reliability/types
 */

/** Terminal lifecycle states reported by `request status` (`.status`). */
export const TERMINAL_STATUSES = ['done', 'failed', 'cancelled'] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/** Non-terminal lifecycle states (poll continues while in one of these). */
export const NON_TERMINAL_STATUSES = ['queued', 'active', 'paused'] as const;
export type NonTerminalStatus = (typeof NON_TERMINAL_STATUSES)[number];

/** Full set of lifecycle states `.status` can take. */
export type RequestStatus = TerminalStatus | NonTerminalStatus;

/** Status the harness assigns when a request never reached any terminal state. */
export const TIMEOUT_STATUS = 'timeout' as const;

/** All possible recorded outcomes for a single run (terminal + timeout). */
export type RunStatus = TerminalStatus | typeof TIMEOUT_STATUS;

/** A single entry in a task suite (`task-suite.json` `tasks[]`). */
export interface Task {
  /** Stable identifier, used for `--tasks` selection and `byTask` keys. */
  id: string;
  /** Natural-language request description handed to `request submit`. */
  description: string;
  /** Risk class; forwarded to the CLI `--size` flag. */
  sizeClass: 'trivial-docs' | 'small' | 'standard' | 'large';
  /** The terminal phase a healthy run is expected to reach (always 'done'). */
  expectedTerminalPhase: 'done';
  /**
   * Per-task poll timeout in ms (#552). Should comfortably exceed the slowest
   * expected wall-clock for this size class (full standard pipeline ≈ 42-47min;
   * trivial-docs lighter pipeline ≈ 18min). Falls back to the batch default
   * when unset; an explicit operator --timeout overrides it.
   */
  timeoutMs?: number;
}

/** Parsed shape of `task-suite.json`. */
export interface TaskSuite {
  version?: number;
  description?: string;
  tasks: Task[];
}

/**
 * One element of the per-request `state.json` `phase_history[]`.
 * Mirrors the on-disk shape; only the fields the harness consumes are typed.
 */
export interface PhaseHistoryEntry {
  state: string;
  retry_count?: number;
  exit_reason?: string;
  cost_usd?: number;
}

/**
 * The single record produced per (task x repeat). This is the unit the
 * aggregation consumes. All fields are plain JSON so result sets can be
 * round-tripped through `--out` and replayed into the aggregator in tests.
 */
export interface RunResult {
  /** {@link Task.id} this run exercised. */
  taskId: string;
  /** The task's declared risk class (carried through for reporting). */
  sizeClass: Task['sizeClass'];
  /** 1-based repeat index for this task within the batch. */
  repeat: number;
  /** Request ID returned by `request submit` (absent only on dry-run stub paths). */
  requestId?: string;
  /** Final recorded outcome: a terminal `.status`, or 'timeout' if it never settled. */
  status: RunStatus;
  /** `.currentPhase` at the terminal observation (e.g. 'monitor' for a clean 'done'). */
  terminalPhase: string;
  /** Per-phase retry counts keyed by phase name, from `phase_history[].retry_count`. */
  perPhaseRetries: Record<string, number>;
  /** Sum of all `perPhaseRetries` values. */
  totalRetries: number;
  /** `.blocker` from `request status`, or `phase_history` exit reason; null if none. */
  blocker: string | null;
  /** Sum of `phase_history[].cost_usd`. */
  costUsd: number;
  /** Wall-clock duration of this run, submit -> terminal, in milliseconds. */
  wallClockMs: number;
  /** True when this record came from `--dry-run` (mocked CLI/state). */
  dryRun?: boolean;
}

/** Min/mean/max/p50 over a numeric sample (used for retries and cost). */
export interface NumericStats {
  count: number;
  total: number;
  mean: number;
  min: number;
  max: number;
  p50: number;
}

/** Output of {@link computeSummary}: the acceptance metrics for #532. */
export interface Summary {
  /** Total recorded runs. */
  totalRuns: number;
  /** Count of runs whose terminal phase == 'done'. */
  successCount: number;
  /** successCount / totalRuns (0 when totalRuns == 0). */
  successRate: number;
  /** Histogram of terminal `.status` across all runs. */
  byTerminalStatus: Record<string, number>;
  /** Histogram of terminal `.currentPhase` across all runs. */
  byTerminalPhase: Record<string, number>;
  /**
   * For non-successful runs, how often each phase was the highest-retried
   * (i.e. the phase most implicated in the failure). Phases with zero
   * retries on failing runs are recorded under '<none>'.
   */
  perPhaseFailureHistogram: Record<string, number>;
  /** Per-task success rate over its repeats (determinism signal: 1.0 == deterministic-green). */
  determinismByTask: Record<string, number>;
  /** Per-task breakdown: runs, successes, rate, and whether it was flaky (0 < rate < 1). */
  byTask: Record<
    string,
    { runs: number; successes: number; successRate: number; flaky: boolean }
  >;
  /** Sum of `costUsd` across all runs. */
  totalCostUsd: number;
  /** Distribution stats for `totalRetries` across runs. */
  retryStats: NumericStats;
  /** Distribution stats for `costUsd` across runs. */
  costStats: NumericStats;
}
