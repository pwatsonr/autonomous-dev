/**
 * Decision Replay (SPEC-009-5-3, Task 5).
 *
 * Provides per-request event filtering and chronological narrative
 * reconstruction from the append-only JSONL audit log.
 *
 * Design constraints:
 *   - Reads log file line-by-line via streaming (never loads full file).
 *   - Filters by `request_id` field.
 *   - Returns events sorted by timestamp (defensive, even though log
 *     should already be chronological).
 *   - Returns empty array for unknown request IDs (no error thrown).
 *   - Phase 2 extension point: `replayStream` for async iteration.
 */

import * as fs from "fs";
import * as readline from "readline";
import type { AuditEvent } from "./types";

// ---------------------------------------------------------------------------
// DecisionReplay
// ---------------------------------------------------------------------------

/**
 * Replays audit events for a specific request ID by streaming through
 * the JSONL log file and filtering matching events.
 */
export class DecisionReplay {
  constructor(private readonly logPath: string) {}

  /**
   * Replay all events for a given request ID in chronological order.
   *
   * Streams the log file line-by-line to avoid loading the entire file
   * into memory. Collects matching events and sorts by timestamp.
   *
   * @param requestId  The request ID to filter events for.
   * @returns          Matching events sorted by timestamp (ascending).
   *                   Empty array if no events match or file does not exist.
   */
  async replay(requestId: string): Promise<AuditEvent[]> {
    // If the log file does not exist, return empty (no error)
    if (!fs.existsSync(this.logPath)) {
      return [];
    }

    const results: AuditEvent[] = [];

    // Stream line-by-line -- do not load full file into memory
    const fileStream = fs.createReadStream(this.logPath, { encoding: "utf-8" });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      try {
        const event: AuditEvent = JSON.parse(trimmed);
        if (event.request_id === requestId) {
          results.push(event);
        }
      } catch {
        // Skip malformed lines -- do not crash on parse errors
        continue;
      }
    }

    // Sort by timestamp (should already be in order, but defensive)
    results.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return results;
  }

  // Phase 2 extension point:
  // async *replayStream(requestId: string): AsyncIterable<AuditEvent> { ... }
}

// ---------------------------------------------------------------------------
// Narrative formatting utility
// ---------------------------------------------------------------------------

/**
 * Summarize an event payload into a short human-readable string.
 *
 * Extracts key fields (decision, reason, details) or falls back to
 * a JSON snippet truncated to a reasonable length.
 */
function summarizePayload(payload: Record<string, unknown>): string {
  // Try common payload fields first
  if (typeof payload.decision === "string") {
    return payload.decision;
  }
  if (typeof payload.reason === "string") {
    return payload.reason;
  }
  if (typeof payload.details === "string") {
    return payload.details;
  }

  // Fallback: compact JSON, truncated
  const json = JSON.stringify(payload);
  const MAX_LEN = 120;
  if (json.length <= MAX_LEN) {
    return json;
  }
  return json.slice(0, MAX_LEN) + "...";
}

/**
 * Format a list of audit events as a human-readable chronological narrative.
 *
 * Each event becomes a single line:
 *   [timestamp] event_type: summary
 *
 * @param events  Events to format (should already be sorted chronologically).
 * @returns       Multi-line string with one line per event.
 */
export function formatNarrative(events: AuditEvent[]): string {
  return events
    .map(
      (e) => `[${e.timestamp}] ${e.event_type}: ${summarizePayload(e.payload)}`,
    )
    .join("\n");
}
