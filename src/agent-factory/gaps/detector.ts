/**
 * Domain Gap Detection (SPEC-005-4-5, Task 11).
 *
 * Detects when no agent in the registry can adequately serve a task domain
 * and logs gap records to `data/domain-gaps.jsonl`. Gaps are rate-limited
 * to at most 1 per task_domain per calendar week to prevent flood logging.
 *
 * Detection triggers:
 *   1. Discovery-triggered: when `registry.getForTask()` yields no agent
 *      above the 0.6 similarity threshold.
 *   2. Analysis-triggered: when the performance analyzer recommends
 *      `propose_specialist`.
 *
 * Fallback behavior: when a gap is detected during pipeline execution,
 * the closest-matching agent is used with a warning injected into the
 * pipeline state.
 *
 * Exports: `DomainGapDetector`, `GapRecord`, `GapStatus`
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

import type { RankedAgent } from '../types';
import type { AuditLogger } from '../audit';

// ---------------------------------------------------------------------------
// GapStatus and GapRecord
// ---------------------------------------------------------------------------

/** Lifecycle status of a domain gap record. */
export type GapStatus =
  | 'detected'
  | 'specialist_recommended'
  | 'proposed'
  | 'accepted'
  | 'rejected'
  | 'deferred';

/** A single domain gap record written to `data/domain-gaps.jsonl`. */
export interface GapRecord {
  /** UUID v4 identifying this gap. */
  gap_id: string;
  /** The task domain that lacks adequate agent coverage. */
  task_domain: string;
  /** Description of the task that revealed the gap. */
  task_description: string;
  /** Name of the closest-matching agent, or null if none. */
  closest_agent: string | null;
  /** Similarity score of the closest agent (0-1), or 0 if none. */
  closest_similarity: number;
  /** ISO 8601 timestamp of when the gap was detected. */
  detected_at: string;
  /** Current status of the gap. */
  status: GapStatus;
  /** How the gap was detected. */
  source: 'discovery' | 'analysis';
}

// ---------------------------------------------------------------------------
// FallbackResult
// ---------------------------------------------------------------------------

/** Result of a gap detection with optional fallback information. */
export interface FallbackResult {
  /** Whether a gap was detected. */
  gapDetected: boolean;
  /** The gap record if one was created (may be null if rate-limited). */
  gapRecord: GapRecord | null;
  /** Whether the gap was rate-limited (duplicate for this week). */
  rateLimited: boolean;
  /** Warning message for pipeline injection when falling back. */
  warningMessage: string | null;
}

// ---------------------------------------------------------------------------
// DomainGapDetector
// ---------------------------------------------------------------------------

/**
 * Detects and logs domain gaps when no agent can adequately serve a
 * task domain.
 *
 * Usage:
 * ```ts
 * const detector = new DomainGapDetector({
 *   gapsFilePath: 'data/domain-gaps.jsonl',
 *   auditLogger,
 * });
 *
 * const result = detector.detect(
 *   'quantum-computing',
 *   'Implement quantum gate simulation',
 *   closestAgent,  // RankedAgent | null
 * );
 * ```
 */
export class DomainGapDetector {
  private readonly gapsFilePath: string;
  private readonly auditLogger: AuditLogger | null;

  constructor(opts: {
    gapsFilePath: string;
    auditLogger?: AuditLogger;
  }) {
    this.gapsFilePath = path.resolve(opts.gapsFilePath);
    this.auditLogger = opts.auditLogger ?? null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Detect a domain gap from a discovery pass (no agent above threshold).
   *
   * @param taskDomain        The domain tag for the task.
   * @param taskDescription   Free-text description of the task.
   * @param closestAgent      The closest-matching agent from discovery, or null.
   * @returns                 GapRecord that was logged (or would have been, if rate-limited).
   */
  detect(
    taskDomain: string,
    taskDescription: string,
    closestAgent: RankedAgent | null,
  ): GapRecord {
    const record = this.buildGapRecord(
      taskDomain,
      taskDescription,
      closestAgent,
      'discovery',
      'detected',
    );

    this.logGap(record);
    return record;
  }

  /**
   * Detect a domain gap from a performance analysis pass
   * (analyst recommended `propose_specialist`).
   *
   * @param taskDomain        The domain tag for the task.
   * @param taskDescription   Free-text description of the task.
   * @param closestAgent      The closest-matching agent, or null.
   * @returns                 GapRecord that was logged.
   */
  detectFromAnalysis(
    taskDomain: string,
    taskDescription: string,
    closestAgent: RankedAgent | null,
  ): GapRecord {
    const record = this.buildGapRecord(
      taskDomain,
      taskDescription,
      closestAgent,
      'analysis',
      'specialist_recommended',
    );

    this.logGap(record);
    return record;
  }

  /**
   * Detect a gap and return fallback information for pipeline injection.
   *
   * When a gap is detected during pipeline execution:
   *   - If rate-limited, still return fallback warning but skip logging.
   *   - The closest agent is used as a fallback.
   *   - A warning message is generated for pipeline state injection.
   *
   * @param taskDomain       The domain tag for the task.
   * @param taskDescription  Free-text description of the task.
   * @param closestAgent     The closest-matching agent, or null.
   * @returns                FallbackResult with gap info and warning.
   */
  detectWithFallback(
    taskDomain: string,
    taskDescription: string,
    closestAgent: RankedAgent | null,
  ): FallbackResult {
    const rateLimited = this.isRateLimited(taskDomain);

    let gapRecord: GapRecord | null = null;

    if (!rateLimited) {
      gapRecord = this.detect(taskDomain, taskDescription, closestAgent);
    }

    const closestName = closestAgent?.agent.agent.name ?? 'none';
    const closestScore = closestAgent?.score ?? 0;

    const warningMessage = closestAgent
      ? `No specialized agent for domain '${taskDomain}'. Falling back to '${closestName}' (similarity: ${closestScore.toFixed(2)}). Consider creating a specialist agent.`
      : `No specialized agent for domain '${taskDomain}'. No fallback agent available. Consider creating a specialist agent.`;

    return {
      gapDetected: true,
      gapRecord,
      rateLimited,
      warningMessage,
    };
  }

  /**
   * Read all gap records from the JSONL file.
   */
  readAll(): GapRecord[] {
    if (!fs.existsSync(this.gapsFilePath)) {
      return [];
    }

    const content = fs.readFileSync(this.gapsFilePath, 'utf-8');
    const lines = content.split('\n');
    const records: GapRecord[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;

      try {
        const parsed = JSON.parse(trimmed) as GapRecord;
        records.push(parsed);
      } catch {
        // Skip malformed lines
      }
    }

    return records;
  }

  /**
   * Check whether a gap for the given domain has already been logged
   * within the current calendar week.
   *
   * Rate limit: max 1 gap per task_domain per calendar week.
   *
   * @param taskDomain  The domain to check.
   * @returns           True if a gap already exists this week.
   */
  isRateLimited(taskDomain: string): boolean {
    const existing = this.readAll();
    const weekStart = getCalendarWeekStart(new Date());

    return existing.some(
      (g) =>
        g.task_domain === taskDomain &&
        new Date(g.detected_at) >= weekStart,
    );
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Build a GapRecord with the given parameters.
   */
  private buildGapRecord(
    taskDomain: string,
    taskDescription: string,
    closestAgent: RankedAgent | null,
    source: 'discovery' | 'analysis',
    status: GapStatus,
  ): GapRecord {
    return {
      gap_id: randomUUID(),
      task_domain: taskDomain,
      task_description: taskDescription,
      closest_agent: closestAgent?.agent.agent.name ?? null,
      closest_similarity: closestAgent?.score ?? 0,
      detected_at: new Date().toISOString(),
      status,
      source,
    };
  }

  /**
   * Log a gap record: append to JSONL file and emit audit event.
   *
   * Respects rate limiting: skips logging if a gap for the same domain
   * already exists this calendar week.
   */
  private logGap(record: GapRecord): void {
    // Rate limit check
    if (this.isRateLimited(record.task_domain)) {
      return;
    }

    // Append to JSONL
    this.appendToJsonl(record);

    // Emit audit event
    if (this.auditLogger) {
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        event_type: 'domain_gap_detected',
        details: {
          gap_id: record.gap_id,
          task_domain: record.task_domain,
          closest_agent: record.closest_agent,
          closest_similarity: record.closest_similarity,
          source: record.source,
          status: record.status,
        },
      });
    }
  }

  /**
   * Append a single GapRecord as a JSON line to the gaps file.
   */
  private appendToJsonl(record: GapRecord): void {
    const dir = path.dirname(this.gapsFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(this.gapsFilePath, line, { encoding: 'utf-8' });
  }
}

// ---------------------------------------------------------------------------
// Calendar week utility
// ---------------------------------------------------------------------------

/**
 * Get the start of the current ISO calendar week (Monday 00:00:00 UTC).
 *
 * @param date  The reference date.
 * @returns     Date representing Monday 00:00:00 UTC of the same week.
 */
function getCalendarWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getUTCDay();
  // Shift Sunday (0) to 7 for ISO week calculation
  const diff = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
