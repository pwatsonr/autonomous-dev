/**
 * False positive filtering chain (SPEC-007-3-1, Task 3).
 *
 * Runs BEFORE any LLM classification to save tokens. Each filter
 * returns a reason if the candidate is filtered out.
 *
 * Filter chain order:
 *   1. Maintenance windows (recurring day-of-week or one-time ISO 8601)
 *   2. Excluded error patterns (regex match against log samples)
 *   3. Load test markers (check request metadata headers/tags)
 */

import type {
  CandidateObservation,
  FilterResult,
  FalsePositiveFilterConfig,
  MaintenanceWindow,
  RecurringMaintenanceWindow,
  LoadTestMarker,
} from './types';

// ---------------------------------------------------------------------------
// Day-of-week mapping
// ---------------------------------------------------------------------------

const DAY_MAP: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

// ---------------------------------------------------------------------------
// Maintenance window helpers
// ---------------------------------------------------------------------------

/**
 * Type guard: returns true when the window has a `days` array
 * (recurring window format).
 */
function isRecurringWindow(
  window: MaintenanceWindow,
): window is RecurringMaintenanceWindow {
  return 'days' in window && Array.isArray((window as RecurringMaintenanceWindow).days);
}

/**
 * Parses an "HH:MM" string into total minutes since midnight.
 */
function parseTimeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Checks whether `currentTime` falls within a maintenance window.
 *
 * Supports:
 * - Recurring windows with day-of-week + HH:MM time range + timezone
 * - One-time windows with ISO 8601 start/end timestamps
 * - Overnight recurring windows where end < start (e.g., 23:00 to 03:00)
 */
export function isWithinMaintenanceWindow(
  currentTime: Date,
  window: MaintenanceWindow,
): boolean {
  if (isRecurringWindow(window)) {
    return isWithinRecurringWindow(currentTime, window);
  }
  return isWithinOneTimeWindow(currentTime, window);
}

/**
 * Checks a recurring window (day-of-week + time range).
 */
function isWithinRecurringWindow(
  currentTime: Date,
  window: RecurringMaintenanceWindow,
): boolean {
  // Convert current time to the window's timezone
  const tz = window.timezone ?? 'UTC';
  const localTime = new Date(
    currentTime.toLocaleString('en-US', { timeZone: tz }),
  );

  const currentDay = localTime.getDay();
  const currentMinutes =
    localTime.getHours() * 60 + localTime.getMinutes();

  const startMinutes = parseTimeToMinutes(window.start);
  const endMinutes = parseTimeToMinutes(window.end);

  // Check if current day is in the configured days
  const dayNames = window.days.map((d) => d.toUpperCase());
  const matchesDayNumbers = dayNames
    .map((name) => DAY_MAP[name])
    .filter((n) => n !== undefined);

  if (endMinutes > startMinutes) {
    // Normal window (e.g., 02:00 to 06:00) -- same day
    return (
      matchesDayNumbers.includes(currentDay) &&
      currentMinutes >= startMinutes &&
      currentMinutes < endMinutes
    );
  }

  // Overnight window (e.g., 23:00 to 03:00) -- spans two days
  // The window starts on one day and ends on the next.
  // We need to check both "started yesterday, still in window today"
  // and "started today, still in window before midnight".
  const previousDay = (currentDay + 6) % 7; // day - 1, wrapping

  if (
    matchesDayNumbers.includes(currentDay) &&
    currentMinutes >= startMinutes
  ) {
    // Started today, still before midnight
    return true;
  }
  if (
    matchesDayNumbers.includes(previousDay) &&
    currentMinutes < endMinutes
  ) {
    // Started yesterday, still in window today
    return true;
  }

  return false;
}

/**
 * Checks a one-time window (ISO 8601 start/end).
 */
function isWithinOneTimeWindow(
  currentTime: Date,
  window: MaintenanceWindow,
): boolean {
  const start = new Date(window.start);
  const end = new Date(window.end);
  return currentTime >= start && currentTime < end;
}

// ---------------------------------------------------------------------------
// Load test marker helper
// ---------------------------------------------------------------------------

/**
 * Checks whether request metadata contains a load test marker.
 *
 * Supports:
 * - Header-based markers: `{ header: "X-Load-Test", value: "true" }`
 * - Tag-based markers: `{ tag: "load-test" }`
 */
export function hasLoadTestMarker(
  metadata: Record<string, unknown>,
  marker: LoadTestMarker,
): boolean {
  if (marker.header && marker.value) {
    // Check for header match (case-insensitive key lookup)
    const headerKey = Object.keys(metadata).find(
      (k) => k.toLowerCase() === marker.header!.toLowerCase(),
    );
    if (headerKey && String(metadata[headerKey]) === marker.value) {
      return true;
    }
  }

  if (marker.tag) {
    // Check for tag in tags array or as a metadata key
    const tags = metadata.tags;
    if (Array.isArray(tags) && tags.includes(marker.tag)) {
      return true;
    }
    if (metadata[marker.tag] !== undefined) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Main filter function
// ---------------------------------------------------------------------------

/**
 * Checks a single candidate observation against the full false-positive
 * filter chain.
 *
 * Filter chain order:
 *   1. Maintenance windows
 *   2. Excluded error patterns
 *   3. Load test markers
 *
 * Returns `{ filtered: false }` if no filter matches, otherwise returns
 * `{ filtered: true, reason: "..." }`.
 *
 * @param candidate   The candidate observation to evaluate
 * @param config      False positive filter configuration
 * @param currentTime The current timestamp (injectable for testing)
 */
export function isFalsePositive(
  candidate: CandidateObservation,
  config: FalsePositiveFilterConfig,
  currentTime: Date,
): FilterResult {
  // Check 1: Maintenance windows
  for (const window of config.maintenance_windows) {
    if (isWithinMaintenanceWindow(currentTime, window)) {
      return {
        filtered: true,
        reason: `maintenance_window: ${window.start}-${window.end}`,
      };
    }
  }

  // Check 2: Excluded error patterns (regex match against log samples)
  for (const pattern of config.excluded_error_patterns) {
    const regex = new RegExp(pattern);
    if (candidate.log_samples.some((line) => regex.test(line))) {
      return { filtered: true, reason: `excluded_pattern: ${pattern}` };
    }
  }

  // Check 3: Load test markers (check request metadata)
  for (const marker of config.load_test_markers) {
    if (
      candidate.request_metadata &&
      hasLoadTestMarker(candidate.request_metadata, marker)
    ) {
      return { filtered: true, reason: 'load_test_traffic' };
    }
  }

  return { filtered: false };
}

// ---------------------------------------------------------------------------
// Batch filter
// ---------------------------------------------------------------------------

/**
 * Result of filtering a batch of candidates.
 */
export interface FilterBatchResult {
  /** Candidates that passed all filters. */
  passed: CandidateObservation[];

  /** Candidates that were filtered out, with reasons. */
  filtered: Array<{
    candidate: CandidateObservation;
    reason: string;
  }>;

  /** Total number of candidates filtered. */
  filtered_count: number;
}

/**
 * Filters an array of candidate observations through the false-positive
 * chain and returns the split results.
 *
 * @param candidates  Array of candidate observations
 * @param config      False positive filter configuration
 * @param currentTime The current timestamp (injectable for testing)
 */
export function filterCandidates(
  candidates: CandidateObservation[],
  config: FalsePositiveFilterConfig,
  currentTime: Date = new Date(),
): FilterBatchResult {
  const passed: CandidateObservation[] = [];
  const filtered: Array<{ candidate: CandidateObservation; reason: string }> =
    [];

  for (const candidate of candidates) {
    const result = isFalsePositive(candidate, config, currentTime);
    if (result.filtered) {
      filtered.push({ candidate, reason: result.reason! });
    } else {
      passed.push(candidate);
    }
  }

  return {
    passed,
    filtered,
    filtered_count: filtered.length,
  };
}
