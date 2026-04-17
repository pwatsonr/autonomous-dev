/**
 * Modification Rate Limiter (SPEC-005-3-4, Task 10).
 *
 * Enforces per-agent weekly modification limits. Uses ISO 8601 week
 * numbering with Monday-Sunday calendar week boundaries.
 *
 * Rate limit state is persisted to `data/rate-limits.json` so that
 * limits survive process restarts. When the rate limit is hit,
 * proposals are **deferred** (not rejected) -- they remain in their
 * current status and will be processed when the next week begins.
 *
 * Exports: `ModificationRateLimiter`
 */

import * as fs from 'fs';
import * as path from 'path';

import type { AgentFactoryConfig } from '../config';
import type { AuditLogger } from '../audit';
import type {
  RateLimitResult,
  RateLimitState,
  ModificationRecord,
} from './types';

// Re-export for convenience
export type { RateLimitResult };

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

export interface RateLimiterLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const defaultLogger: RateLimiterLogger = {
  info: (msg: string) => console.log(`[rate-limiter] ${msg}`),
  warn: (msg: string) => console.warn(`[rate-limiter] ${msg}`),
  error: (msg: string) => console.error(`[rate-limiter] ${msg}`),
};

// ---------------------------------------------------------------------------
// ModificationRateLimiter
// ---------------------------------------------------------------------------

export interface RateLimiterOptions {
  /** Path to the rate-limits.json file. */
  rateLimitsPath: string;
  /** Optional logger. */
  logger?: RateLimiterLogger;
}

/**
 * Enforces per-agent weekly modification limits.
 *
 * Usage:
 * ```ts
 * const limiter = new ModificationRateLimiter(config, auditLogger, {
 *   rateLimitsPath: 'data/rate-limits.json',
 * });
 *
 * const result = limiter.checkLimit('code-executor');
 * if (!result.allowed) {
 *   // Proposal is deferred until next week
 *   console.log(`Rate limited until ${result.nextAllowedAt}`);
 * }
 * ```
 */
export class ModificationRateLimiter {
  private readonly config: AgentFactoryConfig;
  private readonly auditLogger: AuditLogger;
  private readonly rateLimitsPath: string;
  private readonly logger: RateLimiterLogger;

  constructor(
    config: AgentFactoryConfig,
    auditLogger: AuditLogger,
    opts: RateLimiterOptions,
  ) {
    this.config = config;
    this.auditLogger = auditLogger;
    this.rateLimitsPath = path.resolve(opts.rateLimitsPath);
    this.logger = opts.logger ?? defaultLogger;
  }

  /**
   * Check if a modification is allowed for the given agent this week.
   *
   * Logic:
   *   1. Load persisted rate limit state.
   *   2. Get all modification records for this agent in the current
   *      ISO 8601 calendar week (Monday 00:00:00 UTC to Sunday 23:59:59 UTC).
   *   3. If count >= configured limit: return not allowed with nextAllowedAt.
   *   4. Otherwise: return allowed.
   */
  checkLimit(agentName: string): RateLimitResult {
    const maxPerWeek = this.config.rateLimits.modificationsPerAgentPerWeek;
    const state = this.loadState();
    const records = state.modifications[agentName] ?? [];

    // Filter to current calendar week
    const now = new Date();
    const weekStart = getWeekStartUTC(now);
    const weekEnd = getWeekEndUTC(now);

    const thisWeekRecords = records.filter((r) => {
      const ts = new Date(r.timestamp);
      return ts >= weekStart && ts <= weekEnd;
    });

    const currentCount = thisWeekRecords.length;

    if (currentCount >= maxPerWeek) {
      const nextMonday = getNextMondayUTC(now);
      const nextAllowedAt = nextMonday.toISOString();

      this.logger.warn(
        `Rate limit hit for '${agentName}': ${currentCount}/${maxPerWeek} ` +
        `modifications this week. Next allowed at ${nextAllowedAt}`,
      );

      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        event_type: 'agent_frozen' as const, // closest existing audit event type
        agent_name: agentName,
        details: {
          event: 'modification_rate_limited',
          current_count: currentCount,
          max_per_week: maxPerWeek,
          next_allowed_at: nextAllowedAt,
          week_start: weekStart.toISOString(),
          week_end: weekEnd.toISOString(),
        },
      });

      return {
        allowed: false,
        reason: `Rate limit exceeded: ${currentCount}/${maxPerWeek} modifications this week`,
        nextAllowedAt,
        currentCount,
        maxPerWeek,
      };
    }

    return {
      allowed: true,
      currentCount,
      maxPerWeek,
    };
  }

  /**
   * Record a successful modification for rate limit tracking.
   *
   * Should be called after a proposal is successfully promoted (or at the
   * point where the modification is committed).
   */
  recordModification(agentName: string, proposalId: string): void {
    const state = this.loadState();

    if (!state.modifications[agentName]) {
      state.modifications[agentName] = [];
    }

    const record: ModificationRecord = {
      timestamp: new Date().toISOString(),
      proposal_id: proposalId,
    };

    state.modifications[agentName].push(record);
    this.saveState(state);

    this.logger.info(
      `Modification recorded for '${agentName}': proposal ${proposalId}`,
    );
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /**
   * Load the rate limit state from disk.
   * Returns empty state if file does not exist or is corrupt.
   */
  private loadState(): RateLimitState {
    try {
      if (!fs.existsSync(this.rateLimitsPath)) {
        return { modifications: {} };
      }

      const content = fs.readFileSync(this.rateLimitsPath, 'utf-8');
      const parsed = JSON.parse(content);

      // Validate structure
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.modifications === 'object'
      ) {
        return parsed as RateLimitState;
      }

      this.logger.warn('Rate limits file has invalid structure; using empty state');
      return { modifications: {} };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to load rate limits: ${message}`);
      return { modifications: {} };
    }
  }

  /**
   * Save the rate limit state to disk.
   * Creates the parent directory if it does not exist.
   */
  private saveState(state: RateLimitState): void {
    try {
      const dir = path.dirname(this.rateLimitsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(
        this.rateLimitsPath,
        JSON.stringify(state, null, 2) + '\n',
        'utf-8',
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to save rate limits: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Calendar week utilities (ISO 8601 week: Monday-Sunday)
// ---------------------------------------------------------------------------

/**
 * Get the start of the current ISO 8601 week (Monday 00:00:00.000 UTC).
 */
export function getWeekStartUTC(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);

  // getUTCDay(): 0=Sunday, 1=Monday, ..., 6=Saturday
  // We need to go back to Monday
  const dayOfWeek = d.getUTCDay();
  // If Sunday (0), go back 6 days; otherwise go back (dayOfWeek - 1) days
  const daysBack = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  d.setUTCDate(d.getUTCDate() - daysBack);

  return d;
}

/**
 * Get the end of the current ISO 8601 week (Sunday 23:59:59.999 UTC).
 */
export function getWeekEndUTC(date: Date): Date {
  const weekStart = getWeekStartUTC(date);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
  weekEnd.setUTCHours(23, 59, 59, 999);
  return weekEnd;
}

/**
 * Get the next Monday 00:00:00.000 UTC after the given date.
 */
export function getNextMondayUTC(date: Date): Date {
  const weekStart = getWeekStartUTC(date);
  const nextMonday = new Date(weekStart);
  nextMonday.setUTCDate(nextMonday.getUTCDate() + 7);
  return nextMonday;
}
