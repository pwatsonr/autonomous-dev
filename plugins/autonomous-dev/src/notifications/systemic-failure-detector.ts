import { randomUUID } from 'crypto';
import type { CrossRequestConfig, NotificationPayload } from './types';
import type { Clock } from './dnd-filter';

// ---------------------------------------------------------------------------
// AuditTrail interface (minimal, from SPEC-009-5-7)
// ---------------------------------------------------------------------------

/**
 * Minimal interface for the audit trail, consumed by notification components.
 * Full implementation lives in the audit module's AuditTrailEngine.
 */
export interface AuditTrail {
  append(event: {
    event_type: string;
    request_id: string;
    repository: string;
    pipeline_phase: string;
    agent: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Failure tracking types
// ---------------------------------------------------------------------------

export interface FailureRecord {
  requestId: string;
  repository: string;
  pipelinePhase: string;
  failureType: string;
  timestamp: Date;
}

export type SystemicDetectionResult =
  | { systemic: false }
  | {
      systemic: true;
      pattern: SystemicPattern;
      affectedRequests: string[];
      alert: NotificationPayload;
    };

export interface SystemicPattern {
  type: 'same_repo' | 'same_phase' | 'same_failure_type';
  key: string;
  count: number;
  windowStart: Date;
}

// ---------------------------------------------------------------------------
// SystemicFailureDetector
// ---------------------------------------------------------------------------

/**
 * Correlates failures across requests to identify infrastructure-level issues.
 *
 * Three correlation patterns evaluated independently (TDD Section 3.5.5):
 *   1. Same repository: >= threshold failures in the same repo within windowMinutes.
 *   2. Same pipeline phase: >= threshold failures in the same phase.
 *   3. Same failure type: >= threshold failures of the same type.
 *
 * When a pattern is detected:
 *   - Individual escalation notifications are suppressed (rolled into systemic alert).
 *   - A single immediate urgency systemic alert is emitted.
 *   - A systemic_issue_detected audit event is logged.
 *   - The pattern is marked active to prevent duplicate alerts.
 */
export class SystemicFailureDetector {
  /** Index: pattern key -> failure records. */
  private indices: Map<string, FailureRecord[]> = new Map();

  /** Tracks which patterns currently have an active systemic issue. */
  private activePatterns: Set<string> = new Set();

  constructor(
    private config: CrossRequestConfig,
    private auditTrail: AuditTrail,
    private clock: Clock,
  ) {}

  /**
   * Record a failure event and check all three correlation patterns.
   *
   * Returns a detection result indicating whether a systemic issue was
   * newly identified. If so, includes the alert payload and affected requests.
   */
  recordFailure(failure: FailureRecord): SystemicDetectionResult {
    if (!this.config.enabled) {
      return { systemic: false };
    }

    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - this.config.windowMinutes * 60 * 1000);

    // Build pattern keys for the three correlation dimensions
    const patternKeys = [
      { type: 'same_repo' as const, key: `repo:${failure.repository}` },
      { type: 'same_phase' as const, key: `phase:${failure.pipelinePhase}` },
      { type: 'same_failure_type' as const, key: `type:${failure.failureType}` },
    ];

    // Add to all three indices
    for (const { key } of patternKeys) {
      this.addToIndex(key, failure);
    }

    // Prune old entries from all indices
    this.pruneOlderThan(cutoff);

    // Check each pattern
    for (const { type, key } of patternKeys) {
      const entries = (this.indices.get(key) ?? []).filter(
        e => e.timestamp >= cutoff,
      );

      if (entries.length >= this.config.threshold) {
        if (!this.isSystemicIssueActive(key)) {
          // New systemic issue detected
          const affectedRequests = [...new Set(entries.map(e => e.requestId))];
          const alert = this.createSystemicAlert(
            { type, key, count: entries.length, windowStart: cutoff },
            affectedRequests,
          );

          this.markSystemicIssueActive(key);

          // Log audit event (fire-and-forget)
          this.auditTrail
            .append({
              event_type: 'autonomous_decision',
              request_id: 'system',
              repository: failure.repository,
              pipeline_phase: failure.pipelinePhase,
              agent: 'systemic-failure-detector',
              payload: {
                detection: 'systemic_issue_detected',
                pattern: { type, key, count: entries.length },
                affected_requests: affectedRequests,
              },
            })
            .catch(() => {
              // Best-effort audit logging
            });

          return {
            systemic: true,
            pattern: { type, key, count: entries.length, windowStart: cutoff },
            affectedRequests,
            alert,
          };
        }
      }
    }

    return { systemic: false };
  }

  /**
   * Check if a systemic issue is currently active for a pattern key.
   */
  isSystemicIssueActive(pattern: string): boolean {
    return this.activePatterns.has(pattern);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private addToIndex(key: string, failure: FailureRecord): void {
    if (!this.indices.has(key)) {
      this.indices.set(key, []);
    }
    this.indices.get(key)!.push(failure);
  }

  private pruneOlderThan(cutoff: Date): void {
    for (const [key, records] of this.indices) {
      const pruned = records.filter(r => r.timestamp >= cutoff);
      if (pruned.length === 0) {
        this.indices.delete(key);
        // Also deactivate the pattern if all records expired
        this.activePatterns.delete(key);
      } else {
        this.indices.set(key, pruned);
      }
    }
  }

  private markSystemicIssueActive(key: string): void {
    this.activePatterns.add(key);
  }

  private createSystemicAlert(
    pattern: SystemicPattern,
    affectedRequests: string[],
  ): NotificationPayload {
    return {
      notification_id: randomUUID(),
      event_type: 'systemic_issue',
      urgency: 'immediate',
      timestamp: this.clock.now().toISOString(),
      request_id: 'system',
      repository: pattern.key.startsWith('repo:')
        ? pattern.key.slice(5)
        : '',
      title: `Systemic issue detected: ${pattern.type} - ${pattern.key}`,
      body: `${pattern.count} failures in ${this.config.windowMinutes} minutes. Affected requests: ${affectedRequests.join(', ')}. This may indicate an infrastructure or configuration issue.`,
      metadata: {
        systemic_pattern: pattern,
        affected_requests: affectedRequests,
      },
    };
  }
}
