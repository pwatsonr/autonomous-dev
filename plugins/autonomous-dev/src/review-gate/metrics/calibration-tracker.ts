/**
 * CalibrationTracker: per-reviewer calibration score computation and action triggers.
 *
 * Tracks reviewer quality over time using a rolling window of confirmed findings
 * and misses. Computes a calibration score in the range [-1.0, +1.0] and determines
 * recommended actions based on configurable thresholds.
 *
 * Based on SPEC-004-4-3 section 1.
 */

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/** A single calibration event for a reviewer. */
export interface CalibrationEvent {
  reviewer_id: string;
  event_type: 'confirmed_finding' | 'miss';
  gate_id: string;
  timestamp: string;
  details: string;
}

/** Aggregated calibration state for a single reviewer. */
export interface CalibrationRecord {
  reviewer_id: string;
  reviewer_role: string;
  total_reviews: number;
  confirmed_findings: number;
  misses: number;
  calibration_score: number;          // -1.0 to +1.0
  action: CalibrationAction;
  window_size: number;                // number of reviews in the window
  last_updated: string;
  events: CalibrationEvent[];         // rolling window of events
}

/** Action recommended based on a reviewer's calibration score. */
export type CalibrationAction =
  | 'no_action'            // 0.7 to 1.0
  | 'monitor'              // 0.4 to 0.69
  | 'review_prompt'        // 0.1 to 0.39
  | 'remove_from_pool';   // -1.0 to 0.09

/** Configuration for the CalibrationTracker. */
export interface CalibrationTrackerConfig {
  window_size: number;                // default: 50
  action_thresholds: {
    no_action_min: number;            // default: 0.7
    monitor_min: number;              // default: 0.4
    review_prompt_min: number;        // default: 0.1
    // below review_prompt_min: remove_from_pool
  };
}

// ---------------------------------------------------------------------------
// MetricsStore interface
// ---------------------------------------------------------------------------

/**
 * Abstraction over the persistence layer for calibration data.
 *
 * Implementations may use a file system, database, or in-memory store.
 */
export interface MetricsStore {
  /** Retrieve all events for a given reviewer. */
  getEvents(reviewerId: string): CalibrationEvent[];
  /** Append an event for a reviewer. */
  appendEvent(reviewerId: string, event: CalibrationEvent): void;
  /** Get the role assigned to a reviewer. Returns empty string if unknown. */
  getReviewerRole(reviewerId: string): string;
  /** Set or update the role for a reviewer. */
  setReviewerRole(reviewerId: string, role: string): void;
}

// ---------------------------------------------------------------------------
// In-memory MetricsStore (default for testing)
// ---------------------------------------------------------------------------

/** Simple in-memory implementation of MetricsStore. */
export class InMemoryMetricsStore implements MetricsStore {
  private events: Map<string, CalibrationEvent[]> = new Map();
  private roles: Map<string, string> = new Map();

  getEvents(reviewerId: string): CalibrationEvent[] {
    return this.events.get(reviewerId) ?? [];
  }

  appendEvent(reviewerId: string, event: CalibrationEvent): void {
    if (!this.events.has(reviewerId)) {
      this.events.set(reviewerId, []);
    }
    this.events.get(reviewerId)!.push(event);
  }

  getReviewerRole(reviewerId: string): string {
    return this.roles.get(reviewerId) ?? '';
  }

  setReviewerRole(reviewerId: string, role: string): void {
    this.roles.set(reviewerId, role);
  }
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Compute the calibration score from a window of events.
 *
 * Formula: (confirmed - misses) / totalReviews
 * Range: -1.0 to +1.0
 * Returns 0 when no events exist.
 */
export function computeCalibrationScore(
  events: CalibrationEvent[],
  windowSize: number,
): number {
  // Take the most recent `windowSize` events
  const windowEvents = events.slice(-windowSize);

  if (windowEvents.length === 0) return 0;

  const confirmed = windowEvents.filter(e => e.event_type === 'confirmed_finding').length;
  const misses = windowEvents.filter(e => e.event_type === 'miss').length;
  const totalReviews = windowEvents.length;

  // calibration_score = (confirmed - misses) / totalReviews
  // Range: -1.0 to +1.0
  const score = (confirmed - misses) / totalReviews;

  // Clamp to range
  return Math.max(-1.0, Math.min(1.0, Math.round(score * 1000) / 1000));
}

/**
 * Determine the recommended action based on a calibration score and thresholds.
 */
export function determineAction(
  score: number,
  thresholds: CalibrationTrackerConfig['action_thresholds'],
): CalibrationAction {
  if (score >= thresholds.no_action_min) return 'no_action';
  if (score >= thresholds.monitor_min) return 'monitor';
  if (score >= thresholds.review_prompt_min) return 'review_prompt';
  return 'remove_from_pool';
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: CalibrationTrackerConfig = {
  window_size: 50,
  action_thresholds: {
    no_action_min: 0.7,
    monitor_min: 0.4,
    review_prompt_min: 0.1,
  },
};

// ---------------------------------------------------------------------------
// CalibrationTracker
// ---------------------------------------------------------------------------

export class CalibrationTracker {
  constructor(
    private store: MetricsStore,
    private config: CalibrationTrackerConfig = DEFAULT_CONFIG,
  ) {}

  /**
   * Records a +1 event when a reviewer's finding is confirmed by downstream evidence.
   */
  recordConfirmedFinding(reviewerId: string, gateId: string, details: string): void {
    const event: CalibrationEvent = {
      reviewer_id: reviewerId,
      event_type: 'confirmed_finding',
      gate_id: gateId,
      timestamp: new Date().toISOString(),
      details,
    };
    this.store.appendEvent(reviewerId, event);
  }

  /**
   * Records a -1 event when a document the reviewer approved later triggers
   * a backward cascade.
   */
  recordMiss(reviewerId: string, gateId: string, details: string): void {
    const event: CalibrationEvent = {
      reviewer_id: reviewerId,
      event_type: 'miss',
      gate_id: gateId,
      timestamp: new Date().toISOString(),
      details,
    };
    this.store.appendEvent(reviewerId, event);
  }

  /**
   * Computes the current calibration state for a reviewer.
   *
   * Uses the rolling window to compute the score and determine the action.
   */
  getCalibrationRecord(reviewerId: string): CalibrationRecord {
    const allEvents = this.store.getEvents(reviewerId);
    const windowEvents = allEvents.slice(-this.config.window_size);
    const score = computeCalibrationScore(allEvents, this.config.window_size);
    const action = determineAction(score, this.config.action_thresholds);

    const confirmed = windowEvents.filter(e => e.event_type === 'confirmed_finding').length;
    const misses = windowEvents.filter(e => e.event_type === 'miss').length;

    return {
      reviewer_id: reviewerId,
      reviewer_role: this.store.getReviewerRole(reviewerId),
      total_reviews: allEvents.length,
      confirmed_findings: confirmed,
      misses,
      calibration_score: score,
      action,
      window_size: windowEvents.length,
      last_updated: windowEvents.length > 0
        ? windowEvents[windowEvents.length - 1].timestamp
        : new Date().toISOString(),
      events: windowEvents,
    };
  }

  /**
   * Returns the recommended action based on the calibration score.
   */
  getCalibrationAction(reviewerId: string): CalibrationAction {
    const allEvents = this.store.getEvents(reviewerId);
    const score = computeCalibrationScore(allEvents, this.config.window_size);
    return determineAction(score, this.config.action_thresholds);
  }
}
