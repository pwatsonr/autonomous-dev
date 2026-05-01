// SPEC-015-3-03 — LogFilter: AND-combinable level / request_id / time
// filters. URL-serializable so /logs links are shareable.

import {
    LOG_LEVELS,
    type LogEntry,
    type LogFilterCriteria,
    type LogLevel,
    type TimeRange,
    REQUEST_ID_PATTERN,
    TIME_RANGE_MS,
} from "./types";

const LEVEL_SET: ReadonlySet<string> = new Set(LOG_LEVELS);
const TIME_RANGE_SET: ReadonlySet<string> = new Set(["1h", "4h", "24h"]);

function isIsoTimestamp(s: string): boolean {
    // Light validation — full ISO-8601 parsing isn't worth the cost on
    // every filter call. We require at least YYYY-MM-DDTHH:MM:SSZ shape.
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s);
}

export class LogFilter {
    /**
     * Parse query params into a criteria object. Invalid values are
     * silently dropped — the form/UI guarantees never-invalid input
     * for the SSE endpoint, but page GET is permissive.
     */
    static fromQuery(
        query: Record<string, string | undefined>,
    ): LogFilterCriteria {
        const out: LogFilterCriteria = {};
        const lvl = query.level;
        if (lvl !== undefined && LEVEL_SET.has(lvl.toUpperCase())) {
            out.level = lvl.toUpperCase() as LogLevel;
        }
        const reqId = query.request_id;
        if (reqId !== undefined && REQUEST_ID_PATTERN.test(reqId)) {
            out.request_id = reqId;
        }
        const tr = query.time_range;
        if (tr !== undefined && TIME_RANGE_SET.has(tr)) {
            out.time_range = tr as TimeRange;
        }
        const start = query.start_time;
        if (start !== undefined && isIsoTimestamp(start)) {
            out.start_time = start;
        }
        const end = query.end_time;
        if (end !== undefined && isIsoTimestamp(end)) {
            out.end_time = end;
        }
        return out;
    }

    /** Inverse of fromQuery — only includes set fields. */
    static toQuery(criteria: LogFilterCriteria): Record<string, string> {
        const out: Record<string, string> = {};
        if (criteria.level !== undefined) out.level = criteria.level;
        if (criteria.request_id !== undefined) {
            out.request_id = criteria.request_id;
        }
        if (criteria.time_range !== undefined) {
            out.time_range = criteria.time_range;
        }
        if (criteria.start_time !== undefined) {
            out.start_time = criteria.start_time;
        }
        if (criteria.end_time !== undefined) {
            out.end_time = criteria.end_time;
        }
        return out;
    }

    matches(
        entry: LogEntry,
        criteria: LogFilterCriteria,
        now: () => Date = () => new Date(),
    ): boolean {
        if (criteria.level !== undefined && entry.level !== criteria.level) {
            return false;
        }
        if (
            criteria.request_id !== undefined &&
            entry.request_id !== criteria.request_id
        ) {
            return false;
        }
        // Time bounds: explicit start/end overrides time_range.
        if (
            criteria.start_time !== undefined ||
            criteria.end_time !== undefined
        ) {
            if (
                criteria.start_time !== undefined &&
                entry.timestamp < criteria.start_time
            ) {
                return false;
            }
            if (
                criteria.end_time !== undefined &&
                entry.timestamp > criteria.end_time
            ) {
                return false;
            }
        } else if (criteria.time_range !== undefined) {
            const cutoffMs = now().getTime() - TIME_RANGE_MS[criteria.time_range];
            const cutoffIso = new Date(cutoffMs).toISOString();
            if (entry.timestamp < cutoffIso) return false;
        }
        return true;
    }

    /**
     * Single linear pass — no intermediate per-entry array allocation.
     * 10K entries with all 3 filters set must complete in <500ms.
     */
    apply(
        entries: ReadonlyArray<LogEntry>,
        criteria: LogFilterCriteria,
        now: () => Date = () => new Date(),
    ): LogEntry[] {
        // Pre-compute time cutoff once if applicable.
        let startBound: string | undefined;
        let endBound: string | undefined;
        if (
            criteria.start_time !== undefined ||
            criteria.end_time !== undefined
        ) {
            startBound = criteria.start_time;
            endBound = criteria.end_time;
        } else if (criteria.time_range !== undefined) {
            const cutoffMs = now().getTime() - TIME_RANGE_MS[criteria.time_range];
            startBound = new Date(cutoffMs).toISOString();
        }
        const level = criteria.level;
        const reqId = criteria.request_id;
        const out: LogEntry[] = [];
        for (const e of entries) {
            if (level !== undefined && e.level !== level) continue;
            if (reqId !== undefined && e.request_id !== reqId) continue;
            if (startBound !== undefined && e.timestamp < startBound) continue;
            if (endBound !== undefined && e.timestamp > endBound) continue;
            out.push(e);
        }
        return out;
    }
}
